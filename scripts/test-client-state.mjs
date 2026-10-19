#!/usr/bin/env node
/** Execute the production page/tree hooks with controlled route responses. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const sources = await Promise.all(['00-const.js', '05-utils.js', '20-monaco.js', '25-tree.js', '30-page.js']
  .map((name) => readFile(new URL('../src/client/' + name, import.meta.url), 'utf8')))
const pause = () => new Promise((resolve) => setTimeout(resolve, 0))
const depsEqual = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const textDiff = (before, after) => ({ kind: 'text', before: true, after: true, hunks: [{ oldStart: 1, newStart: 1, lines: ['-' + before, '+' + after] }] })
const deletion = { kind: 'text', before: true, after: false, hunks: [{ oldStart: 1, newStart: 0, lines: ['-removed code'] }] }
const missing = () => Object.assign(new Error('File unavailable.'), { status: 404, code: 'not-found' })

function harness(read) {
  let active
  const handlers = new Map()
  const fixtures = { read, lspClears: 0, lspDocuments: [] }
  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      const element = { type, props: props || {}, children }
      active.created.push(element)
      return element
    },
    useState(initial) {
      const runner = active, index = runner.cursor++
      if (!runner.cells[index]) runner.cells[index] = { value: typeof initial === 'function' ? initial() : initial }
      return [runner.cells[index].value, (next) => {
        const previous = runner.cells[index].value
        const value = typeof next === 'function' ? next(previous) : next
        if (!Object.is(previous, value)) { runner.cells[index].value = value; runner.dirty = true }
      }]
    },
    useRef(value) {
      const index = active.cursor++
      if (!active.cells[index]) active.cells[index] = { value: { current: value } }
      return active.cells[index].value
    },
    useMemo(fn, deps) {
      const index = active.cursor++
      if (!active.cells[index] || !depsEqual(active.cells[index].deps, deps)) active.cells[index] = { value: fn(), deps }
      return active.cells[index].value
    },
    useCallback(fn, deps) { return this.useMemo(() => fn, deps) },
    useEffect(fn, deps) {
      const runner = active, index = runner.cursor++
      if (!runner.cells[index] || !depsEqual(runner.cells[index].deps, deps)) {
        const old = runner.cells[index]
        runner.cells[index] = { deps, cleanup: old?.cleanup }
        runner.effects.push(() => { old?.cleanup?.(); runner.cells[index].cleanup = fn() })
      }
    },
  }
  class Runner {
    constructor(component, props) {
      Object.assign(this, { component, props, cells: [], cursor: 0, effects: [], created: [], commits: [], dirty: true })
    }
    render() {
      active = this
      this.cursor = 0; this.effects = []; this.created = []; this.dirty = false
      this.tree = this.component(this.props)
      this.commits.push(this.created)
      this.beforeEffects?.(this.tree)
      for (const effect of this.effects) effect()
    }
    async settle() {
      // Two quiet turns also drain zero-delay background-prefetch continuations.
      let quiet = 0
      for (let turn = 0; turn < 60; turn += 1) {
        if (this.dirty) { this.render(); quiet = 0 }
        await pause()
        if (!this.dirty && ++quiet >= 2) return
      }
      throw new Error('Client failed to settle')
    }
    update(props) { this.props = { ...this.props, ...props }; this.dirty = true }
    node(name) { return this.created.find((node) => typeof node.type === 'function' && node.type.name === name) }
    dispose() { for (const cell of this.cells) cell?.cleanup?.() }
  }
  const window = {
    addEventListener(name, callback) {
      if (!handlers.has(name)) handlers.set(name, new Set())
      handlers.get(name).add(callback)
    },
    removeEventListener(name, callback) { handlers.get(name)?.delete(callback) },
  }
  const document = { addEventListener() {}, removeEventListener() {}, hidden: false }
  const prefix = `
    const h = React.createElement;
    const themeRuntime = {scheme:'dark'};
    const COMMAND_SPECS = [];
    const MONACO_BASE = {light:'vs',dark:'vs-dark'};
    function observeTheme(){return ()=>{}}
    function applyMonacoTheme(){return 'dark'}
    function buildKeyHelp(){return []}
    function lspRegisterProviders(){}
    function lspSetDocument(info){fixtures.lspDocuments.push(info)}
    function lspClearDocument(){fixtures.lspClears += 1}
    function lspCheckAvailability(){}
  `
  const suffix = `
    loadMonaco = () => Promise.resolve({});
    apiGet = (name, params, signal) => fixtures.read(name, params, signal);
    return {ReviewPage, FileTree, MonacoHost, runtimeState};
  `
  const api = new Function('React', 'fixtures', 'window', 'document', 'setTimeout', 'clearTimeout',
    prefix + sources.join('\n') + suffix)(React, fixtures, window, document,
    (fn, delay = 0) => Number(delay) === 0 ? setTimeout(fn, 0) : 0, (id) => clearTimeout(id))
  return {
    fixtures, api,
    editor(props) { return new Runner(api.MonacoHost, props) },
    page(sessionId = 's1') {
      const store = { byId: { [sessionId]: { cwd: 'C:/workspace', running: true } } }
      const page = new Runner(api.ReviewPage, { sessionId, t: (key) => key, useSessions: (selector) => selector(store), services: {} })
      page.store = store
      return page
    },
    tree(props = {}) {
      return new Runner(api.FileTree, {
        sessionId: 's1', cwd: 'C:/workspace', summaryFiles: [], treeMode: 'code', refreshToken: 0,
        changedOnly: false, onOpen() {}, onToggleChangedOnly() {}, t: (key) => key, ...props,
      })
    },
  }
}

async function chooseMode(page, index) {
  page.created.find((node) => String(node.props.className || '').split(' ').includes('drp-mode-btn')).props.onClick()
  await page.settle()
  page.created.filter((node) => node.props.role === 'menuitemradio')[index].props.onClick()
  await page.settle()
}

test('a new turn reloads the active text and never paints new hunks over old text', async () => {
  let seq = 1
  const reads = [], pendingFiles = []
  const h = harness(async (name, params, signal) => {
    reads.push({ name, ...params, signal })
    if (name === 'latest') return { available: true, seq, turn: seq, summary: { files: [{ path: 'a.ts' }] } }
    if (name === 'gitStatus') return { available: false }
    if (name === 'config') return { phase: 3, features: { lsp: true } }
    if (name === 'file') {
      if (seq === 1) return { kind: 'text', text: 'old\n' }
      const pending = deferred(); pendingFiles.push({ ...pending, seq, signal }); return pending.promise
    }
    if (name === 'diff') return textDiff('base ' + params.seq, params.seq === 1 ? 'old' : 'new')
    throw new Error(name)
  })
  const page = h.page()
  await page.settle()
  assert.equal(page.node('MonacoHost').props.file.text, 'old\n')
  const revealNonce = page.node('MonacoHost').props.reveal.nonce
  const boundary = page.commits.length
  seq = 2; page.store.byId.s1.running = false; page.dirty = true
  await page.settle()
  assert.ok(pendingFiles.length > 0)
  assert.equal(page.node('MonacoHost').props.file, null)
  for (const commit of page.commits.slice(boundary)) {
    const editor = commit.find((node) => node.type.name === 'MonacoHost')
    if (editor?.props.file?.text === 'old\n') assert.ok(editor.props.regions.every((region) => !region.oldLines.includes('base 2')))
    if (!editor?.props.file) assert.deepEqual(editor.props.regions, [])
  }
  for (const pending of pendingFiles) pending.resolve({ kind: 'text', text: 'new\n' })
  await page.settle()
  assert.equal(page.node('MonacoHost').props.file.text, 'new\n')
  assert.equal(page.node('MonacoHost').props.reveal.nonce, revealNonce, 'refresh retains the current scroll/reveal')
  const fileReads = reads.filter((entry) => entry.name === 'file').length
  page.node('FileTree').props.onOpen('a.ts')
  await page.settle()
  assert.equal(reads.filter((entry) => entry.name === 'file').length, fileReads, 'revisit still uses the refreshed cache')
  page.dispose()
})

test('a retired file read cannot overwrite the next snapshot even if abort is ignored', async () => {
  let seq = 1
  const oldReads = []
  const h = harness(async (name, params, signal) => {
    if (name === 'latest') return { available: true, seq, turn: seq, summary: { files: [{ path: 'a.ts' }] } }
    if (name === 'gitStatus') return { available: false }
    if (name === 'config') return { phase: 3, features: { lsp: true } }
    if (name === 'diff') return textDiff('base', 'version ' + params.seq)
    if (name === 'file') {
      if (seq !== 2) return { kind: 'text', text: 'version ' + seq }
      const pending = deferred(); oldReads.push({ ...pending, signal }); return pending.promise
    }
    throw new Error(name)
  })
  const page = h.page()
  await page.settle()
  seq = 2; page.store.byId.s1.running = false; page.dirty = true; await page.settle()
  assert.ok(oldReads.length)
  page.store.byId.s1.running = true; page.dirty = true; await page.settle()
  seq = 3; page.store.byId.s1.running = false; page.dirty = true; await page.settle()
  assert.ok(oldReads.some((pending) => pending.signal?.aborted))
  assert.equal(page.node('MonacoHost').props.file.text, 'version 3')
  for (const pending of oldReads) pending.resolve({ kind: 'text', text: 'stale version 2' })
  await page.settle()
  assert.equal(page.node('MonacoHost').props.file.text, 'version 3')
  page.dispose()
})

test('manual refresh retires same-snapshot comparisons and background cache writes', async () => {
  let refreshed = false
  const oldDiffs = []
  const h = harness(async (name, params, signal) => {
    if (name === 'latest') return { available: true, seq: 1, turn: 1, summary: { files: [{ path: 'a.ts' }] } }
    if (name === 'gitStatus') return { available: false }
    if (name === 'config') return { phase: 3, features: { lsp: true } }
    if (name === 'file') return { kind: 'text', text: refreshed ? 'fresh text' : 'old text' }
    if (name === 'diff') {
      if (refreshed) return textDiff('fresh baseline', 'fresh text')
      const pending = deferred(); oldDiffs.push({ ...pending, signal }); return pending.promise
    }
    throw new Error(name)
  })
  const page = h.page()
  await page.settle()
  assert.ok(oldDiffs.length)
  refreshed = true
  assert.equal(h.api.runtimeState.page.command('refresh'), true)
  await page.settle()
  assert.equal(page.node('MonacoHost').props.file.text, 'fresh text')
  assert.deepEqual(page.node('MonacoHost').props.regions[0].oldLines, ['fresh baseline'])
  assert.ok(oldDiffs.every((pending) => pending.signal.aborted))
  for (const pending of oldDiffs) pending.resolve(textDiff('stale baseline', 'old text'))
  await page.settle()
  assert.deepEqual(page.node('MonacoHost').props.regions[0].oldLines, ['fresh baseline'])
  page.node('FileTree').props.onOpen('a.ts')
  await page.settle()
  assert.equal(page.node('MonacoHost').props.file.text, 'fresh text', 'stale prefetch did not overwrite the refreshed file cache')
  assert.deepEqual(page.node('MonacoHost').props.regions[0].oldLines, ['fresh baseline'])
  page.dispose()
})

test('identical source text still refreshes TURN and Git baselines after batched file reads', async () => {
  for (const modeIndex of [0, 1]) {
    let seq = 1, baseline = 'baseline 1'
    const h = harness(async (name) => {
      if (name === 'latest') return { available: true, seq, turn: seq, summary: { files: [{ path: 'a.ts' }] } }
      if (name === 'gitStatus') return { available: true, files: [{ path: 'a.ts', code: 'M' }] }
      if (name === 'config') return { phase: 3, features: { lsp: true } }
      if (name === 'file') return { kind: 'text', text: 'identical source text' }
      if (name === 'diff' || name === 'gitFile') return textDiff(baseline, 'identical source text')
      throw new Error(name)
    })
    const page = h.page()
    await page.settle()
    if (modeIndex === 1) await chooseMode(page, modeIndex)
    assert.deepEqual(page.node('MonacoHost').props.regions[0]?.oldLines, ['baseline 1'])
    seq = 2; baseline = 'baseline 2'; page.store.byId.s1.running = false; page.dirty = true
    await page.settle()
    assert.equal(page.node('MonacoHost').props.file.text, 'identical source text')
    assert.deepEqual(page.node('MonacoHost').props.regions[0]?.oldLines, ['baseline 2'], 'a new snapshot compares against the new baseline even when the current text is identical')
    baseline = 'manually refreshed baseline'
    h.api.runtimeState.page.command('refresh')
    // Simulate React batching loading -> ready into a single render when the
    // route resolves immediately and the text has not changed.
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve()
    await page.settle()
    assert.deepEqual(page.node('MonacoHost').props.regions[0]?.oldLines, ['manually refreshed baseline'], 'same-snapshot manual refresh also rebuilds the comparison')
    page.dispose()
  }
})

test('confirmed deletions can be reviewed in TURN and Git, but code mode keeps the missing-file error', async () => {
  let gitCalls = 0
  const h = harness(async (name) => {
    if (name === 'latest') return { available: true, seq: 1, turn: 1, summary: { files: [{ path: 'deleted.ts' }] } }
    if (name === 'gitStatus') return { available: true, files: [{ path: 'deleted.ts', code: 'D' }] }
    if (name === 'file') throw missing()
    if (name === 'diff') return deletion
    if (name === 'gitFile') { gitCalls += 1; return deletion }
    if (name === 'config') return { phase: 3, features: { lsp: true } }
    throw new Error(name)
  })
  const page = h.page()
  await page.settle()
  assert.equal(page.node('MonacoHost').props.file.text, '')
  assert.equal(page.node('MonacoHost').props.file.missing, true)
  assert.deepEqual(page.node('MonacoHost').props.regions[0].oldLines, ['removed code'])
  page.node('MonacoHost').props.onModelReady({ path: 'deleted.ts', text: '', model: {} })
  assert.ok(h.fixtures.lspClears > 0)
  assert.deepEqual(h.fixtures.lspDocuments, [], 'a deleted placeholder is never sent as an LSP document')
  await chooseMode(page, 1)
  assert.equal(gitCalls, 1)
  assert.equal(page.node('MonacoHost').props.file.missing, true)
  assert.deepEqual(page.node('MonacoHost').props.regions[0].oldLines, ['removed code'])
  await chooseMode(page, 2)
  assert.equal(page.node('MonacoHost').props.file, null)
  assert.ok(page.created.some((node) => node.props.className === 'drp-empty-body' && node.children.includes('File unavailable.')))
  page.dispose()
})

test('recreating a deleted empty file reactivates its LSP document on the existing Monaco model', async () => {
  let seq = 1
  const h = harness(async (name) => {
    if (name === 'latest') return { available: true, seq, turn: seq, summary: { files: [{ path: 'empty.ts' }] } }
    if (name === 'gitStatus') return { available: false }
    if (name === 'config') return { phase: 3, features: { lsp: true } }
    if (name === 'file') { if (seq === 2) throw missing(); return { kind: 'text', text: '' } }
    if (name === 'diff') return { kind: 'text', before: seq === 2, after: seq !== 2, hunks: [] }
    throw new Error(name)
  })
  const page = h.page()
  await page.settle()
  let currentModel = null, editorCreations = 0
  const models = new Map()
  const editorApi = {
    getModel: () => currentModel,
    setModel: (model) => { currentModel = model },
    getDomNode: () => null,
    deltaDecorations: () => [],
    updateOptions() {}, layout() {}, dispose() {},
    onDidLayoutChange: () => ({ dispose() {} }),
    onDidChangeModel: () => ({ dispose() {} }),
    onDidChangeCursorPosition() {},
  }
  const monaco = {
    Uri: { parse: (value) => ({ toString: () => value }) },
    editor: {
      create: () => { editorCreations += 1; return editorApi },
      getModel: (uri) => models.get(uri.toString()),
      createModel(text, language, uri) {
        const model = { uri, getValue: () => text, getLanguageId: () => language, dispose() {} }
        models.set(uri.toString(), model)
        return model
      },
    },
  }
  const editor = h.editor({ ...page.node('MonacoHost').props, monaco })
  editor.beforeEffects = (element) => element.props.ref({})
  await editor.settle()
  assert.equal(h.fixtures.lspDocuments.length, 1)
  const originalModel = h.fixtures.lspDocuments[0].model

  seq = 2; page.store.byId.s1.running = false; page.dirty = true; await page.settle()
  editor.update({ ...page.node('MonacoHost').props, monaco }); await editor.settle()
  assert.equal(editor.props.file.missing, true)
  assert.equal(h.fixtures.lspDocuments.length, 1, 'the empty deletion model is not opened as a document')
  assert.ok(h.fixtures.lspClears > 0)

  page.store.byId.s1.running = true; page.dirty = true; await page.settle()
  seq = 3; page.store.byId.s1.running = false; page.dirty = true; await page.settle()
  editor.update({ ...page.node('MonacoHost').props, monaco }); await editor.settle()
  assert.equal(editor.props.file.text, '')
  assert.equal(editor.props.file.missing, undefined)
  assert.equal(h.fixtures.lspDocuments.length, 2, 'restoring an empty file resends the real active document')
  assert.equal(h.fixtures.lspDocuments[1].model, originalModel)
  assert.equal(editorCreations, 1, 'restoration retains the existing editor and model')
  editor.dispose(); page.dispose()
})

test('missing files require an actual deletion comparison; permission and session errors are never deletions', async () => {
  for (const failure of [missing(), Object.assign(new Error('Forbidden'), { status: 403, code: 'permission-denied' }), Object.assign(new Error('Session gone'), { status: 404, code: 'session-not-live' })]) {
    const h = harness(async (name) => {
      if (name === 'latest') return { available: true, seq: 1, turn: 1, summary: { files: [{ path: 'a.ts' }] } }
      if (name === 'gitStatus') return { available: true, files: [] }
      if (name === 'file') throw failure
      if (name === 'diff') return textDiff('base', 'still exists')
      if (name === 'config') return { phase: 3, features: { lsp: true } }
      throw new Error(name)
    })
    const page = h.page()
    await page.settle()
    assert.equal(page.node('MonacoHost').props.file, null)
    assert.ok(page.created.some((node) => node.props.className === 'drp-empty-body' && node.children.includes(failure.message)))
    page.dispose()
  }
})

test('an oversized Git comparison keeps the source visible and persistently explains the missing diff', async () => {
  const h = harness(async (name) => {
    if (name === 'latest') return { available: false }
    if (name === 'gitStatus') return { available: true, files: [{ path: 'large.ts', code: '?' }] }
    if (name === 'config') return { phase: 3, features: { lsp: true } }
    if (name === 'file') return { kind: 'text', text: 'large source text' }
    if (name === 'gitFile') return { kind: 'oversized', reason: 'too-many-lines' }
    throw new Error(name)
  })
  const page = h.page()
  await page.settle()
  page.node('FileTree').props.onOpen('large.ts')
  await page.settle()
  assert.equal(page.node('MonacoHost').props.file.text, 'large source text')
  assert.deepEqual(page.node('MonacoHost').props.regions, [])
  assert.equal(page.node('ReviewStatusBar').props.statusText, 'status.diffOversized')
  page.dirty = true
  await page.settle()
  assert.equal(page.node('ReviewStatusBar').props.statusText, 'status.diffOversized', 'the explanation survives normal rerenders')
  page.dispose()
})

test('tree refresh ignores an older success and cancels its transport', async () => {
  const requests = []
  const h = harness((name, params, signal) => {
    assert.equal(name, 'tree')
    const pending = deferred(); requests.push({ ...pending, ...params, signal }); return pending.promise
  })
  const tree = h.tree()
  await tree.settle()
  tree.update({ refreshToken: 1 }); await tree.settle()
  assert.equal(requests.length, 2)
  assert.equal(requests[0].signal.aborted, true)
  requests[1].resolve({ entries: [{ name: 'new.ts', type: 'file' }] }); await tree.settle()
  requests[0].resolve({ entries: [{ name: 'old.ts', type: 'file' }] }); await tree.settle()
  assert.deepEqual(tree.node('TreeDir').props.loadState('').entries.map((entry) => entry.name), ['new.ts'])
  tree.dispose()
})

test('older tree errors/finally cannot replace state or clear a newer in-flight directory', async () => {
  const requests = []
  const h = harness((name, params, signal) => {
    const pending = deferred(); requests.push({ ...pending, ...params, signal }); return pending.promise
  })
  const tree = h.tree()
  await tree.settle()
  tree.update({ refreshToken: 1 }); await tree.settle()
  requests[0].reject(new Error('stale failure')); await tree.settle()
  assert.equal(tree.node('TreeDir').props.loadState('').status, 'loading')
  assert.ok(!tree.created.some((node) => node.children.includes('stale failure')))
  tree.update({ activePath: 'nested/a.ts' }); await tree.settle()
  assert.equal(requests.filter((entry) => entry.path === '').length, 2, 'stale finally does not unlock the new root request')
  requests[1].resolve({ entries: [{ name: 'current.ts', type: 'file' }] }); await tree.settle()
  assert.deepEqual(tree.node('TreeDir').props.loadState('').entries.map((entry) => entry.name), ['current.ts'])
  tree.dispose()
  assert.ok(requests.find((entry) => entry.path === 'nested').signal.aborted)
})

test('switching workspace retires pending tree requests and caches', async () => {
  const requests = []
  const h = harness((name, params, signal) => {
    const pending = deferred(); requests.push({ ...pending, ...params, signal }); return pending.promise
  })
  const tree = h.tree()
  await tree.settle()
  tree.update({ sessionId: 's2', cwd: 'C:/other-workspace' }); await tree.settle()
  assert.equal(requests[0].signal.aborted, true)
  requests[1].resolve({ entries: [{ name: 'second.ts', type: 'file' }] }); await tree.settle()
  requests[0].resolve({ entries: [{ name: 'first.ts', type: 'file' }] }); await tree.settle()
  assert.deepEqual(tree.node('TreeDir').props.loadState('').entries.map((entry) => entry.name), ['second.ts'])
  tree.dispose()
})
