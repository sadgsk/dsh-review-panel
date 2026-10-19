/* dsh-review-panel client half — Monaco AMD loader, inline diff renderer, editor host. */

/** Singleton Monaco promise; reset on failure so a later mount can retry. */
let monacoPromise = null

/**
 * Load the vendored Monaco AMD build from the authenticated vendor route.
 * Adapted from the MIT `dsh-vscode-mode` loader (global `module`/`exports`
 * pollution guard included: other plugins may define them, which makes the
 * AMD loader believe it runs under Node).
 * @returns {Promise<any>} the `monaco` namespace
 */
function loadMonaco() {
  if (monacoPromise) return monacoPromise
  monacoPromise = new Promise((resolve, reject) => {
    const base = appUrl(VENDOR_BASE)
    const root = typeof globalThis !== 'undefined' ? globalThis : {}
    const hasModule = Object.prototype.hasOwnProperty.call(root, 'module')
    const hasExports = Object.prototype.hasOwnProperty.call(root, 'exports')
    const savedModule = root.module
    const savedExports = root.exports
    const hideNodeGlobals = () => {
      try { delete root.module } catch (error) { /* read-only global */ }
      try { delete root.exports } catch (error) { /* read-only global */ }
    }
    const restoreNodeGlobals = () => {
      if (hasModule) root.module = savedModule
      else { try { delete root.module } catch (error) { /* ignore */ } }
      if (hasExports) root.exports = savedExports
      else { try { delete root.exports } catch (error) { /* ignore */ } }
    }
    const loaderTagSelector = 'script[data-drp-monaco-loader]'
    const removeLoaderTag = () => {
      const existing = document.querySelector(loaderTagSelector)
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing)
    }
    const fail = (error) => {
      monacoPromise = null
      removeLoaderTag()
      restoreNodeGlobals()
      reject(error instanceof Error ? error : new Error(String(error)))
    }
    const boot = () => {
      restoreNodeGlobals()
      try {
        if (typeof window.require !== 'function' || typeof window.require.config !== 'function') {
          fail(new Error('Monaco AMD loader did not expose window.require'))
          return
        }
        window.require.config({ paths: { vs: base } })
        window.require(['vs/editor/editor.main'], () => {
          const monaco = window.monaco
          if (!monaco || !monaco.editor) {
            fail(new Error('Monaco editor namespace missing'))
            return
          }
          registerMonacoThemes(monaco)
          resolve(monaco)
        }, (error) => fail(new Error('Monaco module load failed: ' + String(error))))
      } catch (error) {
        fail(error)
      }
    }
    try {
      const existing = document.querySelector(loaderTagSelector)
      if (existing && typeof window.require === 'function' && typeof window.require.config === 'function') {
        boot()
        return
      }
      if (existing) removeLoaderTag()
      const script = document.createElement('script')
      script.src = base + '/loader.js'
      script.dataset.didMonacoLoader = '1'
      script.onload = boot
      script.onerror = () => fail(new Error('Monaco loader script failed to load'))
      hideNodeGlobals()
      document.head.appendChild(script)
    } catch (error) {
      fail(error)
    }
  })
  return monacoPromise
}

/**
 * Compute review-panel regions from a comparison against the current file text.
 *
 * A region is one contiguous change group. `start`/`end` are 1-based new-file
 * line numbers (`end` exclusive); `oldStart`/`oldLines` describe the deleted
 * original lines shown as an inline block above `start`.
 *
 * @param {any} comparison WorkspaceFileDiff text comparison
 * @param {string} text current file text
 * @returns {{regions: Array<object>, total: number, added: number, deleted: number}}
 */
