/**
 * Air spacing, lagged following and rendezvous policy (air-follow design §4, CD-F2).
 *
 * The follower must not occupy the target's collision box, so it follows a
 * lagged point on the target's recent path plus a lateral offset. The offset is
 * derived from a smoothed tangent: when the target is slow or turns sharply the
 * previous tangent is held, so the offset does not flip sides.
 *
 * The module is pure. It keeps a short history of target samples and answers
 * three questions: where to aim, how strong the pursuit may be, and where a
 * bounded rendezvous area sits when the follower is far behind.
 */
import type { Vec3 } from './types'

/** Ticks per second, used to turn vanilla motion into blocks per second. */
const TICKS_PER_SECOND = 20
/** Default spacing band in blocks; a debug starting value, not a guarantee. */
export const DEFAULT_AIR_SPACING_BAND = { min: 12, max: 24 } as const
/** Default lag between the target's actual path and the followed point. */
export const DEFAULT_AIR_LAG_MS = 1500
/** Default lateral offset, in blocks, to avoid the same collision box. */
export const DEFAULT_AIR_LATERAL_OFFSET = 2
/** Below this speed the tangent is held instead of recomputed, blocks/tick. */
export const DEFAULT_MIN_TANGENT_SPEED = 0.05
/** Turn beyond this is smoothed instead of followed immediately, degrees. */
export const MAX_TANGENT_TURN_DEG = 35
/** Longest rendezvous prediction horizon, ms. */
export const RENDEZVOUS_MAX_HORIZON_MS = 4000
/** Sample age past which the rendezvous horizon is cut short, ms. */
export const RENDEZVOUS_FRESH_MS = 1500
/** Retained target samples. */
export const AIR_SPACING_MAX_SAMPLES = 60

export interface AirSpacingBand {
  min: number
  max: number
}

/** One target sample the spacing policy keeps. `velocity` is blocks per tick. */
export interface AirSpacingSample {
  at: number
  position: Vec3
  velocity?: Vec3
}

/** Where the follower should aim, and the tangent the offset was built from. */
export interface AirSpacingAim {
  point: Vec3
  tangent: { x: number, z: number }
  /** Target speed at the aimed sample, blocks per tick. */
  speed: number
  /** `lag` when a recent sample existed; `hold` when only the tangent was kept. */
  source: 'lag' | 'hold'
}

export interface AirSpacingOptions {
  band?: Partial<AirSpacingBand>
  lagMs?: number
  lateralOffset?: number
  minTangentSpeed?: number
  maxSamples?: number
  /** Age window beyond which a history sample is dropped, ms. */
  maxAgeMs?: number
}

export interface RendezvousInput {
  self: Vec3
  history: readonly AirSpacingSample[]
  now: number
  band: AirSpacingBand
  /** Age of the newest target sample in ms. */
  targetAgeMs: number
  /** Newest target speed in blocks per tick. */
  targetSpeed: number
  /** Optional explicit horizon cap, ms. */
  maxHorizonMs?: number
}

export interface RendezvousPlan {
  point: Vec3
  horizonMs: number
  /** True when age or maneuver strength shortened the horizon. */
  bounded: boolean
}

function speedOf(velocity: Vec3 | undefined): number {
  return velocity ? Math.hypot(velocity.x, velocity.y, velocity.z) : 0
}

function tangentOf(from: Vec3, to: Vec3): { x: number, z: number } | undefined {
  const dx = to.x - from.x
  const dz = to.z - from.z
  const length = Math.hypot(dx, dz)
  if (length < 1e-6)
    return undefined
  return { x: dx / length, z: dz / length }
}

function blendDirection(
  previous: { x: number, z: number },
  next: { x: number, z: number },
  maxTurnDeg: number,
): { x: number, z: number } {
  const previousAngle = Math.atan2(previous.z, previous.x)
  const nextAngle = Math.atan2(next.z, next.x)
  let delta = nextAngle - previousAngle
  while (delta > Math.PI) delta -= 2 * Math.PI
  while (delta < -Math.PI) delta += 2 * Math.PI
  const maxTurn = maxTurnDeg * Math.PI / 180
  const applied = Math.max(-maxTurn, Math.min(maxTurn, delta))
  const angle = previousAngle + applied
  return { x: Math.cos(angle), z: Math.sin(angle) }
}

/**
 * Creates the air spacing policy.
 *
 * @example
 * const spacing = createAirSpacingPolicy()
 * spacing.push({ at: 0, position: { x: 0, y: 0, z: 0 } })
 * spacing.classify(18)
 * // => 'band'
 */
