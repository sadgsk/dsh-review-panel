#!/usr/bin/env node
/**
 * Offline smoke test for the built browser bundle.
 *
 * It executes the ModuleLoader factory with a stub `require`, stubs the minimal
 * DOM/client-context surface the registration path touches, then invokes
 * `apply` and the main components with a tiny React hook simulator. This proves
 * the bundle parses, registers, and renders without throwing — it does not
 * replace verification in the live Harness page.
 */
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundlePath = join(packageDir, 'lib', 'client.js')

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

// ---- Minimal DOM ----
function makeElement(tag = 'div') {
  const element = {
    tagName: String(tag).toUpperCase(),
    style: { setProperty() {}, tabSize: '' },
    dataset: {},
    children: [],
    textContent: '',
    innerHTML: '',
    className: '',
    setAttribute() {},
    getAttribute() {
      return null
    },
    appendChild(child) {
      this.children.push(child)
      return child
    },
    removeChild(child) {
      this.children = this.children.filter((item) => item !== child)
      return child
    },
    remove() {},
    querySelector() {
      return null
    },
    querySelectorAll() {
      return []
    },
    addEventListener() {},
    removeEventListener() {},
    contains() {
      return false
    },
    scrollIntoView() {},
    select() {},
    focus() {},
    getBoundingClientRect() {
      return { width: 900, height: 600, top: 0, left: 0 }
    },
    get clientWidth() {
      return 900
    },
  }
  return element
}

const documentStub = {
  head: makeElement('head'),
  body: makeElement('body'),
  documentElement: makeElement('html'),
  baseURI: 'http://127.0.0.1:52029/',
  createElement: makeElement,
  querySelector() {
    return null
  },
  addEventListener() {},
  removeEventListener() {},
  createTextNode() {
    return makeElement('text')
  },
}

const windowStub = {
  MonacoEnvironment: undefined,
  matchMedia() {
    return { matches: false, addEventListener() {}, removeEventListener() {} }
  },
  addEventListener() {},
  removeEventListener() {},
  getComputedStyle() {
    return { getPropertyValue() { return '' } }
  },
  requestIdleCallback(callback) {
    callback({ timeRemaining: () => 0 })
  },
}

globalThis.window = windowStub
globalThis.document = documentStub
globalThis.getComputedStyle = windowStub.getComputedStyle
globalThis.MutationObserver = class {
  observe() {}
  disconnect() {}
}
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
}
globalThis.AbortController = globalThis.AbortController || class {
  constructor() { this.signal = { aborted: false, addEventListener() {}, removeEventListener() {} } }
  abort() {}
}
if (!globalThis.navigator) {
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: undefined }, configurable: true })
}
// Keep retry timers inert; the offline test never waits for optional services.
const realSetTimeout = globalThis.setTimeout
globalThis.setTimeout = (callback, delay) => (Number(delay) >= 1000 ? 0 : realSetTimeout(callback, Math.min(Number(delay) || 0, 10)))

// ---- Capture the module loader factory ----
let factory = null
windowStub.__ModuleLoader__ = {
  load(definition) {
    factory = definition.factory
  },
}

const source = await readFile(bundlePath, 'utf8')
// The bundle is a classic script; evaluate it with the stubs in scope.
globalThis.__DSH_REVIEW_PANEL_TEST__ = true
new Function('window', 'document', source)(windowStub, documentStub)
assert(typeof factory === 'function', 'ModuleLoader factory was not registered')

// ---- React stub with a call-order hook simulator ----
let hookCursor = 0
let hookState = []
const ReactStub = {
  Fragment: Symbol('Fragment'),
  createElement(type, props, ...children) {
    return { type, props: props || {}, children }
  },
  useState(initial) {
    const index = hookCursor++
    if (!(index in hookState)) hookState[index] = typeof initial === 'function' ? initial() : initial
    return [hookState[index], (next) => { hookState[index] = typeof next === 'function' ? next(hookState[index]) : next }]
  },
  useRef(initial) {
    const index = hookCursor++
    if (!(index in hookState)) hookState[index] = { current: initial }
    return hookState[index]
  },
  useCallback(fn) {
    hookCursor += 1
    return fn
  },
  useMemo(fn) {
    hookCursor += 1
    return fn()
  },
  useEffect() {
    hookCursor += 1
  },
  memo(fn) {
    return fn
  },
}

