/**
 * Versioned projectile profiles (projectile-aiming design CD-B1/CD-B3).
 *
 * Every physical constant below comes from the 1.21.1 mapped classes. The
 * `javap -p -c` reading is named beside each value as `<class>#<method>`; no
 * value is taken from a wiki or from another version. A projectile that has no
 * profile here is never simulated with a guessed speed: {@link resolveProjectileProfile}
 * returns `unsupported_projectile_profile` instead.
 *
 * A profile describes the launch contract (spawn offset, charge to speed,
 * spread, shooter-velocity inheritance) and the per-tick update contract
 * (inertia, gravity, water behaviour, impact). The pure simulation lives in
 * {@link ./simulation}; the intercept solver lives in {@link ./intercept}.
 */
import type { Vec3 } from '../movement/types'

/** Minecraft version every constant in this module was extracted from. */
export const PROFILE_VERSION = '1.21.1'

/**
 * Revision of the solved trajectory model.
 *
 * A receipt records it so a caller can tell a re-verified release apart from a
 * solution computed against an older model. It changes only when the per-tick
 * update or the launch mapping changes.
 */
export const SOLUTION_REVISION = 1

export type ProjectileProfileId
  = | 'bow-arrow'
    | 'crossbow-arrow'
    | 'spectral-arrow'
    | 'tipped-arrow'
    | 'firework-rocket'
    | 'trident'
    | 'snowball'
    | 'splash-potion'
    | 'lingering-potion'

/** How much of the projectile model the solver may trust. */
export type SolverSupport = 'full' | 'initial-only' | 'unsupported'

/**
 * Per-axis launch spread factor.
 *
 * `Projectile#getMovementToShoot` adds `triangle(0, 0.0172275 * inaccuracy)` to
 * each axis of the normalized direction before it scales by the launch speed
 * (`ldc2_w 0.0172275d`). The triangle distribution is symmetric, so the pure
 * solve uses the mean direction and folds the spread into the box inflation.
 */
export const LAUNCH_SPREAD_PER_AXIS = 0.0172275

/** Gravity of every `AbstractArrow`, `AbstractArrow#getDefaultGravity`. */
export const ARROW_GRAVITY = 0.05
/** Air inertia shared by arrows and throwables, `AbstractArrow#tick` `0.99f`. */
export const PROJECTILE_AIR_INERTIA = 0.99
/** Arrow water inertia, `AbstractArrow#getWaterInertia` `0.6f`. */
export const ARROW_WATER_INERTIA = 0.6
/** Trident water inertia, `ThrownTrident#getWaterInertia` `0.99f`. */
export const TRIDENT_WATER_INERTIA = 0.99
/** Throwable water inertia, `ThrowableProjectile#tick` `0.8f`. */
export const THROWABLE_WATER_INERTIA = 0.8
/** Snowball gravity, `ThrowableProjectile#getDefaultGravity` `0.03d`. */
export const SNOWBALL_GRAVITY = 0.03
/** Potion gravity, `ThrownPotion#getDefaultGravity` `0.05d`. */
export const POTION_GRAVITY = 0.05
/** Spawn offset below the shooter's eye, `AbstractArrow` and `ThrowableProjectile` constructors `eyeY - 0.1`. */
export const SPAWN_OFFSET_Y = -0.1
/** Bow full draw duration, `BowItem#getUseDuration` divides by `20.0f`. */
export const BOW_FULL_CHARGE_TICKS = 20
/** Bow maximum launch speed, `BowItem#releaseUsing` `power * 3.0f`. */
export const BOW_MAX_SPEED = 3
/** Bow cannot release below this power, `BowItem#releaseUsing` compares to `0.1d`. */
export const BOW_MIN_POWER = 0.1
/** Crossbow arrow speed, `CrossbowItem#getShootingPower` `3.15f`. */
export const CROSSBOW_ARROW_SPEED = 3.15
/** Crossbow firework speed, `CrossbowItem#getShootingPower` `1.6f`. */
export const CROSSBOW_FIREWORK_SPEED = 1.6
/** Crossbow load duration, `CrossbowItem#getChargeDuration` `floor(1.25f * 20.0f)`. */
export const CROSSBOW_LOAD_TICKS = 25
/** Trident throw speed, `TridentItem#releaseUsing` `2.5f`. */
export const TRIDENT_SPEED = 2.5
/** Trident minimum hold, `TridentItem#releaseUsing` compares use time to `10`. */
export const TRIDENT_MIN_CHARGE_TICKS = 10
/** Snowball speed, `SnowballItem#use` `1.5f`. */
export const SNOWBALL_SPEED = 1.5
/** Potion speed, `ThrowablePotionItem#use` `0.5f`. */
export const POTION_SPEED = 0.5
/** Potion launch pitch offset, `ThrowablePotionItem#use` `-20.0f`. */
export const POTION_PITCH_OFFSET_DEG = -20
/** Splash potion effect radius, `ThrownPotion#applySplash` `inflate(4.0, 2.0, 4.0)`. */
export const SPLASH_POTION_RADIUS = 4
/** Lingering cloud radius, `ThrownPotion#makeAreaOfEffectCloud` `setRadius(3.0f)`. */
export const LINGERING_POTION_RADIUS = 3

