/* dsh-review-panel client half — the review page (toolbar, code area, tree, status). */

/** Cross-component runtime state: the mounted page controller plus optional services. */
const runtimeState = {
  page: null,
  sessionId: null,
  right: undefined,
  tabs: undefined,
}

/**
 * Per-session page state that survives the right-sidebar tab body unmounting.
 * DSH tears down the previous conversation's sidebar tab bodies when the user
 * switches sessions (and may unmount inactive tab bodies when switching tabs);
 * without this store every remount started from scratch, so a session switch
 * looked like "all open files closed + git version reset". Memory only: the
 * stored paths belong to a live workspace/commit, never to a DSH restart.
 */
const pageSessionStore = new Map()
/** Upper bound of remembered sessions (LRU eviction keeps memory bounded). */
const PAGE_SESSION_STORE_LIMIT = 40

/**
 * Read one session's remembered page state (LRU-touched).
 * @param {string} sessionId session identity
 * @returns {object | null} remembered state or null
 */
function rememberedPageState(sessionId) {
  const key = sessionId ? String(sessionId) : ''
  if (!key) return null
  const value = pageSessionStore.get(key)
  if (!value) return null
  pageSessionStore.delete(key)
  pageSessionStore.set(key, value)
  return value
}

/**
 * Remember one session's page state for the next mount of this tab body.
 * @param {string} sessionId session identity
 * @param {object | null} state page state snapshot
 */
function rememberPageState(sessionId, state) {
  const key = sessionId ? String(sessionId) : ''
  if (!key || !state) return
  pageSessionStore.delete(key)
  pageSessionStore.set(key, state)
  while (pageSessionStore.size > PAGE_SESSION_STORE_LIMIT) {
    const oldest = pageSessionStore.keys().next()
    if (oldest.done) break
    pageSessionStore.delete(oldest.value)
  }
}

/** The client plugin context captured by `apply` (used for optional event subscriptions). */
const globalCtxRef = { current: null }

/** Last known copied-path feedback timer (module scope so remounts do not stack). */
let copiedTimer = null

/**
 * Editor cursor position as a tiny external store: the status bar is the only
 * consumer, so a click/selection in the editor re-renders that one line instead
 * of the whole review page (file tree + tab strip included). That full-page
 * re-render was the reason a click could take a visible moment to paint the
 * word-selection background.
 */
const cursorStore = {
  value: { line: 1, column: 1 },
  listeners: new Set(),
  frame: 0,
  pending: null,
  set(position) {
    if (!position) return
    const next = { line: Number(position.line) || 1, column: Number(position.column) || 1 }
    if (next.line === this.value.line && next.column === this.value.column) return
    this.pending = next
    if (this.frame) return
    const flush = () => {
      this.frame = 0
      const value = this.pending
      this.pending = null
      if (!value) return
      this.value = value
      for (const listener of this.listeners) {
        try { listener() } catch (error) { /* ignore */ }
      }
    }
    try { this.frame = requestAnimationFrame(flush) } catch (error) { flush() }
  },
  reset() { this.value = { line: 1, column: 1 } },
  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  },
}

/** Subscribe one component to the cursor store. */
function useCursorPosition() {
  const [value, setValue] = React.useState(cursorStore.value)
  React.useEffect(() => cursorStore.subscribe(() => setValue(cursorStore.value)), [])
  return value
}

/**
 * Text width helper: ellipsis in the middle so file extensions stay visible.
 * @param {string} text source text
 * @param {number} max maximum characters
 * @returns {string}
 */
function ellipsisMiddle(text, max) {
  const value = String(text || '')
  if (value.length <= max) return value
  const half = Math.max(1, Math.floor((max - 1) / 2))
  return value.slice(0, half) + '…' + value.slice(value.length - (max - half - 1))
}

/**
 * Copy text to the clipboard with a legacy textarea fallback.
 * @param {string} text text to copy
 * @returns {Promise<boolean>}
 */
async function copyText(text) {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch (error) { /* fall through */ }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(area)
    return ok
  } catch (error) {
    return false
  }
}

/**
 * Map a path recorded by workspace-changes (absolute host path or workspace
 * relative, either separator) onto a workspace-relative posix path. The TURN
 * recorder may record absolute paths for file-tool edits, while the review
 * routes and tree use cwd-relative paths.
 * @param {string} rawPath recorded path
 * @param {string | undefined} cwd session working directory
 * @returns {string} workspace-relative posix path (unchanged when not under cwd)
 */
function toWorkspaceRel(rawPath, cwd) {
  const value = normalizeRel(rawPath)
  if (!value) return ''
  const absolute = /^[\\/]/.test(String(rawPath)) || /^[a-zA-Z]:[\\/]/.test(String(rawPath))
  const rootPath = String(cwd || '').replace(/\\/g, '/')
  const windows = /^[a-zA-Z]:\//.test(rootPath) || /^\/\/[^/]+\/[^/]+/.test(rootPath)
  const root = normalizeRel(rootPath).replace(/\/+$/, '')
  if (root && absolute) {
    const comparedValue = windows ? value.toLowerCase() : value
    const comparedRoot = windows ? root.toLowerCase() : root
    if (comparedValue === comparedRoot) return ''
    if (comparedValue.startsWith(comparedRoot + '/')) return value.slice(root.length + 1)
  }
  return value
}

/**
 * The right-sidebar / builtin preview resource address for one workspace file.
 * @param {string} sessionId session identity
 * @param {string} rel workspace-relative path * @returns {string} `dsh-resource://file/session/…` address
 */
function fileAddressOf(sessionId, rel) {
  const segments = segmentsOf(rel).map((segment) => encodeURIComponent(segment))
  return FILE_ADDRESS_PREFIX + encodeURIComponent(sessionId) + '/' + segments.join('/')
}

/**
 * The builtin hunk-review resource address for one turn.
 * @param {string} sessionId session identity
 * @param {number} seq `workspace/changes` event sequence
 * @param {number} turn turn number
 * @returns {string} `dsh-resource://changes-review/session/…` address
 */
function changesReviewAddressOf(sessionId, seq, turn) {
  return CHANGES_REVIEW_PREFIX + encodeURIComponent(sessionId) + '/' + String(seq) + '/' + String(turn)
}

/**
 * Call `openResource` defensively; returns false instead of throwing.
 * @param {any} right sidebarRight controller
 * @param {string} address resource address
 * @param {object} [options] navigation options
 * @returns {boolean}
 */
function openResourceSafe(right, address, options) {
  if (!right || typeof right.openResource !== 'function') return false
  try {
    right.openResource(address, options || undefined)
    return true
  } catch (error) {
    log('warn', 'openResource failed', address, error)
    return false
  }
}

/**
 * Small icon button.
 * @param {object} props button props
 * @returns {any} React element
 */
function IconButton(props) {
  const { title, label, onClick, active, disabled, className } = props
  return h('button', {
    type: 'button',
    className: cx('drp-icon-btn', active && 'drp-icon-btn-on', className),
    title,
    'aria-label': title,
    disabled: disabled === true,
    onClick: disabled === true ? undefined : onClick,
  }, label)
}

/**
 * Non-code / binary / oversized handoff card: never a blank page.
 * @param {object} props component props
 * @returns {any} React element
 */
function HandoffCard(props) {
  const { sessionId, path, kind, t, right, absolutePath, bytes, onCopy, note } = props
  const name = basename(path)
  const isCodeButBlocked = kind === 'binary' || kind === 'oversized'
  const [feedback, setFeedback] = React.useState('')
  /** Open the file through the builtin DSH preview. */
  const openPreview = () => {
    const ok = openResourceSafe(right, fileAddressOf(sessionId, path))
    if (!ok) {
      setFeedback(t('error.openFailed', { message: 'preview' }))
      void copyText(absolutePath || path)
    }
  }
  /** Copy the absolute (or relative) location. */
  const copy = async () => {
    const ok = await copyText(absolutePath || path)
    setFeedback(ok ? t('common.copied') : '')
    onCopy?.()
  }
  return h(
    'div',
    { className: 'drp-handoff' },
    h('div', { className: 'drp-handoff-icon' }, isCodeButBlocked ? '⚠' : '¶'),
    h('div', { className: 'drp-handoff-title' }, isCodeButBlocked
      ? (kind === 'binary' ? t('status.binary') : t('status.oversized', { size: fmtInt(Math.round((bytes || 0) / 1024)) + ' KiB' }))
      : t('handoff.title')),
    h('div', { className: 'drp-handoff-path' }, absolutePath || path),
    h('div', { className: 'drp-handoff-body' }, isCodeButBlocked
      ? t('handoff.body', { name })
      : t('handoff.body', { name })),
    h(
      'div',
      { className: 'drp-handoff-actions' },
      h('button', { type: 'button', className: 'drp-btn drp-btn-primary', onClick: openPreview }, t('action.openInPreview')),
      h('button', { type: 'button', className: 'drp-btn', onClick: () => { void copy() } }, t('action.copyPath')),
    ),
    feedback ? h('div', { className: 'drp-handoff-note' }, feedback) : null,
    note ? h('div', { className: 'drp-handoff-note' }, note) : null,
  )
}

/**
 * Empty placeholder shown before a file is selected.
 * @param {object} props component props
 * @returns {any} React element
 */
function EmptyState(props) {
  const { t, latest } = props
  return h(
    'div',
    { className: 'drp-empty' },
    h('div', { className: 'drp-empty-icon' }, '⌥'),
    h('div', { className: 'drp-empty-title' }, t('empty.title')),
    h('div', { className: 'drp-empty-body' }, t('empty.body')),
    latest && latest.available && latest.summary
      ? h('div', { className: 'drp-empty-hint' }, t('hint.turnMulti', { count: String(latest.summary.files.length) }))
      : null,
  )
}

/**
 * The editor status bar. Cursor moves are the only high-frequency update in the
 * page, so this component subscribes to the cursor store itself and React never
 * re-renders the tree / tab strip for a click.
 * @param {object} props component props
 * @returns {any} React element
 */
function ReviewStatusBar(props) {
  const { statusText, file, gitText, t, narrow } = props
  const cursor = useCursorPosition()
  const fileReady = file && file.status === 'ready'
  return h(
    'div',
    { className: 'drp-status' },
    h('span', { className: 'drp-status-text', title: statusText }, statusText),
    h('span', { className: 'drp-spacer' }),
    fileReady && !narrow ? h('span', {}, t('status.fileInfo', { lines: fmtInt(file.lines), language: file.language })) : null,
    gitText ? h('span', {}, gitText) : null,
    h('span', {}, t('status.lines', { line: String(cursor.line), column: String(cursor.column) })),
  )
}

/** Empty hunk counters (stable identity so re-applying it skips re-renders). */
const EMPTY_HUNK_META = { total: 0, added: 0, deleted: 0 }