function buildRegions(comparison, text) {
  const lines = splitLines(text)
  const lineCount = lines.length
  const empty = { regions: [], total: 0, added: 0, deleted: 0 }
  if (!comparison || comparison.kind !== 'text' || !Array.isArray(comparison.hunks)) return empty
  if (comparison.coarse) {
    if (lineCount === 0) return empty
    const region = { start: 1, end: Math.min(lineCount, MAX_RENDER_LINES) + 1, oldStart: 1, oldLines: [], addedLines: Math.min(lineCount, MAX_RENDER_LINES) }
    return { regions: [region], total: 1, added: lineCount, deleted: 0 }
  }
  const regions = []
  let added = 0
  let deleted = 0
  for (const hunk of comparison.hunks) {
    if (!hunk || !Array.isArray(hunk.lines)) continue
    let newLine = Math.max(1, Number(hunk.newStart) || 1)
    let oldLine = Math.max(1, Number(hunk.oldStart) || 1)
    let index = 0
    while (index < hunk.lines.length) {
      const raw = String(hunk.lines[index])
      const prefix = raw.charAt(0)
      if (prefix === ' ') {
        newLine += 1
        oldLine += 1
        index += 1
        continue
      }
      const start = newLine
      const oldStart = oldLine
      const oldLines = []
      let addedCount = 0
      while (index < hunk.lines.length) {
        const line = String(hunk.lines[index])
        const kind = line.charAt(0)
        if (kind === ' ') break
        if (kind === '-') {
          oldLines.push(line.slice(1))
          oldLine += 1
          deleted += 1
        } else if (kind === '+') {
          addedCount += 1
          added += 1
        }
        index += 1
      }
      if (addedCount === 0 && oldLines.length === 0) continue
      const clampedStart = Math.min(start, Math.max(1, lineCount + 1))
      const clampedAdded = Math.min(addedCount, Math.max(0, lineCount - clampedStart + 1))
      regions.push({
        start: clampedStart,
        end: clampedStart + clampedAdded,
        oldStart,
        oldLines,
        addedLines: clampedAdded,
      })
      newLine += addedCount
    }
  }
  regions.sort((a, b) => a.start - b.start || a.oldStart - b.oldStart)
  return { regions, total: regions.length, added, deleted }
}

/**
 * Per-editor inline diff renderer: whole-line decorations for added lines and
 * Monaco view zones for deleted lines (with their original line numbers).
 * Browser-only; owns its decorations/zones and releases them on dispose.
 * @param {any} monaco Monaco namespace
 * @param {any} editor Monaco editor
 * @returns {{render:Function, refresh:Function, reflow:Function, dispose:Function}}
 */
