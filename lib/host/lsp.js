/**
 * Minimal LSP bridge for the read-only review page.
 *
 * DSH 0.2.1 ships no language-server service, so this module speaks JSON-RPC
 * over a real child process started through `ctx.subprocess`:
 *   - one lazily-started server per (session, language family);
 *   - `initialize` → `initialized` → `textDocument/didOpen` (full sync);
 *   - request/response correlation with a per-request timeout;
 *   - `publishDiagnostics` notifications cached per file;
 *   - idle shutdown after `IDLE_MS` and full teardown on plugin dispose.
 *
 * Nothing here installs a language server: detection only probes the PATH for
 * known executables and reports install hints to the browser.
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, win32, posix } from 'node:path'

/** JSON-RPC/LSP framing: headers plus a JSON body. */
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024
/** How long one LSP request may take before the bridge answers a timeout. */
const REQUEST_TIMEOUT_MS = 15000
/** How long a session's server may stay idle before it is terminated. */
const IDLE_MS = 10 * 60 * 1000
/** Initialization handshake timeout. */
const INIT_TIMEOUT_MS = 20000

/**
 * Supported language families and the executables that can serve them.
 * `install` is shown verbatim to the user when nothing is found.
 */
const SERVER_REGISTRY = [
  {
    id: 'typescript',
    label: 'TypeScript / JavaScript',
    languages: ['typescript', 'javascript', 'typescriptreact', 'javascriptreact'],
    commands: [
      { command: 'typescript-language-server', args: ['--stdio'] },
    ],
    install: 'npm install -g typescript@5 typescript-language-server',
  },
  {
    id: 'pyright',
    label: 'Python (Pyright)',
    languages: ['python'],
    commands: [
      { command: 'pyright-langserver', args: ['--stdio'] },
    ],
    install: 'npm install -g pyright',
  },
  {
    id: 'pylsp',
    label: 'Python (python-lsp-server)',
    languages: ['python'],
    commands: [
      { command: 'pylsp', args: [] },
    ],
    install: 'pip install python-lsp-server',
  },
  {
    id: 'json',
    label: 'JSON',
    languages: ['json', 'jsonc'],
    commands: [
      { command: 'vscode-json-language-server', args: ['--stdio'] },
    ],
    install: 'npm install -g vscode-langservers-extracted',
  },
  {
    id: 'gopls',
    label: 'Go',
    languages: ['go'],
    commands: [
      { command: 'gopls', args: [] },
    ],
    install: 'go install golang.org/x/tools/gopls@latest',
  },
  {
    id: 'rust-analyzer',
    label: 'Rust',
    languages: ['rust'],
    commands: [
      { command: 'rust-analyzer', args: [] },
    ],
    install: 'rustup component add rust-analyzer',
  },
]

/**
 * npm global module roots that may hold a node-based language-server entry.
 * PATH remains authoritative on POSIX (including nvm/fnm/asdf installations).
 * Explicit prefixes and common system prefixes also allow direct Node launch
 * when Windows resolves the npm binary to a .cmd or .ps1 shim.
 * @param {{platform?:string, env?:object, home?:string}} [options] host facts
 * @returns {string[]} candidate roots
 */
