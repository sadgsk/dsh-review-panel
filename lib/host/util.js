/** JSON response and query-coordinate helpers for the read-only review routes. */

/**
 * Build a no-store JSON response.
 * @param {unknown} body serializable payload
 * @param {number} [status] HTTP status
 * @returns {Response}
 */
export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * Build the SPEC error envelope.
 * @param {string} code stable machine code
 * @param {string} message human readable message
 * @param {number} status HTTP status
 * @returns {Response}
 */
export function failure(code, message, status) {
  return jsonResponse({ error: { code, message } }, status)
}

/**
 * Parse a non-negative safe-integer query coordinate.
 * @param {string | number | null} value query string or JSON numeric coordinate
 * @returns {number | undefined}
 */
export function coordinate(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : undefined
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
}

/**
 * Read a bounded opaque identifier query value.
 * @param {string | null} value raw query value
 * @param {number} [maxLength] length bound
 * @returns {string | undefined}
 */
export function identifier(value, maxLength = 256) {
  if (typeof value !== 'string') return undefined
  if (value.length === 0 || value.length > maxLength) return undefined
  return value
}

/**
 * Reject relative workspace paths that could escape the workspace or confuse the
 * filesystem provider: empty segments, `.`/`..`, drive letters, control chars.
 * @param {string} value workspace-relative path using either separator
 * @returns {boolean} whether the path is a safe non-empty relative path
 */
export function safeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) return false
  if (/[\u0000-\u001f\u007f]/.test(value)) return false
  if (/^[a-zA-Z]:/.test(value) || value.startsWith('/') || value.startsWith('\\')) return false
  const segments = value.split(/[\\/]+/)
  if (segments.length === 0) return false
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return false
  }
  return true
}

/**
 * Validate a browser-supplied git revision expression (no spaces, no leading dash).
 * @param {unknown} value raw query value
 * @returns {string | undefined} trimmed revision expression, or undefined when unsafe
 */
export function safeRevision(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 200) return undefined
  if (/[\u0000-\u0020\u007f]/.test(trimmed)) return undefined
  if (trimmed.startsWith('-')) return undefined
  if (!/^[A-Za-z0-9_./~^@{}:+-]+$/.test(trimmed)) return undefined
  return trimmed
}

/**
 * Strip the internal recorder fields the browser should not depend on.
 * @param {object} summary WorkspaceChangesSummary
 * @returns {{turn:number,total:number,added:number,deleted:number,files:Array<object>}}
 */
export function publicSummary(summary) {
  const files = Array.isArray(summary?.files)
    ? summary.files.map((file) => ({
        path: String(file.path),
        display: String(file.display ?? file.path),
        added: Number(file.added) || 0,
        deleted: Number(file.deleted) || 0,
        ...(file.binary === true ? { binary: true } : {}),
        ...(file.oversized === true ? { oversized: true } : {}),
      }))
    : []
  return {
    turn: Number(summary?.turn) || 0,
    total: Number(summary?.total ?? files.length) || 0,
    added: Number(summary?.added) || 0,
    deleted: Number(summary?.deleted) || 0,
    files,
  }
}
