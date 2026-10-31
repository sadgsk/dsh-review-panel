/**
 * Read-only git integration for the review page.
 *
 * Every command runs through the Host `subprocess` capability with a scrubbed
 * environment, a hard timeout, and bounded output; nothing here writes to the
 * repository (no add/commit/stage/fetch). Paths are validated by the route
 * layer before they reach this module.
 */
import { realpath } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import { safeRevision } from './util.js'

/** Milliseconds a git child gets to exit after termination starts. */
const TERMINATE_GRACE_MS = 2000
/** Retained stderr tail for diagnostics. */
const STDERR_TAIL_BYTES = 16 * 1024
/** Default command timeout. */
const TIMEOUT_MS = 15000
/** Default stdout cap (8 MiB). */
const OUTPUT_MAX_BYTES = 8 * 1024 * 1024
/** Text file cap for untracked-file synthesis (2 MiB). */
const TEXT_MAX_BYTES = 2 * 1024 * 1024
/** Maximum number of lines to synthesize for an all-added text file. */
const TEXT_MAX_LINES = 20000
/** Maximum size served for one full file read (2 MiB, mirrors the file route). */
const MAX_FILE_BYTES = 2 * 1024 * 1024
/** Commits listed for the revision picker when the request does not choose a count. */
const DEFAULT_REVISION_LIMIT = 60
/** Hard clamp for the revision list size. */
const MAX_REVISION_LIMIT = 200
/** Field caps for commit metadata (defensive against hostile commit messages). */
const SUBJECT_MAX_CHARS = 300
const AUTHOR_MAX_CHARS = 100
const REF_MAX_CHARS = 100
const REFS_MAX_COUNT = 12
/** Format used for every commit metadata read; fields are NUL-separated and the
 * record ends with the ASCII record separator so subjects keep their bytes. */
const COMMIT_FORMAT = '%H%x00%h%x00%P%x00%an%x00%aI%x00%D%x00%s%x1e'
/** Git record separator between formatted commits. */
const RECORD_SEPARATOR = '\u001e'
/** Well-known empty tree object ids. Git resolves them even when absent locally. */
const EMPTY_TREE_SHA1 = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const EMPTY_TREE_SHA256 = '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321'

/** Extension → true for files the review page treats as code. */
const BINARY_HINTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.pdf', '.zip', '.gz', '.tgz', '.7z', '.rar', '.tar', '.exe', '.dll', '.so', '.dylib', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp3', '.mp4', '.mov', '.avi', '.webm', '.sqlite', '.db', '.class', '.jar', '.wasm', '.o', '.obj', '.a', '.lib', '.pdb'])

/**
 * Whether a path is likely binary by extension.
 * @param {string} path path
 * @returns {boolean}
 */
function binaryByExtension(path) {
  const dot = String(path).toLowerCase().lastIndexOf('.')
  return dot >= 0 && BINARY_HINTS.has(String(path).toLowerCase().slice(dot))
}

/**
 * Runs one resolved git executable with a scrubbed environment, timeout, and
 * bounded output (same contract as the builtin workspace-changes GitRunner).
 */
export class GitRunner {
  /**
   * @param {object} subprocess Host subprocess service
   * @param {string} executable resolved git path
   * @param {{timeoutMs:number, outputMaxBytes:number}} limits command limits
   */
  constructor(subprocess, executable, limits) {
    this.subprocess = subprocess
    this.executable = executable
    this.limits = limits
  }

  /**
   * Run `git <args>` to completion.
   * @param {string[]} args git arguments (never shell-interpreted)
   * @param {{cwd:string, signal?:AbortSignal, maxBytes?:number, stdin?:string, env?:Record<string,string>}} options run options
   * @returns {Promise<{exitCode:number|null, stdout:string, stderr:string, truncated:boolean}>}
   */
  async run(args, options) {
    const timeout = AbortSignal.timeout(this.limits.timeoutMs)
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
    const handle = this.subprocess.spawn({
      argv: [this.executable, ...args],
      cwd: options.cwd,
      stdio: {
        stdin: options.stdin === undefined ? 'ignore' : { data: options.stdin },
        stdout: { maxBytes: options.maxBytes ?? this.limits.outputMaxBytes },
        stderr: { maxBytes: STDERR_TAIL_BYTES },
      },
      graceMs: TERMINATE_GRACE_MS,
      signal,
      env: {
        GIT_CONFIG_COUNT: '0',
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        LC_ALL: 'C',
        ...(options.env || {}),
      },
    })
    const outcome = await handle.done
    if (signal.aborted) throw new Error('git ' + args.join(' ') + (timeout.aborted ? ' timed out after ' + this.limits.timeoutMs + 'ms' : ' was aborted'))
    const stdout = handle.collected.stdout?.readFrom(0) ?? { text: '', lossy: false }
    const stderr = handle.collected.stderr?.readFrom(0)?.text ?? ''
    return {
      exitCode: outcome.exitCode,
      stdout: stdout.text,
      stderr,
      truncated: stdout.lossy === true,
    }
  }
}

