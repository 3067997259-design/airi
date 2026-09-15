/**
 * Pure per-tick ballistic simulation (projectile-aiming design CD-B1).
 *
 * The simulation never spawns a real projectile. It reproduces the vanilla
 * `tick` update order extracted from the 1.21.1 mapped classes:
 *
 * 1. `position += velocity` (the velocity captured before this tick's drag);
 * 2. `velocity *= inertia` (`0.99` in air, the profile's water value in a fluid);
 * 3. `velocity.y -= gravity` (`AbstractArrow#tick` then `applyGravity`).
 *
 * The launch velocity mirrors `Projectile#shootFromRotation`: the normalized
 * look direction receives a symmetric per-axis spread, is scaled by the charge
 * speed, and then gains the shooter's known movement unless the profile says
 * otherwise.
 *
 * Every function here is side-effect-free. A caller that wants collision against
 * terrain passes a predicate to {@link ./intercept}; this module only produces
 * the curve.
 */
import type { Vec3 } from '../movement/types'
import type { ProjectileProfile } from './profile'

/** One simulated tick. `position` is the position at the end of the tick. */
export interface TrajectorySample {
  tick: number
  position: Vec3
  /** Velocity carried into the next tick (after this tick's drag and gravity). */
  velocity: Vec3
  inWater: boolean
}

/** A simulated curve plus the launch facts a receipt wants to record. */
export interface Trajectory {
  profileId: string
  version: string
  launchPosition: Vec3
  initialVelocity: Vec3
  samples: TrajectorySample[]
  endReason: 'max-ticks' | 'below-world'
}

export interface LaunchVelocityInput {
  profile: ProjectileProfile
  /** Minecraft look yaw in degrees. */
  yaw: number
  /** Minecraft look pitch in degrees (positive looks down). */
  pitch: number
  /** Absolute launch speed in blocks/tick. */
  speed: number
  shooterVelocity?: Vec3
  shooterOnGround?: boolean
}

export interface SimulationInput extends LaunchVelocityInput {
  launchPosition: Vec3
  /** Water test at the start of a tick; the default is dry air. */
  inWater?: (position: Vec3) => boolean
  /** Curve stops when the position is at or below this Y. */
  minY?: number
  maxTicks?: number
}

const DEFAULT_MAX_TICKS = 200
const DEFAULT_MIN_Y = -128

/**
 * Normalized launch direction from look angles.
 *
 * Mirrors `Projectile#shootFromRotation`: `x = -sin(yaw)cos(pitch)`,
 * `y = -sin(pitch + pitchOffset)`, `z = cos(yaw)cos(pitch)`, then normalize
 * (the offset can make the vector non-unit before `getMovementToShoot`).
 *
 * @example
 * launchDirection({ yaw: 0, pitch: 0 })
 * // => { x: 0, y: 0, z: 1 }
 */
export function launchDirection(input: { yaw: number, pitch: number, yawOffsetDeg?: number, pitchOffsetDeg?: number }): Vec3 {
  const yaw = ((input.yaw + (input.yawOffsetDeg ?? 0)) * Math.PI) / 180
  const pitch = (input.pitch * Math.PI) / 180
  const pitchOffset = ((input.pitchOffsetDeg ?? 0) * Math.PI) / 180
  const x = -Math.sin(yaw) * Math.cos(pitch)
  const y = -Math.sin(pitch + pitchOffset)
  const z = Math.cos(yaw) * Math.cos(pitch)
  const length = Math.hypot(x, y, z)
  if (length === 0)
    return { x: 0, y: 0, z: 1 }
  return { x: normalizeZero(x / length), y: normalizeZero(y / length), z: normalizeZero(z / length) }
}

function normalizeZero(value: number): number {
  return value === 0 ? 0 : value
}

/**
 * Launch velocity after spread-free direction, charge speed and, when the
 * profile inherits it, the shooter's known movement.
 *
 * `shootFromRotation` adds the shooter's horizontal movement and adds the
 * vertical movement only while airborne; {@link launchVelocity} reproduces
 * that rule.
 *
 * @example
 * launchVelocity({ profile: PROJECTILE_PROFILES['bow-arrow'], yaw: 0, pitch: 0, speed: 3 })
 * // => { x: 0, y: 0, z: 3 }
 */
export function launchVelocity(input: LaunchVelocityInput): Vec3 {
  const direction = launchDirection({
    yaw: input.yaw,
    pitch: input.pitch,
    yawOffsetDeg: input.profile.yawOffsetDeg,
    pitchOffsetDeg: input.profile.pitchOffsetDeg,
  })
  const velocity = {
    x: direction.x * input.speed,
    y: direction.y * input.speed,
    z: direction.z * input.speed,
  }
  if (input.profile.inheritShooterVelocity && input.shooterVelocity) {
    velocity.x += input.shooterVelocity.x
    velocity.y += input.shooterOnGround ? 0 : input.shooterVelocity.y
    velocity.z += input.shooterVelocity.z
  }
  return velocity
}

/**
 * Runs the pure per-tick curve for one launch.
 *
 * @example
 * simulateProjectile({ profile: PROJECTILE_PROFILES['bow-arrow'], launchPosition: { x: 0, y: 65.5, z: 0 }, yaw: 0, pitch: 0, speed: 3, maxTicks: 5 }).samples.length
 * // => 6
 */
export function simulateProjectile(input: SimulationInput): Trajectory {
  const maxTicks = input.maxTicks ?? DEFAULT_MAX_TICKS
  const minY = input.minY ?? DEFAULT_MIN_Y
  const initialVelocity = launchVelocity(input)
  const inWater = input.inWater ?? (() => false)

  const samples: TrajectorySample[] = []
  let position = { ...input.launchPosition }
  let velocity = { ...initialVelocity }
  let endReason: Trajectory['endReason'] = 'max-ticks'

  for (let tick = 1; tick <= maxTicks; tick++) {
    // The fluid test uses the position at the start of the tick, matching the
    // entity's `isInWater()` check before `setPos`.
    const water = inWater(position)
    const inertia = water ? input.profile.waterInertia : input.profile.airInertia
    const next = { x: position.x + velocity.x, y: position.y + velocity.y, z: position.z + velocity.z }
    velocity = {
      x: velocity.x * inertia,
      y: velocity.y * inertia - input.profile.gravity,
      z: velocity.z * inertia,
    }
    position = next
    samples.push({ tick, position, velocity, inWater: water })
    if (position.y <= minY) {
      endReason = 'below-world'
      break
    }
  }

  return {
    profileId: input.profile.id,
    version: input.profile.version,
    launchPosition: { ...input.launchPosition },
    initialVelocity,
    samples,
    endReason,
  }
}
