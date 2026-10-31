#!/usr/bin/env node
/**
 * Offline smoke test for the built Host half: route registration, response
 * shapes, git integration (stubbed subprocess), workspace index/search, path
 * guards, and the authenticated Monaco static route.
 */
import { Readable } from 'node:stream'
import { realpath } from 'node:fs/promises'
import { registerApiRoutes } from '../lib/host/routes.js'
import { registerVendorRoute } from '../lib/host/assets.js'
import { fileUri } from '../lib/host/lsp.js'
import { coordinate } from '../lib/host/util.js'

const failures = []
const notes = []

/** Record a failure and continue. */
function fail(message) {
  failures.push(message)
}

/** Assert a condition. */
function assert(condition, message) {
  if (!condition) fail(message)
}

/** Canonical JSON text so payload comparisons ignore object key order. */
function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}'
  }
  return JSON.stringify(value)
}

/** Assert JSON payload deep equality (fixtures are JSON-shaped payloads). */
function assertDeep(actual, expected, message) {
  if (canonicalJson(actual) !== canonicalJson(expected)) fail(message + ' — got ' + JSON.stringify(actual))
}

// ---- Fixtures ----
// Directory identity is real; file contents and subprocesses remain fixtures.
const cwd = await realpath(new URL('../', import.meta.url))
const events = []
const routes = new Map()
const webRoutes = new Map()
const summaries = new Map()
const diffs = new Map()
const files = new Map()
const session = {
  header: { id: 'session-1', cwd },
  seq: 12,
  ownEvents: () => events.slice(),
}

const gitStatusOutput = [' M src/a.ts', '?? new.ts', 'A  added.ts'].join('\0') + '\0'
const gitDiffOutput = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,3 @@',
  ' a',
  '-b',
  '+b1',
  ' c',
  '',
].join('\n')

// ---- Revision comparison fixtures ----
const HEAD_SHA = 'a'.repeat(40)
const PARENT_SHA = 'b'.repeat(40)
const ROOT_SHA = 'c'.repeat(40)
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const HISTORICAL_TEXT = 'old src a\n'
const HISTORICAL_FIRST = 'first historical\n'
const HISTORICAL_BINARY_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]
const HISTORICAL_BINARY = Buffer.from(HISTORICAL_BINARY_BYTES).toString('utf8')
const historicalSizes = new Map([['src/a.ts', 10], ['first.ts', HISTORICAL_FIRST.length], ['img/logo.png', HISTORICAL_BINARY_BYTES.length]])
const historicalContents = new Map([['src/a.ts', HISTORICAL_TEXT], ['first.ts', HISTORICAL_FIRST], ['img/logo.png', HISTORICAL_BINARY]])
const gitCommitRecord = (fields) => fields.join('\u0000') + '\u001e\n'
const HEAD_RECORD = gitCommitRecord([HEAD_SHA, 'aaaaaaa', PARENT_SHA, 'Alice', '2026-10-29T10:00:00+08:00', 'HEAD -> main, origin/main, tag: v1', 'head subject'])
const PARENT_RECORD = gitCommitRecord([PARENT_SHA, 'bbbbbbb', ROOT_SHA, 'Bob', '2026-10-28T10:00:00+08:00', '', 'parent commit'])
const ROOT_RECORD = gitCommitRecord([ROOT_SHA, 'ccccccc', '', 'Bob', '2026-10-27T10:00:00+08:00', 'tag: root-tag', 'root commit'])
const NAME_STATUS_MIXED = 'M\0src/a.ts\0A\0added.ts\0D\0removed.ts\0R100\0renamed-old.ts\0renamed-new.ts\0'
const NAME_STATUS_ADDED = 'A\0src/a.ts\0A\0added.ts\0A\0removed.ts\0A\0root.ts\0'
const NAME_STATUS_SINCE = 'M\0src/a.ts\0D\0removed.ts\0R100\0renamed-old.ts\0renamed-new.ts\0'
const REMOVED_DIFF_OUTPUT = 'diff --git a/removed.ts b/removed.ts\n--- a/removed.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-removed source\n'
const ADDED_DIFF_OUTPUT = 'diff --git a/added.ts b/added.ts\n--- /dev/null\n+++ b/added.ts\n@@ -0,0 +1 @@\n+added source\n'

/** Fixture file existence for one canonical revision path. */
function fixtureExistsAt(sha, path) {
  if (sha !== HEAD_SHA && sha !== PARENT_SHA && sha !== ROOT_SHA) return false
  if (path === 'src/a.ts' || path === 'deleted.ts') return true
  if (path === 'added.ts' || path === 'renamed-new.ts') return sha === HEAD_SHA
  if (path === 'removed.ts' || path === 'renamed-old.ts') return sha !== HEAD_SHA
  if (path === 'first.ts' || path === 'img/logo.png') return sha === HEAD_SHA
  return false
}

/** Repository path after a `<rev>:<path>` object expression. */
function objectPath(object) {
  const separator = String(object).indexOf(':')
  return separator < 0 ? '' : String(object).slice(separator + 1)
}

