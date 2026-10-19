/* dsh-review-panel client half — composer pill ("本轮修改"). */

/**
 * Composer-dock entry: shows the latest turn's changed-file count and opens the
 * review tab. Refreshes when the running turn settles, when the conversation
 * binding closes its open turn, and when the window regains focus (no polling).
 * @param {object} props slot props (`sessionId`, owner props `session`)
 * @returns {any} React element or null when there is nothing to show
 */
function ChangesPill(props) {
  const { sessionId, session, t } = props
  const running = session && typeof session.running === 'boolean' ? session.running : undefined
  const [latest, setLatest] = React.useState(null)
  const [error, setError] = React.useState(null)
  const tokenRef = React.useRef(0)
  const lastLoadRef = React.useRef(0)
  const retryTimerRef = React.useRef(null)

  const load = React.useCallback(async (options) => {
    if (!sessionId) return
    const token = ++tokenRef.current
    lastLoadRef.current = Date.now()
    try {
      const value = await apiGet('latest', { sessionId })
      if (token !== tokenRef.current) return
      setLatest(value || { available: false })
      // A turn end and the workspace/changes append can race by a moment: retry once.
      if (options && options.retry === true && value && value.available === false && value.reason === 'no-changes') {
        if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
        retryTimerRef.current = setTimeout(() => {
          retryTimerRef.current = null
          void load()
        }, 900)
      }
    } catch (failure) {
      if (token !== tokenRef.current) return
      setLatest({ available: false })
    }
  }, [sessionId])

  React.useEffect(() => {
    void load()
  }, [load])

  React.useEffect(() => {
    if (running === false) void load({ retry: true })
  }, [running, load])

  // Session snapshot signature changes at turn boundaries; throttle to at most
  // one refresh per 1.2s so stream-driven re-renders cannot spam the route.
  const sessionSignature = session
    ? [running, session.turn, session.seq, session.pendingInteraction === undefined ? '' : 'interactive'].join('|')
    : ''
  React.useEffect(() => {
    if (Date.now() - lastLoadRef.current < 1200) return
    void load({ retry: true })
  }, [sessionSignature, load])

  // Precise turn-close signal: the conversation binding's `openTurn` becomes
  // undefined when the turn closes (after workspace/changes was appended).
  React.useEffect(() => {
    if (!sessionId) return undefined
    let dispose
    try {
      const conversation = runtimeState.conversation
      const binding = conversation && typeof conversation.binding === 'function' ? conversation.binding(sessionId) : undefined
      const source = binding && binding.openTurn
      if (source && typeof source.subscribe === 'function' && typeof source.getSnapshot === 'function') {
        let previous = source.getSnapshot()
        const listener = () => {
          const next = source.getSnapshot()
          if (previous !== undefined && (next === undefined || next !== previous)) void load({ retry: true })
          else if (next !== previous) void load()
          previous = next
        }
        dispose = source.subscribe(listener)
      }
    } catch (failure) {
      /* session binding not ready: the running/signature fallbacks still refresh */
    }
    return () => {
      try {
        if (typeof dispose === 'function') dispose()
      } catch (failure) { /* ignore */ }
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current)
        retryTimerRef.current = null
      }
    }
  }, [sessionId, load])

  // Returning focus/visibility to the window also refreshes (covers a reload or
  // a missed event while the page was hidden).
  React.useEffect(() => {
    const refresh = () => { void load() }
    const onVisibility = () => { if (!document.hidden) refresh() }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [load])

  // Remember the session for the global "open review" command.
  React.useEffect(() => {
    if (sessionId) runtimeState.sessionId = sessionId
  }, [sessionId])

  if (error) {
    return h('div', { className: 'drp-pill-row' }, h('div', { className: 'drp-pill-error' }, error))
  }
  // While the first read is in flight, render nothing (avoids a flicker).
  if (!latest) return null

  /** Open (or focus) the review tab for this session. */
  const onOpen = () => {
    runtimeState.sessionId = sessionId
    const address = ADDRESS_PREFIX + encodeURIComponent(sessionId)
    const ok = openResourceSafe(runtimeState.right, address)
    if (!ok) {
      setError(t('error.sidebarUnavailable'))
      return
    }
    setError(null)
  }

  if (latest.available !== true) {
    // No TURN data (no changes, or the Host restarted): keep a compact, clickable
    // entry so the review page (and its diagnostics) stays reachable.
    const text = latest.reason === 'no-changes' || latest.reason === 'summary-unavailable'
      ? t('pill.none')
      : t('pill.unavailable')
    return h(
      'div',
      { className: 'drp-pill-row' },
      h(
        'button',
        {
          type: 'button',
          className: 'drp-pill',
          style: { opacity: 0.82 },
          title: t('pill.tooltip') + (latest.reason ? '\n' + String(latest.reason) : ''),
          onClick: onOpen,
        },
        h('span', { className: 'drp-pill-icon', 'aria-hidden': true }, '↯'),
        h('span', { className: 'drp-pill-text' }, h('span', { className: 'drp-pill-count' }, text)),
        h('span', { className: 'drp-pill-open' }, t('tab.title'), ' ›'),
      ),
    )
  }

  const summary = latest.summary
  const files = summary && Array.isArray(summary.files) ? summary.files : []
  if (files.length === 0) return null

  const tooltip = files.slice(0, 10).map((file) => file.display || file.path).join('\n')

  return h(
    'div',
    { className: 'drp-pill-row' },
    h(
      'button',
      {
        type: 'button',
        className: 'drp-pill',
        title: (tooltip ? tooltip + '\n' : '') + t('pill.tooltip'),
        onClick: onOpen,
      },
      h('span', { className: 'drp-pill-icon', 'aria-hidden': true }, '↯'),
      h(
        'span',
        { className: 'drp-pill-text' },
        h('span', { className: 'drp-pill-count' }, t('pill.changes', { count: String(files.length) })),
        h(
          'span',
          { className: 'drp-pill-stats' },
          h('span', { className: 'drp-badge-add' }, '+' + fmtInt(summary.added)),
          h('span', { className: 'drp-badge-del' }, '−' + fmtInt(summary.deleted)),
        ),
      ),
      h('span', { className: 'drp-pill-open' }, t('pill.open'), ' ›'),
    ),
  )
}
