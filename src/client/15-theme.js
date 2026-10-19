/* dsh-review-panel client half — DSH theme detection and Monaco themes. */

/**
 * Diff palette (adapted from the MIT `dsh-vscode-mode` reference): [addedBg, removedBg, addedText, removedText].
 * Light/dark values keep Cursor-style whole-line tints readable on the DSH surfaces.
 */
const DIFF_PALETTE = {
  light: ['#e6f4e8', '#fbe7e3', '#b7e3bf80', '#f1b1a780'],
  dark: ['#203b2c', '#482b2b', '#2d684880', '#8c454580'],
}

/** Syntax token rules (dark). */
const DARK_RULES = [
  { token: '', foreground: 'd4d4d4' },
  { token: 'comment', foreground: '6a9955', fontStyle: 'italic' },
  { token: 'keyword', foreground: 'c586c0' },
  { token: 'keyword.operator', foreground: 'd4d4d4' },
  { token: 'string', foreground: 'ce9178' },
  { token: 'string.escape', foreground: 'd7ba7d' },
  { token: 'number', foreground: 'b5cea8' },
  { token: 'regexp', foreground: 'd16969' },
  { token: 'type', foreground: '4ec9b0' },
  { token: 'type.identifier', foreground: '4ec9b0' },
  { token: 'identifier', foreground: 'd4d4d4' },
  { token: 'variable', foreground: '9cdcfe' },
  { token: 'variable.predefined', foreground: '4fc1ff' },
  { token: 'variable.parameter', foreground: '00bfae' },
  { token: 'parameter', foreground: '00bfae' },
  { token: 'function', foreground: 'dcdcaa' },
  { token: 'method', foreground: 'dcdcaa' },
  { token: 'property', foreground: '9cdcfe' },
  { token: 'member', foreground: 'dcdcaa' },
  { token: 'constant', foreground: '4fc1ff' },
  { token: 'constant.numeric', foreground: 'b5cea8' },
  { token: 'constant.language', foreground: '569cd6' },
  { token: 'tag', foreground: '569cd6' },
  { token: 'attribute.name', foreground: '9cdcfe' },
  { token: 'attribute.value', foreground: 'ce9178' },
  { token: 'delimiter', foreground: 'd4d4d4' },
  { token: 'delimiter.bracket', foreground: 'ffd700' },
  { token: 'operator', foreground: 'd4d4d4' },
  { token: 'namespace', foreground: '4ec9b0' },
  { token: 'class', foreground: '4ec9b0' },
  { token: 'interface', foreground: '4ec9b0' },
  { token: 'enum', foreground: '4ec9b0' },
  { token: 'struct', foreground: '4ec9b0' },
  { token: 'annotation', foreground: 'dcdcaa' },
  { token: 'punctuation', foreground: 'd4d4d4' },
  { token: 'invalid', foreground: 'f44747' },
]

/** Syntax token rules (light). */
const LIGHT_RULES = [
  { token: '', foreground: '1e1e1e' },
  { token: 'comment', foreground: '008000', fontStyle: 'italic' },
  { token: 'keyword', foreground: '0000ff' },
  { token: 'keyword.operator', foreground: '1e1e1e' },
  { token: 'string', foreground: 'a31515' },
  { token: 'string.escape', foreground: 'ee0000' },
  { token: 'number', foreground: '098658' },
  { token: 'regexp', foreground: '811f3f' },
  { token: 'type', foreground: '267f99' },
  { token: 'type.identifier', foreground: '267f99' },
  { token: 'identifier', foreground: '1e1e1e' },
  { token: 'variable', foreground: '001080' },
  { token: 'variable.predefined', foreground: '001080' },
  { token: 'variable.parameter', foreground: '008577' },
  { token: 'parameter', foreground: '008577' },
  { token: 'function', foreground: '795e26' },
  { token: 'method', foreground: '795e26' },
  { token: 'property', foreground: '001080' },
  { token: 'member', foreground: '795e26' },
  { token: 'constant', foreground: '0070c1' },
  { token: 'constant.numeric', foreground: '098658' },
  { token: 'constant.language', foreground: '0000ff' },
  { token: 'tag', foreground: '800000' },
  { token: 'attribute.name', foreground: 'e50000' },
  { token: 'attribute.value', foreground: '0451a5' },
  { token: 'delimiter', foreground: '1e1e1e' },
  { token: 'delimiter.bracket', foreground: 'b46400' },
  { token: 'operator', foreground: '1e1e1e' },
  { token: 'namespace', foreground: '267f99' },
  { token: 'class', foreground: '267f99' },
  { token: 'interface', foreground: '267f99' },
  { token: 'enum', foreground: '267f99' },
  { token: 'struct', foreground: '267f99' },
  { token: 'annotation', foreground: '795e26' },
  { token: 'punctuation', foreground: '1e1e1e' },
  { token: 'invalid', foreground: 'cd3131' },
]

