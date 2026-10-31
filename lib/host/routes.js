/**
 * Authenticated read-only JSON routes for the inline diff review tab.
 *
 * All routes live under Connection's `/api/` Fetch channel
 * (`ctx.connection.fetch.register`), so they inherit the browser
 * authentication fence: untrusted Host/Origin → 403, unauthenticated → 401,
 * non-owner peer → 403. The browser half calls them with a document-relative
 * URL (leading slash stripped) so desktop `dsh-app:` documents resolve them.
 */
import { coordinate, failure, identifier, jsonResponse, publicSummary, safeRelativePath, safeRevision } from './util.js'
import { createChangesTracker, cwdOf, lastChangesEvent, liveSession } from './session.js'
import {
  createGitProvider,
  listGitRevisions,
  readGitCompare,
  readGitContentAt,
  readGitFile,
  readGitFileAgainst,
  readGitStatus,
} from './git.js'
import { WorkspaceIndex, searchWorkspace } from './files-index.js'
import { LspBridge } from './lsp.js'
import { posix, win32 } from 'node:path'

/** Exact Fetch paths; `/api/` prefix is mandatory for the connection fence. */
export const ROUTES = {
  latest: '/api/review-panel.latest',
  summary: '/api/review-panel.summary',
  diff: '/api/review-panel.diff',
  file: '/api/review-panel.file',
  tree: '/api/review-panel.tree',
  config: '/api/review-panel.config',
  gitStatus: '/api/review-panel.git-status',
  gitFile: '/api/review-panel.git-file',
  gitRevisions: '/api/review-panel.git-revisions',
  gitCompare: '/api/review-panel.git-compare',
  files: '/api/review-panel.files',
  search: '/api/review-panel.search',
  lsp: '/api/review-panel.lsp',
}

/** LSP actions the browser may invoke (read-only language features). */
const LSP_ACTIONS = new Set(['status', 'definition', 'references', 'hover', 'symbols', 'diagnostics'])
/** Longest document text accepted for LSP sync. */
const LSP_MAX_TEXT_BYTES = 2 * 1024 * 1024

/** Text files above this size are reported as oversized instead of being read. */
const MAX_FILE_BYTES = 2 * 1024 * 1024

/**
 * Join a workspace-relative posix path with the native separator.
 * @param {string} rel posix relative path
 * @returns {string} native relative path
 */
function nativePath(rel) {
  return process.platform === 'win32' ? rel.split('/').join('\\') : rel
}

/**
 * Whether the absolute path stays inside the workspace root.
 * @param {string} root absolute workspace root
 * @param {string} target absolute candidate
 * @returns {boolean}
 */
function withinRoot(root, target) {
  if (typeof root !== 'string' || typeof target !== 'string') return false
  const windows = /^[a-z]:[\\/]/i.test(root) || root.startsWith('\\\\') || root.startsWith('//')
  const paths = windows ? win32 : posix
  if (!paths.isAbsolute(root) || !paths.isAbsolute(target)) return false
  const rel = paths.relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + paths.sep) && !paths.isAbsolute(rel))
}

/**
 * Whether a byte prefix looks binary (NUL byte or many undecodable control bytes).
 * @param {Uint8Array | undefined} data bytes
 * @returns {boolean}
 */
function looksBinary(data) {
  if (!(data instanceof Uint8Array)) return false
  const limit = Math.min(data.byteLength, 8192)
  for (let index = 0; index < limit; index += 1) {
    if (data[index] === 0) return true
  }
  return false
}

/**
 * Count lines of a decoded text payload.
 * @param {string} text decoded text
 * @returns {number}
 */
function countLines(text) {
  if (text.length === 0) return 0
  let lines = 1
  for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) === 10) lines += 1
  return text.endsWith('\n') ? lines - 1 : lines
}

/**
 * Latest turn announcement for a session, with its summary when the Host still
 * serves it (it does not survive a Host restart).
 * @param {object} ctx host context
 * @param {WeakMap<object, any>} tracker live announcement tracker
 * @param {string} sessionId session identity
 * @returns {Promise<Response>}
 */