/** Normalize a path for fixture lookups. */
function normalized(path) {
  return String(path).replace(/\\/g, '/').replace(/^\.\//, '')
}

/** Absolute fixture path. */
function absolute(key) {
  return (cwd + '/' + key).replace(/\//g, process.platform === 'win32' ? '\\' : '/')
}

let lspDone = null
let lastLspPosition = null
const fixtureUri = fileUri(absolute('src/a.ts')).replace(/\/([A-Z]):/, (_, drive) => '/' + drive.toLowerCase() + '%3A')
/** Fake interactive LSP server (initialize + a few textDocument methods). */
function fakeLspSpawn(spec) {
  const out = new Readable({ read() {} })
  const err = new Readable({ read() {} })
  let resolveDone = () => {}
  const done = new Promise((resolve) => { resolveDone = resolve })
  const send = (message) => {
    const json = JSON.stringify(message)
    out.push('Content-Length: ' + Buffer.byteLength(json, 'utf8') + '\r\n\r\n' + json)
  }
  const stdin = {
    write(chunk) {
      const text = String(chunk)
      const headerEnd = text.indexOf('\r\n\r\n')
      if (headerEnd < 0) return true
      let message
      try { message = JSON.parse(text.slice(headerEnd + 4)) } catch { return true }
      if (message.params?.position) lastLspPosition = message.params.position
      if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { capabilities: { definitionProvider: true, referencesProvider: true } } })
      else if (message.method === 'initialized') { /* noop */ }
      else if (message.method === 'textDocument/definition') send({ jsonrpc: '2.0', id: message.id, result: [{ uri: fixtureUri, range: { start: { line: 4, character: 2 }, end: { line: 4, character: 5 } } }] })
      else if (message.method === 'textDocument/references') send({ jsonrpc: '2.0', id: message.id, result: [{ uri: fixtureUri, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } } }] })
      else if (message.method === 'textDocument/hover') send({ jsonrpc: '2.0', id: message.id, result: { contents: { value: 'hover text' } } })
      else if (message.method === 'textDocument/completion') send({ jsonrpc: '2.0', id: message.id, result: { items: [{ label: 'alpha', kind: 3 }] } })
      else if (message.method === 'textDocument/documentSymbol') send({ jsonrpc: '2.0', id: message.id, result: [{ name: 'top', kind: 12, range: { start: { line: 0, character: 0 }, end: { line: 3, character: 0 } }, selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } }] })
      else if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, result: null })
      return true
    },
    end() {},
  }
  return {
    stdin,
    stdout: out,
    stderr: err,
    collected: { stdout: undefined, stderr: undefined },
    done,
    terminate: () => {
      try { out.push(null) } catch (error) { /* ignore */ }
      resolveDone({ exitCode: 0, signal: null })
    },
    waitForExit: async () => true,
  }
}

/** Build a fake SubprocessHandle for one argv. */
function fakeSpawn(spec) {
  if (spec.argv[0] === 'ts-ls') return fakeLspSpawn(spec)
  const argv = spec.argv.slice(1).join(' ')
  const last = spec.argv[spec.argv.length - 1]
  const fixtureCwd = spec.cwd === undefined ? '' : String(spec.cwd)
  let exitCode = 0
  let stdout = ''
  let stderr = ''
  if (argv.startsWith('rev-parse --show-toplevel')) {
    if (fixtureCwd.includes('not-a-repo')) {
      exitCode = 128
      stderr = 'fatal: not a git repository (or any of the parent directories): .git\n'
    } else {
      stdout = fixtureCwd + '\n'
    }
  } else if (argv.startsWith('rev-parse --show-object-format')) {
    stdout = 'sha1\n'
  } else if (argv.startsWith('rev-parse --abbrev-ref --symbolic-full-name @{upstream}')) {
    stdout = 'origin/main\n'
  } else if (argv.startsWith('rev-parse --abbrev-ref HEAD')) {
    stdout = 'main\n'
  } else if (argv.startsWith('rev-parse --verify --quiet ')) {
    const verified = last.endsWith('^{commit}') ? last.slice(0, -'^{commit}'.length) : last
    if (fixtureCwd.includes('unborn-fixture') || verified === 'unknown-revision') {
      exitCode = 1
    } else if (verified === 'HEAD' || verified === HEAD_SHA) {
      stdout = HEAD_SHA + '\n'
    } else if (verified === 'root' || verified === ROOT_SHA) {
      stdout = ROOT_SHA + '\n'
    } else if (verified === 'v1') {
      stdout = HEAD_SHA + '\n'
    } else if (verified === PARENT_SHA) {
      stdout = PARENT_SHA + '\n'
    } else if (/^[0-9a-f]{40}$/i.test(verified)) {
      stdout = verified.toLowerCase() + '\n'
    } else if (last.startsWith('HEAD')) {
      stdout = HEAD_SHA + '\n'
    } else {
      exitCode = 1
    }
  } else if (argv.startsWith('rev-list --count')) {
    stdout = '2\n'
  } else if (argv.startsWith('log -1 ')) {
    stdout = last === HEAD_SHA ? HEAD_RECORD : last === PARENT_SHA ? PARENT_RECORD : last === ROOT_SHA ? ROOT_RECORD : ''
    if (stdout === '') {
      exitCode = 128
      stderr = 'fatal: bad object ' + last + '\n'
    }
  } else if (argv.startsWith('log --max-count=')) {
    const match = /^log --max-count=(\d+)/.exec(argv)
    stdout = [HEAD_RECORD, PARENT_RECORD, ROOT_RECORD].slice(0, match ? Number(match[1]) : 60).join('')
  } else if (argv.startsWith('cat-file -t ')) {
    if (historicalContents.has(objectPath(last))) stdout = 'blob\n'
    else {
      exitCode = 128
      stderr = "fatal: path '" + objectPath(last) + "' does not exist\n"
    }
  } else if (argv.startsWith('cat-file -s ')) {
    const target = objectPath(last)
    if (historicalSizes.has(target)) stdout = String(historicalSizes.get(target)) + '\n'
    else {
      exitCode = 128
      stderr = "fatal: path '" + target + "' does not exist\n"
    }
  } else if (argv.startsWith('cat-file -e ')) {
    const separator = last.indexOf(':')
    const sha = separator < 0 ? '' : last.slice(0, separator)
    const target = separator < 0 ? '' : last.slice(separator + 1)
    exitCode = fixtureExistsAt(sha, target) ? 0 : 128
    if (exitCode !== 0) stderr = "fatal: path '" + target + "' does not exist\n"
  } else if (argv.startsWith('status')) {
    stdout = gitStatusOutput
  } else if (argv.startsWith('show ')) {
    if (historicalContents.has(objectPath(last))) stdout = historicalContents.get(objectPath(last))
    else {
      exitCode = 128
      stderr = "fatal: path '" + objectPath(last) + "' does not exist\n"
    }
  } else if (argv.startsWith('ls-files')) {
    const target = spec.argv[spec.argv.length - 1]
    exitCode = target === 'src/a.ts' || target === 'added.ts' ? 0 : 1
  } else if (argv.startsWith('diff --name-status')) {
    const revisions = spec.argv.filter((arg) => /^[0-9a-f]{40}$/i.test(arg))
    if (revisions.length >= 2) stdout = revisions[0].toLowerCase() === EMPTY_TREE_SHA ? NAME_STATUS_ADDED : NAME_STATUS_MIXED
    else stdout = NAME_STATUS_SINCE
  } else if (argv.startsWith('diff')) {
    stdout = /src\/a\.ts/.test(argv)
      ? gitDiffOutput
      : /removed\.ts/.test(argv)
        ? REMOVED_DIFF_OUTPUT
        : /added\.ts/.test(argv)
          ? ADDED_DIFF_OUTPUT
          : /deleted\.ts/.test(argv)
            ? 'diff --git a/deleted.ts b/deleted.ts\n--- a/deleted.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-old source\n'
            : ''
  } else {
    stderr = 'unexpected git invocation: ' + argv
    exitCode = 1
  }
  return {
    done: Promise.resolve({ exitCode, signal: null }),
    collected: {
      stdout: { readFrom: () => ({ text: stdout, lossy: false }) },
      stderr: { readFrom: () => ({ text: stderr, lossy: false }) },
    },
    terminate: async () => {},
    waitForExit: async () => ({ exitCode, signal: null }),
  }
}

