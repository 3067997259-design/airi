/**
 * Geometric jump planning for one-block ascents (Step 2).
 *
 * A jump-up edge is not just "one cell up": whether the hop is possible, where
 * it must start and where it lands depend on the jump clearance, the headroom
 * above both stands, and the walls beside the flight. This module answers that
 * from the exact collision shapes the region read sends, so the executor can
 * reject an impossible edge before hopping (instead of spending the stuck
 * window and a retry timeout) and hand the mod's per-tick jump task a concrete
 * takeoff line and landing target.
 *
 * The model is vanilla's: jump impulse 0.42 blocks/tick, gravity 0.08 with a
 * 0.98 drag, walk speed 0.216 and sprint speed 0.281 blocks/tick. It is used
 * for feasibility and geometry only; the mod confirms the real landing.
 */
import type { BlockSource, MovementConfig, Vec3 } from './types'

import { collisionBoxesOf, overlaps3, playerBox } from './boxes'

/** Vanilla jump impulse, gravity and per-tick drag, in blocks and ticks. */
const JUMP_VELOCITY = 0.42
const GRAVITY = 0.08
const DRAG = 0.98
/** Vanilla horizontal speeds per tick. */
export const WALK_SPEED = 0.216
export const SPRINT_SPEED = 0.281
/** Highest rise a jump can clear; above it the edge is impossible. */
export const MAX_JUMP_RISE = 1.26
/** Below this the follower walks up instead of latching a jump. */
const MIN_JUMP_RISE = 0.35
/** Flight samples along the trajectory. */
const TRAJECTORY_SAMPLES = 12
/** Landing must be within this distance of the destination stand point. */
export const LANDING_TOLERANCE = 0.55
/** Extra reach granted before a sprint is required (measurement noise). */
const SPRINT_MARGIN = 0.25

export type JumpRejectionReason = 'too-high' | 'too-far' | 'no-landing' | 'no-headroom' | 'blocked' | 'not-a-jump'

export interface JumpPlan {
  ok: true
  rise: number
  gap: number
  /** Ground line: the jump fires when the bot's position passes it moving to the destination. */
  takeoff: Vec3
  /** Unit horizontal direction of the flight. */
  direction: { x: number, z: number }
  /** Simulated horizontal distance covered between takeoff and landing. */
  flight: number
  sprint: boolean
  /**
   * The flight overshoots the gap and nothing beyond the landing blocks it.
   *
   * A staircase's next step face absorbs the extra travel; a lone pad has no
   * face, so the flight carries the bot past it (live lone-step run: the hop
   * landed 0.9 past the block). The per-tick task brakes in the air for these.
   */
  brake: boolean
}

export interface JumpRejection {
  ok: false
  reason: JumpRejectionReason
  /** Detail for the ledger and the debug trace. */
  detail?: string
}

/**
 * Simulates the vanilla jump arc for a rise and a horizontal speed.
 *
 * @example
 * simulateFlight(1, WALK_SPEED)
 * // => { ticks: 9, distance: 1.944 }
 */
export function simulateFlight(rise: number, speed: number): { ticks: number, distance: number } {
  let velocity = JUMP_VELOCITY
  let height = 0
  for (let tick = 1; tick <= 24; tick++) {
    height += velocity
    const descending = velocity < 0
    velocity = (velocity - GRAVITY) * DRAG
    if (descending && height <= rise)
      return { ticks: tick, distance: speed * tick }
  }
  return { ticks: 24, distance: speed * 24 }
}

/** True when the player box at `foot` touches a block taller than `clearTop`. */
function headroomBlocked(foot: Vec3, world: BlockSource, clearTop: number): boolean {
  const box = playerBox(foot)
  const minX = Math.floor(box.min.x)
  const maxX = Math.floor(box.max.x - 1e-9)
  const minZ = Math.floor(box.min.z)
  const maxZ = Math.floor(box.max.z - 1e-9)
  const minY = Math.floor(box.min.y) - 1
  const maxY = Math.floor(box.max.y - 1e-9)
  for (let x = minX; x <= maxX; x++) {
    for (let z = minZ; z <= maxZ; z++) {
      for (let y = minY; y <= maxY; y++) {
        const block = world.getBlock(x, y, z)
        if (!block)
          continue
        for (const collision of collisionBoxesOf(block)) {
          if (!overlaps3(box, collision))
            continue
          if (collision.max.y > clearTop + 1e-6)
            return true
        }
      }
    }
  }
  return false
}

/** True when the destination stand has a support whose top is its foot level. */
function landingSupported(to: Vec3, world: BlockSource): boolean {
  const below = world.getBlock(Math.floor(to.x), Math.floor(to.y) - 1, Math.floor(to.z))
  if (!below)
    return true
  if (below.physical)
    return Math.abs(below.y + 1 - to.y) <= 0.6
  return below.safe && Math.abs(below.height - to.y) <= 0.6
}

/**
 * Blocks the flight may pass through: everything except the destination's own
 * support and anything at or below the landing level. A block that rises above
 * both the current feet and the destination top is a wall in the way.
 */
