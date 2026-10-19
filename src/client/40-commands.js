/* dsh-review-panel client half — official shortcuts registration and command dispatch. */

/**
 * Build one official shortcut binding.
 * @param {string} code physical key code
 * @param {string[]} [modifiers] logical modifiers
 * @returns {{code:string, modifiers:string[]}}
 */
function bindingOf(code, modifiers) {
  return { code, modifiers: modifiers || [] }
}

/**
 * Human-readable label for one shortcut binding in the active client profile.
 * @param {{code:string, modifiers:string[]}|undefined} binding binding
 * @returns {string}
 */
function formatBinding(binding, environment = shortcutEnvironment()) {
  if (!binding || !binding.code) return ''
  const parts = (binding.modifiers || []).map((modifier) => shortcutModifierLabel(modifier, environment))
  const keyOf = (code) => String(code)
    .replace(/^Key/, '')
    .replace(/^Digit/, '')
    .replace(/^Arrow/, '')
  const key = keyOf(binding.code) + (binding.secondCode ? '+' + keyOf(binding.secondCode) : '')
  return parts.concat(key).join('+')
}

/**
 * Effective registration outcome per plugin command id: `default` when the
 * declared key combination was accepted, `unbound` when the product rejected
 * it (the command is still registered but without a key), `failed` when even
 * the unbound registration failed. The in-page shortcut panel reports this so
 * a rejected default is visible instead of silently doing nothing.
 */
const SHORTCUT_STATUS = new Map()

/**
 * Shortcut rows for the in-page "快捷键" panel: the plugin command defaults
 * plus the editor-native keys this read-only view supports.
 * @param {(key:string) => string} t translator
 * @returns {Array<{id:string, label:() => string, hint:string}>}
 */
function buildKeyHelp(t) {
  const rows = []
  const environment = shortcutEnvironment()
  const profile = environment.runtime + ':' + environment.platform
  const primary = shortcutModifierLabel('primary', environment)
  const foldModifier = environment.platform === 'macos' ? shortcutModifierLabel('alt', environment) : 'Shift'
  const quickOpenBinding = COMMAND_SPECS.find((spec) => spec.id === 'quickOpen')?.defaults?.[profile]
    || COMMAND_SPECS.find((spec) => spec.id === 'quickOpenAlt')?.defaults?.[profile]
  const quickOpenLabel = formatBinding(quickOpenBinding, environment) || primary + '+P'
  for (const spec of COMMAND_SPECS) {
    const label = formatBinding(spec.defaults && spec.defaults[profile], environment)
    if (!label) continue
    const status = SHORTCUT_STATUS.get(spec.id)
    const suffix = status === 'unbound' ? t('keys.unbound') : status === 'failed' ? t('keys.failed') : ''
    rows.push({ id: 'k:' + spec.id, label: () => t(spec.message), hint: label + suffix })
  }
  rows.push(
    { id: 'k:find', label: () => '编辑器内查找', hint: primary + '+F' },
    { id: 'k:replace', label: () => '查找下一个', hint: primary + '+F → Enter' },
    { id: 'k:fold', label: () => '折叠 / 展开代码块', hint: primary + '+' + foldModifier + '+[ / ]' },
    { id: 'k:foldAll', label: () => '全部折叠 / 展开', hint: primary + '+K ' + primary + '+0 / ' + primary + '+K ' + primary + '+J' },
    { id: 'k:fontZoom', label: () => '字号增大 / 减小 / 重置', hint: 'Ctrl+滚轮 · ' + primary + '+= / - / 0' },
    { id: 'k:lspDefinition', label: () => '跳转到定义', hint: 'F12' },
    { id: 'k:lspReferences', label: () => '查找引用', hint: 'Shift+F12' },
    { id: 'k:lspHover', label: () => '悬停提示（类型/文档）', hint: '鼠标悬停' },
    { id: 'k:quickOpenCommands', label: () => '快速打开：输入 > 运行命令', hint: quickOpenLabel + ' 后输入 >' },
    { id: 'k:quickOpenLine', label: () => '快速打开：输入 : 跳转行', hint: quickOpenLabel + ' 后输入 :' },
  )
  return rows
}

/**
 * Command catalogue: single data source for official shortcuts (and later the
 * command palette). Linux declares allowed letter combinations; its reserved
 * function/arrow/tab keys and Web profiles stay available through buttons,
 * in-page fallback handlers, or explicit bindings in the official settings.
 */