export function createAirSpacingPolicy(options: AirSpacingOptions = {}) {
  const band: AirSpacingBand = {
    min: options.band?.min ?? DEFAULT_AIR_SPACING_BAND.min,
    max: options.band?.max ?? DEFAULT_AIR_SPACING_BAND.max,
  }
  const lagMs = options.lagMs ?? DEFAULT_AIR_LAG_MS
  const lateralOffset = options.lateralOffset ?? DEFAULT_AIR_LATERAL_OFFSET
  const minTangentSpeed = options.minTangentSpeed ?? DEFAULT_MIN_TANGENT_SPEED
  const maxSamples = options.maxSamples ?? AIR_SPACING_MAX_SAMPLES
  const maxAgeMs = options.maxAgeMs ?? 10_000

  let samples: AirSpacingSample[] = []
  let tangent: { x: number, z: number } | undefined
  let lateralSign: 1 | -1 | undefined

  function push(sample: AirSpacingSample): void {
    const previous = samples[samples.length - 1]
    if (previous && sample.at < previous.at)
      return
    samples.push(sample)
    if (samples.length > maxSamples)
      samples = samples.slice(samples.length - maxSamples)
  }

  function laggedSample(now: number): AirSpacingSample | undefined {
    if (samples.length === 0)
      return undefined
    const newest = samples[samples.length - 1]!
    const cutoff = now - lagMs
    // The oldest sample that is still newer than the lag cutoff is the closest
    // point to the desired lag; when every sample is older, the oldest one is
    // the best available approximation.
    let candidate = samples[0]!
    for (const sample of samples) {
      if (sample.at <= cutoff)
        candidate = sample
      else
        break
    }
    if (candidate.at > newest.at)
      return newest
    return candidate
  }

  function computeTangent(): { x: number, z: number } | undefined {
    if (samples.length < 2)
      return tangent
    const newest = samples[samples.length - 1]!
    // Average over a short recent window so one noisy sample cannot flip the
    // tangent, and skip samples separated by a teleport-sized jump.
    const recent = samples.filter(sample => newest.at - sample.at <= 1000)
    if (recent.length >= 2) {
      const first = recent[0]!
      const direction = tangentOf(first.position, newest.position)
      if (direction)
        return direction
    }
    return tangent
  }

  function updateTangent(): { x: number, z: number } | undefined {
    const newest = samples[samples.length - 1]
    if (!newest)
      return tangent
    const speed = speedOf(newest.velocity)
    const next = computeTangent()
    if (!next)
      return tangent
    if (!tangent) {
      tangent = next
      return tangent
    }
    // Slow or sharply turning targets keep the previous tangent: the lateral
    // side must not flip while the follower is still crossing the old offset.
    if (speed < minTangentSpeed)
      return tangent
    tangent = blendDirection(tangent, next, MAX_TANGENT_TURN_DEG)
    return tangent
  }

  function signFor(self: Vec3, point: Vec3, direction: { x: number, z: number }): 1 | -1 {
    // Perpendicular of the tangent. The sign is chosen so the follower sits on
    // the side it already occupies; a genuine reversal flips it.
    const perp = { x: direction.z, z: -direction.x }
    const toSelfX = self.x - point.x
    const toSelfZ = self.z - point.z
    const side = perp.x * toSelfX + perp.z * toSelfZ
    if (lateralSign === undefined) {
      lateralSign = side >= 0 ? 1 : -1
      return lateralSign
    }
    const reversed = direction.x * tangent!.x + direction.z * tangent!.z < 0
    if (reversed || Math.abs(side) < 1e-6)
      lateralSign = side >= 0 ? 1 : -1
    return lateralSign
  }

  return {
    push,
    samples: () => samples,
    band: () => band,

    /** Newest target speed in blocks per tick. */
    speed: () => speedOf(samples[samples.length - 1]?.velocity),

    /** Classifies a horizontal distance against the spacing band. */
    classify: (distance: number): 'near' | 'band' | 'far' => {
      if (distance < band.min)
        return 'near'
      if (distance > band.max)
        return 'far'
      return 'band'
    },

    /**
     * Pursuit strength in `[0, 1]`.
     *
     * Inside the band the strength is zero: entering the band only removes the
     * chase, it never triggers a landing (design §4).
     */
    pursuitStrength: (distance: number): number => {
      if (distance <= band.min)
        return 0
      if (distance >= band.max)
        return 1
      return (distance - band.min) / (band.max - band.min)
    },

    /** True when the newest sample is older than its freshness window. */
    isStale: (now: number, maxAge = 500): boolean => {
      const newest = samples[samples.length - 1]
      return !newest || now - newest.at > maxAge
    },

    /**
     * Aim point for the follower: the lagged target position plus a stable
     * lateral offset. Returns undefined before any sample exists.
     */
    aimAt: (now: number, self: Vec3): AirSpacingAim | undefined => {
      const lagged = laggedSample(now)
      if (!lagged)
        return undefined
      const direction = updateTangent()
      if (!direction)
        return { point: { ...lagged.position }, tangent: { x: 0, z: 1 }, speed: speedOf(lagged.velocity), source: 'lag' }
      const sign = signFor(self, lagged.position, direction)
      const perp = { x: direction.z * sign, z: -direction.x * sign }
      return {
        point: {
          x: lagged.position.x + perp.x * lateralOffset,
          y: lagged.position.y,
          z: lagged.position.z + perp.z * lateralOffset,
        },
        tangent: direction,
        speed: speedOf(lagged.velocity),
        source: 'lag',
      }
    },

    /** Drops samples older than `maxAgeMs` relative to `now`. */
    prune: (now: number): void => {
      samples = samples.filter(sample => now - sample.at <= maxAgeMs)
    },

    clear: (): void => {
      samples = []
      tangent = undefined
      lateralSign = undefined
    },
  }
}

