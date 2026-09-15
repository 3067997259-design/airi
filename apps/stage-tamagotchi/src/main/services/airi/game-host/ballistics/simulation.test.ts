import { describe, expect, it } from 'vitest'

import { PROJECTILE_PROFILES } from './profile'
import { launchDirection, launchVelocity, simulateProjectile } from './simulation'

const EYE = { x: 0, y: 65.62, z: 0 }

describe('launch direction (Projectile#shootFromRotation)', () => {
  it('maps the Minecraft look angles to a unit vector', () => {
    expect(launchDirection({ yaw: 0, pitch: 0 })).toEqual({ x: 0, y: 0, z: 1 })
    const west = launchDirection({ yaw: 90, pitch: 0 })
    expect(west.x).toBeCloseTo(-1, 6)
    expect(west.z).toBeCloseTo(0, 6)
    const down = launchDirection({ yaw: 0, pitch: 90 })
    expect(down.y).toBeCloseTo(-1, 6)
  })

  it('applies the potion pitch offset', () => {
    const plain = launchDirection({ yaw: 0, pitch: 0 })
    const potion = launchDirection({ yaw: 0, pitch: 0, pitchOffsetDeg: -20 })
    expect(potion.y).toBeGreaterThan(plain.y)
    expect(Math.hypot(potion.x, potion.y, potion.z)).toBeCloseTo(1, 6)
  })
})

describe('launch velocity', () => {
  it('scales the unit direction by the charge speed', () => {
    const velocity = launchVelocity({ profile: PROJECTILE_PROFILES['bow-arrow'], yaw: 0, pitch: 0, speed: 3 })
    expect(velocity.x).toBeCloseTo(0, 6)
    expect(velocity.y).toBeCloseTo(0, 6)
    expect(velocity.z).toBeCloseTo(3, 6)
  })

  it('adds the shooter movement for shootFromRotation projectiles, without the grounded Y', () => {
    const grounded = launchVelocity({
      profile: PROJECTILE_PROFILES['bow-arrow'],
      yaw: 0,
      pitch: 0,
      speed: 1,
      shooterVelocity: { x: 0.2, y: 0.3, z: -0.1 },
      shooterOnGround: true,
    })
    expect(grounded.x).toBeCloseTo(0.2, 6)
    expect(grounded.y).toBeCloseTo(0, 6)
    expect(grounded.z).toBeCloseTo(0.9, 6)
    const airborne = launchVelocity({
      profile: PROJECTILE_PROFILES['bow-arrow'],
      yaw: 0,
      pitch: 0,
      speed: 1,
      shooterVelocity: { x: 0, y: 0.3, z: 0 },
      shooterOnGround: false,
    })
    expect(airborne.y).toBeCloseTo(0.3, 6)
  })

  it('does not inherit shooter movement for a crossbow bolt', () => {
    const velocity = launchVelocity({
      profile: PROJECTILE_PROFILES['crossbow-arrow'],
      yaw: 0,
      pitch: 0,
      speed: 3.15,
      shooterVelocity: { x: 1, y: 1, z: 1 },
      shooterOnGround: false,
    })
    expect(velocity.x).toBeCloseTo(0, 6)
    expect(velocity.y).toBeCloseTo(0, 6)
    expect(velocity.z).toBeCloseTo(3.15, 6)
  })
})

describe('per-tick update order (AbstractArrow#tick)', () => {
  it('moves by the pre-drag velocity, then applies drag and gravity', () => {
    const trajectory = simulateProjectile({
      profile: PROJECTILE_PROFILES['bow-arrow'],
      launchPosition: EYE,
      yaw: 0,
      pitch: 0,
      speed: 1,
      maxTicks: 1,
    })
    const initial = trajectory.initialVelocity
    expect(trajectory.samples).toHaveLength(1)
    const [first] = trajectory.samples
    // position += velocity happens before the inertia and gravity update.
    expect(first.position).toEqual({ x: EYE.x + initial.x, y: EYE.y + initial.y, z: EYE.z + initial.z })
    expect(first.velocity.x).toBeCloseTo(initial.x * PROJECTILE_PROFILES['bow-arrow'].airInertia, 6)
    expect(first.velocity.y).toBeCloseTo(initial.y * PROJECTILE_PROFILES['bow-arrow'].airInertia - PROJECTILE_PROFILES['bow-arrow'].gravity, 6)
  })

  it('pulls a horizontal shot down over successive ticks', () => {
    const trajectory = simulateProjectile({
      profile: PROJECTILE_PROFILES['bow-arrow'],
      launchPosition: EYE,
      yaw: 0,
      pitch: 0,
      speed: 3,
      maxTicks: 10,
    })
    const first = trajectory.samples[0].position.y
    const last = trajectory.samples[trajectory.samples.length - 1].position.y
    expect(last).toBeLessThan(first)
  })

  it('uses the profile water inertia while submerged', () => {
    const dry = simulateProjectile({
      profile: PROJECTILE_PROFILES['bow-arrow'],
      launchPosition: EYE,
      yaw: 0,
      pitch: 0,
      speed: 3,
      maxTicks: 5,
    })
    const wet = simulateProjectile({
      profile: PROJECTILE_PROFILES['bow-arrow'],
      launchPosition: EYE,
      yaw: 0,
      pitch: 0,
      speed: 3,
      maxTicks: 5,
      inWater: () => true,
    })
    expect(wet.samples[4].velocity.z).toBeLessThan(dry.samples[4].velocity.z)
    expect(wet.samples[4].velocity.z).toBeCloseTo(3 * 0.6 ** 5, 6)
  })

  it('stops below the world floor', () => {
    const trajectory = simulateProjectile({
      profile: PROJECTILE_PROFILES['bow-arrow'],
      launchPosition: { x: 0, y: 0, z: 0 },
      yaw: 0,
      pitch: 90,
      speed: 3,
      minY: -4,
      maxTicks: 100,
    })
    expect(trajectory.endReason).toBe('below-world')
  })

  it('is deterministic and never exceeds the tick budget', () => {
    const input = {
      profile: PROJECTILE_PROFILES.trident,
      launchPosition: EYE,
      yaw: 30,
      pitch: -20,
      speed: 2.5,
      maxTicks: 40,
    } as const
    const first = simulateProjectile(input)
    const second = simulateProjectile(input)
    expect(first).toEqual(second)
    expect(first.samples.length).toBeLessThanOrEqual(40)
  })
})
