/** Live-session lookups, working-directory access, and the latest turn announcement. */

/**
 * @typedef {object} LiveSession
 * @property {{ id: string, cwd?: string }} header
 * @property {number} seq
 * @property {() => readonly any[]} ownEvents
 */

/**
 * Look up a live Host session without throwing on unknown ids.
 * @param {{ sessions: { get(id: string): unknown } }} ctx host context
 * @param {string} sessionId session identity
 * @returns {LiveSession | undefined}
 */
export function liveSession(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 256) return undefined
  try {
    return /** @type {LiveSession | undefined} */ (ctx.sessions.get(sessionId))
  } catch {
    return undefined
  }
}

/**
 * The session's working directory, when it has one.
 * @param {LiveSession | undefined} session live session
 * @returns {string | undefined}
 */
export function cwdOf(session) {
  const cwd = session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
}

/**
 * Scan a live session's own events backwards for its latest `workspace/changes`
 * announcement. Used only as a fallback when the live tracker missed one.
 * @param {LiveSession} session live session
 * @returns {any | undefined} the event record
 */
export function lastChangesEvent(session) {
  let events
  try {
    events = session.ownEvents()
  } catch {
    return undefined
  }
  if (!Array.isArray(events)) return undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'workspace/changes') continue
    if (Number.isSafeInteger(event.data?.turn) && event.data.turn >= 1) return event
  }
  return undefined
}

/**
 * Track the latest `workspace/changes` event per live session, so the review
 * routes do not rescan long session logs on every request.
 * @param {object} ctx host context
 * @returns {WeakMap<object, any>} session → event record
 */
export function createChangesTracker(ctx) {
  const latest = new WeakMap()
  try {
    const dispose = ctx.on('session/event', (session, event) => {
      if (event?.type !== 'workspace/changes') return
      if (!Number.isSafeInteger(event.data?.turn) || event.data.turn < 1) return
      latest.set(session, event)
    })
    if (typeof dispose === 'function') {
      ctx.effect(() => () => {
        try {
          dispose()
        } catch {
          /* the connection may already be torn down */
        }
      }, 'dsh-review-panel: workspace/changes tracker')
    }
  } catch {
    /* A missing event bridge only costs a rescan. */
  }
  return latest
}