/**
 * Monaco built-in themes: the guaranteed background/foreground base. Custom
 * theme ids below may only add syntax rules; their failure can never leave the
 * editor stuck on the other palette.
 */
const MONACO_BASE = { dark: 'vs-dark', light: 'vs' }

/** Monaco custom theme ids owned by this plugin (syntax rules on top of the base). */
const MONACO_THEME = { dark: 'drp-dark', light: 'drp-light' }

/** Runtime theme state: the optional theme service plus the last resolution. */
const themeRuntime = { service: undefined, scheme: 'dark', source: 'initial', base: 'vs-dark' }

// The editor always follows the DSH theme; a manual override from an earlier
// build is ignored and cleared so no stale localStorage value can force the
// wrong palette (a light page with dark ink, or the reverse).
try { localStorage.removeItem('dsh-review-panel.scheme') } catch (error) { /* storage is optional */ }

/**
 * Read a CSS custom property from the DSH theme surface.
 * @param {string} name token name
 * @returns {string} trimmed value or ''
 */
function readCssVar(name) {
  try {
    for (const node of [document.body, document.documentElement]) {
      if (!node) continue
      const value = getComputedStyle(node).getPropertyValue(name)
      if (value && value.trim() && !value.trim().startsWith('var(')) return value.trim()
    }
  } catch (error) {
    /* tokens are optional */
  }
  return ''
}

/**
 * Parse a CSS color (`#rgb`, `#rrggbb`, `rgb()`/`rgba()`) into RGB channels.
 * @param {string} value raw color
 * @returns {{r:number,g:number,b:number} | undefined}
 */
function parseColor(value) {
  const text = String(value || '').trim()
  if (!text) return undefined
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text)
  if (hex) {
    const digits = hex[1]
    if (digits.length === 3) {
      return {
        r: parseInt(digits[0] + digits[0], 16),
        g: parseInt(digits[1] + digits[1], 16),
        b: parseInt(digits[2] + digits[2], 16),
      }
    }
    const number = parseInt(digits, 16)
    return { r: (number >> 16) & 255, g: (number >> 8) & 255, b: number & 255 }
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)/i.exec(text)
  if (rgb) return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) }
  return undefined
}

/**
 * Perceived luminance (0–255) of a CSS color.
 * @param {string} value raw color
 * @returns {number | undefined}
 */
function luminanceOf(value) {
  const color = parseColor(value)
  if (!color) return undefined
  return 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b
}

/**
 * The scheme implied by the rendered page background, when readable.
 * The live computed background is the most reliable signal after a theme switch
 * because it already reflects the active DSH theme.
 * @returns {'light'|'dark' | undefined}
 */
