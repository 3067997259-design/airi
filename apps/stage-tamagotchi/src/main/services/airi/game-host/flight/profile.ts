/**
 * Versioned elytra flight profile (elytra-navigation design §5, CD-E1).
 *
 * Every constant below was read from the mapped 1.21.1 classes with
 * `javap -p -c`; the `class#method` is named beside each value and the source
 * line is recorded on the profile. No value is taken from a wiki, from another
 * version, or from a real-world aircraft model.
 *
 * Reading locations:
 *
 * - `net.minecraft.world.entity.LivingEntity#travel` (the `isFallFlying`
 *   branch): gravity, the lift/dive/climb terms, the steady glide term and the
 *   `0.99/0.98/0.99` drag, applied in this order before `move`.
 * - `net.minecraft.world.entity.projectile.FireworkRocketEntity#tick`: the
 *   attached boost `v + look * 0.1 + (look * 1.5 - v) * 0.5`.
 *
 * The profile binds the Minecraft version and the known movement-affecting
 * mods. A prediction residual calibration on a real machine is required before
 * any error bound is claimed; that calibration is NOT-RUN (design §9).
 */
import type { FlightPoseBox } from './contracts'

/** Minecraft version every constant in this module was extracted from. */
export const FLIGHT_PROFILE_VERSION = '1.21.1'

/**
 * Revision of the solved flight model.
 *
 * A receipt records it so a re-verified release is distinguishable from a
 * solution computed against an older model.
 */
export const FLIGHT_SOLUTION_REVISION = 1

/**
 * Gravity the elytra branch adds.
 *
 * `LivingEntity#travel` loads `getGravity()` into a local (`dstore_2`) and
 * applies `vel.y += gravity * (-1 + cosPitch^2 * 0.75)`. For a player the
 * default gravity is `0.08`; slow falling lowers it to `0.01`.
 */
export const FLIGHT_GRAVITY = 0.08

/** `0.75`: the lift multiplier inside the gravity term, `LivingEntity#travel`. */
export const FLIGHT_LIFT_FACTOR = 0.75

/** `-0.1`: the dive term `vel.y * -0.1 * cosPitch^2`, `LivingEntity#travel`. */
export const FLIGHT_DIVE_FACTOR = -0.1

/** `0.04`: the climb term `horizontalSpeed * -sin(pitch) * 0.04`, `LivingEntity#travel`. */
export const FLIGHT_CLIMB_FACTOR = 0.04

/** `3.2`: the climb vertical multiplier, `LivingEntity#travel`. */
export const FLIGHT_CLIMB_THRUST = 3.2

/** `0.1`: the steady glide pull toward `look * horizontalSpeed`, `LivingEntity#travel`. */
export const FLIGHT_STEADY_PULL = 0.1

/** `0.99` horizontal drag, `LivingEntity#travel` `multiply(0.99, 0.98, 0.99)`. */
export const FLIGHT_HORIZONTAL_DRAG = 0.99
/** `0.98` vertical drag, `LivingEntity#travel`. */
export const FLIGHT_VERTICAL_DRAG = 0.98

/**
 * `0.4`: `getLookAngle()` has length 1 for a player, but the branch clamps the
 * lift factor by `min(1, lookLength / 0.4)`, `LivingEntity#travel`.
 */
export const FLIGHT_LOOK_LENGTH_CAP = 0.4

/** `1.5`: the rocket target speed inside the firework boost. */
export const FLIGHT_ROCKET_TARGET_SPEED = 1.5
/** `0.1`: the rocket base acceleration inside the firework boost. */
export const FLIGHT_ROCKET_BASE_ACCEL = 0.1
/** `0.5`: the rocket velocity pull inside the firework boost. */
export const FLIGHT_ROCKET_PULL = 0.5

/** Default player pose box the swept collision uses. */
export const FLIGHT_POSE_BOX: FlightPoseBox = { width: 0.6, height: 1.8 }

/** A mod the profile knows can change elytra movement. */
export interface FlightModifier {
  id: string
  /** Only movement-affecting mods belong in a profile binding. */
  affects: 'movement'
  note?: string
}

/**
 * One versioned flight model (design §5).
 *
 * A profile with an unknown version or an unknown movement mod is refused
 * rather than flown with guessed physics.
 */
export interface FlightProfile {
  id: string
  version: string
  revision: number
  modifiers: FlightModifier[]
  gravity: number
  liftFactor: number
  diveFactor: number
  climbFactor: number
  climbThrust: number
  steadyPull: number
  horizontalDrag: number
  verticalDrag: number
  lookLengthCap: number
  rocketTargetSpeed: number
  rocketBaseAccel: number
  rocketPull: number
  poseBox: FlightPoseBox
  /** `class#method` the constants came from. */
  source: string
}

