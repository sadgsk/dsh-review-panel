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
    // The revisions picker is exercised in scripts/smoke-client.mjs; the page
    // tests only need its element/props contract.
    function PickerOverlay(props){return h('div', {className:'drp-picker-stub', 'data-mode':props.mode})}
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

async function chooseMode(page, id) {
  page.created.find((node) => String(node.props.className || '').split(' ').includes('drp-mode-btn')).props.onClick()
  await page.settle()
  const item = page.created.find((node) => node.props.role === 'menuitemradio' && node.props['data-drp-mode'] === id)
  assert.ok(item, 'mode menu item ' + id + ' exists')
  assert.ok(!item.props.disabled, 'mode menu item ' + id + ' is enabled')
  item.props.onClick()
  await page.settle()
}

test('a new turn reloads the active text and never paints new hunks over old text', async () => {
  let seq = 1
  const reads = [], pendingFiles = []
  const h = harness(async (name, params, signal) => {
    reads.push({ name, ...params, signal })
    if (name === 'latest') return { available: true, seq, turn: seq, summary: { files: [{ path: 'a.ts' }] } }
    if (name === 'gitStatus') return { available: false }
    if (name === 'config') return { phase: 3, features: { lsp: true, gitRevisions: true } }
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
    if (name === 'config') return { phase: 3, features: { lsp: true, gitRevisions: true } }
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
    if (name === 'config') return { phase: 3, features: { lsp: true, gitRevisions: true } }
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
  for (const targetMode of ['turn', 'git']) {
    let seq = 1, baseline = 'baseline 1'
    const h = harness(async (name) => {
      if (name === 'latest') return { available: true, seq, turn: seq, summary: { files: [{ path: 'a.ts' }] } }
      if (name === 'gitStatus') return { available: true, files: [{ path: 'a.ts', code: 'M' }] }
      if (name === 'config') return { phase: 3, features: { lsp: true, gitRevisions: true } }
      if (name === 'file') return { kind: 'text', text: 'identical source text' }
      if (name === 'diff' || name === 'gitFile') return textDiff(baseline, 'identical source text')
      throw new Error(name)
    })
    const page = h.page()
    await page.settle()
    if (targetMode === 'git') await chooseMode(page, targetMode)
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
    if (name === 'config') return { phase: 3, features: { lsp: true, gitRevisions: true } }
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
  await chooseMode(page, 'git')
  assert.equal(gitCalls, 1)
  assert.equal(page.node('MonacoHost').props.file.missing, true)
  assert.deepEqual(page.node('MonacoHost').props.regions[0].oldLines, ['removed code'])
  await chooseMode(page, 'code')
  assert.equal(page.node('MonacoHost').props.file, null)
  assert.ok(page.created.some((node) => node.props.className === 'drp-empty-body' && node.children.includes('File unavailable.')))
  page.dispose()
})

test('recreating a deleted empty file reactivates its LSP document on the existing Monaco model', async () => {
  let seq = 1
  const h = harness(async (name) => {
    if (name === 'latest') return { available: true, seq, turn: seq, summary: { files: [{ path: 'empty.ts' }] } }
    if (name === 'gitStatus') return { available: false }
    if (name === 'config') return { phase: 3, features: { lsp: true, gitRevisions: true } }
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
      if (name === 'config') return { phase: 3, features: { lsp: true, gitRevisions: true } }
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
    if (name === 'config') return { phase: 3, features: { lsp: true, gitRevisions: true } }
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

/** One compare payload as the host's `git-compare` route returns it. */
const comparePayload = (scope, rev) => ({
  available: true,
  scope,
  base: { sha: 'b'.repeat(40), short: 'bbbbbbb', subject: 'base' },
  target: scope === 'since'
    ? { kind: 'worktree' }
    : { kind: 'commit', sha: String(rev).repeat(40).slice(0, 40), short: 'ccccccc', subject: 'target' },
  files: [{ path: 'a.ts', code: 'M' }],
})
const commitRecord = (short, subject) => ({ sha: short.repeat(8), short, subject, date: '2026-01-02T03:04:05Z' })

test('最新提交 loads the HEAD comparison, historical content and diff and disables LSP for historical content', async () => {
  const reads = []
  const h = harness(async (name, params) => {
    reads.push({ name, ...params })
    if (name === 'latest') return { available: true, seq: 1, turn: 1, summary: { files: [{ path: 'a.ts' }] } }
    if (name === 'gitStatus') return { available: true, files: [{ path: 'a.ts', code: 'M' }] }
    if (name === 'config') return { phase: 3, features: { lsp: true, gitRevisions: true } }
    if (name === 'file') return { kind: 'text', text: params.rev === 'HEAD' ? 'historical text' : 'worktree text' }
    if (name === 'diff') return textDiff('turn base', 'worktree text')
    if (name === 'gitCompare') {
      assert.equal(params.rev, 'HEAD')
      assert.equal(params.scope, 'commit')
      return comparePayload('commit', 'h')
    }
    if (name === 'gitFile') {
      assert.equal(params.rev, 'HEAD')
      assert.equal(params.scope, 'commit')
      return textDiff('historical base', 'historical text')
    }
    throw new Error(name)
  })
  const page = h.page()
  await page.settle()
  const editor = () => page.node('MonacoHost').props
  const modeLabel = () => page.created.find((node) => String(node.props.className || '').split(' ').includes('drp-mode-label'))
  assert.equal(editor().file.text, 'worktree text')
  assert.equal(modeLabel().children.join(''), 'mode.turn.withTurn')
  // TURN content feeds the language server.
  editor().onModelReady({ path: 'a.ts', text: 'worktree text', language: 'typescript', monaco: {}, model: {} })
  assert.equal(h.fixtures.lspDocuments.length, 1)

  await chooseMode(page, 'revision-head')
  assert.equal(modeLabel().children.join(''), 'mode.commit')
  // The one-click entry advertises the current (HEAD) revision as checked.
  page.created.find((node) => String(node.props.className || '').split(' ').includes('drp-mode-btn')).props.onClick()
  await page.settle()
  const headItem = page.created.find((node) => node.props.role === 'menuitemradio' && node.props['data-drp-mode'] === 'revision-head')
  assert.ok(headItem, 'the 最新提交 radio item exists')
  assert.equal(headItem.props['aria-checked'], true)
  headItem.props.onClick()
  await page.settle()
  assert.ok(reads.some((entry) => entry.name === 'gitCompare' && entry.rev === 'HEAD' && entry.scope === 'commit'), 'one click asks the host for the HEAD comparison')
  assert.ok(reads.some((entry) => entry.name === 'file' && entry.rev === 'HEAD'), 'historical content is read at the revision')
  assert.ok(reads.some((entry) => entry.name === 'gitFile' && entry.rev === 'HEAD' && entry.scope === 'commit'), 'the file diff compares the commit scope')
  assert.equal(editor().file.text, 'historical text', 'the code area shows the commit content, not the worktree file')
  assert.deepEqual(editor().regions[0]?.oldLines, ['historical base'])
  assert.equal(page.node('ReviewStatusBar').props.statusText, 'status.revision.commit')
  assert.equal(page.node('ReviewStatusBar').props.gitText, 'status.revision.historical')
  assert.equal(page.node('FileTree').props.treeMode, 'revision')
  assert.equal(page.node('FileTree').props.gitStatus.available, true)
  assert.equal(page.node('FileTree').props.gitStatus.files.length, 1)

  const clears = h.fixtures.lspClears
  editor().onModelReady({ path: 'a.ts', text: 'historical text', language: 'typescript', monaco: {}, model: {} })
  assert.ok(h.fixtures.lspClears > clears, 'historical content clears the LSP document')
  assert.equal(h.fixtures.lspDocuments.length, 1, 'historical content is never opened as an LSP document')
  page.dispose()
})

test('the revisions picker applies scope, resolves raw revisions and refetches when the scope changes', async () => {
  const reads = []
  const commit = commitRecord('c1c1c1c', 'fix: first')
  const sinceCommit = commitRecord('c2c2c2c', 'fix: second')
  const resolved = commitRecord('c3c3c3c', 'fix: raw')
  const h = harness(async (name, params) => {
    reads.push({ name, ...params })
    if (name === 'latest') return { available: true, seq: 1, turn: 1, summary: { files: [{ path: 'a.ts' }] } }
    if (name === 'gitStatus') return { available: true, files: [{ path: 'a.ts', code: 'M' }] }
    if (name === 'config') return { phase: 3, features: { lsp: true, gitRevisions: true } }
    if (name === 'file') return { kind: 'text', text: params.rev ? 'content at ' + params.rev : 'worktree content' }
    if (name === 'diff') return textDiff('turn base', 'worktree content')
    if (name === 'gitCompare') return comparePayload(params.scope, params.rev)
    if (name === 'gitFile') return textDiff('base ' + params.scope, 'content ' + params.scope)
    if (name === 'gitRevisions') {
      if (params.q === 'HEAD~2') return { available: true, resolved }
      return { available: true, resolveError: 'bad revision' }
    }
    throw new Error(name)
  })
  const page = h.page()
  await page.settle()
  const readOf = (name) => reads.filter((entry) => entry.name === name)

  // No revision yet: the "Git 版本…" item opens the revisions picker.
  await chooseMode(page, 'revision')
  let picker = page.node('PickerOverlay')
  assert.ok(picker, 'the revisions picker opened')
  assert.equal(picker.props.mode, 'revisions')
  assert.equal(picker.props.revisionScope, 'commit')
  picker.props.onPickRevision(commit)
  await page.settle()
  assert.ok(!page.node('PickerOverlay'), 'choosing a commit closes the picker')
  assert.equal(readOf('gitCompare').length, 1)
  assert.equal(readOf('gitCompare')[0].rev, commit.sha)
  assert.equal(readOf('gitCompare')[0].scope, 'commit')
  assert.equal(readOf('file').slice(-1)[0].rev, commit.sha, 'commit scope reads the historical file')
  assert.equal(readOf('gitFile').slice(-1)[0].rev, commit.sha)
  assert.equal(readOf('gitFile').slice(-1)[0].scope, 'commit')
  assert.equal(page.node('MonacoHost').props.file.text, 'content at ' + commit.sha)
  assert.deepEqual(page.node('MonacoHost').props.regions[0]?.oldLines, ['base commit'])
  assert.equal(page.node('ReviewStatusBar').props.statusText, 'status.revision.commit')
  assert.equal(page.node('ReviewStatusBar').props.gitText, 'status.revision.historical')
  assert.equal(page.node('FileTree').props.treeMode, 'revision')
  assert.equal(page.node('FileTree').props.gitStatus.scope, 'commit')

  // Reopen through the mode dropdown (an existing revision opens the picker).
  page.created.find((node) => String(node.props.className || '').split(' ').includes('drp-mode-btn')).props.onClick()
  await page.settle()
  const revisionItem = page.created.find((node) => node.props.role === 'menuitemradio' && node.props['data-drp-mode'] === 'revision')
  assert.equal(revisionItem.props['aria-checked'], true)
  revisionItem.props.onClick()
  await page.settle()
  picker = page.node('PickerOverlay')
  assert.ok(picker, 'the picked version reopens the picker')
  assert.equal(picker.props.revisionScope, 'commit')
  picker.props.onRevisionScopeChange('since')
  await page.settle()
  picker = page.node('PickerOverlay')
  assert.equal(picker.props.revisionScope, 'since', 'the scope toggle updates the picker')
  const comparesBefore = readOf('gitCompare').length
  const filesBefore = readOf('file').length
  picker.props.onPickRevision(sinceCommit)
  await page.settle()
  assert.ok(!page.node('PickerOverlay'), 'the picker closed')
  assert.equal(readOf('gitCompare').length, comparesBefore + 1, 'a scope change refetches the comparison')
  assert.equal(readOf('gitCompare').slice(-1)[0].rev, sinceCommit.sha)
  assert.equal(readOf('gitCompare').slice(-1)[0].scope, 'since')
  assert.equal(readOf('file').length, filesBefore + 1)
  assert.equal(readOf('file').slice(-1)[0].rev, undefined, 'since scope reads the worktree file')
  assert.equal(page.node('MonacoHost').props.file.text, 'worktree content')
  assert.equal(page.node('ReviewStatusBar').props.statusText, 'status.revision.since')
  assert.equal(page.node('ReviewStatusBar').props.gitText, 'status.revision.worktree')
  assert.equal(page.node('FileTree').props.gitStatus.scope, 'since')
  assert.ok(page.node('MonacoHost').props.documentEpoch > 0, 'switching from commit to since scope re-announces the document')
  // Since scope is the worktree: the language server keeps working.
  const docs = h.fixtures.lspDocuments.length
  page.node('MonacoHost').props.onModelReady({ path: 'a.ts', text: 'worktree content', language: 'typescript', monaco: {}, model: {} })
  assert.equal(h.fixtures.lspDocuments.length, docs + 1, 'since-scope content still feeds the language server')

  // A raw revision expression is resolved by the host; the picker scope sticks.
  await chooseMode(page, 'revision')
  picker = page.node('PickerOverlay')
  picker.props.onPickRevision({ raw: 'HEAD~2' })
  await page.settle()
  assert.ok(!page.node('PickerOverlay'), 'the picker closed')
  assert.equal(readOf('gitRevisions').length, 1)
  assert.equal(readOf('gitRevisions')[0].q, 'HEAD~2')
  assert.equal(readOf('gitCompare').slice(-1)[0].rev, resolved.sha)
  assert.equal(readOf('gitCompare').slice(-1)[0].scope, 'since')

  // A failed raw resolution keeps the picker open and warns.
  await chooseMode(page, 'revision')
  picker = page.node('PickerOverlay')
  picker.props.onPickRevision({ raw: 'nope' })
  await page.settle()
  assert.ok(page.node('PickerOverlay'), 'a failed raw resolution keeps the picker open')
  assert.equal(page.node('ReviewStatusBar').props.statusText, 'picker.revisions.resolveFailed')
  page.dispose()
})

test('switching back to turn restores the turn baseline and its language-server document', async () => {
  const commit = commitRecord('d1d1d1d', 'turn work')
  const h = harness(async (name, params) => {
    if (name === 'latest') return { available: true, seq: 1, turn: 1, summary: { files: [{ path: 'a.ts' }] } }
    if (name === 'gitStatus') return { available: true, files: [{ path: 'a.ts', code: 'M' }] }
    if (name === 'config') return { phase: 3, features: { lsp: true, gitRevisions: true } }
    if (name === 'file') return { kind: 'text', text: params.rev ? 'historical text' : 'worktree text' }
    if (name === 'diff') return textDiff('turn base', 'worktree text')
    if (name === 'gitCompare') return comparePayload(params.scope, params.rev)
    if (name === 'gitFile') return textDiff('rev base', 'historical text')
    throw new Error(name)
  })
  const page = h.page()
  await page.settle()
  await chooseMode(page, 'revision')
  page.node('PickerOverlay').props.onPickRevision(commit)
  await page.settle()
  assert.equal(page.node('MonacoHost').props.file.text, 'historical text')
  assert.equal(page.node('ReviewStatusBar').props.gitText, 'status.revision.historical')
  const historicalEpoch = page.node('MonacoHost').props.documentEpoch

  await chooseMode(page, 'turn')
  assert.equal(page.node('MonacoHost').props.file.text, 'worktree text')
  // Leaving historical content re-announces the document even when the Monaco
  // model text is unchanged (same path/text would skip onModelReady).
  assert.ok(page.node('MonacoHost').props.documentEpoch > historicalEpoch, 'leaving historical content bumps documentEpoch so LSP re-attaches')
  assert.deepEqual(page.node('MonacoHost').props.regions[0]?.oldLines, ['turn base'])
  assert.equal(page.node('ReviewStatusBar').props.statusText, 'status.mode.turn')
  assert.equal(page.node('ReviewStatusBar').props.gitText, null)
  assert.equal(page.node('FileTree').props.treeMode, 'turn')
  // Turn mode re-enables the language server for the active document.
  const docs = h.fixtures.lspDocuments.length
  page.node('MonacoHost').props.onModelReady({ path: 'a.ts', text: 'worktree text', language: 'typescript', monaco: {}, model: {} })
  assert.equal(h.fixtures.lspDocuments.length, docs + 1)
  page.dispose()
})

test('revisiting a file in revision mode reuses the per-revision caches', async () => {
  const reads = []
  const commit = commitRecord('e1e1e1e', 'cache work')
  const h = harness(async (name, params) => {
    reads.push({ name, ...params })
    if (name === 'latest') return { available: false }
    if (name === 'gitStatus') return { available: true, files: [] }
    if (name === 'config') return { phase: 3, features: { lsp: true, gitRevisions: true } }
    if (name === 'file') return { kind: 'text', text: 'content of ' + params.path + ' at rev' }
    if (name === 'gitCompare') return { ...comparePayload(params.scope, params.rev), files: [{ path: 'a.ts', code: 'M' }, { path: 'b.ts', code: 'M' }] }
    if (name === 'gitFile') return textDiff(params.path + ' base', params.path + ' content')
    throw new Error(name)
  })
  const page = h.page()
  await page.settle()
  await chooseMode(page, 'revision')
  page.node('PickerOverlay').props.onPickRevision(commit)
  await page.settle()
  page.node('FileTree').props.onOpen('a.ts')
  await page.settle()
  assert.equal(page.node('MonacoHost').props.file.text, 'content of a.ts at rev')
  page.node('FileTree').props.onOpen('b.ts')
  await page.settle()
  assert.equal(page.node('MonacoHost').props.file.text, 'content of b.ts at rev')
  const counts = {
    compare: reads.filter((entry) => entry.name === 'gitCompare').length,
    files: reads.filter((entry) => entry.name === 'file').length,
    gitFiles: reads.filter((entry) => entry.name === 'gitFile').length,
  }
  page.node('FileTree').props.onOpen('a.ts')
  await page.settle()
  assert.equal(page.node('MonacoHost').props.file.text, 'content of a.ts at rev')
  assert.deepEqual(page.node('MonacoHost').props.regions[0]?.oldLines, ['a.ts base'])
  assert.deepEqual({
    compare: reads.filter((entry) => entry.name === 'gitCompare').length,
    files: reads.filter((entry) => entry.name === 'file').length,
    gitFiles: reads.filter((entry) => entry.name === 'gitFile').length,
  }, counts, 'revisiting a file reuses the file and comparison caches')
  page.dispose()
})

test('manual refresh refetches the revision comparison, the historical file and its diff', async () => {
  const reads = []
  let version = 1
  const commit = commitRecord('f1f1f1f', 'refresh work')
  const h = harness(async (name, params) => {
    reads.push({ name, ...params })
    if (name === 'latest') return { available: false }
    if (name === 'gitStatus') return { available: true, files: [] }
    if (name === 'config') return { phase: 3, features: { lsp: true, gitRevisions: true } }
    if (name === 'file') return { kind: 'text', text: params.rev ? 'historical text v' + version : 'worktree text' }
    if (name === 'gitCompare') return {
      ...comparePayload(params.scope, params.rev),
      base: { sha: 'b'.repeat(40), short: 'base0' + version, subject: 'base' },
      files: version === 1 ? [{ path: 'a.ts', code: 'M' }] : [{ path: 'a.ts', code: 'M' }, { path: 'b.ts', code: 'A' }],
    }
    if (name === 'gitFile') return textDiff('base v' + version, 'historical text v' + version)
    throw new Error(name)
  })
  const page = h.page()
  await page.settle()
  await chooseMode(page, 'revision')
  page.node('PickerOverlay').props.onPickRevision(commit)
  await page.settle()
  page.node('FileTree').props.onOpen('a.ts')
  await page.settle()
  const before = {
    compare: reads.filter((entry) => entry.name === 'gitCompare').length,
    files: reads.filter((entry) => entry.name === 'file').length,
    gitFiles: reads.filter((entry) => entry.name === 'gitFile').length,
  }
  assert.equal(page.node('FileTree').props.gitStatus.files.length, 1)
  assert.equal(page.node('MonacoHost').props.file.text, 'historical text v1')
  version = 2
  assert.equal(h.api.runtimeState.page.command('refresh'), true)
  await page.settle()
  assert.equal(reads.filter((entry) => entry.name === 'gitCompare').length, before.compare + 1, 'refresh refetches the compare payload')
  assert.equal(reads.filter((entry) => entry.name === 'file').length, before.files + 1, 'refresh refetches the historical file')
  assert.equal(reads.filter((entry) => entry.name === 'gitFile').length, before.gitFiles + 1, 'refresh refetches the file diff')
  assert.equal(reads.filter((entry) => entry.name === 'gitCompare').slice(-1)[0].rev, commit.sha)
  assert.equal(reads.filter((entry) => entry.name === 'gitCompare').slice(-1)[0].scope, 'commit')
  assert.equal(page.node('FileTree').props.gitStatus.files.length, 2, 'the tree receives the refreshed compare payload')
  assert.equal(page.node('FileTree').props.gitStatus.base.short, 'base02')
  assert.equal(page.node('MonacoHost').props.file.text, 'historical text v2')
  assert.deepEqual(page.node('MonacoHost').props.regions[0]?.oldLines, ['base v2'])
  assert.equal(page.node('ReviewStatusBar').props.statusText, 'status.revision.commit')
  page.dispose()
})

test('revision tree mode shows git badges (T reads as M, U/other as unmerged) and the git empty text', async () => {
  const h = harness(async (name) => {
    if (name === 'tree') return { entries: [{ name: 'a.ts', type: 'file' }, { name: 'b.ts', type: 'file' }] }
    throw new Error(name)
  })
  const files = [{ path: 'a.ts', code: 'T' }, { path: 'b.ts', code: 'U' }]
  const tree = h.tree({ treeMode: 'revision', changedOnly: true, gitStatus: { available: true, files } })
  await tree.settle()
  const badges = () => tree.created.filter((node) => String(node.props.className || '').split(' ').includes('drp-git-badge'))
  assert.deepEqual(badges().map((node) => node.children.join('')), ['M', 'U'])
  assert.deepEqual(badges().map((node) => node.props.title), ['Git: T', 'Git: U'])

  // The lazy tree gets the same map, so revision rows carry git decorations.
  tree.update({ changedOnly: false })
  await tree.settle()
  const lazy = tree.node('TreeDir').props.gitBadges
  assert.ok(lazy instanceof Map)
  assert.equal(lazy.get('a.ts').code, 'T')
  assert.equal(lazy.get('b.ts').code, 'U')

  tree.update({ changedOnly: true, gitStatus: { available: true, files: [] } })
  await tree.settle()
  const empty = tree.created.find((node) => String(node.props.className || '').includes('drp-tree-empty'))
  assert.equal(empty.children.join(''), 'tree.noChanges')
  tree.dispose()
})