const COMMAND_SPECS = [
  { id: 'openReview', message: 'cmd.openReview', regions: ['page', 'editable'], defaults: { 'desktop:windows': bindingOf('KeyD', ['primary', 'alt']), 'desktop:macos': bindingOf('KeyD', ['primary', 'alt']), 'desktop:linux': bindingOf('KeyD', ['primary', 'alt']) } },
  { id: 'nextChange', message: 'cmd.nextChange', regions: ['page', 'editable', 'terminal'], defaults: { 'desktop:windows': bindingOf('F7'), 'desktop:macos': bindingOf('F7') } },
  { id: 'prevChange', message: 'cmd.prevChange', regions: ['page', 'editable', 'terminal'], defaults: { 'desktop:windows': bindingOf('F7', ['shift']), 'desktop:macos': bindingOf('F7', ['shift']) } },
  { id: 'nextTab', message: 'cmd.nextTab', regions: ['page', 'editable'], defaults: { 'desktop:windows': bindingOf('Tab', ['primary']), 'desktop:macos': bindingOf('Tab', ['primary']) } },
  { id: 'prevTab', message: 'cmd.prevTab', regions: ['page', 'editable'], defaults: { 'desktop:windows': bindingOf('Tab', ['primary', 'shift']), 'desktop:macos': bindingOf('Tab', ['primary', 'shift']) } },
  { id: 'closeTab', message: 'cmd.closeTab', regions: ['page', 'editable'], defaults: { 'desktop:windows': bindingOf('F4', ['primary']), 'desktop:macos': bindingOf('F4', ['primary']) } },
  { id: 'navBack', message: 'cmd.navBack', regions: ['page'], defaults: {} },
  { id: 'navForward', message: 'cmd.navForward', regions: ['page'], defaults: {} },
  { id: 'toggleTree', message: 'cmd.toggleTree', regions: ['page', 'editable'], defaults: { 'desktop:windows': bindingOf('KeyE', ['primary', 'shift']), 'desktop:macos': bindingOf('KeyE', ['primary', 'shift']), 'desktop:linux': bindingOf('KeyE', ['primary', 'shift']) } },
  { id: 'refresh', message: 'cmd.refresh', regions: ['page', 'editable'], defaults: {} },
  { id: 'copyPath', message: 'cmd.copyPath', regions: ['page', 'editable'], defaults: {} },
  { id: 'officialReview', message: 'cmd.officialReview', regions: ['page', 'editable'], defaults: {} },
  { id: 'openInPreview', message: 'cmd.openInPreview', regions: ['page', 'editable'], defaults: {} },
  // VS Code–style pickers. Primary keys follow VS Code (Mod+P quick open,
  // Mod+Shift+P command palette, Mod+Shift+F search, Mod+G goto line); the
  // Mod+Alt+P variant stays as a fallback when the product owns Mod+P.
  // `editable` is included so the keys also work while the Monaco editor has
  // focus (none of these chords is a Monaco-native binding).
  { id: 'outline', message: 'cmd.outline', regions: ['page', 'editable'], defaults: { 'desktop:windows': bindingOf('KeyO', ['primary', 'shift']), 'desktop:macos': bindingOf('KeyO', ['primary', 'shift']), 'desktop:linux': bindingOf('KeyO', ['primary', 'shift']) } },
  { id: 'lspRecheck', message: 'lsp.recheck', regions: ['page', 'editable'], defaults: {} },
  { id: 'quickOpen', message: 'cmd.quickOpen', regions: ['page', 'editable'], defaults: { 'desktop:windows': bindingOf('KeyP', ['primary']), 'desktop:macos': bindingOf('KeyP', ['primary']) } },
  { id: 'quickOpenAlt', message: 'cmd.quickOpen', regions: ['page', 'editable'], defaults: { 'desktop:windows': bindingOf('KeyP', ['primary', 'alt']), 'desktop:macos': bindingOf('KeyP', ['primary', 'alt']), 'desktop:linux': bindingOf('KeyP', ['primary', 'alt']) } },
  { id: 'gotoLine', message: 'cmd.gotoLine', regions: ['page'], defaults: { 'desktop:windows': bindingOf('KeyG', ['primary']), 'desktop:macos': bindingOf('KeyG', ['primary']), 'desktop:linux': bindingOf('KeyG', ['primary']) } },
  { id: 'searchWorkspace', message: 'cmd.search', regions: ['page', 'editable'], defaults: { 'desktop:windows': bindingOf('KeyF', ['primary', 'shift']), 'desktop:macos': bindingOf('KeyF', ['primary', 'shift']), 'desktop:linux': bindingOf('KeyF', ['primary', 'shift']) } },
  { id: 'commandPalette', message: 'cmd.commands', regions: ['page', 'editable'], defaults: { 'desktop:windows': bindingOf('KeyP', ['primary', 'shift']), 'desktop:macos': bindingOf('KeyP', ['primary', 'shift']), 'desktop:linux': bindingOf('KeyP', ['primary', 'shift']) } },
]

