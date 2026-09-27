/**
 * Pure per-tick elytra simulation (elytra-navigation design §5, CD-E1).
 *
 * `stepFlight` reproduces the 1.21.1 `LivingEntity#travel` fall-flying branch in
 * the mapped update order, then adds the attached firework boost from
 * `FireworkRocketEntity#tick`. It never moves a real player and never reads the
 * network.
 *
 * Update order per tick (constants from {@link ./profile}):
 *
 * 1. `look = getLookAngle(yaw, pitch)`;
 * 2. `gravity * (-1 + cosPitch^2 * min(1, lookLength / 0.4))` added to `v.y`;
 * 3. the dive term while descending: `d = v.y * -0.1 * lift`; `v += look * d`;
 * 4. the climb term while looking up: `d = vHorizontal * -sin(pitch) * 0.04`;
 *    `v += -lookH * d`, `v.y += d * 3.2`;
 * 5. the steady glide pull toward `look * vHorizontal`;
 * 6. drag `v *= (0.99, 0.98, 0.99)`;
 * 7. `position += v`.
 *
 * The firework boost sets `v += look * 0.1 + (look * 1.5 - v) * 0.5` before the
 * glide on the modelled tick. The real order between the player entity tick and
 * the firework entity tick is not proven here; residual calibration is NOT-RUN.
 */
import type { Vec3 } from '../movement/types'
import type { FlightProfile } from './profile'

/**
 * Rocket boost ticks a fresh firework applies.
 *
 * NOTICE:
 * Why 35: measured on 2026-09-18 (E-01, `flight_duration: 2` rockets). A live
 * burn held its plateau speed from the impulse through tick 35 and only then
 * began decaying at 0.0198 blocks/tick; the pre-fix value of 10 started decaying
 * at tick 10 and left the speed 0.32 blocks/tick low by tick 30, which is what
 * made the boost trajectory residual grow to 5.6 blocks instead of converging.
 * Root cause: a firework entity calls `boostPlayer` on EVERY tick it stays
 * alive, so the window is the entity's lifetime, not a fixed 10 ticks — 10 is
 * most likely just the rise time to `rocketTargetSpeed`.
 * Source: docs/fork/evidence/e01-flight-calibration-20260918/e01-residuals.md §6.2.
 * Removal condition: none — re-measure when the profile moves to another
 * Minecraft version or a different `flight_duration` is used in flight.
 */
export const ROCKET_BOOST_TICKS = 35

/** Modelled per-tick state. `velocity` is left after this tick's drag. */
export interface FlightState {
  position: Vec3
  velocity: Vec3
  /** Minecraft yaw in degrees. */
  yaw: number
  /** Minecraft pitch in degrees; positive looks down. */
  pitch: number
  /** Rocket boost ticks still applied; a fresh rocket sets this. */
  rocketTicksRemaining: number
  onGround: boolean
  inWater: boolean
}

export interface FlightInput {
  yaw: number
  pitch: number
  /** Fire a rocket this tick; the profile counts one use per request. */
  useRocket?: boolean
  /** Whether a rocket exists to fire. */
  rocketAvailable?: boolean
}

/** The world facts the pure step needs; collision is a predicate, not a read. */
export interface FlightWorld {
  /** True when the cell at the position is occupied or unknown. */
  isBlocked?: (position: Vec3) => boolean
  /** Dimension floor; below it the glider is out of bounds. */
  minY?: number
}

/** One recorded tick. */
export interface FlightSample {
  tick: number
  position: Vec3
  velocity: Vec3
  onGround: boolean
  inWater: boolean
  rocketTicksRemaining: number
  /** True on the tick a new rocket was fired. */
  rocketFired: boolean
}

export interface FlightTrajectory {
  profileId: string
  version: string
  revision: number
  samples: FlightSample[]
  endReason: 'input-exhausted' | 'max-ticks' | 'blocked' | 'below-world' | 'landed'
  collision?: Vec3
}

/**
 * `Entity#getLookAngle` for a yaw and pitch in degrees.
 *
 * `x = -sin(yaw)cos(pitch)`, `y = -sin(pitch)`, `z = cos(yaw)cos(pitch)`.
 *
 * @example
 * lookVector(0, 0)
 * // => { x: 0, y: 0, z: 1 }
 */
export function lookVector(yaw: number, pitch: number): Vec3 {
  const yawRad = yaw * Math.PI / 180
  const pitchRad = pitch * Math.PI / 180
  return {
    x: -Math.sin(yawRad) * Math.cos(pitchRad),
    y: -Math.sin(pitchRad),
    z: Math.cos(yawRad) * Math.cos(pitchRad),
  }
}

