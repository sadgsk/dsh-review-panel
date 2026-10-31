/* dsh-review-panel client half — lazy workspace file tree styled like the VS Code Explorer. */

/** Monaco language id → VS Code/Seti language id (only the ones that differ). */
const SETI_LANG_ALIAS = {
  shell: 'shellscript',
  bat: 'bat',
  dockerfile: 'dockerfile',
  plaintext: '',
}

/** Codicon codepoints used by the page chrome (from the Monaco codicon font). */
const CODICON_GLYPHS = {
  chevronRight: '\uEAB6',
  chevronDown: '\uEAB4',
  close: '\uEA76',
  ellipsis: '\uEA7C',
  search: '\uEA6D',
  refresh: '\uEB37',
  diff: '\uEAE1',
  files: '\uEAF0',
  filter: '\uEAF1',
  add: '\uEA60',
}

/**
 * Resolve the Seti file icon for one path (VS Code icon theme precedence:
 * exact file name, longest extension chain, language id, default file icon).
 * @param {string} path workspace-relative or absolute path
 * @param {'light'|'dark'} scheme active color scheme
 * @returns {{char:string,color:string,lightColor:string,lightChar?:string}|null}
 */
function vscodeIconFor(path, scheme) {
  const theme = typeof VSCODE_ICON_THEME !== 'undefined' ? VSCODE_ICON_THEME : null
  if (!theme) return null
  let icon = theme.forPath(path)
  if (!icon) {
    const language = (typeof languageOf === 'function' ? languageOf(path) : '') || ''
    const alias = Object.prototype.hasOwnProperty.call(SETI_LANG_ALIAS, language) ? SETI_LANG_ALIAS[language] : language
    icon = alias ? theme.languageIds[alias] : undefined
  }
  if (!icon) icon = theme.file
  return icon || null
}

/**
 * One VS Code codicon glyph (chevrons, close, ellipsis…).
 * @param {object} props `char` glyph key, `size` optional font size
 * @returns {any} React element
 */
function Codicon(props) {
  const { char, size, className } = props
  return h('span', {
    className: cx('drp-codicon', className),
    style: size ? { fontSize: size } : undefined,
    'aria-hidden': true,
  }, CODICON_GLYPHS[char] || '')
}

/**
 * One Seti file icon at VS Code metrics (16 px box, 6 px gap, 150 % glyph).
 * @param {object} props `path` file path, `scheme` active scheme
 * @returns {any} React element
 */
function FileIcon(props) {
  const { path, scheme } = props
  const icon = vscodeIconFor(path, scheme)
  if (!icon) return h('span', { className: 'drp-tree-icon' })
  const char = icon.lightChar && scheme === 'light' ? icon.lightChar : icon.char
  const color = scheme === 'light' ? icon.lightColor || icon.color : icon.color
  return h('span', {
    className: 'drp-tree-icon drp-seti-icon',
    style: { color },
    'data-drp-icon': char,
  }, char)
}

/**
 * Build a map of normalized path → change badge data.
 * @param {Array<object> | null} files summary files
 * @param {boolean} enabled whether badges are shown
 * @returns {Map<string, object>}
 */
function changedMapOf(files, enabled) {
  const map = new Map()
  if (!enabled || !Array.isArray(files)) return map
  for (const file of files) {
    if (!file || typeof file.path !== 'string') continue
    const key = normalizeRel(file.path)
    if (key !== '') map.set(key, file)
  }
  return map
}

/**
 * One change badge: +added −deleted, or a binary/oversized marker.
 * @param {object} file changed-file record
 * @returns {any} React element
 */
function ChangeBadge(file) {
  if (file.binary === true) return h('span', { className: 'drp-badge drp-badge-muted', title: 'binary' }, 'bin')
  if (file.oversized === true) return h('span', { className: 'drp-badge drp-badge-muted', title: 'too large' }, 'big')
  return h(
    'span',
    { className: 'drp-badge' },
    h('span', { className: 'drp-badge-add' }, '+' + fmtInt(file.added)),
    h('span', { className: 'drp-badge-del' }, '−' + fmtInt(file.deleted)),
  )
}

/**
 * Build an absolute host path from the session cwd and a workspace-relative path.
 * @param {string | undefined} cwd session working directory
 * @param {string} rel workspace-relative posix path
 * @returns {string} absolute path using the cwd's separators
 */