export function npmGlobalRoots({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  const windows = platform === 'win32'
  const api = windows ? win32 : posix
  const roots = []
  for (const prefix of [env.npm_config_prefix, env.NPM_CONFIG_PREFIX]) {
    if (prefix) roots.push(api.join(prefix, ...(windows ? [] : ['lib']), 'node_modules'))
  }
  if (env.NODE_PATH) roots.push(...env.NODE_PATH.split(windows ? ';' : ':').filter(Boolean))
  if (windows) {
    if (env.APPDATA) roots.push(api.join(env.APPDATA, 'npm', 'node_modules'))
    roots.push(api.join(home, 'AppData', 'Roaming', 'npm', 'node_modules'))
    if (env.NVM_SYMLINK) roots.push(api.join(env.NVM_SYMLINK, 'node_modules'))
  } else {
    if (env.NVM_BIN) roots.push(api.join(api.dirname(env.NVM_BIN), 'lib', 'node_modules'))
    roots.push('/opt/homebrew/lib/node_modules', '/usr/local/lib/node_modules', '/usr/lib/node_modules')
    roots.push(api.join(home, '.npm-global', 'lib', 'node_modules'))
  }
  return [...new Map(roots.map((root) => [windows ? api.normalize(root).toLowerCase() : api.normalize(root), root])).values()]
}

/** Node entry points for servers whose npm bin is a .cmd/.ps1 shim on Windows. */
const NODE_ENTRIES = {
  typescript: { bin: join('typescript-language-server', 'lib', 'cli.mjs'), args: ['--stdio'] },
  pyright: { bin: join('pyright', 'langserver.index.js'), args: ['--stdio'] },
  json: { bin: join('vscode-langservers-extracted', 'bin', 'vscode-json-language-server'), args: ['--stdio'] },
}

/**
 * Candidate launch commands for one registry entry. Node + explicit CLI path
 * comes first on Windows because `ctx.subprocess.spawn` cannot execute a .cmd
 * shim directly. POSIX prefers the native PATH command and its shebang.
 * @param {object} entry registry entry
 * @returns {Array<{command:string, args:string[]}>}
 */
function candidatesFor(entry) {
  const commands = []
  const nodeEntry = NODE_ENTRIES[entry.id]
  if (nodeEntry) {
    for (const root of npmGlobalRoots()) {
      const cli = join(root, nodeEntry.bin)
      try {
        if (existsSync(cli)) commands.push({ command: 'node', args: [cli, ...nodeEntry.args] })
      } catch {
        /* ignore unreadable roots */
      }
    }
  }
  return process.platform === 'win32' ? [...commands, ...entry.commands] : [...entry.commands, ...commands]
}

/**
 * Registry entries that can serve one Monaco language id.
 * @param {string} languageId Monaco language id
 * @returns {Array<object>}
 */
export function serversFor(languageId) {
  const id = String(languageId || '').toLowerCase()
  return SERVER_REGISTRY.filter((entry) => entry.languages.includes(id))
}
/**
 * All registry entries (for the status payload).
 * @returns {Array<object>}
 */
export function listServerRegistry() {
  return SERVER_REGISTRY.map((entry) => ({
    id: entry.id,
    label: entry.label,
    languages: entry.languages.slice(),
    install: entry.install,
  }))
}

/**
 * Convert an absolute host path to a `file://` URI (Windows drive letters kept).
 * @param {string} absolutePath absolute path
 * @returns {string}
 */
export function fileUri(absolutePath) {
  const normalized = normalizeHostPath(absolutePath)
  const encoded = normalized.split('/').map((part, index) =>
    index === 0 && /^[a-zA-Z]:$/.test(part) ? part : encodeURIComponent(part)).join('/')
  if (normalized.startsWith('//')) return 'file:' + encoded
  return (/^[a-zA-Z]:\//.test(normalized) ? 'file:///' : 'file://') + encoded
}

function windowsPath(path) {
  return /^[a-zA-Z]:[\\/]|^[\\/]{2}/.test(String(path))
}

function normalizeHostPath(path) {
  const value = String(path || '')
  const normalized = (windowsPath(value) ? win32 : posix).normalize(value).replace(/\\/g, '/')
  return normalized.replace(/^[a-z]:/, (drive) => drive.toUpperCase())
}

function pathKey(path) {
  const normalized = normalizeHostPath(path)
  return windowsPath(normalized) ? normalized.toLowerCase() : normalized
}

/**
 * Convert a `file://` URI back to a host path.
 * @param {string} uri file URI or plain path
 * @returns {string}
 */
export function uriToPath(uri) {
  const text = String(uri || '')
  if (!/^file:\/\//i.test(text)) return normalizeHostPath(text)
  try {
    const url = new URL(text)
    let path = decodeURIComponent(url.pathname)
    if (url.hostname && url.hostname !== 'localhost') path = '//' + url.hostname + path
    else if (/^\/[a-zA-Z]:\//.test(path)) path = path.slice(1)
    return normalizeHostPath(path)
  } catch {
    return text
  }
}

/**
 * Detect one available server for a language family.
 * @param {object} subprocess Host subprocess service
 * @param {string} languageId Monaco language id
 * @returns {Promise<{entry:object, command:string, args:string[]} | null>}
 */
export async function detectServer(subprocess, languageId) {
  for (const entry of serversFor(languageId)) {
    for (const candidate of candidatesFor(entry)) {
      try {
        const resolved = await subprocess.resolveExecutable(candidate.command)
        if (!resolved) continue
        if (process.platform === 'win32' && /\.(?:cmd|bat|ps1)$/i.test(resolved)) {
          // A custom global npm prefix may only be discoverable through PATH.
          // Resolve its JS entry beside the shim instead of invoking a shell.
          const nodeEntry = NODE_ENTRIES[entry.id]
          const cli = nodeEntry && join(win32.dirname(resolved), 'node_modules', nodeEntry.bin)
          if (!cli || !existsSync(cli)) continue
          const node = await subprocess.resolveExecutable('node')
          if (node) return { entry, command: node, args: [cli, ...nodeEntry.args] }
          continue
        }
        return { entry, command: resolved, args: candidate.args.slice() }
      } catch {
        /* keep probing */
      }
    }
  }
  return null
}

/** One JSON-RPC connection over a child process. */
class LspConnection {
  /**
   * @param {object} handle SubprocessHandle
   * @param {(line:string) => void} log sink
   */
  constructor(handle, log) {
    this.handle = handle
    this.log = log
    this.buffer = Buffer.alloc(0)
    this.pending = new Map()
    this.nextId = 1
    this.closed = false
    this.diagnostics = new Map()
    this.stdout = handle.stdout
    this.stdin = handle.stdin
    this.stdin?.on?.('error', () => this.onClose())
    if (this.stdout) {
      this.stdout.on('data', (chunk) => this.onData(chunk))
      this.stdout.on('error', () => this.onClose())
      this.stdout.on('end', () => this.onClose())
    }
    this.handle.done.then(() => this.onClose()).catch(() => this.onClose())
  }

  /** Feed stdout bytes into the framing parser. */
  onData(chunk) {
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk])
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) {
        if (this.buffer.length > 8192) this.dispose()
        break
      }
      const header = this.buffer.subarray(0, headerEnd).toString('ascii')
      const lengthMatch = /content-length:\s*(\d+)/i.exec(header)
      if (!lengthMatch) {
        this.buffer = this.buffer.subarray(headerEnd + 4)
        continue
      }
      const length = Number(lengthMatch[1])
      if (!Number.isSafeInteger(length) || length > MAX_MESSAGE_BYTES) {
        this.buffer = Buffer.alloc(0)
        this.dispose()
        return
      }
      const start = headerEnd + 4
      if (this.buffer.length < start + length) break
      const body = this.buffer.subarray(start, start + length).toString('utf8')
      this.buffer = this.buffer.subarray(start + length)
      this.dispatch(body)
    }
  }

  /** Route one decoded message. */
  dispatch(body) {
    let message
    try {
      message = JSON.parse(body)
    } catch {
      return
    }
    if (message && typeof message.id === 'number' && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(String(message.error.message || 'lsp error')))
      else pending.resolve(message.result)
      return
    }
    if (message && typeof message.method === 'string') {
      // Server → client requests: answer the few that keep the server alive.
      if (typeof message.id === 'number' || typeof message.id === 'string') {
        let result = null
        if (message.method === 'workspace/configuration') result = (Array.isArray(message.params?.items) ? message.params.items : []).map(() => ({}))
        if (message.method === 'window/workDoneProgress/create' || message.method === 'client/registerCapability') result = null
        if (message.method === 'workspace/workspaceFolders') result = [{ uri: this.rootUri || fileUri(process.cwd()), name: 'workspace' }]
        this.send({ jsonrpc: '2.0', id: message.id, result })
        return
      }
      if (message.method === 'textDocument/publishDiagnostics') {
        const params = message.params
        if (params?.uri) this.diagnostics.set(pathKey(uriToPath(params.uri)), params)
      }
      return
    }
  }

  /** Write one message to the server. */
  send(message) {
    if (this.closed || !this.stdin) throw new Error('lsp connection is closed')
    const json = JSON.stringify(message)
    const payload = 'Content-Length: ' + Buffer.byteLength(json, 'utf8') + '\r\n\r\n' + json
    this.stdin.write(payload)
  }

  /**
   * One request with timeout.
   * @param {string} method LSP method
   * @param {object} params parameters
   * @returns {Promise<any>}
   */
  request(method, params) {
    if (this.closed) return Promise.reject(new Error('lsp connection is closed'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('lsp request timed out: ' + method))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.send({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  /** Send one notification. */
  notify(method, params) {
    try {
      this.send({ jsonrpc: '2.0', method, params })
    } catch {
      /* a dead server is reported by the next request */
    }
  }

  /** Mark closed and reject pending work. */
  onClose() {
    if (this.closed) return
    this.closed = true
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error('lsp server exited'))
    }
    this.pending.clear()
    this.buffer = Buffer.alloc(0)
  }

  /** Graceful shutdown, then terminate. */
  dispose() {
    try { this.notify('exit', null) } catch { /* ignore */ }
    try { this.handle.terminate() } catch { /* ignore */ }
    this.onClose()
  }
}

/** One language server bound to a session workspace. */
class LspSession {
  /**
   * @param {object} options session options
   */
  constructor(options) {
    this.sessionId = options.sessionId
    this.cwd = options.cwd
    this.languageId = options.languageId
    this.server = options.server
    this.subprocess = options.subprocess
    this.log = options.log
    this.connection = null
    this.ready = null
    this.opened = new Map()
    this.versions = new Map()
    this.operations = Promise.resolve()
    this.sync = { openClose: false, change: 0 }
    this.lastUsed = Date.now()
    this.disposed = false
  }

  /** Start the process and run the initialize handshake once. */
  ensureReady() {
    if (this.ready) return this.ready
    const spec = {
      argv: [this.server.command, ...this.server.args],
      cwd: this.cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 16 * 1024 } },
      graceMs: 2000,
      env: { ...process.env, NO_COLOR: '1' },
    }
    this.ready = new Promise((resolve, reject) => {
      let handle
      try {
        handle = this.subprocess.spawn(spec)
      } catch (error) {
        reject(error)
        return
      }
      const connection = new LspConnection(handle, this.log)
      connection.rootUri = fileUri(this.cwd)
      this.connection = connection
      const timer = setTimeout(() => reject(new Error('lsp initialize timed out')), INIT_TIMEOUT_MS)
      connection.request('initialize', {
        processId: null,
        rootUri: fileUri(this.cwd),
        workspaceFolders: [{ uri: fileUri(this.cwd), name: 'workspace' }],
        // Syntax-only fallback can return an import alias while the TS project
        // loads. A read-only navigator needs the semantic answer on the first F12.
        initializationOptions: this.server.entry.id === 'typescript'
          ? { tsserver: { useSyntaxServer: 'never' }, disableAutomaticTypingAcquisition: true }
          : undefined,
        capabilities: {
          textDocument: {
            synchronization: { dynamicRegistration: false },
            definition: { linkSupport: false },
            references: {},
            hover: { contentFormat: ['plaintext', 'markdown'] },
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            publishDiagnostics: { relatedInformation: false },
          },
          workspace: { configuration: true, workspaceFolders: true },
        },
        clientInfo: { name: 'dsh-review-panel' },
      }).then((result) => {
        clearTimeout(timer)
        const sync = result?.capabilities?.textDocumentSync
        this.sync = typeof sync === 'number'
          ? { openClose: sync !== 0, change: sync }
          : { openClose: sync?.openClose === true, change: sync?.change || 0 }
        connection.notify('initialized', {})
        resolve({ capabilities: (result && result.capabilities) || {} })
      }).catch((error) => {
        clearTimeout(timer)
        reject(error)
      })
    }).catch((error) => {
      this.dispose()
      throw error
    })
    return this.ready
  }

  /**
   * Keep only the requested document overlaid. Other files must be read from
   * disk so an Agent's edits cannot be hidden behind a formerly viewed model.
   * The whole operation is serialized: closing a document while its hover or
   * navigation request is in flight can change that request's meaning.
   */
  withDocument(request, operation) {
    const pending = this.operations.then(async () => {
      if (this.disposed) throw new Error('lsp session is disposed')
      const uri = await this.syncDocument(request.path, request.text || '', request.languageId)
      return operation(uri)
    })
    this.operations = pending.catch(() => {})
    return pending
  }

  /** Open or refresh the requested document using the negotiated sync mode. */
  async syncDocument(path, text, languageId) {
    await this.ensureReady()
    if (this.disposed) throw new Error('lsp session is disposed')
    this.lastUsed = Date.now()
    const uri = fileUri(resolveWorkspacePath(this.cwd, path))
    const key = pathKey(uriToPath(uri))
    for (const [other, document] of this.opened) {
      if (other === key) continue
      if (this.sync.openClose) this.connection.notify('textDocument/didClose', { textDocument: { uri: document.uri } })
      this.connection.diagnostics.delete(other)
      this.opened.delete(other)
    }
    const existing = this.opened.get(key)
    if (existing) {
      if (existing.text === text) return existing.uri
      this.connection.diagnostics.delete(key)
      const version = existing.version + 1
      if (this.sync.change === 1 || this.sync.change === 2) {
        const lines = existing.text.split(/\r\n|\r|\n/)
        const range = { start: { line: 0, character: 0 }, end: { line: lines.length - 1, character: lines.at(-1).length } }
        this.connection.notify('textDocument/didChange', {
          textDocument: { uri, version },
          contentChanges: [this.sync.change === 2 ? { range, text } : { text }],
        })
      } else if (this.sync.openClose) {
        // A server may accept open/close without incremental changes.
        this.connection.notify('textDocument/didClose', { textDocument: { uri } })
        this.connection.notify('textDocument/didOpen', {
          textDocument: { uri, languageId: languageId || 'plaintext', version, text },
        })
      }
      existing.version = version
      existing.text = text
      this.versions.set(key, version)
      return existing.uri
    }
    const version = (this.versions.get(key) || 0) + 1
    this.connection.diagnostics.delete(key)
    if (this.sync.openClose) this.connection.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: languageId || 'plaintext', version, text },
    })
    this.versions.set(key, version)
    this.opened.set(key, { uri, version, text })
    return uri
  }

  /** Position parameters for one 1-based line/column. */
  positionParams(path, line, column) {
    const opened = this.opened.get(pathKey(resolveWorkspacePath(this.cwd, path)))
    const uri = opened ? opened.uri : fileUri(resolveWorkspacePath(this.cwd, path))
    return {
      textDocument: { uri },
      position: { line: Math.max(0, (Number(line) || 1) - 1), character: Math.max(0, (Number(column) || 1) - 1) },
    }
  }

  /** Serialize a Location/LocationLink for the browser. */
  locationOf(value) {
    if (!value) return null
    const target = value.targetUri ? value.targetUri : value.uri
    const range = value.targetSelectionRange || value.targetRange || value.range
    if (!target || !range || !/^file:\/\//i.test(target)) return null
    return {
      path: relativeToCwd(this.cwd, uriToPath(target)),
      line: range.start.line + 1,
      column: range.start.character + 1,
      endLine: range.end.line + 1,
      endColumn: range.end.character + 1,
    }
  }

  /** Read the latest complete notification for a file (an empty list clears errors). */
  takeDiagnostics(path) {
    const out = []
    const opened = this.opened.get(pathKey(resolveWorkspacePath(this.cwd, path)))
    const params = this.connection?.diagnostics.get(pathKey(resolveWorkspacePath(this.cwd, path)))
    if (!params || (typeof params.version === 'number' && params.version < opened?.version)) return { diagnostics: out, pending: true }
    for (const diagnostic of Array.isArray(params.diagnostics) ? params.diagnostics : []) {
      out.push({
        path: relativeToCwd(this.cwd, uriToPath(params.uri)),
        line: diagnostic.range.start.line + 1,
        column: diagnostic.range.start.character + 1,
        endLine: diagnostic.range.end.line + 1,
        endColumn: diagnostic.range.end.character + 1,
        severity: diagnostic.severity || 1,
        message: String(diagnostic.message || ''),
        source: diagnostic.source ? String(diagnostic.source) : '',
      })
    }
    return { diagnostics: out, pending: false }
  }

  /** Terminate the server. */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    if (this.connection) this.connection.dispose()
    this.connection = null
  }
}

