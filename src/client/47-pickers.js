/* dsh-review-panel client half — Quick Open / workspace search / command palette overlay. */

/**
 * Fuzzy subsequence score for Quick Open (higher is better; 0 = no match).
 * Consecutive matches and a basename hit score higher; a path hit still counts.
 * @param {string} query typed query
 * @param {string} target candidate path
 * @returns {number}
 */
function fuzzyScore(query, target) {
  const needle = String(query || '').toLowerCase()
  const haystack = String(target || '').toLowerCase()
  if (needle === '') return 1
  if (haystack.length === 0) return 0
  const baseStart = haystack.lastIndexOf('/') + 1
  let score = 0
  let index = 0
  let streak = 0
  for (const character of needle) {
    let at = haystack.indexOf(character, index)
    if (at < 0) return 0
    streak = at === index ? streak + 1 : 0
    score += 2 + streak
    if (at >= baseStart) score += 2
    index = at + 1
  }
  if (haystack.endsWith(needle)) score += 6
  return score
}

/**
 * Filter and rank paths for Quick Open.
 * @param {string[]} files candidate paths
 * @param {string} query typed query
 * @param {number} [limit] max results
 * @returns {Array<{path:string, score:number}>}
 */
function rankQuickOpen(files, query, limit = 100) {
  const needle = String(query || '').trim()
  if (needle === '') {
    return files.slice(0, limit).map((path) => ({ path, score: 1 }))
  }
  const ranked = []
  for (const path of files) {
    const score = fuzzyScore(needle, path)
    if (score > 0) ranked.push({ path, score })
  }
  ranked.sort((left, right) => right.score - left.score || left.path.length - right.path.length || left.path.localeCompare(right.path))
  return ranked.slice(0, limit)
}

/**
 * Short display date for one revision: `MM-DD` for dates in the current calendar
 * year, otherwise the full `YYYY-MM-DD`; unparseable values render as ''.
 * @param {string} iso ISO-8601 date from git
 * @returns {string}
 */
function formatRevisionDate(iso) {
  // Git dates carry the author's own offset; show that calendar date as-is
  // instead of shifting it into the viewer's time zone (matches `git log`).
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''))
  if (!match) return ''
  const year = match[1]
  const monthDay = match[2] + '-' + match[3]
  return year === String(new Date().getFullYear()) ? monthDay : year + '-' + monthDay
}

/**
 * Whether typed picker text should be offered as a raw git revision expression.
 * Shortened to the cases where the query clearly is not a commit subject: a
 * sha-like token, a ref path, a `HEAD~2`-style expression or an `@{...}` ref.
 * A plain word (branch/tag name or subject text) only becomes a raw revision
 * when no loaded commit matches it.
 * @param {string} value typed query
 * @returns {boolean}
 */
