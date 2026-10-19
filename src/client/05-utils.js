/* dsh-review-panel client half — pure helpers. */

/**
 * Join class names, dropping empty values.
 * @param {...(string|false|null|undefined)} values class names
 * @returns {string}
 */
function cx(...values) {
  return values.filter((value) => typeof value === 'string' && value.length > 0).join(' ')
}

/**
 * Resolve an application-local path against the document base (reverse-proxy and
 * desktop `dsh-app:` safe).
 * @param {string} path root-shaped path
 * @returns {string} absolute application URL
 */
function appUrl(path) {
  try {
    const base = (typeof document !== 'undefined' && document.baseURI) || (typeof location !== 'undefined' ? location.href : undefined)
    if (!base) return path
    const root = new URL('.', base)
    return new URL(String(path).replace(/^\/+/, ''), root).href
  } catch (error) {
    return path
  }
}

/**
 * Read one optional client service without throwing.
 * @param {object} ctx client plugin context
 * @param {string} name service name
 * @returns {any}
 */
function safeGet(ctx, name) {
  try {
    return ctx.get(name)
  } catch (error) {
    return undefined
  }
}

/** Resolve shortcut labels against the connected client's profile, not the Host OS. */
function shortcutEnvironment(service) {
  if (!service && typeof globalCtxRef !== 'undefined' && globalCtxRef.current) {
    service = safeGet(globalCtxRef.current, 'shortcuts')
  }
  let detected = ''
  try {
    if (typeof navigator !== 'undefined') detected = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || ''
  } catch (error) { /* use the service profile or neutral labels */ }
  const rawPlatform = String(service?.platform || detected).toLowerCase()
  const platform = /mac|darwin|iphone|ipad/.test(rawPlatform) ? 'macos'
    : /win/.test(rawPlatform) ? 'windows' : /linux/.test(rawPlatform) ? 'linux' : 'unknown'
  let runtime = service?.runtime
  if (runtime !== 'desktop' && runtime !== 'web') {
    runtime = typeof document !== 'undefined' && /^dsh-app:/i.test(document.baseURI || '') ? 'desktop' : 'web'
  }
  return { platform, runtime }
}

/** Name one logical/physical modifier using the current client platform. */
function shortcutModifierLabel(modifier, environment = shortcutEnvironment()) {
  const mac = environment.platform === 'macos'
  const labels = {
    primary: mac ? 'Cmd' : 'Ctrl', control: 'Ctrl', shift: 'Shift',
    alt: mac ? 'Option' : 'Alt', meta: mac ? 'Cmd' : environment.platform === 'windows' ? 'Win' : 'Super',
  }
  return labels[modifier] || modifier
}

/**
 * Tagged console logger (the client runtime tags it per package).
 * @param {'log'|'warn'|'error'} level console level
 * @param {...unknown} args values
 */
function log(level, ...args) {
  try {
    const target = console[level] || console.log
    target.call(console, '[dsh-review-panel]', ...args)
  } catch (error) {
    /* logging must never break the view */
  }
}

/**
 * Format an integer with grouping.
 * @param {number} value number
 * @returns {string}
 */
function fmtInt(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '0'
  return number.toLocaleString('en-US')
}

/**
 * Decode one service response as JSON, mapping HTTP failures to Errors.
 * @param {Response} response fetch response
 * @returns {Promise<any>}
 */
async function decodeJson(response) {
  let body = null
  try {
    body = await response.json()
  } catch (error) {
    body = null
  }
  if (!response.ok) {
    const message = body && body.error && typeof body.error.message === 'string'
      ? body.error.message
      : 'HTTP ' + response.status
    const failure = new Error(message)
    failure.status = response.status
    failure.code = body && body.error ? body.error.code : undefined
    throw failure
  }
  return body
}

/**
 * GET one authenticated review route with document-relative resolution.
 * @param {string} name route key in ROUTES
 * @param {Record<string, string|number|undefined|null>} [params] query parameters
 * @param {AbortSignal} [signal] cancellation
 * @returns {Promise<any>}
 */
async function apiGet(name, params, signal) {
  const query = new URLSearchParams()
  if (params) {
    for (const key of Object.keys(params)) {
      const value = params[key]
      if (value === undefined || value === null || value === '') continue
      query.set(key, String(value))
    }
  }
  const suffix = query.toString()
  const url = ROUTES[name] + (suffix ? '?' + suffix : '')
  const response = await fetch(url, {
    signal,
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  })
  return decodeJson(response)
}

/**
 * POST one authenticated review route with a JSON body.
 * @param {string} name route key in ROUTES
 * @param {object} body JSON body
 * @param {AbortSignal} [signal] cancellation
 * @returns {Promise<any>}
 */
async function apiPost(name, body, signal) {
  const response = await fetch(ROUTES[name], {
    method: 'POST',
    signal,
    credentials: 'same-origin',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  })
  return decodeJson(response)
}

/**
 * Normalize a workspace-relative path for display and comparison.
 * @param {string} value path using either separator
 * @returns {string} posix relative path without leading `./`
 */
function normalizeRel(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '')
}

/**
 * Split a normalized relative path into segments.
 * @param {string} value normalized path
 * @returns {string[]}
 */
function segmentsOf(value) {
  const normalized = normalizeRel(value)
  return normalized === '' ? [] : normalized.split('/')
}

/**
 * The final segment of a path.
 * @param {string} value path
 * @returns {string}
 */
function basename(value) {
  const segments = segmentsOf(value)
  return segments.length === 0 ? '' : segments[segments.length - 1]
}

/**
 * The parent path of a normalized relative path ('' for top-level files).
 * @param {string} value normalized path
 * @returns {string}
 */
function dirname(value) {
  const segments = segmentsOf(value)
  segments.pop()
  return segments.join('/')
}

/**
 * Join relative path segments, skipping empty segments.
 * @param {...string} parts segments
 * @returns {string}
 */
function joinRel(...parts) {
  const segments = []
  for (const part of parts) for (const segment of segmentsOf(part)) segments.push(segment)
  return segments.join('/')
}

/**
 * Whether a path should open in the code viewer (vs handoff to DSH preview).
 * @param {string} path workspace-relative path
 * @returns {boolean}
 */
function isCodeFile(path) {
  const name = basename(path).toLowerCase()
  if (name === '') return false
  if (CODE_BASENAMES.has(name)) return true
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return false
  return CODE_EXT.has(name.slice(dot + 1))
}

/**
 * Monaco language id for a path.
 * @param {string} path workspace-relative path
 * @returns {string}
 */
function languageOf(path) {
  const name = basename(path).toLowerCase()
  if (name === 'dockerfile') return 'dockerfile'
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return 'plaintext'
  return LANG_BY_EXT[name.slice(dot + 1)] || 'plaintext'
}

/**
 * Split text into lines, normalizing CRLF/CR (Monaco reports line numbers by line).
 * @param {string} text source text
 * @returns {string[]}
 */
function splitLines(text) {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (normalized === '') return []
  const lines = normalized.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * Current date-time stamp for status messages.
 * @returns {string}
 */
function timeStamp() {
  try {
    const now = new Date()
    return now.toLocaleTimeString('zh-CN', { hour12: false })
  } catch (error) {
    return ''
  }
}

/**
 * Escape a string for safe use inside a RegExp.
 * @param {string} value raw text
 * @returns {string}
 */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