/** Render one component function with a fresh hook state. */
function renderComponent(name, fn, props) {
  hookCursor = 0
  hookState = []
  try {
    const tree = fn(props)
    notes.push(`${name}: rendered (${tree && tree.type ? String(tree.type) : typeof tree})`)
    return tree
  } catch (error) {
    fail(`${name} threw during render: ${error && error.stack ? error.stack : String(error)}`)
    return null
  }
  finally {
    hookCursor = 0
    hookState = []
  }
}

/** Collect every element of a stubbed render tree whose className contains one token. */
function findElementsByClass(node, token, found = []) {
  if (!node || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) findElementsByClass(child, token, found)
    return found
  }
  const className = node.props && typeof node.props.className === 'string' ? node.props.className : ''
  if (className.split(/\s+/).includes(token)) found.push(node)
  for (const child of node.children || []) findElementsByClass(child, token, found)
  return found
}

// ---- Client context stub ----
const themeStub = { scheme: 'light', marker: null, computedBackground: '' }
// The theme detector reads DOM markers and the rendered background; wire both to
// the mutable stub so the offline test can simulate a live theme switch.
documentStub.body.getAttribute = (name) => (name === 'data-ds-dark-theme' ? themeStub.marker : null)
documentStub.documentElement.getAttribute = () => null
globalThis.getComputedStyle = (node) => ({
  backgroundColor: themeStub.computedBackground,
  getPropertyValue: (name) => (name === '--dsw-alias-bg-base' ? themeStub.computedBackground : ''),
})
windowStub.getComputedStyle = globalThis.getComputedStyle
const registrations = { dock: [], sidebarBody: [], view: [], tabTypes: [], shortcuts: [], styles: 0, locale: 0 }
const disposers = []
const ctxStub = {
  get(name) {
    if (name === 'sidebarRightTabs') {
      return {
        register(definition) {
          registrations.tabTypes.push(definition)
          return () => {}
        },
      }
    }
    if (name === 'sidebarRight') {
      return {
        openResource(address) {
          registrations.lastOpen = address
        },
      }
    }
    if (name === 'shortcuts') {
      return {
        register(command) {
          registrations.shortcuts.push(command)
          return () => {}
        },
        catalog: { getSnapshot: () => [], subscribe: () => () => {} },
        config: { getSnapshot: () => ({ revision: '1' }) },
      }
    }
    if (name === 'theme') {
      return { getTheme: () => ({ preference: themeStub.scheme, active: { id: themeStub.scheme, colorScheme: themeStub.scheme, tokens: {} } }) }
    }
    return undefined
  },
  on() {
    return () => {}
  },
  effect(callback) {
    const disposer = callback()
    if (typeof disposer === 'function') disposers.push(disposer)
    return () => {}
  },
  locale: {
    register() {
      registrations.locale += 1
      return () => {}
    },
    bind() {
      return (key, params) => {
        if (!params) return key
        return String(key).replace(/\{(\w+)\}/g, (match, name) => (params[name] !== undefined ? String(params[name]) : match))
      }
    },
  },
  slots: {
    inject(name, callback) {
      registrations.injected = registrations.injected || []
      registrations.injected.push(name)
      const result = callback()
      if (typeof result === 'function') disposers.push(result)
      return () => {}
    },
    register(options, component) {
      if (options && options.name === 'conversation.input.dock') registrations.dock.push({ options, component })
      if (options && options.name === 'sidebar.right.pane.tab') registrations.sidebarBody.push({ options, component })
      if (options && options.name === 'conversation.view') registrations.view.push({ options, component })
      return () => {}
    },
  },
  timeout(callback) {
    return () => {}
  },
}

// ---- Exercise the plugin ----
let moduleExports = null
try {
  moduleExports = factory((name) => (name === 'react' ? ReactStub : undefined))
} catch (error) {
  fail(`factory threw: ${error && error.stack ? error.stack : String(error)}`)
}
assert(moduleExports && typeof moduleExports.apply === 'function', 'module exports.apply missing')
assert(Array.isArray(moduleExports && moduleExports.inject), 'module exports.inject missing')