/**
 * Fallback collision box for an observed entity whose box was not reported.
 *
 * NOTICE: a read may omit the box. A missing box is not proof the target is a
 * point, so the solver uses a player-sized box and still widens it by the
 * observation uncertainty. Remove this default when every target read carries
 * an explicit box.
 */
export const DEFAULT_TARGET_BOUNDS = { width: 0.6, height: 1.8 } as const

export const BOW_ARROW_ITEMS = ['minecraft:arrow', 'minecraft:tipped_arrow', 'minecraft:spectral_arrow']
export const CROSSBOW_PROJECTILE_ITEMS = ['minecraft:arrow', 'minecraft:tipped_arrow', 'minecraft:spectral_arrow', 'minecraft:firework_rocket']

/** Charge-to-speed mapping. `bow` follows the vanilla power curve; `fixed` is a throw/load. */
export type ProjectileCharge
  = | { kind: 'bow', fullChargeTicks: number, maxSpeed: number, minPower: number }
    | { kind: 'fixed', speed: number, minChargeTicks: number }

/** What a projectile does when it stops. The pure solver only needs this to stop the curve. */
export interface ProjectileImpact {
  kind: 'single' | 'area'
  /** Effect radius in blocks; 0 for a direct hit. */
  radius: number
  /** Non-physical effect the solver does not apply, recorded for the caller. */
  note?: string
}

/** Enchantment behaviour the solver either models or refuses. */
export interface ProjectileEnchantRules {
  /** Enchantments the launch and flight model already covers. */
  modelled: string[]
  /** Enchantments that add projectiles or change flight; the solver refuses them. */
  refused: string[]
}

export interface ProjectileProfile {
  id: ProjectileProfileId
  version: string
  projectileType: string
  launcherItem: string
  ammo: string[]
  charge: ProjectileCharge
  /** Spawn position is `shooter eye + (0, spawnOffsetY, 0)`. */
  spawnOffsetY: number
  /** Rotation added to the look angles, matching `Projectile#shootFromRotation`. */
  yawOffsetDeg: number
  pitchOffsetDeg: number
  /**
   * Inaccuracy passed to `shoot`/`shootFromRotation`; spread per axis is
   * `LAUNCH_SPREAD_PER_AXIS * launchInaccuracy`.
   */
  launchInaccuracy: number
  /** `shootFromRotation` adds the shooter's known movement; `shoot` alone does not. */
  inheritShooterVelocity: boolean
  gravity: number
  airInertia: number
  waterInertia: number
  impact: ProjectileImpact
  enchant: ProjectileEnchantRules
  solver: SolverSupport
  /** `class#method` the constants came from. */
  source: string
}

const REFUSED_ENCHANTS = ['minecraft:multishot', 'minecraft:piercing']
const MODELLED_ENCHANTS = ['minecraft:power', 'minecraft:quick_charge']

/** Arrow inaccuracy, `BowItem#releaseUsing` and `CrossbowItem#use` pass `1.0f`. */
export const ARROW_INACCURACY = 1

const ARROW_FLIGHT = {
  gravity: ARROW_GRAVITY,
  airInertia: PROJECTILE_AIR_INERTIA,
  waterInertia: ARROW_WATER_INERTIA,
  spawnOffsetY: SPAWN_OFFSET_Y,
  yawOffsetDeg: 0,
  pitchOffsetDeg: 0,
  launchInaccuracy: ARROW_INACCURACY,
} as const

