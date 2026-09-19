import type { MovementControlPort, MovementState } from '../movement/port'
import type { SnapshotEntry } from '../movement/snapshot'
import type { CollisionBox, Vec3 } from '../movement/types'
/**
 * Bridge from the live movement port onto the flight planner inputs
 * (B0/LR-0, acceptance checklist §3.1 item 1).
 *
 * Hides the two adaptations the elytra and air-follow drivers would otherwise
 * each reinvent: assembling a {@link FlightObservation} from one
 * {@link MovementState} read plus the rocket bookkeeping the driver already
 * owns, and serving a rollout {@link ShapeSource} from one bounded region
 * read. Cells the read did not cover stay `undefined` (unknown, never air), so
 * a candidate sweeping an unread cell fails its safety check instead of
 * flying through it.
 */
import type { FlightObservation } from './contracts'
import type { FlightPlannerSwitch } from './profile'

import { classifyBlock } from '../movement/block-view'
import { collisionBoxesOf } from '../movement/boxes'
import { planRollout } from './rollout'
// One owner for the boost lifetime: a local copy is how the read drifted from
// the model before the E-01 boost measurement (evidence §6.2).
import { ROCKET_BOOST_TICKS } from './simulation'

export { ROCKET_BOOST_TICKS }
const MS_PER_TICK = 50

/**
 * Half-extents of the per-poll shape read around the player, in blocks.
 *
 * Invariant: the horizontal half-extent must cover the rollout horizon at the
 * top boosted speed (12 ticks × ~1.5 blocks/tick ≈ 18 < 20), or every fast
 * candidate sweeps past the read into unknown cells and the planner falls
 * back on every poll. Cell count stays under the ~30k region-read budget the
 * vehicle router already uses (41 × 17 × 41 ≈ 28.6k).
 */
export const LIVE_SHAPE_HALF_XZ = 20
export const LIVE_SHAPE_UP = 12
export const LIVE_SHAPE_DOWN = 4

/**
 * First-guess rollout limits for live cruise driving. The horizon trades
 * against the shape-read half-extent (see above) rather than reaching for the
 * design's 20–40 tick window; E-01 residuals are the tuning input, not these
 * values.
 */
export const LIVE_ROLLOUT_LIMITS = {
  horizonTicks: 12,
  yawStepDeg: 15,
  pitchStepDeg: 10,
  maxYawRateDeg: 30,
  maxPitchRateDeg: 25,
  inflate: 0.25,
  reserveTicks: 30,
  maxCandidates: 24,
  budgetMs: 60,
} as const

/** Firework boost state implied by the last spent rocket, in wall-clock ms. */
export function fireworkStateSince(lastSpentAt: number | undefined, now: number): { active: boolean, ticksRemaining: number } {
  if (lastSpentAt === undefined)
    return { active: false, ticksRemaining: 0 }
  const elapsedTicks = Math.floor((now - lastSpentAt) / MS_PER_TICK)
  if (elapsedTicks >= ROCKET_BOOST_TICKS)
    return { active: false, ticksRemaining: 0 }
  return { active: true, ticksRemaining: ROCKET_BOOST_TICKS - elapsedTicks }
}

/** The control one live planner update produced. */
export interface LiveFlightControl {
  yaw: number
  pitch: number
  useRocket: boolean
  /** The rollout had to shorten its executed prefix (design §8). */
  slowDown: boolean
}

/**
 * Plans one cruise control step with the rollout planner.
 *
 * Returns `undefined` when the region read fails or no candidate is safe; the
 * caller keeps its heuristic branch for that poll. A read failure is a
 * missing fact, never a reason to fly blind through unknown cells.
 */
export async function planLiveFlightControl(options: {
  planner: FlightPlannerSwitch
  port: MovementControlPort
  state: MovementState
  /** Monotonic poll counter; the read's source tick is preferred when present. */
  poll: number
  fireworks: number
  health: number
  goal: Vec3
  lastRocketAt: number | undefined
  now: () => number
}): Promise<LiveFlightControl | undefined> {
  const position = options.state.position
  let entries: SnapshotEntry[]
  try {
    entries = await options.port.getBlocksRegion(
      { x: Math.floor(position.x) - LIVE_SHAPE_HALF_XZ, y: Math.floor(position.y) - LIVE_SHAPE_DOWN, z: Math.floor(position.z) - LIVE_SHAPE_HALF_XZ },
      { x: Math.floor(position.x) + LIVE_SHAPE_HALF_XZ, y: Math.floor(position.y) + LIVE_SHAPE_UP, z: Math.floor(position.z) + LIVE_SHAPE_HALF_XZ },
    )
  }
  catch {
    return undefined
  }
  // Every read cell is stored, air included, so an empty box list means
  // "known passable" while an absent key means the read never covered the cell.
  const shapes = new Map<string, CollisionBox[]>()
  for (const entry of entries) {
    const block = { ...classifyBlock(entry), ...(entry.collision ? { collision: entry.collision } : {}) }
    const boxes = collisionBoxesOf(block)
    shapes.set(`${entry.x},${entry.y},${entry.z}`, boxes.map(box => ({
      minX: box.min.x,
      minY: box.min.y,
      minZ: box.min.z,
      maxX: box.max.x,
      maxY: box.max.y,
      maxZ: box.max.z,
    })))
  }
  const observation: FlightObservation = {
    tick: options.state.observation?.sourceTick ?? options.poll,
    position: { ...position },
    velocity: options.state.motion ? { ...options.state.motion } : { x: 0, y: 0, z: 0 },
    yaw: options.state.yaw,
    pitch: options.state.pitch ?? 0,
    poseBox: options.planner.profile.poseBox,
    health: options.health,
    firework: fireworkStateSince(options.lastRocketAt, options.now()),
    onGround: options.state.onGround,
    inWater: options.state.inWater,
  }
  const outcome = planRollout({
    profile: options.planner.profile,
    observation,
    source: { shapeAt: (x, y, z) => shapes.get(`${x},${y},${z}`) },
    limits: {
      ...LIVE_ROLLOUT_LIMITS,
      minY: position.y - LIVE_SHAPE_DOWN,
      maxY: position.y + LIVE_SHAPE_UP,
      // NOTICE:
      // `RolloutLimits.fireworks` is compared against `reserveTicks` inside
      // `evaluateCandidate` (rollout.ts "fireworks - rocketUses < reserveTicks"),
      // so the planner reads it as remaining boost TICKS, not a rocket count
      // despite the field doc. Convert here until the rollout contract names
      // its units; removal condition: rollout.ts documents fireworks in ticks
      // or switches both sides to rocket counts.
      fireworks: options.fireworks * ROCKET_BOOST_TICKS,
    },
    goal: options.goal,
    now: options.now,
  })
  if (!outcome.ok)
    return undefined
  return {
    yaw: outcome.chosen.input.yaw,
    pitch: outcome.chosen.input.pitch,
    useRocket: outcome.chosen.input.useRocket,
    slowDown: outcome.slowDown,
  }
}
