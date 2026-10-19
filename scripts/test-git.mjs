#!/usr/bin/env node
/** Real-Git regressions for workspace paths, literal file names and empty/deleted sides. */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { GitRunner, parseUnifiedDiff, readGitFile, readGitStatus } from '../lib/host/git.js'

// Match the Host's bounded subprocess collection while executing the real binary.
const subprocess = {
  spawn(spec) {
    const child = spawn(spec.argv[0], spec.argv.slice(1), {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      windowsHide: true,
      signal: spec.signal,
      stdio: [spec.stdio.stdin === 'ignore' ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    })
    const collect = (stream, maxBytes) => {
      const chunks = []
      let bytes = 0
      let lossy = false
      stream.on('data', (chunk) => {
        const retained = Math.min(chunk.length, Math.max(0, maxBytes - bytes))
        if (retained < chunk.length) lossy = true
        if (retained > 0) chunks.push(chunk.subarray(0, retained))
        bytes += retained
      })
      return { readFrom: () => ({ text: Buffer.concat(chunks).toString('utf8'), lossy }) }
    }
    const collected = {
      stdout: collect(child.stdout, spec.stdio.stdout.maxBytes),
      stderr: collect(child.stderr, spec.stdio.stderr.maxBytes),
    }
    if (spec.stdio.stdin !== 'ignore') child.stdin.end(spec.stdio.stdin.data)
    return {
      collected,
      done: new Promise((resolvePromise, reject) => {
        child.once('error', reject)
        child.once('close', (exitCode, signal) => resolvePromise({ exitCode, signal }))
      }),
    }
  },
}
const runner = new GitRunner(subprocess, 'git', { timeoutMs: 15000, outputMaxBytes: 8 * 1024 * 1024 })
const provider = async () => runner
const ctx = {
  workspaceFiles: {
    async stat(scope, path) {
      const absolutePath = resolve(scope.workspaceRoot, path)
      const found = await stat(absolutePath)
      return { absolutePath, bytes: found.size }
    },
    async readBytes(scope, path) {
      return { data: await readFile(resolve(scope.workspaceRoot, path)), eof: true }
    },
  },
}
const temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-review-panel-git-'))
const signal = new AbortController().signal
let groups = 0
let skipped = 0
const ok = (name) => { groups += 1; process.stdout.write('PASS ' + name + '\n') }
const skip = (name) => { skipped += 1; process.stdout.write('SKIP ' + name + '\n') }
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const file = (cwd, path, useRunner = provider, useCtx = ctx) => readGitFile(useCtx, useRunner, { sessionId: 'git-regression', cwd, path, signal })
const put = async (cwd, path, text) => {
  await mkdir(dirname(join(cwd, path)), { recursive: true })
  await writeFile(join(cwd, path), text)
}
const commit = (cwd) => git(cwd, '-c', 'user.name=Inline Diff Regression', '-c', 'user.email=review-panel@example.invalid', 'commit', '-qm', 'baseline')

try {
  const repo = join(temporaryRoot, 'repo')
  const sub = join(repo, 'sub')
  await mkdir(sub, { recursive: true })
  git(repo, 'init')
  for (const [path, text] of Object.entries({
    'root.ts': 'root base\n',
    'sub/a.ts': 'nested base\n',
    'sub/[x].ts': 'bracket base\n',
    'sub/x.ts': 'plain base\n',
    'sub/[slug]/page.ts': 'dynamic base\n',
    'sub/s/page.ts': 'ordinary base\n',
    'sub/old.ts': 'renamed within\n',
    'incoming.ts': 'renamed into\n',
    'sub/outgoing.ts': 'renamed outside\n',
    'sub/staged-delete.ts': 'staged old\nsecond old\n',
    'sub/deleted.ts': 'unstaged old\n',
    'sub/binary.txt': '\0binary old\n',
  })) await put(repo, path, text)
  git(repo, 'add', '--all')
  commit(repo)
  await put(repo, 'root.ts', 'root edited\n')
  await put(repo, 'sub/a.ts', 'nested edited\n')
  await put(repo, 'sub/[x].ts', 'bracket edited\n')
  await put(repo, 'sub/x.ts', 'plain edited\n')
  await put(repo, 'sub/[slug]/page.ts', 'dynamic edited\n')
  await put(repo, 'sub/s/page.ts', 'ordinary edited\n')
  git(repo, 'mv', 'sub/old.ts', 'sub/new.ts')
  git(repo, 'mv', 'incoming.ts', 'sub/incoming.ts')
  git(repo, 'mv', 'sub/outgoing.ts', 'outgoing.ts')
  git(repo, 'rm', 'sub/staged-delete.ts')
  await rm(join(sub, 'deleted.ts'))
  await rm(join(sub, 'binary.txt'))

  const status = await readGitStatus(ctx, provider, sub, signal)
  assert.equal(status.available, true)
  const changes = new Map(status.files.map((entry) => [entry.path, entry]))
  assert.equal(changes.get('a.ts').code, 'M')
  assert.equal(changes.has('root.ts'), false)
  assert.equal(status.files.some((entry) => entry.path.startsWith('sub/') || entry.path.startsWith('../')), false)
  assert.equal(changes.get('new.ts').renamedFrom, 'old.ts')
  assert.equal(changes.get('incoming.ts').code, 'A')
  assert.equal(changes.get('incoming.ts').renamedFrom, undefined)
  assert.equal(changes.get('outgoing.ts').code, 'D')
  assert.equal(changes.get('outgoing.ts').renamedFrom, undefined)
  assert.equal(changes.get('staged-delete.ts').code, 'D')
  const rootStatus = await readGitStatus(ctx, provider, repo, signal)
  const rootChanges = new Map(rootStatus.files.map((entry) => [entry.path, entry]))
  assert.equal(rootChanges.get('root.ts').code, 'M')
  assert.equal(rootChanges.get('sub/a.ts').code, 'M')
  assert.equal(rootChanges.get('sub/new.ts').renamedFrom, 'sub/old.ts')
  ok('subdirectory status paths and rename boundaries stay within the workspace')

  for (const [path, expected, excluded] of [
    ['[x].ts', 'bracket', 'plain'],
    ['[slug]/page.ts', 'dynamic', 'ordinary'],
  ]) {
    const diff = await file(sub, path)
    assert.equal(diff.kind, 'text')
    const lines = diff.hunks.flatMap((hunk) => hunk.lines)
    assert.ok(lines.includes('-' + expected + ' base'))
    assert.ok(lines.includes('+' + expected + ' edited'))
    assert.equal(lines.some((line) => line.includes(excluded) || line.startsWith('--- ') || line.startsWith('+++ ')), false)
  }
  const regular = await file(sub, 'a.ts')
  assert.ok(regular.hunks[0].lines.includes('+nested edited'))
  const renamed = await file(sub, 'new.ts')
  assert.equal(renamed.before, false)
  assert.deepEqual(renamed.hunks[0].lines, ['+renamed within'])
  ok('literal bracket files/directories and subdirectory file diffs do not mix paths')

  for (const [path, expected] of [
    ['staged-delete.ts', ['-staged old', '-second old']],
    ['deleted.ts', ['-unstaged old']],
    ['outgoing.ts', ['-renamed outside']],
  ]) {
    const diff = await file(sub, path)
    assert.equal(diff.kind, 'text')
    assert.equal(diff.before, true)
    assert.equal(diff.after, false)
    assert.deepEqual(diff.hunks.flatMap((hunk) => hunk.lines), expected)
  }
  assert.equal((await file(sub, 'binary.txt')).kind, 'binary')
  await put(sub, 'staged-delete.ts', 'recreated source\n')
  const recreated = await file(sub, 'staged-delete.ts')
  assert.equal(recreated.kind, 'text')
  assert.equal(recreated.before, true)
  assert.equal(recreated.after, true)
  assert.deepEqual(recreated.hunks.flatMap((hunk) => hunk.lines), ['-staged old', '-second old', '+recreated source'])
  ok('staged/unstaged deletions expose HEAD text; deleted binary content stays binary')

  const emptyRepo = join(temporaryRoot, 'unborn')
  await mkdir(emptyRepo)
  git(emptyRepo, 'init')
  await put(emptyRepo, 'staged.ts', 'first\nsecond\n')
  await put(emptyRepo, 'untracked.ts', 'untracked\n')
  await put(emptyRepo, 'empty.ts', '')
  git(emptyRepo, 'add', 'staged.ts', 'empty.ts')
  for (const [path, expected] of [
    ['staged.ts', ['+first', '+second']],
    ['untracked.ts', ['+untracked']],
    ['empty.ts', []],
  ]) {
    const diff = await file(emptyRepo, path)
    assert.equal(diff.kind, 'text')
    assert.equal(diff.before, false)
    assert.equal(diff.after, true)
    assert.deepEqual(diff.hunks.flatMap((hunk) => hunk.lines), expected)
  }
  ok('staged, untracked and empty files work before the first commit')

  const sha256Repo = join(temporaryRoot, 'sha256')
  await mkdir(sha256Repo)
  let sha256Supported = true
  try {
    git(sha256Repo, 'init', '--object-format=sha256')
  } catch (error) {
    const detail = String(error.stderr || '')
    if (!/(?:unknown|unrecognized) option.*object-format|(?:unknown|unsupported) (?:hash algorithm|object format).*sha256/i.test(detail)) throw error
    sha256Supported = false
  }
  if (sha256Supported) {
    await put(sha256Repo, 'first.ts', 'sha256 first\n')
    git(sha256Repo, 'add', 'first.ts')
    assert.equal((await file(sha256Repo, 'first.ts')).before, false)
    commit(sha256Repo)
    await put(sha256Repo, 'first.ts', 'sha256 edited\n')
    assert.ok((await file(sha256Repo, 'first.ts')).hunks[0].lines.includes('+sha256 edited'))
    ok('empty and committed SHA-256 repositories use their actual revision format')
  } else skip('SHA-256 repositories are unsupported by this Git version')

  // The status conversion itself must preserve case even on a host whose disk
  // cannot contain both spellings. Real Git file matching is covered above.
  const caseRunner = {
    async run(args) {
      return { exitCode: 0, stderr: '', truncated: false, stdout: args[0] === 'rev-parse'
        ? repo + '\n'
        : ' M sub/Foo.ts\0 M sub/foo.ts\0 M SUB/outside.ts\0' }
    },
  }
  const caseStatus = await readGitStatus(ctx, async () => caseRunner, sub, signal)
  assert.ok(caseStatus.files.some((entry) => entry.path === 'Foo.ts'))
  assert.ok(caseStatus.files.some((entry) => entry.path === 'foo.ts'))
  assert.equal(caseStatus.files.some((entry) => entry.path === 'outside.ts'), process.platform === 'win32')
  ok('workspace status preserves file-name case and uses the host path boundary rules')

  await put(emptyRepo, 'line-limit.ts', 'line\n'.repeat(20000))
  await put(emptyRepo, 'too-many-lines.ts', 'line\n'.repeat(20001))
  await put(emptyRepo, 'too-many-bytes.ts', 'x'.repeat(2 * 1024 * 1024 + 1))
  await put(emptyRepo, 'binary.txt', 'one\0two')
  const atLimit = await file(emptyRepo, 'line-limit.ts')
  assert.equal(atLimit.kind, 'text')
  assert.equal(atLimit.hunks[0].lines.length, 20000)
  assert.equal((await file(emptyRepo, 'too-many-lines.ts')).kind, 'oversized')
  assert.equal((await file(emptyRepo, 'too-many-bytes.ts')).kind, 'oversized')
  assert.equal((await file(emptyRepo, 'binary.txt')).kind, 'binary')
  assert.equal((await file(emptyRepo, 'missing.ts')).reason, 'file-unavailable')
  const partialReadCtx = { workspaceFiles: { ...ctx.workspaceFiles, async readBytes() { return { data: Buffer.from('partial'), eof: false } } } }
  assert.equal((await file(emptyRepo, 'untracked.ts', provider, partialReadCtx)).kind, 'oversized')
  const grownReadCtx = { workspaceFiles: { ...ctx.workspaceFiles, async readBytes() { return { data: Buffer.alloc(2 * 1024 * 1024 + 1), eof: true } } } }
  assert.equal((await file(emptyRepo, 'untracked.ts', provider, grownReadCtx)).kind, 'oversized')
  const smallOutput = { run: (args, options) => runner.run(args, args[0] === 'diff' ? { ...options, maxBytes: 16 } : options) }
  assert.equal((await file(sub, 'a.ts', async () => smallOutput)).kind, 'oversized')
  ok('line/byte/output bounds and partial reads never masquerade as a complete text diff')

  const unexpected = [
    'diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1 +1 @@', '-old a', '+new a',
    'diff --git a/b.ts b/b.ts', '--- a/b.ts', '+++ b/b.ts', '@@ -1 +1 @@', '-old b', '+new b', '',
  ].join('\n')
  const parsed = parseUnifiedDiff(unexpected)
  assert.equal(parsed.multipleFiles, true)
  assert.deepEqual(parsed.hunks[0].lines, ['-old a', '+new a'])
  const unexpectedRunner = {
    run: async (args, options) => args[0] === 'diff'
      ? { exitCode: 0, stdout: unexpected, stderr: '', truncated: false }
      : runner.run(args, options),
  }
  assert.equal((await file(sub, 'a.ts', async () => unexpectedRunner)).reason, 'diff-multiple-files')
  ok('unexpected multi-file output is refused and file headers cannot leak into hunks')
  process.stdout.write('OK (' + groups + ' Git regression groups, ' + skipped + ' skipped)\n')
} finally {
  // Only remove the one freshly created directory directly inside the temp dir.
  assert.equal(dirname(resolve(temporaryRoot)), resolve(tmpdir()))
  assert.ok(basename(temporaryRoot).startsWith('dsh-review-panel-git-'))
  await rm(temporaryRoot, { recursive: true, force: true })
}
