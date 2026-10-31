#!/usr/bin/env node
/** Real-Git regressions for workspace paths, literal file names, empty/deleted sides and version comparisons. */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import {
  GitRunner,
  emptyTreeHash,
  listGitRevisions,
  parseNameStatus,
  parseUnifiedDiff,
  readGitCompare,
  readGitContentAt,
  readGitFile,
  readGitFileAgainst,
  readGitStatus,
  resolveCommit,
  resolveComparison,
} from '../lib/host/git.js'
import { safeRevision } from '../lib/host/util.js'

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
const commitAs = (cwd, message) => git(cwd, '-c', 'user.name=Inline Diff Regression', '-c', 'user.email=review-panel@example.invalid', 'commit', '-qm', message)
const compare = (cwd, rev, scope = 'commit') => readGitCompare(ctx, provider, { cwd, rev, scope, signal })
const against = (cwd, path, rev, scope = 'commit') => readGitFileAgainst(ctx, provider, { sessionId: 'git-regression', cwd, path, rev, scope, signal })
const contentAt = (cwd, path, rev) => readGitContentAt(ctx, provider, { cwd, path, rev, signal })
const revisions = (cwd, query) => listGitRevisions(runner, cwd, { query, signal })
// Git prints its work-tree root with forward slashes even on Windows, while
// fs.realpath uses native separators there; compare one canonical spelling.
const rootKey = (value) => {
  const normalized = String(value).replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}