async function handleLatest(ctx, tracker, sessionId) {
  const session = liveSession(ctx, sessionId)
  if (!session) return jsonResponse({ available: false, reason: 'session-not-live' })
  const cwd = cwdOf(session)
  if (!cwd) return jsonResponse({ available: false, reason: 'no-cwd' })
  const event = tracker.get(session) ?? lastChangesEvent(session)
  if (!event) return jsonResponse({ available: false, reason: 'no-changes', cwd })
  const seq = Number(event.seq)
  const turn = Number(event.data.turn)
  let summary
  try {
    summary = ctx.workspaceChanges.summary(sessionId, seq)
  } catch {
    summary = undefined
  }
  if (!summary) return jsonResponse({ available: false, reason: 'summary-unavailable', seq, turn, cwd })
  return jsonResponse({ available: true, seq, turn, cwd, summary: publicSummary(summary) })
}

/**
 * Serve one announced turn summary.
 * @param {object} ctx host context
 * @param {Request} request Fetch request
 * @returns {Promise<Response>}
 */
async function handleSummary(ctx, request) {
  const query = new URL(request.url).searchParams
  const sessionId = identifier(query.get('sessionId'))
  const seq = coordinate(query.get('seq'))
  if (!sessionId || seq === undefined) return failure('invalid-coordinates', 'Invalid change summary coordinates.', 400)
  if (!liveSession(ctx, sessionId)) return failure('session-not-live', 'Change summary unavailable.', 404)
  let summary
  try {
    summary = ctx.workspaceChanges.summary(sessionId, seq)
  } catch {
    summary = undefined
  }
  if (!summary) return failure('summary-unavailable', 'Change summary unavailable.', 404)
  return jsonResponse({ seq, ...publicSummary(summary) })
}

/**
 * Serve one listed file's turn-start/turn-end comparison.
 * @param {object} ctx host context
 * @param {Request} request Fetch request
 * @returns {Promise<Response>}
 */
async function handleDiff(ctx, request) {
  const query = new URL(request.url).searchParams
  const sessionId = identifier(query.get('sessionId'))
  const seq = coordinate(query.get('seq'))
  const index = coordinate(query.get('index'))
  if (!sessionId || seq === undefined || index === undefined) {
    return failure('invalid-coordinates', 'Invalid changed file coordinates.', 400)
  }
  if (!liveSession(ctx, sessionId)) return failure('session-not-live', 'Change comparison unavailable.', 404)
  try {
    const diff = await ctx.workspaceChanges.diff(sessionId, seq, index, request.signal)
    if (!diff) return failure('diff-unavailable', 'Change comparison unavailable.', 404)
    return jsonResponse(diff)
  } catch (error) {
    if (request.signal?.aborted) return failure('aborted', 'Request aborted.', 499)
    return failure('diff-failed', 'Change comparison unavailable.', 404)
  }
}

/** Map file-service errors without treating permission or I/O failures as deletion. */
function fileReadFailure(error, signal, operation) {
  if (signal?.aborted) return failure('aborted', 'Request aborted.', 499)
  const codes = new Set([error?.code, error?.cause?.code])
  if (['ENOENT', 'ENOTDIR', 'FS_NOT_FOUND', 'not-found'].some((code) => codes.has(code))) {
    return failure('not-found', 'File unavailable.', 404)
  }
  if (['EACCES', 'EPERM', 'FS_PERMISSION_DENIED', 'permission-denied'].some((code) => codes.has(code))) {
    return failure('permission-denied', 'File access denied.', 403)
  }
  return failure(operation + '-failed', 'File content unavailable.', 502)
}

/**
 * Serve one complete current file (or one file as committed at a revision).
 * @param {object} ctx host context
 * @param {() => Promise<object | null>} gitProvider lazy git runner provider
 * @param {Request} request Fetch request
 * @returns {Promise<Response>}
 */