/**
 * Join a cwd-relative posix path to a host path.
 * @param {string} cwd workspace root
 * @param {string} rel relative path
 * @returns {string}
 */
function resolveWorkspacePath(cwd, rel) {
  const api = windowsPath(cwd) ? win32 : posix
  return api.resolve(String(cwd), String(rel))
}

/**
 * Host-path → cwd-relative posix path when inside the workspace, else the path.
 * @param {string} cwd workspace root
 * @param {string} absolute absolute path
 * @returns {string}
 */
export function relativeToCwd(cwd, absolute) {
  const root = normalizeHostPath(cwd)
  const target = normalizeHostPath(absolute)
  const api = windowsPath(root) ? win32 : posix
  if (windowsPath(root) !== windowsPath(target) || !api.isAbsolute(target)) return target
  const relative = api.relative(root, target).replace(/\\/g, '/')
  if (relative === '') return ''
  if (relative !== '..' && !relative.startsWith('../') && !api.isAbsolute(relative)) return relative
  return target
}

/** Bridge owner: registry detection cache plus per-session servers. */
export class LspBridge {
  /**
   * @param {object} ctx Host context
   * @param {object} logger logger
   */
  constructor(ctx, logger) {
    this.ctx = ctx
    this.logger = logger
    this.detection = new Map()
    this.sessions = new Map()
    this.closed = false
  }