function horizontalDistance(vector: Vec3): number {
  return Math.hypot(vector.x, vector.z)
}

function length(vector: Vec3): number {
  return Math.hypot(vector.x, vector.y, vector.z)
}

/** Applies the attached firework boost to a copy of `velocity`. */
function applyRocketBoost(profile: FlightProfile, velocity: Vec3, look: Vec3): Vec3 {
  const target = profile.rocketTargetSpeed
  const base = profile.rocketBaseAccel
  const pull = profile.rocketPull
  return {
    x: velocity.x + look.x * base + (look.x * target - velocity.x) * pull,
    y: velocity.y + look.y * base + (look.y * target - velocity.y) * pull,
    z: velocity.z + look.z * base + (look.z * target - velocity.z) * pull,
  }
}

/**
 * One side-effect-free flight tick.
 *
 * @example
 * stepFlight(FLIGHT_PROFILE_1_21_1, { position: { x: 0, y: 100, z: 0 }, velocity: { x: 0, y: 0, z: 1 }, yaw: 0, pitch: 0, rocketTicksRemaining: 0, onGround: false, inWater: false }, { yaw: 0, pitch: 0 })
 * // position advances roughly one block south
 */
export function stepFlight(profile: FlightProfile, state: FlightState, input: FlightInput, world: FlightWorld = {}): FlightState {
  const look = lookVector(input.yaw, input.pitch)
  const lookHorizontal = horizontalDistance(look)
  const lookLength = length(look)
  const pitchRad = input.pitch * Math.PI / 180

  // The lift factor uses cos(pitch)^2, capped by the look length so a non-unit
  // look vector cannot inflate it (LivingEntity#travel).
  const lift = Math.cos(pitchRad) ** 2 * Math.min(1, lookLength / profile.lookLengthCap)

  let velocity: Vec3 = { ...state.velocity }
  let rocketTicksRemaining = state.rocketTicksRemaining

  // The glide runs on the PRE-thrust velocity. Calibrated against the live
  // telemetry boundary (ab-17 audit 2026-09-21): the next recorded position
  // matches a glide step with the pre-thrust velocity, and the rocket's pull
  // reaches the velocity only AFTER that displacement. The old order (boost
  // first) had a single-step position error P95 of 0.54 blocks on 139 boosted
  // ticks; this one fits to ~2e-5. Java's FlightDynamics mirrors this order.
  const horizontalSpeed = horizontalDistance(velocity)

  velocity = {
    ...velocity,
    y: velocity.y + profile.gravity * (-1 + lift * profile.liftFactor),
  }

  if (velocity.y < 0 && lookHorizontal > 0) {
    const dive = velocity.y * profile.diveFactor * lift
    velocity = {
      x: velocity.x + look.x * dive / lookHorizontal,
      y: velocity.y + dive,
      z: velocity.z + look.z * dive / lookHorizontal,
    }
  }

  if (pitchRad < 0 && lookHorizontal > 0) {
    // The climb term uses the horizontal speed captured before this tick's
    // updates (d1 in the bytecode), not the already-updated velocity.
    const climb = horizontalSpeed * (-Math.sin(pitchRad)) * profile.climbFactor
    velocity = {
      x: velocity.x - look.x * climb / lookHorizontal,
      y: velocity.y + climb * profile.climbThrust,
      z: velocity.z - look.z * climb / lookHorizontal,
    }
  }

  if (lookHorizontal > 0) {
    velocity = {
      x: velocity.x + (look.x / lookHorizontal * horizontalSpeed - velocity.x) * profile.steadyPull,
      y: velocity.y,
      z: velocity.z + (look.z / lookHorizontal * horizontalSpeed - velocity.z) * profile.steadyPull,
    }
  }

  velocity = {
    x: velocity.x * profile.horizontalDrag,
    y: velocity.y * profile.verticalDrag,
    z: velocity.z * profile.horizontalDrag,
  }

  const position = {
    x: state.position.x + velocity.x,
    y: state.position.y + velocity.y,
    z: state.position.z + velocity.z,
  }

  // The rocket's pull lands on the velocity AFTER the displacement, so it
  // steers the NEXT tick's motion.
  if (input.useRocket === true && input.rocketAvailable !== false)
    rocketTicksRemaining = ROCKET_BOOST_TICKS
  if (rocketTicksRemaining > 0) {
    velocity = applyRocketBoost(profile, velocity, look)
    rocketTicksRemaining -= 1
  }

  const onGround = world.isBlocked?.(position) === true

  return {
    position,
    velocity,
    yaw: input.yaw,
    pitch: input.pitch,
    rocketTicksRemaining,
    onGround,
    inWater: state.inWater,
  }
}