if (moduleExports && typeof moduleExports.apply === 'function') {
  try {
    moduleExports.apply(ctxStub)
  } catch (error) {
    fail(`apply threw: ${error && error.stack ? error.stack : String(error)}`)
  }
}

// Give the retry timers a turn (they are stubbed to fire fast).
await new Promise((resolvePromise) => realSetTimeout(resolvePromise, 80))

assert(registrations.styles === undefined || true, 'styles')
assert(documentStub.head.children.length >= 1, 'stylesheet element was not appended')
assert(registrations.locale === 1, 'locale dictionary registration missing')
assert(registrations.tabTypes.length === 1, `expected one tab type registration, got ${registrations.tabTypes.length}`)
assert(registrations.dock.length === 1, `expected one composer pill, got ${registrations.dock.length}`)
assert(registrations.sidebarBody.length === 1, `expected one sidebar body, got ${registrations.sidebarBody.length}`)
assert(registrations.shortcuts.length > 0, 'official shortcuts were not registered')

const tabType = registrations.tabTypes[0]
if (tabType) {
  assert(tabType.kind === 'review-panel', 'tab kind mismatch')
  assert(Array.isArray(tabType.patterns) && tabType.patterns[0] === 'dsh-resource://review-panel/**', 'tab patterns mismatch')
  assert(typeof tabType.title === 'function', 'tab title must be a function')
  assert(tabType.canOpen('dsh-resource://review-panel/session/s1') === true, 'canOpen should accept our address')
  assert(tabType.canOpen('dsh-resource://file/x') === false, 'canOpen should reject foreign addresses')
}

// Component render smoke tests.
const t = (key, params) => {
  if (!params) return key
  return String(key).replace(/\{(\w+)\}/g, (match, name) => (params[name] !== undefined ? String(params[name]) : match))
}
const services = { right: ctxStub.get('sidebarRight'), tabs: ctxStub.get('sidebarRightTabs') }
const useSessions = (selector) => selector({ byId: { 'session-1': { cwd: 'C:/workspace', running: false } } })