const ctx = {
  on(name, listener) {
    if (name === 'session/event') session.emit = (event) => listener(session, event)
    return () => {}
  },
  effect(callback) {
    const cleanup = callback()
    return () => {
      if (typeof cleanup === 'function') cleanup()
    }
  },
  logger: { warn: () => {}, info: () => {}, error: () => {} },
  sessions: {
    get(id) {
      return id === 'session-1' ? session : undefined
    },
  },
  subprocess: {
    async resolveExecutable(command) {
      if (command === 'git') return 'git'
      if (command === 'typescript-language-server') return 'ts-ls'
      throw new Error('not found: ' + command)
    },
    spawn(spec) {
      return fakeSpawn(spec)
    },
  },
  connection: {
    fetch: {
      register(route) {
        routes.set(route.path, route)
        return async () => routes.delete(route.path)
      },
    },
    requestRejection() {
      return undefined
    },
  },
  webServer: {
    register(route) {
      webRoutes.set(route.path, route)
      return () => webRoutes.delete(route.path)
    },
  },
  workspaceChanges: {
    summary(id, seq) {
      return id === 'session-1' ? summaries.get(seq) : undefined
    },
    async diff(id, seq, index) {
      return id === 'session-1' ? diffs.get(String(seq) + ':' + String(index)) : undefined
    },
  },
  workspaceFiles: {
    async stat(scope, path) {
      const key = normalized(path)
      if (key === 'deleted.ts') throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      if (key === 'permission.ts') throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      if (key === 'broken.ts') throw Object.assign(new Error('I/O failure'), { code: 'EIO' })
      const entry = files.get(key)
      if (!entry) throw Object.assign(new Error('not-found'), { code: 'ENOENT' })
      return { absolutePath: absolute(key), version: 'v1', bytes: entry.data.length }
    },
    async readBytes(scope, path) {
      const key = normalized(path)
      const entry = files.get(key)
      if (!entry) throw new Error('not-found')
      return { data: entry.data, version: 'v1', offset: 0, eof: true }
    },
    async list(scope, path) {
      const key = normalized(path)
      const rootKey = normalized(cwd)
      if (key === '' || key === rootKey) {
        return {
          path: String(path),
          entries: [
            { name: 'src', type: 'directory' },
            { name: 'plain.txt', type: 'file', size: 12 },
            { name: 'added.ts', type: 'file', size: 12 },
            { name: 'new.ts', type: 'file', size: 14 },
            { name: 'node_modules', type: 'directory' },
          ],
          truncated: false,
        }
      }
      if (key === 'src') {
        return { path: String(path), entries: [{ name: 'a.ts', type: 'file', size: 10 }], truncated: false }
      }
      throw new Error('not-found')
    },
  },
}

summaries.set(12, {
  turn: 3,
  cwd,
  total: 2,
  added: 5,
  deleted: 2,
  files: [
    { path: 'src/a.ts', display: 'src/a.ts', added: 4, deleted: 1 },
    { path: 'img/logo.png', display: 'img/logo.png', added: 1, deleted: 1, binary: true },
  ],
})
diffs.set('12:0', {
  kind: 'text',
  path: 'src/a.ts',
  display: 'src/a.ts',
  before: true,
  after: true,
  coarse: false,
  hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [' a', '-b', '+b1', ' c'] }],
})
files.set('src/a.ts', { data: new TextEncoder().encode('a\nb1\nc\n') })
files.set('plain.txt', { data: new TextEncoder().encode('hello\nworld\n') })
files.set('added.ts', { data: new TextEncoder().encode('added\n') })
files.set('new.ts', { data: new TextEncoder().encode('fresh line\n') })
files.set('img/logo.png', { data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]) })

