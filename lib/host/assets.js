/**
 * Static route for the vendored Monaco AMD build.
 *
 * `ctx.webServer.register` routes carry no authentication of their own, so the
 * handler applies the Host Connection fence first (fail closed when the service
 * is unavailable), then resolves the request path against the package's
 * `assets/vendor/monaco` directory with realpath containment.
 */
import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Prefix claimed by the plugin; namespaced to avoid any shipped route.
 * NOTE: `ctx.webServer.match()` matches `pathname === prefix || pathname.startsWith(prefix + '/')`,
 * so the registered prefix must NOT carry a trailing slash or nested files never match.
 */
export const VENDOR_PREFIX = '/dsh-review-panel/monaco'

/** Content types present in the AMD build (js/css/ttf). */
const VENDOR_MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}

/**
 * Apply the Connection request policy; returns the rejection status, or
 * undefined when admitted. Never admits on a capability mismatch.
 * @param {object} ctx host context
 * @param {import('node:http').IncomingMessage} req request
 * @returns {number | undefined}
 */
function rejectionOf(ctx, req) {
  try {
    const connection = ctx.connection
    if (connection && typeof connection.requestRejection === 'function') {
      const rejection = connection.requestRejection(req)
      return rejection === 401 || rejection === 403 ? rejection : undefined
    }
  } catch {
    /* fall through to fail-closed */
  }
  return 503
}

/**
 * Serve one file under the Monaco vendor directory.
 * @param {string} root absolute vendor root
 * @param {import('node:http').IncomingMessage} req request
 * @param {import('node:http').ServerResponse} res response
 */
async function serveVendor(root, req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405
    res.end()
    return
  }
  try {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    if (pathname !== VENDOR_PREFIX && !pathname.startsWith(VENDOR_PREFIX + '/')) {
      res.statusCode = 404
      res.end()
      return
    }
    let raw
    try {
      raw = decodeURIComponent(pathname.slice(VENDOR_PREFIX.length)).replace(/^\/+/, '')
    } catch {
      res.statusCode = 400
      res.end()
      return
    }
    if (!raw || raw.includes('\u0000')) {
      res.statusCode = 404
      res.end()
      return
    }
    const segments = raw.split('/')
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      res.statusCode = 403
      res.end()
      return
    }
    const canonicalRoot = await realpath(root)
    const target = await realpath(resolve(canonicalRoot, raw))
    const rel = relative(canonicalRoot, target)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
      res.statusCode = 403
      res.end()
      return
    }
    const info = await stat(target)
    if (!info.isFile()) {
      res.statusCode = 404
      res.end()
      return
    }
    const etag = 'W/"' + info.mtimeMs.toString(16) + '-' + info.size.toString(16) + '"'
    res.setHeader('etag', etag)
    res.setHeader('cache-control', 'private, max-age=3600')
    if (req.headers['if-none-match'] === etag) {
      res.statusCode = 304
      res.end()
      return
    }
    res.statusCode = 200
    res.setHeader('content-type', VENDOR_MIME[extname(target).toLowerCase()] ?? 'application/octet-stream')
    res.setHeader('content-length', info.size)
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    res.end(await readFile(target))
  } catch {
    if (!res.headersSent) res.statusCode = 404
    res.end()
  }
}

/**
 * Register the authenticated Monaco asset prefix route.
 * @param {object} ctx host plugin context
 */
export function registerVendorRoute(ctx) {
  const root = fileURLToPath(new URL('../../assets/vendor/monaco/', import.meta.url))
  const handler = (req, res) => {
    const rejection = rejectionOf(ctx, req)
    if (rejection !== undefined) {
      res.statusCode = rejection
      res.setHeader('cache-control', 'no-store')
      res.end()
      return
    }
    void serveVendor(root, req, res)
  }
  try {
    const web = ctx.webServer
    if (!web || typeof web.register !== 'function') {
      ctx.logger?.warn?.('dsh-review-panel: webServer unavailable; Monaco assets cannot be served')
      return
    }
    const dispose = web.register({ kind: 'prefix', path: VENDOR_PREFIX, handler })
    ctx.effect(() => () => {
      try {
        dispose()
      } catch {
        /* webserver teardown may already own the route */
      }
    }, 'dsh-review-panel: Monaco vendor route')
  } catch (error) {
    ctx.logger?.warn?.(`dsh-review-panel: Monaco vendor route unavailable (${String(error)})`)
  }
}