/** The vanilla 1.21.1 profile with no movement-affecting mods. */
export const FLIGHT_PROFILE_1_21_1: FlightProfile = {
  id: 'vanilla-1.21.1',
  version: FLIGHT_PROFILE_VERSION,
  revision: FLIGHT_SOLUTION_REVISION,
  modifiers: [],
  gravity: FLIGHT_GRAVITY,
  liftFactor: FLIGHT_LIFT_FACTOR,
  diveFactor: FLIGHT_DIVE_FACTOR,
  climbFactor: FLIGHT_CLIMB_FACTOR,
  climbThrust: FLIGHT_CLIMB_THRUST,
  steadyPull: FLIGHT_STEADY_PULL,
  horizontalDrag: FLIGHT_HORIZONTAL_DRAG,
  verticalDrag: FLIGHT_VERTICAL_DRAG,
  lookLengthCap: FLIGHT_LOOK_LENGTH_CAP,
  rocketTargetSpeed: FLIGHT_ROCKET_TARGET_SPEED,
  rocketBaseAccel: FLIGHT_ROCKET_BASE_ACCEL,
  rocketPull: FLIGHT_ROCKET_PULL,
  poseBox: FLIGHT_POSE_BOX,
  source: 'LivingEntity#travel (fall-flying branch), FireworkRocketEntity#tick',
}

/**
 * Movement-affecting mod ids this model can bind.
 *
 * An empty list is the vanilla model. A mod that changes elytra motion must be
 * added here with its own tuned profile before it is simulated; otherwise the
 * lookup refuses the session.
 */
export const KNOWN_FLIGHT_MODIFIERS: Record<string, FlightModifier> = {}

export type FlightProfileResolution
  = | { ok: true, profile: FlightProfile }
    | { ok: false, reason: 'unsupported_flight_profile', requested: string }

/**
 * Resolves the flight profile for a version and a mod set.
 *
 * @example
 * resolveFlightProfile('1.21.1', []).ok
 * // => true
 */
export function resolveFlightProfile(version: string, modIds: string[] = []): FlightProfileResolution {
  if (version !== FLIGHT_PROFILE_VERSION)
    return { ok: false, reason: 'unsupported_flight_profile', requested: version }
  const modifiers: FlightModifier[] = []
  for (const id of modIds) {
    const modifier = KNOWN_FLIGHT_MODIFIERS[id]
    if (!modifier)
      return { ok: false, reason: 'unsupported_flight_profile', requested: `${version}+${id}` }
    modifiers.push(modifier)
  }
  return { ok: true, profile: { ...FLIGHT_PROFILE_1_21_1, modifiers } }
}

/**
 * Live wiring switch for the rollout planner (B0/LR-0, checklist §3.1).
 *
 * `enabled` is the explicit switch point: while the switch is absent the live
 * elytra and air-follow drivers keep the heuristic cruise control unchanged.
 * `calibrated` records the E-01 residual-calibration verdict; the escort
 * strategy and the low-altitude shortcuts additionally require it (escort
 * design D6), so it stays false until that run is registered PASS.
 */
export interface FlightPlannerSwitch {
  enabled: boolean
  profile: FlightProfile
  calibrated: boolean
  /** False when the config asked for the route layers without the per-poll rollout replacement. */
  rolloutOn: boolean
}

/**
 * Resolves the live planner switch from the persisted flight config.
 *
 * Returns `undefined` unless the planner is explicitly on and the profile
 * resolves for the reported Minecraft version; an unresolvable profile keeps
 * the heuristic path instead of flying on guessed physics.
 *
 * @example
 * resolveFlightPlannerSwitch({ planner: 'on' }, '1.21.1')?.enabled
 * // => true
 * resolveFlightPlannerSwitch(undefined, '1.21.1')
 * // => undefined
 */
export function resolveFlightPlannerSwitch(
  flight: { planner?: 'off' | 'on', rollout?: 'on' | 'off', calibrated?: boolean } | undefined,
  minecraftVersion: string,
): FlightPlannerSwitch | undefined {
  if (flight?.planner !== 'on')
    return undefined
  const resolution = resolveFlightProfile(minecraftVersion)
  if (!resolution.ok)
    return undefined
  return {
    enabled: true,
    profile: resolution.profile,
    calibrated: flight.calibrated === true,
    rolloutOn: flight.rollout !== 'off',
  }
}