  /**
   * Detect (and cache for the plugin lifetime) a server for a language.
   * @param {string} languageId Monaco language id
   * @returns {Promise<object | null>}
   */
  detect(languageId) {
    if (!this.detection.has(languageId)) {
      const probe = detectServer(this.ctx.subprocess, languageId).catch(() => null)
      this.detection.set(languageId, probe)
    }
    return this.detection.get(languageId)
  }

  /** Status payload for the browser (which languages can work right now). */
  async status(languageId, refresh = false) {
    const language = String(languageId || '')
    if (refresh) this.detection.delete(language)
    const registryEntries = serversFor(language)
    if (registryEntries.length === 0) {
      return { language, available: false, server: null, servers: [], reason: 'unsupported-language', install: null }
    }
    const entry = (await this.detect(language)) || null
    const servers = registryEntries.map((server) => server.id)
    return {
      language,
      available: entry !== null,
      server: entry ? entry.entry.id : null,
      servers,
      reason: entry ? null : 'missing-server',
      install: entry ? null : registryEntries[0].install || null,
    }
  }

  /**
   * Run one language-server operation (starting the server on demand).
   * @param {{sessionId:string, cwd:string, languageId:string, action:string, path:string, text?:string, line?:number, column?:number, query?:string}} request request
   * @returns {Promise<object>}
   */
  async operate(request) {
    if (this.closed) return { available: false, reason: 'disposed' }
    const registryEntries = serversFor(request.languageId)
    if (registryEntries.length === 0) {
      return { available: false, reason: 'unsupported-language', language: request.languageId, install: null }
    }
    const server = await this.detect(request.languageId)
    if (this.closed) return { available: false, reason: 'disposed' }
    if (!server) {
      return {
        available: false,
        reason: 'missing-server',
        language: request.languageId,
        install: registryEntries[0].install || null,
      }
    }
    const key = request.sessionId + '\n' + server.entry.id
    let session = this.sessions.get(key)
    if (session && (pathKey(session.cwd) !== pathKey(request.cwd) || session.connection?.closed)) session.dispose()
    if (!session || session.disposed) {
      session = new LspSession({
        sessionId: request.sessionId,
        cwd: request.cwd,
        languageId: request.languageId,
        server,
        subprocess: this.ctx.subprocess,
        log: (level, ...args) => {
          try { this.logger?.[level === 'warn' ? 'warn' : 'info']?.('[review-panel lsp]', ...args) } catch { /* ignore */ }
        },
      })
      this.sessions.set(key, session)
    }
    session.lastUsed = Date.now()
    try {
      return await session.withDocument(request, async (uri) => {
        const params = session.positionParams(request.path, request.line, request.column)
        if (request.action === 'definition') {
          const result = await session.connection.request('textDocument/definition', params)
          const values = Array.isArray(result) ? result : result ? [result] : []
          return { available: true, locations: values.map((value) => session.locationOf(value)).filter(Boolean) }
        }
        if (request.action === 'references') {
          const result = await session.connection.request('textDocument/references', { ...params, context: { includeDeclaration: true } })
          const values = Array.isArray(result) ? result : []
          return { available: true, locations: values.map((value) => session.locationOf(value)).filter(Boolean) }
        }
        if (request.action === 'hover') {
          const result = await session.connection.request('textDocument/hover', params)
          const contents = result && result.contents
          const text = Array.isArray(contents)
            ? contents.map((part) => (typeof part === 'string' ? part : part && part.value ? part.value : '')).join('\n')
            : typeof contents === 'string' ? contents : contents && contents.value ? contents.value : ''
          return { available: true, contents: String(text || '') }
        }
        if (request.action === 'symbols') {
          const result = await session.connection.request('textDocument/documentSymbol', { textDocument: { uri } })
          const flat = []
          const walk = (nodes, depth) => {
            for (const node of Array.isArray(nodes) ? nodes : []) {
              const range = node.selectionRange || node.range || node.location?.range
              flat.push({
                name: String(node.name || ''),
                detail: node.detail ? String(node.detail) : '',
                kind: typeof node.kind === 'number' ? node.kind : 0,
                depth,
                line: range ? range.start.line + 1 : 1,
                column: range ? range.start.character + 1 : 1,
              })
              if (Array.isArray(node.children)) walk(node.children, depth + 1)
            }
          }
          walk(result, 0)
          return { available: true, symbols: flat.slice(0, 500) }
        }
        if (request.action === 'diagnostics') {
          return { available: true, ...session.takeDiagnostics(request.path) }
        }
        return { available: true, unsupported: true }
      })
    } catch (error) {
      try { session.dispose() } catch { /* ignore */ }
      if (this.sessions.get(key) === session) this.sessions.delete(key)
      return { available: false, reason: 'server-error', message: String(error && error.message ? error.message : error) }
    }
  }

  /** Terminate idle servers and all servers. */
  reap() {
    const now = Date.now()
    for (const [key, session] of this.sessions) {
      if (!session.disposed && now - session.lastUsed > IDLE_MS) {
        session.dispose()
        this.sessions.delete(key)
      }
    }
  }

  /** Dispose everything. */
  dispose() {
    this.closed = true
    for (const [, session] of this.sessions) {
      try { session.dispose() } catch { /* ignore */ }
    }
    this.sessions.clear()
  }
}