export const PROJECTILE_PROFILES: Record<ProjectileProfileId, ProjectileProfile> = {
  'bow-arrow': {
    ...ARROW_FLIGHT,
    id: 'bow-arrow',
    version: PROFILE_VERSION,
    projectileType: 'minecraft:arrow',
    launcherItem: 'minecraft:bow',
    ammo: BOW_ARROW_ITEMS,
    charge: { kind: 'bow', fullChargeTicks: BOW_FULL_CHARGE_TICKS, maxSpeed: BOW_MAX_SPEED, minPower: BOW_MIN_POWER },
    // BowItem#shootProjectile calls Projectile#shootFromRotation, so the shot
    // inherits the shooter's movement.
    inheritShooterVelocity: true,
    impact: { kind: 'single', radius: 0 },
    enchant: { modelled: MODELLED_ENCHANTS, refused: REFUSED_ENCHANTS },
    solver: 'full',
    source: 'BowItem#releaseUsing/#getPowerForTime, Projectile#getMovementToShoot, AbstractArrow#tick',
  },
  'crossbow-arrow': {
    ...ARROW_FLIGHT,
    id: 'crossbow-arrow',
    version: PROFILE_VERSION,
    projectileType: 'minecraft:arrow',
    launcherItem: 'minecraft:crossbow',
    ammo: CROSSBOW_PROJECTILE_ITEMS,
    charge: { kind: 'fixed', speed: CROSSBOW_ARROW_SPEED, minChargeTicks: 0 },
    // CrossbowItem#shootProjectile calls Projectile#shoot directly, so a bolt
    // does not inherit the shooter's movement.
    inheritShooterVelocity: false,
    impact: { kind: 'single', radius: 0 },
    enchant: { modelled: MODELLED_ENCHANTS, refused: REFUSED_ENCHANTS },
    solver: 'full',
    source: 'CrossbowItem#getShootingPower/#shootProjectile, Projectile#shoot, AbstractArrow#tick',
  },
  'spectral-arrow': {
    ...ARROW_FLIGHT,
    id: 'spectral-arrow',
    version: PROFILE_VERSION,
    projectileType: 'minecraft:spectral_arrow',
    launcherItem: 'minecraft:bow',
    ammo: ['minecraft:spectral_arrow'],
    charge: { kind: 'bow', fullChargeTicks: BOW_FULL_CHARGE_TICKS, maxSpeed: BOW_MAX_SPEED, minPower: BOW_MIN_POWER },
    inheritShooterVelocity: true,
    impact: { kind: 'single', radius: 0, note: 'applies Glowing; the solver does not apply effects' },
    enchant: { modelled: MODELLED_ENCHANTS, refused: REFUSED_ENCHANTS },
    solver: 'full',
    source: 'SpectralArrow extends AbstractArrow; ArrowItem#createArrow, BowItem#releaseUsing',
  },
  'tipped-arrow': {
    ...ARROW_FLIGHT,
    id: 'tipped-arrow',
    version: PROFILE_VERSION,
    projectileType: 'minecraft:tipped_arrow',
    launcherItem: 'minecraft:bow',
    ammo: ['minecraft:tipped_arrow'],
    charge: { kind: 'bow', fullChargeTicks: BOW_FULL_CHARGE_TICKS, maxSpeed: BOW_MAX_SPEED, minPower: BOW_MIN_POWER },
    inheritShooterVelocity: true,
    impact: { kind: 'single', radius: 0, note: 'applies the arrow potion contents; the solver does not apply effects' },
    enchant: { modelled: MODELLED_ENCHANTS, refused: REFUSED_ENCHANTS },
    solver: 'full',
    source: 'Arrow with PotionContents; ArrowItem#createArrow, BowItem#releaseUsing',
  },
  'firework-rocket': {
    id: 'firework-rocket',
    version: PROFILE_VERSION,
    projectileType: 'minecraft:firework_rocket',
    launcherItem: 'minecraft:crossbow',
    ammo: ['minecraft:firework_rocket'],
    charge: { kind: 'fixed', speed: CROSSBOW_FIREWORK_SPEED, minChargeTicks: 0 },
    spawnOffsetY: SPAWN_OFFSET_Y,
    yawOffsetDeg: 0,
    pitchOffsetDeg: 0,
    launchInaccuracy: ARROW_INACCURACY,
    inheritShooterVelocity: false,
    gravity: POTION_GRAVITY,
    airInertia: PROJECTILE_AIR_INERTIA,
    waterInertia: PROJECTILE_AIR_INERTIA,
    impact: { kind: 'area', radius: 3, note: 'firework explosion; damage and knockback are not modelled' },
    enchant: { modelled: MODELLED_ENCHANTS, refused: REFUSED_ENCHANTS },
    // FireworkRocketEntity#tick accelerates the rocket after launch. That thrust
    // is not in the initial ballistic model, so the solver only predicts the
    // initial arc and marks the result initial-only.
    solver: 'initial-only',
    source: 'CrossbowItem#getShootingPower (firework 1.6f), FireworkRocketEntity#tick',
  },
  'trident': {
    id: 'trident',
    version: PROFILE_VERSION,
    projectileType: 'minecraft:trident',
    launcherItem: 'minecraft:trident',
    ammo: ['minecraft:trident'],
    charge: { kind: 'fixed', speed: TRIDENT_SPEED, minChargeTicks: TRIDENT_MIN_CHARGE_TICKS },
    spawnOffsetY: SPAWN_OFFSET_Y,
    yawOffsetDeg: 0,
    pitchOffsetDeg: 0,
    launchInaccuracy: ARROW_INACCURACY,
    inheritShooterVelocity: true,
    gravity: ARROW_GRAVITY,
    airInertia: PROJECTILE_AIR_INERTIA,
    waterInertia: TRIDENT_WATER_INERTIA,
    impact: { kind: 'single', radius: 0, note: 'loyalty return is not part of the ballistic solution' },
    enchant: { modelled: MODELLED_ENCHANTS, refused: REFUSED_ENCHANTS },
    solver: 'full',
    source: 'TridentItem#releaseUsing, ThrownTrident#getWaterInertia, AbstractArrow#tick',
  },
  'snowball': {
    id: 'snowball',
    version: PROFILE_VERSION,
    projectileType: 'minecraft:snowball',
    launcherItem: 'minecraft:snowball',
    ammo: ['minecraft:snowball'],
    charge: { kind: 'fixed', speed: SNOWBALL_SPEED, minChargeTicks: 0 },
    spawnOffsetY: SPAWN_OFFSET_Y,
    yawOffsetDeg: 0,
    pitchOffsetDeg: 0,
    launchInaccuracy: ARROW_INACCURACY,
    inheritShooterVelocity: true,
    gravity: SNOWBALL_GRAVITY,
    airInertia: PROJECTILE_AIR_INERTIA,
    waterInertia: THROWABLE_WATER_INERTIA,
    impact: { kind: 'single', radius: 0, note: 'knockback only; no damage is modelled' },
    enchant: { modelled: [], refused: [] },
    solver: 'full',
    source: 'SnowballItem#use, ThrowableProjectile#getDefaultGravity/#tick',
  },
  'splash-potion': {
    id: 'splash-potion',
    version: PROFILE_VERSION,
    projectileType: 'minecraft:splash_potion',
    launcherItem: 'minecraft:splash_potion',
    ammo: ['minecraft:splash_potion'],
    charge: { kind: 'fixed', speed: POTION_SPEED, minChargeTicks: 0 },
    spawnOffsetY: SPAWN_OFFSET_Y,
    yawOffsetDeg: 0,
    pitchOffsetDeg: POTION_PITCH_OFFSET_DEG,
    launchInaccuracy: ARROW_INACCURACY,
    inheritShooterVelocity: true,
    gravity: POTION_GRAVITY,
    airInertia: PROJECTILE_AIR_INERTIA,
    waterInertia: THROWABLE_WATER_INERTIA,
    impact: { kind: 'area', radius: SPLASH_POTION_RADIUS, note: 'splash effects are not applied by the solver' },
    enchant: { modelled: [], refused: [] },
    solver: 'full',
    source: 'ThrowablePotionItem#use, ThrownPotion#getDefaultGravity/#applySplash',
  },
  'lingering-potion': {
    id: 'lingering-potion',
    version: PROFILE_VERSION,
    projectileType: 'minecraft:lingering_potion',
    launcherItem: 'minecraft:lingering_potion',
    ammo: ['minecraft:lingering_potion'],
    charge: { kind: 'fixed', speed: POTION_SPEED, minChargeTicks: 0 },
    spawnOffsetY: SPAWN_OFFSET_Y,
    yawOffsetDeg: 0,
    pitchOffsetDeg: POTION_PITCH_OFFSET_DEG,
    launchInaccuracy: ARROW_INACCURACY,
    inheritShooterVelocity: true,
    gravity: POTION_GRAVITY,
    airInertia: PROJECTILE_AIR_INERTIA,
    waterInertia: THROWABLE_WATER_INERTIA,
    impact: { kind: 'area', radius: LINGERING_POTION_RADIUS, note: 'area effect cloud is not created by the solver' },
    enchant: { modelled: [], refused: [] },
    solver: 'full',
    source: 'ThrowablePotionItem#use, ThrownPotion#getDefaultGravity/#makeAreaOfEffectCloud',
  },
}

