/**
 * Per-type driving primitives (CD-V2).
 *
 * These are pure policies the travel session applies while mounted. They are
 * deliberately separate from the routing graphs: a route decides *where*, a
 * drive primitive decides *how*. The vanilla client exposes no real physics
 * here, so the primitives express verifiable rules (turn rate, jump clearance,
 * launch speed) and return typed "unverified" answers when an input cannot be
 * proven to act on the vehicle.
 */
import type { TriState } from './target-observation'
import type { Vec3 } from './types'

import { angleDelta, clamp } from './geometry'

// --- Boat ---------------------------------------------------------------------------------

/** Turning rate below which a held forward input proved no yaw change, deg/s. */
export const BOAT_TURN_DEADBAND_DEG_PER_S = 2

/**
 * Measured angular velocity from two boat yaw readings.
 *
 * The value comes from the vehicle's own yaw, never the player camera: turning
 * the view does not prove the hull turned (design §4).
 *
 * @example
 * boatAngularVelocity(0, 90, 1000)
 * // => 90
 */
export function boatAngularVelocity(previousYaw: number, currentYaw: number, elapsedMs: number): number {
  if (elapsedMs <= 0)
    return 0
  return angleDelta(previousYaw, currentYaw) / (elapsedMs / 1000)
}

/**
 * Whether a paddle input actually turned the boat in this version.
 *
 * `false` is reported when forward was held but the hull did not rotate beyond
 * the deadband, so a caller can stop assuming camera yaw steers the boat and
 * instead pulse the opposing paddle.
 */
export function paddleTurnVerified(input: {
  previousYaw?: number
  currentYaw?: number
  elapsedMs: number
  forwardHeld: boolean
}): TriState {
  if (!input.forwardHeld)
    return 'unobserved'
  if (input.previousYaw === undefined || input.currentYaw === undefined || input.elapsedMs <= 0)
    return 'unobserved'
  return Math.abs(boatAngularVelocity(input.previousYaw, input.currentYaw, input.elapsedMs)) > BOAT_TURN_DEADBAND_DEG_PER_S
}

export interface BoatApproachPlan {
  /** Yaw the boat should hold for this tick; the hull heading, not the camera. */
  yawCommand: number
  forward: boolean
  back: boolean
  /** True when the boat is inside the slow-down radius of a bend or the goal. */
  slow: boolean
}

/**
 * Plans one boat approach tick.
 *
 * A boat cannot strafe, so the plan only points the hull at the next waypoint
 * and holds forward. A bend or the final approach releases forward early and
 * brakes with reverse instead of charging the same bank again and again
 * (design §4).
 *
 * @example
 * planBoatApproach({ position: { x: 0, y: 64, z: 0 }, yaw: 0, waypoint: { x: 0, y: 64, z: 10 } }).forward
 * // => true
 */
export function planBoatApproach(input: {
  position: Vec3
  yaw: number
  waypoint: Vec3
  goal: Vec3
  speed: number
  /** Distance at which the boat starts braking, in blocks. */
  brakeDistance?: number
}): BoatApproachPlan {
  const brakeDistance = input.brakeDistance ?? 2.5
  const yawCommand = Math.atan2(-(input.waypoint.x - input.position.x), input.waypoint.z - input.position.z) * 180 / Math.PI
  const bend = Math.abs(angleDelta(input.yaw, yawCommand)) > 35
  const distanceToWaypoint = Math.hypot(input.waypoint.x - input.position.x, input.waypoint.z - input.position.z)
  // Stop distance from the current speed: v^2 / (2a), with a = 0.1 blocks/tick^2.
  const stopDistance = (input.speed * input.speed) / 0.2
  const slow = bend || distanceToWaypoint <= brakeDistance || stopDistance >= distanceToWaypoint
  const turnaround = Math.abs(angleDelta(input.yaw, yawCommand)) > 120
  return {
    yawCommand,
    forward: !slow,
    // Reverse paddling is the only brake; a sharp turnaround also backs out
    // rather than grinding the same hull edge against the bank.
    back: slow && (turnaround || distanceToWaypoint <= brakeDistance),
    slow,
  }
}

/**
 * Steering for a boat that follows a planned water route.
 *
 * The open-water approach ({@link planBoatApproach}) brakes by the waypoint
 * distance and at any bend; used for route cells that stalls the boat at every
 * corner and, with a short look-ahead, never lets it move at all (live V-02:
 * the route follower sat still and reported route_unavailable). A route
 * follower keeps paddling through bends and brakes only at the goal.
 */
