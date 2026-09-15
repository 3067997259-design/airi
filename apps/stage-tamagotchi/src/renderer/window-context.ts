import type { LeadershipMode } from '@proj-airi/stage-ui/libs/pinia'

/** Describes the synchronization and Stage runtime policy for one renderer. */
export interface RendererWindowContext {
  /** Determines whether this renderer can own synchronized actions. */
  leadership: LeadershipMode
  /** Determines whether this renderer initializes Stage integrations. */
  stageRuntime: 'full' | 'minimal'
  /** What surfaces this renderer owns, derived from the launch query. */
  capabilities: RendererWindowCapabilities
}

/**
 * Declares the surfaces one renderer owns.
 *
 * The role is fixed by the launch query, so this is read-only derived state,
 * not a second synchronized store. `stage` marks the renderer that displays
 * and drives an avatar model: the main window (leader, full runtime). The
 * dedicated chat window runs the minimal runtime, so stage-bound tools can
 * name the missing capability instead of failing with a raw "no model" error
 * (UI-SURFACE UI-H/UI-3).
 */
export interface RendererWindowCapabilities {
  stage: boolean
}

function normalizeRoutePath(routePath: string) {
  const [path = ''] = routePath.split(/[?#]/)
  return path || '/'
}

/**
 * Resolves the initial renderer route before Vue Router hydrates the hash.
 *
 * @example
 * resolveInitialRendererRoutePath('/', '#/widgets?source=tray')
 * // => '/widgets'
 */
export function resolveInitialRendererRoutePath(routePath: string, hash = globalThis.location?.hash ?? ''): string {
  const hashPath = hash.startsWith('#') ? hash.slice(1) : ''
  return normalizeRoutePath(hashPath || routePath)
}

/**
 * Reports whether the launch query marks this renderer as the synchronized
 * leader.
 *
 * Runtime discovery (built-in, MCP, plugin, game tools) must run in the leader
 * window only: a follower registers locally through closure calls that bypass
 * synchronized action routing, publishes its incomplete tool set as a
 * full-state proposal, and replaces the leader's discovered face.
 *
 * @example
 * isSyncedLeaderWindow('?synced-leader=true')  // => true
 * isSyncedLeaderWindow('?synced-leader=false') // => false
 */
export function isSyncedLeaderWindow(search = globalThis.location?.search ?? ''): boolean {
  return new URLSearchParams(search).get('synced-leader') === 'true'
}

/**
 * Resolves renderer ownership from the query that the main process supplies.
 *
 * @example
 * resolveRendererWindowContext('?synced-leader=false&stage-runtime=minimal')
 * // => { leadership: 'follower-only', stageRuntime: 'minimal', capabilities: { stage: false } }
 */
export function resolveRendererWindowContext(search = globalThis.location?.search ?? ''): RendererWindowContext {
  const query = new URLSearchParams(search)
  const syncedLeader = query.get('synced-leader')
  if (syncedLeader === null)
    throw new TypeError('Missing synced-leader query')
  if (syncedLeader !== 'true' && syncedLeader !== 'false')
    throw new TypeError(`Invalid synced-leader query: ${syncedLeader}`)

  const stageRuntime = query.get('stage-runtime')
  if (stageRuntime !== null && stageRuntime !== 'minimal')
    throw new TypeError(`Invalid stage-runtime query: ${stageRuntime}`)

  const leadership: LeadershipMode = isSyncedLeaderWindow(search) ? 'leader-only' : 'follower-only'
  const runtime: RendererWindowContext['stageRuntime'] = stageRuntime === 'minimal' ? 'minimal' : 'full'
  // Only the main window is leader and full-runtime, so it is the one window
  // that mounts the avatar surface and the model tools bind to.
  const capabilities: RendererWindowCapabilities = {
    stage: leadership === 'leader-only' && runtime === 'full',
  }

  return { leadership, stageRuntime: runtime, capabilities }
}