/**
 * Resolve the git executable once.
 * @param {object} ctx Host context
 * @param {AbortSignal} [signal] cancellation
 * @returns {Promise<string | null>}
 */
export async function resolveGit(ctx, signal) {
  try {
    return await ctx.subprocess.resolveExecutable('git', undefined, signal)
  } catch {
    return null
  }
}

/**
 * Create a lazily-resolved runner.
 * @param {object} ctx Host context
 * @returns {() => Promise<GitRunner | null>}
 */
export function createGitProvider(ctx) {
  let pending
  return () => {
    pending ??= resolveGit(ctx).then((executable) => (executable === null
      ? null
      : new GitRunner(ctx.subprocess, executable, { timeoutMs: TIMEOUT_MS, outputMaxBytes: OUTPUT_MAX_BYTES })))
    return pending
  }
}

/**
 * Locate the repository enclosing a working directory.
 * @param {GitRunner} git runner
 * @param {string} cwd absolute session working directory
 * @param {AbortSignal} signal cancellation
 * @returns {Promise<string | null>} repository work-tree root, or null when not a git work tree
 */
export async function repositoryRoot(git, cwd, signal) {
  const found = await git.run(['rev-parse', '--show-toplevel'], { cwd, signal })
  if (found.exitCode === 128 && /not a git repository/i.test(found.stderr)) return null
  if (found.exitCode !== 0 || found.truncated) return null
  const root = found.stdout.replace(/\r?\n$/, '')
  return root === '' ? null : root
}

/**
 * The empty tree object id for the repository's object format.
 * @param {GitRunner} git runner
 * @param {string} cwd absolute session working directory
 * @param {AbortSignal} signal cancellation
 * @returns {Promise<string>} full empty-tree hash (SHA-1 fallback)
 */
export async function emptyTreeHash(git, cwd, signal) {
  const format = await git.run(['rev-parse', '--show-object-format'], { cwd, signal })
  const name = format.exitCode === 0 ? format.stdout.trim() : ''
  return name === 'sha256' ? EMPTY_TREE_SHA256 : EMPTY_TREE_SHA1
}

/**
 * Parse `git status --porcelain=v1 -z` output into review-tree records.
 * Porcelain v1 paths are always relative to the repository root.
 * @param {string} raw NUL-separated status output
 * @returns {Array<{path:string, code:string, indexStatus:string, workTreeStatus:string, renamedFrom?:string}>}
 */
export function parsePorcelain(raw) {
  const parts = String(raw).split('\0')
  const files = []
  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index]
    if (!entry || entry.length < 4) continue
    const indexStatus = entry.charAt(0)
    const workTreeStatus = entry.charAt(1)
    const path = entry.slice(3)
    if (!path) continue
    const code = indexStatus === '?' || workTreeStatus === '?'
      ? '?'
      : indexStatus !== ' '
        ? indexStatus
        : workTreeStatus !== ' '
          ? workTreeStatus
          : ' '
    const record = { path, code, indexStatus, workTreeStatus }
    // Rename/copy entries carry the original path in the next NUL-separated slot.
    if ((/[RC]/.test(indexStatus) || /[RC]/.test(workTreeStatus)) && index + 1 < parts.length) {
      record.renamedFrom = parts[index + 1]
      index += 1
    }
    files.push(record)
  }
  return files
}

/**
 * Parse a unified diff body into comparison hunks (workspace-changes shape).
 * @param {string} text unified diff text
 * @returns {{hunks:Array<object>, binary:boolean, multipleFiles:boolean}}
 */
export function parseUnifiedDiff(text) {
  const hunks = []
  let binary = false
  let current = null
  let fileCount = 0
  const lines = String(text).split('\n')
  for (const raw of lines) {
    if (raw.startsWith('diff --git ')) {
      if (current) hunks.push(current)
      current = null
      fileCount += 1
      continue
    }
    if (raw.startsWith('Binary files ') || raw === 'GIT binary patch') {
      binary = true
      continue
    }
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw)
    if (header) {
      if (current) hunks.push(current)
      current = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      }
      continue
    }
    if (!current) continue
    if (raw.startsWith('\\ No newline')) continue
    if (raw.startsWith('+') || raw.startsWith('-') || raw.startsWith(' ')) current.lines.push(raw)
    else if (raw.startsWith('@@')) { /* next hunk header handled above */ }
  }
  if (current) hunks.push(current)
  return { hunks, binary, multipleFiles: fileCount > 1 }
}

/**
 * Count text lines the same way the file route does.
 * @param {string} text decoded text
 * @returns {number}
 */
function countLines(text) {
  if (text.length === 0) return 0
  let lines = 1
  for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) === 10) lines += 1
  return text.endsWith('\n') ? lines - 1 : lines
}

/**
 * Parse commit metadata emitted with {@link COMMIT_FORMAT}.
 * @param {string} raw command output
 * @returns {Array<{sha:string, short:string, parents:string[], author:string, date:string, refs:string[], subject:string}>}
 */