export function planRouteFollow(input: {
  position: Vec3
  yaw: number
  waypoint: Vec3
  goal: Vec3
  speed: number
  /** Distance at which the boat starts braking for the goal, in blocks. */
  brakeDistance?: number
}): BoatApproachPlan {
  const brakeDistance = input.brakeDistance ?? 2.5
  const yawCommand = Math.atan2(-(input.waypoint.x - input.position.x), input.waypoint.z - input.position.z) * 180 / Math.PI
  const distanceToGoal = Math.hypot(input.goal.x - input.position.x, input.goal.z - input.position.z)
  const slow = distanceToGoal <= brakeDistance
  const turnaround = Math.abs(angleDelta(input.yaw, yawCommand)) > 120
  return {
    yawCommand,
    forward: !slow,
    back: slow && (turnaround || distanceToGoal <= brakeDistance),
    slow,
  }
}

/**
 * Chooses a bank dismount point near the goal.
 *
 * Returns the best cell on land adjacent to water, or `undefined` when the
 * goal offers no bank. A missing bank is reported as `arrived_mounted`, not as
 * a forced dismount into water (design §4).
 */
export function chooseDockPoint(input: {
  goal: Vec3
  /** Known water surface cells around the goal. */
  waterCells: Vec3[]
  /** True when the cell is solid land the player can stand on. */
  isLand: (cell: Vec3) => boolean
}): Vec3 | undefined {
  let best: Vec3 | undefined
  let bestDistance = Number.POSITIVE_INFINITY
  for (const water of input.waterCells) {
    for (const neighbor of [
      { x: water.x + 1, y: water.y, z: water.z },
      { x: water.x - 1, y: water.y, z: water.z },
      { x: water.x, y: water.y, z: water.z + 1 },
      { x: water.x, y: water.y, z: water.z - 1 },
    ]) {
      if (!input.isLand(neighbor))
        continue
      const distance = Math.hypot(neighbor.x - input.goal.x, neighbor.z - input.goal.z)
      if (distance < bestDistance) {
        bestDistance = distance
        best = neighbor
      }
    }
  }
  return best
}

// --- Horse / donkey / mule ----------------------------------------------------------------

/** Minimum health fraction before a jump is refused as risky. */
export const HORSE_MIN_JUMP_HEALTH_FRACTION = 0.35
/** Maximum obstacle the default horse jump can clear, in blocks. */
export const HORSE_MAX_JUMP_HEIGHT = 1.25
/** Maximum horizontal gap one horse jump covers, in blocks. */
export const HORSE_MAX_JUMP_GAP = 4

export interface HorseJumpEstimate {
  feasible: boolean
  /** Vertical clearance the jump provides above the obstacle top. */
  clearance: number
  /** Predicted landing cell. */
  landing: Vec3
  /** Blocks of run-up the takeoff needs before the obstacle. */
  runUpNeeded: number
  reason?: 'too_high' | 'too_far' | 'no_run_up' | 'low_health' | 'blocked_landing'
}

/**
 * Estimates one horse jump from takeoff to landing.
 *
 * The estimate uses the horse's real jump strength (when reported) and its
 * height, plus the run-up space and health. A jump is only feasible when the
 * obstacle clears, the gap fits, the takeoff has room and the landing is free
 * (design §5).
 *
 * @example
 * estimateHorseJump({ takeoff: { x: 0, y: 64, z: 0 }, obstacleTop: 65, landing: { x: 0, y: 64, z: 3 } }).feasible
 * // => true
 */