// ---- Registration ----
try {
  registerApiRoutes(ctx)
} catch (error) {
  fail('registerApiRoutes threw: ' + (error && error.stack ? error.stack : String(error)))
}
for (const path of [
  '/api/review-panel.latest',
  '/api/review-panel.summary',
  '/api/review-panel.diff',
  '/api/review-panel.file',
  '/api/review-panel.tree',
  '/api/review-panel.config',
  '/api/review-panel.git-status',
  '/api/review-panel.git-file',
  '/api/review-panel.git-revisions',
  '/api/review-panel.git-compare',
  '/api/review-panel.files',
  '/api/review-panel.search',
]) {
  assert(routes.has(path), 'route not registered: ' + path)
}

/** Invoke one registered route with a synthetic authenticated POST request. */
async function callPost(path, payload) {
  const route = routes.get(path)
  if (!route) throw new Error('missing route ' + path)
  const request = new Request('http://127.0.0.1' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload || {}),
  })
  const response = await route.fetch(request)
  let body = null
  try { body = await response.json() } catch { body = null }
  return { status: response.status, body }
}
/** Invoke one registered route with a synthetic authenticated GET request. */
async function call(path, query) {
  const route = routes.get(path)
  if (!route) throw new Error('missing route ' + path)
  const url = 'http://127.0.0.1' + path + '?' + new URLSearchParams(query || {}).toString()
  return route.fetch(new Request(url))
}

/** Read JSON from a route response. */
async function callJson(path, query) {
  const response = await call(path, query)
  let body = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  return { status: response.status, body }
}

// ---- Turn routes ----
session.emit({ type: 'workspace/changes', seq: 12, data: { turn: 3 } })
let result = await callJson('/api/review-panel.latest', { sessionId: 'session-1' })
assert(result.status === 200 && result.body.available === true, 'latest should be available')
assert(result.body.seq === 12 && result.body.turn === 3, 'latest coordinates mismatch')
assert(result.body.summary && result.body.summary.files.length === 2, 'latest summary files mismatch')
assert(result.body.summary.cwd === undefined, 'latest must strip the internal cwd')
notes.push('latest: ok')

result = await callJson('/api/review-panel.summary', { sessionId: 'session-1', seq: 12 })
assert(result.status === 200 && result.body.turn === 3 && result.body.total === 2, 'summary payload mismatch')
result = await callJson('/api/review-panel.summary', { sessionId: 'session-1', seq: 99 })
assert(result.status === 404, 'missing summary should be 404')
notes.push('summary: ok')

result = await callJson('/api/review-panel.diff', { sessionId: 'session-1', seq: 12, index: 0 })
assert(result.status === 200 && result.body.kind === 'text' && result.body.hunks.length === 1, 'diff payload mismatch')
result = await callJson('/api/review-panel.diff', { sessionId: 'session-1', seq: 12 })
assert(result.status === 400, 'missing diff index should be 400')
notes.push('diff: ok')

result = await callJson('/api/review-panel.file', { sessionId: 'session-1', path: 'src/a.ts' })
assert(result.status === 200 && result.body.kind === 'text' && result.body.text === 'a\nb1\nc\n', 'file text payload mismatch')
result = await callJson('/api/review-panel.file', { sessionId: 'session-1', path: 'img/logo.png' })
assert(result.body.kind === 'binary', 'binary detection failed')
result = await callJson('/api/review-panel.file', { sessionId: 'session-1', path: '../secrets.txt' })
assert(result.status === 400, 'traversal must be rejected with 400')
result = await callJson('/api/review-panel.file', { sessionId: 'session-1', path: 'missing.ts' })
assert(result.status === 404, 'missing file should be 404')
assert(result.body.error?.code === 'not-found', 'missing file must identify not-found')
result = await callJson('/api/review-panel.file', { sessionId: 'session-1', path: 'permission.ts' })
assert(result.status === 403 && result.body.error?.code !== 'not-found', 'permission errors must not look like deleted files')
result = await callJson('/api/review-panel.file', { sessionId: 'session-1', path: 'broken.ts' })
assert(result.status === 502 && result.body.error?.code !== 'not-found', 'I/O errors must not look like deleted files')
notes.push('file: ok')

// Workspace containment follows the Host path style, including POSIX roots and
// case-sensitive directories. Windows/UNC identity remains case-insensitive.
const originalCwd = session.header.cwd
const originalStat = ctx.workspaceFiles.stat
const originalRead = ctx.workspaceFiles.readBytes
try {
  for (const [workspace, absolutePath, expected] of [
    ['/workspace/Repo', '/workspace/repo/probe.ts', 403],
    ['/workspace/repo', '/workspace/repo-other/probe.ts', 403],
    ['/workspace/repo', '/workspace/repo/../other/probe.ts', 403],
    ['/workspace/repo', '/workspace/repo/probe.ts', 200],
    ['/', '/probe.ts', 200],
    ['E:\\Workspace', 'e:\\workspace\\Probe.ts', 200],
    ['\\\\server\\share\\work', '\\\\SERVER\\share\\work\\probe.ts', 200],
  ]) {
    session.header.cwd = workspace
    ctx.workspaceFiles.stat = async () => ({ absolutePath, bytes: 5 })
    ctx.workspaceFiles.readBytes = async () => ({ data: new TextEncoder().encode('probe'), eof: true })
    result = await callJson('/api/review-panel.file', { sessionId: 'session-1', path: 'probe.ts' })
    assert(result.status === expected, 'workspace containment mismatch for ' + workspace + ' -> ' + absolutePath)
  }
} finally {
  session.header.cwd = originalCwd
  ctx.workspaceFiles.stat = originalStat
  ctx.workspaceFiles.readBytes = originalRead
}
notes.push('POSIX/Windows/UNC file containment: ok')

