/* dsh-review-panel client half — shared constants (no imports/exports). */

/** Locale namespace owned by this plugin. */
const NS = 'dsh-review-panel'
/** Tab type identity; also the keyed body-slot key (must equal the definition id). */
const TAB_ID = 'dsh-review-panel'
/** Tab kind discriminator. */
const TAB_KIND = 'review-panel'
/** Resource-address prefix of this plugin's review pages. */
const ADDRESS_PREFIX = 'dsh-resource://review-panel/session/'
/** Builtin file-preview resource prefix (used for non-code handoff). */
const FILE_ADDRESS_PREFIX = 'dsh-resource://file/session/'
/** Builtin hunk-review resource prefix (reused, never re-registered). */
const CHANGES_REVIEW_PREFIX = 'dsh-resource://changes-review/session/'
/** Vendor AMD root (absolute application path; served by the Host plugin). */
const VENDOR_BASE = '/dsh-review-panel/monaco/vs'
/** Document-relative authenticated JSON routes (Host registers them under /api/). */
const ROUTES = {
  latest: 'api/review-panel.latest',
  summary: 'api/review-panel.summary',
  diff: 'api/review-panel.diff',
  file: 'api/review-panel.file',
  tree: 'api/review-panel.tree',
  config: 'api/review-panel.config',
  gitStatus: 'api/review-panel.git-status',
  gitFile: 'api/review-panel.git-file',
  files: 'api/review-panel.files',
  search: 'api/review-panel.search',
  lsp: 'api/review-panel.lsp',
}
/** Maximum diff lines drawn by the code area (matches the builtin review policy). */
const MAX_RENDER_LINES = 5000
/** Default widths (CSS px) of the in-page workspace tree. */
const TREE_WIDTH_DEFAULT = 230
const TREE_WIDTH_MIN = 160
const TREE_WIDTH_MAX = 300
/** Below this page width the tree becomes an overlay drawer. */
const NARROW_WIDTH = 560

/** Extension → Monaco language id. */
const LANG_BY_EXT = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  json: 'json', jsonc: 'jsonc', json5: 'json', md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  css: 'css', scss: 'scss', less: 'less', html: 'html', htm: 'html', vue: 'html', svelte: 'html', xml: 'xml',
  svg: 'xml', yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini', env: 'ini',
  py: 'python', pyi: 'python', sh: 'shell', bash: 'shell', zsh: 'shell', ps1: 'powershell', psm1: 'powershell',
  bat: 'bat', cmd: 'bat', lua: 'lua', java: 'java', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp',
  hpp: 'cpp', hh: 'cpp', cs: 'csharp', go: 'go', rs: 'rust', rb: 'ruby', php: 'php', sql: 'sql',
  swift: 'swift', kt: 'kotlin', kts: 'kotlin', dart: 'dart', ex: 'plaintext', exs: 'plaintext',
  dockerfile: 'dockerfile', graphql: 'graphql', gql: 'graphql', proto: 'proto', r: 'r', jl: 'julia',
  pl: 'perl', pm: 'perl', scala: 'scala', groovy: 'java', gradle: 'java', vim: 'plaintext',
}

/** Extensions rendered by the code viewer; everything else is handed to DSH preview. */
const CODE_EXT = new Set(Object.keys(LANG_BY_EXT))

/** Files without an extension that are still code. */
const CODE_BASENAMES = new Set([
  'dockerfile', 'makefile', 'cmakelists.txt', 'jenkinsfile', 'procfile', 'gemfile', 'rakefile',
  'cargo.lock', 'go.sum', 'justfile', 'vagrantfile', '.gitignore', '.gitattributes', '.editorconfig',
  '.npmrc', '.nvmrc', '.prettierrc', '.eslintrc', '.babelrc', '.dockerignore',
])

/** A short label per diff mode. */
const MODES = ['turn', 'git', 'code']