function parseCommitRecords(raw) {
  const commits = []
  for (const piece of String(raw).split(RECORD_SEPARATOR)) {
    const text = piece.replace(/^\r?\n+/, '').replace(/\r?\n+$/, '')
    if (text === '') continue
    const fields = text.split('\u0000')
    if (fields.length < 7) continue
    if (!/^[0-9a-f]{40,64}$/i.test(fields[0])) continue
    const refs = fields[5] === ''
      ? []
      : fields[5].split(',').map((value) => value.trim()).filter(Boolean).slice(0, REFS_MAX_COUNT).map((value) => value.slice(0, REF_MAX_CHARS))
    commits.push({
      sha: fields[0],
      short: fields[1].slice(0, 40),
      parents: fields[2] === '' ? [] : fields[2].split(' ').filter(Boolean),
      author: fields[3].slice(0, AUTHOR_MAX_CHARS),
      date: fields[4],
      refs,
      subject: fields.slice(6).join('\u0000').slice(0, SUBJECT_MAX_CHARS),
    })
  }
  return commits
}

/**
 * Read the metadata of one already-canonicalized commit.
 * @param {GitRunner} git runner
 * @param {string} cwd absolute session working directory
 * @param {string} sha full commit hash
 * @param {AbortSignal} signal cancellation
 * @returns {Promise<object | null>}
 */
async function commitRecordBySha(git, cwd, sha, signal) {
  const logged = await git.run(['log', '-1', '--format=' + COMMIT_FORMAT, sha], { cwd, signal })
  if (logged.exitCode !== 0 || logged.truncated) return null
  const [record] = parseCommitRecords(logged.stdout)
  return record ?? null
}

/**
 * Resolve a revision expression to a commit and read its metadata.
 * @param {GitRunner} git runner
 * @param {string} cwd absolute session working directory
 * @param {string} rev revision expression (validated by the route)
 * @param {AbortSignal} signal cancellation
 * @returns {Promise<object | null>}
 */
async function commitRecordFor(git, cwd, rev, signal) {
  const verified = await git.run(['rev-parse', '--verify', '--quiet', rev + '^{commit}'], { cwd, signal })
  let sha
  if (verified.exitCode === 0 && !verified.truncated) {
    sha = verified.stdout.trim()
  } else {
    // Some revision expressions (e.g. `:/<regex>` message search) name a commit
    // but cannot be parsed with the `^{commit}` peel suffix. Resolve them
    // verbatim and require the result to be a commit object.
    const plain = await git.run(['rev-parse', '--verify', '--quiet', rev], { cwd, signal })
    if (plain.exitCode !== 0 || plain.truncated) return null
    const candidate = plain.stdout.trim()
    if (!/^[0-9a-f]{40,64}$/i.test(candidate)) return null
    const typed = await git.run(['cat-file', '-t', candidate], { cwd, signal })
    if (typed.exitCode !== 0 || typed.stdout.trim() !== 'commit') return null
    sha = candidate
  }
  if (!/^[0-9a-f]{40,64}$/i.test(sha)) return null
  return commitRecordBySha(git, cwd, sha, signal)
}

/**
 * Parse `git diff --name-status -z` output.
 * @param {string} raw NUL-separated name/status output
 * @returns {Array<{path:string, code:string, renamedFrom?:string}>}
 */
export function parseNameStatus(raw) {
  const parts = String(raw).split('\u0000')
  const files = []
  for (let index = 0; index < parts.length; index += 1) {
    const status = parts[index]
    if (!status) continue
    const code = status.charAt(0)
    if (code === 'R' || code === 'C') {
      const renamedFrom = parts[index + 1]
      const path = parts[index + 2]
      index += 2
      if (!renamedFrom || !path) continue
      files.push({ path, code, renamedFrom })
    } else {
      const path = parts[index + 1]
      index += 1
      if (!path) continue
      files.push({ path, code })
    }
  }
  return files
}

/** Convert a repository-relative status path to a path within the session. */
function workspacePath(root, cwd, path) {
  const rel = relative(resolve(cwd), resolve(root, path))
  if (rel === '' || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel)) return null
  return rel.replace(/\\/g, '/')
}

/** Keep only changes in the session, including the visible side of a rename. */
function workspaceStatus(files, root, cwd) {
  const result = []
  for (const file of files) {
    const path = workspacePath(root, cwd, file.path)
    const renamedFrom = file.renamedFrom === undefined ? null : workspacePath(root, cwd, file.renamedFrom)
    if (path !== null) {
      const record = { ...file, path }
      delete record.renamedFrom
      if (renamedFrom !== null) record.renamedFrom = renamedFrom
      else if (file.renamedFrom !== undefined) {
        // The source is outside this workspace, so only the added side exists here.
        record.indexStatus = /[RC]/.test(file.indexStatus) ? 'A' : file.indexStatus
        record.workTreeStatus = /[RC]/.test(file.workTreeStatus) ? 'A' : file.workTreeStatus
        record.code = record.indexStatus !== ' ' ? record.indexStatus : record.workTreeStatus
      }
      result.push(record)
    } else if (renamedFrom !== null && (file.indexStatus === 'R' || file.workTreeStatus === 'R')) {
      // Moving a file out of the workspace removes its old path from this view.
      result.push({
        path: renamedFrom,
        code: 'D',
        indexStatus: file.indexStatus === 'R' ? 'D' : ' ',
        workTreeStatus: file.workTreeStatus === 'R' ? 'D' : ' ',
      })
    }
  }
  return result
}

