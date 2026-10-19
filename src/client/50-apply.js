/* dsh-review-panel client half — registration entry. */

/** Cordis client services required for registration; optional services are probed. */
const inject = ['slots', 'locale']

/**
 * Register the plugin's client service catalog: styles, dictionaries, the
 * composer pill, official shortcuts, and the right-sidebar tab type with its
 * body (or the degraded central view when the sidebar services are absent).
 * @param {object} ctx client plugin context
 */
function apply(ctx) {
  globalCtxRef.current = ctx
  ctx.effect(() => () => lspDispose(), 'dsh-review-panel: client LSP lifecycle')

  // Optional theme service (snapshot source; DOM markers remain the fallback).
  try {
    themeRuntime.service = safeGet(ctx, 'theme')
  } catch (error) {
    themeRuntime.service = undefined
  }
  themeRuntime.scheme = detectScheme()

  // Optional conversation service: its per-session binding's `openTurn` source
  // is the precise "turn closed" signal (used by the pill and the page).
  runtimeState.conversation = safeGet(ctx, 'uiConversation')

  // Plugin-owned stylesheet, cleaned up with the client run.
  ctx.effect(() => {
    const element = document.createElement('style')
    element.setAttribute('data-dsh-review-panel', '1')
    element.textContent = STYLE_TEXT
    document.head.appendChild(element)
    return () => {
      try { element.remove() } catch (error) { /* ignore */ }
    }
  }, 'dsh-review-panel: styles')

  // VS Code Seti icon font (embedded woff from the generated icon theme asset).
  ctx.effect(() => {
    const css = typeof VSCODE_ICON_THEME !== 'undefined' && VSCODE_ICON_THEME.fontFaceCss
    if (!css) return undefined
    const element = document.createElement('style')
    element.setAttribute('data-dsh-review-panel-icons', '1')
    element.textContent = css
    document.head.appendChild(element)
    return () => {
      try { element.remove() } catch (error) { /* ignore */ }
    }
  }, 'dsh-review-panel: icon font')

  // Dictionaries follow the DSH language; there is no plugin-local override.
  ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'dsh-review-panel: dictionaries')
  let t
  try {
    t = ctx.locale.bind(NS)
  } catch (error) {
    t = (key) => key
  }

  // Composer pill (registered independently of the sidebar; it degrades to an
  // inline error if the review tab cannot be opened).
  try {
    ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
      name: 'conversation.input.dock',
      id: 'review-panel-pill',
      order: 30,
      locale: NS,
    }, ChangesPill))
  } catch (error) {
    log('warn', 'composer pill registration failed', error)
  }

  // Official shortcuts (optional service; bounded probe inside).
  ctx.effect(() => installOfficialShortcuts(ctx, t), 'dsh-review-panel: shortcuts')

  // Primary container: the official right sidebar's new tab type.
  mountContainer(ctx, t)
}

/**
 * Register the resource tab type and its body on the official right sidebar.
 * @param {object} ctx client plugin context
 * @param {Function} t locale-bound translator
 * @param {{ register: Function }} tabs sidebarRightTabs service
 */
function registerSidebarTab(ctx, t, tabs) {
  ctx.effect(() => {
    const dispose = tabs.register({
      id: TAB_ID,
      kind: TAB_KIND,
      patterns: ['dsh-resource://review-panel/**'],
      priority: 'extension',
      // Resource opens use our addresses; the sidebar guide opens the page type
      // by kind, whose composed address is `sidebar://<kind>` (format is the
      // sidebar's own; accept any `sidebar://` page address since a named kind
      // is the only way this type is asked to open one).
      canOpen: (address) => typeof address === 'string'
        && (address.startsWith(ADDRESS_PREFIX) || address.startsWith('sidebar://')),
      title: () => t('tab.title'),
      // Advertise the page in the sidebar's guide ("+") so it is always reachable,
      // even before the first turn with changes exists.
      guide: [{
        id: TAB_ID,
        order: 20,
        kind: TAB_KIND,
        title: () => t('tab.title'),
        description: () => t('tab.description'),
      }],
    })
    return () => {
      try { dispose() } catch (error) { /* ignore */ }
    }
  }, 'dsh-review-panel: tab type')

  try {
    ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab',
      key: TAB_ID,
      locale: NS,
      inject: () => ({
        services: { right: runtimeState.right, tabs: runtimeState.tabs },
      }),
    }, ReviewTabBody))
  } catch (error) {
    log('error', 'sidebar tab body registration failed', error)
  }
}

/**
 * Degraded container: a central Conversation view tab with the same page.
 * @param {object} ctx client plugin context
 * @param {Function} t locale-bound translator
 * @param {any} right sidebarRight controller (may be undefined)
 */
function registerFallbackView(ctx, t, right) {
  runtimeState.right = right
  try {
    ctx.slots.inject('conversation.view', () => ctx.slots.register({
      name: 'conversation.view',
      id: 'review-panel-view',
      order: 50,
      label: () => t('tab.title'),
      locale: NS,
      inject: () => ({ services: { right: runtimeState.right } }),
    }, ReviewViewBody))
    log('warn', 'right sidebar services unavailable; registered the fallback conversation view')
  } catch (error) {
    log('error', 'fallback conversation view registration failed', error)
  }
}

/**
 * Probe the optional right-sidebar services with a bounded retry, then mount the
 * primary container (falling back to the central view after ~10s).
 * @param {object} ctx client plugin context
 * @param {Function} t locale-bound translator
 */
function mountContainer(ctx, t) {
  let stopped = false
  let timer = null
  let attempts = 0
  ctx.effect(() => () => {
    stopped = true
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }, 'dsh-review-panel: container probe')

  const tick = () => {
    if (stopped) return
    const tabs = safeGet(ctx, 'sidebarRightTabs')
    const right = safeGet(ctx, 'sidebarRight')
    const ready = tabs && typeof tabs.register === 'function' && right && typeof right.openResource === 'function'
    if (ready) {
      runtimeState.tabs = tabs
      runtimeState.right = right
      try {
        registerSidebarTab(ctx, t, tabs)
        log('log', 'review tab registered on the official right sidebar')
      } catch (error) {
        log('error', 'right sidebar tab registration failed', error)
        registerFallbackView(ctx, t, right)
      }
      return
    }
    if (attempts >= 20) {
      registerFallbackView(ctx, t, right)
      return
    }
    attempts += 1
    timer = setTimeout(tick, 500)
  }
  tick()
}

/**
 * Open the review tab for a session (used by the composer pill and commands).
 * @param {string} sessionId session identity
 * @returns {boolean} whether the resource open was issued
 */
function openReviewPage(sessionId) {
  if (!sessionId) return false
  runtimeState.sessionId = sessionId
  return openResourceSafe(runtimeState.right, ADDRESS_PREFIX + encodeURIComponent(sessionId))
}