/** Result of a profile lookup. An unknown projectile is a typed refusal, not a default speed. */
export type ProfileResolution
  = | { ok: true, profile: ProjectileProfile }
    | { ok: false, reason: 'unsupported_projectile_profile', requested: string }

/**
 * Resolves a projectile profile by id.
 *
 * @example
 * resolveProjectileProfile('bow-arrow').ok
 * // => true
 */
export function resolveProjectileProfile(id: string): ProfileResolution {
  const profile = PROJECTILE_PROFILES[id as ProjectileProfileId]
  if (profile)
    return { ok: true, profile }
  return { ok: false, reason: 'unsupported_projectile_profile', requested: id }
}

/**
 * Resolves the profile for a selected weapon and, when known, its ammo.
 *
 * The default ammo is the ordinary arrow; a caller that knows the loaded stack
 * can name it to get the special profile. An unknown ammo is not silently
 * treated as an arrow when it names another item.
 *
 * @example
 * resolveWeaponProfile('crossbow', 'minecraft:firework_rocket').map(p => p.id)
 * // => 'firework-rocket'
 */
export function resolveWeaponProfile(weapon: string, ammoItemId?: string): ProfileResolution {
  const key = `${weapon}+${ammoItemId ?? ''}`
  switch (key) {
    case 'bow+minecraft:spectral_arrow':
      return { ok: true, profile: PROJECTILE_PROFILES['spectral-arrow'] }
    case 'bow+minecraft:tipped_arrow':
      return { ok: true, profile: PROJECTILE_PROFILES['tipped-arrow'] }
    case 'crossbow+minecraft:spectral_arrow':
      return { ok: true, profile: PROJECTILE_PROFILES['spectral-arrow'] }
    case 'crossbow+minecraft:tipped_arrow':
      return { ok: true, profile: PROJECTILE_PROFILES['tipped-arrow'] }
    case 'crossbow+minecraft:firework_rocket':
      return { ok: true, profile: PROJECTILE_PROFILES['firework-rocket'] }
    default:
      break
  }
  if (ammoItemId && !CROSSBOW_PROJECTILE_ITEMS.includes(ammoItemId) && weapon === 'crossbow')
    return { ok: false, reason: 'unsupported_projectile_profile', requested: ammoItemId }
  if (ammoItemId && !BOW_ARROW_ITEMS.includes(ammoItemId) && weapon === 'bow')
    return { ok: false, reason: 'unsupported_projectile_profile', requested: ammoItemId }
  switch (weapon) {
    case 'bow':
      return { ok: true, profile: PROJECTILE_PROFILES['bow-arrow'] }
    case 'crossbow':
      return { ok: true, profile: PROJECTILE_PROFILES['crossbow-arrow'] }
    case 'trident':
      return { ok: true, profile: PROJECTILE_PROFILES.trident }
    default:
      return { ok: false, reason: 'unsupported_projectile_profile', requested: weapon }
  }
}

