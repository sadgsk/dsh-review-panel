/**
 * Read-only workspace index + text search for Quick Open and Search.
 *
 * Both surfaces walk the session workspace through `workspaceFiles.list` and
 * read through `workspaceFiles.readBytes`; nothing is written and every walk is
 * bounded by depth, entry count, file size, and total scan budget.
 */

/** Directories never indexed (dependency/build/VCS noise). */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next', '.nuxt',
  '.cache', '.turbo', '.parcel-cache', 'target', 'obj', 'bin', 'vendor', '.venv',
  'venv', '__pycache__', '.idea', '.vscode', 'coverage', '.dsh', '.pnpm-store',
])

/** File extensions never read by search. */
const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'pdf', 'zip', 'gz', 'tgz', '7z', 'rar',
  'tar', 'exe', 'dll', 'so', 'dylib', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp3', 'mp4',
  'mov', 'avi', 'webm', 'sqlite', 'db', 'class', 'jar', 'wasm', 'o', 'obj', 'a', 'lib', 'pdb',
  'bcmap', 'pfb', 'zstd', 'zst', 'asar',
])

const INDEX_TTL_MS = 30000
const MAX_FILES = 8000
const MAX_DEPTH = 14
const MAX_ENTRIES_PER_DIR = 2000
const MAX_SEARCH_FILES = 1500
const MAX_SEARCH_BYTES = 24 * 1024 * 1024
const MAX_FILE_BYTES = 512 * 1024
const MAX_RESULTS = 200
const SEARCH_TIME_BUDGET_MS = 8000

/**
 * Join a parent posix path and a child name.
 * @param {string} parent parent path ('' for root)
 * @param {string} name child name
 * @returns {string}
 */
export function joinPath(parent, name) {
  return parent === '' ? name : parent + '/' + name
}

/**
 * Whether a file name is searchable text.
 * @param {string} name basename
 * @returns {boolean}
 */
function searchableName(name) {
  const dot = name.toLowerCase().lastIndexOf('.')
  if (dot < 0) return true
  return !BINARY_EXT.has(name.toLowerCase().slice(dot + 1))
}

/**
 * Per-session cached workspace file index (paths only, cwd-relative posix).
 */
export class WorkspaceIndex {
  /**
   * @param {object} ctx Host context
   * @param {number} [ttlMs] cache lifetime
   */
  constructor(ctx, ttlMs = INDEX_TTL_MS) {
    this.ctx = ctx
    this.ttlMs = ttlMs
    this.cache = new Map()
  }

  /**
   * Drop one session's cached index.
   * @param {string} sessionId session identity
   */
  invalidate(sessionId) {
    this.cache.delete(sessionId)
  }

  /**
   * Walk the workspace breadth-first under the given caps.
   * @param {{sessionId:string, workspaceRoot:string}} scope workspace scope
   * @param {AbortSignal} signal cancellation
   * @returns {Promise<{files:string[], truncated:boolean}>}
   */
  async walk(scope, signal) {
    const files = []
    const queue = [{ dir: '', depth: 0 }]
    let truncated = false
    while (queue.length > 0) {
      if (signal?.aborted) throw new Error('aborted')
      const next = queue.shift()
      let listing
      try {
        listing = await this.ctx.workspaceFiles.list(scope, next.dir === '' ? scope.workspaceRoot : next.dir, signal)
      } catch {
        continue
      }
      const entries = Array.isArray(listing?.entries) ? listing.entries.slice(0, MAX_ENTRIES_PER_DIR) : []
      if (listing?.truncated === true || entries.length < (listing?.entries?.length ?? 0)) truncated = true
      for (const entry of entries) {
        const child = joinPath(next.dir, String(entry.name))
        if (entry.type === 'directory') {
          if (SKIP_DIRS.has(String(entry.name).toLowerCase())) continue
          if (next.depth + 1 > MAX_DEPTH) {
            truncated = true
            continue
          }
          queue.push({ dir: child, depth: next.depth + 1 })
        } else if (entry.type === 'file') {
          files.push(child)
          if (files.length >= MAX_FILES) {
            truncated = true
            return { files, truncated }
          }
        }
      }
    }
    return { files, truncated }
  }

  /**
   * Cached index read.
   * @param {{sessionId:string, workspaceRoot:string}} scope workspace scope
   * @param {AbortSignal} signal cancellation
   * @param {boolean} [force] bypass cache
   * @returns {Promise<{files:string[], truncated:boolean, cached:boolean}>}
   */
  async get(scope, signal, force = false) {
    const key = scope.sessionId + '\n' + scope.workspaceRoot
    const now = Date.now()
    const hit = this.cache.get(key)
    if (!force && hit && now - hit.at < this.ttlMs) return { files: hit.files, truncated: hit.truncated, cached: true }
    const walked = await this.walk(scope, signal)
    this.cache.set(key, { at: now, files: walked.files, truncated: walked.truncated })
    return { ...walked, cached: false }
  }
}

/**
 * Case-insensitive substring search across indexed text files.
 * @param {object} ctx Host context
 * @param {WorkspaceIndex} index workspace index
 * @param {{sessionId:string, workspaceRoot:string}} scope workspace scope
 * @param {{query:string, limit?:number, signal?:AbortSignal}} options search options
 * @returns {Promise<{results:Array<object>, scanned:number, truncated:boolean, elapsedMs:number}>}
 */
export async function searchWorkspace(ctx, index, scope, options) {
  const query = String(options.query || '').trim()
  if (query.length === 0) return { results: [], scanned: 0, truncated: false, elapsedMs: 0 }
  const limit = Math.min(MAX_RESULTS, Math.max(1, Number(options.limit) || MAX_RESULTS))
  const startedAt = Date.now()
  const signal = options.signal
  const walk = await index.get(scope, signal)
  const results = []
  let scanned = 0
  let bytes = 0
  let truncated = walk.truncated
  const needle = query.toLowerCase()
  for (const path of walk.files) {
    if (signal?.aborted) break
    if (Date.now() - startedAt > SEARCH_TIME_BUDGET_MS) {
      truncated = true
      break
    }
    if (results.length >= limit) {
      truncated = true
      break
    }
    if (!searchableName(path)) continue
    if (scanned >= MAX_SEARCH_FILES) {
      truncated = true
      break
    }
    scanned += 1
    let read
    try {
      read = await ctx.workspaceFiles.readBytes(scope, path, {}, signal)
    } catch {
      continue
    }
    if (!read || !(read.data instanceof Uint8Array)) continue
    if (read.data.byteLength > MAX_FILE_BYTES) {
      truncated = true
      continue
    }
    bytes += read.data.byteLength
    if (bytes > MAX_SEARCH_BYTES) {
      truncated = true
      break
    }
    const text = new TextDecoder('utf-8', { fatal: false }).decode(read.data)
    if (text.indexOf('\u0000') >= 0) continue
    const lines = text.split(/\r\n|\r|\n/)
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex]
      const at = line.toLowerCase().indexOf(needle)
      if (at < 0) continue
      results.push({
        path,
        line: lineIndex + 1,
        column: at + 1,
        text: line.length > 240 ? line.slice(0, 240) + '…' : line,
      })
      if (results.length >= limit) break
    }
  }
  return { results, scanned, truncated, elapsedMs: Date.now() - startedAt }
}