function schemeFromRenderedBackground() {
  try {
    const candidates = []
    for (const node of [document.body, document.documentElement]) {
      if (!node) continue
      const style = getComputedStyle(node)
      candidates.push(style.backgroundColor)
      const token = style.getPropertyValue('--dsw-alias-bg-base')
      if (token) candidates.push(token.trim())
    }
    for (const value of candidates) {
      const luminance = luminanceOf(value)
      if (luminance === undefined) continue
      if (luminance <= 4) continue // fully transparent body: not informative
      return luminance < 128 ? 'dark' : 'light'
    }
  } catch (error) {
    /* fall through */
  }
  return undefined
}

/**
 * Resolve the active color scheme.
 *
 * Priority is the **rendered DSH surface** first (the `--dsw-alias-bg-base`
 * token / computed background): it already reflects the theme the user sees, so
 * it survives a live switch in either direction even when the optional theme
 * service snapshot or a DOM marker is stale. The official marker and the theme
 * service are fallbacks for the short moment before CSS variables update.
 * @returns {'light'|'dark'}
 */
function detectScheme() {
  const rendered = schemeFromRenderedBackground()
  if (rendered !== undefined) {
    themeRuntime.source = 'rendered-background'
    return rendered
  }
  try {
    const marked = document.body && document.body.getAttribute('data-ds-dark-theme')
    if (marked !== null && marked !== undefined && marked !== 'false') {
      themeRuntime.source = 'dom-marker'
      return 'dark'
    }
  } catch (error) {
    /* fall through */
  }
  try {
    const snapshot = typeof themeRuntime.service?.getTheme === 'function' ? themeRuntime.service.getTheme() : undefined
    const colorScheme = snapshot && snapshot.active && snapshot.active.colorScheme
    if (colorScheme === 'light' || colorScheme === 'dark') {
      themeRuntime.source = 'theme-service'
      return colorScheme
    }
  } catch (error) {
    /* fall through */
  }
  try {
    const attr = String(
      (document.documentElement && document.documentElement.getAttribute('data-theme')) ||
      (document.body && document.body.getAttribute('data-theme')) || '',
    ).toLowerCase()
    if (attr.includes('light') || attr.includes('latte')) {
      themeRuntime.source = 'data-theme'
      return 'light'
    }
    if (attr.includes('dark') || attr.includes('mocha') || attr.includes('frappe') || attr.includes('macchiato')) {
      themeRuntime.source = 'data-theme'
      return 'dark'
    }
  } catch (error) {
    /* fall through */
  }
  try {
    if (typeof window.matchMedia === 'function') {
      themeRuntime.source = 'prefers-color-scheme'
      return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
    }
  } catch (error) {
    /* fall through */
  }
  themeRuntime.source = 'default'
  return 'dark'
}

/**
 * Diff colors for one scheme, as Monaco color keys.
 * @param {'light'|'dark'} scheme scheme
 * @returns {Record<string,string>}
 */
function diffColorsOf(scheme) {
  const [added, removed, addText, delText] = DIFF_PALETTE[scheme === 'light' ? 'light' : 'dark']
  return {
    'diffEditor.insertedLineBackground': added,
    'diffEditor.removedLineBackground': removed,
    'diffEditor.insertedTextBackground': addText,
    'diffEditor.removedTextBackground': delText,
    'diffEditorGutter.insertedLineBackground': added,
    'diffEditorGutter.removedLineBackground': removed,
  }
}

/**
 * Read one CSS token only when its luminance fits the target scheme (background
 * tokens must be dark in the dark scheme and light in the light scheme);
 * otherwise the literal fallback wins. This is what keeps the Monaco theme from
 * inheriting stale light-theme token values after a live theme switch.
 * @param {string} name token name
 * @param {'light'|'dark'} scheme target scheme
 * @param {number | undefined} expectedLight whether the token must be light
 * @param {string} fallback fallback color
 * @returns {string}
 */
function schemeToken(name, scheme, expectedLight, fallback) {
  const raw = readCssVar(name)
  if (!raw) return fallback
  if (expectedLight === undefined) return raw
  const luminance = luminanceOf(raw)
  if (luminance === undefined) return raw
  return (luminance >= 128) === expectedLight ? raw : fallback
}