export type AirSpacingPolicy = ReturnType<typeof createAirSpacingPolicy>

/**
 * Plans a bounded rendezvous point when the follower is far behind.
 *
 * The horizon is limited by the sample age and the target's maneuver strength,
 * so a stale or violently turning target is not extrapolated far. The aim point
 * sits `band.max` blocks in front of the follower on the line to the predicted
 * position, so it can be reached instead of copying the target's exact gap.
 *
 * @example
 * planRendezvous({ self, history, now, band, targetAgeMs: 100, targetSpeed: 0.3 })?.bounded
 * // => false
 */
export function planRendezvous(input: RendezvousInput): RendezvousPlan | undefined {
  const newest = input.history[input.history.length - 1]
  if (!newest)
    return undefined
  const age = Math.max(0, input.targetAgeMs)
  // A fast target may maneuver quickly, so its horizon shrinks further than a
  // slow one's. This is the maneuver-strength bound, not a fixed distance.
  const maneuverBudgetMs = RENDEZVOUS_FRESH_MS * (1 - Math.min(1, input.targetSpeed))
  const requested = input.maxHorizonMs ?? RENDEZVOUS_MAX_HORIZON_MS
  const allowed = Math.min(requested, maneuverBudgetMs - age)
  const horizonMs = Math.max(0, Math.min(requested, allowed))
  const bounded = horizonMs < requested

  const velocity = newest.velocity ?? { x: 0, y: 0, z: 0 }
  const ticks = horizonMs / 1000 * TICKS_PER_SECOND
  const predicted = {
    x: newest.position.x + velocity.x * ticks,
    y: newest.position.y + velocity.y * ticks,
    z: newest.position.z + velocity.z * ticks,
  }
  const towards = tangentOf(input.self, predicted)
  if (!towards)
    return { point: predicted, horizonMs, bounded }
  const point = {
    x: predicted.x - towards.x * input.band.max,
    y: predicted.y,
    z: predicted.z - towards.z * input.band.max,
  }
  return { point, horizonMs, bounded }
}

/** One axis-aligned coarse region a corridor is made of. */
export interface AirCorridorRegion {
  min: Vec3
  max: Vec3
}

/**
 * The flight corridor split by role (elytra-navigation design §3, air-follow §4).
 *
 * `track` is the region where the follower may hold station. Entering the
 * spacing band there only reduces pursuit strength; it never triggers a landing.
 */
export interface AirFollowCorridor {
  transit: AirCorridorRegion[]
  track: AirCorridorRegion[]
  landing: AirCorridorRegion[]
}

/** Which corridor role a point falls in; the most specific role wins. */
export type AirCorridorRole = 'transit' | 'track' | 'landing' | 'outside'

function inRegion(point: Vec3, region: AirCorridorRegion): boolean {
  return point.x >= region.min.x && point.x <= region.max.x
    && point.y >= region.min.y && point.y <= region.max.y
    && point.z >= region.min.z && point.z <= region.max.z
}

/**
 * Resolves the corridor role of a point.
 *
 * `landing` outranks `track`, which outranks `transit`, so an overlapping
 * region cannot downgrade a landing area into a transit area.
 *
 * @example
 * corridorRoleOf(corridor, { x: 1, y: 2, z: 3 })
 * // => 'outside'
 */
export function corridorRoleOf(corridor: AirFollowCorridor, point: Vec3): AirCorridorRole {
  if (corridor.landing.some(region => inRegion(point, region)))
    return 'landing'
  if (corridor.track.some(region => inRegion(point, region)))
    return 'track'
  if (corridor.transit.some(region => inRegion(point, region)))
    return 'transit'
  return 'outside'
}

/**
 * Whether the corridor role permits an automatic landing at this distance.
 *
 * A `track` region never lands just because the band was entered; only the
 * explicit `land` intent or an absent reachable site may do that (design §4).
 */
export function corridorAllowsAutoLand(role: AirCorridorRole): boolean {
  return role === 'landing'
}

/**
 * One versioned main-process update to a flight session (design §5).
 *
 * The session id, the fixed target uuid and the monotonic revision are the
 * isolation keys: a late update with an older revision is dropped and never
 * starts a second write command.
 */
export interface AirFollowUpdate {
  sessionId: string
  targetUuid: string
  revision: number
  validUntilTick: number
  phase: string
}

/**
 * True when `incoming` may replace `current`.
 *
 * An update is dropped when its session or target differs, its revision is not
 * newer, or its client-tick lease already expired.
 *
 * @example
 * acceptAirFollowUpdate(undefined, update, 0)
 * // => true
 */
export function acceptAirFollowUpdate(
  current: AirFollowUpdate | undefined,
  incoming: AirFollowUpdate,
  nowTick: number,
): boolean {
  if (incoming.validUntilTick < nowTick)
    return false
  if (!current)
    return true
  if (current.sessionId !== incoming.sessionId || current.targetUuid !== incoming.targetUuid)
    return false
  return incoming.revision > current.revision
}