/** Keep only diff records in the session, including the visible side of a rename. */
function workspaceDiff(files, root, cwd) {
  const result = []
  for (const file of files) {
    const path = workspacePath(root, cwd, file.path)
    const renamedFrom = file.renamedFrom === undefined ? null : workspacePath(root, cwd, file.renamedFrom)
    if (path !== null) {
      const record = { path, code: file.code }
      if (renamedFrom !== null) record.renamedFrom = renamedFrom
      else if (file.renamedFrom !== undefined && (file.code === 'R' || file.code === 'C')) record.code = 'A'
      result.push(record)
    } else if (renamedFrom !== null && file.code === 'R') {
      // Moving a file out of the workspace removes its old path from this view.
      result.push({ path: renamedFrom, code: 'D' })
    }
  }
  return result
}

/**
 * Resolve a revision expression to a canonical commit hash and metadata.
 * @param {GitRunner} git runner
 * @param {string} cwd absolute session working directory
 * @param {string} rev revision expression (validated by the route)
 * @param {AbortSignal} signal cancellation
 * @returns {Promise<{sha:string, short:string, subject:string, author:string, date:string, parents:string[]} | null>}
 */
export async function resolveCommit(git, cwd, rev, signal) {
  const record = await commitRecordFor(git, cwd, rev, signal)
  if (!record) return null
  return {
    sha: record.sha,
    short: record.short,
    subject: record.subject,
    author: record.author,
    date: record.date,
    parents: record.parents,
  }
}

/**
 * Resolve the picker's raw revision query into the route's 200-shape fields.
 * @param {GitRunner} git runner
 * @param {string} cwd absolute session working directory
 * @param {string | undefined} rawQuery raw browser revision expression
 * @param {AbortSignal} signal cancellation
 * @returns {Promise<{resolved?:object, resolveError?:string}>}
 */
async function resolveRevisionQuery(git, cwd, rawQuery, signal) {
  if (rawQuery === undefined) return {}
  const rev = safeRevision(rawQuery)
  if (!rev) return { resolveError: 'Invalid git revision.' }
  const record = await commitRecordFor(git, cwd, rev, signal)
  if (!record) return { resolveError: 'Unknown git revision.' }
  return {
    resolved: {
      sha: record.sha,
      short: record.short,
      subject: record.subject,
      author: record.author,
      date: record.date,
      parents: record.parents,
      refs: record.refs,
    },
  }
}

/**
 * Read the revision picker payload: HEAD metadata plus recent commits.
 * @param {GitRunner} git runner
 * @param {string} cwd absolute session working directory
 * @param {{limit?:number, query?:string, signal:AbortSignal}} [options] request facts
 * @returns {Promise<object>} revision list payload (route git-revisions shape)
 */
export async function listGitRevisions(git, cwd, options = {}) {
  const { limit, query, signal } = options
  const root = await repositoryRoot(git, cwd, signal)
  if (!root) return { available: false, reason: 'not-git' }
  const requested = Number.isSafeInteger(limit) ? limit : DEFAULT_REVISION_LIMIT
  const count = Math.min(MAX_REVISION_LIMIT, Math.max(1, requested))
  const headCheck = await git.run(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd, signal })
  const resolution = await resolveRevisionQuery(git, cwd, query, signal)
  if (headCheck.exitCode !== 0) {
    return { available: true, root, unborn: true, head: null, commits: [], ...resolution }
  }
  const headSha = headCheck.stdout.trim()
  if (!/^[0-9a-f]{40,64}$/i.test(headSha)) {
    return { available: false, reason: 'head-failed', detail: headCheck.stderr.trim().slice(0, 400) }
  }
  const [logged, branch, upstream, headRecord] = await Promise.all([
    git.run(['log', '--max-count=' + String(count), '--format=' + COMMIT_FORMAT], { cwd, signal }),
    git.run(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, signal }),
    git.run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { cwd, signal }),
    commitRecordBySha(git, cwd, headSha, signal),
  ])
  if (logged.exitCode !== 0) return { available: false, reason: 'log-failed', detail: logged.stderr.trim().slice(0, 400) }
  const branchName = branch.exitCode === 0 ? branch.stdout.trim() : ''
  const detached = branchName === '' || branchName === 'HEAD'
  const upstreamName = upstream.exitCode === 0 ? upstream.stdout.trim() : ''
  let ahead = 0
  if (upstreamName !== '') {
    const counted = await git.run(['rev-list', '--count', upstreamName + '..HEAD'], { cwd, signal })
    const parsed = counted.exitCode === 0 ? Number.parseInt(counted.stdout.trim(), 10) : 0
    ahead = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
  }
  return {
    available: true,
    root,
    unborn: false,
    head: {
      sha: headSha,
      short: headRecord ? headRecord.short : headSha.slice(0, 7),
      subject: headRecord ? headRecord.subject : '',
      date: headRecord ? headRecord.date : '',
      branch: detached ? null : branchName,
      upstream: upstreamName === '' ? null : upstreamName,
      ahead,
      detached,
    },
    commits: parseCommitRecords(logged.stdout),
    ...resolution,
  }
}

