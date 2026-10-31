#!/usr/bin/env node
/** Regression checks for the actual navigation chain; --real also starts the installed TS server. */
import assert from 'node:assert/strict'
import { access, mkdir, readFile, mkdtemp, stat, writeFile, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { detectServer, fileUri, npmGlobalRoots, uriToPath, relativeToCwd, LspBridge } from '../lib/host/lsp.js'
import { registerApiRoutes } from '../lib/host/routes.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const range = { start: { line: 14, character: 13 }, end: { line: 14, character: 26 } }
let groups = 0
const ok = (name) => { groups++; console.log('PASS ' + name) }

assert.equal(relativeToCwd('E:\\Workspace', uriToPath('file:///e%3A/workspace/src/a.ts')), 'src/a.ts')
assert.equal(relativeToCwd('E:\\Workspace', 'e:/WORKSPACE/src/A.ts'), 'src/A.ts')
assert.equal(relativeToCwd('E:\\Workspace', 'E:/Workspace-other/a.ts'), 'E:/Workspace-other/a.ts')
assert.equal(relativeToCwd('E:\\Workspace', 'E:/Workspace/../outside/a.ts'), 'E:/outside/a.ts')
assert.equal(relativeToCwd('/workspace', '/Workspace/a.ts'), '/Workspace/a.ts')
assert.equal(relativeToCwd('/', '/src/a.ts'), 'src/a.ts')
assert.equal(relativeToCwd('\\\\server\\share\\root', uriToPath('file://SERVER/share/root/a.ts')), 'a.ts')
for (const path of ['E:/测试 folder/a#b%20.ts', '/tmp/测试 folder/a#b%.ts', '//server/share/测试 #%.ts']) {
  assert.equal(uriToPath(fileUri(path)), path)
}
ok('Windows/POSIX/UNC path identity, URI escaping and workspace boundaries')

const posixRoots = npmGlobalRoots({platform:'darwin',home:'/Users/dev',env:{
  NPM_CONFIG_PREFIX:'/custom/npm',NVM_BIN:'/Users/dev/.nvm/versions/node/v22/bin',NODE_PATH:'/shared/modules:/other/modules',
}})
for (const path of ['/custom/npm/lib/node_modules','/opt/homebrew/lib/node_modules','/Users/dev/.nvm/versions/node/v22/lib/node_modules','/shared/modules','/other/modules']) assert(posixRoots.includes(path))
assert(!posixRoots.some(path=>path.includes('AppData') || path.includes('\\')))
const windowsRoots = npmGlobalRoots({platform:'win32',home:'C:\\Users\\dev',env:{APPDATA:'C:\\Roaming',npm_config_prefix:'D:\\npm'}})
assert(windowsRoots.includes('D:\\npm\\node_modules'))
assert(windowsRoots.includes('C:\\Roaming\\npm\\node_modules'))
assert(!windowsRoots.some(path=>path.startsWith('/usr') || path.startsWith('/opt')))
const prefixFixture = await mkdtemp(join(tmpdir(),'dsh-lsp-prefix-'))
const previousPrefix = process.env.npm_config_prefix
try {
  const moduleRoot = join(prefixFixture, ...(process.platform === 'win32' ? [] : ['lib']), 'node_modules')
  const entry = join(moduleRoot,'typescript-language-server','lib','cli.mjs')
  await mkdir(dirname(entry),{recursive:true})
  await writeFile(entry,'// Detection fixture only; this file is never executed.\n')
  process.env.npm_config_prefix = prefixFixture
  const detected = await detectServer({resolveExecutable:async command=>command==='node'?'fixture-node':null},'typescript')
  assert.equal(detected?.command,'fixture-node')
  assert.deepEqual(detected?.args,[entry,'--stdio'])
} finally {
  if (previousPrefix === undefined) delete process.env.npm_config_prefix
  else process.env.npm_config_prefix = previousPrefix
  assert.equal(dirname(resolve(prefixFixture)),resolve(tmpdir()))
  await rm(prefixFixture,{recursive:true,force:true})
}
ok('platform-specific npm prefixes, macOS Homebrew/nvm roots and custom-prefix Node fallback')

let available = true
let send
let definitionUri = 'file:///e%3A/workspace/src/a.ts'
let textDocumentSync = { openClose: true, change: 1 }
let holdDefinitions = false
const heldDefinitions = []
const messages = []
const fakeProcess = {
  async resolveExecutable(command) {
    if (available && command === 'typescript-language-server') return 'fake-lsp'
    throw Error('not installed')
  },
  spawn() {
    const stdout = new Readable({ read() {} })
    let finish
    const done = new Promise((resolve) => { finish = resolve })
    send = (message) => {
      const body = JSON.stringify(message)
      const bytes = Buffer.from('Content-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body)
      // Split even the header to exercise real stream framing.
      stdout.push(bytes.subarray(0, 9)); stdout.push(bytes.subarray(9))
    }
    return { stdout, done, stdin: { write(payload) {
      const message = JSON.parse(String(payload).split('\r\n\r\n').slice(1).join('\r\n\r\n'))
      messages.push(message)
      if (message.id === undefined) return
      let result = null
      if (message.method === 'initialize') result = { capabilities: { textDocumentSync } }
      if (message.method === 'textDocument/definition') result = [{ targetUri: definitionUri, targetRange: { start: {line: 0, character: 0}, end: {line: 40, character: 0} }, targetSelectionRange: range }]
      if (message.method === 'textDocument/definition' && holdDefinitions) { heldDefinitions.push(message.id); return }
      send({jsonrpc:'2.0',id:message.id,result})
    } }, terminate() { stdout.push(null); finish({exitCode:0}) } }
  },
}
const bridge = new LspBridge({subprocess:fakeProcess}, {})
const request = {sessionId:'s1',cwd:'E:\\Workspace',languageId:'typescript',path:'src/a.ts',text:'hello',line:22,column:67}
try {
  const definition = await bridge.operate({...request,action:'definition'})
  assert.deepEqual(definition.locations, [{path:'src/a.ts',line:15,column:14,endLine:15,endColumn:27}])
  const session = [...bridge.sessions.values()][0]
  send({jsonrpc:'2.0',method:'textDocument/publishDiagnostics',params:{uri:'file:///e%3A/workspace/src/a.ts',version:1,diagnostics:[{range,message:'old error',severity:1}]}})
  await new Promise(setImmediate)
  assert.equal((await bridge.operate({...request,action:'diagnostics'})).diagnostics.length, 1)
  send({jsonrpc:'2.0',method:'textDocument/publishDiagnostics',params:{uri:'file:///e%3A/workspace/src/a.ts',version:1,diagnostics:[]}})
  await new Promise(setImmediate)
  assert.deepEqual((await bridge.operate({...request,action:'diagnostics'})).diagnostics, [])
  assert.equal(session.connection.diagnostics.size, 1)
  assert.equal(messages.filter(x=>x.method==='textDocument/didChange').length, 0)
  await bridge.operate({...request,text:'updated',action:'diagnostics'})
  assert.equal(messages.filter(x=>x.method==='textDocument/didChange').length, 1)
  ok('LocationLink selects symbol; diagnostics replace/clear; unchanged documents do not resync')

  // A delayed navigation must finish before a later document switch closes it.
  holdDefinitions = true
  const navigation = bridge.operate({...request, text:'updated', action:'definition'})
  await new Promise(setImmediate)
  assert.equal(heldDefinitions.length, 1)
  const openedCount = messages.filter(x=>x.method==='textDocument/didOpen').length
  const switched = bridge.operate({...request, path:'src/b.ts', text:'export {}', action:'symbols'})
  await new Promise(setImmediate)
  assert.equal(messages.filter(x=>x.method==='textDocument/didOpen').length, openedCount)
  send({jsonrpc:'2.0', id:heldDefinitions.shift(), result:[]})
  await Promise.all([navigation, switched])
  holdDefinitions = false
  const closeAt = messages.findIndex(x=>x.method==='textDocument/didClose')
  assert(closeAt >= 0)
  assert.equal(messages[closeAt].params.textDocument.uri, fileUri('E:/Workspace/src/a.ts'))
  assert.equal(session.opened.size, 1)
  assert.equal(session.connection.diagnostics.size, 0)
  const openAt = messages.findIndex((x,index)=>index > closeAt && x.method==='textDocument/didOpen')
  assert.equal(messages[openAt].params.textDocument.uri, fileUri('E:/Workspace/src/b.ts'))
  await bridge.operate({...request, action:'diagnostics'})
  assert.equal(messages.filter(x=>x.method==='textDocument/didOpen').at(-1).params.textDocument.version, 3)
  ok('document switches close stale overlays; concurrent navigation completes before didClose; reopen versions increase')
} finally { bridge.dispose() }

for (const mode of [2, {openClose:true, change:0}, undefined]) {
  textDocumentSync = mode
  const syncBridge = new LspBridge({subprocess:fakeProcess}, {})
  const offset = messages.length
  try {
    await syncBridge.operate({...request, text:'first\r\n🙂 end', action:'symbols'})
    await syncBridge.operate({...request, text:'replacement', action:'symbols'})
    const stream = messages.slice(offset).filter(x=>/^textDocument\/did/.test(x.method))
    if (mode === 2) {
      assert.deepEqual(stream.map(x=>x.method), ['textDocument/didOpen','textDocument/didChange'])
      assert.deepEqual(stream[1].params.contentChanges, [{range:{start:{line:0,character:0},end:{line:1,character:6}},text:'replacement'}])
    } else if (mode) {
      assert.deepEqual(stream.map(x=>x.method), ['textDocument/didOpen','textDocument/didClose','textDocument/didOpen'])
      assert.equal(stream.at(-1).params.textDocument.version, 2)
    } else assert.deepEqual(stream, [])
  } finally { syncBridge.dispose() }
}
textDocumentSync = { openClose: true, change: 1 }
ok('negotiated incremental UTF-16 ranges, open/close-only refresh and no-sync servers')

const posixBridge = new LspBridge({subprocess:fakeProcess}, {})
try {
  definitionUri = 'file:///work/Case/lib.ts'
  const request = {sessionId:'posix',cwd:'/work/Case',languageId:'typescript',path:'src/a.ts',text:'export {}',action:'definition',line:2,column:3}
  assert.equal((await posixBridge.operate(request)).locations[0].path,'lib.ts')
  const firstSession = [...posixBridge.sessions.values()][0]
  assert.equal(messages.filter(x=>x.method==='initialize').at(-1).params.rootUri,'file:///work/Case')
  assert.equal(messages.filter(x=>x.method==='textDocument/didOpen').at(-1).params.textDocument.uri,'file:///work/Case/src/a.ts')
  for (const [uri,message] of [['file:///work/Case/src/a.ts','correct case'],['file:///work/case/src/a.ts','other case']]) {
    send({jsonrpc:'2.0',method:'textDocument/publishDiagnostics',params:{uri,version:1,diagnostics:[{range,message,severity:1}]}})
  }
  await new Promise(setImmediate)
  assert.deepEqual((await posixBridge.operate({...request,action:'diagnostics'})).diagnostics.map(x=>x.message),['correct case'])
  await posixBridge.operate({...request,cwd:'/work/case',action:'symbols'})
  assert.equal(firstSession.disposed,true,'POSIX roots that differ by case must not share a session')
  assert.equal(messages.filter(x=>x.method==='initialize').at(-1).params.rootUri,'file:///work/case')
  assert.equal(messages.filter(x=>x.method==='textDocument/didOpen').at(-1).params.textDocument.uri,'file:///work/case/src/a.ts')
} finally { posixBridge.dispose(); definitionUri = 'file:///e%3A/workspace/src/a.ts' }
ok('production LSP bridge preserves POSIX initialize/document URIs and case-sensitive diagnostics/session identity')

available = false
const detection = new LspBridge({subprocess:fakeProcess}, {})
assert.equal((await detection.status('typescript')).available, false)
available = true
assert.equal((await detection.status('typescript', true)).available, true)
assert.equal((await detection.status('plaintext')).reason, 'unsupported-language')
detection.dispose()
ok('re-detect after installation and unsupported-language fallback')

// Execute the production client source with a transport stub, not a rewritten algorithm.
const source = await readFile(join(root, 'src/client/22-lsp.js'), 'utf8')
let reply = {available:true,locations:[{path:'e:/workspace/src/a.ts',line:15,column:14,endLine:15,endColumn:27}]}
const sent = []
const opened = []
const listed = []
const notices = []
const missing = []
const composerCalls = []
const composer = { setDraft: async (value) => { composerCalls.push(['draft',value]) }, submit: async () => { composerCalls.push(['submit']) } }
const composerContext = { get: (name) => name === 'sessions' ? {scope:(id)=>id} : {input:{for:()=>composer}} }
const client = new Function('apiPost','setTimeout','clearTimeout','globalCtxRef','safeGet',source + '\nreturn {lspRuntime,lspSetDocument,lspDefinition,lspReferences,lspPosition,lspSymbols,lspCheckAvailability,lspDiagnostics,lspForgetMissing,lspClearDocument,workspaceLocationPath,lspRegisterProviders,lspAskAgentToInstall,lspDispose};')(
  async (name, body) => { sent.push(body); return typeof reply === 'function' ? reply() : reply }, () => 0, () => {}, {current:composerContext}, (ctx,name)=>ctx.get(name))
const host = {openLocation:(...args)=>opened.push(args),showLocations:(...args)=>listed.push(args),notify:(...args)=>notices.push(args),onMissing:(value)=>missing.push(value)}
client.lspRegisterProviders(null, host)
client.lspSetDocument({sessionId:'s1',cwd:'E:\\Workspace',path:'src/a.ts',text:'hello',languageId:'typescript',model:{}})
const position = client.lspPosition({getSelection:()=>({isEmpty:()=>false,getStartPosition:()=>({lineNumber:22,column:63})}),getPosition:()=>({lineNumber:22,column:76})})
assert.deepEqual(position, {lineNumber:22,column:63})
assert.equal(await client.lspDefinition(position.lineNumber, position.column), true)
assert.equal(sent[0].column, 63)
assert.deepEqual(opened[0].slice(0,3), ['src/a.ts',15,14])
for(const path of ['../secret','/etc/passwd','E:/Workspace-other/a.ts','file:///e%3A/outside/a.ts','file:///e%3A/workspace/../outside.ts','https://example/a.ts']) assert.equal(client.workspaceLocationPath(path), null)
assert.equal(client.workspaceLocationPath('file:///e%3A/Workspace/测试%20%23.ts'),'测试 #.ts')
assert.equal(client.workspaceLocationPath('/work/Case/src/A.ts','/work/Case/'),'src/A.ts')
assert.equal(client.workspaceLocationPath('/work/case/src/A.ts','/work/Case'),null)
assert.equal(client.workspaceLocationPath('/work/Cases/a.ts','/work/Case'),null)
assert.equal(client.workspaceLocationPath('file:///work/Case/测试%20%23.ts','/work/Case'),'测试 #.ts')
assert.equal(client.workspaceLocationPath('/src/a.ts','/'),'src/a.ts')
assert.equal(client.workspaceLocationPath('file:///src/a.ts','/'),'src/a.ts')
assert.equal(client.workspaceLocationPath('../secret.ts','/'),null)
assert.equal(client.workspaceLocationPath('e:/src/a.ts','E:/'),'src/a.ts')
reply = {available:true,locations:[{path:'C:/lib/lib.dom.d.ts',line:1,column:1}]}
assert.equal(await client.lspDefinition(1,1),false)
assert.match(notices.at(-1)[0], /工作区外/)
reply = {available:true,locations:[{path:'src/a.ts',line:1,column:2},{path:'src/b.ts',line:2,column:3}]}
assert.equal(await client.lspDefinition(1,1),true)
assert.equal(listed.at(-1)[1],'definitions')
assert.equal(await client.lspReferences(1,1),true)
ok('selected-symbol F12, column/range propagation, multi-definition/references picker and external libraries')

reply = {available:false,reason:'missing-server',language:'typescript',install:'npm install -g typescript@5 typescript-language-server'}
await client.lspCheckAvailability()
assert.equal(missing.at(-1).language,'typescript')
client.lspForgetMissing()
reply = {available:true,server:'typescript'}
await client.lspCheckAvailability(true)
assert.equal(sent.at(-1).refresh,true)
assert.equal(missing.at(-1), null)
assert((await client.lspDiagnostics()).some(x=>x.includes('typescript')))
let finishReply
reply = () => new Promise(resolve=>{finishReply=resolve})
const count = opened.length
const late = client.lspDefinition(1,1)
client.lspClearDocument()
finishReply({available:true,locations:[{path:'src/a.ts',line:1,column:1}]})
assert.equal(await late,false)
assert.equal(opened.length,count)
ok('missing-server notification controls and stale navigation cancellation')
assert.equal(composerCalls.length,0,'opening/probing documents must not send an installation request')
assert.equal(await client.lspAskAgentToInstall('', 'plaintext'),null)
assert.equal(composerCalls.length,0)
assert.equal(await client.lspAskAgentToInstall('npm install -g pyright','python'),'sent')
assert.deepEqual(composerCalls.map(x=>x[0]),['draft','submit'])
let disposed = 0
client.lspRegisterProviders({languages:{registerHoverProvider:()=>({dispose:()=>disposed++})}},host)
client.lspDispose()
assert.equal(disposed,9)
ok('explicit installation action only; provider teardown on plugin reload')

// Virtual time executes the production polling code for minutes in milliseconds.
function diagnosticHarness(responder, hidden = false) {
  let now = 0
  let nextTimer = 0
  const timers = new Map()
  const listeners = new Set()
  const polls = []
  const writes = []
  const document = {
    hidden,
    addEventListener(name, listener) { assert.equal(name, 'visibilitychange'); listeners.add(listener) },
    removeEventListener(name, listener) { assert.equal(name, 'visibilitychange'); listeners.delete(listener) },
  }
  const monaco = {editor:{setModelMarkers(model, owner, markers) { writes.push({now, model, markers}) },getModelMarkers:()=>[]}}
  const harnessClient = new Function('apiPost','setTimeout','clearTimeout','Date','document', source + '\nreturn {lspRuntime,lspSetDocument,lspClearDocument,lspCheckAvailability,lspDispose};')(
    async (name, body) => { polls.push({now,body}); return responder(now, body) },
    (fn, delay) => { const id = ++nextTimer; timers.set(id, {fn,at:now+delay}); return id },
    (id) => timers.delete(id), {now:()=>now}, document)
  const flush = async () => { for(let n=0;n<20;n++) await Promise.resolve() }
  const open = (path = 'a.ts', extra = {}) => harnessClient.lspSetDocument({sessionId:'s',cwd:'E:/workspace',path,text:'current',languageId:'typescript',model:{},monaco,...extra})
  return {
    client:harnessClient, polls, writes, timers, listeners, open, flush,
    hide(value) { document.hidden = value; for (const listener of listeners) listener() },
    async advance(target) {
      for (let n=0;n<1000;n++) {
        const next = [...timers].sort((a,b)=>a[1].at-b[1].at)[0]
        if (!next || next[1].at > target) { now=target; return }
        const [id, timer] = next
        timers.delete(id); now=timer.at; timer.fn(); await flush()
      }
      throw Error('diagnostic clock did not quiesce')
    },
  }
}
const diagnostic = (message) => ({severity:1,message,line:1,column:1,endLine:1,endColumn:2})
{
  const h = diagnosticHarness((now) => ({available:true,pending:now<12000,
    diagnostics: now<12000 || now>=50000 ? [] : [diagnostic(now<35000 ? 'late project error' : 'changed dependency error')]}))
  h.open()
  await h.advance(25000)
  assert(h.writes.some(x=>x.markers[0]?.message === 'late project error'))
  assert(h.polls.at(-1).now > 11500)
  await h.advance(45000)
  assert.equal(h.writes.at(-1).markers[0]?.message, 'changed dependency error')
  await h.advance(60000)
  assert.deepEqual(h.writes.at(-1).markers, [])
  assert.equal(h.timers.size, 1)
  const idlePolls = h.polls.filter(x=>x.now>=25000)
  assert(idlePolls.length <= 8, 'settled diagnostics should use low-frequency polling')
  h.client.lspDispose()
  assert.equal(h.timers.size, 0)
  assert.equal(h.listeners.size, 0)
}
ok('virtual clock: diagnostics arriving after 12 s, later dependency changes and clearing all remain observable')

for (const reason of ['missing-server','unsupported-language']) {
  let installed = false
  const h = diagnosticHarness((now, body) => installed || body.action === 'status'
    ? {available:true,pending:false,diagnostics:[]}
    : {available:false,reason,language:'typescript',install:'npm install -g typescript-language-server'})
  h.open()
  await h.advance(60000)
  assert.equal(h.polls.length, 1)
  assert.equal(h.timers.size, 0)
  installed = true
  await h.client.lspCheckAvailability(true)
  await h.advance(61000)
  assert(h.polls.some(x=>x.now>60000 && x.body.action==='diagnostics'))
  h.client.lspDispose()
}
ok('virtual clock: missing/unsupported servers stop polling and explicit recheck restarts it')

{
  // Historical (git revision) documents are first-class LSP documents for
  // navigation, but their diagnostics would mix the old snapshot with the
  // current worktree project, so the bridge must never poll or paint them.
  const h = diagnosticHarness(() => ({ available: true, pending: false, diagnostics: [diagnostic('historical snapshot error')] }))
  h.open('a.ts', { historical: true })
  assert.equal(h.client.lspRuntime.historical, true)
  assert.equal(h.timers.size, 0, 'historical content must not schedule diagnostics polling')
  await h.advance(60000)
  assert.equal(h.polls.length, 0, 'historical content must not request diagnostics')
  assert(!h.writes.some((entry) => entry.markers.length > 0), 'historical content must not paint markers')
  h.open('b.ts', { historical: false })
  await h.advance(65000)
  assert.equal(h.client.lspRuntime.historical, false)
  assert(h.polls.some((entry) => entry.body.action === 'diagnostics'), 'leaving historical content re-arms diagnostics')
  h.client.lspDispose()
}
ok('virtual clock: historical snapshot documents suppress diagnostics and worktree documents resume them')

{
  const pending = []
  const h = diagnosticHarness(() => new Promise(resolve=>pending.push(resolve)), true)
  h.open()
  assert.equal(h.timers.size, 0)
  assert.equal(h.listeners.size, 1)
  h.hide(false)
  await h.advance(300)
  assert.equal(pending.length, 1)
  h.hide(true)
  pending.shift()({available:true,pending:false,diagnostics:[diagnostic('hidden stale error')]})
  await h.flush()
  assert.equal(h.timers.size, 0)
  assert(!h.writes.some(x=>x.markers.length))
  h.hide(false)
  await h.advance(600)
  assert.equal(pending.length, 1)
  h.open('b.ts')
  const currentTimer = [...h.timers.keys()]
  pending.shift()({available:true,pending:false,diagnostics:[diagnostic('old document error')]})
  await h.flush()
  assert.deepEqual([...h.timers.keys()], currentTimer)
  assert(!h.writes.some(x=>x.markers.length))
  await h.advance(900)
  h.client.lspClearDocument()
  pending.shift()({available:true,pending:false,diagnostics:[diagnostic('closed document error')]})
  await h.flush()
  assert.equal(h.timers.size, 0)
  h.client.lspDispose()
  assert.equal(h.listeners.size, 0)
}
ok('virtual clock: hidden page pauses, visibility resumes, stale/closed responses cannot paint or replace timers')

if (process.argv.includes('--real')) {
  const exits = []
  const subprocess = {
    async resolveExecutable(command) {
      if (command === 'node') return process.execPath
      // Exercise the same PATH-first POSIX and npm-shim Windows detection as
      // production, without requiring a globally installed command at one path.
      const extensions = process.platform === 'win32' ? ['',...(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')] : ['']
      for (const directory of String(process.env.PATH || '').split(delimiter).filter(Boolean)) {
        for (const extension of extensions) {
          const candidate = join(directory.replace(/^"|"$/g,''),command + extension)
          try {
            await access(candidate,constants.X_OK)
            if ((await stat(candidate)).isFile()) return candidate
          } catch { /* try the next PATH entry */ }
        }
      }
      return null
    },
    spawn(spec) {
      const child = spawn(spec.argv[0],spec.argv.slice(1),{cwd:spec.cwd,env:spec.env,stdio:'pipe',windowsHide:true})
      child.stderr.resume()
      const done = new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',(exitCode,signal)=>resolve({exitCode,signal}))})
      exits.push(done)
      return {stdin:child.stdin,stdout:child.stdout,done,terminate:()=>child.kill()}
    },
  }
  const real = new LspBridge({subprocess}, {})
  const routes = new Map()
  const cleanups = []
  registerApiRoutes({
    subprocess, logger: {},
    on() { return () => {} },
    effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup) },
    sessions: { get: (id) => id === 'real-route' ? { header: { id, cwd: root }, ownEvents: () => [] } : undefined },
    connection: { fetch: { register: (route) => { routes.set(route.path, route); return () => {} } } },
  })
  const temp = await mkdtemp(join(tmpdir(),'dsh-lsp 测试 #%-'))
  try {
    const path = 'scripts/fixtures/retry-policy.ts'
    const text = await readFile(join(root,path),'utf8')
    const ask = (action,line,column)=>real.operate({sessionId:'real-demo',cwd:root,languageId:'typescript',path,text,action,line,column})
    for (const line of [22,28]) {
      const column = text.split(/\r?\n/)[line-1].indexOf('DEFAULT_RETRY')+1
      const value = await ask('definition',line,column)
      assert.equal(value.available,true,JSON.stringify(value))
      assert.equal(value.locations[0].path,path)
      assert.equal(value.locations[0].line,15)
      assert.equal(value.locations[0].column,14)
    }
    const routeResponse = await routes.get('/api/review-panel.lsp').fetch(new Request('http://localhost/api/review-panel.lsp',{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionId:'real-route',languageId:'typescript',path,text,action:'definition',line:22,column:65}),
    }))
    const routeResult = await routeResponse.json()
    assert.equal(routeResult.locations?.[0]?.line,15,JSON.stringify(routeResult))
    assert.equal(routeResult.locations?.[0]?.path,path)
    assert((await ask('references',15,16)).locations.length >= 3)
    assert((await ask('hover',15,16)).contents.includes('DEFAULT_RETRY'))
    assert((await ask('symbols')).symbols.some(x=>x.name==='DEFAULT_RETRY'))
    const library = await ask('definition',36,text.split(/\r?\n/)[35].indexOf('setTimeout')+3)
    assert(library.locations.some(x=>x.path.includes('lib.dom.d.ts')))
    const targetText = 'export const VALUE = 123\n'
    await writeFile(join(temp,'target #%.ts'),targetText)
    await writeFile(join(temp,'tsconfig.json'),JSON.stringify({compilerOptions:{module:'esnext',moduleResolution:'bundler'},include:['*.ts']}))
    const crossText = 'import { VALUE } from "./target #%"\nconsole.log(VALUE)\n'
    await writeFile(join(temp,'caller.ts'),crossText)
    const previous = await real.operate({sessionId:'real-cross',cwd:temp,languageId:'typescript',path:'target #%.ts',text:targetText,action:'symbols'})
    assert(previous.symbols?.some(x=>x.name==='VALUE' && x.line===1),JSON.stringify(previous))
    await writeFile(join(temp,'target #%.ts'),'\n'.repeat(10)+targetText)
    const cross = await real.operate({sessionId:'real-cross',cwd:temp,languageId:'typescript',path:'caller.ts',text:crossText,action:'definition',line:2,column:14})
    assert.equal(cross.locations?.[0]?.path,'target #%.ts',JSON.stringify(cross))
    assert.equal(cross.locations?.[0]?.line,11,JSON.stringify(cross))
    assert.equal(cross.locations?.[0]?.column,14,JSON.stringify(cross))
    // Once closed, subsequent external edits follow the server's disk watcher.
    await writeFile(join(temp,'target #%.ts'),'\n'.repeat(20)+targetText)
    let watched
    for (let n=0;n<16;n++) {
      watched = await real.operate({sessionId:'real-cross',cwd:temp,languageId:'typescript',path:'caller.ts',text:crossText,action:'definition',line:2,column:14})
      if (watched.locations?.[0]?.line===21) break
      await new Promise(resolve=>setTimeout(resolve,250))
    }
    assert.equal(watched.locations?.[0]?.line,21,JSON.stringify(watched))
    // Historical (git revision) text overlay: the bridge opens exactly the text
    // the review page shows, so same-file navigation works on that snapshot.
    // This is what F12 on a historical version relies on (the worktree file on
    // disk is a different, presumably newer version of the same path).
    const oldText = [
      'export const CURRENT = 1',
      'export function legacyHelper(label: string) {',
      '  return label.toUpperCase()',
      '}',
      'const legacyGreeting = legacyHelper("old")',
      '',
    ].join('\n')
    await writeFile(join(temp,'old.ts'),'export const CURRENT = 2\nexport function currentHelper() { return CURRENT }\n')
    const historicalAsk = (action,line,column)=>real.operate({sessionId:'real-hist',cwd:temp,languageId:'typescript',path:'old.ts',text:oldText,action,line,column})
    const usageLine = 5
    const usageColumn = oldText.split('\n')[usageLine-1].indexOf('legacyHelper')+1
    const historicalDefinition = await historicalAsk('definition',usageLine,usageColumn)
    assert.equal(historicalDefinition.available,true,JSON.stringify(historicalDefinition))
    assert.equal(historicalDefinition.locations?.[0]?.path,'old.ts',JSON.stringify(historicalDefinition))
    assert.equal(historicalDefinition.locations?.[0]?.line,2,JSON.stringify(historicalDefinition))
    assert.equal(historicalDefinition.locations?.[0]?.column,oldText.split('\n')[1].indexOf('legacyHelper')+1,JSON.stringify(historicalDefinition))
    const historicalHover = await historicalAsk('hover',usageLine,usageColumn)
    assert(String(historicalHover.contents||'').includes('legacyHelper'),JSON.stringify(historicalHover))
    const historicalSymbols = await historicalAsk('symbols')
    assert(historicalSymbols.symbols?.some(x=>x.name==='legacyHelper' && x.line===2),JSON.stringify(historicalSymbols))
    assert(!historicalSymbols.symbols?.some(x=>x.name==='currentHelper'),'the overlaid snapshot must win over the worktree file')
    const badText = 'const count: number = "wrong"\n'
    let diagnostics
    for (let n=0;n<24;n++) {
      diagnostics=await real.operate({sessionId:'real-cross',cwd:temp,languageId:'typescript',path:'error.ts',text:badText,action:'diagnostics'})
      if (diagnostics.diagnostics?.length) break
      await new Promise(resolve=>setTimeout(resolve,250))
    }
    assert(diagnostics.diagnostics?.some(x=>x.message.includes('number')),JSON.stringify(diagnostics))
    ok('REAL TypeScript: DEFAULT_RETRY navigation, references/hover/outline, library target, unicode/#/% paths, closed-overlay/external-file edits, historical-snapshot overlay and diagnostics')
  } finally {
    real.dispose()
    for (const cleanup of cleanups) cleanup()
    await Promise.allSettled(exits)
    assert(resolve(temp).startsWith(resolve(tmpdir()) + '\\') || resolve(temp).startsWith(resolve(tmpdir()) + '/'))
    await rm(temp,{recursive:true,force:true,maxRetries:10,retryDelay:250})
  }
}
console.log('OK: ' + groups + ' regression groups')