function absolutePathOf(cwd, rel) {
  const root = String(cwd || '').replace(/[\\/]+$/, '')
  const tail = String(rel || '').replace(/^[\\/]+/, '')
  if (!root) return tail
  const separator = root.includes('\\') ? '\\' : '/'
  return root + separator + (separator === '\\' ? tail.replace(/\//g, '\\') : tail)
}

/**
 * One git status letter badge (M/A/D/R/C/U), coloured like VS Code's
 * git decorations. Diff-range statuses are folded onto the four badge colours
 * (`T` type change reads as modified, `U`/`?`/anything else as unmerged).
 * @param {{path:string, code:string}} entry git status record
 * @returns {any} React element
 */
function GitBadge(entry) {
  const raw = typeof entry.code === 'string' ? entry.code : ''
  const code = raw === 'T' ? 'M' : /^[MADRC]$/.test(raw) ? raw : 'U'
  const className = code === 'U' ? 'drp-git-other' : 'drp-git-' + code
  return h('span', { className: cx('drp-git-badge', className), title: 'Git: ' + (raw || '?') }, code)
}

/**
 * Indentation (px) of a row's left edge inside the tree, matching VS Code:
 * 0 for depth 0, then `8 + (depth-1)*8` (the 4 px row inset comes from CSS).
 * @param {number} depth zero-based row depth
 * @returns {number}
 */
function treeIndentOf(depth) {
  const level = Math.max(0, Number(depth) || 0)
  return level === 0 ? 0 : 8 + (level - 1) * 8
}

/**
 * A directory row plus its lazily loaded children. The implicit workspace root
 * is not rendered as a row (VS Code's Explorer lists the top-level entries
 * directly under the section header).
 * @param {object} props component props
 * @returns {any} React element
 */
function TreeDir(props) {
  const { relPath, depth, expanded, loadState, onToggle, onOpen, onContextMenu, activePath, changed, badgesEnabled, gitBadges, scheme } = props
  const isExpanded = expanded.has(relPath)
  const state = loadState(relPath)
  const children = state && Array.isArray(state.entries) ? state.entries : []
  const content = []
  if (state && state.status === 'loading' && children.length === 0) {
    content.push(h('div', {
      key: relPath + '::loading',
      className: 'drp-tree-note',
      style: { paddingLeft: (treeIndentOf(depth + 1) + 22) + 'px' },
    }, '…'))
  }
  for (const entry of children) {
    const childRel = joinRel(relPath, entry.name)
    if (entry.type === 'directory') {
      content.push(h(TreeDir, {
        key: childRel,
        relPath: childRel,
        depth: depth + 1,
        expanded,
        loadState,
        onToggle,
        onOpen,
        onContextMenu,
        activePath,
        changed,
        badgesEnabled,
        gitBadges,
        scheme,
      }))
      continue
    }
    const badge = badgesEnabled ? changed.get(childRel) : undefined
    const gitEntry = gitBadges ? gitBadges.get(childRel) : undefined
    const isActive = activePath === childRel
    content.push(h(
      'div',
      {
        key: childRel,
        className: cx('drp-tree-row drp-tree-file', isActive && 'drp-tree-active'),
        style: { paddingLeft: treeIndentOf(depth + 1) + 'px' },
        onClick: () => onOpen(childRel),
        onContextMenu: (event) => onContextMenu(event, childRel),
        title: childRel + (gitEntry ? '\nGit: ' + gitEntry.code : ''),
        role: 'treeitem',
        'data-drp-path': childRel,
      },
      h('span', { className: 'drp-tree-twisty' }),
      h(FileIcon, { path: childRel, scheme }),
      h('span', { className: 'drp-tree-name' }, entry.name),
      gitEntry ? GitBadge(gitEntry) : null,
      badge ? h(ChangeBadge, badge) : null,
    ))
  }
  if (state && state.truncated) {
    content.push(h('div', {
      key: relPath + '::truncated',
      className: 'drp-tree-note',
      style: { paddingLeft: (treeIndentOf(depth + 1) + 22) + 'px' },
    }, '… truncated'))
  }
  if (relPath === '') {
    // Implicit workspace root: only its children are rendered.
    return h('div', { className: 'drp-tree-branch drp-tree-root' }, content)
  }
  return h(
    'div',
    { className: 'drp-tree-branch' },
    h(
      'div',
      {
        className: cx('drp-tree-row drp-tree-dir', isExpanded && 'drp-tree-dir-open'),
        style: { paddingLeft: treeIndentOf(depth) + 'px' },
        onClick: () => onToggle(relPath),
        role: 'treeitem',
        'aria-expanded': isExpanded,
        'data-drp-dir': relPath,
        title: relPath,
      },
      h('span', { className: cx('drp-tree-twisty', isExpanded && 'drp-tree-twisty-open') },
        h(Codicon, { char: isExpanded ? 'chevronDown' : 'chevronRight' })),
      h('span', { className: 'drp-tree-name' }, basename(relPath)),
      state && state.status === 'loading' ? h('span', { className: 'drp-tree-note' }, '…') : null,
      state && state.status === 'error' ? h('span', { className: 'drp-tree-note drp-tree-error' }, '!') : null,
    ),
    isExpanded ? h('div', { className: 'drp-tree-children' }, content) : null,
  )
}

/**
 * Workspace tree panel: lazy directories, change badges, "changes only" flat list,
 * reveal-in-tree and manual refresh. Visual metrics follow VS Code's Explorer
 * (22 px rows, 8 px indent, 13 px UI font, Seti icons, 28 px section header).
 * @param {object} props component props
 * @returns {any} React element
 */
function FileTree(props) {
  const {
    sessionId, cwd, summaryFiles, gitStatus, changedOnly, activePath, treeMode,
    onOpen, onToggleChangedOnly, reveal, refreshToken, t, onPreview, onNotify, scheme,
  } = props
  const activeScheme = scheme === 'light' ? 'light' : 'dark'
  const [expanded, setExpanded] = React.useState(() => new Set(['']))
  const [cache, setCache] = React.useState(() => new Map())
  const [error, setError] = React.useState(null)
  const [ctxMenu, setCtxMenu] = React.useState(null)
  const loadingRef = React.useRef(new Map())
  const generationRef = React.useRef(0)
  const rootRef = React.useRef(null)
  const gitBadges = React.useMemo(() => {
    if ((treeMode !== 'git' && treeMode !== 'revision') || !gitStatus || gitStatus.available !== true) return null
    const map = new Map()
    for (const entry of Array.isArray(gitStatus.files) ? gitStatus.files : []) {
      if (!entry || typeof entry.path !== 'string') continue
      const key = normalizeRel(entry.path)
      if (key !== '') map.set(key, entry)
    }
    return map
  }, [treeMode, gitStatus])
  const cacheRef = React.useRef(cache)
  cacheRef.current = cache
  const expandedRef = React.useRef(expanded)
  expandedRef.current = expanded
  const changed = React.useMemo(() => changedMapOf(summaryFiles, treeMode === 'turn'), [summaryFiles, treeMode])

  /** Open the tree context menu at the pointer for one file row. */
  const showContextMenu = React.useCallback((event, relPath) => {
    try {
      event.preventDefault()
      event.stopPropagation()
    } catch (error) { /* ignore */ }
    const width = 196
    const height = 168
    const x = Math.max(4, Math.min(Number(event.clientX) || 0, (window.innerWidth || 1024) - width - 4))
    const y = Math.max(4, Math.min(Number(event.clientY) || 0, (window.innerHeight || 768) - height - 4))
    setCtxMenu({ x, y, path: normalizeRel(relPath) })
  }, [])

  // Close the context menu on outside pointer, Escape, scroll or resize.
  React.useEffect(() => {
    if (!ctxMenu) return undefined
    const close = () => setCtxMenu(null)
    const onPointer = (event) => {
      try {
        const target = event.target
        const menu = rootRef.current && rootRef.current.querySelector('.drp-ctx-menu')
        if (menu && target instanceof Node && menu.contains(target)) return
      } catch (error) { /* ignore */ }
      close()
    }
    const onKey = (event) => { if (event.key === 'Escape') close() }
    window.addEventListener('mousedown', onPointer)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('mousedown', onPointer)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [ctxMenu])

  /** Copy one path from the context menu and notify the page. */
  const copyFromMenu = async (relPath, absolute) => {
    const value = absolute ? absolutePathOf(cwd, relPath) : relPath
    const ok = await copyText(value)
    setCtxMenu(null)
    if (typeof onNotify === 'function') onNotify(ok ? t('common.copied') + '：' + value : t('action.copyPath'), ok ? 'info' : 'warn')
  }

  /**
   * Read one cached directory state.
   * @param {string} relPath directory path
   * @returns {object | undefined}
   */
  const loadState = (relPath) => cache.get(relPath)

  /** Retire every request before replacing the cache or workspace. */
  const cancelLoads = React.useCallback(() => {
    generationRef.current += 1
    for (const controller of loadingRef.current.values()) {
      try { controller?.abort() } catch (error) { /* ignore */ }
    }
    loadingRef.current = new Map()
  }, [])

  /**
   * Load one directory's direct children (idempotent while in flight).
   * @param {string} relPath directory path
   */
  const loadDir = React.useCallback((relPath) => {
    if (!sessionId || !cwd) return
    if (loadingRef.current.has(relPath)) return
    const existing = cacheRef.current.get(relPath)
    if (existing && (existing.status === 'ready' || existing.status === 'loading')) return
    const generation = generationRef.current
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    loadingRef.current.set(relPath, controller)
    cacheRef.current.set(relPath, { status: 'loading', entries: [] })
    setCache(new Map(cacheRef.current))
    apiGet('tree', { sessionId, path: relPath }, controller ? controller.signal : undefined)
      .then((listing) => {
        if (generation !== generationRef.current) return
        const entries = Array.isArray(listing && listing.entries) ? listing.entries.slice() : []
        const sorted = entries.sort((a, b) => {
          const aDir = a.type === 'directory' ? 0 : 1
          const bDir = b.type === 'directory' ? 0 : 1
          if (aDir !== bDir) return aDir - bDir
          return String(a.name).localeCompare(String(b.name))
        })
        cacheRef.current.set(relPath, { status: 'ready', entries: sorted, truncated: listing && listing.truncated === true })
        setError(null)
      })
      .catch((failure) => {
        if (generation !== generationRef.current) return
        cacheRef.current.set(relPath, { status: 'error', entries: [] })
        setError(failure && failure.message ? failure.message : String(failure))
      })
      .finally(() => {
        // An older finally must not clear a newer in-flight request for the
        // same directory, even when the old transport ignored cancellation.
        if (generation !== generationRef.current) return
        loadingRef.current.delete(relPath)
        setCache(new Map(cacheRef.current))
      })
  }, [sessionId, cwd])

  /**
   * Refresh every visible directory while keeping the expansion state.
   * Dropping the cache alone would leave expanded directories empty (they only
   * load on first expand), so every expanded directory is re-requested here.
   */
  const refreshTree = React.useCallback(() => {
    cancelLoads()
    cacheRef.current = new Map()
    setCache(new Map())
    setError(null)
    const dirs = new Set(expandedRef.current)
    dirs.add('')
    for (const dir of dirs) loadDir(dir)
  }, [loadDir, cancelLoads])

  // Page-level refresh (single toolbar ⟳) drives the tree through this token.
  const lastRefreshRef = React.useRef(refreshToken)
  React.useEffect(() => {
    if (refreshToken === undefined) return
    if (lastRefreshRef.current === refreshToken) return
    lastRefreshRef.current = refreshToken
    refreshTree()
  }, [refreshToken, refreshTree])

  // Reset when the session/workspace changes.
  React.useEffect(() => {
    cancelLoads()
    cacheRef.current = new Map()
    setCache(new Map())
    expandedRef.current = new Set([''])
    setExpanded(expandedRef.current)
    setError(null)
    if (sessionId && cwd) loadDir('')
    return cancelLoads
  }, [sessionId, cwd, loadDir, cancelLoads])

  // Auto-expand ancestors of the active file.
  React.useEffect(() => {
    if (!activePath) return
    const parts = segmentsOf(activePath)
    parts.pop()
    const next = new Set(expandedRef.current)
    let prefix = ''
    for (const segment of parts) {
      prefix = prefix === '' ? segment : prefix + '/' + segment
      next.add(prefix)
    }
    expandedRef.current = next
    setExpanded(next)
    for (const dir of next) loadDir(dir)
  }, [activePath, loadDir])

  // Reveal request: expand ancestors, then scroll the row into view.
  const revealNonce = reveal && reveal.nonce
  React.useEffect(() => {
    if (!reveal || !reveal.path) return
    const parts = segmentsOf(reveal.path)
    parts.pop()
    const next = new Set(expandedRef.current)
    let prefix = ''
    for (const segment of parts) {
      prefix = prefix === '' ? segment : prefix + '/' + segment
      next.add(prefix)
    }
    expandedRef.current = next
    setExpanded(next)
    for (const dir of next) loadDir(dir)
    const timer = setTimeout(() => {
      try {
        const node = rootRef.current && rootRef.current.querySelector('[data-drp-path="' + String(reveal.path).replace(/"/g, '\\"') + '"]')
        if (node && node.scrollIntoView) node.scrollIntoView({ block: 'center' })
      } catch (err) { /* ignore */ }
    }, 120)
    return () => clearTimeout(timer)
  }, [revealNonce, reveal && reveal.path, loadDir])

  /**
   * Toggle one directory open/closed.
   * @param {string} relPath directory path
   */
  const toggle = (relPath) => {
    const next = new Set(expandedRef.current)
    if (next.has(relPath)) next.delete(relPath)
    else {
      next.add(relPath)
      loadDir(relPath)
    }
    expandedRef.current = next
    setExpanded(next)
  }

  /**
   * Open one file row.
   * @param {string} relPath file path
   */
  const open = (relPath) => {
    onOpen(relPath)
  }

  const changedFiles = React.useMemo(() => {
    if (treeMode === 'git' || treeMode === 'revision') {
      const list = gitStatus && gitStatus.available === true && Array.isArray(gitStatus.files) ? gitStatus.files : []
      return list
        .map((file) => ({ ...file, rel: normalizeRel(file.path), display: file.path }))
        .filter((file) => file.rel !== '')
        .sort((a, b) => a.rel.localeCompare(b.rel))
    }
    if (!Array.isArray(summaryFiles)) return []
    return summaryFiles
      .map((file) => ({ ...file, rel: normalizeRel(file.path) }))
      .filter((file) => file.rel !== '')
      .sort((a, b) => a.rel.localeCompare(b.rel))
  }, [summaryFiles, gitStatus, treeMode])

  const rootName = cwd ? basename(cwd) : t('toolbar.tree.all')
  const headerTitle = changedOnly ? t('toolbar.tree.changedOnly') : rootName

  return h(
    'div',
    { className: 'drp-tree', ref: rootRef, 'data-drp-scheme': activeScheme },
    h(
      'div',
      { className: 'drp-tree-head' },
      h('span', { className: 'drp-tree-head-chevron' }, h(Codicon, { char: 'chevronDown' })),
      h('span', { className: 'drp-tree-title', title: cwd || headerTitle }, headerTitle),
      h(
        'button',
        {
          type: 'button',
          className: cx('drp-tree-action', changedOnly && 'drp-tree-action-on'),
          title: changedOnly ? t('toolbar.tree.all') : t('toolbar.tree.changedOnly'),
          onClick: () => onToggleChangedOnly(!changedOnly),
        },
        h(Codicon, { char: changedOnly ? 'files' : 'filter' }),
      ),
    ),
    error ? h('div', { className: 'drp-tree-note drp-tree-error', style: { padding: '4px 8px' } }, error) : null,
    changedOnly
      ? h(
          'div',
          { className: 'drp-tree-body' },
          changedFiles.length === 0
            ? h('div', { className: 'drp-tree-empty' }, treeMode === 'git' || treeMode === 'revision' ? t('tree.noChanges') : t('pill.none'))
            : changedFiles.map((file) => {
                const isActive = activePath === file.rel
                return h(
                  'div',
                  {
                    key: file.rel,
                    className: cx('drp-tree-row drp-tree-file', isActive && 'drp-tree-active'),
                    onClick: () => open(file.rel),
                    onContextMenu: (event) => showContextMenu(event, file.rel),
                    title: file.rel + '\n' + (file.display || ''),
                    role: 'treeitem',
                    'data-drp-path': file.rel,
                  },
                  h('span', { className: 'drp-tree-twisty' }),
                  h(FileIcon, { path: file.rel, scheme: activeScheme }),
                  h('span', { className: 'drp-tree-name' }, file.rel),
                  treeMode === 'git' || treeMode === 'revision' ? GitBadge(file) : h(ChangeBadge, file),
                )
              }),
        )
      : h(
          'div',
          { className: 'drp-tree-body' },
          h(TreeDir, {
            relPath: '',
            depth: 0,
            expanded,
            loadState,
            onToggle: toggle,
            onOpen: open,
            onContextMenu: showContextMenu,
            activePath,
            changed,
            badgesEnabled: treeMode === 'turn',
            gitBadges,
            scheme: activeScheme,
          }),
        ),
    ctxMenu
      ? h(
          'div',
          {
            className: 'drp-ctx-menu',
            style: { left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' },
            role: 'menu',
            onMouseDown: (event) => { try { event.stopPropagation() } catch (error) { /* ignore */ } },
          },
          h('button', { type: 'button', className: 'drp-menu-item', onClick: () => { void copyFromMenu(ctxMenu.path, false) } }, t('action.copyPath')),
          h('button', { type: 'button', className: 'drp-menu-item', onClick: () => { void copyFromMenu(ctxMenu.path, true) } }, t('action.copyAbsolutePath')),
          h('div', { className: 'drp-menu-sep' }),
          h('button', {
            type: 'button',
            className: 'drp-menu-item',
            onClick: () => {
              const path = ctxMenu.path
              setCtxMenu(null)
              if (typeof onPreview === 'function') onPreview(path)
            },
          }, t('action.openInPreview')),
        )
      : null,
  )
}