/**
 * Resolve a revision and comparison scope into diff endpoints.
 * @param {GitRunner} git runner
 * @param {string} cwd absolute session working directory
 * @param {string} rev validated revision expression
 * @param {'commit'|'since'} scope comparison scope
 * @param {AbortSignal} signal cancellation
 * @returns {Promise<{base:object, target:object, baseArg:string, targetArg:string|undefined} | null>}
 */
export async function resolveComparison(git, cwd, rev, scope, signal) {
  const commit = await resolveCommit(git, cwd, rev, signal)
  if (!commit) return null
  if (scope === 'since') {
    return {
      base: { sha: commit.sha, short: commit.short, subject: commit.subject, emptyTree: false },
      target: { kind: 'worktree' },
      baseArg: commit.sha,
      targetArg: undefined,
    }
  }
  const target = { kind: 'commit', sha: commit.sha, short: commit.short, subject: commit.subject }
  const parentSha = commit.parents[0]
  if (!parentSha) {
    const empty = await emptyTreeHash(git, cwd, signal)
    return {
      base: { sha: empty, short: empty.slice(0, 7), subject: 'empty tree', emptyTree: true },
      target,
      baseArg: empty,
      targetArg: commit.sha,
    }
  }
  const parent = await resolveCommit(git, cwd, parentSha, signal)
  return {
    base: parent
      ? { sha: parent.sha, short: parent.short, subject: parent.subject, emptyTree: false }
      : { sha: parentSha, short: parentSha.slice(0, 7), subject: '', emptyTree: false },
    target,
    baseArg: parentSha,
    targetArg: commit.sha,
  }
}

/**
 * Serve the working-tree status of the session repository.
 * @param {object} ctx Host context
 * @param {() => Promise<GitRunner | null>} gitProvider runner provider
 * @param {string} cwd session working directory
 * @param {AbortSignal} signal cancellation
 * @returns {Promise<object>} status payload
 */
export async function readGitStatus(ctx, gitProvider, cwd, signal) {
  const git = await gitProvider()
  if (!git) return { available: false, reason: 'no-git' }
  const root = await repositoryRoot(git, cwd, signal)
  if (!root) return { available: false, reason: 'not-git' }
  // Git expands directory symlinks and Windows short names. Compare both
  // directory identities in the same form before applying workspace bounds.
  const [canonicalRoot, canonicalCwd] = await Promise.all([realpath(root), realpath(cwd)])
  const status = await git.run(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd, signal })
  if (status.exitCode !== 0) return { available: false, reason: 'status-failed', detail: status.stderr.trim().slice(0, 400) }
  return {
    available: true,
    root,
    truncated: status.truncated === true,
    files: workspaceStatus(parsePorcelain(status.stdout), canonicalRoot, canonicalCwd),
  }
}

/**
 * Serve the file list of a revision comparison (commit scope or since scope).
 * @param {object} ctx Host context
 * @param {() => Promise<GitRunner | null>} gitProvider runner provider
 * @param {{cwd:string, rev:string, scope:'commit'|'since', signal:AbortSignal}} request request facts
 * @returns {Promise<object>} route git-compare payload
 */
export async function readGitCompare(ctx, gitProvider, request) {
  const { cwd, rev, signal } = request
  const scope = request.scope === 'since' ? 'since' : 'commit'
  const git = await gitProvider()
  if (!git) return { available: false, reason: 'no-git' }
  const root = await repositoryRoot(git, cwd, signal)
  if (!root) return { available: false, reason: 'not-git' }
  const comparison = await resolveComparison(git, cwd, rev, scope, signal)
  if (!comparison) return { available: false, reason: 'unknown-revision' }
  // Git expands directory symlinks and Windows short names; map paths through
  // the same canonical identities as readGitStatus.
  const [canonicalRoot, canonicalCwd] = await Promise.all([realpath(root), realpath(cwd)])
  let records
  let truncated = false
  if (comparison.target.kind === 'worktree') {
    const diff = await git.run(['diff', '--name-status', '-z', '--find-renames=50%', comparison.baseArg], { cwd, signal })
    if (diff.exitCode !== 0) return { available: false, reason: 'diff-failed', detail: diff.stderr.trim().slice(0, 400) }
    truncated = diff.truncated === true
    records = parseNameStatus(diff.stdout)
    // The worktree diff omits untracked files; append them as additions.
    const status = await git.run(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd, signal })
    if (status.exitCode !== 0) return { available: false, reason: 'status-failed', detail: status.stderr.trim().slice(0, 400) }
    if (status.truncated) truncated = true
    const listed = new Set(records.map((record) => record.path))
    for (const entry of parsePorcelain(status.stdout)) {
      if (entry.code !== '?' || listed.has(entry.path)) continue
      listed.add(entry.path)
      records.push({ path: entry.path, code: 'A' })
    }
  } else {
    const diff = await git.run(['diff', '--name-status', '-z', '--find-renames=50%', comparison.baseArg, comparison.targetArg], { cwd, signal })
    if (diff.exitCode !== 0) return { available: false, reason: 'diff-failed', detail: diff.stderr.trim().slice(0, 400) }
    truncated = diff.truncated === true
    records = parseNameStatus(diff.stdout)
  }
  return {
    available: true,
    root,
    scope,
    base: comparison.base,
    target: comparison.target,
    files: workspaceDiff(records, canonicalRoot, canonicalCwd),
    truncated,
  }
}