/**
 * Normalize one `/file` route payload into the page's file record.
 * @param {string} path workspace-relative path
 * @param {any} value host response
 * @returns {object} file record
 */
function fileRecordOf(path, value) {
  if (value && value.kind === 'text') {
    return {
      status: 'ready',
      path,
      kind: 'text',
      text: value.text || '',
      lines: Number(value.lines) || splitLines(value.text || '').length,
      language: languageOf(path),
      version: value.version,
      absolutePath: value.absolutePath,
      bytes: value.bytes,
    }
  }
  if (!value || !value.kind) {
    return { status: 'handoff', path, kind: 'external', absolutePath: value && value.absolutePath, bytes: value && value.bytes }
  }
  return { status: 'handoff', path, kind: value.kind, absolutePath: value.absolutePath, bytes: value.bytes }
}

/**
 * The code review page.
 * @param {object} props component props (`sessionId`, `t`, `useSessions`, plus services)
 * @returns {any} React element
 */
function ReviewPage(props) {
  const { sessionId, t, useSessions, useTabInfo, services, address } = props
  const right = services && services.right
  const rootRef = React.useRef(null)
  const abortRef = React.useRef(null)
  const prefetchAbortRef = React.useRef(null)
  const fileTokenRef = React.useRef(0)
  const latestTokenRef = React.useRef(0)
  const revisionTokenRef = React.useRef(0)
  const historyRef = React.useRef({ past: [], future: [] })
  const handlersRef = React.useRef({})
  const initialisedRef = React.useRef(false)
  const autoOpenedRef = React.useRef(false)
  const sessionRef = React.useRef(sessionId)
  /** Latest render snapshot of the state that must survive this body's unmount. */
  const pageSnapshotRef = React.useRef(null)
  /** One-shot flag: the restored active file still has to be read from the Host. */
  const restoreLoadRef = React.useRef(false)
  /** Snapshot-effect bookkeeping: the last (snapshotKey, path) it force-loaded. */
  const lastSnapshotLoadRef = React.useRef(null)
  const editorControlsRef = React.useRef(null)
  const fontSizeRef = React.useRef(13)
  const gitStatusRef = React.useRef(null)
  const pendingRevealRef = React.useRef(null)
  /** Per-path file payload cache: a revisit renders from memory, not a round trip. */
  const fileCacheRef = React.useRef(new Map())
  const cacheGenerationRef = React.useRef(0)
  /** Per (baseline, path) comparison cache: diff rendering is instant on revisit. */
  const diffCacheRef = React.useRef(new Map())
  /** Files whose first diff was already auto-revealed (revisit keeps scroll). */
  const revealOnceRef = React.useRef(new Set())

  const cwdFromStore = useSessions
    ? useSessions((sessions) => (sessions && sessions.byId && sessionId && sessions.byId[sessionId] ? sessions.byId[sessionId].cwd : undefined))
    : undefined
  const running = useSessions
    ? useSessions((sessions) => (sessions && sessions.byId && sessionId && sessions.byId[sessionId] ? sessions.byId[sessionId].running : undefined))
    : undefined

  const [monaco, setMonaco] = React.useState(null)
  const [monacoError, setMonacoError] = React.useState(null)
  const [latest, setLatest] = React.useState(null)
  const [latestLoading, setLatestLoading] = React.useState(true)
  const [mode, setMode] = React.useState('code')
  const [modeTouched, setModeTouched] = React.useState(false)
  const [openTabs, setOpenTabs] = React.useState([])
  const [activePath, setActivePath] = React.useState(null)
  const [file, setFile] = React.useState(null)
  const [comparison, setComparison] = React.useState(null)
  const [regions, setRegions] = React.useState([])
  const [hunkMeta, setHunkMeta] = React.useState({ total: 0, added: 0, deleted: 0 })
  const [hunkIndex, setHunkIndex] = React.useState(0)
  const [reveal, setReveal] = React.useState({ line: 0, nonce: 0 })
  const [treeOpen, setTreeOpen] = React.useState(true)
  const [treeWidth, setTreeWidth] = React.useState(TREE_WIDTH_DEFAULT)
  const [changedOnly, setChangedOnly] = React.useState(false)
  const [narrow, setNarrow] = React.useState(false)
  const [status, setStatus] = React.useState(null)
  const [scheme, setScheme] = React.useState(themeRuntime.scheme)
  const [fontSize, setFontSize] = React.useState(() => {
    try {
      const stored = Number(localStorage.getItem('dsh-review-panel.fontSize'))
      return Number.isFinite(stored) && stored >= 9 && stored <= 28 ? Math.round(stored) : 13
    } catch (error) {
      return 13
    }
  })
  const [menuOpen, setMenuOpen] = React.useState(false)
  const [modeMenuOpen, setModeMenuOpen] = React.useState(false)
  const [gitStatus, setGitStatus] = React.useState(null)
  const [revision, setRevision] = React.useState(null)
  const [revisionData, setRevisionData] = React.useState(null)
  const [revisionLoading, setRevisionLoading] = React.useState(false)
  const [revisionRefreshToken, setRevisionRefreshToken] = React.useState(0)
  // Bumped when the shown snapshot kind changes (worktree ↔ historical commit):
  // Monaco keeps the same model/text, so the Host half needs an explicit
  // re-announce to hand the language server the right document.
  const [documentEpoch, setDocumentEpoch] = React.useState(0)
  const [picker, setPicker] = React.useState(null)
  const [treeRefreshToken, setTreeRefreshToken] = React.useState(0)
  const [lspMissing, setLspMissing] = React.useState(null)

  const treeVisible = treeOpen && !narrow
  const summary = latest && latest.available ? latest.summary : null
  // Revision mode pins every cache key to one (commit, scope) pair, so switching
  // versions never paints another version's text or hunks.
  const revisionKey = mode === 'revision' && revision ? 'rev:' + revision.sha + ':' + revision.scope : ''
  const revisionSha = revision ? revision.sha : ''
  const revisionScope = revision ? revision.scope : ''
  // Content and comparisons belong to the same announcement. During the
  // render before the refresh effect runs, the old text must not accept the
  // next snapshot's hunks.
  const snapshotKey = String(sessionId || '') + ':' + (revisionKey || (latest && latest.available ? String(latest.seq) : 'none'))
  const fileCurrent = file && file.path === activePath && file.snapshotKey === snapshotKey
  // Historical (= immutable commit content) mode: the diff is base → commit, and
  // the language server must not see the old document (line numbers of the
  // worktree no longer match).
  const historical = mode === 'revision' && Boolean(revision) && revision.scope === 'commit'
  const revisionLabel = revision
    ? (revision.sha === 'HEAD' ? t('mode.commit') : t('mode.revision.with', { ref: revision.short }))
    : t('mode.revision.pick')
  const modeLabel = mode === 'turn'
    ? (latest && latest.available
      ? t('mode.turn.withTurn', { turn: String(latest.turn) })
      : t('mode.turn') + ' · ' + t('status.mode.turn.stale'))
    : mode === 'git' ? t('mode.git') : mode === 'revision' ? revisionLabel : t('mode.code')

  // Render-synchronous snapshot of everything worth restoring after this tab
  // body unmounts (session switch, tab switch, tab close).
  sessionRef.current = sessionId
  pageSnapshotRef.current = {
    openTabs: openTabs.slice(),
    activePath,
    mode,
    modeTouched,
    revision: revision ? { ...revision } : null,
    changedOnly,
    treeOpen,
    treeWidth,
    initialised: initialisedRef.current,
    autoOpened: autoOpenedRef.current,
  }

  /** Publish a transient status line. */
  const notify = React.useCallback((text, kind) => {
    if (!text) return
    setStatus({ text: String(text), kind: kind || 'info', at: Date.now() })
  }, [])

  // Transient status auto-clear.
  React.useEffect(() => {
    if (!status) return undefined
    const timer = setTimeout(() => setStatus(null), 4200)
    return () => clearTimeout(timer)
  }, [status])

  // Page width measurement for the narrow layout. Only the boolean crosses the
  // React state boundary: during a DSH splitter drag the sidebar width changes
  // on every frame, and keeping pixel width in state re-rendered the whole page
  // (tree + editor) per frame — the reported divider-drag stutter.
  React.useEffect(() => {
    const node = rootRef.current
    if (!node) return undefined
    const measure = () => {
      try {
        const next = (node.getBoundingClientRect().width || node.clientWidth || 900) < NARROW_WIDTH
        setNarrow((previous) => (previous === next ? previous : next))
      } catch (error) { /* ignore */ }
    }
    measure()
    let observer
    try {
      observer = new ResizeObserver(measure)
      observer.observe(node)
    } catch (error) { /* ResizeObserver unavailable: keep the default */ }
    window.addEventListener('resize', measure)
    return () => {
      try { observer?.disconnect() } catch (error) { /* ignore */ }
      window.removeEventListener('resize', measure)
    }
  }, [])

  // Monaco loads lazily when this page first mounts.
  React.useEffect(() => {
    let cancelled = false
    loadMonaco()
      .then((namespace) => {
        if (cancelled) return
        setMonaco(namespace)
        const applied = applyMonacoTheme(namespace)
        setScheme(applied)
      })
      .catch((error) => {
        if (cancelled) return
        setMonacoError(error)
        log('error', 'monaco failed to load', error)
      })
    return () => { cancelled = true }
  }, [])

  // Theme changes repaint the editor and diff decorations.
  React.useEffect(() => {
    const dispose = observeTheme(globalCtxRef.current, () => {
      const next = applyMonacoTheme(monaco)
      setScheme(next)
    })
    return dispose
  }, [monaco])

  /** Reload the latest turn announcement for this session. */
  const modeRef = React.useRef(mode)
  modeRef.current = mode
  const tRef = React.useRef(t)
  tRef.current = t
  const notifyRef = React.useRef(notify)
  notifyRef.current = notify
  const refreshLatest = React.useCallback(async () => {
    if (!sessionId) return
    const token = ++latestTokenRef.current
    setLatestLoading(true)
    try {
      const value = await apiGet('latest', { sessionId })
      if (token !== latestTokenRef.current) return
      // Keep the previous object when the snapshot did not change: a fresh
      // object identity would re-run the diff effect and repaint the editor
      // (the old code refreshed on every window focus and looked laggy).
      setLatest((previous) => {
        const next = { ...(value || {}), loaded: true }
        if (previous && previous.loaded === true
          && previous.available === next.available
          && previous.seq === next.seq
          && previous.turn === next.turn) return previous
        return next
      })
      if (modeRef.current === 'turn' && value && value.available === false) {
        const fallback = gitStatusRef.current?.available ? 'git' : 'code'
        setMode(fallback)
        setModeTouched(true)
        notifyRef.current(tRef.current('mode.turn.unavailable'), 'warn')
      }
    } catch (failure) {
      if (token !== latestTokenRef.current) return
      setLatest((previous) => (previous && previous.loaded === true ? previous : { available: false, loaded: true, reason: 'request-failed' }))
    } finally {
      if (token === latestTokenRef.current) setLatestLoading(false)
    }
  }, [sessionId])

  /** Refresh the git working-tree status used by the Git mode and tree badges. */
  const loadGitStatus = React.useCallback(async () => {
    if (!sessionId) return
    try {
      const value = await apiGet('gitStatus', { sessionId })
      gitStatusRef.current = value || { available: false }
      setGitStatus(value || { available: false })
    } catch (failure) {
      const value = { available: false, reason: 'request-failed' }
      gitStatusRef.current = value
      setGitStatus(value)
    }
  }, [sessionId])

  // Probe git once when the page mounts (also decides the initial baseline).
  React.useEffect(() => {
    void loadGitStatus()
  }, [loadGitStatus])

  // Initial baseline: restore this session's remembered workspace (tabs, active
  // file, diff baseline, git version) or fall back to TURN when the Host recorded
  // a turn, else GIT when the workspace is a repository, else code-only. The
  // right-sidebar tab body is remounted whenever the user switches sessions, so
  // this is the only place the previous visit's state comes back.
  React.useEffect(() => {
    if (initialisedRef.current) return
    if (!latest || latest.loaded !== true) return
    if (gitStatus === null) return
    initialisedRef.current = true
    const gitAvailable = gitStatus.available === true
    const defaultMode = () => (latest.available ? 'turn' : gitAvailable ? 'git' : 'code')
    // The Host probes can be slow: the user may already have opened a file or
    // picked a baseline during the remount window. That choice wins over the
    // remembered snapshot (which was captured before this mount).
    const interacted = Boolean(activePath) || openTabs.length > 0 || revision !== null || modeTouched === true || mode !== 'code'
    if (interacted) {
      if (!modeTouched) setMode(defaultMode())
      // Never let the turn's auto-open replace the file the user just picked.
      autoOpenedRef.current = true
      return
    }
    const saved = rememberedPageState(sessionId)
    if (!saved) {
      setMode(defaultMode())
      return
    }
    const modes = ['turn', 'git', 'revision', 'code']
    let nextMode = modes.includes(saved.mode) ? saved.mode : ''
    if (!nextMode) nextMode = defaultMode()
    if (nextMode === 'turn' && !latest.available) nextMode = gitAvailable ? 'git' : 'code'
    if (nextMode === 'git' && !gitAvailable) nextMode = 'code'
    let nextRevision = null
    if (nextMode === 'revision') {
      const record = saved.revision
      if (gitAvailable && record && typeof record.sha === 'string' && record.sha !== '') {
        nextRevision = {
          sha: record.sha,
          short: typeof record.short === 'string' && record.short !== '' ? record.short : record.sha,
          subject: typeof record.subject === 'string' ? record.subject : '',
          date: typeof record.date === 'string' ? record.date : undefined,
          scope: record.scope === 'since' ? 'since' : 'commit',
        }
      } else {
        // A git version belongs to a repository: never restore it without one.
        nextMode = gitAvailable ? 'git' : 'code'
      }
    }
    const tabs = Array.isArray(saved.openTabs) ? saved.openTabs.filter((path) => typeof path === 'string' && path !== '') : []
    const active = typeof saved.activePath === 'string' && saved.activePath !== '' ? saved.activePath : null
    if (active && !tabs.includes(active)) tabs.push(active)
    setOpenTabs(tabs)
    setActivePath(active)
    setChangedOnly(saved.changedOnly === true)
    if (typeof saved.treeOpen === 'boolean') setTreeOpen(saved.treeOpen)
    const width = Number(saved.treeWidth)
    if (Number.isFinite(width)) setTreeWidth(Math.min(TREE_WIDTH_MAX, Math.max(TREE_WIDTH_MIN, Math.round(width))))
    autoOpenedRef.current = saved.autoOpened === true || Boolean(active)
    // A restored file did not go through openPath(), so it still has to be
    // read from the Host once the final baseline announcement is known.
    restoreLoadRef.current = Boolean(active)
    setRevision(nextRevision)
    setMode(nextMode)
    setModeTouched(saved.modeTouched === true)
  }, [latest, gitStatus, sessionId])

  // Persist the page's workspace state before this tab body unmounts. DSH
  // unmounts the previous conversation's sidebar tab bodies on a session switch,
  // so the next mount of the same session restores its tabs, active file and git
  // version instead of starting from scratch.
  React.useEffect(() => () => {
    const state = pageSnapshotRef.current
    if (!state) return
    if (state.initialised !== true && state.openTabs.length === 0 && !state.activePath) return
    rememberPageState(sessionRef.current, state)
  }, [sessionId])

  // Revision baseline: one compare payload drives the tree's changed-file list,
  // the status bar and the per-file rev+scope comparisons below. refreshAll
  // bumps revisionRefreshToken so this reloads.
  React.useEffect(() => {
    revisionTokenRef.current += 1
    const token = revisionTokenRef.current
    if (mode !== 'revision' || !revisionSha || !sessionId) {
      setRevisionData(null)
      setRevisionLoading(false)
      return undefined
    }
    setRevisionData(null)
    setRevisionLoading(true)
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    apiGet('gitCompare', { sessionId, rev: revisionSha, scope: revisionScope }, controller ? controller.signal : undefined)
      .then((value) => {
        if (token !== revisionTokenRef.current) return
        setRevisionData(value || { available: false, reason: 'request-failed' })
      })
      .catch((failure) => {
        if (token !== revisionTokenRef.current) return
        setRevisionData({ available: false, reason: 'request-failed', message: failure && failure.message })
      })
      .finally(() => {
        if (token === revisionTokenRef.current) setRevisionLoading(false)
      })
    return () => {
      revisionTokenRef.current += 1
      try { controller?.abort() } catch (error) { /* ignore */ }
    }
  }, [mode, sessionId, revisionSha, revisionScope, revisionRefreshToken])

  /** Cache key for one comparison (turn snapshot, git baseline or git revision). */
  const diffCacheKey = React.useCallback((path) => {
    if (!path) return ''
    if (mode === 'turn') return latest && latest.available ? 'turn:' + String(latest.seq) + ':' + path : ''
    if (mode === 'git') return 'git:' + (gitStatus && gitStatus.available === true ? '1' : '0') + ':' + path
    if (mode === 'revision') return revisionSha ? 'rev:' + revisionSha + ':' + revisionScope + ':' + path : ''
    return 'code:' + path
  }, [mode, latest && latest.seq, latest && latest.available, gitStatus && gitStatus.available, revisionSha, revisionScope])

  /**
   * Apply one cached diff entry (or an error/empty marker) to the page state.
   * The first diff of a file is revealed once; revisits keep the scroll position
   * the user left, which is what makes switching back feel like VS Code.
   * @param {object} entry cached diff entry
   * @param {string} path active file
   * @param {string} text current file text
   */
  const applyDiffEntry = React.useCallback((entry, path, text) => {
    if (!entry) return
    const context = { path, snapshotKey, generation: cacheGenerationRef.current, key: diffCacheKey(path) }
    if (entry.status === 'ready') {
      const built = buildRegions(entry.value, text || '')
      setComparison({ ...context, status: 'ready', value: entry.value, index: entry.index })
      setRegions(built.regions)
      setHunkMeta({ total: built.total, added: built.added, deleted: built.deleted })
      setHunkIndex(0)
      if (built.regions.length > 0 && !pendingRevealRef.current && !revealOnceRef.current.has(path)) {
        revealOnceRef.current.add(path)
        setReveal((previous) => ({ line: built.regions[0].start, nonce: previous.nonce + 1 }))
      }
      return
    }
    setRegions([])
    setHunkMeta(EMPTY_HUNK_META)
    setHunkIndex(0)
    if (entry.status === 'deleted') {
      setComparison({ ...context, status: 'deleted' })
      notify(t('status.git.deleted'), 'warn')
      return
    }
    setComparison({ ...context, status: entry.status, message: entry.message, kind: entry.kind })
  }, [notify, t, snapshotKey, diffCacheKey])

  /** Load one file's current content, using the per-path cache for instant switch. */
  const loadFile = React.useCallback(async (path, options) => {
    if (!sessionId || !path) return
    const force = Boolean(options && options.force)
    fileTokenRef.current += 1
    const token = fileTokenRef.current
    try { abortRef.current?.abort() } catch (error) { /* ignore */ }
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    abortRef.current = controller
    cursorStore.reset()
    if (!isCodeFile(path)) {
      const handoff = { status: 'handoff', path, kind: 'external', snapshotKey }
      fileCacheRef.current.set(path, handoff)
      setFile(handoff)
      setComparison({ status: 'none' })
      setRegions([])
      setHunkMeta(EMPTY_HUNK_META)
      setHunkIndex(0)
      return
    }
    const candidate = force ? undefined : fileCacheRef.current.get(path)
    const cached = candidate && candidate.snapshotKey === snapshotKey ? candidate : undefined
    if (cached) setFile(cached)
    else setFile({ status: 'loading', path, kind: 'text', snapshotKey })
    // Re-apply a cached comparison synchronously; the diff effects only run for
    // files whose comparison is not cached yet.
    const cachedKey = force ? '' : diffCacheKey(path)
    const cachedDiff = cachedKey ? diffCacheRef.current.get(cachedKey) : undefined
    if (cachedDiff) applyDiffEntry(cachedDiff, path, cached && cached.status === 'ready' ? cached.text : '')
    else {
      setRegions([])
      setHunkMeta(EMPTY_HUNK_META)
      setHunkIndex(0)
      setComparison(null)
    }
    if (cached) return
    try {
      // Historical content comes from git at the selected commit, never from the
      // worktree; since-scope and the other baselines read the worktree file.
      const params = historical && revision ? { sessionId, path, rev: revision.sha } : { sessionId, path }
      const value = await apiGet('file', params, controller ? controller.signal : undefined)
      if (token !== fileTokenRef.current) return
      const record = { ...fileRecordOf(path, value), snapshotKey }
      fileCacheRef.current.set(path, record)
      setFile(record)
    } catch (failure) {
      if (token !== fileTokenRef.current) return
      // A missing file is only a candidate deletion. It becomes an empty
      // review model after the comparison confirms that its after side is
      // absent. Permission/session/read errors remain ordinary errors.
      const missing = failure && failure.status === 404 && failure.code === 'not-found'
      const record = {
        status: missing ? 'missing' : 'error', path, kind: 'text', snapshotKey,
        text: '', lines: 1, language: languageOf(path), missing,
        error: failure && failure.message ? failure.message : String(failure),
      }
      if (missing) fileCacheRef.current.set(path, record)
      setFile(record)
    }
  }, [sessionId, snapshotKey, diffCacheKey, applyDiffEntry, historical, revision && revision.sha])

  /** Match one active file against the turn summary's changed files. */
  const changedIndexOf = React.useCallback((path) => {
    if (!summary || !Array.isArray(summary.files) || !path) return -1
    const target = normalizeRel(path)
    const targetName = basename(target)
    const relativeOfEntry = (fileEntry) => toWorkspaceRel(fileEntry.path || fileEntry.display || '', cwdFromStore)
    for (let index = 0; index < summary.files.length; index += 1) {
      const fileEntry = summary.files[index]
      if (!fileEntry) continue
      if (relativeOfEntry(fileEntry) === target) return index
    }
    // Fallback: unique basename match (workspace-changes may record paths
    // relative to a repository above the session cwd, or absolute paths).
    const candidates = []
    for (let index = 0; index < summary.files.length; index += 1) {
      const fileEntry = summary.files[index]
      const rel = relativeOfEntry(fileEntry)
      if (rel.endsWith('/' + target) || rel === target || basename(rel) === targetName) candidates.push(index)
    }
    return candidates.length === 1 ? candidates[0] : -1
  }, [summary, cwdFromStore])

  // Refresh the turn announcement on mount and when a running turn settles.
  React.useEffect(() => {
    void refreshLatest()
  }, [sessionId, refreshLatest])

  React.useEffect(() => {
    if (running === false) void refreshLatest()
  }, [running, refreshLatest])

  // Reload the active text as well as invalidating caches. Keep Monaco mounted
  // and keep the first-reveal history so refreshing a viewed file retains its
  // scroll position. loadFile cancels the previous read before starting anew.
  const snapshotRef = React.useRef(null)
  React.useEffect(() => {
    if (snapshotRef.current === snapshotKey) return
    snapshotRef.current = snapshotKey
    cacheGenerationRef.current += 1
    fileCacheRef.current = new Map()
    diffCacheRef.current = new Map()
    if (activePath) {
      lastSnapshotLoadRef.current = { key: snapshotKey, path: activePath }
      void loadFile(activePath, { force: true })
    }
  }, [snapshotKey, activePath, loadFile])

  // The baseline restore puts the remembered active file in place without going
  // through openPath(); read it once here, from the render that already carries
  // the restored baseline/revision (so historical content is read at its commit).
  // The snapshot effect above may already have force-loaded that exact file while
  // settling the restored revision (which changes snapshotKey); never fetch twice.
  React.useEffect(() => {
    if (!restoreLoadRef.current) return
    if (!activePath) return
    restoreLoadRef.current = false
    const already = lastSnapshotLoadRef.current
    if (already && already.key === snapshotKey && already.path === activePath) return
    snapshotRef.current = snapshotKey
    cacheGenerationRef.current += 1
    fileCacheRef.current = new Map()
    diffCacheRef.current = new Map()
    void loadFile(activePath, { force: true })
  }, [activePath, snapshotKey, loadFile])

  // A mode switch invalidates the current decorations before the matching
  // baseline effect repaints from cache in the same commit.
  const previousModeRef = React.useRef(mode)
  React.useEffect(() => {
    if (previousModeRef.current === mode) return
    previousModeRef.current = mode
    applyDiffEntry({ status: 'none' })
  }, [mode, applyDiffEntry])

  // Depend on the file record itself: a refresh can return identical text while
  // React batches away the intermediate loading state. Its new record still
  // has to restart the comparison after cache invalidation.
  // TURN baseline: cached per (turn seq, path), fetched once.
  React.useEffect(() => {
    if (!activePath || mode !== 'turn' || !summary || !latest || !latest.available) return undefined
    if (!fileCurrent || (file.status !== 'ready' && file.status !== 'missing')) return undefined
    const index = changedIndexOf(activePath)
    if (index < 0) {
      applyDiffEntry({ status: 'none' }, activePath, file.text)
      return undefined
    }
    const key = diffCacheKey(activePath)
    const cached = key ? diffCacheRef.current.get(key) : undefined
    if (cached) {
      applyDiffEntry(cached, activePath, file.text)
      return undefined
    }
    let cancelled = false
    const generation = cacheGenerationRef.current
    let showedLoading = false
    if (!comparison || comparison.status !== 'ready') showedLoading = true
    if (showedLoading) setComparison({ status: 'loading', index })
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    apiGet('diff', { sessionId, seq: latest.seq, index }, controller ? controller.signal : undefined)
      .then((value) => {
        if (cancelled || generation !== cacheGenerationRef.current) return
        const entry = { status: 'ready', value, index }
        if (key) diffCacheRef.current.set(key, entry)
        applyDiffEntry(entry, activePath, file.text)
      })
      .catch((failure) => {
        if (cancelled || generation !== cacheGenerationRef.current) return
        const status = failure && failure.status === 404 ? 'missing' : 'error'
        if (key) diffCacheRef.current.set(key, { status, message: failure && failure.message })
        applyDiffEntry({ status, message: failure && failure.message }, activePath, file.text)
        if (failure && failure.status === 404) notify(t('error.sessionGone'), 'warn')
      })
    return () => { cancelled = true; controller?.abort() }
  }, [activePath, mode, snapshotKey, latest && latest.seq, latest && latest.available, summary, file, sessionId, changedIndexOf, diffCacheKey, applyDiffEntry, notify, t])

  // Git baseline: HEAD ↔ working tree for the active file (cached per path).
  React.useEffect(() => {
    if (mode !== 'git' || !activePath) return undefined
    if (!fileCurrent || (file.status !== 'ready' && file.status !== 'missing')) return undefined
    if (!gitStatus || gitStatus.available !== true) {
      applyDiffEntry({ status: 'unavailable', message: t('mode.git.unavailable') }, activePath, file.text)
      return undefined
    }
    const key = diffCacheKey(activePath)
    const cached = key ? diffCacheRef.current.get(key) : undefined
    if (cached) {
      applyDiffEntry(cached, activePath, file.text)
      return undefined
    }
    let cancelled = false
    const generation = cacheGenerationRef.current
    setComparison({ status: 'loading' })
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    apiGet('gitFile', { sessionId, path: activePath }, controller ? controller.signal : undefined)
      .then((value) => {
        if (cancelled || generation !== cacheGenerationRef.current) return
        let entry
        if (!value || !value.kind) entry = { status: 'error' }
        else if (value.kind === 'text') entry = { status: 'ready', value }
        else if (value.kind === 'deleted') entry = { status: 'deleted' }
        else entry = { status: 'unavailable', kind: value.kind }
        if (key) diffCacheRef.current.set(key, entry)
        applyDiffEntry(entry, activePath, file.text)
      })
      .catch((failure) => {
        if (cancelled || generation !== cacheGenerationRef.current) return
        applyDiffEntry({ status: 'error', message: failure && failure.message }, activePath, file.text)
      })
    return () => { cancelled = true; controller?.abort() }
  }, [mode, activePath, snapshotKey, file, gitStatus && gitStatus.available, sessionId, diffCacheKey, applyDiffEntry, t])

  // Revision baseline: compare the active file against the selected git version
  // (`commit` = rev^1 → rev, `since` = rev → worktree). The tree's compare
  // payload has to be ready first: without it the diff columns are meaningless.
  React.useEffect(() => {
    if (mode !== 'revision' || !activePath || !revision) return undefined
    if (!fileCurrent || (file.status !== 'ready' && file.status !== 'missing')) return undefined
    if (!revisionData) return undefined
    if (revisionData.available !== true) {
      applyDiffEntry({ status: 'unavailable', message: t('status.revision.unavailable') }, activePath, file.text)
      return undefined
    }
    const key = diffCacheKey(activePath)
    const cached = key ? diffCacheRef.current.get(key) : undefined
    if (cached) {
      applyDiffEntry(cached, activePath, file.text)
      return undefined
    }
    let cancelled = false
    const generation = cacheGenerationRef.current
    setComparison({ status: 'loading' })
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    apiGet('gitFile', { sessionId, path: activePath, rev: revision.sha, scope: revision.scope }, controller ? controller.signal : undefined)
      .then((value) => {
        if (cancelled || generation !== cacheGenerationRef.current) return
        let entry
        if (!value || !value.kind) entry = { status: 'error' }
        else if (value.kind === 'text') entry = { status: 'ready', value }
        else if (value.kind === 'deleted') entry = { status: 'deleted' }
        else entry = { status: 'unavailable', kind: value.kind }
        if (key) diffCacheRef.current.set(key, entry)
        applyDiffEntry(entry, activePath, file.text)
      })
      .catch((failure) => {
        if (cancelled || generation !== cacheGenerationRef.current) return
        applyDiffEntry({ status: 'error', message: failure && failure.message }, activePath, file.text)
      })
    return () => { cancelled = true; controller?.abort() }
  }, [mode, activePath, snapshotKey, file, revision && revision.sha, revision && revision.scope, revisionData, sessionId, diffCacheKey, applyDiffEntry, t])

  // Prefetch file text + comparison for the turn's changed files in the
  // background, so the first click on a file in the tree also renders its diff
  // without a round-trip (limited concurrency, cache-only; never touches the
  // live page state).
  React.useEffect(() => {
    if (mode !== 'turn' || !latest || !latest.available || !summary || !sessionId) return undefined
    const seq = latest.seq
    const generation = cacheGenerationRef.current
    const files = Array.isArray(summary.files) ? summary.files : []
    const targets = []
    for (const fileEntry of files) {
      const rel = toWorkspaceRel((fileEntry && (fileEntry.path || fileEntry.display)) || '', cwdFromStore)
      if (!rel || !isCodeFile(rel) || targets.includes(rel)) continue
      targets.push(rel)
      if (targets.length >= 8) break
    }
    let cancelled = false
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    prefetchAbortRef.current = controller
    const run = async () => {
      for (const path of targets) {
        if (cancelled || generation !== cacheGenerationRef.current) return
        const key = 'turn:' + String(seq) + ':' + path
        const haveFile = fileCacheRef.current.get(path)?.status === 'ready'
        const haveDiff = diffCacheRef.current.has(key)
        if (haveFile && haveDiff) continue
        const index = changedIndexOf(path)
        if (index < 0) continue
        try {
          const [fileValue, diffValue] = await Promise.all([
            haveFile ? null : apiGet('file', { sessionId, path }, controller ? controller.signal : undefined),
            haveDiff ? null : apiGet('diff', { sessionId, seq, index }, controller ? controller.signal : undefined),
          ])
          if (cancelled || generation !== cacheGenerationRef.current) return
          if (fileValue) {
            const record = { ...fileRecordOf(path, fileValue), snapshotKey }
            if (record.status === 'ready' || record.status === 'handoff') fileCacheRef.current.set(path, record)
          }
          if (diffValue) diffCacheRef.current.set(key, { status: 'ready', value: diffValue, index })
        } catch (error) {
          /* prefetch is best effort */
        }
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    }
    void run()
    return () => {
      cancelled = true
      controller?.abort()
      if (prefetchAbortRef.current === controller) prefetchAbortRef.current = null
    }
  }, [mode, snapshotKey, latest && latest.seq, latest && latest.available, summary, sessionId, cwdFromStore, changedIndexOf])

  // A search hit / Quick Open result may ask to reveal a specific line once the
  // file content is in and its comparison settled.
  React.useEffect(() => {
    const pending = pendingRevealRef.current
    if (!pending) return
    if (!file || file.status !== 'ready' || file.path !== pending.path) return
    if (comparison && comparison.status === 'loading') return
    setReveal((previous) => ({ ...pending, line: Math.max(1, pending.line), nonce: previous.nonce + 1 }))
  }, [file, comparison])

  /** Open a file in the code area (adding a tab and recording nav history). */
  const openPath = React.useCallback((path, options) => {
    const rel = normalizeRel(path)
    if (!rel) return
    if (!options?.location) pendingRevealRef.current = null
    if (activePath && activePath !== rel) {
      const history = historyRef.current
      history.past.push(activePath)
      if (history.past.length > 100) history.past.shift()
      history.future = []
    }
    setActivePath(rel)
    setOpenTabs((tabs) => (tabs.includes(rel) ? tabs : tabs.concat(rel)))
    setMenuOpen(false)
    if (!(options && options.silent)) void loadFile(rel)
  }, [activePath, loadFile])

  // SPEC §3.1/§10.2: opening the page selects the first changed file and jumps
  // to its first diff (once per mount, only when turn data is available).
  React.useEffect(() => {
    if (autoOpenedRef.current) return
    if (!latest || latest.available !== true || !latest.summary) return
    if (mode !== 'turn') return
    const files = Array.isArray(latest.summary.files) ? latest.summary.files : []
    if (files.length === 0) return
    autoOpenedRef.current = true
    const mapped = files.map((fileEntry) => toWorkspaceRel(fileEntry.path || fileEntry.display || '', cwdFromStore))
    const candidates = mapped.filter((rel) => rel !== '' && !rel.startsWith('..') && !/^[a-zA-Z]:/.test(rel))
    if (candidates.length === 0) return
    const target = candidates.find((rel) => isCodeFile(rel)) || candidates[0]
    openPath(target)
  }, [latest, mode, cwdFromStore, openPath])

  /** Close one tab, selecting a neighbour. */
  const closeTab = React.useCallback((path) => {
    const tabs = openTabs
    const index = tabs.indexOf(path)
    const next = tabs.filter((tab) => tab !== path)
    setOpenTabs(next)
    if (activePath !== path) return
    const fallback = next[Math.min(Math.max(index, 0), next.length - 1)] || null
    setActivePath(fallback)
    if (fallback) void loadFile(fallback)
    else setFile(null)
  }, [openTabs, activePath, loadFile])

  /** Cycle through open tabs. */
  const cycleTab = React.useCallback((delta) => {
    if (openTabs.length === 0) return
    const index = Math.max(0, openTabs.indexOf(activePath))
    const next = (index + delta + openTabs.length) % openTabs.length
    const path = openTabs[next]
    if (path) openPath(path)
  }, [openTabs, activePath, openPath])

  /** Navigate the in-page history. */
  const navigateHistory = React.useCallback((direction) => {
    const history = historyRef.current
    const current = activePath
    if (direction === 'back') {
      const previous = history.past.pop()
      if (!previous) return
      if (current) history.future.push(current)
      setActivePath(previous)
      setOpenTabs((tabs) => (tabs.includes(previous) ? tabs : tabs.concat(previous)))
      void loadFile(previous)
    } else {
      const next = history.future.pop()
      if (!next) return
      if (current) history.past.push(current)
      setActivePath(next)
      setOpenTabs((tabs) => (tabs.includes(next) ? tabs : tabs.concat(next)))
      void loadFile(next)
    }
  }, [activePath, loadFile])

  /** Reveal a change group by index. */
  const goToChange = React.useCallback((index) => {
    if (!regions.length) return
    const clamped = ((index % regions.length) + regions.length) % regions.length
    setHunkIndex(clamped)
    setReveal((previous) => ({ line: regions[clamped].start, nonce: previous.nonce + 1 }))
  }, [regions])

  /** Open the builtin hunk review for the current turn. */
  const openOfficialReview = React.useCallback(() => {
    if (!latest || !latest.available) {
      notify(t('action.officialReview.disabled'), 'warn')
      return
    }
    const index = activePath ? changedIndexOf(activePath) : 0
    const ok = openResourceSafe(right, changesReviewAddressOf(sessionId, latest.seq, latest.turn), { params: { index: Math.max(0, index) } })
    if (!ok) notify(t('action.officialReview.disabled'), 'warn')
  }, [latest, activePath, changedIndexOf, right, sessionId, notify, t])

  /** Open a file (defaults to the active one) in the builtin DSH preview. */
  const openInPreview = React.useCallback((targetPath) => {
    const path = typeof targetPath === 'string' && targetPath !== '' ? targetPath : activePath
    if (!path) return
    const ok = openResourceSafe(right, fileAddressOf(sessionId, path))
    if (!ok) notify(t('error.openFailed', { message: 'preview' }), 'warn')
  }, [activePath, sessionId, right, notify, t])

  /** Copy the active file's workspace-relative path. */
  const copyActivePath = React.useCallback(async () => {
    if (!activePath) return
    const ok = await copyText(activePath)
    notify(ok ? t('common.copied') : t('action.copyPath'), ok ? 'info' : 'warn')
    if (copiedTimer) clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => { copiedTimer = null }, 2000)
  }, [activePath, notify, t])

  /** Refresh everything currently shown (the single toolbar refresh button). */
  const refreshAll = React.useCallback(() => {
    cacheGenerationRef.current += 1
    prefetchAbortRef.current?.abort()
    fileCacheRef.current = new Map()
    diffCacheRef.current = new Map()
    void refreshLatest()
    void loadGitStatus()
    if (activePath) void loadFile(activePath, { force: true })
    setTreeRefreshToken((value) => value + 1)
    // Reload the revision comparison (and therefore the tree's file list).
    setRevisionRefreshToken((value) => value + 1)
  }, [refreshLatest, loadGitStatus, activePath, loadFile])

  /** Apply one editor font size (clamped) to the live editor, if any. */
  const applyFontSize = React.useCallback((size) => {
    const next = Math.min(28, Math.max(9, Math.round(Number(size) || 13)))
    fontSizeRef.current = next
    setFontSize(next)
    try { localStorage.setItem('dsh-review-panel.fontSize', String(next)) } catch (error) { /* optional */ }
    editorControlsRef.current?.setFontSize?.(next)
  }, [])

  /** Open the picker overlay in one mode. The revisions picker keeps its scope. */
  const openPicker = React.useCallback((targetMode) => {
    setMenuOpen(false)
    setModeMenuOpen(false)
    if (targetMode === 'revisions') {
      setPicker({ mode: 'revisions', scope: revision && revision.scope === 'since' ? 'since' : 'commit' })
      return
    }
    setPicker({ mode: targetMode })
  }, [revision])

  /**
   * Switch the page to one git revision baseline. `HEAD` is the one-click
   * latest-commit shortcut; the host resolves it to the real commit.
   * @param {object} next revision-ish record (`sha`, `short`, `subject`, `date`)
   * @param {'commit'|'since'} [scope] comparison scope
   */
  const applyRevision = React.useCallback((next, scope) => {
    if (!next || typeof next.sha !== 'string' || next.sha === '') return
    setRevision({
      sha: next.sha,
      short: next.short ? String(next.short) : next.sha,
      subject: next.subject ? String(next.subject) : '',
      date: next.date ? String(next.date) : undefined,
      scope: scope === 'since' ? 'since' : 'commit',
    })
    setMode('revision')
    setModeTouched(true)
  }, [])

  /** Change the revisions-picker scope (commit vs since) without closing it. */
  const changeRevisionScope = React.useCallback((scope) => {
    const next = scope === 'since' ? 'since' : 'commit'
    setPicker((current) => (current && current.mode === 'revisions' ? { ...current, scope: next } : current))
  }, [])

  /**
   * Apply one picked revision from the picker. A raw typed expression is
   * resolved through the host (`gitRevisions` with `q`); failures keep the
   * picker open and surface a warning.
   * @param {object} picked commit record or `{raw:string}`
   */
  const pickRevision = React.useCallback(async (picked) => {
    if (!picked) return
    const scope = picker && picker.mode === 'revisions' && picker.scope === 'since' ? 'since' : 'commit'
    if (typeof picked.raw === 'string') {
      const raw = picked.raw.trim()
      if (!raw) return
      try {
        const value = await apiGet('gitRevisions', { sessionId, q: raw })
        const resolved = value && value.resolved
        if (!resolved) {
          const reason = value && (value.resolveError || value.reason)
          notify(t('picker.revisions.resolveFailed', { message: reason || raw }), 'warn')
          return
        }
        applyRevision(resolved, scope)
        setPicker(null)
      } catch (failure) {
        notify(t('picker.revisions.resolveFailed', { message: failure && failure.message ? failure.message : String(failure) }), 'warn')
      }
      return
    }
    applyRevision(picked, scope)
    setPicker(null)
  }, [picker, sessionId, notify, t, applyRevision])

  // In-page shortcut fallback: when the DSH shortcut dispatcher does not consume
  // the chord (or the binding could not be registered), handle the VS Code–style
  // keys while focus is inside the review page. Bubble phase + defaultPrevented
  // keeps native bindings (e.g. Monaco's own Ctrl+G) authoritative.
  React.useEffect(() => {
    if (picker) return undefined
    const onKeyDown = (event) => {
      try {
        if (event.defaultPrevented) return
        const root = rootRef.current
        if (!root || !(event.target instanceof Node) || !root.contains(event.target)) return
        const primary = event.ctrlKey || event.metaKey
        const key = String(event.key || '').toLowerCase()
        const alt = event.altKey
        const shift = event.shiftKey
        if (primary && !alt && !shift && key === 'p') { event.preventDefault(); openPicker('quickopen'); return }
        if (primary && !alt && shift && key === 'p') { event.preventDefault(); openPicker('commands'); return }
        if (primary && !alt && shift && key === 'f') { event.preventDefault(); openPicker('search'); return }
        if (primary && !alt && !shift && key === 'g') { event.preventDefault(); openPicker('line'); return }
        if (primary && !alt && shift && key === 'e') { event.preventDefault(); setTreeOpen((value) => !value) }
        if (primary && !alt && shift && key === 'o') { event.preventDefault(); void handlersRef.current.outline?.() }
      } catch (error) {
        log('warn', 'key fallback failed', error)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [picker, openPicker])

  /** Open a picked file (optionally revealing a line from a search hit). */
  const pickFile = React.useCallback((path, line, column, range) => {
    setPicker(null)
    const rel = normalizeRel(path)
    if (!rel) return
    const target = typeof line === 'number' && line > 0 ? { path: rel, line, column: column || 1, endLine: range?.endLine, endColumn: range?.endColumn } : null
    pendingRevealRef.current = target
    if (target && rel === activePath && file?.status === 'ready') {
      setReveal((previous) => ({ ...target, nonce: previous.nonce + 1 }))
      return
    }
    openPath(rel, { location: target })
  }, [openPath, activePath, file?.status])

  // Host-version self-check: a stale Host half (LSP or git-version routes not
  // loaded yet) would otherwise fail silently as "no definition found" or an
  // empty version picker.
  React.useEffect(() => {
    let cancelled = false
    apiGet('config')
      .then((value) => {
        if (cancelled || !value) return
        const features = value.features || {}
        if (features.lsp !== true || Number(value.phase) < 3) {
          notify('插件 Host 端仍是旧版本（phase ' + String(value.phase) + '）：LSP 路由不可用，请重启 DSH 后再试', 'warn')
        } else if (features.gitRevisions !== true) {
          notify(t('error.hostOutdated'), 'warn')
        }
      })
      .catch(() => { /* config probe is optional */ })
    return () => { cancelled = true }
  }, [notify, t])
  // Register the language-server providers once Monaco is ready, and feed the
  // bridge the active document whenever the model changes.
  React.useEffect(() => {
    if (!monaco) return
    lspRegisterProviders(monaco, {
      notify: (text, kind) => notify(text, kind),
      onMissing: (missing) => setLspMissing(missing),
      onUnsupported: (language) => notify(t('lsp.unsupported', { language }), 'warn'),
      openLocation: (path, line, column, range) => {
        // Historical content is shown at its commit, but navigation locations
        // for other files are computed against the worktree; the reveal line is
        // therefore only approximate there.
        const crossFile = historical && normalizeRel(path) !== activePath
        pickFile(path, line, column, range)
        if (crossFile) notify(t('lsp.historicalCrossFile'), 'info')
      },
      showLocations: (locations, kind) => { setMenuOpen(false); setPicker({ mode: 'locations', locations, kind }) },
    })
  }, [monaco, notify, pickFile, historical, activePath, t])

  /** One click = confirmation: send the install request to the Agent. */
  const installLspFromAgent = React.useCallback(async () => {
    const missing = lspMissing
    if (!missing) return
    const result = await lspAskAgentToInstall(missing.install, missing.language)
    if (result === 'sent') {
      lspForgetMissing()
      setLspMissing(null)
      notify(t('lsp.sent'), 'info')
      return
    }
    if (result === 'draft') {
      notify(t('lsp.inserted'), 'info')
      return
    }
    const ok = await copyText(missing.install)
    notify(ok ? t('lsp.copied') : missing.install, ok ? 'info' : 'warn')
  }, [lspMissing, notify, t])

  /** Copy the install command for manual installation. */
  const copyLspInstall = React.useCallback(async () => {
    const missing = lspMissing
    if (!missing) return
    const ok = await copyText(missing.install)
    notify(ok ? t('lsp.copied') : missing.install, ok ? 'info' : 'warn')
  }, [lspMissing, notify, t])

  /** Show the live LSP state (debug aid for missing-server/route problems). */
  const showLspDiagnostics = React.useCallback(async () => {
    setMenuOpen(false)
    const rows = await lspDiagnostics()
    notify(rows.join('  |  '), 'info')
    try { console.log('[dsh-review-panel lsp]', rows) } catch (error) { /* ignore */ }
  }, [notify])

  /** Fetch the document outline and list it in the picker. */
  const openOutline = React.useCallback(async () => {
    setMenuOpen(false)
    const symbols = await lspSymbols()
    if (!Array.isArray(symbols) || symbols.length === 0) {
      notify(t('lsp.noSymbols'), 'info')
      return
    }
    setPicker({ mode: 'outline', symbols })
  }, [notify, t])

  // F12 / Shift+F12 in capture phase: Monaco's built-in goToReferences action
  // otherwise swallows Shift+F12 (it has no provider for our models) and only
  // F12 would reach our editor command. Capture also covers the non-editor area
  // of the page, where the editor never sees the key at all.
  React.useEffect(() => {
    const onF12 = (event) => {
      if (event.key !== 'F12' || event.altKey || event.ctrlKey || event.metaKey) return
      if (picker || event.repeat) return
      try {
        const root = rootRef.current
        if (!root || !(event.target instanceof Node) || !root.contains(event.target)) return
        event.preventDefault()
        event.stopPropagation()
        let position = null
        try {
          const editor = editorControlsRef.current?.getEditor?.()
          position = lspPosition(editor)
        } catch (error) { /* disposed editor */ }
        if (!position || !lspRuntime.model) { notify('请先打开代码文件并选中要查询的符号', 'info'); return }
        if (event.shiftKey) void lspReferences(position.lineNumber, position.column)
        else void lspDefinition(position.lineNumber, position.column)
      } catch (error) {
        log('warn', 'F12 handler failed', error)
      }
    }
    window.addEventListener('keydown', onF12, true)
    return () => window.removeEventListener('keydown', onF12, true)
  }, [picker, notify])

  // Palette entries: the plugin command catalog plus a few view actions.
  const paletteCommands = React.useMemo(() => {
    const list = COMMAND_SPECS.map((spec) => ({ id: spec.id, label: () => t(spec.message), hint: '' }))
    list.push(
      { id: 'shortcuts', label: () => t('action.shortcuts'), hint: 'keys' },
    )
    return list
  }, [t])

  /** Run one command chosen from the palette or a location/outline picker. */
  const pickCommand = React.useCallback((id) => {
    const current = picker
    setPicker(null)
    if (typeof id === 'string' && id.startsWith('loc:') && current && Array.isArray(current.locations)) {
      const location = current.locations[Number(id.slice(4))]
      if (location) pickFile(location.path, location.line, location.column, location)
      return
    }
    if (typeof id === 'string' && id.startsWith('sym:') && current) {
      const symbol = current.symbols?.[Number(id.slice(4))]
      if (symbol) pickFile(activePath, symbol.line, symbol.column)
      return
    }
    const handler = handlersRef.current[id]
    if (typeof handler === 'function') handler()
  }, [picker, pickFile, activePath])

  // Command handlers shared with the official-shortcut dispatcher.
  handlersRef.current = {
    nextChange: () => goToChange(hunkIndex + 1),
    prevChange: () => goToChange(hunkIndex - 1),
    nextTab: () => cycleTab(1),
    prevTab: () => cycleTab(-1),
    closeTab: () => { if (activePath) closeTab(activePath) },
    navBack: () => navigateHistory('back'),
    navForward: () => navigateHistory('forward'),
    toggleTree: () => setTreeOpen((value) => !value),
    fontLarger: () => applyFontSize(fontSizeRef.current + 1),
    fontSmaller: () => applyFontSize(fontSizeRef.current - 1),
    fontReset: () => applyFontSize(13),
    refresh: refreshAll,
    copyPath: copyActivePath,
    officialReview: openOfficialReview,
    openInPreview,
    openReview: () => { if (activePath) openPath(activePath) },
    outline: openOutline,
    lspDiagnostics: () => { void showLspDiagnostics() },
    lspRecheck: () => { setMenuOpen(false); void lspCheckAvailability(true) },
    quickOpen: () => openPicker('quickopen'),
    quickOpenAlt: () => openPicker('quickopen'),
    gotoLine: () => openPicker('line'),
    searchWorkspace: () => openPicker('search'),
    commandPalette: () => openPicker('commands'),
    shortcuts: () => openPicker('keys'),
  }

  // Publish this page as the active command target.
  React.useEffect(() => {
    const controller = {
      sessionId,
      contains: (element) => Boolean(rootRef.current && element && rootRef.current.contains(element)),
      command: (id) => {
        const handler = handlersRef.current[id]
        if (typeof handler !== 'function') return false
        try {
          handler()
          return true
        } catch (error) {
          log('error', 'command failed', id, error)
          return false
        }
      },
    }
    runtimeState.page = controller
    runtimeState.sessionId = sessionId
    return () => {
      if (runtimeState.page === controller) runtimeState.page = null
    }
  }, [sessionId])

  // Keep the latest session id available for the global "open review" command.
  React.useEffect(() => {
    if (sessionId) runtimeState.sessionId = sessionId
  }, [sessionId])

  // Auto-refresh when the turn closes (workspace/changes was appended before
  // turn/end), and when the window regains focus.
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
          if (previous !== undefined && (next === undefined || next !== previous)) void refreshLatest()
          previous = next
        }
        dispose = source.subscribe(listener)
      }
    } catch (error) {
      /* optional signal */
    }
    return () => {
      try {
        if (typeof dispose === 'function') dispose()
      } catch (error) { /* ignore */ }
    }
  }, [sessionId, refreshLatest])

  React.useEffect(() => {
    // Window focus fires constantly while working across apps; a full refresh on
    // every focus repainted the editor and could visibly jump the diff, so it is
    // rate-limited to one check per few seconds.
    let last = 0
    const refresh = () => {
      const now = Date.now()
      if (now - last < 3000) return
      last = now
      void refreshLatest()
    }
    const onVisibility = () => { if (!document.hidden) refresh() }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [refreshLatest])

  // Unmount: cancel in-flight reads.
  React.useEffect(() => () => {
    fileTokenRef.current += 1
    try { abortRef.current?.abort() } catch (error) { /* ignore */ }
  }, [])

  // Tree width drag (rAF-throttled: one state update per frame).
  const startTreeResize = (event) => {
    try {
      event.preventDefault()
    } catch (error) { /* ignore */ }
    const startX = event.clientX
    const startWidth = treeWidth
    let frame = 0
    let pendingWidth = startWidth
    const flush = () => {
      frame = 0
      setTreeWidth(pendingWidth)
    }
    const onMove = (moveEvent) => {
      const delta = startX - moveEvent.clientX
      pendingWidth = Math.min(TREE_WIDTH_MAX, Math.max(TREE_WIDTH_MIN, startWidth + delta))
      if (frame) return
      try { frame = requestAnimationFrame(flush) } catch (error) { flush() }
    }
    const onUp = () => {
      if (frame) {
        try { cancelAnimationFrame(frame) } catch (error) { /* ignore */ }
        frame = 0
        flush()
      }
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // Close the overflow/dropdown menus on outside pointer or Escape. Pointer
  // presses on the trigger wrappers themselves are ignored: otherwise the
  // outside handler closes the menu and the trigger's click toggles it back on,
  // which reads as "the button sometimes does nothing".
  React.useEffect(() => {
    if (!menuOpen && !modeMenuOpen) return undefined
    const onPointer = (event) => {
      try {
        const target = event.target
        if (target instanceof Element) {
          if (target.closest('.drp-dropdown, .drp-dropdown-menu')) return
        }
      } catch (error) { /* ignore */ }
      setMenuOpen(false)
      setModeMenuOpen(false)
    }
    const onKey = (event) => {
      if (event.key === 'Escape') {
        setMenuOpen(false)
        setModeMenuOpen(false)
      }
    }
    window.addEventListener('mousedown', onPointer)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onPointer)
      window.removeEventListener('keydown', onKey)
    }
  }, [menuOpen, modeMenuOpen])

  const monacoReady = Boolean(monaco) && !monacoError
  const modeButtonLabel = mode === 'turn'
    ? (latest && latest.available ? t('mode.turn.withTurn', { turn: String(latest.turn) }) : t('mode.turn'))
    : mode === 'git' ? t('mode.git') : mode === 'revision' ? revisionLabel : t('mode.code')
  const comparisonCurrent = comparison && comparison.path === activePath
    && comparison.snapshotKey === snapshotKey && comparison.generation === cacheGenerationRef.current
    && comparison.key === diffCacheKey(activePath)
  const deletedReady = fileCurrent && file.status === 'missing' && comparisonCurrent
    && comparison.status === 'ready' && comparison.value && comparison.value.kind === 'text'
    && comparison.value.before === true && comparison.value.after === false
    && Array.isArray(comparison.value.hunks)
  const reviewedFile = fileCurrent && file.status === 'ready' ? file
    : deletedReady ? { ...file, status: 'ready' } : null
  const fileReady = Boolean(reviewedFile)
  const missingPending = fileCurrent && file.status === 'missing' && mode !== 'code'
    && (!comparisonCurrent || comparison.status === 'loading')
  React.useEffect(() => {
    // Even a formerly empty document can be deleted without changing the
    // Monaco model's text, so do not rely only on onModelReady for teardown.
    if (deletedReady) lspClearDocument()
  }, [deletedReady, activePath])
  // Historical (= commit) content is a real document for the language server:
  // the Host bridge overlays the shown text, so navigation keeps working. Both
  // directions re-announce it through MonacoHost (the model text can be
  // byte-identical even when the snapshot kind changed).
  const historicalRef = React.useRef(false)
  React.useEffect(() => {
    if (historicalRef.current === historical) return
    historicalRef.current = historical
    setDocumentEpoch((value) => value + 1)
  }, [historical])
  const tabsRow = openTabs.length > 0
    ? h('div', { className: 'drp-tabs', role: 'tablist' }, openTabs.map((path, index) => {
        const isActive = path === activePath
        const showDivider = !isActive && index > 0 && openTabs[index - 1] !== activePath
        return h(
          React.Fragment,
          { key: path },
          showDivider ? h('span', { className: 'drp-tab-divider' }) : null,
          h(
            'div',
            {
              className: cx('drp-tab', isActive && 'drp-tab-active'),
              role: 'tab',
              'aria-selected': isActive,
              title: path,
              onClick: () => openPath(path),
              onAuxClick: (event) => { if (event.button === 1) closeTab(path) },
            },
            h('span', { className: 'drp-tab-fill' }),
            h(FileIcon, { path, scheme }),
            h('span', { className: 'drp-tab-name' }, basename(path)),
            h('span', { className: 'drp-tab-actions' },
              h('button', {
                type: 'button',
                className: 'drp-tab-close',
                title: t('action.closeTab'),
                'aria-label': t('action.closeTab'),
                onClick: (event) => { try { event.stopPropagation() } catch (error) { /* ignore */ } closeTab(path) },
              }, h(Codicon, { char: 'close' }))),
          ),
        )
      }))
    : null

  /**
   * One diff-mode option row inside the mode dropdown.
   * @param {string} id mode id (also the `data-drp-mode` selector)
   * @param {string} label visible row label
   * @param {{checked?:boolean, disabled?:boolean, hint?:string, onPick?:Function}} [options] row options
   * @returns {any} React element
   */
  const modeOption = (id, label, options) => {
    const { checked, disabled, hint, onPick } = options || {}
    const active = typeof checked === 'boolean' ? checked : mode === id
    return h('button', {
      key: id,
      type: 'button',
      role: 'menuitemradio',
      'data-drp-mode': id,
      'aria-checked': active,
      className: cx('drp-menu-item', active && 'drp-menu-item-on'),
      title: hint || label,
      disabled: disabled === true,
      onClick: disabled === true ? undefined : () => {
        if (typeof onPick === 'function') onPick()
        else {
          setMode(id)
          setModeTouched(true)
        }
        setModeMenuOpen(false)
      },
    }, (active ? '✓ ' : '   ') + label)
  }

  // Diff-mode dropdown: turn, uncommitted, latest commit (one click), any git
  // version (picker), code-only.
  const gitAvailable = gitStatus && gitStatus.available === true
  const revisionIsHead = mode === 'revision' && Boolean(revision) && revision.sha === 'HEAD'
  const modeMenu = modeMenuOpen
    ? h('div', {
        className: 'drp-dropdown-menu',
        role: 'menu',
        onMouseDown: (event) => { try { event.stopPropagation() } catch (error) { /* ignore */ } },
      },
        modeOption('turn', latest && latest.available ? t('mode.turn.withTurn', { turn: String(latest.turn) }) : t('mode.turn'), {
          disabled: !(latest && latest.available),
          hint: latest && latest.available ? undefined : t('mode.turn.unavailable'),
        }),
        modeOption('git', t('mode.git'), {
          disabled: !gitAvailable,
          hint: gitAvailable ? t('mode.git') : t('mode.git.unavailable'),
        }),
        modeOption('revision-head', t('mode.commit'), {
          checked: revisionIsHead,
          disabled: !gitAvailable,
          hint: t('mode.commit.hint'),
          onPick: () => applyRevision({ sha: 'HEAD', short: 'HEAD', subject: t('mode.commit') }, 'commit'),
        }),
        modeOption('revision', revisionLabel, {
          checked: mode === 'revision' && Boolean(revision) && !revisionIsHead,
          hint: t('mode.revision.pick.hint'),
          onPick: () => {
            if (revision && mode !== 'revision') {
              // Already resolved once: re-enter the revision baseline directly,
              // keeping the chosen version and scope.
              setMode('revision')
              setModeTouched(true)
              return
            }
            openPicker('revisions')
          },
        }),
        modeOption('code', t('mode.code')),
      )
    : null

  const menu = menuOpen
    ? h(
        'div',
        {
          className: 'drp-dropdown-menu',
          role: 'menu',
          onMouseDown: (event) => { try { event.stopPropagation() } catch (error) { /* ignore */ } },
        },
        h('button', { type: 'button', className: 'drp-menu-item', onClick: () => { applyFontSize(fontSizeRef.current + 1); } }, t('action.fontLarger') + '  +'),
        h('button', { type: 'button', className: 'drp-menu-item', onClick: () => { applyFontSize(fontSizeRef.current - 1); } }, t('action.fontSmaller') + '  −'),
        h('button', { type: 'button', className: 'drp-menu-item', onClick: () => { applyFontSize(13); setMenuOpen(false) } }, t('action.fontReset') + '  (' + String(fontSize) + 'px)'),
        h('div', { className: 'drp-menu-sep' }),
        h('button', { type: 'button', className: 'drp-menu-item', onClick: () => { openInPreview(); setMenuOpen(false) } }, t('action.openInPreview')),
        h('button', { type: 'button', className: 'drp-menu-item', onClick: () => { void openOutline() } }, t('cmd.outline')),
        h('button', { type: 'button', className: 'drp-menu-item', onClick: () => { void showLspDiagnostics() } }, 'LSP 诊断'),
        h('button', { type: 'button', className: 'drp-menu-item', onClick: () => handlersRef.current.lspRecheck() }, t('lsp.recheck')),
        h('button', { type: 'button', className: 'drp-menu-item', onClick: () => openPicker('keys') }, t('action.shortcuts')),
      )
    : null

  const pickerItems = React.useMemo(() => {
    if (!picker) return []
    if (picker.mode === 'locations') {
      return (picker.locations || []).map((location, index) => ({
        id: 'loc:' + index,
        label: () => location.path + ':' + location.line + ':' + location.column,
        hint: '',
      }))
    }
    if (picker.mode === 'outline') {
      return (picker.symbols || []).map((symbol, index) => ({
        id: 'sym:' + index,
        label: () => '  '.repeat(Math.max(0, symbol.depth || 0)) + symbol.name,
        hint: symbol.detail || '',
      }))
    }
    return null
  }, [picker])

  const pickerNode = picker
    ? h(PickerOverlay, {
        mode: picker.mode,
        locationKind: picker.kind,
        t,
        sessionId,
        commands: pickerItems || (picker.mode === 'keys' ? buildKeyHelp(t) : paletteCommands),
        activePath,
        lineCount: fileReady ? file.lines : 0,
        // Revisions picker contract (optional props for every other mode).
        revisionScope: picker.mode === 'revisions' ? (picker.scope || 'commit') : undefined,
        onRevisionScopeChange: changeRevisionScope,
        onPickRevision: pickRevision,
        onPickFile: pickFile,
        onPickCommand: pickCommand,
        onClose: () => setPicker(null),
      })
    : null

  // VS Code–style notification: one click on 安装 confirms and sends the install
  // request to the Agent; the card closes once the request is submitted.
  const lspBanner = lspMissing
    ? h('div', { className: 'drp-lsp-toast', role: 'alertdialog', 'aria-label': t('lsp.askAgent') },
        h('div', { className: 'drp-lsp-toast-head' },
          h('span', { className: 'drp-lsp-toast-title' }, t('lsp.toastTitle', { language: lspMissing.language })),
          h('button', { type: 'button', className: 'drp-icon-btn', title: t('common.close'), onClick: () => { lspForgetMissing(); setLspMissing(null) } }, '✕')),
        h('div', { className: 'drp-lsp-toast-body' }, t('lsp.toastBody')),
        h('code', { className: 'drp-lsp-toast-cmd', title: lspMissing.install }, lspMissing.install),
        h('div', { className: 'drp-lsp-toast-actions' },
          h('button', { type: 'button', className: 'drp-btn drp-btn-primary', onClick: () => { void installLspFromAgent() } }, t('lsp.install')),
          h('button', { type: 'button', className: 'drp-btn', onClick: () => { void copyLspInstall() } }, t('lsp.copyInstall')),
          h('button', { type: 'button', className: 'drp-btn', onClick: () => { void lspCheckAvailability(true) } }, t('lsp.recheck')),
        ),
      )
    : null

  // The Monaco host stays mounted for the whole page lifetime. A file switch only
  // swaps the model inside the existing editor, so the previous file's scroll
  // position survives and the new content/diff paints immediately (the old code
  // unmounted the editor on every switch, recreating it and jumping to line 1).
  const editorCard = h(MonacoHost, {
    monaco,
    file: reviewedFile,
    regions: fileReady && comparisonCurrent ? regions : [],
    sessionId,
    wrap: false,
    minimap: false,
    fontSize,
    reveal,
    scheme,
    documentEpoch,
    onCursor: (position) => cursorStore.set(position),
    onRequestLine: () => openPicker('line'),
    onRequestOutline: () => { void openOutline() },
    onModelReady: (info) => {
      if (reviewedFile && reviewedFile.missing) {
        lspClearDocument()
        return
      }
      // Derive the LSP language from the file extension (Monaco's model
      // language depends on which tokenizers are registered and can be
      // plaintext); the bridge needs the language server's language id.
      // Historical content is handed over too: the bridge overlays this text,
      // so go-to-definition/references/hover/symbols work on the old snapshot
      // (diagnostics stay suppressed for it, see lspSetDocument).
      lspSetDocument({
        path: info.path,
        text: info.text,
        languageId: languageOf(info.path),
        monaco: info.monaco,
        model: info.model,
        sessionId,
        cwd: cwdFromStore,
        historical,
      })
      void lspCheckAvailability()
    },
    onLsp: (kind, line, column) => { if (kind === 'definition') void lspDefinition(line, column); else if (kind === 'references') void lspReferences(line, column) },
    onReady: (controls) => {
      editorControlsRef.current = controls
      if (controls && typeof controls.setFontSize === 'function') controls.setFontSize(fontSizeRef.current)
    },
    onError: (error) => setMonacoError(error),
  })

  const codeArea = !activePath
    ? h(EmptyState, { t, latest })
    : fileCurrent && file.status === 'handoff'
      ? h(HandoffCard, {
          sessionId,
          path: activePath,
          kind: file.kind,
          t,
          right,
          absolutePath: file.absolutePath,
          bytes: file.bytes,
        })
      : fileCurrent && (file.status === 'error' || (file.status === 'missing' && !deletedReady && !missingPending))
        ? h('div', { className: 'drp-empty' },
            h('div', { className: 'drp-empty-title' }, t('empty.error')),
            h('div', { className: 'drp-empty-body' }, file.error || ''),
            h('button', { type: 'button', className: 'drp-btn', onClick: () => loadFile(activePath, { force: true }) }, t('empty.retry')))
        : monacoError
          ? h('div', { className: 'drp-empty' },
              h('div', { className: 'drp-empty-title' }, t('empty.error')),
              h('div', { className: 'drp-empty-body' }, String(monacoError && monacoError.message ? monacoError.message : monacoError)))
          : h(React.Fragment, null,
              monacoReady ? editorCard : null,
              !monacoReady || !fileReady
                ? h('div', { className: 'drp-loading drp-loading-overlay' },
                    h('span', { className: 'drp-spinner' }),
                    latestLoading || (file && file.status === 'loading') ? t('status.loadingFile') : t('common.loading'))
                : null,
            )

  const revisionFileCount = revisionData && revisionData.available === true && Array.isArray(revisionData.files) ? revisionData.files.length : 0
  const revisionStatusText = revisionLoading || !revisionData
    ? t('status.revision.loading')
    : revisionData.available !== true
      ? t('status.revision.unavailable')
      : revisionData.scope === 'since'
        ? t('status.revision.since', {
            base: revisionData.base ? revisionData.base.short : '',
            count: String(revisionFileCount),
          })
        : t('status.revision.commit', {
            ref: revisionData.target ? revisionData.target.short : '',
            base: revisionData.base ? revisionData.base.short : '',
            count: String(revisionFileCount),
            historical: historical ? t('status.revision.historical') : t('status.revision.worktree'),
          })

  const statusText = status
    ? status.text
    : file && file.status === 'loading'
      ? t('status.loadingFile')
      : comparison && comparison.status === 'loading'
        ? t('status.diffLoading')
        : comparisonCurrent && comparison.status === 'unavailable' && comparison.kind === 'oversized'
          ? t('status.diffOversized')
          : mode === 'turn'
            ? (latest && latest.available
              ? t('status.mode.turn', { turn: String(latest.turn), seq: String(latest.seq) })
              : t('status.mode.turn.stale'))
            : mode === 'git'
              ? t('status.mode.git')
              : mode === 'revision'
                ? revisionStatusText
                : t('status.mode.code')

  const gitStatusText = mode === 'revision'
    ? (historical ? t('status.revision.historical') : t('status.revision.worktree'))
    : mode === 'git' && gitStatus
      ? (gitStatus.available === true
        ? t('status.git', { count: String((gitStatus.files || []).length) })
        : t('status.git.unavailable'))
      : null

  const treeNode = h(FileTree, {
    sessionId,
    cwd: cwdFromStore,
    summaryFiles: summary ? summary.files : null,
    gitStatus: mode === 'revision' ? revisionData : gitStatus,
    changedOnly,
    activePath,
    treeMode: mode === 'revision' ? 'revision' : mode,
    onOpen: (path) => openPath(path),
    onToggleChangedOnly: (value) => setChangedOnly(value),
    reveal: null,
    refreshToken: treeRefreshToken,
    onPreview: (path) => openInPreview(path),
    onNotify: (text, kind) => notify(text, kind),
    t,
    scheme,
  })

  // Solid popover surfaces per scheme: DSH menu/overlay tokens are translucent,
  // which reads as washed-out over the code area (user report). All plugin
  // popovers therefore use opaque plugin-owned colors derived from the scheme.
  const solidTheme = scheme === 'light'
    ? {
        '--drp-panel-bg': '#ffffff',
        '--drp-panel-bg-2': '#f3f4f6',
        '--drp-panel-border': 'rgba(31, 35, 40, 0.16)',
        '--drp-panel-text': '#1f2328',
        '--drp-git-M': '#9a6700',
        '--drp-git-A': '#1a7f37',
        '--drp-git-D': '#cf222e',
        '--drp-git-U': '#0969da',
        '--drp-git-R': '#0969da',
      }
    : {
        '--drp-panel-bg': '#1c2128',
        '--drp-panel-bg-2': '#22272e',
        '--drp-panel-border': 'rgba(240, 246, 252, 0.16)',
        '--drp-panel-text': '#e6edf3',
        '--drp-git-M': '#e3b341',
        '--drp-git-A': '#56d364',
        '--drp-git-D': '#ff7b72',
        '--drp-git-U': '#79c0ff',
        '--drp-git-R': '#79c0ff',
      }

  return h(
    'div',
    {
      className: cx('drp-root', narrow && 'drp-root-narrow'),
      ref: rootRef,
      'data-drp-view': '1',
      'data-dsh-review-panel-page': '1',
      'data-drp-scheme': scheme,
      style: solidTheme,
    },
    h(
      'div',
      { className: 'drp-main' },
      tabsRow,
      h(
        'div',
        { className: 'drp-toolbar' },
        h(
          'div',
          { className: 'drp-toolbar-row' },
          h(IconButton, { title: t('action.quickOpen'), label: h(Codicon, { char: 'search' }), onClick: () => openPicker('quickopen') }),
          h('span', { className: 'drp-path', title: activePath || t('tab.title') }, activePath ? ellipsisMiddle(activePath, narrow ? 24 : 46) : t('tab.title')),
          h('span', { className: 'drp-spacer' }),
          h(
            'div',
            { className: 'drp-dropdown' },
            h('button', {
              type: 'button',
              className: cx('drp-mode-btn', modeMenuOpen && 'drp-mode-btn-open'),
              title: modeLabel,
              onClick: () => { setModeMenuOpen((value) => !value); setMenuOpen(false) },
            },
            h('span', { className: 'drp-mode-label' }, modeButtonLabel),
            h(Codicon, { char: 'chevronDown', className: 'drp-caret' })),
            modeMenu,
          ),
          h(IconButton, { title: t('action.officialReview'), label: h(Codicon, { char: 'diff' }), onClick: openOfficialReview, disabled: !(latest && latest.available) }),
          h(IconButton, { title: t('action.refresh'), label: h(Codicon, { char: 'refresh' }), onClick: refreshAll }),
          h(IconButton, {
            title: (treeOpen ? t('tree.hide') : t('tree.show')) + '  (' + shortcutModifierLabel('primary') + '+Shift+E)',
            label: h(Codicon, { char: 'files' }),
            active: treeOpen,
            onClick: () => setTreeOpen((value) => !value),
          }),
          h(
            'div',
            { className: 'drp-dropdown' },
            h(IconButton, { title: t('action.more'), label: h(Codicon, { char: 'ellipsis' }), onClick: () => { setMenuOpen((value) => !value); setModeMenuOpen(false) } }),
            menu,
          ),
        ),
      ),
      lspBanner,
      h('div', { className: 'drp-body' }, codeArea),
      h(ReviewStatusBar, { statusText, file: reviewedFile, gitText: gitStatusText, t, narrow }),
      pickerNode,
    ),
    narrow
      ? treeOpen
        ? h('div', { className: 'drp-drawer-overlay', onClick: () => setTreeOpen(false) },
            h('div', { className: 'drp-drawer', style: { width: Math.max(TREE_WIDTH_MIN, Math.min(TREE_WIDTH_MAX, treeWidth)) + 'px' }, onClick: (event) => { try { event.stopPropagation() } catch (error) { /* ignore */ } } },
              treeNode,
            ))
        : null
      : treeVisible
        ? h(React.Fragment, null,
            h('div', { className: 'drp-tree-resizer', title: t('status.treeWidth', { width: String(treeWidth) }), onMouseDown: startTreeResize }),
            h('div', { className: 'drp-tree-panel', style: { width: treeWidth + 'px' } }, treeNode),
          )
        : null,
  )
}

/**
 * The tab-kind body: reads the tab record via `useTabInfo()` and renders the page.
 * Keyed by session: a different conversation gets a fresh page instance, whose
 * mount restores that session's remembered tabs/baseline from `pageSessionStore`.
 * @param {object} props slot props
 * @returns {any} React element
 */
function ReviewTabBody(props) {
  const { sessionId, t, useSessions, useTabInfo, services } = props
  let tab = null
  try {
    if (typeof useTabInfo === 'function') tab = useTabInfo().tab
  } catch (error) {
    tab = null
  }
  const address = tab && tab.contentId ? tab.contentId : null
  return h(ReviewPage, {
    key: sessionId,
    sessionId,
    t,
    useSessions,
    useTabInfo,
    services,
    address,
  })
}

/**
 * Degraded central-view body (when the right sidebar services are unavailable).
 * @param {object} props slot props
 * @returns {any} React element
 */
function ReviewViewBody(props) {
  const { sessionId, t, useSessions, services } = props
  return h('div', { className: 'drp-view-wrap' },
    h('div', { className: 'drp-view-hint' }, t('error.sidebarUnavailable')),
    h(ReviewPage, { key: sessionId, sessionId, t, useSessions, services, address: null }),
  )
}