result = await callJson('/api/review-panel.tree', { sessionId: 'session-1', path: '' })
assert(result.status === 200 && Array.isArray(result.body.entries) && result.body.entries.length === 5, 'tree entries mismatch')
notes.push('tree: ok')

result = await callJson('/api/review-panel.config', {})
assert(result.body.phase === 3 && result.body.features.git === true && result.body.features.turn === true && result.body.features.lsp === true, 'config feature flags mismatch')
assert(result.body.features.gitRevisions === true, 'config must advertise the gitRevisions feature')
notes.push('config: ok')
// ---- LSP bridge (stubbed interactive language server) ----
result = await callPost('/api/review-panel.lsp', { sessionId: 'session-1', action: 'status', languageId: 'typescript' })
assert(result.status === 200 && result.body.available === true && result.body.server === 'typescript', 'lsp status should detect typescript')

result = await callPost('/api/review-panel.lsp', { sessionId: 'session-1', action: 'status', languageId: 'python' })
if (result.body.available !== false) process.stdout.write('DEBUG python: ' + JSON.stringify(result.body) + '\n')
assert(result.body.available === false && result.body.reason === 'missing-server', 'lsp status should report a missing python server')
assert(typeof result.body.install === 'string' && result.body.install.length > 0, 'missing server should carry an install hint')

result = await callPost('/api/review-panel.lsp', { sessionId: 'session-1', action: 'definition', path: 'src/a.ts', languageId: 'typescript', line: 6, column: 3, text: 'a\nb1\nc\n' })
assert(result.status === 200 && result.body.available === true, 'lsp definition should be available')
if (!result.body.locations) process.stdout.write('DEBUG definition: ' + JSON.stringify(result.body) + '\n')
assert(result.body.locations.length === 1 && result.body.locations[0].path === 'src/a.ts' && result.body.locations[0].line === 5, 'lsp definition location mismatch')
assert(lastLspPosition?.line === 5 && lastLspPosition?.character === 2, 'JSON numeric line/column must reach LSP as zero-based position, not fall back to 0:0')
assert(coordinate(22) === 22 && coordinate('22') === 22, 'coordinate must support JSON numbers and URL strings')
for (const invalid of [null, undefined, NaN, Infinity, -1, 1.5, '', '1x', {}, true]) assert(coordinate(invalid) === undefined, 'invalid coordinate accepted: ' + String(invalid))

result = await callPost('/api/review-panel.lsp', { sessionId: 'session-1', action: 'references', path: 'src/a.ts', languageId: 'typescript', line: 2, column: 1, text: 'a\nb1\nc\n' })
assert(result.body.available === true && result.body.locations.length === 1, 'lsp references mismatch')

result = await callPost('/api/review-panel.lsp', { sessionId: 'session-1', action: 'hover', path: 'src/a.ts', languageId: 'typescript', line: 2, column: 1, text: 'a\nb1\nc\n' })
assert(result.body.available === true && result.body.contents === 'hover text', 'lsp hover mismatch')

notes.push('lsp bridge: ok')

// ---- Git routes (stubbed subprocess) ----
result = await callJson('/api/review-panel.git-status', { sessionId: 'session-1' })
assert(result.status === 200 && result.body.available === true, 'git status should be available')
assert(result.body.root === cwd, 'git status root mismatch')
const byPath = new Map((result.body.files || []).map((entry) => [entry.path, entry.code]))
assert(byPath.get('src/a.ts') === 'M', 'git status should report modified src/a.ts')
assert(byPath.get('new.ts') === '?', 'git status should report untracked new.ts')
assert(byPath.get('added.ts') === 'A', 'git status should report staged added.ts')
notes.push('git-status: ok')

result = await callJson('/api/review-panel.git-status', { sessionId: 'nope' })
assert(result.status === 404, 'git status for unknown session should be 404')

result = await callJson('/api/review-panel.git-file', { sessionId: 'session-1', path: 'src/a.ts' })
assert(result.status === 200 && result.body.kind === 'text' && result.body.hunks.length === 1, 'git file diff payload mismatch')
assert(result.body.hunks[0].lines.includes('-b') && result.body.hunks[0].lines.includes('+b1'), 'git hunk lines mismatch')

result = await callJson('/api/review-panel.git-file', { sessionId: 'session-1', path: 'deleted.ts' })
assert(result.status === 200 && result.body.kind === 'text' && result.body.before === true && result.body.after === false, 'deleted Git file should expose its old text')
assert(result.body.hunks[0].lines[0] === '-old source', 'deleted Git file must retain deletion hunks')

result = await callJson('/api/review-panel.git-file', { sessionId: 'session-1', path: 'new.ts' })
assert(result.status === 200 && result.body.kind === 'text' && result.body.before === false, 'untracked comparison shape mismatch')
assert(result.body.hunks[0].lines.length === 1 && result.body.hunks[0].lines[0] === '+fresh line', 'untracked comparison lines mismatch')