/**
 * Read one untracked file through the workspace file service.
 * @param {object} ctx Host context
 * @param {object} scope workspace file scope
 * @param {string} path cwd-relative path
 * @param {AbortSignal} signal cancellation
 * @returns {Promise<{kind:'text', text:string} | {kind:'binary'} | {kind:'oversized'} | {kind:'missing'}>}
 */
async function readWorkingFile(ctx, scope, path, signal) {
  let stat
  try {
    stat = await ctx.workspaceFiles.stat(scope, path, signal)
  } catch {
    return { kind: 'missing' }
  }
  if (typeof stat?.bytes === 'number' && stat.bytes > TEXT_MAX_BYTES) return { kind: 'oversized' }
  let read
  try {
    read = await ctx.workspaceFiles.readBytes(scope, path, {}, signal)
  } catch {
    return { kind: 'missing' }
  }
  if (!read || !(read.data instanceof Uint8Array)) return { kind: 'missing' }
  if (read.data.byteLength > TEXT_MAX_BYTES || read.eof === false) return { kind: 'oversized' }
  const limit = Math.min(read.data.byteLength, 8192)
  for (let index = 0; index < limit; index += 1) if (read.data[index] === 0) return { kind: 'binary' }
  return { kind: 'text', text: new TextDecoder('utf-8', { fatal: false }).decode(read.data) }
}

/**
 * Build the all-added comparison for one untracked file.
 * @param {string} text file text
 * @param {string} path cwd-relative path
 * @returns {object} WorkspaceFileDiff text shape
 */
function untrackedComparison(text, path) {
  const lines = text.split(/\r\n|\r|\n/)
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  if (lines.length > TEXT_MAX_LINES) return { kind: 'oversized', path, display: path }
  return {
    kind: 'text',
    path,
    display: path,
    before: false,
    after: true,
    coarse: false,
    hunks: lines.length === 0 ? [] : [{
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: lines.length,
      lines: lines.map((line) => '+' + line),
    }],
  }
}

/**
 * Serve one file's HEAD↔worktree comparison (read-only).
 * @param {object} ctx Host context
 * @param {() => Promise<GitRunner | null>} gitProvider runner provider
 * @param {{sessionId:string, cwd:string, path:string, signal:AbortSignal}} request request facts
 * @returns {Promise<object>} WorkspaceFileDiff-shaped comparison or a status payload
 */