/** One input for a future tick; the trajectory walks the list in order. */
export interface ScheduledInput extends FlightInput {
  useRocket?: boolean
  rocketAvailable?: boolean
}

/** Sub-samples per tick the collision sweep tests along the segment. */
const SWEEP_SUBSTEPS = 4

/**
 * Runs the pure curve for a list of per-tick inputs.
 *
 * The collision sweep tests `SWEEP_SUBSTEPS` points along each segment so a
 * thin obstacle between two end points is not skipped; a whole read failure is
 * the caller's concern (E2 widens the sweep by the error budget).
 *
 * @example
 * simulateFlight(FLIGHT_PROFILE_1_21_1, initialState, [{ yaw: 0, pitch: 0 }], {}, { maxTicks: 40 }).samples.length
 */
export function simulateFlight(
  profile: FlightProfile,
  initial: FlightState,
  inputs: ScheduledInput[],
  world: FlightWorld = {},
  options: { maxTicks?: number } = {},
): FlightTrajectory {
  const maxTicks = options.maxTicks ?? inputs.length
  const samples: FlightSample[] = []
  let state = { ...initial, position: { ...initial.position }, velocity: { ...initial.velocity } }
  let endReason: FlightTrajectory['endReason'] = 'max-ticks'
  let collision: Vec3 | undefined

  for (let tick = 1; tick <= maxTicks; tick++) {
    const input = inputs[tick - 1] ?? inputs[inputs.length - 1] ?? { yaw: state.yaw, pitch: state.pitch }
    const previous = state.position
    const next = stepFlight(profile, state, input, world)
    const blockedAt = firstBlockedOnSegment(world, previous, next.position)
    if (blockedAt) {
      collision = blockedAt
      endReason = 'blocked'
      break
    }
    if (world.minY !== undefined && next.position.y <= world.minY) {
      state = next
      samples.push(toSample(tick, next, input))
      endReason = 'below-world'
      break
    }
    state = next
    samples.push(toSample(tick, state, input))
    if (state.onGround) {
      endReason = 'landed'
      break
    }
  }

  if (endReason === 'max-ticks' && samples.length >= inputs.length && samples.length >= maxTicks)
    endReason = inputs.length < maxTicks ? 'input-exhausted' : 'max-ticks'

  return {
    profileId: profile.id,
    version: profile.version,
    revision: profile.revision,
    samples,
    endReason,
    ...(collision ? { collision } : {}),
  }
}

function toSample(tick: number, state: FlightState, input: FlightInput): FlightSample {
  return {
    tick,
    position: { ...state.position },
    velocity: { ...state.velocity },
    onGround: state.onGround,
    inWater: state.inWater,
    rocketTicksRemaining: state.rocketTicksRemaining,
    rocketFired: input.useRocket === true,
  }
}

/** First sub-sample position along a segment that the world reports blocked. */
function firstBlockedOnSegment(world: FlightWorld, from: Vec3, to: Vec3): Vec3 | undefined {
  if (!world.isBlocked)
    return undefined
  for (let step = 1; step <= SWEEP_SUBSTEPS; step++) {
    const t = step / SWEEP_SUBSTEPS
    const point = {
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
      z: from.z + (to.z - from.z) * t,
    }
    if (world.isBlocked(point))
      return point
  }
  return undefined
}

/**
 * A bounded ring-buffer trajectory recorder (design §6).
 *
 * The client records ticks locally and the main process reads a batch; this is
 * the pure shape of that buffer, not a network protocol.
 */
export interface TrajectoryRecorder {
  push: (sample: FlightSample) => void
  snapshot: () => FlightSample[]
  clear: () => void
}

/**
 * Creates a fixed-capacity recorder that overwrites the oldest sample.
 *
 * @example
 * const recorder = createTrajectoryRecorder(2)
 * recorder.push(sampleA); recorder.push(sampleB); recorder.push(sampleC)
 * recorder.snapshot().length
 * // => 2
 */
export function createTrajectoryRecorder(capacity: number): TrajectoryRecorder {
  const buffer: FlightSample[] = []
  return {
    push: (sample) => {
      buffer.push(sample)
      while (buffer.length > capacity)
        buffer.shift()
    },
    snapshot: () => buffer.map(sample => ({ ...sample, position: { ...sample.position }, velocity: { ...sample.velocity } })),
    clear: () => {
      buffer.length = 0
    },
  }
}

/** Serializes a recorded trajectory as one JSON object per line. */
export function trajectoryToJsonl(trajectory: FlightTrajectory): string {
  return trajectory.samples
    .map(sample => JSON.stringify({ profileId: trajectory.profileId, version: trajectory.version, revision: trajectory.revision, tick: sample.tick, position: sample.position, velocity: sample.velocity }))
    .join('\n')
}