result = await callJson('/api/review-panel.git-file', { sessionId: 'session-1', path: 'img/logo.png' })
assert(result.status === 200 && result.body.kind === 'binary', 'binary extension should be refused')

result = await callJson('/api/review-panel.git-file', { sessionId: 'session-1', path: '../escape.ts' })
assert(result.status === 400, 'git file path traversal must be rejected')
notes.push('git-file: ok')

// ---- Extended git-file (revision scope) ----
result = await callJson('/api/review-panel.git-file', { sessionId: 'session-1', path: 'src/a.ts', rev: 'HEAD', scope: 'commit' })
assert(result.status === 200 && result.body.kind === 'text', 'rev git-file should be text')
assert(result.body.before === true && result.body.after === true, 'rev git-file flags mismatch')
assert(result.body.base.sha === PARENT_SHA && result.body.base.short === 'bbbbbbb', 'rev git-file base mismatch')
assert(result.body.target.kind === 'commit' && result.body.target.sha === HEAD_SHA && result.body.target.short === 'aaaaaaa', 'rev git-file target mismatch')
assert(result.body.hunks.length === 1, 'rev git-file hunks mismatch')

result = await callJson('/api/review-panel.git-file', { sessionId: 'session-1', path: 'added.ts', rev: 'HEAD', scope: 'commit' })
assert(result.status === 200 && result.body.kind === 'text' && result.body.before === false && result.body.after === true, 'added rev git-file flags mismatch')
assert(result.body.hunks[0].lines.includes('+added source'), 'added rev git-file content mismatch')

result = await callJson('/api/review-panel.git-file', { sessionId: 'session-1', path: 'removed.ts', rev: 'HEAD', scope: 'commit' })
assert(result.status === 200 && result.body.before === true && result.body.after === false, 'removed rev git-file flags mismatch')
assert(result.body.hunks[0].lines.includes('-removed source'), 'removed rev git-file content mismatch')

result = await callJson('/api/review-panel.git-file', { sessionId: 'session-1', path: 'src/a.ts', rev: 'root', scope: 'commit' })
assert(result.status === 200 && result.body.base.sha === EMPTY_TREE_SHA, 'root commit base should be the empty tree')

result = await callJson('/api/review-panel.git-file', { sessionId: 'session-1', path: 'new.ts', rev: 'HEAD', scope: 'since' })
assert(result.status === 200 && result.body.kind === 'text' && result.body.before === false && result.body.after === true, 'since rev git-file untracked flags mismatch')
assert(result.body.target.kind === 'worktree', 'since rev git-file target must be the worktree')
assert(result.body.hunks[0].lines.length === 1 && result.body.hunks[0].lines[0] === '+fresh line', 'since rev git-file untracked lines mismatch')

result = await callJson('/api/review-panel.git-file', { sessionId: 'session-1', path: 'src/a.ts', rev: 'HEAD', scope: 'nope' })
assert(result.status === 400 && result.body.error?.code === 'invalid-scope', 'invalid scope must be 400 invalid-scope')
result = await callJson('/api/review-panel.git-file', { sessionId: 'session-1', path: 'src/a.ts', rev: 'bad rev' })
assert(result.status === 400 && result.body.error?.code === 'invalid-revision', 'invalid revision syntax must be 400 invalid-revision')
result = await callJson('/api/review-panel.git-file', { sessionId: 'session-1', path: 'src/a.ts', rev: 'unknown-revision' })
assert(result.status === 200 && result.body.available === false && result.body.reason === 'unknown-revision', 'unknown revision git-file should be a 200 unavailable payload')
result = await callJson('/api/review-panel.git-file', { sessionId: 'session-1', path: '../escape.ts', rev: 'HEAD' })
assert(result.status === 400, 'rev git-file path traversal must be rejected')
notes.push('git-file rev: ok')

// ---- git-compare (commit and since scopes) ----
result = await callJson('/api/review-panel.git-compare', { sessionId: 'session-1', rev: 'HEAD' })
assert(result.status === 200 && result.body.available === true, 'git-compare should be available')
assert(result.body.root === cwd, 'git-compare root mismatch')
assert(result.body.scope === 'commit', 'git-compare default scope mismatch')
assertDeep(result.body.base, { sha: PARENT_SHA, short: 'bbbbbbb', subject: 'parent commit', emptyTree: false }, 'git-compare base mismatch')
assertDeep(result.body.target, { kind: 'commit', sha: HEAD_SHA, short: 'aaaaaaa', subject: 'head subject' }, 'git-compare target mismatch')
assertDeep(result.body.files, [
  { path: 'src/a.ts', code: 'M' },
  { path: 'added.ts', code: 'A' },
  { path: 'removed.ts', code: 'D' },
  { path: 'renamed-new.ts', code: 'R', renamedFrom: 'renamed-old.ts' },
], 'git-compare files mismatch')
assert(result.body.truncated === false, 'git-compare truncated mismatch')

result = await callJson('/api/review-panel.git-compare', { sessionId: 'session-1', rev: 'root', scope: 'commit' })
assert(result.status === 200 && result.body.available === true, 'root git-compare should be available')
assertDeep(result.body.base, { sha: EMPTY_TREE_SHA, short: '4b825dc', subject: 'empty tree', emptyTree: true }, 'root git-compare base must be the empty tree')
assertDeep(result.body.target, { kind: 'commit', sha: ROOT_SHA, short: 'ccccccc', subject: 'root commit' }, 'root git-compare target mismatch')
assertDeep(result.body.files, [
  { path: 'src/a.ts', code: 'A' },
  { path: 'added.ts', code: 'A' },
  { path: 'removed.ts', code: 'A' },
  { path: 'root.ts', code: 'A' },
], 'root git-compare files must be all additions')