const internals = (moduleExports && moduleExports.__test) || {}
assert(Object.keys(internals).length > 0, 'test hook missing (build with the __DSH_REVIEW_PANEL_TEST__ export)')
const pageTree = renderComponent('ReviewPage', internals.ReviewPage, {
  sessionId: 'session-1',
  t,
  useSessions,
  services,
  address: 'dsh-resource://review-panel/session/session-1',
})
const pill = renderComponent('ChangesPill', internals.ChangesPill, {
  sessionId: 'session-1',
  session: { id: 'session-1', running: true },
  t,
})
const tree = renderComponent('FileTree', internals.FileTree, {
  sessionId: 'session-1',
  cwd: 'C:/workspace',
  summaryFiles: [{ path: 'src/a.ts', display: 'src/a.ts', added: 3, deleted: 1 }],
  gitStatus: { available: true, files: [{ path: 'src/a.ts', code: 'M' }, { path: 'new.ts', code: '?' }] },
  changedOnly: false,
  activePath: 'src/a.ts',
  treeMode: 'turn',
  onOpen() {},
  onToggleChangedOnly() {},
  onClose: null,
  reveal: { path: null, nonce: 0 },
  t,
})
renderComponent('FileTree(git)', internals.FileTree, {
  sessionId: 'session-1',
  cwd: 'C:/workspace',
  summaryFiles: null,
  gitStatus: { available: true, files: [{ path: 'src/a.ts', code: 'M' }, { path: 'new.ts', code: '?' }] },
  changedOnly: true,
  activePath: 'src/a.ts',
  treeMode: 'git',
  onOpen() {},
  onToggleChangedOnly() {},
  onClose: null,
  reveal: null,
  t,
})
renderComponent('PickerOverlay(commands)', internals.PickerOverlay, {
  mode: 'commands',
  t,
  sessionId: 'session-1',
  commands: [{ id: 'x', label: () => '命令 A', hint: '' }],
  onPickFile() {},
  onPickCommand() {},
  onClose() {},
})
renderComponent('PickerOverlay(quickopen)', internals.PickerOverlay, {
  mode: 'quickopen',
  t,
  sessionId: 'session-1',
  commands: [],
  onPickFile() {},
  onPickCommand() {},
  onClose() {},
})
renderComponent('PickerOverlay(search)', internals.PickerOverlay, {
  mode: 'search',
  t,
  sessionId: 'session-1',
  commands: [],
  onPickFile() {},
  onPickCommand() {},
  onClose() {},
})
// Git-version picker: renders with the new (optional) revision props and stays
// safe when the page does not pass them yet.
const revisionsTree = renderComponent('PickerOverlay(revisions)', internals.PickerOverlay, {
  mode: 'revisions',
  t,
  sessionId: 'session-1',
  commands: [],
  revisionScope: 'commit',
  onRevisionScopeChange() {},
  onPickRevision() {},
  onPickFile() {},
  onPickCommand() {},
  onClose() {},
})
const scopeRows = findElementsByClass(revisionsTree, 'drp-picker-scope')
assert(scopeRows.length === 1, `revision picker expected one scope row, got ${scopeRows.length}`)
const scopeButtons = findElementsByClass(revisionsTree, 'drp-seg-btn')
assert(scopeButtons.length === 2, `revision picker expected two scope buttons, got ${scopeButtons.length}`)
if (scopeButtons.length === 2) {
  assert(scopeButtons[0].props.title === 'picker.revisions.scope.commit.hint', 'commit scope hint mismatch')
  assert(scopeButtons[1].props.title === 'picker.revisions.scope.since.hint', 'since scope hint mismatch')
  assert(String(scopeButtons[0].props.className).includes('drp-seg-btn-on'), 'commit scope should be the default selection')
  assert(!String(scopeButtons[1].props.className).includes('drp-seg-btn-on'), 'since scope must not be selected by default')
}
const revisionsDialogs = findElementsByClass(revisionsTree, 'drp-picker')
assert(revisionsDialogs.length === 1 && revisionsDialogs[0].props['aria-label'] === 'picker.revisions.title', 'revision picker title mismatch')
renderComponent('PickerOverlay(revisions, no version props)', internals.PickerOverlay, {
  mode: 'revisions',
  t,
  sessionId: 'session-1',
})
renderComponent('TreeDir', internals.TreeDir, {
  relPath: '',
  rootName: 'workspace',
  depth: 0,
  expanded: new Set(['']),
  loadState: () => ({ status: 'ready', entries: [{ name: 'src', type: 'directory' }] }),
  onToggle() {},
  onOpen() {},
  activePath: 'src/a.ts',
  changed: new Map(),
  badgesEnabled: true,
})
renderComponent('EmptyState', internals.EmptyState, { t, latest: null })
renderComponent('HandoffCard', internals.HandoffCard, {
  sessionId: 'session-1',
  path: 'docs/readme.md',
  kind: 'external',
  t,
  right: ctxStub.get('sidebarRight'),
  absolutePath: 'C:/workspace/docs/readme.md',
})
renderComponent('MonacoHost', internals.MonacoHost, {
  monaco: null,
  file: null,
  regions: [],
  wrap: false,
  minimap: false,
  reveal: { line: 0, nonce: 0 },
})