function isRevisionLikeQuery(value) {
  const text = String(value || '').trim()
  if (text === '') return false
  if (/^[0-9a-f]{4,64}$/i.test(text)) return true
  if (/^refs\//.test(text) || text.startsWith('@')) return true
  if (/^HEAD([~^]|$)/.test(text) || /^tag[:/]/.test(text) || /^origin\//.test(text)) return true
  return /[~^@]/.test(text) || /\//.test(text) && /^[A-Za-z0-9_.\/-]+$/.test(text)
}

/**
 * One picker overlay: Quick Open, workspace search, the command palette, or the
 * git-version picker (mode `revisions`).
 * @param {object} props component props
 * @returns {any} React element
 */
function PickerOverlay(props) {
  const {
    mode, t, sessionId, commands, onPickFile, onPickCommand, onClose, initialQuery,
    activePath, lineCount,
    revisionScope, onRevisionScopeChange, onPickRevision,
  } = props
  const inputRef = React.useRef(null)
  const [query, setQuery] = React.useState(initialQuery || '')
  const [files, setFiles] = React.useState(null)
  const [filesTruncated, setFilesTruncated] = React.useState(false)
  const [fileError, setFileError] = React.useState(null)
  const [searchState, setSearchState] = React.useState({ status: 'idle', results: [], scanned: 0, truncated: false })
  const [revisionState, setRevisionState] = React.useState({ status: 'idle', data: null, message: '' })
  const [activeIndex, setActiveIndex] = React.useState(0)
  const debounceRef = React.useRef(null)
  // Optional props: the picker stays usable when the page omits the version props.
  const scope = revisionScope === 'since' ? 'since' : 'commit'

  // VS Code Quick Open prefixes: `>` runs a command, `:` jumps to a line.
  const trimmed = query.trimStart()
  const effectiveMode = mode === 'quickopen'
    ? (trimmed.startsWith('>') ? 'commands' : trimmed.startsWith(':') ? 'line' : 'quickopen')
    : mode
  const prefixQuery = effectiveMode === 'commands' && mode === 'quickopen'
    ? trimmed.slice(1).trim()
    : effectiveMode === 'line' && mode === 'quickopen' ? trimmed.slice(1).trim() : query

  const title = mode === 'revisions'
    ? t('picker.revisions.title')
    : mode === 'locations' ? t(props.locationKind === 'definitions' ? 'picker.definitions.title' : 'picker.locations.title')
    : mode === 'outline' ? t('picker.outline.title')
    : mode === 'keys'
    ? t('picker.keys.title')
    : mode === 'line'
    ? t('picker.line.title')
    : mode === 'quickopen'
      ? t('picker.quickOpen.title')
      : mode === 'search' ? t('picker.search.title') : t('picker.commands.title')
  const placeholder = mode === 'revisions'
    ? t('picker.revisions.placeholder')
    : mode === 'locations' ? t('picker.locations.placeholder')
    : mode === 'outline' ? t('picker.outline.placeholder')
    : mode === 'keys'
    ? t('picker.keys.placeholder')
    : mode === 'line'
      ? t('picker.line.placeholder')
    : mode === 'quickopen'
      ? t('picker.quickOpen.placeholder')
      : mode === 'search' ? t('picker.search.placeholder') : t('picker.commands.placeholder')

  // Focus the input as soon as the overlay opens.
  React.useEffect(() => {
    const timer = setTimeout(() => {
      try { inputRef.current?.focus() } catch (error) { /* ignore */ }
    }, 20)
    return () => clearTimeout(timer)
  }, [])

  // Quick Open: load the (cached) workspace index once.
  React.useEffect(() => {
    if (mode !== 'quickopen' || !sessionId) return undefined
    let cancelled = false
    apiGet('files', { sessionId })
      .then((value) => {
        if (cancelled) return
        setFiles(Array.isArray(value?.files) ? value.files : [])
        setFilesTruncated(value?.truncated === true)
      })
      .catch((failure) => {
        if (cancelled) return
        setFiles([])
        setFileError(failure?.message || String(failure))
      })
    return () => { cancelled = true }
  }, [mode, sessionId])

  // Git versions: load the bounded revision list once per picker open; the token
  // guard drops late responses when the overlay closes or the mode changes.
  React.useEffect(() => {
    if (mode !== 'revisions') return undefined
    let cancelled = false
    setRevisionState({ status: 'loading', data: null, message: '' })
    if (!sessionId) {
      setRevisionState({ status: 'error', data: null, message: t('error.noSession') })
      return () => { cancelled = true }
    }
    apiGet('gitRevisions', { sessionId })
      .then((value) => {
        if (cancelled) return
        setRevisionState({ status: 'ready', data: value || null, message: '' })
      })
      .catch((failure) => {
        if (cancelled) return
        setRevisionState({ status: 'error', data: null, message: failure && failure.message ? failure.message : String(failure) })
      })
    return () => { cancelled = true }
  }, [mode, sessionId])

  // Workspace search: debounced remote query.
  React.useEffect(() => {
    if (mode !== 'search') return undefined
    const needle = query.trim()
    if (needle.length < 2) {
      setSearchState({ status: 'idle', results: [], scanned: 0, truncated: false })
      return undefined
    }
    setSearchState({ status: 'searching', results: [], scanned: 0, truncated: false })
    if (debounceRef.current) clearTimeout(debounceRef.current)
    let cancelled = false
    debounceRef.current = setTimeout(() => {
      apiGet('search', { sessionId, q: needle, limit: 100 })
        .then((value) => {
          if (cancelled) return
          setSearchState({
            status: 'ready',
            results: Array.isArray(value?.results) ? value.results : [],
            scanned: Number(value?.scanned) || 0,
            truncated: value?.truncated === true,
          })
          setActiveIndex(0)
        })
        .catch((failure) => {
          if (cancelled) return
          setSearchState({ status: 'error', results: [], scanned: 0, truncated: false, message: failure?.message || String(failure) })
        })
    }, 250)
    return () => {
      cancelled = true
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [mode, query, sessionId])

  const commandItems = React.useMemo(() => {
    if (effectiveMode !== 'commands' && effectiveMode !== 'keys' && mode !== 'locations' && mode !== 'outline') return []
    const needle = prefixQuery.trim().toLowerCase()
    const list = (commands || []).map((command) => ({
      id: command.id,
      label: typeof command.label === 'function' ? command.label() : String(command.label || command.id),
      hint: command.hint || '',
    }))
    if (needle === '') return list
    return list.filter((item) => (item.label + ' ' + item.hint).toLowerCase().includes(needle))
  }, [effectiveMode, commands, prefixQuery])

  const quickItems = React.useMemo(() => {
    if (effectiveMode !== 'quickopen' || !files) return []
    return rankQuickOpen(files, prefixQuery, 100)
  }, [effectiveMode, files, prefixQuery])

  // Git versions: loaded payload, typed-query filter, scope toggle and offered rows.
  const revisionData = revisionState.data
  const revisionCommits = revisionData && Array.isArray(revisionData.commits) ? revisionData.commits : []
  const revisionNeedle = query.trim().toLowerCase()
  const revisionRaw = query.trim()
  const revisionMatches = revisionNeedle === ''
    ? revisionCommits
    : revisionCommits.filter((commit) => (
      [commit.sha, commit.short, commit.subject, commit.author, Array.isArray(commit.refs) ? commit.refs.join(' ') : '']
        .filter(Boolean).join(' ').toLowerCase().includes(revisionNeedle)
    ))
  // Offer the typed expression as a raw revision unless it plainly looks like a
  // commit-subject search that already matched rows.
  const offerRawRevision = revisionRaw !== '' && (revisionMatches.length === 0 || isRevisionLikeQuery(revisionRaw))
  const revisionRows = effectiveMode !== 'revisions' ? [] : [
    ...(offerRawRevision
      ? [{ key: 'revraw:' + revisionRaw, id: 'revraw:' + revisionRaw, primary: t('picker.revisions.raw', { query: revisionRaw }), raw: revisionRaw }]
      : []),
    ...revisionMatches.map((commit) => ({
      key: 'rev:' + commit.sha,
      id: 'rev:' + commit.sha,
      primary: String(commit.short || commit.sha || '') + (commit.subject ? ' ' + commit.subject : ''),
      secondary: [
        Array.isArray(commit.refs) ? commit.refs.join(' ') : '',
        formatRevisionDate(commit.date),
        commit.author,
      ].filter(Boolean).join(' · '),
      commit,
    })),
  ]

  /** Status copy for the revisions mode: head/branch/upstream/ahead summary. */
  const revisionStatus = (() => {
    if (revisionState.status === 'error') return revisionState.message || t('picker.empty')
    if (revisionState.status !== 'ready') return t('picker.revisions.loading')
    if (revisionData && revisionData.available === true) {
      const head = revisionData.head
      if (revisionData.unborn === true || !head || revisionCommits.length === 0) return t('picker.revisions.none')
      const parts = [t('picker.revisions.head', { ref: head.short || head.sha || '' })]
      if (head.detached === true) parts.push(t('picker.revisions.detached'))
      else if (head.branch) {
        parts.push(head.upstream
          ? t('picker.revisions.branchUpstream', { branch: head.branch, upstream: head.upstream })
          : t('picker.revisions.branch', { branch: head.branch }))
      }
      if (Number(head.ahead) > 0) parts.push(t('picker.revisions.ahead', { count: String(head.ahead) }))
      if (revisionNeedle !== '' && revisionMatches.length === 0) parts.push(t('picker.revisions.empty'))
      return parts.join(' · ')
    }
    return t('mode.revision.unavailable')
  })()

  /** Empty-list copy for revisions (no commits yet vs no filter match). */
  const revisionEmptyText = revisionState.status === 'ready' && revisionData && revisionData.available === true
    ? (revisionCommits.length === 0 ? t('picker.revisions.none') : t('picker.revisions.empty'))
    : revisionStatus

  const rows = effectiveMode === 'revisions'
    ? revisionRows
    : effectiveMode === 'quickopen'
      ? quickItems.map((item) => ({ key: 'f:' + item.path, primary: item.path, secondary: '' }))
      : effectiveMode === 'search'
        ? searchState.results.map((hit) => ({
            key: 's:' + hit.path + ':' + hit.line + ':' + hit.column,
            primary: hit.path + ':' + hit.line,
            secondary: hit.text || '',
            path: hit.path,
            line: hit.line,
          }))
        : effectiveMode === 'commands' || effectiveMode === 'keys' || mode === 'locations' || mode === 'outline'
          ? commandItems.map((item) => ({ key: 'c:' + item.id, primary: item.label, secondary: item.hint, id: item.id }))
          : []

  // Keep the active row in range while results shrink.
  React.useEffect(() => {
    setActiveIndex((current) => (current < rows.length ? current : Math.max(0, rows.length - 1)))
  }, [rows.length])

  /** Jump to a typed line number in the active file. */
  const jumpToLine = () => {
    const line = Number(prefixQuery.trim())
    const total = Number(lineCount) || 0
    if (!Number.isFinite(line) || line <= 0 || (total > 0 && line > total)) return false
    onPickFile?.(activePath, line)
    return true
  }

  /** Activate one result row. */
  const choose = (row) => {
    if (effectiveMode === 'line') { jumpToLine(); return }
    if (!row) return
    if (effectiveMode === 'quickopen') { onPickFile?.(row.primary, undefined); return }
    if (effectiveMode === 'search') { onPickFile?.(row.path, row.line); return }
    if (effectiveMode === 'revisions') {
      if (typeof row.raw === 'string') onPickRevision?.({ raw: row.raw })
      else if (row.commit) onPickRevision?.(row.commit)
      return
    }
    onPickCommand?.(row.id)
  }

  /** Keyboard handling: arrows, Enter, Escape. */
  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      try { event.stopPropagation() } catch (error) { /* ignore */ }
      onClose?.()
      return
    }
    if (event.key === 'ArrowDown') {
      try { event.preventDefault() } catch (error) { /* ignore */ }
      setActiveIndex((current) => (rows.length === 0 ? 0 : (current + 1) % rows.length))
      return
    }
    if (event.key === 'ArrowUp') {
      try { event.preventDefault() } catch (error) { /* ignore */ }
      setActiveIndex((current) => (rows.length === 0 ? 0 : (current - 1 + rows.length) % rows.length))
      return
    }
    if (event.key === 'Enter') {
      try { event.preventDefault() } catch (error) { /* ignore */ }
      choose(rows[activeIndex])
    }
  }

  const totalLines = Number(lineCount) || 0
  const lineNumber = Number(prefixQuery.trim())
  const lineValid = Number.isFinite(lineNumber) && lineNumber > 0 && (totalLines === 0 || lineNumber <= totalLines)

  const status = effectiveMode === 'line'
    ? (prefixQuery.trim() === ''
      ? t('picker.line.hint', { lines: String(totalLines) })
      : lineValid ? t('picker.line.hint', { lines: String(totalLines) }) : t('picker.line.invalid'))
    : effectiveMode === 'search'
      ? searchState.status === 'searching'
        ? t('picker.search.scanning')
        : searchState.status === 'ready'
          ? (searchState.results.length === 0
            ? t('picker.search.none')
            : t('picker.search.results', { count: String(searchState.results.length), scanned: String(searchState.scanned) }) + (searchState.truncated ? ' · …' : ''))
          : searchState.status === 'error' ? t('picker.empty') : ''
      : effectiveMode === 'revisions'
        ? revisionStatus
      : mode === 'quickopen'
        ? (fileError || (filesTruncated ? t('picker.files.truncated') : (files ? '' : t('picker.loading'))))
        : ''

  return h(
    'div',
    {
      className: 'drp-picker-backdrop',
      onMouseDown: (event) => { try { if (event.target === event.currentTarget) onClose?.() } catch (error) { /* ignore */ } },
    },
    h('div', {
      className: 'drp-picker',
      role: 'dialog',
      'aria-label': title,
      onMouseDown: (event) => { try { event.stopPropagation() } catch (error) { /* ignore */ } },
    },
      h('div', { className: 'drp-picker-head' },
        h('span', { className: 'drp-picker-title' }, title),
        h('button', { type: 'button', className: 'drp-icon-btn', title: t('common.close'), onClick: () => onClose?.() }, '✕')),
      effectiveMode === 'revisions'
        ? h('div', { className: 'drp-picker-scope' },
            h('div', { className: 'drp-seg', role: 'group', 'aria-label': t('picker.revisions.title') },
              h('button', {
                type: 'button',
                className: cx('drp-seg-btn', scope === 'commit' && 'drp-seg-btn-on'),
                'aria-pressed': scope === 'commit',
                title: t('picker.revisions.scope.commit.hint'),
                onClick: () => onRevisionScopeChange?.('commit'),
              }, t('picker.revisions.scope.commit')),
              h('button', {
                type: 'button',
                className: cx('drp-seg-btn', scope === 'since' && 'drp-seg-btn-on'),
                'aria-pressed': scope === 'since',
                title: t('picker.revisions.scope.since.hint'),
                onClick: () => onRevisionScopeChange?.('since'),
              }, t('picker.revisions.scope.since'))),
            h('span', { className: 'drp-picker-scope-label' }, t(scope === 'since' ? 'picker.revisions.scope.since.hint' : 'picker.revisions.scope.commit.hint')))
        : null,
      h('input', {
        ref: inputRef,
        className: 'drp-picker-input',
        value: query,
        placeholder,
        spellCheck: false,
        autoComplete: 'off',
        onChange: (event) => { setQuery(event.target.value); setActiveIndex(0) },
        onKeyDown,
      }),
      status ? h('div', { className: 'drp-picker-status' }, status) : null,
      h('div', { className: 'drp-picker-list', role: 'listbox' },
        rows.length === 0
          ? h('div', { className: 'drp-picker-empty' },
              effectiveMode === 'line'
                ? (lineValid ? '↵ ' + t('picker.line.title') : t('picker.line.placeholder'))
                : effectiveMode === 'revisions'
                  ? revisionEmptyText
                : mode === 'search' && query.trim().length < 2 ? t('picker.search.placeholder') : t('picker.empty'))
          : rows.slice(0, 200).map((row, index) => h('div', {
              key: row.key,
              className: cx('drp-picker-row', index === activeIndex && 'drp-picker-row-active', row.commit ? 'drp-picker-row-rev' : row.raw !== undefined ? 'drp-picker-row-raw' : ''),
              role: 'option',
              'aria-selected': index === activeIndex,
              title: row.primary,
              onMouseEnter: () => setActiveIndex(index),
              onMouseDown: (event) => { try { event.preventDefault() } catch (error) { /* ignore */ } },
              onClick: () => choose(row),
            },
              h('span', { className: 'drp-picker-primary' }, row.primary),
              row.secondary ? h('span', { className: 'drp-picker-secondary' }, row.secondary) : null,
            ))),
      h('div', { className: 'drp-picker-foot' }, t('picker.hint.navigate')),
    ),
  )
}

