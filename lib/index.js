/**
 * dsh-review-panel — Host half.
 *
 * Read-only review data plane for the right-sidebar "代码审查" tab:
 *  - /api/review-panel.* authenticated JSON routes: turn snapshots from the
 *    builtin workspace-changes recorder, workspace file reads/directory
 *    listings from workspaceFiles, read-only git status/diff through the
 *    subprocess capability, and a bounded workspace index/search;
 *  - an authenticated prefix route serving the vendored Monaco AMD assets.
 *
 * No route writes files, mutates the repository, or runs arbitrary commands.
 *
 * Parts of the review-panel rendering approach are adapted from the MIT
 * licensed `dsh-vscode-mode` reference implementation
 * (https://github.com/Lenonss/DSH_VsCodeMode, © 2026 LiuZiLong / ddj).
 */
import { registerApiRoutes } from './host/routes.js'
import { registerVendorRoute } from './host/assets.js'

export const name = 'dsh-review-panel'

/** Hard dependencies: every one is a shipped Host service in DSH 0.2.x. */
export const inject = ['connection', 'webServer', 'workspaceFiles', 'workspaceChanges', 'sessions', 'subprocess']

/**
 * Register the review data plane and the static Monaco route.
 * @param {import('./host/context.d.ts').HostContext} ctx host plugin context
 */
export function apply(ctx) {
  registerApiRoutes(ctx)
  registerVendorRoute(ctx)
}
