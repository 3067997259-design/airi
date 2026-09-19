/**
 * Live coarse corridor port (B0/LR-0 item 2, elytra-navigation design §4).
 *
 * The offline corridor (`corridor.ts`) needed a caller that owns two things the
 * pure planner must not own: one bounded region read on a slow cadence, and the
 * route's next aim point for the current position. This module is that caller,
 * so the air-follow and elytra drivers only ask "where should this poll aim".
 *
 * Two honesty rules decide the failures:
 *
 * - A cell the read did not cover is unknown, never air. The read window is
 *   therefore aligned to the coarse lattice: a window that is not a multiple of
 *   the cell size would leave the planner's edge cells unscanned while looking
 *   perfectly covered from the outside.
 * - A refusal (`read_failed`, `no_route`) keeps the driver's existing goal
 *   instead of inventing a route through unverified space.
 */
import type { MovementControlPort } from '../movement/port'
import type { SnapshotEntry } from '../movement/snapshot'
import type { Vec3 } from '../movement/types'
import type { FlightCorridor, FlightCorridorRegion } from './contracts'
import type { FlightPlannerSwitch } from './profile'

import { buildFreeSpace, DEFAULT_COARSE_RESOLUTION, DEFAULT_MIN_CLEARANCE, planCorridor } from './corridor'

/**
 * Horizontal half-extent of the corridor read, in blocks.
 *
 * The A* runs over the cells of this window, so the window is the planning
 * horizon: a goal farther away is reached by re-planning while flying, not by
 * reading farther. A 32-block half-extent at the 4-block cell size gives a
 * 65 × 9 × 65 cell read (≈ 25 k cells), inside the ~30 k region-read budget the
 * vehicle router already pays (checklist §3.1).
 */
export const LIVE_CORRIDOR_RADIUS = 32

/**
 * Vertical half-extent of the corridor read, in blocks.
 *
 * NOTICE:
 * Why 3 and not 16: the bridge returns at most 32768 cells per region read and
 * silently *truncates* the rest (measured live 2026-09-18: a 75809-cell request
 * came back with `truncated: true` and 32768 entries). A 65 x 33 x 65 request is
 * 139425 cells, so about three quarters of the window arrived as "missing", every
 * unread coarse cell counted as unknown rather than free, and the A* refused with
 * `start_unknown` on every poll of a 380-block fixture flight — the corridor
 * layer was dead and the mover silently flew the pre-B0 heuristics into a canyon
 * wall. 65 x 7 x 65 = 29575 cells stays under the cap, and the cheap axis to give
 * up is height: a route hint through a canyon needs width far more than it needs
 * 32 blocks of sky.
 * Source: live read-budget probe (D:/mcpfabric/mcp-server/read-budget.mjs).
 * Removal condition: when the bridge reports a queryable per-call limit or chunks
 * the read, so the window can grow again.
 */
export const LIVE_CORRIDOR_UP = 3
export const LIVE_CORRIDOR_DOWN = 3

/** Wall-clock ms between two route re-plans (design §8 suggests 1–2 Hz). */
export const LIVE_CORRIDOR_REPLAN_MS = 1500
/** A goal that moved this far invalidates the cached route before the interval. */
export const LIVE_CORRIDOR_REPLAN_MOVE = 8

/** What the last route attempt proved. `planned` is the only usable state. */
export type LiveCorridorStatus
  = | 'planned'
    | 'read_failed'
    | 'no_route'
    | 'not_started'

/** Typed refusal of the pure planner, kept for the receipt. */
export type LiveCorridorRefusal = 'start_unknown' | 'goal_unknown' | 'no_corridor' | 'budget'

export interface LiveCorridorPlan {
  status: LiveCorridorStatus
  /** Next point of the route to aim at; absent when nothing may be aimed at. */
  aim?: Vec3
  /** Route the aim belongs to; absent on a refusal. */
  corridor?: FlightCorridor
  /** Why the last attempt refused, absent when it planned. */
  refusal?: LiveCorridorRefusal
}

export interface LiveCorridorOptions {
  port: MovementControlPort
  planner: FlightPlannerSwitch
  dimension: string
  worldId: string
  /** Map identity carried by the corridor; a changed value re-plans. */
  mapVersion: string
  now?: () => number
  radius?: number
  up?: number
  down?: number
  resolution?: number
  minClearance?: number
  replanMs?: number
}

/**
 * Reads one bounded window and plans the coarse route to the goal.
 *
 * @example
 * const plan = await planLiveCorridor(options, self, goal)
 * plan.status
 * // => 'planned' when the window covers a free route, otherwise a typed refusal
 */