function flightBlocked(from: Vec3, to: Vec3, world: BlockSource): boolean {
  const samples = Math.max(2, TRAJECTORY_SAMPLES)
  for (let index = 1; index <= samples; index++) {
    const t = index / samples
    const foot: Vec3 = {
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * Math.min(1, t * 1.15),
      z: from.z + (to.z - from.z) * t,
    }
    const box = playerBox(foot)
    const minX = Math.floor(box.min.x)
    const maxX = Math.floor(box.max.x - 1e-9)
    const minZ = Math.floor(box.min.z)
    const maxZ = Math.floor(box.max.z - 1e-9)
    const minY = Math.floor(box.min.y)
    const maxY = Math.floor(box.max.y - 1e-9)
    for (let x = minX; x <= maxX; x++) {
      for (let z = minZ; z <= maxZ; z++) {
        for (let y = minY; y <= maxY; y++) {
          const block = world.getBlock(x, y, z)
          if (!block)
            continue
          // The destination's own column is where the bot lands, not a wall.
          if (x === Math.floor(to.x) && z === Math.floor(to.z))
            continue
          for (const collision of collisionBoxesOf(block)) {
            if (!overlaps3(box, collision))
              continue
            if (collision.max.y > Math.max(foot.y, to.y) + 1e-6)
              return true
          }
        }
      }
    }
  }
  return false
}

/**
 * Plans one jump-up edge.
 *
 * `from` and `to` are standing points (block center X/Z, foot level Y). The
 * takeoff is the line the bot must cross while grounded before the jump fires:
 * when the simulated flight would carry it past the destination (a walk-speed
 * hop covers about 1.9 blocks), the line sits before the source stand and the
 * bot jumps as soon as it can; when the flight is shorter than the gap, the
 * line sits inside the gap and the bot walks up to it first.
 *
 * @example
 * planStepUp({ from: { x: 0.5, y: 64, z: 0.5 }, to: { x: 1.5, y: 65, z: 0.5 }, world, config })
 * // => { ok: true, rise: 1, gap: 1, ... }
 */
export function planStepUp(options: {
  from: Vec3
  to: Vec3
  world: BlockSource
  config: MovementConfig
}): JumpPlan | JumpRejection {
  const { from, to, world, config } = options
  const rise = to.y - from.y
  if (rise > MAX_JUMP_RISE)
    return { ok: false, reason: 'too-high', detail: `rise ${rise.toFixed(2)}` }
  if (rise < MIN_JUMP_RISE)
    return { ok: false, reason: 'not-a-jump', detail: `rise ${rise.toFixed(2)}` }

  const gap = Math.hypot(to.x - from.x, to.z - from.z)
  const walk = simulateFlight(rise, WALK_SPEED)
  const sprint = simulateFlight(rise, SPRINT_SPEED)
  if (gap > sprint.distance + SPRINT_MARGIN)
    return { ok: false, reason: 'too-far', detail: `gap ${gap.toFixed(2)} > sprint reach ${sprint.distance.toFixed(2)}` }
  const needsSprint = gap > walk.distance + SPRINT_MARGIN
  if (needsSprint && !config.allowSprinting)
    return { ok: false, reason: 'too-far', detail: `gap ${gap.toFixed(2)} needs a sprint, sprinting is disabled` }

  if (!landingSupported(to, world))
    return { ok: false, reason: 'no-landing', detail: `${to.x.toFixed(2)},${to.y.toFixed(2)},${to.z.toFixed(2)} has no support at the foot level` }

  // A wall beside the destination, a ceiling above it, or a wall inside the
  // flight all make the hop impossible or a snag. The destination's own
  // column is the landing, so it is exempt in the flight sweep.
  if (headroomBlocked(to, world, to.y))
    return { ok: false, reason: 'no-headroom', detail: `above ${to.x.toFixed(2)},${to.y.toFixed(2)},${to.z.toFixed(2)}` }
  if (headroomBlocked(from, world, from.y))
    return { ok: false, reason: 'no-headroom', detail: `above ${from.x.toFixed(2)},${from.y.toFixed(2)},${from.z.toFixed(2)}` }
  if (flightBlocked(from, to, world))
    return { ok: false, reason: 'blocked', detail: `flight ${from.x.toFixed(2)},${from.z.toFixed(2)} -> ${to.x.toFixed(2)},${to.z.toFixed(2)}` }

  const length = gap < 1e-9 ? { x: 0, z: 0 } : { x: (to.x - from.x) / gap, z: (to.z - from.z) / gap }
  const speed = needsSprint ? SPRINT_SPEED : WALK_SPEED
  const flight = simulateFlight(rise, speed).distance
  // Takeoff line: the ideal is `to - direction * flight`; when that sits far
  // behind the source stand there is no room for the run-up, so the line is the
  // source stand itself and the hop starts as early as possible.
  const idealDistance = gap - flight
  const backoff = Math.max(-1.2, Math.min(0.6, idealDistance))
  const takeoff: Vec3 = {
    x: from.x + length.x * backoff,
    y: from.y,
    z: from.z + length.z * backoff,
  }
  // A face past the landing absorbs the overshoot; without one the task must
  // brake in the air (the host cannot time that from a 150 ms poll).
  const beyondX = Math.floor(to.x + length.x)
  const beyondZ = Math.floor(to.z + length.z)
  const beyond = world.getBlock(beyondX, Math.floor(to.y) - 1, beyondZ)
  const faceAtLandingLevel = beyond !== undefined
    && (beyond.physical
      ? Math.abs(beyond.y + 1 - to.y) <= 0.6
      : beyond.safe && Math.abs(beyond.height - to.y) <= 0.6)
  return { ok: true, rise, gap, takeoff, direction: length, flight, sprint: needsSprint, brake: !faceAtLandingLevel }
}
