/* dsh-review-panel client half — language-server features (Phase 3). */

/**
 * Runtime binding for the active editor document. The vendored Monaco runs
 * without a file system, so providers read this record instead of the model URI.
 */
const lspRuntime = {
  sessionId: null,
  cwd: null,
  path: null,
  text: null,
  languageId: null,
  monaco: null,
  model: null,
  host: null,
  // Historical (= git revision) content: navigation/hover keep working against
  // the overlaid text, but diagnostics are suppressed because the server would
  // mix that snapshot with the current worktree project.
  historical: false,
  missing: null,
  registered: false,
  unsupported: null,
  diagnosticsTimer: null,
  diagnosticsPollId: 0,
  diagnosticsVisibility: null,
  diagOpenedAt: 0,
  diagLastSignature: null,
  diagStableCount: 0,
  builtinValidationDisabled: false,
  generation: 0,
  dismissed: new Set(),
  providers: [],
  navigationId: 0,
}

/** Preserve absolute-path identity until containment has been checked. */
function workspaceLocationPath(raw, cwd = lspRuntime.cwd) {
  let path = String(raw || '').replace(/\\/g, '/')
  if (/^file:\/\//i.test(path)) {
    try {
      const uri = new URL(path)
      path = decodeURIComponent(uri.pathname)
      if (uri.hostname && uri.hostname !== 'localhost') path = '//' + uri.hostname + path
      else if (/^\/[a-z]:\//i.test(path)) path = path.slice(1)
    } catch { return null }
  }
  const rawRoot = String(cwd || '').replace(/\\/g, '/')
  const root = rawRoot.replace(/\/+$/, '') || (rawRoot.startsWith('/') ? '/' : '')
  const windows = /^[a-z]:\//i.test(rawRoot) || rawRoot.startsWith('//')
  const key = (value) => windows ? value.toLowerCase() : value
  if (/^(?:[a-z]:|\/)/i.test(path)) {
    const prefix = root.endsWith('/') ? root : root + '/'
    if (!root || !key(path).startsWith(key(prefix))) return null
    path = path.slice(prefix.length)
  }
  path = path.replace(/^\.\//, '')
  if (!path || /[:\x00-\x1f]/.test(path) || path.split('/').some((part) => !part || part === '..' || part === '.')) return null
  return path
}

/** A selection's start belongs to the selected symbol; its end may not. */
function lspPosition(editor) {
  const selection = editor?.getSelection?.()
  return selection && !selection.isEmpty() ? selection.getStartPosition() : editor?.getPosition?.()
}

function lspForgetMissing() {
  if (lspRuntime.missing) lspRuntime.dismissed.add(lspRuntime.missing.language)
  lspRuntime.missing = null
}

async function lspCheckAvailability(refresh = false) {
  const generation = lspRuntime.generation
  if (refresh) {
    lspRuntime.dismissed.delete(lspRuntime.languageId)
    lspRuntime.missing = null
  }
  const response = await lspRequest('status', { refresh })
  if (generation !== lspRuntime.generation) return response
  if (response.available) {
    lspRuntime.missing = null
    lspRuntime.host?.onMissing?.(null)
    if (refresh) scheduleLspDiagnostics()
  } else if (response.reason === 'missing-server') noteLspUnavailable(response)
  if (refresh) lspRuntime.host?.notify?.(response.available ? '语言服务器已就绪' : lspFailureMessage(response, '语言服务器尚未就绪'), response.available ? 'info' : 'warn')
  return response
}

async function lspDiagnostics() {
  const response = await lspCheckAvailability()
  return [
    '语言：' + (lspRuntime.languageId || '—'),
    '文件：' + (lspRuntime.path || '—'),
    response.available ? '服务器：' + response.server : lspFailureMessage(response, '状态：' + response.reason),
  ]
}

function lspClearDocument(model) {
  if (model && model !== lspRuntime.model) return
  stopLspDiagnostics()
  clearLspMarkers()
  lspRuntime.generation += 1
  lspRuntime.model = null
  lspRuntime.path = null
  lspRuntime.text = null
  lspRuntime.historical = false
}

function lspDispose() {
  lspClearDocument()
  if (lspRuntime.diagnosticsVisibility && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', lspRuntime.diagnosticsVisibility)
    lspRuntime.diagnosticsVisibility = null
  }
  for (const provider of lspRuntime.providers) { try { provider?.dispose?.() } catch { /* already disposed */ } }
  lspRuntime.providers = []
  lspRuntime.registered = false
  lspRuntime.host = null
}

/**
 * Resolve the official composer input facade for one session.
 *
 * DSH exposes the composer only through `ctx.get('conversation').input.for(...)`
 * (the same path the product's own UI uses); there is no standalone input
 * service in the client Service catalog.
 * @param {string} sessionId session id
 * @returns {any | null} composer shell (setDraft / insertText / submit) or null
 */
function composerFor(sessionId) {
  try {
    const ctx = globalCtxRef.current
    if (!ctx || !sessionId) return null
    const sessions = safeGet(ctx, 'sessions')
    const conversation = safeGet(ctx, 'conversation')
    const actx = sessions && typeof sessions.scope === 'function' ? sessions.scope(sessionId) : undefined
    const input = conversation && conversation.input && typeof conversation.input.for === 'function'
      ? conversation.input.for(actx)
      : undefined
    return input || null
  } catch (error) {
    return null
  }
}

/**
 * Hand the install request to the Agent: fill the composer draft and submit it
 * (one explicit click is the confirmation, so nothing installs silently).
 * @param {string} install install command
 * @param {string} language language label
 * @returns {Promise<'sent'|'draft'|null>} how far the request got
 */
async function lspAskAgentToInstall(install, language) {
  if (!install || !language) return null
  const prompt = '请在这个工作区安装并配置 ' + language + ' 语言服务器（用于代码审查页的跳转定义/查找引用/悬停提示/诊断）：' + install + '。安装完成后告诉我如何验证。'
  const shell = composerFor(lspRuntime.sessionId)
  try {
    if (shell && typeof shell.setDraft === 'function') {
      await shell.setDraft(prompt)
      if (typeof shell.submit === 'function') {
        await shell.submit()
        return 'sent'
      }
      return 'draft'
    }
    if (shell && typeof shell.insertText === 'function') {
      await shell.insertText(prompt, null)
      if (typeof shell.submit === 'function') {
        await shell.submit()
        return 'sent'
      }
      return 'draft'
    }
  } catch (error) {
    /* fall back to the clipboard in the caller */
  }
  return null
}

/**
 * Put a language-server install request into the chat composer draft.
 * Fallback for when the composer cannot submit directly.
 * @param {string} install install command
 * @param {string} language language label
 * @returns {'draft'|'insert'|null} how the request was inserted
 */
function lspInsertInstallRequest(install, language) {
  if (!install || !language) return null
  const prompt = '请在这个工作区安装并配置 ' + language + ' 语言服务器（用于代码审查页的跳转定义/查找引用/悬停提示/诊断）：' + install + '。安装完成后告诉我如何验证。'
  const shell = composerFor(lspRuntime.sessionId)
  try {
    if (shell && typeof shell.setDraft === 'function') {
      shell.setDraft(prompt)
      return 'draft'
    }
    if (shell && typeof shell.insertText === 'function') {
      shell.insertText(prompt, null)
      return 'insert'
    }
  } catch (error) {
    /* fall back to the clipboard */
  }
  return null
}

/** Languages whose servers this build can talk to. */
const LSP_LANGUAGES = [
  'typescript',
  'javascript',
  'typescriptreact',
  'javascriptreact',
  'python',
  'json',
  'jsonc',
  'go',
  'rust',
]

/**
 * One LSP action through the Host bridge.
 * @param {string} action action name
 * @param {object} payload extra fields
 * @returns {Promise<any>}
 */
async function lspRequest(action, payload) {
  if (!lspRuntime.sessionId) return { available: false, reason: 'no-session' }
  if (action !== 'status' && !lspRuntime.model) return { available: false, reason: 'no-document' }
  try {
    const response = await apiPost('lsp', {
      sessionId: lspRuntime.sessionId,
      action,
      path: lspRuntime.path,
      text: lspRuntime.text,
      languageId: lspRuntime.languageId,
      ...(payload || {}),
    })
    if (!response || typeof response !== 'object') return { available: false, reason: 'transport-error' }
    if (response.error) return { available: false, reason: 'host-stale', message: String(response.error.message || '') }
    return response
  } catch (error) {
    return { available: false, reason: 'transport-error', message: String(error && error.message ? error.message : error) }
  }
}

/**
 * User-facing explanation for a failed LSP response: distinguishes a stale Host
 * (route missing until DSH restarts) from "no server installed" and a missing
 * page session, so a silent failure never looks like "nothing found".
 * @param {any} response LSP response
 * @param {string} fallback generic message
 * @returns {string}
 */
function lspFailureMessage(response, fallback) {
  if (!response) return fallback
  if (response.reason === 'no-session') return '当前页面没有会话上下文，无法查询语言服务器'
  if (response.reason === 'no-document') return '请先打开代码文件并选中要查询的符号'
  if (response.reason === 'host-stale' || response.reason === 'transport-error') {
    return '语言服务器接口不可用：请重启 DSH 以加载最新插件 Host 端（新增了 LSP 路由）'
  }
  if (response.message) return fallback + '：' + String(response.message)
  return fallback
}

/**
 * Remember the active document (called whenever the Monaco model changes).
 * Historical (git revision) content is a first-class document for navigation:
 * the Host bridge overlays the shown text, so F12 / references / hover / symbols
 * work against the snapshot. Diagnostics stay off there (see `historical`).
 * @param {object} info document facts plus page callbacks
 */
function lspSetDocument(info) {
  const historical = info.historical === true
  const wasHistorical = lspRuntime.historical
  const changed = lspRuntime.sessionId !== info.sessionId || lspRuntime.cwd !== info.cwd || lspRuntime.languageId !== info.languageId || lspRuntime.model !== info.model || lspRuntime.path !== info.path || lspRuntime.text !== info.text
  if (lspRuntime.languageId !== info.languageId) {
    lspRuntime.missing = null
    lspRuntime.host?.onMissing?.(null)
  }
  if (changed) { clearLspMarkers(); lspRuntime.generation += 1 }
  lspRuntime.sessionId = info.sessionId
  lspRuntime.cwd = info.cwd
  lspRuntime.path = info.path
  lspRuntime.text = info.text
  lspRuntime.languageId = info.languageId
  lspRuntime.monaco = info.monaco
  lspRuntime.model = info.model
  lspRuntime.historical = historical
  if (historical) {
    // A historical snapshot is never mixed with the worktree project for
    // diagnostics; navigation still uses the overlaid document text.
    stopLspDiagnostics()
    clearLspMarkers()
  }
  if (changed) {
    lspRuntime.diagOpenedAt = Date.now()
    lspRuntime.diagLastSignature = null
    lspRuntime.diagStableCount = 0
    clearLspMarkers()
    clearForeignDiagnosticMarkers(info.monaco, info.model)
    disableBuiltinTsValidation(info.monaco)
    if (!historical) scheduleLspDiagnostics()
    return
  }
  // Same text/model but the snapshot kind changed (e.g. a commit version whose
  // content equals the worktree): re-arm polling only when leaving historical.
  if (wasHistorical && !historical) {
    stopLspDiagnostics()
    scheduleLspDiagnostics()
  }
}

/**
 * Turn off the Monaco built-in TypeScript/JavaScript worker validation. Those
 * workers run without the project's tsconfig and are the source of the
 * "foreign" markers that VS Code never shows (the user reported e.g. a
 * moduleResolution 2792 hover that this page's own bridge cannot produce).
 * The plugin's language-server markers (`dsh-lsp`) stay the single source.
 * @param {any} monaco Monaco namespace
 */
function disableBuiltinTsValidation(monaco) {
  if (lspRuntime.builtinValidationDisabled) return
  try {
    const languages = monaco && monaco.languages && monaco.languages.typescript
    if (!languages) return
    const options = { noSemanticValidation: true, noSyntaxValidation: true, noSuggestionDiagnostics: true }
    if (languages.typescriptDefaults && typeof languages.typescriptDefaults.setDiagnosticsOptions === 'function') {
      languages.typescriptDefaults.setDiagnosticsOptions(options)
    }
    if (languages.javascriptDefaults && typeof languages.javascriptDefaults.setDiagnosticsOptions === 'function') {
      languages.javascriptDefaults.setDiagnosticsOptions(options)
    }
    lspRuntime.builtinValidationDisabled = true
  } catch (error) { /* validation settings are best-effort */ }
}

/**
 * Drop markers owned by anything other than this bridge on a plugin model
 * (defensive: a stale foreign provider marker would survive model switches).
 * @param {any} monaco Monaco namespace
 * @param {any} model Monaco text model
 */
function clearForeignDiagnosticMarkers(monaco, model) {
  try {
    if (!monaco || !model || !monaco.editor || typeof monaco.editor.getModelMarkers !== 'function') return
    const markers = monaco.editor.getModelMarkers({ resource: model.uri })
    const owners = new Set()
    for (const marker of markers) {
      if (marker && marker.owner && marker.owner !== 'dsh-lsp') owners.add(marker.owner)
    }
    for (const owner of owners) monaco.editor.setModelMarkers(model, owner, [])
  } catch (error) { /* markers are best-effort */ }
}

/** Clear Monaco diagnostics markers on the active model. */
function clearLspMarkers() {
  try {
    if (lspRuntime.monaco && lspRuntime.model) {
      lspRuntime.monaco.editor.setModelMarkers(lspRuntime.model, 'dsh-lsp', [])
    }
  } catch (error) { /* markers are best-effort */ }
}

/**
 * Report a missing language server to the page once per language.
 * @param {any} response LSP response
 * @returns {boolean} whether the response means "server not installed"
 */
function noteLspUnavailable(response) {
  if (!response || response.available !== false) return false
  const language = response.language || lspRuntime.languageId
  if (response.reason === 'unsupported-language') {
    if (!lspRuntime.unsupported) lspRuntime.unsupported = new Set()
    if (lspRuntime.unsupported.has(language)) return true
    lspRuntime.unsupported.add(language)
    try { lspRuntime.host?.onUnsupported?.(language) } catch (error) { /* ignore */ }
    return true
  }
  if (response.reason !== 'missing-server') return false
  const install = response.install || ''
  if (!install) return false
  if (lspRuntime.dismissed.has(language)) return true
  const next = { language, install }
  if (lspRuntime.missing && lspRuntime.missing.language === next.language) return true
  lspRuntime.missing = next
  try { lspRuntime.host?.onMissing?.(next) } catch (error) { /* ignore */ }
  return true
}

/** Diagnostics settle window (ms): never paint before the server had time to
 * load the project and replace the early syntax/semantic snapshots. */
const LSP_DIAG_SETTLE_MS = 3500
/** Poll quickly during project startup, then back off to one request per 5 s. */
const LSP_DIAG_FAST_ATTEMPTS = 16
const LSP_DIAG_IDLE_MS = 5000

/** Cancel the timer and invalidate any response that is still in flight. */
function stopLspDiagnostics() {
  clearTimeout(lspRuntime.diagnosticsTimer)
  lspRuntime.diagnosticsTimer = null
  lspRuntime.diagnosticsPollId += 1
}

function lspDiagnosticsVisible() {
  return typeof document === 'undefined' || !document.hidden
}

/** Poll diagnostics shortly after the document changed. */
function scheduleLspDiagnostics(attempt = 0, pollId) {
  // Historical snapshots never publish diagnostics (see `lspRuntime.historical`).
  if (lspRuntime.historical) return
  if (pollId === undefined) {
    stopLspDiagnostics()
    pollId = lspRuntime.diagnosticsPollId
  }
  if (!lspRuntime.diagnosticsVisibility && typeof document !== 'undefined') {
    lspRuntime.diagnosticsVisibility = () => {
      stopLspDiagnostics()
      if (lspDiagnosticsVisible()) scheduleLspDiagnostics()
    }
    document.addEventListener('visibilitychange', lspRuntime.diagnosticsVisibility)
  }
  if (!lspRuntime.model || !lspRuntime.sessionId || !lspDiagnosticsVisible() || pollId !== lspRuntime.diagnosticsPollId) return
  clearTimeout(lspRuntime.diagnosticsTimer)
  const delay = attempt === 0 ? 300 : attempt <= LSP_DIAG_FAST_ATTEMPTS ? 700
    : Math.min(LSP_DIAG_IDLE_MS, 700 * 2 ** Math.min(4, attempt - LSP_DIAG_FAST_ATTEMPTS))
  lspRuntime.diagnosticsTimer = setTimeout(() => {
    lspRuntime.diagnosticsTimer = null
    void refreshLspDiagnostics(attempt, pollId)
  }, delay)
}

/** Fetch diagnostics and publish them as Monaco markers. */
async function refreshLspDiagnostics(attempt = 0, pollId = lspRuntime.diagnosticsPollId) {
  if (lspRuntime.historical) return
  if (!lspRuntime.sessionId || !lspRuntime.model || !lspDiagnosticsVisible() || pollId !== lspRuntime.diagnosticsPollId) return
  const model = lspRuntime.model
  const generation = lspRuntime.generation
  try {
    const response = await lspRequest('diagnostics', {})
    if (model !== lspRuntime.model || generation !== lspRuntime.generation || pollId !== lspRuntime.diagnosticsPollId || !lspDiagnosticsVisible()) return
    if (!response || response.available !== true) {
      noteLspUnavailable(response)
      // Missing/unsupported servers need an explicit retry or a new document.
      // Transient transport/process failures may recover during a visible view.
      if (!['missing-server', 'unsupported-language', 'no-session', 'no-document', 'disposed'].includes(response?.reason)) {
        scheduleLspDiagnostics(Math.max(attempt + 1, LSP_DIAG_FAST_ATTEMPTS + 3), pollId)
      }
      return
    }
    scheduleLspDiagnostics(attempt + 1, pollId)
    // The bridge returns `pending` while the server has not yet published a
    // snapshot for the opened document version. Never paint in that state.
    if (response.pending === true) {
      lspRuntime.diagLastSignature = null
      lspRuntime.diagStableCount = 0
      return
    }
    const list = Array.isArray(response.diagnostics) ? response.diagnostics : []
    const signature = JSON.stringify(list)
    if (signature === lspRuntime.diagLastSignature) lspRuntime.diagStableCount += 1
    else {
      lspRuntime.diagLastSignature = signature
      lspRuntime.diagStableCount = 1
    }
    const settled = Date.now() - (lspRuntime.diagOpenedAt || 0) >= LSP_DIAG_SETTLE_MS
    const stable = lspRuntime.diagStableCount >= 2
    // Paint only a snapshot that had time to settle and did not change between
    // two polls; the very first false snapshot (or an empty syntax snapshot) is
    // therefore never shown, and a late correct snapshot still clears anything.
    if (!settled || !stable) return
    const markers = list.map((diagnostic) => ({
      severity: diagnostic.severity === 1 ? 8 : diagnostic.severity === 2 ? 4 : 2,
      message: diagnostic.message + (diagnostic.source ? ' (' + diagnostic.source + ')' : ''),
      startLineNumber: diagnostic.line,
      startColumn: diagnostic.column,
      endLineNumber: diagnostic.endLine,
      endColumn: diagnostic.endColumn,
    }))
    lspRuntime.markers = markers
    try { lspRuntime.monaco.editor.setModelMarkers(model, 'dsh-lsp', markers) } catch (error) { /* ignore */ }
  } catch (error) {
    if (model === lspRuntime.model && generation === lspRuntime.generation && pollId === lspRuntime.diagnosticsPollId) {
      scheduleLspDiagnostics(Math.max(attempt + 1, LSP_DIAG_FAST_ATTEMPTS + 3), pollId)
    }
  }
}

/**
 * Go-to-definition (F12) for the active document.
 * @param {number} line 1-based line
 * @param {number} column 1-based column
 * @returns {Promise<boolean>} whether a location was opened
 */
async function lspDefinition(line, column) {
  if (!lspRuntime.host) { lspRuntime.host?.notify?.('LSP 未初始化：页面还没准备好，请重新打开本页', 'warn'); return false }
  const generation = lspRuntime.generation
  const navigationId = ++lspRuntime.navigationId
  const response = await lspRequest('definition', { line, column })
  if (generation !== lspRuntime.generation || navigationId !== lspRuntime.navigationId) return false
  if (noteLspUnavailable(response)) return false
  const host = lspRuntime.host
  if (!response || response.available !== true) {
    host?.notify?.(lspFailureMessage(response, '未找到定义（语言服务器不可用）'), 'warn')
    return false
  }
  const all = response.locations || []
  const locations = all.map((location) => ({ ...location, path: workspaceLocationPath(location.path) })).filter((location) => location.path)
  if (locations.length === 0) {
    if (all.length > 0) {
      host?.notify?.('定义在工作区外的文件：' + all[0].path + ':' + all[0].line + '（本页只能打开工作区内的文件）', 'info')
    } else {
      host?.notify?.('未找到定义（该符号可能来自内置库/依赖，或项目依赖未安装）', 'info')
    }
    return false
  }
  if (locations.length > 1) host?.showLocations?.(locations, 'definitions')
  else host?.openLocation?.(locations[0].path, locations[0].line, locations[0].column, locations[0])
  return true
}

/**
 * Find references (Shift+F12) and list them through the page picker.
 * @param {number} line 1-based line
 * @param {number} column 1-based column
 * @returns {Promise<boolean>} whether any reference was found
 */
async function lspReferences(line, column) {
  if (!lspRuntime.host) { lspRuntime.host?.notify?.('LSP 未初始化：页面还没准备好，请重新打开本页', 'warn'); return false }
  const generation = lspRuntime.generation
  const navigationId = ++lspRuntime.navigationId
  const response = await lspRequest('references', { line, column })
  if (generation !== lspRuntime.generation || navigationId !== lspRuntime.navigationId) return false
  if (noteLspUnavailable(response)) return false
  const host = lspRuntime.host
  if (!response || response.available !== true) {
    host?.notify?.(lspFailureMessage(response, '查找引用失败（语言服务器不可用）'), 'warn')
    return false
  }
  const all = response.locations || []
  const locations = all.map((location) => ({ ...location, path: workspaceLocationPath(location.path) })).filter((location) => location.path)
  if (locations.length === 0) {
    if (all.length > 0) host?.notify?.('找到 ' + all.length + ' 处引用，但都在工作区外（库/依赖），本页无法定位', 'info')
    else host?.notify?.('没有找到引用', 'info')
    return false
  }
  host?.showLocations?.(locations)
  return true
}

/**
 * Fetch the document outline for the picker.
 * @returns {Promise<Array<object>>}
 */
async function lspSymbols() {
  const generation = lspRuntime.generation
  const response = await lspRequest('symbols', {})
  if (generation !== lspRuntime.generation) return []
  if (noteLspUnavailable(response)) return []
  if (!response || response.available !== true) return []
  return Array.isArray(response.symbols) ? response.symbols : []
}

/**
 * Register a hover provider for every supported language.
 * @param {any} monaco Monaco namespace
 * @param {object} host page callbacks (`notify`, `onMissing`, `openLocation`, `showLocations`)
 */
function lspRegisterProviders(monaco, host) {
  lspRuntime.host = host
  disableBuiltinTsValidation(monaco)
  if (!monaco || lspRuntime.registered) return
  lspRuntime.registered = true
  for (const language of LSP_LANGUAGES) {
    try {
      const provider = monaco.languages.registerHoverProvider(language, {
        async provideHover(model, position) {
          if (!lspRuntime.sessionId || model !== lspRuntime.model) return null
          try {
            const generation = lspRuntime.generation
            const response = await lspRequest('hover', { line: position.lineNumber, column: position.column })
            if (generation !== lspRuntime.generation) return null
            if (!response || response.available !== true || !response.contents) return null
            return { contents: [{ value: String(response.contents) }] }
          } catch {
            return null
          }
        },
      })
      lspRuntime.providers.push(provider)
    } catch (error) { /* ignore */ }
  }
}