const SHA1_EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const SHA256_EMPTY_TREE = '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321'

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
  assert.equal(status.available, true, JSON.stringify(status))
  const changes = new Map(status.files.map((entry) => [entry.path, entry]))
  assert.equal(changes.get('a.ts')?.code, 'M', JSON.stringify({ cwd: sub, status }))
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

  // Git expands directory aliases, including macOS temp-directory symlinks and
  // Windows short paths. Exercise aliases explicitly on every CI platform.
  const aliases = [join(temporaryRoot, 'repo alias 测试'), join(temporaryRoot, 'sub alias 测试')]
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  await symlink(await realpath(repo), aliases[0], linkType)
  await symlink(await realpath(sub), aliases[1], linkType)
  for (const cwd of [join(aliases[0], 'sub'), aliases[1]]) {
    const aliasedStatus = await readGitStatus(ctx, provider, cwd, signal)
    assert.deepEqual(aliasedStatus.files, status.files, JSON.stringify({ cwd, root: aliasedStatus.root }))
    const modified = await file(cwd, 'a.ts')
    assert.equal(modified.before, true)
    assert.deepEqual(modified.hunks[0].lines, ['-nested base', '+nested edited'])
    const deleted = await file(cwd, 'deleted.ts')
    assert.equal(deleted.before, true)
    assert.equal(deleted.after, false)
    assert.deepEqual(deleted.hunks[0].lines, ['-unstaged old'])
  }
  const aliasedRootStatus = await readGitStatus(ctx, provider, aliases[0], signal)
  assert.deepEqual(aliasedRootStatus.files, rootStatus.files)
  ok('directory aliases preserve status, rename boundaries, modified diffs and deleted HEAD content')

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
    const sha256Head = git(sha256Repo, 'rev-parse', 'HEAD').trim()
    const sha256Compare = await compare(sha256Repo, 'HEAD')
    assert.equal(sha256Compare.available, true, JSON.stringify(sha256Compare))
    assert.equal(sha256Compare.base.emptyTree, true)
    assert.equal(sha256Compare.base.sha, SHA256_EMPTY_TREE)
    assert.deepEqual(sha256Compare.files, [{ path: 'first.ts', code: 'A' }])
    assert.equal(await emptyTreeHash(runner, sha256Repo, signal), SHA256_EMPTY_TREE)
    const sha256Hunks = await against(sha256Repo, 'first.ts', sha256Head)
    assert.equal(sha256Hunks.before, false)
    assert.equal(sha256Hunks.after, true)
    assert.deepEqual(sha256Hunks.hunks.flatMap((hunk) => hunk.lines), ['+sha256 first'])
    const sha256Content = await contentAt(sha256Repo, 'first.ts', sha256Head)
    assert.equal(sha256Content.kind, 'text')
    assert.equal(sha256Content.text, 'sha256 first\n')
    assert.equal(sha256Content.version, sha256Head)
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

  // ---- Arbitrary-revision comparisons ----
  assert.equal(safeRevision(' HEAD~1 '), 'HEAD~1')
  for (const good of ['HEAD', 'main', 'v1.2.3', '@', '@{upstream}', 'release/1+hotfix', 'abc:def', 'HEAD^{commit}']) {
    assert.equal(safeRevision(good), good)
  }
  for (const bad of [undefined, null, 42, {}, '', '   ', '-x', 'a b', 'a\tb', 'a?b', 'a[b]', 'a*b', 'x'.repeat(201)]) {
    assert.equal(safeRevision(bad), undefined, 'unsafe revision accepted: ' + String(bad))
  }
  assert.deepEqual(parseNameStatus('M\0a.ts\0A\0b.ts\0D\0c.ts\0'), [
    { path: 'a.ts', code: 'M' },
    { path: 'b.ts', code: 'A' },
    { path: 'c.ts', code: 'D' },
  ])
  assert.deepEqual(parseNameStatus('R100\0old.ts\0new.ts\0T\0type.ts\0'), [
    { path: 'new.ts', code: 'R', renamedFrom: 'old.ts' },
    { path: 'type.ts', code: 'T' },
  ])
  assert.deepEqual(parseNameStatus(''), [])
  ok('safeRevision and NUL-separated name-status parsing are bounded and defensive')

  // `:/<regex>` message searches name a commit but reject the `^{commit}` peel
  // suffix; they still have to resolve through the verbatim fallback.
  const baselineSha = git(repo, 'rev-parse', 'HEAD').trim()
  const regexCommit = await resolveCommit(runner, repo, ':/baseline', signal)
  assert.equal(regexCommit && regexCommit.sha, baselineSha)
  assert.equal(await resolveCommit(runner, repo, ':/no-such-message-anywhere', signal), null)
  const regexCompare = await compare(repo, ':/baseline')
  assert.equal(regexCompare.available, true, JSON.stringify(regexCompare))
  assert.equal(regexCompare.target.sha, baselineSha)
  const regexRevisions = await revisions(repo, ':/baseline')
  assert.equal(regexRevisions.resolved && regexRevisions.resolved.sha, baselineSha)
  ok('regex revision searches resolve to their commit through the verbatim fallback')

  // A clone with an upstream exercises branch/upstream/ahead and raw tag resolution.
  git(temporaryRoot, 'init', '--bare', '--quiet', 'origin.git')
  const origin = join(temporaryRoot, 'origin.git')
  const cloned = join(temporaryRoot, 'cloned')
  git(temporaryRoot, 'clone', '--quiet', origin, cloned)
  git(cloned, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  await put(cloned, 'first.ts', 'first\n')
  git(cloned, 'add', 'first.ts')
  commitAs(cloned, 'first commit')
  const cloneFirst = git(cloned, 'rev-parse', 'HEAD').trim()
  await put(cloned, 'first.ts', 'first edited\n')
  git(cloned, 'add', 'first.ts')
  commitAs(cloned, 'second commit')
  const cloneSecond = git(cloned, 'rev-parse', 'HEAD').trim()
  git(cloned, 'tag', 'v-first', cloneFirst)
  git(cloned, 'push', '--quiet', '--set-upstream', 'origin', 'main')
  const cloneRevisions = await revisions(cloned)
  assert.equal(cloneRevisions.available, true, JSON.stringify(cloneRevisions))
  assert.equal(cloneRevisions.unborn, false)
  assert.equal(rootKey(cloneRevisions.root), rootKey(await realpath(cloned)))
  assert.equal(cloneRevisions.head.sha, cloneSecond)
  assert.ok(cloneSecond.startsWith(cloneRevisions.head.short))
  assert.equal(cloneRevisions.head.subject, 'second commit')
  assert.equal(cloneRevisions.head.branch, 'main')
  assert.equal(cloneRevisions.head.upstream, 'origin/main')
  assert.equal(cloneRevisions.head.ahead, 0)
  assert.equal(cloneRevisions.head.detached, false)
  assert.deepEqual(cloneRevisions.commits.map((entry) => entry.sha), [cloneSecond, cloneFirst])
  assert.deepEqual(cloneRevisions.commits.map((entry) => entry.subject), ['second commit', 'first commit'])
  assert.equal(cloneRevisions.commits[0].author, 'Inline Diff Regression')
  assert.ok(cloneRevisions.commits[1].refs.includes('tag: v-first'))
  assert.equal(cloneRevisions.resolved, undefined)
  assert.equal(cloneRevisions.resolveError, undefined)
  const resolvedTag = await revisions(cloned, 'v-first')
  assert.equal(resolvedTag.resolved.sha, cloneFirst)
  assert.equal(resolvedTag.resolved.subject, 'first commit')
  assert.deepEqual(resolvedTag.resolved.refs, ['tag: v-first'])
  assert.equal((await revisions(cloned, 'no-such-revision')).resolveError, 'Unknown git revision.')
  assert.equal((await revisions(cloned, 'bad revision')).resolveError, 'Invalid git revision.')
  assert.equal((await listGitRevisions(runner, cloned, { limit: 1, signal })).commits.length, 1)
  await put(cloned, 'third.ts', 'third\n')
  git(cloned, 'add', 'third.ts')
  commitAs(cloned, 'third commit')
  assert.equal((await revisions(cloned)).head.ahead, 1)
  git(cloned, 'checkout', '--quiet', '--detach', cloneFirst)
  const detachedRevisions = await revisions(cloned)
  assert.equal(detachedRevisions.head.detached, true)
  assert.equal(detachedRevisions.head.branch, null)
  assert.equal(detachedRevisions.head.upstream, null)
  assert.equal(detachedRevisions.head.ahead, 0)
  const unbornRevisions = await revisions(emptyRepo)
  assert.equal(unbornRevisions.available, true)
  assert.equal(unbornRevisions.unborn, true)
  assert.equal(unbornRevisions.head, null)
  assert.deepEqual(unbornRevisions.commits, [])
  assert.equal((await revisions(emptyRepo, 'HEAD')).resolveError, 'Unknown git revision.')
  const plain = join(temporaryRoot, 'plain-dir')
  await mkdir(plain)
  assert.deepEqual(await revisions(plain), { available: false, reason: 'not-git' })
  assert.deepEqual(await readGitCompare(ctx, async () => null, { cwd: cloned, rev: 'HEAD', scope: 'commit', signal }), { available: false, reason: 'no-git' })
  ok('revision list reports head/branch/upstream/ahead, tags, detached and unborn states')

  const history = join(temporaryRoot, 'history')
  await mkdir(history)
  git(history, 'init')
  git(history, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  const bigText = 'x'.repeat(2 * 1024 * 1024 + 1)
  for (const [path, text] of Object.entries({
    'a.ts': 'one\ntwo\nthree\n',
    'gone.ts': 'gone\n',
    'lib/rename-old.ts': 'rename content here\n',
    'sub/inner.ts': 'inner base\n',
    'worktree.ts': 'worktree base\n',
    'deleted-later.ts': 'delete me\n',
    'recreate.ts': 'recreate old\n',
    'mv-old.ts': 'moving file content\n',
    'big.txt': bigText,
  })) await put(history, path, text)
  git(history, 'add', '--all')
  commitAs(history, 'history root')
  const historyRoot = git(history, 'rev-parse', 'HEAD').trim()
  await put(history, 'a.ts', 'one\ntwo-b\nthree\n')
  await put(history, 'added.ts', 'added content\n')
  await put(history, 'bin/blob.dat', 'blob\0bytes\n')
  await rm(join(history, 'gone.ts'))
  git(history, 'mv', 'lib/rename-old.ts', 'lib/rename-new.ts')
  git(history, 'add', '--all')
  commitAs(history, 'history second')
  const historySecond = git(history, 'rev-parse', 'HEAD').trim()
  git(history, 'tag', 'release-1', historySecond)
  await put(history, 'sub/inner.ts', 'inner head\n')
  git(history, 'add', '--all')
  commitAs(history, 'history third')
  const historyHead = git(history, 'rev-parse', 'HEAD').trim()
  // Worktree tangle for the since scope: committed + staged + unstaged + untracked.
  await put(history, 'staged.ts', 'staged new\n')
  git(history, 'add', 'staged.ts')
  await put(history, 'worktree.ts', 'worktree edited\n')
  await put(history, 'untracked.ts', 'untracked fresh\n')
  await rm(join(history, 'deleted-later.ts'))
  git(history, 'mv', 'mv-old.ts', 'mv-new.ts')
  git(history, 'rm', '-q', 'recreate.ts')
  await put(history, 'recreate.ts', 'recreate new\n')

  assert.equal(await emptyTreeHash(runner, history, signal), SHA1_EMPTY_TREE)
  const resolvedSecond = await resolveCommit(runner, history, 'release-1', signal)
  assert.equal(resolvedSecond.sha, historySecond)
  assert.equal(resolvedSecond.subject, 'history second')
  assert.deepEqual(resolvedSecond.parents, [historyRoot])
  assert.equal(await resolveCommit(runner, history, 'no-such-revision', signal), null)
  const commitEndpoints = await resolveComparison(runner, history, 'release-1', 'commit', signal)
  assert.equal(commitEndpoints.baseArg, historyRoot)
  assert.equal(commitEndpoints.targetArg, historySecond)
  const sinceEndpoints = await resolveComparison(runner, history, 'release-1', 'since', signal)
  assert.deepEqual(sinceEndpoints.target, { kind: 'worktree' })
  assert.equal(sinceEndpoints.targetArg, undefined)
  assert.equal(await resolveComparison(runner, history, 'no-such-revision', 'commit', signal), null)
  const rootEndpoints = await resolveComparison(runner, history, historyRoot, 'commit', signal)
  assert.equal(rootEndpoints.base.emptyTree, true)
  assert.equal(rootEndpoints.baseArg, SHA1_EMPTY_TREE)
  ok('emptyTreeHash, resolveCommit and resolveComparison canonicalize every endpoint')

  const commitCompare = await compare(history, 'release-1')
  assert.equal(commitCompare.available, true, JSON.stringify(commitCompare))
  assert.equal(commitCompare.scope, 'commit')
  assert.equal(commitCompare.base.sha, historyRoot)
  assert.ok(historyRoot.startsWith(commitCompare.base.short))
  assert.equal(commitCompare.base.subject, 'history root')
  assert.equal(commitCompare.base.emptyTree, false)
  assert.equal(commitCompare.target.kind, 'commit')
  assert.equal(commitCompare.target.sha, historySecond)
  assert.equal(commitCompare.target.subject, 'history second')
  assert.equal(commitCompare.truncated, false)
  const commitFiles = new Map(commitCompare.files.map((entry) => [entry.path, entry]))
  assert.equal(commitFiles.get('a.ts').code, 'M')
  assert.equal(commitFiles.get('added.ts').code, 'A')
  assert.equal(commitFiles.get('gone.ts').code, 'D')
  assert.equal(commitFiles.get('bin/blob.dat').code, 'A')
  assert.equal(commitFiles.get('lib/rename-new.ts').code, 'R')
  assert.equal(commitFiles.get('lib/rename-new.ts').renamedFrom, 'lib/rename-old.ts')
  assert.equal(commitFiles.has('sub/inner.ts'), false)
  const rootCompare = await compare(history, historyRoot)
  assert.equal(rootCompare.base.emptyTree, true)
  assert.equal(rootCompare.base.sha, SHA1_EMPTY_TREE)
  assert.ok(rootCompare.files.length >= 8)
  assert.ok(rootCompare.files.every((entry) => entry.code === 'A'))
  assert.ok(rootCompare.files.some((entry) => entry.path === 'big.txt'))
  const secondHunks = await against(history, 'a.ts', historySecond)
  assert.equal(secondHunks.kind, 'text')
  assert.deepEqual(secondHunks.hunks.flatMap((hunk) => hunk.lines), [' one', '-two', '+two-b', ' three'])
  assert.equal(secondHunks.base.sha, historyRoot)
  assert.equal(secondHunks.target.kind, 'commit')
  assert.equal(secondHunks.target.sha, historySecond)
  assert.equal((await against(history, 'a.ts', historyHead)).hunks.length, 0)
  const addedSide = await against(history, 'added.ts', historySecond)
  assert.equal(addedSide.before, false)
  assert.equal(addedSide.after, true)
  assert.ok(addedSide.hunks.flatMap((hunk) => hunk.lines).includes('+added content'))
  const deletedSide = await against(history, 'gone.ts', historySecond)
  assert.equal(deletedSide.before, true)
  assert.equal(deletedSide.after, false)
  assert.deepEqual(deletedSide.hunks.flatMap((hunk) => hunk.lines), ['-gone'])
  assert.equal((await against(history, 'bin/blob.dat', historySecond)).kind, 'binary')
  assert.equal((await against(history, 'logo.png', historySecond)).kind, 'binary')
  assert.equal((await against(history, 'a.ts', 'no-such-revision')).reason, 'unknown-revision')
  ok('commit scope compares the first parent with commit and exposes M/A/D/R, binary and flags')

  const sinceCompare = await compare(history, 'release-1', 'since')
  assert.equal(sinceCompare.available, true, JSON.stringify(sinceCompare))
  assert.equal(sinceCompare.scope, 'since')
  assert.equal(sinceCompare.base.sha, historySecond)
  assert.deepEqual(sinceCompare.target, { kind: 'worktree' })
  const sinceFiles = new Map(sinceCompare.files.map((entry) => [entry.path, entry]))
  assert.equal(sinceFiles.get('sub/inner.ts').code, 'M')
  assert.equal(sinceFiles.get('staged.ts').code, 'A')
  assert.equal(sinceFiles.get('worktree.ts').code, 'M')
  assert.equal(sinceFiles.get('untracked.ts').code, 'A')
  assert.equal(sinceFiles.get('deleted-later.ts').code, 'D')
  assert.equal(sinceFiles.get('mv-new.ts').code, 'R')
  assert.equal(sinceFiles.get('mv-new.ts').renamedFrom, 'mv-old.ts')
  const untrackedSince = await against(history, 'untracked.ts', historySecond, 'since')
  assert.deepEqual(untrackedSince.target, { kind: 'worktree' })
  assert.equal(untrackedSince.base.sha, historySecond)
  assert.equal(untrackedSince.before, false)
  assert.equal(untrackedSince.after, true)
  assert.deepEqual(untrackedSince.hunks.flatMap((hunk) => hunk.lines), ['+untracked fresh'])
  const deletedSince = await against(history, 'deleted-later.ts', historySecond, 'since')
  assert.equal(deletedSince.before, true)
  assert.equal(deletedSince.after, false)
  assert.deepEqual(deletedSince.hunks.flatMap((hunk) => hunk.lines), ['-delete me'])
  const modifiedSince = await against(history, 'worktree.ts', historySecond, 'since')
  assert.equal(modifiedSince.before, true)
  assert.equal(modifiedSince.after, true)
  assert.deepEqual(modifiedSince.hunks.flatMap((hunk) => hunk.lines), ['-worktree base', '+worktree edited'])
  const recreatedSince = await against(history, 'recreate.ts', historySecond, 'since')
  assert.equal(recreatedSince.before, true)
  assert.equal(recreatedSince.after, true)
  assert.deepEqual(recreatedSince.hunks.flatMap((hunk) => hunk.lines), ['-recreate old', '+recreate new'])
  assert.equal((await against(history, 'untracked.ts', historySecond)).reason, 'file-unavailable')
  ok('since scope includes committed/staged/unstaged/untracked changes, deletions and renames')

  const oldText = await contentAt(history, 'a.ts', historySecond)
  assert.equal(oldText.kind, 'text')
  assert.equal(oldText.text, 'one\ntwo-b\nthree\n')
  assert.equal(oldText.lines, 3)
  assert.equal(oldText.bytes, Buffer.byteLength('one\ntwo-b\nthree\n'))
  assert.equal(oldText.version, historySecond)
  assert.equal(oldText.absolutePath, join(history, 'a.ts'))
  assert.equal((await contentAt(history, 'a.ts', historyRoot)).text, 'one\ntwo\nthree\n')
  assert.deepEqual(await contentAt(history, 'gone.ts', historyHead), { available: false, reason: 'file-unavailable' })
  const binaryContent = await contentAt(history, 'bin/blob.dat', historySecond)
  assert.equal(binaryContent.kind, 'binary')
  assert.equal(binaryContent.bytes, Buffer.byteLength('blob\0bytes\n'))
  const oversizedContent = await contentAt(history, 'big.txt', historyRoot)
  assert.equal(oversizedContent.kind, 'oversized')
  assert.equal(oversizedContent.bytes, bigText.length)
  assert.equal((await contentAt(history, 'a.ts', 'no-such-revision')).reason, 'unknown-revision')
  assert.equal((await contentAt(history, 'a.ts', 'bad revision')).reason, 'unknown-revision')
  const subContent = await contentAt(join(history, 'sub'), 'inner.ts', historyHead)
  assert.equal(subContent.kind, 'text')
  assert.equal(subContent.text, 'inner head\n')
  assert.equal(subContent.version, historyHead)
  ok('readGitContentAt serves historical text, binary, oversized, missing and unknown revisions')

  const subCommitCompare = await compare(sub, 'HEAD')
  assert.equal(subCommitCompare.available, true, JSON.stringify(subCommitCompare))
  assert.ok(subCommitCompare.files.some((entry) => entry.path === 'a.ts'))
  assert.ok(subCommitCompare.files.some((entry) => entry.path === '[slug]/page.ts'))
  assert.ok(subCommitCompare.files.every((entry) => !entry.path.startsWith('sub/') && !entry.path.startsWith('../') && entry.path !== 'root.ts' && entry.path !== 'incoming.ts'))
  const subSinceCompare = await compare(sub, 'HEAD', 'since')
  assert.equal(subSinceCompare.available, true, JSON.stringify(subSinceCompare))
  const subSinceFiles = new Map(subSinceCompare.files.map((entry) => [entry.path, entry]))
  assert.equal(subSinceFiles.get('new.ts').code, 'R')
  assert.equal(subSinceFiles.get('new.ts').renamedFrom, 'old.ts')
  assert.equal(subSinceFiles.get('incoming.ts').code, 'A')
  assert.equal(subSinceFiles.get('incoming.ts').renamedFrom, undefined)
  assert.equal(subSinceFiles.get('outgoing.ts').code, 'D')
  assert.deepEqual((await compare(aliases[1], 'HEAD', 'since')).files, subSinceCompare.files)
  assert.deepEqual((await compare(join(aliases[0], 'sub'), 'HEAD')).files, subCommitCompare.files)
  ok('version comparisons keep cwd-relative paths, rename boundaries and alias canonicalization')

  process.stdout.write('OK (' + groups + ' Git regression groups, ' + skipped + ' skipped)\n')
} finally {
  // Only remove the one freshly created directory directly inside the temp dir.
  assert.equal(dirname(resolve(temporaryRoot)), resolve(tmpdir()))
  assert.ok(basename(temporaryRoot).startsWith('dsh-review-panel-git-'))
  await rm(temporaryRoot, { recursive: true, force: true })
}