/**
 * Vanilla bow power fraction for a draw time.
 *
 * `BowItem#getPowerForTime`: `f = ticks / 20; f = (f * f + 2f) / 3; f = min(f, 1)`.
 *
 * @example
 * bowPowerFraction(20)
 * // => 1
 */
export function bowPowerFraction(chargeTicks: number): number {
  const ratio = Math.max(0, chargeTicks) / BOW_FULL_CHARGE_TICKS
  const power = (ratio * ratio + 2 * ratio) / 3
  return power > 1 ? 1 : power
}

/**
 * Absolute launch speed for one charge, or undefined when the weapon cannot
 * release yet (a partial bow draw below the minimum power, a trident held for
 * less than the throw threshold).
 *
 * @example
 * launchSpeed(PROJECTILE_PROFILES['bow-arrow'], 20)
 * // => 3
 */
export function launchSpeed(profile: ProjectileProfile, chargeTicks: number): number | undefined {
  if (profile.charge.kind === 'bow') {
    const power = bowPowerFraction(chargeTicks)
    if (power < profile.charge.minPower)
      return undefined
    return power * profile.charge.maxSpeed
  }
  if (chargeTicks < profile.charge.minChargeTicks)
    return undefined
  return profile.charge.speed
}

/** Ticks a full charge needs for this profile's launcher. */
export function fullChargeTicks(profile: ProjectileProfile): number {
  return profile.charge.kind === 'bow' ? profile.charge.fullChargeTicks : profile.charge.minChargeTicks
}

/**
 * Where a projectile spawns for a shooter eye position.
 *
 * @example
 * launchPositionFor(PROJECTILE_PROFILES['bow-arrow'], { x: 0, y: 65.62, z: 0 })
 * // => { x: 0, y: 65.52, z: 0 }
 */
export function launchPositionFor(profile: ProjectileProfile, eye: Vec3): Vec3 {
  return { x: eye.x, y: eye.y + profile.spawnOffsetY, z: eye.z }
}
