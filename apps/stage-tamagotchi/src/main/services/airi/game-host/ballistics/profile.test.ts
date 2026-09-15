import { describe, expect, it } from 'vitest'

import {
  ARROW_GRAVITY,
  ARROW_INACCURACY,
  ARROW_WATER_INERTIA,
  BOW_MAX_SPEED,
  BOW_MIN_POWER,
  bowPowerFraction,
  CROSSBOW_ARROW_SPEED,
  CROSSBOW_FIREWORK_SPEED,
  CROSSBOW_LOAD_TICKS,
  fullChargeTicks,
  LAUNCH_SPREAD_PER_AXIS,
  launchPositionFor,
  launchSpeed,
  POTION_GRAVITY,
  POTION_PITCH_OFFSET_DEG,
  POTION_SPEED,
  PROFILE_VERSION,
  PROJECTILE_AIR_INERTIA,
  PROJECTILE_PROFILES,
  resolveProjectileProfile,
  resolveWeaponProfile,
  SNOWBALL_GRAVITY,
  SNOWBALL_SPEED,
  SOLUTION_REVISION,
  THROWABLE_WATER_INERTIA,
  TRIDENT_SPEED,
  TRIDENT_WATER_INERTIA,
} from './profile'

describe('projectile profile constants (1.21.1 javap)', () => {
  it('uses the mapped AbstractArrow gravity and water inertia', () => {
    expect(ARROW_GRAVITY).toBe(0.05)
    expect(PROJECTILE_AIR_INERTIA).toBe(0.99)
    expect(ARROW_WATER_INERTIA).toBe(0.6)
  })

  it('uses the mapped ThrownTrident and ThrowableProjectile fluid constants', () => {
    expect(TRIDENT_WATER_INERTIA).toBe(0.99)
    expect(THROWABLE_WATER_INERTIA).toBe(0.8)
    expect(SNOWBALL_GRAVITY).toBe(0.03)
    expect(POTION_GRAVITY).toBe(0.05)
  })

  it('uses the mapped launch speeds and spread', () => {
    expect(BOW_MAX_SPEED).toBe(3)
    expect(CROSSBOW_ARROW_SPEED).toBe(3.15)
    expect(CROSSBOW_FIREWORK_SPEED).toBe(1.6)
    expect(CROSSBOW_LOAD_TICKS).toBe(25)
    expect(TRIDENT_SPEED).toBe(2.5)
    expect(SNOWBALL_SPEED).toBe(1.5)
    expect(POTION_SPEED).toBe(0.5)
    expect(POTION_PITCH_OFFSET_DEG).toBe(-20)
    expect(LAUNCH_SPREAD_PER_AXIS).toBe(0.0172275)
    expect(ARROW_INACCURACY).toBe(1)
  })

  it('gives every profile a version and a source citation', () => {
    for (const profile of Object.values(PROJECTILE_PROFILES)) {
      expect(profile.version).toBe(PROFILE_VERSION)
      expect(profile.source.length).toBeGreaterThan(0)
    }
    expect(SOLUTION_REVISION).toBeGreaterThan(0)
  })
})

function profileIdOf(weapon: string, ammo?: string): string | undefined {
  const result = resolveWeaponProfile(weapon, ammo)
  return result.ok ? result.profile.id : undefined
}

describe('profile lookup', () => {
  it('returns a typed refusal for an unknown projectile instead of a default speed', () => {
    const result = resolveProjectileProfile('minecraft:potion')
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.reason).toBe('unsupported_projectile_profile')
  })

  it('resolves the ordinary weapon profiles', () => {
    expect(profileIdOf('bow')).toBe('bow-arrow')
    expect(profileIdOf('crossbow')).toBe('crossbow-arrow')
    expect(profileIdOf('trident')).toBe('trident')
  })

  it('separates special crossbow ammo from an ordinary arrow', () => {
    expect(profileIdOf('crossbow', 'minecraft:firework_rocket')).toBe('firework-rocket')
    expect(profileIdOf('crossbow', 'minecraft:spectral_arrow')).toBe('spectral-arrow')
    expect(profileIdOf('crossbow', 'minecraft:tipped_arrow')).toBe('tipped-arrow')
  })

  it('refuses an unknown projectile loaded in a supported launcher', () => {
    const result = resolveWeaponProfile('crossbow', 'minecraft:stick')
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.reason).toBe('unsupported_projectile_profile')
  })

  it('keeps the special projectiles as distinct impact profiles', () => {
    expect(PROJECTILE_PROFILES['firework-rocket'].impact.kind).toBe('area')
    expect(PROJECTILE_PROFILES['splash-potion'].impact.radius).toBe(4)
    expect(PROJECTILE_PROFILES['lingering-potion'].impact.radius).toBe(3)
    expect(PROJECTILE_PROFILES.snowball.gravity).toBe(SNOWBALL_GRAVITY)
  })
})

describe('charge to speed', () => {
  it('reproduces the vanilla bow power curve', () => {
    expect(bowPowerFraction(0)).toBe(0)
    expect(bowPowerFraction(20)).toBe(1)
    expect(bowPowerFraction(40)).toBe(1)
    const half = bowPowerFraction(10)
    expect(half).toBeCloseTo(5 / 12, 6)
  })

  it('scales the bow speed and refuses a release below the minimum power', () => {
    const profile = PROJECTILE_PROFILES['bow-arrow']
    expect(launchSpeed(profile, 20)).toBe(BOW_MAX_SPEED)
    expect(launchSpeed(profile, 10)).toBeCloseTo(BOW_MAX_SPEED * (5 / 12), 6)
    expect(launchSpeed(profile, 1)).toBeUndefined()
    expect(BOW_MIN_POWER).toBe(0.1)
  })

  it('requires the trident hold and accepts an immediate throw for the fixed projectiles', () => {
    expect(launchSpeed(PROJECTILE_PROFILES.trident, 9)).toBeUndefined()
    expect(launchSpeed(PROJECTILE_PROFILES.trident, 10)).toBe(TRIDENT_SPEED)
    expect(launchSpeed(PROJECTILE_PROFILES.snowball, 0)).toBe(SNOWBALL_SPEED)
    expect(fullChargeTicks(PROJECTILE_PROFILES['bow-arrow'])).toBe(20)
    expect(fullChargeTicks(PROJECTILE_PROFILES['crossbow-arrow'])).toBe(0)
  })
})

describe('launch position', () => {
  it('spawns 0.1 below the shooter eye', () => {
    const position = launchPositionFor(PROJECTILE_PROFILES['bow-arrow'], { x: 1, y: 65.62, z: -2 })
    expect(position.x).toBe(1)
    expect(position.y).toBeCloseTo(65.52, 6)
    expect(position.z).toBe(-2)
  })
})