function createDiffRenderer(monaco, editor) {
  let decorations = []
  let zones = []
  let listeners = []
  let lastRegions = null
  let generation = 0
  let disposed = false

  const colorVars = () => diffCssVarsOf(themeRuntime.scheme || detectScheme())

  /**
   * Apply the diff color variables to the editor DOM.
   * @param {HTMLElement} node target node
   */
  const setColors = (node) => {
    if (!node || !node.style) return
    const vars = colorVars()
    node.style.setProperty('--drp-diff-add', vars.add)
    node.style.setProperty('--drp-diff-del', vars.del)
    node.style.setProperty('--drp-diff-fg', vars.fg)
    node.style.setProperty('--drp-diff-number', vars.number)
  }

  /** Remove every decoration and view zone this renderer owns. */
  const clear = () => {
    generation += 1
    lastRegions = null
    try {
      if (decorations.length > 0) decorations = editor.deltaDecorations(decorations, [])
    } catch (error) {
      decorations = []
    }
    try {
      if (zones.length > 0) {
        editor.changeViewZones((accessor) => {
          for (const zone of zones) {
            try { accessor.removeZone(zone.id) } catch (error) { /* already gone */ }
          }
        })
      }
    } catch (error) { /* editor may be disposed */ }
    zones = []
  }

  /**
   * Map a pointer position onto a caret inside a deleted-line zone. Coordinates
   * outside the zone are clamped to its first/last row so a drag that starts in
   * the zone can never create a page-wide native selection.
   * @param {object} zone zone record
   * @param {number} x client X
   * @param {number} y client Y
   * @returns {{node:Node, offset:number} | null}
   */
  const zoneCaretPoint = (zone, x, y) => {
    const rows = zone.domNode.querySelectorAll('.drp-del-row')
    if (!rows.length) return null
    const first = rows[0]
    const last = rows[rows.length - 1]
    const firstRect = first.getBoundingClientRect()
    const lastRect = last.getBoundingClientRect()
    const firstText = zone.rows[0] && zone.rows[0].firstChild
    const lastText = zone.rows[zone.rows.length - 1] && zone.rows[zone.rows.length - 1].firstChild
    if (y <= firstRect.top) return firstText ? { node: firstText, offset: 0 } : null
    if (y >= lastRect.bottom) return lastText ? { node: lastText, offset: lastText.textContent.length } : null
    let caret = null
    try { caret = document.caretRangeFromPoint(x, y) } catch (error) { caret = null }
    if (caret && zone.domNode.contains(caret.startContainer)) {
      return { node: caret.startContainer, offset: caret.startOffset }
    }
    const rowCount = Math.max(1, rows.length)
    const step = rowCount > 1 ? (lastRect.top - firstRect.top) / (rowCount - 1) : 20
    const index = Math.max(0, Math.min(rowCount - 1, Math.floor((y - firstRect.top) / Math.max(1, step))))
    const text = zone.rows[index] && zone.rows[index].firstChild
    if (!text) return null
    const right = rows[index].getBoundingClientRect().right
    return { node: text, offset: x >= right ? text.textContent.length : 0 }
  }

  /** Zone DOM node → zone record (mouse selection needs the text rows). */
  const zoneByNode = new WeakMap()
  let zoneMouseInstalled = false

  /** Apply one restricted Range selection inside a deleted-line zone. */
  const applyZoneRange = (anchor, focus) => {
    try {
      const anchorFirst = anchor.node === focus.node
        ? anchor.offset <= focus.offset
        : Boolean(anchor.node.compareDocumentPosition(focus.node) & 4)
      const start = anchorFirst ? anchor : focus
      const end = anchorFirst ? focus : anchor
      const range = document.createRange()
      range.setStart(start.node, start.offset)
      range.setEnd(end.node, end.offset)
      const selection = window.getSelection()
      if (!selection) return
      selection.removeAllRanges()
      selection.addRange(range)
    } catch (error) { /* ignore */ }
  }

  /**
   * Install one document-level capture handler for deleted-line zones. Capture is
   * required: Monaco's own mousedown handling would otherwise clear the native
   * Range we create for the zone (the editor normally keeps native selection off).
   */
  const installZoneMouse = () => {
    if (zoneMouseInstalled) return
    zoneMouseInstalled = true
    document.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return
      const target = event.target
      if (!(target instanceof Element) || !target.closest) return
      const zoneEl = target.closest('.drp-del-zone')
      if (!zoneEl) return
      if (target.closest('.drp-del-copy')) return
      const zone = zoneByNode.get(zoneEl)
      if (!zone) return
      const anchor = zoneCaretPoint(zone, event.clientX, event.clientY)
      if (!anchor) return
      try {
        event.preventDefault()
        event.stopPropagation()
      } catch (error) { /* ignore */ }
      applyZoneRange(anchor, anchor)
      const onMove = (moveEvent) => {
        if (moveEvent.buttons === 0) return
        const focus = zoneCaretPoint(zone, moveEvent.clientX, moveEvent.clientY)
        if (focus) applyZoneRange(anchor, focus)
        try { moveEvent.preventDefault(); moveEvent.stopPropagation() } catch (error) { /* ignore */ }
      }
      const onUp = (upEvent) => {
        document.removeEventListener('mousemove', onMove, true)
        document.removeEventListener('mouseup', onUp, true)
        try { upEvent.stopPropagation() } catch (error) { /* ignore */ }
      }
      document.addEventListener('mousemove', onMove, true)
      document.addEventListener('mouseup', onUp, true)
    }, true)
  }

  /**
   * Build one deleted-line view zone (body + gutter twin).
   * @param {object} region change group
   * @returns {object} zone record
   */
  const makeZone = (region) => {
    const domNode = document.createElement('div')
    domNode.className = 'drp-del-zone'
    const marginDomNode = document.createElement('div')
    marginDomNode.className = 'drp-del-margin'
    const rows = []
    for (let index = 0; index < region.oldLines.length; index += 1) {
      const row = document.createElement('div')
      row.className = 'drp-del-row'
      const code = document.createElement('span')
      code.className = 'drp-del-text'
      code.textContent = region.oldLines[index]
      row.appendChild(code)
      domNode.appendChild(row)
      rows.push(code)
      const marginRow = document.createElement('div')
      marginRow.className = 'drp-del-margin-row'
      const number = document.createElement('span')
      number.className = 'drp-del-number'
      number.textContent = String((region.oldStart || 1) + index)
      const marker = document.createElement('span')
      marker.className = 'drp-del-marker'
      marker.textContent = '−'
      marginRow.appendChild(number)
      marginRow.appendChild(marker)
      marginDomNode.appendChild(marginRow)
    }
    const zone = {
      domNode,
      marginDomNode,
      rows,
      lines: region.oldLines,
      after: Math.max(0, (Number(region.start) || 1) - 1),
    }
    // One-click copy for the whole deleted block, placed in the gutter so it
    // never covers the deleted code text itself.
    const copyBtn = document.createElement('button')
    copyBtn.type = 'button'
    copyBtn.className = 'drp-del-copy'
    copyBtn.title = '复制删除的行'
    copyBtn.textContent = '\u29C9'
    copyBtn.addEventListener('mousedown', (event) => {
      try { event.preventDefault(); event.stopPropagation() } catch (error) { /* ignore */ }
    })
    copyBtn.addEventListener('click', (event) => {
      try { event.preventDefault(); event.stopPropagation() } catch (error) { /* ignore */ }
      const text = zone.lines.join('\n')
      Promise.resolve(typeof copyText === 'function' ? copyText(text) : false)
        .then((ok) => {
          copyBtn.textContent = ok ? '\u2713' : '!'
          setTimeout(() => { copyBtn.textContent = '\u29C9' }, 1300)
        })
        .catch(() => { copyBtn.textContent = '!' })
    })
    marginDomNode.appendChild(copyBtn)
    zoneByNode.set(domNode, zone)
    installZoneMouse()
    return zone
  }

  /**
   * Align a zone with the editor's font, gutter geometry and theme.
   * @param {object} zone zone record
   * @returns {number} minimum width in px for horizontal scrolling
   */
  const layoutZone = (zone) => {
    const vars = colorVars()
    try { editor.applyFontInfo?.(zone.domNode) } catch (error) { /* optional */ }
    try { editor.applyFontInfo?.(zone.marginDomNode) } catch (error) { /* optional */ }
    setColors(zone.domNode)
    setColors(zone.marginDomNode)
    let lineHeight = 20
    let layout = { lineNumbersLeft: 0, lineNumbersWidth: 0, decorationsLeft: 0, decorationsWidth: 0 }
    let fontInfo = null
    try {
      lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight) || 20
      layout = editor.getLayoutInfo() || layout
      fontInfo = editor.getOption(monaco.editor.EditorOption.fontInfo)
    } catch (error) { /* defaults */ }
    const tabSize = (zone.domNode && zone.domNode.style && Number(zone.domNode.style.tabSize)) || 2
    for (const node of [zone.domNode, zone.marginDomNode]) {
      node.style.setProperty('--drp-line-height', lineHeight + 'px')
    }
    zone.domNode.style.tabSize = String(tabSize || 2)
    zone.marginDomNode.style.setProperty('--drp-number-left', layout.lineNumbersLeft + 'px')
    zone.marginDomNode.style.setProperty('--drp-number-width', layout.lineNumbersWidth + 'px')
    zone.marginDomNode.style.setProperty('--drp-marker-left', layout.decorationsLeft + 'px')
    zone.marginDomNode.style.setProperty('--drp-marker-width', layout.decorationsWidth + 'px')
    zone.marginDomNode.style.setProperty('--drp-diff-number', vars.number)
    let width = 0
    for (const line of zone.lines) width = Math.max(width, String(line).replace(/\t/g, ' '.repeat(4)).length)
    const charWidth = Math.max(
      (fontInfo && fontInfo.typicalHalfwidthCharacterWidth) || 8,
      (fontInfo && fontInfo.typicalFullwidthCharacterWidth) || 0,
    )
    return width * charWidth + 24
  }

  /**
   * Asynchronously syntax-color deleted lines with Monaco's own tokenizer.
   * @param {object} zone zone record
   * @param {number} epoch render generation
   */
  const colorizeZone = async (zone, epoch) => {
    try {
      if (typeof monaco.editor.colorize !== 'function') return
      const model = editor.getModel()
      if (!model) return
      const language = model.getLanguageId()
      const tabSize = (model.getOptions && model.getOptions().tabSize) || 2
      const html = await monaco.editor.colorize(zone.lines.join('\n'), language, { tabSize })
      if (disposed || epoch !== generation || editor.getModel() !== model) return
      const rows = String(html).split(/<br\s*\/?\s*>/i)
      if (rows.length === zone.rows.length + 1 && rows[rows.length - 1] === '') rows.pop()
      if (rows.length !== zone.rows.length) return
      for (let index = 0; index < rows.length; index += 1) zone.rows[index].innerHTML = rows[index]
    } catch (error) {
      /* keep the plain-text fallback visible */
    }
  }

  /**
   * Paint regions onto the current model.
   * @param {Array<object>} regions change groups (see buildRegions)
   */
  const paint = (regions) => {
    lastRegions = regions
    clear()
    lastRegions = regions
    if (!editor || disposed) return
    const model = editor.getModel()
    if (!model) return
    setColors(editor.getDomNode())
    const decorationsSpec = []
    const zoneSpecs = []
    for (const region of regions) {
      if (region.addedLines > 0 && region.start >= 1) {
        decorationsSpec.push({
          range: new monaco.Range(region.start, 1, Math.max(region.start, region.end - 1), 1),
          options: {
            isWholeLine: true,
            className: 'drp-add-line',
            marginClassName: 'drp-add-line',
            linesDecorationsClassName: 'drp-add-gutter',
          },
        })
      }
      if (region.oldLines.length > 0) zoneSpecs.push(makeZone(region))
    }
    try {
      decorations = editor.deltaDecorations([], decorationsSpec)
    } catch (error) {
      decorations = []
    }
    if (zoneSpecs.length > 0) {
      try {
        editor.changeViewZones((accessor) => {
          for (const zone of zoneSpecs) {
            const minWidthInPx = layoutZone(zone)
            zone.id = accessor.addZone({
              afterLineNumber: zone.after,
              heightInLines: Math.max(1, zone.lines.length),
              domNode: zone.domNode,
              marginDomNode: zone.marginDomNode,
              minWidthInPx,
              // Deleted lines are plain DOM (they are not part of the Monaco
              // text model). Suppressing the mouse would make the whole block
              // unselectable and uncopyable, so let the browser handle drag
              // selection inside the zone like normal text.
              suppressMouseDown: false,
            })
            zones.push(zone)
            void colorizeZone(zone, generation)
          }
        })
      } catch (error) {
        zones = []
      }
    }
  }

  /**
   * Re-layout zones after a theme or geometry change.
   * @returns {void}
   */
  const reflow = () => {
    if (disposed) return
    setColors(editor.getDomNode())
    for (const zone of zones) {
      try { layoutZone(zone) } catch (error) { /* ignore */ }
    }
    for (const zone of zones) void colorizeZone(zone, generation)
  }

  // Layout changes fire on every splitter frame. Only the geometry of the
  // existing zones needs to follow (gutter offsets, line height); re-tokenizing
  // the deleted lines on every frame is what made the DSH divider drag stutter.
  let layoutFrame = 0
  const onLayout = () => {
    if (disposed || layoutFrame) return
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = 0
      if (disposed) return
      try {
        setColors(editor.getDomNode())
        for (const zone of zones) layoutZone(zone)
      } catch (error) { /* ignore */ }
    })
  }
  try { listeners.push(editor.onDidLayoutChange(onLayout)) } catch (error) { /* ignore */ }
  try { listeners.push(editor.onDidChangeModel(() => clear())) } catch (error) { /* ignore */ }

  return {
    render(regions) {
      paint(Array.isArray(regions) ? regions : [])
    },
    refresh() {
      paint(lastRegions || [])
    },
    reflow,
    dispose() {
      disposed = true
      if (layoutFrame) {
        try { cancelAnimationFrame(layoutFrame) } catch (error) { /* ignore */ }
        layoutFrame = 0
      }
      clear()
      for (const listener of listeners) {
        try { listener.dispose() } catch (error) { /* ignore */ }
      }
      listeners = []
    },
  }
}