result = await callJson('/api/review-panel.git-compare', { sessionId: 'session-1', rev: 'HEAD', scope: 'since' })
assert(result.status === 200 && result.body.available === true, 'since git-compare should be available')
assert(result.body.scope === 'since', 'since git-compare scope mismatch')
assertDeep(result.body.base, { sha: HEAD_SHA, short: 'aaaaaaa', subject: 'head subject', emptyTree: false }, 'since git-compare base mismatch')
assertDeep(result.body.target, { kind: 'worktree' }, 'since git-compare target must be the worktree')
assertDeep(result.body.files, [
  { path: 'src/a.ts', code: 'M' },
  { path: 'removed.ts', code: 'D' },
  { path: 'renamed-new.ts', code: 'R', renamedFrom: 'renamed-old.ts' },
  { path: 'new.ts', code: 'A' },
], 'since git-compare must include untracked worktree files')

result = await callJson('/api/review-panel.git-compare', { sessionId: 'session-1' })
assert(result.status === 400 && result.body.error?.code === 'invalid-revision', 'missing rev must be 400 invalid-revision')
result = await callJson('/api/review-panel.git-compare', { sessionId: 'session-1', rev: 'bad rev' })
assert(result.status === 400 && result.body.error?.code === 'invalid-revision', 'invalid rev syntax must be 400 invalid-revision')
result = await callJson('/api/review-panel.git-compare', { sessionId: 'session-1', rev: 'HEAD', scope: 'nope' })
assert(result.status === 400 && result.body.error?.code === 'invalid-scope', 'unknown compare scope must be 400 invalid-scope')
result = await callJson('/api/review-panel.git-compare', { sessionId: 'session-1', rev: 'unknown-revision' })
assert(result.status === 200 && result.body.available === false && result.body.reason === 'unknown-revision', 'unknown rev compare payload mismatch')
result = await callJson('/api/review-panel.git-compare', { sessionId: 'nope', rev: 'HEAD' })
assert(result.status === 404, 'git-compare for unknown session should be 404')
notes.push('git-compare: ok')

// ---- git-revisions (picker data) ----
result = await callJson('/api/review-panel.git-revisions', { sessionId: 'session-1' })
assert(result.status === 200 && result.body.available === true, 'git-revisions should be available')
assert(result.body.root === cwd && result.body.unborn === false, 'git-revisions head coordinates mismatch')
assertDeep(result.body.head, {
  sha: HEAD_SHA,
  short: 'aaaaaaa',
  subject: 'head subject',
  date: '2026-10-29T10:00:00+08:00',
  branch: 'main',
  upstream: 'origin/main',
  ahead: 2,
  detached: false,
}, 'git-revisions head payload mismatch')
assert(result.body.commits.length === 3, 'git-revisions commit list mismatch')
assertDeep(result.body.commits[0], {
  sha: HEAD_SHA,
  short: 'aaaaaaa',
  subject: 'head subject',
  author: 'Alice',
  date: '2026-10-29T10:00:00+08:00',
  parents: [PARENT_SHA],
  refs: ['HEAD -> main', 'origin/main', 'tag: v1'],
}, 'git-revisions commit entry mismatch')
assert(result.body.commits[1].sha === PARENT_SHA && result.body.commits[2].sha === ROOT_SHA, 'git-revisions commit order mismatch')
assert(result.body.resolved === undefined && result.body.resolveError === undefined, 'git-revisions must omit resolution fields without q')

result = await callJson('/api/review-panel.git-revisions', { sessionId: 'session-1', q: 'v1' })
assert(result.status === 200 && result.body.resolved?.sha === HEAD_SHA, 'git-revisions raw tag resolution mismatch')
assert(result.body.resolveError === undefined, 'resolved tag must not carry resolveError')

result = await callJson('/api/review-panel.git-revisions', { sessionId: 'session-1', q: 'root' })
assert(result.status === 200 && result.body.resolved?.sha === ROOT_SHA, 'git-revisions raw root resolution mismatch')
assertDeep(result.body.resolved.parents, [], 'root resolution parents mismatch')

result = await callJson('/api/review-panel.git-revisions', { sessionId: 'session-1', q: 'unknown-revision' })
assert(result.status === 200 && result.body.available === true && result.body.resolveError === 'Unknown git revision.', 'unknown q must be a 200 resolveError')
assert(result.body.resolved === undefined, 'unknown q must not include a resolved commit')

result = await callJson('/api/review-panel.git-revisions', { sessionId: 'session-1', q: 'bad rev' })
assert(result.status === 200 && result.body.resolveError === 'Invalid git revision.', 'invalid q must be a 200 resolveError')

result = await callJson('/api/review-panel.git-revisions', { sessionId: 'session-1', limit: 1 })
assert(result.status === 200 && result.body.commits.length === 1, 'git-revisions limit coordinate mismatch')

result = await callJson('/api/review-panel.git-revisions', { sessionId: 'nope' })
assert(result.status === 404, 'git-revisions for unknown session should be 404')
notes.push('git-revisions: ok')

// ---- file at a revision ----
result = await callJson('/api/review-panel.file', { sessionId: 'session-1', path: 'src/a.ts', rev: 'HEAD' })
assert(result.status === 200 && result.body.kind === 'text', 'rev file should be text')
assert(result.body.text === HISTORICAL_TEXT && result.body.lines === 1, 'rev file text mismatch')
assert(result.body.version === HEAD_SHA, 'rev file version must be the resolved sha')
assert(result.body.path === 'src/a.ts' && result.body.display === 'src/a.ts', 'rev file path fields mismatch')