/**
 * Editor chrome colors for one scheme, matching VS Code 1.131 Dark/Light Modern
 * (the reference the file tree and tab bar are copied from) while keeping the
 * diff tints from the plugin palette.
 * @param {'light'|'dark'} scheme scheme
 * @returns {Record<string,string>}
 */
function editorColorsOf(scheme) {
  const light = scheme === 'light'
  return {
    'editor.background': light ? '#ffffff' : '#1f1f1f',
    'editor.foreground': light ? '#3b3b3b' : '#cccccc',
    'editorLineNumber.foreground': '#6e7681',
    'editorLineNumber.activeForeground': light ? '#3b3b3b' : '#cccccc',
    'editorCursor.foreground': light ? '#005fb8' : '#aeafad',
    // Higher-contrast selection (Cursor-style blue) so a selection remains
    // obvious on top of the green/red review-panel tints.
    'editor.selectionBackground': light ? '#9fc9f5' : '#2f5c8f',
    'editor.inactiveSelectionBackground': light ? '#d7e4f2' : '#3a4a5f',
    'editor.selectionHighlightBackground': light ? '#add6ff66' : '#264f7866',
    'editor.lineHighlightBackground': light ? '#00000000' : '#ffffff00',
    'editorIndentGuide.background1': light ? '#d3d3d3' : '#404040',
    'editorIndentGuide.activeBackground1': light ? '#939393' : '#707070',
    'editorWidget.background': light ? '#f8f8f8' : '#202020',
    'editorWidget.border': light ? '#e5e5e5' : '#454545',
    'editorGutter.background': light ? '#ffffff' : '#1f1f1f',
    'minimap.background': light ? '#ffffff' : '#1f1f1f',
    'scrollbarSlider.background': light ? '#64646466' : '#79797966',
    'scrollbarSlider.hoverBackground': light ? '#646464b3' : '#646464b3',
    'scrollbarSlider.activeBackground': light ? '#a6a6a666' : '#bfbfbf66',
    'editorBracketMatch.background': light ? '#0064001a' : '#0064001a',
    'editorBracketMatch.border': light ? '#005fb8' : '#0078d4',
    ...diffColorsOf(scheme),
  }
}

/**
 * Register the two plugin themes (idempotent).
 *
 * The custom theme carries the VS Code 1.131 Dark/Light Modern editor chrome
 * colors plus the plugin syntax rules. The base theme is still applied first in
 * {@link applyMonacoTheme}, so a failed defineTheme can never leave the editor on
 * the previous palette.
 * @param {any} monaco Monaco namespace
 */
function registerMonacoThemes(monaco) {
  try {
    if (!monaco || !monaco.editor || typeof monaco.editor.defineTheme !== 'function') return
    monaco.editor.defineTheme(MONACO_THEME.dark, {
      base: MONACO_BASE.dark,
      inherit: true,
      rules: DARK_RULES,
      colors: editorColorsOf('dark'),
    })
    monaco.editor.defineTheme(MONACO_THEME.light, {
      base: MONACO_BASE.light,
      inherit: true,
      rules: LIGHT_RULES,
      colors: editorColorsOf('light'),
    })
  } catch (error) {
    log('warn', 'monaco theme registration failed', error)
  }
}

/**
 * Apply the theme matching the current DSH scheme.
 *
 * The built-in base theme is applied FIRST and unconditionally, so the editor
 * background/foreground always follow the light/dark switch even if the custom
 * syntax theme cannot be defined in this Monaco build. The custom theme (syntax
 * rules on top of that base) is then applied best-effort with a base fallback.
 * @param {any} monaco Monaco namespace
 * @returns {'light'|'dark'} the applied scheme
 */
