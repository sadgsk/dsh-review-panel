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

/** Re-export for callers that only need the extension heuristic. */
export { binaryByExtension, extname }