async function handleFile(ctx, gitProvider, request) {
  const query = new URL(request.url).searchParams
  const sessionId = identifier(query.get('sessionId'))
  const rel = query.get('path') ?? ''
  if (!sessionId) return failure('invalid-coordinates', 'Missing session id.', 400)
  if (!safeRelativePath(rel)) return failure('invalid-path', 'Invalid workspace path.', 400)
  const session = liveSession(ctx, sessionId)
  if (!session) return failure('session-not-live', 'Session is not live on this Host.', 404)
  const cwd = cwdOf(session)
  if (!cwd) return failure('no-cwd', 'Session has no working directory.', 404)
  const rawRevision = query.get('rev')
  if (rawRevision !== null) {
    const rev = safeRevision(rawRevision)
    if (!rev) return failure('invalid-revision', 'Invalid git revision.', 400)
    try {
      const content = await readGitContentAt(ctx, gitProvider, { cwd, path: rel, rev, signal: request.signal })
      if (content?.available === false) {
        if (content.reason === 'unknown-revision') return failure('invalid-revision', 'Unknown git revision.', 400)
        if (content.reason === 'file-unavailable') return failure('not-found', 'File unavailable.', 404)
        return jsonResponse(content)
      }
      if (content.kind === 'text') {
        return jsonResponse({
          kind: 'text',
          path: rel,
          display: rel,
          text: content.text,
          lines: content.lines,
          bytes: content.bytes,
          version: content.version,
          absolutePath: content.absolutePath,
        })
      }
      return jsonResponse({ kind: content.kind, path: rel, display: rel, bytes: content.bytes, absolutePath: content.absolutePath })
    } catch (error) {
      if (request.signal?.aborted) return failure('aborted', 'Request aborted.', 499)
      return failure('read-failed', 'File content unavailable.', 502)
    }
  }
  const scope = { sessionId, workspaceRoot: cwd }
  const target = nativePath(rel)
  let stat
  try {
    stat = await ctx.workspaceFiles.stat(scope, target, request.signal)
  } catch (error) {
    return fileReadFailure(error, request.signal, 'stat')
  }
  if (!stat || typeof stat.absolutePath !== 'string') return failure('not-found', 'File unavailable.', 404)
  if (!withinRoot(cwd, stat.absolutePath)) {
    return failure('outside-workspace', 'File is outside the session workspace.', 403)
  }
  if (typeof stat.bytes === 'number' && stat.bytes > MAX_FILE_BYTES) {
    return jsonResponse({ kind: 'oversized', path: rel, display: rel, bytes: stat.bytes, absolutePath: stat.absolutePath })
  }
  let read
  try {
    read = await ctx.workspaceFiles.readBytes(scope, target, {}, request.signal)
  } catch (error) {
    return fileReadFailure(error, request.signal, 'read')
  }
  if (!read || !(read.data instanceof Uint8Array)) return failure('read-failed', 'File content unavailable.', 502)
  if (looksBinary(read.data)) {
    return jsonResponse({ kind: 'binary', path: rel, display: rel, bytes: read.data.byteLength, absolutePath: stat.absolutePath })
  }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(read.data)
  return jsonResponse({
    kind: 'text',
    path: rel,
    display: rel,
    text,
    lines: countLines(text),
    bytes: read.data.byteLength,
    version: read.version ?? stat.version,
    absolutePath: stat.absolutePath,
  })
}

/**
 * Serve one directory's direct children for the lazy workspace tree.
 * @param {object} ctx host context
 * @param {Request} request Fetch request
 * @returns {Promise<Response>}
 */
async function handleTree(ctx, request) {
  const query = new URL(request.url).searchParams
  const sessionId = identifier(query.get('sessionId'))
  const rel = query.get('path') ?? ''
  if (!sessionId) return failure('invalid-coordinates', 'Missing session id.', 400)
  if (rel !== '' && !safeRelativePath(rel)) return failure('invalid-path', 'Invalid workspace path.', 400)
  const session = liveSession(ctx, sessionId)
  if (!session) return failure('session-not-live', 'Session is not live on this Host.', 404)
  const cwd = cwdOf(session)
  if (!cwd) return failure('no-cwd', 'Session has no working directory.', 404)
  const scope = { sessionId, workspaceRoot: cwd }
  const target = rel === '' ? cwd : nativePath(rel)
  let listing
  try {
    listing = await ctx.workspaceFiles.list(scope, target, request.signal)
  } catch (error) {
    return failure('list-failed', 'Directory unavailable.', 404)
  }
  if (!listing || !Array.isArray(listing.entries)) return failure('not-found', 'Directory unavailable.', 404)
  return jsonResponse({
    path: rel,
    truncated: listing.truncated === true,
    entries: listing.entries.map((entry) => ({
      name: String(entry.name),
      type: entry.type === 'directory' ? 'directory' : entry.type === 'file' ? 'file' : 'other',
      ...(typeof entry.size === 'number' ? { size: entry.size } : {}),
    })),
  })
}