result = await callJson('/api/review-panel.file', { sessionId: 'session-1', path: 'img/logo.png', rev: 'HEAD' })
assert(result.status === 200 && result.body.kind === 'binary' && result.body.bytes === HISTORICAL_BINARY_BYTES.length, 'rev file binary mismatch')

result = await callJson('/api/review-panel.file', { sessionId: 'session-1', path: 'gone-at-rev.ts', rev: 'HEAD' })
assert(result.status === 404 && result.body.error?.code === 'not-found', 'file missing at revision must be 404 not-found')
result = await callJson('/api/review-panel.file', { sessionId: 'session-1', path: 'src/a.ts', rev: 'unknown-revision' })
assert(result.status === 400 && result.body.error?.code === 'invalid-revision', 'unknown rev file must be 400 invalid-revision')
result = await callJson('/api/review-panel.file', { sessionId: 'session-1', path: 'src/a.ts', rev: 'bad rev' })
assert(result.status === 400 && result.body.error?.code === 'invalid-revision', 'invalid rev file must be 400 invalid-revision')
result = await callJson('/api/review-panel.file', { sessionId: 'session-1', path: '../secrets.ts', rev: 'HEAD' })
assert(result.status === 400, 'rev file path traversal must be rejected')
notes.push('file rev: ok')

// ---- repository availability (not-git and unborn) ----
const recordedCwd = session.header.cwd
try {
  session.header.cwd = '/not-a-repo/project'
  result = await callJson('/api/review-panel.git-compare', { sessionId: 'session-1', rev: 'HEAD' })
  assert(result.status === 200 && result.body.available === false && result.body.reason === 'not-git', 'git-compare outside a repo must report not-git')
  result = await callJson('/api/review-panel.git-revisions', { sessionId: 'session-1' })
  assert(result.status === 200 && result.body.available === false && result.body.reason === 'not-git', 'git-revisions outside a repo must report not-git')
  session.header.cwd = '/unborn-fixture'
  result = await callJson('/api/review-panel.git-revisions', { sessionId: 'session-1' })
  assert(result.status === 200 && result.body.available === true && result.body.unborn === true, 'unborn repo must report unborn')
  assert(result.body.head === null && result.body.commits.length === 0, 'unborn repo must have no head or commits')
} finally {
  session.header.cwd = recordedCwd
}
notes.push('git repository availability: ok')

// ---- Workspace index / search ----
result = await callJson('/api/review-panel.files', { sessionId: 'session-1' })
assert(result.status === 200 && Array.isArray(result.body.files), 'files index payload mismatch')
assert(result.body.files.includes('src/a.ts') && result.body.files.includes('plain.txt'), 'files index missing entries')
assert(!result.body.files.some((path) => path.includes('node_modules')), 'files index must skip node_modules')
notes.push('files index: ok')

result = await callJson('/api/review-panel.search', { sessionId: 'session-1', q: 'world' })
assert(result.status === 200 && Array.isArray(result.body.results), 'search payload mismatch')
assert(result.body.results.length === 1, 'search should find one hit, got ' + result.body.results.length)
assert(result.body.results[0].path === 'plain.txt' && result.body.results[0].line === 2, 'search hit coordinates mismatch')
notes.push('search: ok')

// ---- Monaco vendor route ----
try {
  registerVendorRoute(ctx)
} catch (error) {
  fail('registerVendorRoute threw: ' + (error && error.stack ? error.stack : String(error)))
}
const vendor = webRoutes.get('/dsh-review-panel/monaco')
assert(vendor && vendor.kind === 'prefix', 'vendor prefix route missing')

/** Invoke the vendor handler with stub node req/res. */
async function requestVendor(url, method) {
  const record = { status: 0, headers: {}, body: null, ended: false }
  const response = {
    statusCode: 0,
    headersSent: false,
    setHeader(name, value) {
      record.headers[name.toLowerCase()] = value
    },
    end(payload) {
      record.status = this.statusCode
      record.ended = true
      record.body = payload === undefined ? null : payload
    },
  }
  const request = { url, method, headers: {} }
  const pending = vendor.handler(request, response)
  if (pending && typeof pending.then === 'function') await pending
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 60))
  return record
}

let assetResult = await requestVendor('/dsh-review-panel/monaco/vs/loader.js', 'GET')
assert(assetResult.headers['content-type'] === 'text/javascript; charset=utf-8', 'vendor content-type mismatch')
assert(assetResult.headers.etag, 'vendor etag missing')
assert(assetResult.body && assetResult.body.length > 1000, 'vendor loader.js body missing')
notes.push('vendor GET: ok')

ctx.connection.requestRejection = () => 401
assetResult = await requestVendor('/dsh-review-panel/monaco/vs/loader.js', 'GET')
assert(assetResult.status === 401, 'vendor auth rejection expected 401, got ' + assetResult.status)
ctx.connection.requestRejection = () => undefined
notes.push('vendor auth: ok')

assetResult = await requestVendor('/dsh-review-panel/monaco/../package.json', 'GET')
assert(assetResult.status === 403 || assetResult.status === 404, 'vendor traversal must be refused')
notes.push('vendor traversal: ok')

process.stdout.write('\n=== host smoke notes ===\n')
for (const note of notes) process.stdout.write('· ' + note + '\n')
process.stdout.write('\n=== failures (' + failures.length + ') ===\n')
for (const failure of failures) process.stdout.write('x ' + failure + '\n')
if (failures.length > 0) process.exitCode = 1
else process.stdout.write('OK\n')