export async function planLiveCorridor(
  options: Omit<LiveCorridorOptions, 'now' | 'replanMs'>,
  self: Vec3,
  goal: Vec3,
): Promise<LiveCorridorPlan> {
  const resolution = options.resolution ?? DEFAULT_COARSE_RESOLUTION
  const radius = options.radius ?? LIVE_CORRIDOR_RADIUS
  const snap = (value: number): number => Math.floor(value / resolution) * resolution
  const bounds = {
    min: { x: snap(self.x - radius), y: snap(self.y - (options.down ?? LIVE_CORRIDOR_DOWN)), z: snap(self.z - radius) },
    max: { x: snap(self.x + radius), y: snap(self.y + (options.up ?? LIVE_CORRIDOR_UP)), z: snap(self.z + radius) },
  }
  let entries: SnapshotEntry[]
  try {
    entries = await options.port.getBlocksRegion(bounds.min, bounds.max)
  }
  catch {
    // A failed read is a missing fact for this interval, never a free window.
    return { status: 'read_failed' }
  }

  const space = buildFreeSpace({
    bounds,
    resolution,
    minClearance: options.minClearance ?? DEFAULT_MIN_CLEARANCE,
    dimension: options.dimension,
    worldId: options.worldId,
    mapVersion: options.mapVersion,
  }, entries)

  /**
   * The goal the window can actually route to.
   *
   * ROOT CAUSE (live, 2026-09-18): the plan was checked against the caller's real
   * goal, and a goal farther away than the read radius can never be reached
   * inside the window, so `corridorReachesGoal` refused every long trip and the
   * whole corridor layer degraded to the direct goal (a 380-block fixture run
   * reported `corridor no_route` on every poll, then flew the pre-B0 heuristics
   * into a canyon wall). The corridor is a *coarse near-field* hint: it has to
   * plan to the window edge on the way to the goal, and the caller re-plans as it
   * flies. The rule "a route that does not reach its target is not a route" stays,
   * applied to the clamped target.
   */
  const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max)
  // One whole cell inside the read: a point on the boundary belongs to a cell
  // whose far half was never read, and the free-space builder correctly refuses
  // to call that cell known (`goal_unknown`, measured live on the same run).
  const margin = resolution
  const windowGoal = {
    x: clamp(goal.x, bounds.min.x + margin, bounds.max.x - margin),
    y: clamp(goal.y, bounds.min.y + margin, bounds.max.y - margin),
    z: clamp(goal.z, bounds.min.z + margin, bounds.max.z - margin),
  }

  /**
   * Targets to try, in order: the direction of the real goal, then placements
   * beside and above it.
   *
   * ROOT CAUSE (live, 2026-09-18): with only the clamped point tried, a fixture
   * flight through a canyon refused with `no_corridor` / `goal_unknown` — the
   * single point on the window edge kept landing inside a bank (a route that
   * cannot enter its own target is not a route). The window's boundary is a whole
   * plane, so the near-field hint has to look along it for a cell it can actually
   * route into instead of giving up on the first placement, and then the caller
   * re-plans as it flies.
   */
  const candidates: Vec3[] = [windowGoal]
  if (windowGoal.x !== goal.x || windowGoal.y !== goal.y || windowGoal.z !== goal.z) {
    const alongZ = Math.abs(goal.z - self.z) >= Math.abs(goal.x - self.x)
    const shifts = [12, -12, 24, -24]
    for (const shift of shifts) {
      for (const lift of [0, 6, -6]) {
        candidates.push({
          x: clamp(alongZ ? windowGoal.x + shift : windowGoal.x, bounds.min.x + margin, bounds.max.x - margin),
          y: clamp(windowGoal.y + lift, bounds.min.y + margin, bounds.max.y - margin),
          z: clamp(alongZ ? windowGoal.z : windowGoal.z + shift, bounds.min.z + margin, bounds.max.z - margin),
        })
      }
    }
  }

  let lastRefusal: LiveCorridorRefusal = 'no_corridor'
  let lastCorridor: FlightCorridor | undefined
  for (const candidate of candidates) {
    const plan = planCorridor(space, { start: self, goal: candidate })
    if (!plan.ok) {
      lastRefusal = plan.reason
      continue
    }
    lastCorridor = plan.corridor
    // A route that does not reach the goal cell is not a route to the goal.
    if (!corridorReachesGoal(plan.corridor, candidate))
      continue
    return { status: 'planned', aim: aimInCorridor(plan.corridor, resolution, self), corridor: plan.corridor }
  }

  return { status: 'no_route', refusal: lastRefusal, ...(lastCorridor ? { corridor: lastCorridor } : {}) }
}

/**
 * Whether a route ends at the goal.
 *
 * The corridor merges contiguous cells into axis-aligned regions, so a straight
 * flight is one long region; counting regions would call that route useful when
 * it carries no avoidance information. The honest test is containment: a route
 * that never reaches the goal's cell is a partial route, not a route to it.
 */
export function corridorReachesGoal(corridor: FlightCorridor, goal: Vec3): boolean {
  return regionContaining(corridor.regions, goal) !== undefined
}