/**
 * Resolve the live session and its working directory from a request query.
 * @param {object} ctx host context
 * @param {Request} request fetch request
 * @returns {{sessionId:string, cwd:string} | Response}
 */
function sessionCoordinates(ctx, request) {
  const sessionId = identifier(new URL(request.url).searchParams.get('sessionId'))
  if (!sessionId) return failure('invalid-coordinates', 'Missing session id.', 400)
  const session = liveSession(ctx, sessionId)
  if (!session) return failure('session-not-live', 'Session is not live on this Host.', 404)
  const cwd = cwdOf(session)
  if (!cwd) return failure('no-cwd', 'Session has no working directory.', 404)
  return { sessionId, cwd }
}

/**
 * Working-tree status of the session repository (read-only git).
 * @param {object} ctx host context
 * @param {() => Promise<object | null>} gitProvider lazy git runner provider
 * @param {Request} request fetch request
 * @returns {Promise<Response>}
 */
async function handleGitStatus(ctx, gitProvider, request) {
  const coordinates = sessionCoordinates(ctx, request)
  if (coordinates instanceof Response) return coordinates
  try {
    const status = await readGitStatus(ctx, gitProvider, coordinates.cwd, request.signal)
    return jsonResponse(status)
  } catch (error) {
    if (request.signal?.aborted) return failure('aborted', 'Request aborted.', 499)
    return jsonResponse({ available: false, reason: 'git-failed', detail: String(error?.message || error).slice(0, 400) })
  }
}

/**
 * One file's HEAD↔worktree comparison, or its comparison against a revision.
 * @param {object} ctx host context
 * @param {() => Promise<object | null>} gitProvider lazy git runner provider
 * @param {Request} request fetch request
 * @returns {Promise<Response>}
 */
async function handleGitFile(ctx, gitProvider, request) {
  const coordinates = sessionCoordinates(ctx, request)
  if (coordinates instanceof Response) return coordinates
  const query = new URL(request.url).searchParams
  const path = query.get('path') ?? ''
  if (!safeRelativePath(path)) return failure('invalid-path', 'Invalid workspace path.', 400)
  const rawRevision = query.get('rev')
  if (rawRevision !== null) {
    const rev = safeRevision(rawRevision)
    if (!rev) return failure('invalid-revision', 'Invalid git revision.', 400)
    const rawScope = query.get('scope')
    const scope = rawScope === null ? 'commit' : rawScope
    if (scope !== 'commit' && scope !== 'since') return failure('invalid-scope', 'Invalid diff scope.', 400)
    try {
      const comparison = await readGitFileAgainst(ctx, gitProvider, {
        sessionId: coordinates.sessionId,
        cwd: coordinates.cwd,
        path,
        rev,
        scope,
        signal: request.signal,
      })
      return jsonResponse(comparison)
    } catch (error) {
      if (request.signal?.aborted) return failure('aborted', 'Request aborted.', 499)
      return jsonResponse({ available: false, reason: 'git-failed', detail: String(error?.message || error).slice(0, 400) })
    }
  }
  try {
    const comparison = await readGitFile(ctx, gitProvider, {
      sessionId: coordinates.sessionId,
      cwd: coordinates.cwd,
      path,
      signal: request.signal,
    })
    return jsonResponse(comparison)
  } catch (error) {
    if (request.signal?.aborted) return failure('aborted', 'Request aborted.', 499)
    return jsonResponse({ available: false, reason: 'git-failed', detail: String(error?.message || error).slice(0, 400) })
  }
}

/**
 * Revision picker data: HEAD metadata plus recent commits (read-only git).
 * @param {object} ctx host context
 * @param {() => Promise<object | null>} gitProvider lazy git runner provider
 * @param {Request} request fetch request
 * @returns {Promise<Response>}
 */
async function handleGitRevisions(ctx, gitProvider, request) {
  const coordinates = sessionCoordinates(ctx, request)
  if (coordinates instanceof Response) return coordinates
  const query = new URL(request.url).searchParams
  const rawQuery = query.get('q')
  try {
    const git = await gitProvider()
    if (!git) return jsonResponse({ available: false, reason: 'no-git' })
    const payload = await listGitRevisions(git, coordinates.cwd, {
      limit: coordinate(query.get('limit')),
      query: rawQuery === null ? undefined : rawQuery,
      signal: request.signal,
    })
    return jsonResponse(payload)
  } catch (error) {
    if (request.signal?.aborted) return failure('aborted', 'Request aborted.', 499)
    return jsonResponse({ available: false, reason: 'git-failed', detail: String(error?.message || error).slice(0, 400) })
  }
}