/**
 * Run one plugin command against the mounted page, or the global open action.
 * @param {string} id command id (without the plugin prefix)
 * @returns {boolean} whether something ran
 */
function runCommand(id) {
  if (id === 'openReview') return openReviewFromChat()
  const page = runtimeState.page
  if (!page) return false
  return page.command(id)
}

/**
 * Open the review tab for the last known session (global command).
 * @returns {boolean} whether the open call was issued
 */
function openReviewFromChat() {
  const sessionId = runtimeState.sessionId
  if (!sessionId) return false
  const ok = openResourceSafe(runtimeState.right, ADDRESS_PREFIX + encodeURIComponent(sessionId))
  if (!ok) log('warn', 'openReview: sidebarRight unavailable')
  return ok
}

/**
 * Command-specific visibility rules: only claim a key when this plugin's page
 * (or the global open action) is the right target.
 * @param {string} id command id
 * @param {any} context official shortcut invoke context
 * @returns {{status:'handled',run:Function}|{status:'pass'}}
 */
function resolveCommand(id, context) {
  if (context && context.modal !== null && context.modal !== undefined) return { status: 'pass' }
  if (id === 'openReview') {
    if (!runtimeState.sessionId) return { status: 'pass' }
    return { status: 'handled', run: () => { runCommand('openReview') } }
  }
  const page = runtimeState.page
  if (!page) return { status: 'pass' }
  const target = context && context.target
  if (target && !page.contains(target)) return { status: 'pass' }
  return { status: 'handled', run: () => { runCommand(id) } }
}

/**
 * Register one command, downgrading to an unbound command when its default
 * combination is rejected (duplicate id / reserved / conflicting defaults).
 * @param {any} service official shortcuts service
 * @param {object} spec command spec
 * @param {Function} t locale-bound translator
 * @returns {() => void} disposer
 */
function safeRegisterCommand(service, spec, t) {
  const command = {
    id: 'dsh-review-panel.' + spec.id,
    label: () => t(spec.message),
    aliases: [],
    defaults: spec.defaults,
    regions: spec.regions,
    modals: [],
    resolve: (context) => resolveCommand(spec.id, context),
  }
  try {
    const dispose = service.register(command)
    SHORTCUT_STATUS.set(spec.id, 'default')
    return dispose
  } catch (error) {
    log('warn', 'shortcut default rejected, registering unbound:', command.id, String(error))
    try {
      const dispose = service.register(Object.assign({}, command, { defaults: {} }))
      SHORTCUT_STATUS.set(spec.id, 'unbound')
      return dispose
    } catch (retryError) {
      log('warn', 'shortcut registration failed:', command.id, String(retryError))
      SHORTCUT_STATUS.set(spec.id, 'failed')
      return () => {}
    }
  }
}

/**
 * Detect the optional official shortcuts service with a bounded retry, then
 * register the whole catalog exactly once.
 * @param {object} ctx client plugin context
 * @param {Function} t locale-bound translator
 * @returns {() => void} cancel/dispose
 */
function installOfficialShortcuts(ctx, t) {
  let stopped = false
  let timer = null
  let attempts = 0
  let registered = []

  const register = (service) => {
    if (stopped) return
    for (const spec of COMMAND_SPECS) {
      try {
        const dispose = safeRegisterCommand(service, spec, t)
        registered.push(dispose)
      } catch (error) {
        log('warn', 'shortcut setup failed', spec.id, String(error))
      }
    }
    log('log', 'official shortcuts registered:', COMMAND_SPECS.length)
  }

  const timerTick = () => {
    if (stopped) return
    let service
    try {
      service = safeGet(ctx, 'shortcuts')
    } catch (error) {
      service = undefined
    }
    if (service && typeof service.register === 'function' && service.catalog && service.config) {
      register(service)
      return
    }
    if (attempts >= 15) {
      log('warn', 'official shortcuts service unavailable; plugin commands stay unbound')
      return
    }
    attempts += 1
    timer = setTimeout(timerTick, 2000)
  }
  timerTick()

  return () => {
    stopped = true
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    for (const dispose of registered) {
      try {
        dispose()
      } catch (error) { /* ignore */ }
    }
    registered = []
  }
}