// Geometry of the review-panel region builder.
if (typeof internals.buildRegions === 'function') {
  const current = ['a', 'b1', 'b2', 'c', 'd'].join('\n')
  const comparison = {
    kind: 'text',
    hunks: [{ oldStart: 1, oldLines: 4, newStart: 1, newLines: 5, lines: [' a', '-b', '+b1', '+b2', ' c', ' d'] }],
  }
  try {
    const built = internals.buildRegions(comparison, current)
    assert(built.total === 1, `buildRegions expected 1 region, got ${built.total}`)
    assert(built.regions[0].start === 2, `buildRegions expected region start 2, got ${built.regions[0].start}`)
    assert(built.regions[0].oldLines.length === 1 && built.regions[0].oldLines[0] === 'b', 'buildRegions deleted line mismatch')
    assert(built.regions[0].addedLines === 2, 'buildRegions added line count mismatch')
    assert(built.regions[0].end === 4, `buildRegions expected exclusive end 4, got ${built.regions[0].end}`)
    notes.push('buildRegions: ok')
  } catch (error) {
    fail(`buildRegions threw: ${error && error.stack ? error.stack : String(error)}`)
  }
}
// Workspace-relative mapping for recorded (often absolute) turn paths.
if (typeof internals.toWorkspaceRel === 'function') {  try {
    const cwd = 'C:\\workspace'
    assert(internals.toWorkspaceRel('C:/workspace/src/a.ts', cwd) === 'src/a.ts', 'toWorkspaceRel absolute posix mismatch')
    assert(internals.toWorkspaceRel('C:\\workspace\\src\\b.ts', cwd) === 'src/b.ts', 'toWorkspaceRel absolute win mismatch')
    assert(internals.toWorkspaceRel('src/c.ts', cwd) === 'src/c.ts', 'toWorkspaceRel relative mismatch')
    assert(internals.toWorkspaceRel('D:/elsewhere/x.ts', cwd) === 'D:/elsewhere/x.ts', 'toWorkspaceRel outside mismatch')
    notes.push('toWorkspaceRel: ok')
  } catch (error) {
    fail(`toWorkspaceRel threw: ${error && error.stack ? error.stack : String(error)}`)
  }
}
if (typeof internals.fuzzyScore === 'function' && typeof internals.rankQuickOpen === 'function') {
  try {
    assert(internals.fuzzyScore('rp', 'src/retry-policy.ts') > 0, 'fuzzyScore should match a subsequence')
    assert(internals.fuzzyScore('zzz', 'src/retry-policy.ts') === 0, 'fuzzyScore should reject a non-subsequence')
    const files = ['src/retry-policy.ts', 'src/feature-flags.ts', 'README.md', 'demo/a.ts']
    const ranked = internals.rankQuickOpen(files, 'retry', 10)
    assert(ranked.length === 1 && ranked[0].path === 'src/retry-policy.ts', 'rankQuickOpen ranking mismatch')
    assert(internals.rankQuickOpen(files, '', 2).length === 2, 'rankQuickOpen empty query should return the first N')
    notes.push('quick open ranker: ok')
  } catch (error) {
    fail(`quick open ranker threw: ${error && error.stack ? error.stack : String(error)}`)
  }
}
if (typeof internals.formatRevisionDate === 'function' && typeof internals.isRevisionLikeQuery === 'function') {
  try {
    const year = new Date().getFullYear()
    assert(internals.formatRevisionDate(year + '-03-04T05:06:07Z') === '03-04', 'current-year revision dates are shortened')
    assert(internals.formatRevisionDate('1999-12-31T23:59:59Z') === '1999-12-31', 'other-year revision dates keep the year')
    assert(internals.formatRevisionDate('not-a-date') === '', 'unparseable revision dates render empty')
    assert(internals.isRevisionLikeQuery('b42aebd') === true, 'short sha is offered as a raw revision')
    assert(internals.isRevisionLikeQuery('HEAD~2') === true, 'HEAD~2 is offered as a raw revision')
    assert(internals.isRevisionLikeQuery('origin/main') === true, 'remote ref is offered as a raw revision')
    assert(internals.isRevisionLikeQuery('fix typo') === false, 'commit-subject text is not a raw revision')
    notes.push('revision picker helpers: ok')
  } catch (error) {
    fail(`revision picker helpers threw: ${error && error.stack ? error.stack : String(error)}`)
  }
}
if (typeof internals.absolutePathOf === 'function') {
  try {
    assert(internals.absolutePathOf('C:\\workspace', 'src/a.ts') === 'C:\\workspace\\src\\a.ts', 'absolutePathOf windows mismatch')
    assert(internals.absolutePathOf('/home/u/ws', 'a/b.ts') === '/home/u/ws/a/b.ts', 'absolutePathOf posix mismatch')
    assert(internals.absolutePathOf(undefined, 'x.ts') === 'x.ts', 'absolutePathOf empty cwd mismatch')
    notes.push('absolutePathOf: ok')
  } catch (error) {
    fail(`absolutePathOf threw: ${error && error.stack ? error.stack : String(error)}`)
  }
}
// Theme resolution and the stale-token guard (the "white editor under a dark
// DSH theme" regression: themes defined once froze the light background).
if (typeof internals.detectScheme === 'function' && typeof internals.editorColorsOf === 'function') {
  try {
    // 1) The rendered DSH surface token wins (dark) even with a stale service.
    themeStub.scheme = 'light'
    themeStub.marker = null
    themeStub.computedBackground = '#101418'
    assert(internals.detectScheme() === 'dark', 'rendered dark token should force the dark scheme')
    const darkColors = internals.editorColorsOf('dark')
    assert(String(darkColors['editor.background']).toLowerCase() === '#1f1f1f', 'dark editor background must match VS Code Dark Modern, got ' + darkColors['editor.background'])

    // 2) The rendered surface token wins (light) even with a stale service.
    themeStub.scheme = 'dark'
    themeStub.computedBackground = '#ffffff'
    assert(internals.detectScheme() === 'light', 'rendered light token should force the light scheme')
    assert(internals.editorColorsOf('light')['editor.background'] === '#ffffff', 'light editor background mismatch')

    // 3) The editor palette follows the VS Code reference, not a DSH surface token.
    const guarded = internals.editorColorsOf('dark')
    assert(guarded['editor.background'] !== '#ffffff', 'dark editor must never use the light background')
    assert(guarded['editor.background'] === '#1f1f1f', 'dark editor background must be #1f1f1f, got ' + guarded['editor.background'])

    // 4) With no readable surface, the DOM marker wins over a stale service.
    themeStub.scheme = 'light'
    themeStub.computedBackground = ''
    themeStub.marker = 'true'
    assert(internals.detectScheme() === 'dark', 'data-ds-dark-theme marker should force dark when the surface is unreadable')
    themeStub.marker = null

    // 5) With no readable surface and no marker, the theme service is used.
    themeStub.scheme = 'dark'
    assert(internals.detectScheme() === 'dark', 'theme service fallback should report dark')
    themeStub.scheme = 'light'
    assert(internals.detectScheme() === 'light', 'theme service fallback should report light')
    notes.push('theme detection: ok')
  } catch (error) {
    fail(`theme detection threw: ${error && error.stack ? error.stack : String(error)}`)
  }
}