/**
 * Picks the route point the next poll should fly at.
 *
 * A position inside the route aims at the centre of its next region, so the aim
 * leaves the player's own cell. A position outside the route aims at the
 * nearest region centre, which is the coarse form of "rejoin the planned
 * route". The vertical component is the centre of the coarse cell: a 4-block
 * cell cannot say more than ±2 blocks about the altitude, and the rollout's own
 * sweep owns the exact path.
 */
function aimInCorridor(corridor: FlightCorridor, resolution: number, self: Vec3): Vec3 {
  const current = regionContaining(corridor.regions, self)
  const index = current ? corridor.regions.indexOf(current) : nearestRegionIndex(corridor.regions, self)
  const next = current && index < corridor.regions.length - 1 ? corridor.regions[index + 1]! : corridor.regions[index]!
  return centreOf(next, resolution)
}

/**
 * The region holding the position, if any.
 *
 * The cell size is the tolerance on every axis: a position between two cells
 * belongs to neither, and the nearest-region fallback handles it.
 */
function regionContaining(regions: FlightCorridorRegion[], point: Vec3): FlightCorridorRegion | undefined {
  return regions.find((region) => {
    const min = region.bounds.min
    const max = region.bounds.max
    return point.x >= min.x && point.x <= max.x + 1
      && point.y >= min.y && point.y <= max.y + 1
      && point.z >= min.z && point.z <= max.z + 1
  })
}

function nearestRegionIndex(regions: FlightCorridorRegion[], point: Vec3): number {
  let best = 0
  let bestDistance = Number.POSITIVE_INFINITY
  for (let index = 0; index < regions.length; index++) {
    const center = centreOf(regions[index]!, 1)
    const distance = Math.hypot(center.x - point.x, center.y - point.y, center.z - point.z)
    if (distance < bestDistance) {
      bestDistance = distance
      best = index
    }
  }
  return best
}

function centreOf(region: FlightCorridorRegion, resolution: number): Vec3 {
  return {
    x: (region.bounds.min.x + region.bounds.max.x) / 2,
    y: (region.bounds.min.y + region.bounds.max.y) / 2 + resolution / 2,
    z: (region.bounds.min.z + region.bounds.max.z) / 2,
  }
}

export interface LiveCorridorPort {
  /**
   * Runs one cadence step and returns the route aim, or `undefined` when the
   * caller must keep its own goal.
   */
  step: (self: Vec3, goal: Vec3) => Promise<Vec3 | undefined>
  status: () => LiveCorridorStatus
  /**
   * Why the last attempt refused, when it did.
   *
   * `status()` alone cannot tell a caller whether the window was unreadable, the
   * space unrouteable, or the route too short to count; without that, a live
   * diagnosis has to guess (the first fixture run only knew `no_route`).
   */
  refusal: () => LiveCorridorRefusal | undefined
}

/**
 * Wraps {@link planLiveCorridor} in the slow re-plan cadence.
 *
 * The route is rebuilt when the interval elapsed, when the goal moved past
 * {@link LIVE_CORRIDOR_REPLAN_MOVE}, or when the previous attempt failed: a
 * failed read is a missing fact for this interval, not a permanent verdict. A
 * step during an in-flight attempt reuses that attempt instead of queueing a
 * second region read.
 *
 * @example
 * const corridor = createLiveCorridorPort(options)
 * const aim = await corridor.step(self, target)
 */
export function createLiveCorridorPort(options: LiveCorridorOptions): LiveCorridorPort {
  const now = options.now ?? (() => Date.now())
  const replanMs = options.replanMs ?? LIVE_CORRIDOR_REPLAN_MS
  let status: LiveCorridorStatus = 'not_started'
  let refusal: LiveCorridorRefusal | undefined
  let aim: Vec3 | undefined
  let plannedAt = Number.NEGATIVE_INFINITY
  let plannedGoal: Vec3 | undefined
  let inFlight: Promise<Vec3 | undefined> | undefined

  async function replan(self: Vec3, goal: Vec3): Promise<Vec3 | undefined> {
    const plan = await planLiveCorridor(options, self, goal)
    status = plan.status
    refusal = plan.status === 'no_route' ? plan.refusal : undefined
    aim = plan.aim
    plannedAt = now()
    plannedGoal = { ...goal }
    return aim
  }

  return {
    async step(self, goal) {
      const due = now() - plannedAt >= replanMs || status !== 'planned'
      const moved = plannedGoal === undefined
        || Math.hypot(goal.x - plannedGoal.x, goal.y - plannedGoal.y, goal.z - plannedGoal.z) > LIVE_CORRIDOR_REPLAN_MOVE
      if (!due && !moved)
        return aim
      if (inFlight)
        return inFlight
      inFlight = replan(self, goal).finally(() => {
        inFlight = undefined
      })
      return inFlight
    },
    status: () => status,
    refusal: () => refusal,
  }
}