export function estimateHorseJump(input: {
  takeoff: Vec3
  /** Top surface height of the obstacle, in blocks (block y plus shape). */
  obstacleTop: number
  landing: Vec3
  /** Horizontal gap between the takeoff edge and the landing, in blocks. */
  gap?: number
  jumpStrength?: number
  health?: number
  maxHealth?: number
  /** Blocks of clear ground before the obstacle; 1 is the takeoff cell only. */
  runUp?: number
  /** True when the landing cell is occupied by another entity or block. */
  landingBlocked?: boolean
}): HorseJumpEstimate {
  const strength = clamp(input.jumpStrength ?? 0.7, 0.2, 1)
  const maxHeight = HORSE_MAX_JUMP_HEIGHT * (0.6 + 0.4 * strength)
  const clearance = input.takeoff.y + maxHeight - input.obstacleTop
  const gap = input.gap ?? Math.hypot(input.landing.x - input.takeoff.x, input.landing.z - input.takeoff.z)
  const runUpNeeded = gap > 1.5 ? 2 : 1
  if (input.landingBlocked)
    return { feasible: false, clearance, landing: input.landing, runUpNeeded, reason: 'blocked_landing' }
  if (input.health !== undefined && input.maxHealth !== undefined && input.maxHealth > 0
    && input.health < input.maxHealth * HORSE_MIN_JUMP_HEALTH_FRACTION) {
    return { feasible: false, clearance, landing: input.landing, runUpNeeded, reason: 'low_health' }
  }
  if (clearance < 0.1)
    return { feasible: false, clearance, landing: input.landing, runUpNeeded, reason: 'too_high' }
  if (gap > HORSE_MAX_JUMP_GAP)
    return { feasible: false, clearance, landing: input.landing, runUpNeeded, reason: 'too_far' }
  if (input.runUp !== undefined && input.runUp < runUpNeeded)
    return { feasible: false, clearance, landing: input.landing, runUpNeeded, reason: 'no_run_up' }
  return { feasible: true, clearance, landing: input.landing, runUpNeeded }
}

/**
 * Picks the cheaper of a gentle detour and a jump.
 *
 * A detour whose extra ground cost stays under the jump cost (including the
 * run-up and the risk of a failed jump) wins, because a failed jump costs the
 * whole attempt and can injure the horse (design §5).
 *
 * @example
 * chooseHorseMotion({ jumpDistance: 3, detourDistance: 4, jumpFeasible: true })
 * // => 'detour'
 */
export function chooseHorseMotion(input: {
  jumpDistance: number
  detourDistance: number
  jumpFeasible: boolean
  /** Cost multiplier applied to a jump for its failure risk. */
  jumpRiskFactor?: number
}): 'jump' | 'detour' {
  if (!input.jumpFeasible)
    return 'detour'
  const risk = input.jumpRiskFactor ?? 1.35
  return input.jumpDistance * risk <= input.detourDistance ? 'jump' : 'detour'
}

// --- Minecart -----------------------------------------------------------------------------

/** Speed, in blocks/tick, above which a cart is treated as still moving. */
export const MINECART_MOVING_SPEED = 0.02
/** Speed below which a dismount is considered low-speed. */
export const MINECART_SAFE_DISMOUNT_SPEED = 0.08

export interface MinecartLaunchObservation {
  launched: boolean
  reason?: 'rail_not_powered' | 'launch_unavailable'
  speed: number
}

/**
 * Classifies a minecart launch from real speed observations.
 *
 * A cart that never gains speed with no verified propulsion reports
 * `rail_not_powered` immediately instead of waiting out a fixed 30 s timeout
 * (design §6). A powered rail that still produced no speed is a distinct
 * `launch_unavailable`.
 *
 * @example
 * observeMinecartLaunch({ speedBefore: 0, speedAfter: 0.2, powered: true }).launched
 * // => true
 */
export function observeMinecartLaunch(input: {
  speedBefore: number
  speedAfter: number
  powered: TriState
}): MinecartLaunchObservation {
  const speed = Math.max(0, input.speedAfter)
  if (speed > MINECART_MOVING_SPEED)
    return { launched: true, speed }
  if (input.powered === false)
    return { launched: false, reason: 'rail_not_powered', speed }
  return { launched: false, reason: 'launch_unavailable', speed }
}

/**
 * Whether a minecart may dismount at its current state.
 *
 * A moving cart on a high-speed rail is not a safe footing; the caller must
 * either wait for a known safe station or report that it stayed mounted
 * (design §6).
 */
export function minecartDismountSafe(input: {
  speed: number
  onRail: TriState
  /** True when the cart is at a known station or a safe footing. */
  atStation?: boolean
}): boolean {
  if (input.atStation)
    return true
  if (input.onRail === false)
    return true
  return input.speed <= MINECART_SAFE_DISMOUNT_SPEED
}

/** Braking distance for a cart at `speed` with a given friction, in blocks. */
export function minecartBrakingDistance(speed: number, deceleration = 0.05): number {
  if (deceleration <= 0)
    return Number.POSITIVE_INFINITY
  return (speed * speed) / (2 * deceleration)
}