/**
 * Diff a revision against its first parent or against the working tree.
 * @param {object} ctx host context
 * @param {() => Promise<object | null>} gitProvider lazy git runner provider
 * @param {Request} request fetch request
 * @returns {Promise<Response>}
 */
async function handleGitCompare(ctx, gitProvider, request) {
  const coordinates = sessionCoordinates(ctx, request)
  if (coordinates instanceof Response) return coordinates
  const query = new URL(request.url).searchParams
  const rev = safeRevision(query.get('rev') ?? '')
  if (!rev) return failure('invalid-revision', 'Invalid git revision.', 400)
  const rawScope = query.get('scope')
  const scope = rawScope === null ? 'commit' : rawScope
  if (scope !== 'commit' && scope !== 'since') return failure('invalid-scope', 'Invalid diff scope.', 400)
  try {
    const comparison = await readGitCompare(ctx, gitProvider, {
      cwd: coordinates.cwd,
      rev,
      scope,
      signal: request.signal,
    })
    return jsonResponse(comparison)
  } catch (error) {
    if (request.signal?.aborted) return failure('aborted', 'Request aborted.', 499)
    return jsonResponse({ available: false, reason: 'git-failed', detail: String(error?.message || error).slice(0, 400) })
  }
}

/**
 * The workspace file index for Quick Open.
 * @param {object} ctx host context
 * @param {WorkspaceIndex} index cached workspace index
 * @param {Request} request fetch request
 * @returns {Promise<Response>}
 */
async function handleFiles(ctx, index, request) {
  const coordinates = sessionCoordinates(ctx, request)
  if (coordinates instanceof Response) return coordinates
  const force = new URL(request.url).searchParams.get('refresh') === '1'
  try {
    const walked = await index.get({ sessionId: coordinates.sessionId, workspaceRoot: coordinates.cwd }, request.signal, force)
    return jsonResponse(walked)
  } catch (error) {
    if (request.signal?.aborted) return failure('aborted', 'Request aborted.', 499)
    return failure('index-failed', 'Workspace index unavailable.', 502)
  }
}

/**
 * Bounded case-insensitive text search across the workspace.
 * @param {object} ctx host context
 * @param {WorkspaceIndex} index cached workspace index
 * @param {Request} request fetch request
 * @returns {Promise<Response>}
 */
async function handleSearch(ctx, index, request) {
  const coordinates = sessionCoordinates(ctx, request)
  if (coordinates instanceof Response) return coordinates
  const query = new URL(request.url).searchParams
  const result = await searchWorkspace(ctx, index, { sessionId: coordinates.sessionId, workspaceRoot: coordinates.cwd }, {
    query: query.get('q') ?? '',
    limit: coordinate(query.get('limit')) ?? undefined,
    signal: request.signal,
  })
  return jsonResponse(result)
}

/**
 * Language-server operations for the active file (read-only LSP features).
 * @param {object} ctx host context
 * @param {LspBridge} bridge language-server bridge
 * @param {Request} request fetch request (JSON body)
 * @returns {Promise<Response>}
 */