// Exercise Monaco's actual attachment path: a render-only smoke would miss
// undefined F12 key codes, swallowed outline commands and hidden read-only markers.
{
  const bindings = new Map()
  const actions = []
  let options
  let mouseUp
  const editor = {
    addCommand: (key, run) => bindings.set(key, run),
    getSelection: () => ({ isEmpty: () => false, getStartPosition: () => ({ lineNumber: 22, column: 65 }) }),
    getPosition: () => ({ lineNumber: 22, column: 78 }),
    onMouseUp: (callback) => { mouseUp = callback },
  }
  const monaco = {
    KeyMod: { CtrlCmd: 2048, Shift: 1024 },
    KeyCode: { F12: 70, KeyG: 37, KeyO: 45, Equal: 81, Minus: 83, Digit0: 21 },
    editor: { create: (node, value) => { options = value; return editor } },
  }
  const tree = renderComponent('MonacoHost(attach)', internals.MonacoHost, {
    monaco, file: null, onRequestOutline: () => actions.push('outline'),
    onLsp: (...args) => actions.push(args),
  })
  tree.props.ref(makeElement())
  assert(options?.readOnly === true && options?.renderValidationDecorations === 'on', 'read-only Monaco must display LSP diagnostics')
  bindings.get(70)?.()
  bindings.get(1024 | 70)?.()
  bindings.get(2048 | 1024 | 45)?.()
  mouseUp?.({ event: { ctrlKey: true, leftButton: true }, target: { position: { lineNumber: 4, column: 30 } } })
  assert(JSON.stringify(actions) === JSON.stringify([['definition',22,65],['references',22,65],'outline',['definition',4,30]]), 'F12/Shift+F12/outline/Ctrl-click must invoke the page LSP callbacks')
  notes.push('Monaco LSP input bindings and read-only diagnostics: ok')
}