/**
 * Read-only Monaco editor host: one editor instance, one model per reviewed file,
 * per-file view state, inline diff decorations refreshed from `regions`.
 * @param {object} props component props
 * @returns {any} React element
 */
function MonacoHost(props) {
  const { monaco, file, sessionId, regions, wrap, minimap, reveal, scheme, fontSize, onCursor, onReady, onError, onRequestLine, onRequestOutline, onModelReady, onLsp } = props
  const hostRef = React.useRef(null)
  const editorRef = React.useRef(null)
  const rendererRef = React.useRef(null)
  const modelsRef = React.useRef(new Map())
  const viewStatesRef = React.useRef(new Map())
  const fontSizeRef = React.useRef(13)
  const callbacksRef = React.useRef({ onCursor, onReady, onError, onRequestLine, onRequestOutline, onModelReady, onLsp })
  callbacksRef.current = { onCursor, onReady, onError, onRequestLine, onRequestOutline, onModelReady, onLsp }

  /**
   * Create the editor once the host node and Monaco both exist.
   * @param {HTMLDivElement | null} node host node
   */
  const attach = React.useCallback((node) => {
    hostRef.current = node
    if (!node || editorRef.current || !monaco) return
    try {
      const editor = monaco.editor.create(node, {
        value: '',
        language: 'plaintext',
        theme: themeRuntime.scheme === 'light' ? MONACO_BASE.light : MONACO_BASE.dark,
        readOnly: true,
        domReadOnly: true,
        renderValidationDecorations: 'on',
        automaticLayout: true,
        scrollBeyondLastLine: false,
        wordWrap: 'off',
        minimap: { enabled: false },
        glyphMargin: false,
        lineNumbers: 'on',
        lineDecorationsWidth: 14,
        folding: true,
        bracketPairColorization: { enabled: true },
        matchBrackets: 'always',
        renderLineHighlight: 'none',
        renderWhitespace: 'selection',
        smoothScrolling: false,
        cursorBlinking: 'smooth',
        mouseWheelZoom: true,
        contextmenu: true,
        // Let hovers / suggest widgets escape the editor's clipped box: inside the
        // narrow right sidebar a clipped hover hides its first lines behind the
        // toolbar (user report). Fixed overflow widgets are positioned in the
        // viewport, so the tooltip stays readable.
        fixedOverflowWidgets: true,
        hover: { above: false, sticky: true, delay: 120 },
        fontSize: fontSizeRef.current,
        lineHeight: 20,
        fontFamily: 'var(--ds-font-family-code, var(--dsh-code-font-family, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace))',
        tabSize: 2,
        padding: { top: 8, bottom: 24 },
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
      })
      rendererRef.current = createDiffRenderer(monaco, editor)
      editorRef.current = editor
      try {
        editor.onDidChangeCursorPosition((event) => {
          callbacksRef.current.onCursor?.({ line: event.position.lineNumber, column: event.position.column })
        })
      } catch (error) { /* optional */ }
      try {
        const key = monaco.KeyMod
        const code = monaco.KeyCode
        const bump = (delta) => {
          fontSizeRef.current = Math.min(28, Math.max(9, fontSizeRef.current + delta))
          editor.updateOptions({ fontSize: fontSizeRef.current })
          rendererRef.current?.reflow()
        }
        editor.addCommand(key.CtrlCmd | code.Equal, () => bump(1))
        editor.addCommand(key.CtrlCmd | code.Minus, () => bump(-1))
        editor.addCommand(key.CtrlCmd | code.Digit0, () => { fontSizeRef.current = 13; editor.updateOptions({ fontSize: 13 }) })
        // VS Code go-to-line parity inside the editor (the page-level command
        // covers the non-editor region with the same overlay).
        editor.addCommand(key.CtrlCmd | code.KeyG, () => {
          try {
            const action = editor.getAction('editor.action.gotoLine')
            if (action) action.run()
            else callbacksRef.current.onRequestLine?.()
          } catch (error) { /* ignore */ }
        })
        editor.addCommand(key.CtrlCmd | key.Shift | code.KeyO, () => callbacksRef.current.onRequestOutline?.())
        // Language-server navigation: F12 definition / Shift+F12 references.
        editor.addCommand(code.F12, () => {
          try {
            const position = lspPosition(editor)
            if (position) callbacksRef.current.onLsp?.('definition', position.lineNumber, position.column)
          } catch (error) { /* ignore */ }
        })
        editor.addCommand(key.Shift | code.F12, () => {
          try {
            const position = lspPosition(editor)
            if (position) callbacksRef.current.onLsp?.('references', position.lineNumber, position.column)
          } catch (error) { /* ignore */ }
        })
        editor.onMouseUp((event) => {
          if (!(event.event.ctrlKey || event.event.metaKey) || !event.event.leftButton || !event.target.position) return
          const position = event.target.position
          callbacksRef.current.onLsp?.('definition', position.lineNumber, position.column)
        })
      } catch (error) { /* keybindings are best-effort */ }
      callbacksRef.current.onReady?.({
        revealLine: (line) => {
          try {
            const target = Math.max(1, Number(line) || 1)
            editor.revealLineInCenterIfOutsideViewport?.(target)
            editor.revealLineInCenter(target)
            editor.setPosition({ lineNumber: target, column: 1 })
          } catch (error) { /* ignore */ }
        },
        focus: () => { try { editor.focus() } catch (error) { /* ignore */ } },
        layout: () => { try { editor.layout() } catch (error) { /* ignore */ } },
        getEditor: () => editor,
        setFontSize: (size) => { fontSizeRef.current = Math.min(28, Math.max(9, Number(size) || 13)); editor.updateOptions({ fontSize: fontSizeRef.current }) },
      })
    } catch (error) {
      log('error', 'monaco editor creation failed', error)
      callbacksRef.current.onError?.(error)
    }
  }, [monaco])

  // Disposal.
  React.useEffect(() => () => {
    try { rendererRef.current?.dispose() } catch (error) { /* ignore */ }
    rendererRef.current = null
    const editor = editorRef.current
    lspClearDocument(editor?.getModel?.())
    editorRef.current = null
    if (editor) {
      try { editor.dispose() } catch (error) { /* ignore */ }
    }
    for (const model of modelsRef.current.values()) {
      try { model.dispose() } catch (error) { /* ignore */ }
    }
    modelsRef.current.clear()
  }, [])

  // Model switching with per-file view state. The host stays mounted while a
  // file loads, so `file` may be null or still loading: the previous model then
  // stays visible (the page paints a loading veil on top) and the scroll
  // position of each file survives a switch because the editor is never
  // destroyed and each model's Monaco view state is restored synchronously.
  React.useEffect(() => {
    const editor = editorRef.current
    if (!editor || !monaco || !file || file.kind !== 'text') return
    const path = file.path
    if (!path || typeof file.text !== 'string') return
    let model = modelsRef.current.get(path)
    try {
      if (!model) {
        const uri = monaco.Uri.parse('did:///' + encodeURIComponent(sessionId || 'workspace') + '/' + path.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/'))
        model = monaco.editor.getModel(uri) || monaco.editor.createModel(file.text, file.language || 'plaintext', uri)
        modelsRef.current.set(path, model)
      } else if (model.getValue() !== file.text) {
        // Content changed underneath (refresh): keep the user's scroll position.
        const saved = editor.getModel() === model ? editor.saveViewState() : viewStatesRef.current.get(model.uri.toString())
        model.setValue(file.text)
        if (saved) {
          try { editor.restoreViewState(saved) } catch (error) { /* ignore */ }
        }
      }
      if (model.getLanguageId() !== (file.language || 'plaintext')) monaco.editor.setModelLanguage(model, file.language || 'plaintext')
      if (editor.getModel() !== model) {
        try {
          const previous = editor.getModel()
          if (previous) viewStatesRef.current.set(previous.uri.toString(), editor.saveViewState())
        } catch (error) { /* ignore */ }
        editor.setModel(model)
        try {
          const saved = viewStatesRef.current.get(model.uri.toString())
          if (saved) editor.restoreViewState(saved)
        } catch (error) { /* ignore */ }
        try { editor.layout() } catch (error) { /* ignore */ }
      }
      callbacksRef.current.onModelReady?.({
        path,
        text: model.getValue(),
        language: model.getLanguageId(),
        monaco,
        model,
      })
    } catch (error) {
      log('error', 'monaco model switch failed', error)
    }
  }, [monaco, sessionId, file && file.path, file && file.text, file && file.language, file && file.kind, file && file.missing])

  // Inline diff decorations.
  React.useEffect(() => {
    const renderer = rendererRef.current
    if (!renderer) return
    renderer.render(regions || [])
  }, [regions])

  // Editor options.
  React.useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    try {
      editor.updateOptions({ wordWrap: wrap ? 'on' : 'off', minimap: { enabled: minimap === true } })
      rendererRef.current?.reflow()
    } catch (error) { /* ignore */ }
  }, [wrap, minimap])

  // Font size is prop-driven so menu commands always reach the live editor
  // (the imperative controls object is only a convenience path).
  React.useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const next = Math.min(28, Math.max(9, Math.round(Number(fontSize) || 13)))
    fontSizeRef.current = next
    try {
      editor.updateOptions({ fontSize: next })
      rendererRef.current?.reflow()
    } catch (error) { /* ignore */ }
  }, [fontSize, file && file.path])

  // Theme switching: re-apply the plugin theme and repaint zone decorations.
  React.useEffect(() => {
    const editor = editorRef.current
    if (!editor || !monaco) return
    try {
      applyMonacoTheme(monaco)
      rendererRef.current?.reflow()
    } catch (error) { /* ignore */ }
  }, [monaco, scheme])

  // Reveal requests from hunk navigation / file open.
  React.useEffect(() => {
    const editor = editorRef.current
    if (!editor || !reveal || !reveal.line) return
    try {
      const target = Math.max(1, Number(reveal.line) || 1)
      editor.revealLineInCenter(target)
      const column = Math.max(1, Number(reveal.column) || 1)
      if (reveal.endLine && reveal.endColumn) {
        const range = { startLineNumber: target, startColumn: column, endLineNumber: reveal.endLine, endColumn: reveal.endColumn }
        editor.setSelection(range)
        editor.revealRangeInCenter(range)
      } else {
        editor.setPosition({ lineNumber: target, column })
        editor.revealPositionInCenter({ lineNumber: target, column })
      }
      editor.focus()
    } catch (error) { /* ignore */ }
  }, [reveal && reveal.line, reveal && reveal.nonce])

  return h('div', { className: 'drp-monaco-host', ref: attach })
}