async function handleLsp(ctx, bridge, request) {
  let body
  try {
    body = await request.json()
  } catch {
    return failure('invalid-body', 'Invalid JSON body.', 400)
  }
  const sessionId = identifier(body && body.sessionId) ?? identifier(new URL(request.url).searchParams.get('sessionId'))
  if (!sessionId) return failure('invalid-coordinates', 'Missing session id.', 400)
  const session = liveSession(ctx, sessionId)
  if (!session) return failure('session-not-live', 'Session is not live on this Host.', 404)
  const cwd = cwdOf(session)
  if (!cwd) return failure('no-cwd', 'Session has no working directory.', 404)
  const coordinates = { sessionId, cwd }
  const action = String((body && body.action) || '')
  if (!LSP_ACTIONS.has(action)) return failure('invalid-action', 'Unsupported LSP action.', 400)
  const languageId = String((body && body.languageId) || 'plaintext').slice(0, 64)
  if (action === 'status') {
    try {
      return jsonResponse(await bridge.status(languageId, body.refresh === true))
    } catch (error) {
      return jsonResponse({ available: false, reason: 'probe-failed', message: String(error && error.message ? error.message : error).slice(0, 400) })
    }
  }
  const path = body && body.path !== undefined ? String(body.path) : ''
  if (!path || !safeRelativePath(path)) return failure('invalid-path', 'Invalid workspace path.', 400)
  const text = typeof body.text === 'string' ? body.text : undefined
  if (text !== undefined && Buffer.byteLength(text, 'utf8') > LSP_MAX_TEXT_BYTES) {
    return jsonResponse({ available: false, reason: 'oversized' })
  }
  try {
    const requested = {
      sessionId: coordinates.sessionId,
      cwd: coordinates.cwd,
      languageId,
      action,
      path,
      text,
      line: coordinate(body.line),
      column: coordinate(body.column),
    }
    const result = await bridge.operate(requested)
    return jsonResponse(result)
  } catch (error) {
    if (request.signal?.aborted) return failure('aborted', 'Request aborted.', 499)
    return jsonResponse({ available: false, reason: 'lsp-failed', message: String(error && error.message ? error.message : error).slice(0, 400) })
  }
}

/**
 * Advertise the plugin phase and feature flags so the browser hides
 * unavailable affordances instead of failing at call time.
 * @returns {Response}
 */
function handleConfig() {
  return jsonResponse({
    phase: 3,
    features: { turn: true, git: true, gitRevisions: true, files: true, search: true, lsp: true, wordLevel: false },
    limits: { maxFileBytes: MAX_FILE_BYTES },
  })
}

/**
 * Register every review route inside the authenticated Fetch channel.
 * @param {object} ctx host plugin context
 */
export function registerApiRoutes(ctx) {
  const tracker = createChangesTracker(ctx)
  const gitProvider = createGitProvider(ctx)
  const index = new WorkspaceIndex(ctx)
  const lsp = new LspBridge(ctx, ctx.logger)
  ctx.effect(() => {
    const reaper = setInterval(() => {
      try { lsp.reap() } catch { /* reaping is best-effort */ }
    }, 60000)
    try { reaper.unref?.() } catch { /* optional */ }
    return () => {
      clearInterval(reaper)
      lsp.dispose()
    }
  }, 'dsh-review-panel: lsp lifecycle')
  const routes = [
    [ROUTES.latest, ['GET'], (request) => handleLatest(ctx, tracker, identifier(new URL(request.url).searchParams.get('sessionId')) ?? '')],
    [ROUTES.summary, ['GET'], (request) => handleSummary(ctx, request)],
    [ROUTES.diff, ['GET'], (request) => handleDiff(ctx, request)],
    [ROUTES.file, ['GET'], (request) => handleFile(ctx, gitProvider, request)],
    [ROUTES.tree, ['GET'], (request) => handleTree(ctx, request)],
    [ROUTES.config, ['GET'], () => handleConfig()],
    [ROUTES.gitStatus, ['GET'], (request) => handleGitStatus(ctx, gitProvider, request)],
    [ROUTES.gitFile, ['GET'], (request) => handleGitFile(ctx, gitProvider, request)],
    [ROUTES.gitRevisions, ['GET'], (request) => handleGitRevisions(ctx, gitProvider, request)],
    [ROUTES.gitCompare, ['GET'], (request) => handleGitCompare(ctx, gitProvider, request)],
    [ROUTES.files, ['GET'], (request) => handleFiles(ctx, index, request)],
    [ROUTES.search, ['GET'], (request) => handleSearch(ctx, index, request)],
    [ROUTES.lsp, ['POST'], (request) => handleLsp(ctx, lsp, request)],
  ]
  for (const [path, methods, fetch] of routes) {
    try {
      const dispose = ctx.connection.fetch.register({ path, methods, requestBody: 'buffered', fetch })
      ctx.effect(() => () => {
        try {
          const result = dispose()
          if (result && typeof result.then === 'function') result.catch(() => {})
        } catch {
          /* connection teardown may already own the route */
        }
      }, `dsh-review-panel: ${path}`)
    } catch (error) {
      ctx.logger?.warn?.(`dsh-review-panel: route ${path} unavailable (${String(error)})`)
    }
  }
}