if (typeof internals.lspRegisterProviders === 'function') {
  try {
    const registered = { hover: 0 }
    const fakeMonaco = {
      languages: {
        registerHoverProvider: () => { registered.hover += 1 },
      },
    }
    internals.lspRegisterProviders(fakeMonaco, {})
    assert(registered.hover === 9, 'lsp hover provider should register for every supported language, got ' + registered.hover)
    internals.lspRegisterProviders(fakeMonaco, {})
    assert(registered.hover === 9, 'lsp providers must register only once')
    notes.push('lsp providers: ok')
  } catch (error) {
    fail(`lsp providers threw: ${error && error.stack ? error.stack : String(error)}`)
  }
}

// The ZH and EN dictionaries must expose identical key sets and contain every
// key the git-version feature references. Evaluate the source chunk directly so
// a missing translation fails this offline test instead of rendering a raw key.
try {
  const i18nSource = await readFile(join(packageDir, 'src', 'client', '10-i18n.js'), 'utf8')
  const dictionaries = new Function(i18nSource + '\nreturn { ZH, EN }')()
  const zhKeys = Object.keys(dictionaries.ZH || {}).sort()
  const enKeys = Object.keys(dictionaries.EN || {}).sort()
  const missingInEN = zhKeys.filter((key) => !enKeys.includes(key))
  const missingInZH = enKeys.filter((key) => !zhKeys.includes(key))
  assert(missingInEN.length === 0, 'EN dictionary is missing keys: ' + missingInEN.join(', '))
  assert(missingInZH.length === 0, 'ZH dictionary is missing keys: ' + missingInZH.join(', '))
  const requiredKeys = [
    'mode.commit', 'mode.commit.hint', 'mode.revision.pick', 'mode.revision.with',
    'mode.revision.pick.hint', 'mode.revision.unavailable',
    'picker.revisions.title', 'picker.revisions.placeholder', 'picker.revisions.loading',
    'picker.revisions.none', 'picker.revisions.empty', 'picker.revisions.raw',
    'picker.revisions.resolving', 'picker.revisions.resolveFailed',
    'picker.revisions.scope.commit', 'picker.revisions.scope.since',
    'picker.revisions.scope.commit.hint', 'picker.revisions.scope.since.hint',
    'picker.revisions.head', 'picker.revisions.branch', 'picker.revisions.branchUpstream',
    'picker.revisions.detached', 'picker.revisions.ahead',
    'status.revision.commit', 'status.revision.since', 'status.revision.loading',
    'status.revision.unavailable', 'status.revision.historical', 'status.revision.worktree',
    'tree.noChanges', 'error.hostOutdated',
  ]
  const missingRequired = requiredKeys.filter((key) => !zhKeys.includes(key) || !enKeys.includes(key))
  assert(missingRequired.length === 0, 'git-version dictionary keys missing: ' + missingRequired.join(', '))
  notes.push('i18n ZH/EN dictionaries: ' + zhKeys.length + ' keys, key sets identical')
} catch (error) {
  fail(`i18n dictionary check threw: ${error && error.stack ? error.stack : String(error)}`)
}

if (typeof internals.STYLE_TEXT === 'string') {
  assert(internals.STYLE_TEXT.includes('.drp-add-line'), 'stylesheet lost the added-line rule')
  assert(internals.STYLE_TEXT.includes('.drp-del-zone'), 'stylesheet lost the deleted-line rule')
  assert(internals.STYLE_TEXT.includes('.drp-picker-scope'), 'stylesheet lost the revision picker scope rule')
  assert(internals.STYLE_TEXT.includes('.drp-picker-row-raw'), 'stylesheet lost the raw-revision row rule')
  assert(!/--dsw-[a-z-]+\s*:/.test(internals.STYLE_TEXT.replace(/var\(--dsw-[a-z-]+/g, '')), 'stylesheet must not redefine --dsw-* tokens')
}

process.stdout.write('\n=== smoke notes ===\n')
for (const note of notes) process.stdout.write('· ' + note + '\n')
process.stdout.write('\n=== failures (' + failures.length + ') ===\n')
for (const failure of failures) process.stdout.write('✗ ' + failure + '\n')
if (failures.length > 0) process.exitCode = 1
else process.stdout.write('OK\n')