export async function readGitFile(ctx, gitProvider, request) {
  const { sessionId, cwd, path, signal } = request
  if (binaryByExtension(path)) return { kind: 'binary', path, display: path }
  const git = await gitProvider()
  if (!git) return { available: false, reason: 'no-git' }
  const root = await repositoryRoot(git, cwd, signal)
  if (!root) return { available: false, reason: 'not-git' }
  // Resolve directories only: the requested file may have been deleted and
  // still needs its repository-relative HEAD path to recover the old content.
  const [canonicalRoot, canonicalCwd] = await Promise.all([realpath(root), realpath(cwd)])
  const scope = { sessionId, workspaceRoot: cwd }
  // A staged deletion is absent from ls-files but still has a HEAD side. Check
  // the commit itself using an exact revision path, never a glob pathspec.
  const head = await git.run(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd, signal })
  if (head.truncated || (head.exitCode !== 0 && head.exitCode !== 1)) {
    return { available: false, reason: 'head-failed', detail: head.stderr.trim().slice(0, 400) }
  }
  const headRevision = head.exitCode === 0 ? head.stdout.trim() : null
  const repositoryPath = relative(canonicalRoot, resolve(canonicalCwd, path)).replace(/\\/g, '/')
  const committed = headRevision
    ? await git.run(['cat-file', '-e', headRevision + ':' + repositoryPath], { cwd, signal })
    : null
  if (!committed || committed.exitCode !== 0) {
    // Both untracked files and staged files before the first commit have an
    // empty old side. This also works in SHA-256 repositories.
    const working = await readWorkingFile(ctx, scope, path, signal)
    if (working.kind === 'oversized') return { kind: 'oversized', path, display: path }
    if (working.kind === 'binary') return { kind: 'binary', path, display: path }
    if (working.kind === 'missing') return { available: false, reason: 'file-unavailable' }
    return untrackedComparison(working.text, path)
  }
  let after = true
  try {
    const stat = await ctx.workspaceFiles.stat(scope, path, signal)
    if (typeof stat?.bytes === 'number' && stat.bytes > TEXT_MAX_BYTES) return { kind: 'oversized', path, display: path }
  } catch {
    after = false
  }
  let diff = await git.run(['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '-U3', headRevision, '--', ':(literal)' + path], { cwd, signal })
  if (diff.exitCode !== 0) {
    return { available: false, reason: 'diff-failed', detail: diff.stderr.trim().slice(0, 400) }
  }
  if (diff.truncated) return { kind: 'oversized', path, display: path }
  if (after && /^deleted file mode \d+$/m.test(diff.stdout)) {
    // git rm followed by recreating the same path leaves the current file
    // untracked. A normal HEAD diff only reports the index deletion. Compare
    // the committed blob against that current path without writing an index
    // or temporary files; --no-index accepts the old side on standard input.
    const old = await git.run(['show', headRevision + ':' + repositoryPath], { cwd, signal, maxBytes: TEXT_MAX_BYTES })
    if (old.truncated) return { kind: 'oversized', path, display: path }
    if (old.exitCode !== 0) return { available: false, reason: 'diff-failed', detail: old.stderr.trim().slice(0, 400) }
    diff = await git.run(['diff', '--no-index', '--no-color', '--no-ext-diff', '--no-textconv', '-U3', '--', '-', resolve(cwd, path)], { cwd, signal, stdin: old.stdout })
    // --no-index returns 1 for a successfully generated nonempty comparison.
    if (diff.exitCode !== 0 && diff.exitCode !== 1) return { available: false, reason: 'diff-failed', detail: diff.stderr.trim().slice(0, 400) }
    if (diff.truncated) return { kind: 'oversized', path, display: path }
  }
  const parsed = parseUnifiedDiff(diff.stdout)
  if (parsed.binary) return { kind: 'binary', path, display: path }
  if (parsed.multipleFiles) return { available: false, reason: 'diff-multiple-files' }
  return {
    kind: 'text',
    path,
    display: path,
    before: true,
    after,
    coarse: false,
    hunks: parsed.hunks,
  }
}

/** Base/target identity attached to revision-scoped file comparisons. */
function comparisonEndpoints(comparison) {
  return {
    base: { sha: comparison.base.sha, short: comparison.base.short },
    target: comparison.target.kind === 'commit'
      ? { kind: 'commit', sha: comparison.target.sha, short: comparison.target.short }
      : { kind: 'worktree' },
  }
}

/**
 * Serve one file's comparison against an arbitrary revision (read-only).
 * @param {object} ctx Host context
 * @param {() => Promise<GitRunner | null>} gitProvider runner provider
 * @param {{sessionId:string, cwd:string, path:string, rev:string, scope:'commit'|'since', signal:AbortSignal}} request request facts
 * @returns {Promise<object>} WorkspaceFileDiff-shaped comparison plus base/target
 */
export async function readGitFileAgainst(ctx, gitProvider, request) {
  const { sessionId, cwd, path, rev, signal } = request
  const scope = request.scope === 'since' ? 'since' : 'commit'
  const git = await gitProvider()
  if (!git) return { available: false, reason: 'no-git' }
  const root = await repositoryRoot(git, cwd, signal)
  if (!root) return { available: false, reason: 'not-git' }
  const comparison = await resolveComparison(git, cwd, rev, scope, signal)
  if (!comparison) return { available: false, reason: 'unknown-revision' }
  const [canonicalRoot, canonicalCwd] = await Promise.all([realpath(root), realpath(cwd)])
  const workspaceScope = { sessionId, workspaceRoot: cwd }
  const endpoints = comparisonEndpoints(comparison)
  // Binary extension hints avoid materializing the diff at all.
  if (binaryByExtension(path)) return { kind: 'binary', path, display: path, ...endpoints }
  const repositoryPath = relative(canonicalRoot, resolve(canonicalCwd, path)).replace(/\\/g, '/')
  const written = (sha) => git.run(['cat-file', '-e', sha + ':' + repositoryPath], { cwd, signal })
  const committedBefore = await written(comparison.baseArg)
  const before = committedBefore.exitCode === 0
  let after
  if (comparison.target.kind === 'commit') {
    after = (await written(comparison.target.sha)).exitCode === 0
  } else {
    try {
      await ctx.workspaceFiles.stat(workspaceScope, path, signal)
      after = true
    } catch {
      after = false
    }
  }
  if (!before && !after) return { available: false, reason: 'file-unavailable' }
  if (scope === 'since' && !before) {
    // Untracked (or not-yet-committed) files only exist on the worktree side.
    const working = await readWorkingFile(ctx, workspaceScope, path, signal)
    if (working.kind === 'oversized') return { kind: 'oversized', path, display: path, ...endpoints }
    if (working.kind === 'binary') return { kind: 'binary', path, display: path, ...endpoints }
    if (working.kind === 'missing') return { available: false, reason: 'file-unavailable' }
    return { ...untrackedComparison(working.text, path), ...endpoints }
  }
  let diff
  if (comparison.target.kind === 'commit') {
    diff = await git.run(['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '-U3', comparison.baseArg, comparison.targetArg, '--', ':(literal)' + path], { cwd, signal })
  } else {
    diff = await git.run(['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '-U3', comparison.baseArg, '--', ':(literal)' + path], { cwd, signal })
  }
  if (diff.exitCode !== 0) {
    return { available: false, reason: 'diff-failed', detail: diff.stderr.trim().slice(0, 400) }
  }
  if (diff.truncated) return { kind: 'oversized', path, display: path, ...endpoints }
  if (comparison.target.kind === 'worktree' && after && /^deleted file mode \d+$/m.test(diff.stdout)) {
    // git rm followed by recreating the same path leaves the current file
    // untracked. Compare the committed blob against that path without writing
    // an index or temporary file; --no-index accepts the old side on stdin.
    const old = await git.run(['show', comparison.baseArg + ':' + repositoryPath], { cwd, signal, maxBytes: TEXT_MAX_BYTES })
    if (old.truncated) return { kind: 'oversized', path, display: path, ...endpoints }
    if (old.exitCode !== 0) return { available: false, reason: 'diff-failed', detail: old.stderr.trim().slice(0, 400) }
    diff = await git.run(['diff', '--no-index', '--no-color', '--no-ext-diff', '--no-textconv', '-U3', '--', '-', resolve(cwd, path)], { cwd, signal, stdin: old.stdout })
    // --no-index returns 1 for a successfully generated nonempty comparison.
    if (diff.exitCode !== 0 && diff.exitCode !== 1) return { available: false, reason: 'diff-failed', detail: diff.stderr.trim().slice(0, 400) }
    if (diff.truncated) return { kind: 'oversized', path, display: path, ...endpoints }
  }
  const parsed = parseUnifiedDiff(diff.stdout)
  if (parsed.binary) return { kind: 'binary', path, display: path, ...endpoints }
  if (parsed.multipleFiles) return { available: false, reason: 'diff-multiple-files' }
  return {
    kind: 'text',
    path,
    display: path,
    before,
    after,
    coarse: false,
    hunks: parsed.hunks,
    ...endpoints,
  }
}

/**
 * Read one complete file as committed at a revision (read-only).
 * @param {object} ctx Host context
 * @param {() => Promise<GitRunner | null>} gitProvider runner provider
 * @param {{cwd:string, path:string, rev:string, signal:AbortSignal}} request request facts
 * @returns {Promise<object>} file content payload or a status payload
 */
export async function readGitContentAt(ctx, gitProvider, request) {
  const { cwd, path, rev, signal } = request
  const git = await gitProvider()
  if (!git) return { available: false, reason: 'no-git' }
  const root = await repositoryRoot(git, cwd, signal)
  if (!root) return { available: false, reason: 'not-git' }
  const commit = await resolveCommit(git, cwd, rev, signal)
  if (!commit) return { available: false, reason: 'unknown-revision' }
  const [canonicalRoot, canonicalCwd] = await Promise.all([realpath(root), realpath(cwd)])
  const repositoryPath = relative(canonicalRoot, resolve(canonicalCwd, path)).replace(/\\/g, '/')
  if (repositoryPath === '' || repositoryPath === '..' || repositoryPath.startsWith('../') || repositoryPath.startsWith('..\\') || isAbsolute(repositoryPath)) {
    return { available: false, reason: 'file-unavailable' }
  }
  const absolutePath = resolve(cwd, path)
  const object = commit.sha + ':' + repositoryPath
  const typed = await git.run(['cat-file', '-t', object], { cwd, signal })
  if (typed.exitCode !== 0 || typed.stdout.trim() !== 'blob') return { available: false, reason: 'file-unavailable' }
  const sized = await git.run(['cat-file', '-s', object], { cwd, signal })
  const bytes = sized.exitCode === 0 ? Number.parseInt(sized.stdout.trim(), 10) : Number.NaN
  if (!Number.isSafeInteger(bytes) || bytes < 0) return { available: false, reason: 'file-unavailable' }
  if (bytes > MAX_FILE_BYTES) return { kind: 'oversized', bytes, version: commit.sha, absolutePath }
  const shown = await git.run(['show', object], { cwd, signal, maxBytes: MAX_FILE_BYTES })
  if (shown.exitCode !== 0) return { available: false, reason: 'file-unavailable' }
  if (shown.truncated) return { kind: 'oversized', bytes, version: commit.sha, absolutePath }
  if (shown.stdout.slice(0, 8192).includes('\u0000')) {
    return { kind: 'binary', bytes, version: commit.sha, absolutePath }
  }
  return {
    kind: 'text',
    text: shown.stdout,
    lines: countLines(shown.stdout),
    bytes,
    version: commit.sha,
    absolutePath,
  }
}

/** Re-export for callers that only need the extension heuristic. */
export { binaryByExtension, extname }
