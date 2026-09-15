/**
 * Touch-down classification for the elytra lifecycle (elytra-navigation design §6, CD-E0).
 *
 * Stopping a glide is not a landing. A touch-down is confirmed only from a
 * fresh `onGround`, a plausible contact position and a low residual speed.
 * Drowning is its own outcome, and a missing read stays `unknown` instead of
 * being reported as a landing (design §1).
 *
 * Pure: a caller passes the last observed sample and the reference point the
 * touch-down was aimed at.
 */
import type { Vec3 } from '../movement/types'

/**
 * The subset of a player-state read a touch-down decision needs.
 *
 * Every field is optional so a partial read classifies as `unknown`, not as a
 * landing. `onGround` and `fallFlying` must be explicit facts when present.
 */
export interface TouchdownSample {
  position?: Vec3
  motion?: Vec3
  onGround?: boolean
  inWater?: boolean
  fallFlying?: boolean
}

/** Horizontal speed above this is motion, not a settled touch-down, blocks/tick. */
export const TOUCHDOWN_MAX_HORIZONTAL_SPEED = 0.5
/** Vertical speed magnitude above this is still a fall or a bounce, blocks/tick. */
export const TOUCHDOWN_MAX_VERTICAL_SPEED = 0.5
/** Contact is plausible only within this many blocks of the aimed point. */
export const TOUCHDOWN_POSITION_TOLERANCE = 8

/** Result of classifying one sample. */
export type TouchdownOutcome
  = | { kind: 'still-flying' }
    | { kind: 'landed', position: Vec3, horizontalSpeed: number, verticalSpeed: number }
    | { kind: 'water' }
    /** Glide ended without ground contact; the player is falling. */
    | { kind: 'lost-flight', position: Vec3 }
    /** A missing or incomplete read; never a landing. */
    | { kind: 'unknown', reason: string }
    /** Ground contact, but the sample cannot confirm a settled touch-down. */
    | { kind: 'unsettled', position: Vec3, reason: string }

function horizontalSpeedOf(motion: Vec3 | undefined): number {
  return motion ? Math.hypot(motion.x, motion.z) : 0
}

/**
 * Classifies the last flight sample.
 *
 * @example
 * classifyTouchdown({ position: { x: 0, y: 64, z: 0 }, onGround: true, motion: { x: 0, y: 0, z: 0 } }, { x: 0, y: 64, z: 0 })
 * // => { kind: 'landed', ... }
 */
export function classifyTouchdown(
  sample: TouchdownSample | undefined,
  reference: Vec3,
  options: {
    maxHorizontalSpeed?: number
    maxVerticalSpeed?: number
    positionTolerance?: number
  } = {},
): TouchdownOutcome {
  if (!sample || !sample.position)
    return { kind: 'unknown', reason: 'no position in the flight sample' }
  const position = sample.position
  const horizontalSpeed = horizontalSpeedOf(sample.motion)
  const verticalSpeed = Math.abs(sample.motion?.y ?? 0)

  if (sample.inWater === true)
    return { kind: 'water' }
  if (sample.fallFlying === true)
    return { kind: 'still-flying' }
  if (sample.onGround !== true) {
    // `onGround` false with a known glide state is a fall; a missing field is
    // an incomplete read, which is unknown rather than a landing.
    if (sample.fallFlying === false)
      return { kind: 'lost-flight', position }
    return { kind: 'unknown', reason: 'onGround was not reported' }
  }

  const maxHorizontal = options.maxHorizontalSpeed ?? TOUCHDOWN_MAX_HORIZONTAL_SPEED
  const maxVertical = options.maxVerticalSpeed ?? TOUCHDOWN_MAX_VERTICAL_SPEED
  const tolerance = options.positionTolerance ?? TOUCHDOWN_POSITION_TOLERANCE
  if (horizontalSpeed > maxHorizontal || verticalSpeed > maxVertical) {
    return {
      kind: 'unsettled',
      position,
      reason: `residual speed ${horizontalSpeed.toFixed(2)}/${verticalSpeed.toFixed(2)}`,
    }
  }
  if (Math.hypot(position.x - reference.x, position.z - reference.z) > tolerance) {
    return {
      kind: 'unsettled',
      position,
      reason: `contact ${Math.hypot(position.x - reference.x, position.z - reference.z).toFixed(1)} blocks from the aimed point`,
    }
  }
  return { kind: 'landed', position, horizontalSpeed, verticalSpeed }
}