function applyMonacoTheme(monaco) {
  const scheme = detectScheme()
  themeRuntime.scheme = scheme
  const base = scheme === 'light' ? MONACO_BASE.light : MONACO_BASE.dark
  const custom = scheme === 'light' ? MONACO_THEME.light : MONACO_THEME.dark
  themeRuntime.base = base
  try {
    if (monaco && monaco.editor && typeof monaco.editor.setTheme === 'function') {
      monaco.editor.setTheme(base)
      try {
        registerMonacoThemes(monaco)
        monaco.editor.setTheme(custom)
      } catch (error) {
        // Any custom-theme problem keeps the base palette (correct background).
        log('warn', 'monaco custom theme skipped', error)
        try { monaco.editor.setTheme(base) } catch (fallbackError) { /* keep base */ }
      }
    }
  } catch (error) {
    /* no Monaco yet: the next render applies it */
  }
  return scheme
}

/**
 * Diff CSS variables for the current Monaco theme (used by view-zone DOM nodes).
 * @param {'light'|'dark'} scheme scheme
 * @returns {{add:string,del:string,fg:string,number:string}}
 */
function diffCssVarsOf(scheme) {
  const palette = DIFF_PALETTE[scheme === 'light' ? 'light' : 'dark']
  return {
    add: palette[0],
    del: palette[1],
    fg: themeRuntime.scheme === 'light' ? '#1e1e1e' : '#d4d4d4',
    number: themeRuntime.scheme === 'light' ? '#8c8c8c' : '#6e7681',
  }
}

/**
 * Subscribe to DSH theme changes.
 * @param {object} ctx client context
 * @param {() => void} onChange called after the runtime scheme may have changed
 * @returns {() => void} disposer
 */
function observeTheme(ctx, onChange) {
  const disposers = []
  const check = () => {
    try {
      onChange()
    } catch (error) {
      /* a theme repaint failure must never break the page */
    }
    // Theme CSS applies a tick after the preference event/mutation in some
    // paths: re-check once shortly after so light↔dark converges in both
    // directions even if the first read saw the previous surface.
    try {
      const retry = setTimeout(() => {
        try { onChange() } catch (error) { /* ignore */ }
      }, 120)
      disposers.push(() => clearTimeout(retry))
    } catch (error) {
      /* ignore */
    }
  }
  try {
    const dispose = ctx.on('theme/change', check)
    if (typeof dispose === 'function') disposers.push(dispose)
  } catch (error) {
    /* optional event */
  }
  try {
    if (typeof MutationObserver === 'function' && typeof document !== 'undefined') {
      const observer = new MutationObserver(check)
      for (const node of [document.body, document.documentElement]) {
        if (node) observer.observe(node, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'data-theme', 'class', 'style'] })
      }
      // Style-element swaps (theme stylesheets) mutate head, not the root attrs.
      if (document.head) observer.observe(document.head, { childList: true })
      disposers.push(() => observer.disconnect())
    }
  } catch (error) {
    /* optional observer */
  }
  try {
    if (typeof window.matchMedia === 'function') {
      const media = window.matchMedia('(prefers-color-scheme: dark)')
      if (media && typeof media.addEventListener === 'function') {
        media.addEventListener('change', check)
        disposers.push(() => media.removeEventListener('change', check))
      }
    }
  } catch (error) {
    /* optional media query */
  }
  try {
    const onFocus = () => check()
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    disposers.push(() => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    })
  } catch (error) {
    /* optional listeners */
  }
  // Low-frequency safety net: the rendered surface is the source of truth, so a
  // missed event cannot leave the editor stuck on the other theme.
  try {
    const interval = setInterval(() => {
      try {
        if (detectScheme() !== themeRuntime.scheme) onChange()
      } catch (error) {
        /* ignore */
      }
    }, 1200)
    disposers.push(() => clearInterval(interval))
  } catch (error) {
    /* ignore */
  }
  // One delayed re-check catches themes applied right after this page mounted.
  try {
    const timer = setTimeout(check, 600)
    disposers.push(() => clearTimeout(timer))
  } catch (error) {
    /* ignore */
  }
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch (error) {
        /* ignore */
      }
    }
  }
}
