#!/usr/bin/env node
/** Cross-platform workspace paths and the production shortcut profile/help code. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = (await Promise.all(['00-const.js', '05-utils.js', '30-page.js', '40-commands.js']
  .map((name) => readFile(new URL('../src/client/' + name, import.meta.url), 'utf8')))).join('\n')

function client(service, navigator = { platform: 'Win32' }) {
  const suffix = `
    globalCtxRef.current = {get: name => name === 'shortcuts' ? service : undefined};
    return {toWorkspaceRel, shortcutEnvironment, shortcutModifierLabel, formatBinding, buildKeyHelp, COMMAND_SPECS, installOfficialShortcuts};
  `
  return new Function('service', 'navigator', 'document', 'console', source + suffix)(
    service, navigator, { baseURI: 'https://dsh.example/' }, { log() {}, warn() {}, error() {} })
}
const t = (key) => key

test('POSIX workspace paths keep case and segment boundaries, including filesystem root', () => {
  const { toWorkspaceRel } = client()
  assert.equal(toWorkspaceRel('/repo/src/A.ts', '/repo'), 'src/A.ts')
  assert.equal(toWorkspaceRel('/Repo/src/A.ts', '/repo'), 'Repo/src/A.ts', 'a different-cased POSIX root is not stripped')
  assert.equal(toWorkspaceRel('/repo-other/a.ts', '/repo'), 'repo-other/a.ts', 'matching a path prefix does not cross a directory boundary')
  assert.equal(toWorkspaceRel('/repo', '/repo'), '')
  assert.equal(toWorkspaceRel('/repo/a.ts', '/'), 'repo/a.ts')
  assert.equal(toWorkspaceRel('/a.ts', '/'), 'a.ts')
  assert.equal(toWorkspaceRel('/', '/'), '')
  assert.equal(toWorkspaceRel('repo/a.ts', '/repo'), 'repo/a.ts', 'an already-relative path retains its leading directory')
  assert.equal(toWorkspaceRel('./src/A.ts', '/repo'), 'src/A.ts')
})

test('Windows drive and UNC workspace roots still compare without case sensitivity', () => {
  const { toWorkspaceRel } = client()
  assert.equal(toWorkspaceRel('c:\\REPO\\src\\A.ts', 'C:\\repo'), 'src/A.ts')
  assert.equal(toWorkspaceRel('C:/Repo/src/A.ts', 'c:/repo/'), 'src/A.ts')
  assert.equal(toWorkspaceRel('c:/src/A.ts', 'C:/'), 'src/A.ts')
  assert.equal(toWorkspaceRel('\\\\SERVER\\Share\\Repo\\src\\A.ts', '\\\\server\\share\\repo'), 'src/A.ts')
  assert.equal(toWorkspaceRel('//SERVER/Share/Repo/src/A.ts', '//server/share/repo/'), 'src/A.ts')
  assert.equal(toWorkspaceRel('C:/other/A.ts', 'C:/repo'), 'C:/other/A.ts')
})

test('macOS help follows the connected client platform and names Command and Option', () => {
  // Deliberately keep the simulated host/browser platform Windows: the service
  // describes the client that actually owns the bindings and must take priority.
  const api = client({ runtime: 'desktop', platform: 'macos' })
  assert.deepEqual(api.shortcutEnvironment(), { runtime: 'desktop', platform: 'macos' })
  assert.equal(api.formatBinding({ code: 'KeyP', modifiers: ['primary', 'alt'] }), 'Cmd+Option+P')
  assert.equal(api.formatBinding({ code: 'KeyK', secondCode: 'KeyD', modifiers: ['control'] }), 'Ctrl+K+D')
  const rows = new Map(api.buildKeyHelp(t).map((row) => [row.id, row.hint]))
  assert.equal(rows.get('k:quickOpen'), 'Cmd+P')
  assert.equal(rows.get('k:quickOpenAlt'), 'Cmd+Option+P')
  assert.equal(rows.get('k:toggleTree'), 'Cmd+Shift+E')
  assert.equal(rows.get('k:find'), 'Cmd+F')
  assert.equal(rows.get('k:fold'), 'Cmd+Option+[ / ]')
  assert.equal(rows.get('k:foldAll'), 'Cmd+K Cmd+0 / Cmd+K Cmd+J')
  assert.match(rows.get('k:fontZoom'), /Cmd\+=/)
  assert.match(rows.get('k:quickOpenCommands'), /^Cmd\+P /)
})

test('Windows and Linux help use their actual runtime profile without desktop leakage into Web', () => {
  const windows = client({ runtime: 'desktop', platform: 'windows' })
  const windowsRows = new Map(windows.buildKeyHelp(t).map((row) => [row.id, row.hint]))
  assert.equal(windowsRows.get('k:quickOpenAlt'), 'Ctrl+Alt+P')
  assert.equal(windowsRows.get('k:toggleTree'), 'Ctrl+Shift+E')
  assert.equal(windowsRows.get('k:fold'), 'Ctrl+Shift+[ / ]')
  const linux = client({ runtime: 'desktop', platform: 'linux' })
  const linuxRows = new Map(linux.buildKeyHelp(t).map((row) => [row.id, row.hint]))
  assert.equal(linuxRows.get('k:quickOpenAlt'), 'Ctrl+Alt+P')
  assert.equal(linuxRows.get('k:gotoLine'), 'Ctrl+G')
  assert.equal(linuxRows.has('k:nextChange'), false, 'Linux does not claim the Desktop F7 default')
  assert.match(linuxRows.get('k:quickOpenCommands'), /^Ctrl\+Alt\+P /)
  const web = client({ runtime: 'web', platform: 'macos' })
  const webRows = new Map(web.buildKeyHelp(t).map((row) => [row.id, row.hint]))
  assert.equal(webRows.has('k:openReview'), false)
  assert.equal(webRows.has('k:quickOpenAlt'), false)
  assert.equal(webRows.has('k:nextChange'), false)
  assert.equal(webRows.get('k:find'), 'Cmd+F', 'editor-native help still follows the Web client platform')
})

test('Linux registers supported letter defaults and keeps reserved function/arrow combinations unbound', () => {
  const registered = []
  const service = {
    runtime: 'desktop', platform: 'linux',
    catalog: { getSnapshot: () => [] }, config: {},
    register(command) {
      const binding = command.defaults['desktop:linux']
      if (binding) {
        assert.match(binding.code, /^Key[A-Z]$/)
        assert.ok(binding.modifiers.includes('primary'))
        assert.ok(!binding.modifiers.includes('meta'))
        assert.ok(!['KeyV', 'KeyC', 'KeyX', 'KeyZ', 'KeyY', 'KeyQ', 'KeyH', 'KeyA'].includes(binding.code))
      }
      registered.push(command)
      return () => {}
    },
  }
  const api = client(service)
  const dispose = api.installOfficialShortcuts({ get: () => service }, t)
  assert.equal(registered.length, api.COMMAND_SPECS.length)
  const byId = new Map(registered.map((command) => [command.id.split('.').at(-1), command]))
  for (const id of ['openReview', 'quickOpenAlt', 'searchWorkspace', 'commandPalette', 'toggleTree', 'outline', 'gotoLine']) {
    assert.ok(byId.get(id).defaults['desktop:linux'], id + ' has an allowed Linux default')
  }
  for (const id of ['nextChange', 'prevChange', 'nextTab', 'prevTab', 'closeTab', 'navBack', 'navForward']) {
    assert.equal(byId.get(id).defaults['desktop:linux'], undefined)
  }
  for (const command of registered) {
    assert.equal(command.defaults['web:linux'], undefined)
    assert.equal(command.defaults['web:macos'], undefined)
    assert.equal(command.defaults['web:windows'], undefined)
  }
  dispose()
})

test('without a shortcuts service, platform labels can fall back to the browser', () => {
  const api = client(undefined, { platform: 'MacIntel' })
  assert.equal(api.shortcutEnvironment().platform, 'macos')
  assert.equal(api.shortcutModifierLabel('primary'), 'Cmd')
  assert.equal(api.shortcutModifierLabel('alt'), 'Option')
})
