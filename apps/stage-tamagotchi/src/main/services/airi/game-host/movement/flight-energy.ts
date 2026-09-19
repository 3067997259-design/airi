/**
 * Thrust economy for the air-follow cruise (LR-3, escort design D4).
 *
 * The pre-LR-3 driver ignited on any of three independent thresholds — climbing,
 * speed below the glide floor, or out of the spacing band — which fires on most
 * polls of a long chase. A live 108 s follow spent 114 rockets (about one per
 * second) closing a gap by burning supply instead of by trading height for
 * distance (escort design §1).
 *
 * The design's rule is narrower: thrust only when the height is below what the
 * remaining glide needs, when the speed is below the glide floor, or when the
 * chase is not closing and the budget allows it. Everything else glides.
 */
import type { Vec3 } from './types'

/**
 * Horizontal speed the glide must keep to stay useful, blocks per tick.
 *
 * Same floor the driver has always used (`THRUST_SPEED`); below it the wing
 * stops covering ground and every further tick of glide is a loss.
 */
export const CRUISE_GLIDE_FLOOR = 0.45

/**
 * Height the calibrated glide gives up per block forward.
 *
 * NOTICE:
 * Why 0.26: the E-01 calibration (2026-09-18, vanilla 1.21.1) measured the
 * best glide at 3.76:1 (pitch −10) and 4.47:1 (pitch −3), i.e. 0.27 to 0.22
 * blocks of drop per block of advance. 0.26 is the conservative end of that
 * band. The older `MIN_GLIDE_RATIO = 0.08` used by the legacy reachability check
 * is 12.5:1 and under-states the needed height by about 2.8×, so it must not be
 * reused here.
 * Removal condition: when the profile exposes a per-pitch glide ratio derived
 * from `simulateFlight`, take the value from the calibrated profile instead.
 */
export const CRUISE_DROP_PER_BLOCK = 0.26

/** Height kept in hand for terrain, turns and observation error, in blocks. */
export const CRUISE_HEIGHT_MARGIN = 6

/** Extra margin per second of target-sample age (design D4: freshness binds the budget). */
export const CRUISE_MARGIN_PER_SECOND = 1.5

/** Ceiling on the age-widened margin; a very old sample does not justify infinite height. */
export const CRUISE_MARGIN_EXTRA_MAX = 8

/** Why the policy spent a rocket, or `economy` when it kept it. */
export type CruiseThrustReason = 'required_height' | 'glide_floor' | 'not_closing' | 'economy'

export interface CruiseEnergyInput {
  /** Horizontal distance to the aim point, in blocks. */
  gap: number
  /** Height above the aim point, in blocks. Negative when below it. */
  height: number
  /** Horizontal speed right now, blocks per tick. */
  speed: number
  /**
   * Closing rate over the last evaluation window, blocks per second.
   *
   * Absent means "not measured": a missing rate is not a negative one, so it
   * never spends a rocket on its own (design D4/D7).
   */
  closingRatePerSecond?: number
  /**
   * The spacing policy says the target has left the band.
   *
   * Used only when no closing rate exists, where a band violation is the same
   * fact measured a different way. With a fresh rate the rate decides.
   */
  behindBand?: boolean
  /** Rockets in the inventory, and the part this command may not spend on progress. */
  fireworks: number
  reserve: number
  /** Overrides; the calibrated defaults apply when absent. */
  dropPerBlock?: number
  glideFloorSpeed?: number
  heightMargin?: number
}

export interface CruiseEnergyPlan {
  thrust: boolean
  reason: CruiseThrustReason
  /** Height the remaining glide needs, in blocks. */
  requiredHeight: number
  /** Height above that requirement; negative means short. */
  surplusHeight: number
  /** Rockets above the reserve; zero means the flight may only land. */
  spendable: number
}

/**
 * Height margin that grows with the target sample's age (design D4/D7).
 *
 * A coarse 1 Hz observation cannot support the same confidence as a fresh one,
 * so the glide keeps more height in hand rather than planning to the last block.
 *
 * @example
 * energyMarginForAge(2_000)
 * // => 9  (6 base + 3 for two seconds of age)
 */
export function energyMarginForAge(ageMs: number | undefined): number {
  if (ageMs === undefined || !Number.isFinite(ageMs) || ageMs <= 0)
    return CRUISE_HEIGHT_MARGIN
  const extra = Math.min(CRUISE_MARGIN_EXTRA_MAX, (ageMs / 1000) * CRUISE_MARGIN_PER_SECOND)
  return CRUISE_HEIGHT_MARGIN + extra
}

/**
 * Decides whether this poll spends a rocket, and why.
 *
 * @example
 * planCruiseThrust({ gap: 120, height: 40, speed: 0.9, fireworks: 20, reserve: 2 })
 * // => { thrust: false, reason: 'economy', requiredHeight: 31.2, surplusHeight: 8.8, spendable: 18 }
 */
export function planCruiseThrust(input: CruiseEnergyInput): CruiseEnergyPlan {
  const dropPerBlock = input.dropPerBlock ?? CRUISE_DROP_PER_BLOCK
  const glideFloor = input.glideFloorSpeed ?? CRUISE_GLIDE_FLOOR
  const margin = input.heightMargin ?? CRUISE_HEIGHT_MARGIN
  const requiredHeight = Math.max(0, input.gap) * dropPerBlock
  const surplusHeight = input.height - requiredHeight
  const spendable = Math.max(0, input.fireworks - input.reserve)
  const plan: CruiseEnergyPlan = {
    thrust: false,
    reason: 'economy',
    requiredHeight,
    surplusHeight,
    spendable,
  }
  // The reserve is the nearest landing's supply; progress never touches it.
  if (spendable <= 0)
    return plan
  if (surplusHeight < margin)
    return { ...plan, thrust: true, reason: 'required_height' }
  if (input.speed < glideFloor)
    return { ...plan, thrust: true, reason: 'glide_floor' }
  const notClosing = input.closingRatePerSecond !== undefined
    ? input.closingRatePerSecond <= 0
    : input.behindBand === true
  if (notClosing)
    return { ...plan, thrust: true, reason: 'not_closing' }
  return plan
}

/**
 * How much the corridor's route bends away from the straight line to the goal.
 *
 * The D2 estimate multiplies the straight-line gap by a detour factor. Until the
 * corridor exposed an ordered path this was the constant 1.3; measuring the
 * dogleg through the route's next aim point is the cheapest honest replacement:
 * an aim on the straight line gives 1.0, and a route that swings aside gives
 * more. It is a lower bound on the true detour (a route can bend more than its
 * next point shows), which is the safe direction for a feasibility gate.
 */
export function routeDetourRatio(input: {
  self: Vec3
  aim: Vec3
  goal: Vec3
  /** Ceiling so one odd aim point cannot inflate the estimate without bound. */
  max?: number
}): number {
  const max = input.max ?? 2.5
  const straight = Math.hypot(input.goal.x - input.self.x, input.goal.z - input.self.z)
  if (straight < 1)
    return 1
  const outbound = Math.hypot(input.aim.x - input.self.x, input.aim.z - input.self.z)
  const inbound = Math.hypot(input.goal.x - input.aim.x, input.goal.z - input.aim.z)
  const ratio = (outbound + inbound) / straight
  if (!Number.isFinite(ratio))
    return 1
  return Math.min(max, Math.max(1, ratio))
}
