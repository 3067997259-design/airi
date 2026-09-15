/**
 * Moving-target intercept solver (projectile-aiming design CD-B2).
 *
 * The solver predicts the target over a short horizon, builds candidate
 * yaw/pitch pairs from the direct aim and an approximate parabola, simulates
 * each candidate with the pure model from {@link ./simulation}, and finds the
 * earliest intersection with the target's moving box. The chosen curve is then
 * re-checked against friendly entities and terrain before it is returned, so a
 * single trajectory decides both the hit and the safety check.
 *
 * Flight time comes from the simulated intersection, never from
 * `distance / fixedSpeed`. When no candidate reaches the target inside the
 * budget the solver returns `no_ballistic_solution` and the caller keeps the
 * ammo. The solver never spawns a projectile.
 */
import type { TargetObservation, TriState } from '../movement/target-observation'
import type { Vec3 } from '../movement/types'
import type { ProjectileProfile } from './profile'
import type { Trajectory, TrajectorySample } from './simulation'

import { DEFAULT_TARGET_BOUNDS, LAUNCH_SPREAD_PER_AXIS, launchPositionFor, launchSpeed, SOLUTION_REVISION } from './profile'
import { simulateProjectile } from './simulation'

/** Axis-aligned box in world coordinates. */
export interface Aabb {
  min: Vec3
  max: Vec3
}

/** A target whose position and velocity were observed once. */
export interface TargetTrack {
  targetUuid: string
  /** Feet position (the vanilla entity position). */
  position: Vec3
  velocity?: Vec3
  bounds: { width: number, height: number }
  onGround: TriState
  /** Observation age in milliseconds; folded into the inflation. */
  ageMs: number
  /** Position uncertainty in blocks from the observation contract. */
  positionUncertainty: number
}

/** Another entity that must not be hit (a friendly or a bystander). */
export interface FloatingEntityTrack {
  uuid: string
  position: Vec3
  velocity?: Vec3
  bounds: { width: number, height: number }
}

export interface BallisticRequest {
  profile: ProjectileProfile
  launchPosition: Vec3
  /** Absolute launch speed in blocks/tick. */
  speed: number
  shooterVelocity?: Vec3
  shooterOnGround?: boolean
  target: TargetTrack
  /** Entities that must not be shot; the target and own uuid are the caller's to filter. */
  friendlies?: FloatingEntityTrack[]
  /**
   * Terrain test for a cell the curve passes through. `'unknown'` counts as
   * blocking so an uncovered read never becomes clear air (CD-0 D10).
   */
  isObstacle?: (cell: Vec3) => boolean | 'unknown'
  /** Extra inflation in blocks for latency, target age and spread. */
  spreadUncertainty?: number
  maxTicks?: number
}

export type BallisticRefusalReason
  = | 'unsupported_projectile_profile'
    | 'no_ballistic_solution'
    | 'friendly_blocked'
    | 'target_unobserved'
    | 'insufficient_charge'

/** A solved curve ready to be handed to the release path. */
export interface BallisticSolution {
  profileId: string
  version: string
  solutionRevision: number
  /** Look angles in Minecraft convention. */
  yaw: number
  pitch: number
  arc: 'low' | 'high'
  /** Tick index of the predicted intersection; absent for a closest-approach result. */
  hitTick?: number
  predictedFlightTicks: number
  /** Smallest distance from the curve to the target box, in blocks. */
  closestDistance: number
  /** Target position predicted at the hit tick (or the closest tick). */
  predictedTarget: Vec3
  trajectory: Trajectory
}

export type BallisticPlan
  = | { ok: true, solution: BallisticSolution, observationAgeMs: number }
    | { ok: false, reason: BallisticRefusalReason, detail?: string }

const DEFAULT_MAX_TICKS = 160
const COARSE_PITCH_STEP = 5
const COARSE_YAW_OFFSETS = [-10, 0, 10] as const
const REFINE_PITCH_OFFSETS = [-4, -3, -2, -1, 0, 1, 2, 3, 4] as const
const REFINE_YAW_OFFSETS = [-3, -2, -1, 0, 1, 2, 3] as const
const FINE_PITCH_OFFSETS = [-0.5, -0.25, 0, 0.25, 0.5] as const
const COARSE_PITCH_MIN = -80
const COARSE_PITCH_MAX = 80

function addScaled(position: Vec3, velocity: Vec3 | undefined, tick: number): Vec3 {
  if (!velocity)
    return { ...position }
  return {
    x: position.x + velocity.x * tick,
    y: position.y,
    z: position.z + velocity.z * tick,
  }
}

/**
 * Predicts a target position at a tick offset.
 *
 * The base model is short uniform motion. A grounded target keeps its observed
 * Y (terrain constraint); an airborne target moves along its observed velocity
 * without a full player path prediction (design §4).
 *
 * @example
 * predictTargetPosition({ targetUuid: 'u', position: { x: 0, y: 64, z: 0 }, velocity: { x: 0.2, y: 0, z: 0 }, bounds: DEFAULT_TARGET_BOUNDS, onGround: true, ageMs: 0, positionUncertainty: 0.25 }, 5).x
 * // => 1
 */
export function predictTargetPosition(track: TargetTrack, tick: number): Vec3 {
  const base = addScaled(track.position, track.velocity, tick)
  if (!track.velocity)
    return base
  const y = track.onGround === true ? track.position.y : track.position.y + track.velocity.y * tick
  return { x: base.x, y, z: base.z }
}

function aabbAt(position: Vec3, bounds: { width: number, height: number }, inflation: number): Aabb {
  const half = bounds.width / 2 + inflation
  return {
    min: { x: position.x - half, y: position.y - inflation, z: position.z - half },
    max: { x: position.x + half, y: position.y + bounds.height + inflation, z: position.z + half },
  }
}

/** Target box at a tick, inflated by the per-tick spread/latency budget. */
export function targetAabbAt(track: TargetTrack, tick: number, inflation: number): Aabb {
  return aabbAt(predictTargetPosition(track, tick), track.bounds, inflation)
}

/** Friendly box at a tick, inflated by the per-tick spread/latency budget. */
export function floatingAabbAt(entity: FloatingEntityTrack, tick: number, inflation: number): Aabb {
  const position = addScaled(entity.position, entity.velocity, tick)
  if (!entity.velocity)
    return aabbAt(position, entity.bounds, inflation)
  const y = entity.position.y + entity.velocity.y * tick
  return aabbAt({ x: position.x, y, z: position.z }, entity.bounds, inflation)
}

/**
 * Segment/AABB overlap by the slab method.
 *
 * The projectile is treated as a point and the box as its obstacle, which is
 * exact enough for the block and entity sweeps the design requires. A zero
 * direction component on an axis outside the slab rejects immediately.
 *
 * @example
 * segmentIntersectsAabb({ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, { min: { x: 1, y: -1, z: -1 }, max: { x: 1.5, y: 1, z: 1 } })
 * // => true
 */
export function segmentIntersectsAabb(from: Vec3, to: Vec3, box: Aabb): boolean {
  const axes = ['x', 'y', 'z'] as const
  let tMin = 0
  let tMax = 1
  for (const axis of axes) {
    const start = from[axis]
    const delta = to[axis] - start
    const min = box.min[axis]
    const max = box.max[axis]
    if (delta === 0) {
      if (start < min || start > max)
        return false
      continue
    }
    const inverse = 1 / delta
    let near = (min - start) * inverse
    let far = (max - start) * inverse
    if (near > far)
      [near, far] = [far, near]
    tMin = near > tMin ? near : tMin
    tMax = far < tMax ? far : tMax
    if (tMin > tMax)
      return false
  }
  return true
}

/** Distance from a point to a box; zero when the point is inside. */
export function pointAabbDistance(point: Vec3, box: Aabb): number {
  const dx = Math.max(box.min.x - point.x, 0, point.x - box.max.x)
  const dy = Math.max(box.min.y - point.y, 0, point.y - box.max.y)
  const dz = Math.max(box.min.z - point.z, 0, point.z - box.max.z)
  return Math.hypot(dx, dy, dz)
}

export interface TargetIntersection {
  hitTick?: number
  closestTick: number
  closestDistance: number
}

/**
 * Earliest tick whose segment enters the target box.
 *
 * Each tick's segment is tested against the target box at that tick, so a
 * moving target is not reduced to a single sample point.
 */
export function findTargetIntersection(samples: TrajectorySample[], track: TargetTrack, spreadPerTick: number, baseInflation = 0): TargetIntersection {
  let closestTick = 0
  let closestDistance = Number.POSITIVE_INFINITY
  for (let index = 1; index < samples.length; index++) {
    const previous = samples[index - 1]
    const current = samples[index]
    const inflation = baseInflation + spreadPerTick * current.tick
    const box = targetAabbAt(track, current.tick, inflation)
    const distance = pointAabbDistance(current.position, box)
    if (distance < closestDistance) {
      closestDistance = distance
      closestTick = current.tick
    }
    if (segmentIntersectsAabb(previous.position, current.position, box))
      return { hitTick: current.tick, closestTick: current.tick, closestDistance: 0 }
  }
  return { closestTick, closestDistance }
}

/** Earliest tick where the curve enters a blocking cell; every entered cell is visited. */
export function firstObstacleTick(samples: TrajectorySample[], isBlocking: (cell: Vec3) => boolean): number | undefined {
  for (let index = 1; index < samples.length; index++) {
    if (segmentBlocked(samples[index - 1].position, samples[index].position, isBlocking))
      return samples[index].tick
  }
  return undefined
}

function segmentBlocked(from: Vec3, to: Vec3, isBlocking: (cell: Vec3) => boolean): boolean {
  // Amanatides-Woo voxel traversal: every cell the segment enters is visited,
  // so a thin one-block wall cannot slip between sample points.
  let x = Math.floor(from.x)
  let y = Math.floor(from.y)
  let z = Math.floor(from.z)
  if (isBlocking({ x, y, z }))
    return true
  const dx = to.x - from.x
  const dy = to.y - from.y
  const dz = to.z - from.z
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0
  const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0
  const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Number.POSITIVE_INFINITY
  const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Number.POSITIVE_INFINITY
  const tDeltaZ = dz !== 0 ? Math.abs(1 / dz) : Number.POSITIVE_INFINITY
  let tMaxX = stepX !== 0 ? (stepX > 0 ? x + 1 - from.x : from.x - x) * tDeltaX : Number.POSITIVE_INFINITY
  let tMaxY = stepY !== 0 ? (stepY > 0 ? y + 1 - from.y : from.y - y) * tDeltaY : Number.POSITIVE_INFINITY
  let tMaxZ = stepZ !== 0 ? (stepZ > 0 ? z + 1 - from.z : from.z - z) * tDeltaZ : Number.POSITIVE_INFINITY
  for (let guard = 0; guard < 1024; guard++) {
    const t = Math.min(tMaxX, tMaxY, tMaxZ)
    if (!(t <= 1))
      return false
    if (t === tMaxX) {
      x += stepX
      tMaxX += tDeltaX
    }
    else if (t === tMaxY) {
      y += stepY
      tMaxY += tDeltaY
    }
    else {
      z += stepZ
      tMaxZ += tDeltaZ
    }
    if (isBlocking({ x, y, z }))
      return true
  }
  return false
}

/**
 * Earliest tick where the curve enters a friendly box.
 *
 * The friendly boxes get the same inflation as the target box, so a curve is
 * never called safe against a friendly just because the target budget made the
 * target box larger.
 */
export function firstFriendlyBlockTick(samples: TrajectorySample[], friendlies: FloatingEntityTrack[], spreadPerTick: number, baseInflation = 0): number | undefined {
  for (let index = 1; index < samples.length; index++) {
    const previous = samples[index - 1]
    const current = samples[index]
    const inflation = baseInflation + spreadPerTick * current.tick
    for (const friendly of friendlies) {
      const box = floatingAabbAt(friendly, current.tick, inflation)
      if (segmentIntersectsAabb(previous.position, current.position, box))
        return current.tick
    }
  }
  return undefined
}

function yawTowards(from: Vec3, to: Vec3): number {
  return (Math.atan2(-(to.x - from.x), to.z - from.z) * 180) / Math.PI
}

function pitchTowards(from: Vec3, to: Vec3): number {
  const horizontal = Math.hypot(to.x - from.x, to.z - from.z)
  return (Math.atan2(-(to.y - from.y), horizontal) * 180) / Math.PI
}

interface Candidate {
  yaw: number
  pitch: number
  trajectory: Trajectory
  intersection: TargetIntersection
  blockedTick?: number
  friendlyTick?: number
  peakY: number
}

function buildCandidate(request: BallisticRequest, yaw: number, pitch: number, isBlocking?: (cell: Vec3) => boolean): Candidate {
  const trajectory = simulateProjectile({
    profile: request.profile,
    launchPosition: request.launchPosition,
    yaw,
    pitch,
    speed: request.speed,
    ...(request.shooterVelocity ? { shooterVelocity: request.shooterVelocity } : {}),
    ...(request.shooterOnGround !== undefined ? { shooterOnGround: request.shooterOnGround } : {}),
    maxTicks: request.maxTicks ?? DEFAULT_MAX_TICKS,
  })
  // Launch spread grows with flight time; observation uncertainty and the
  // caller's latency budget are constant inflations on every tick.
  const spreadPerTick = LAUNCH_SPREAD_PER_AXIS * request.profile.launchInaccuracy * request.speed
  const baseInflation = request.target.positionUncertainty + (request.spreadUncertainty ?? 0)
  const intersection = findTargetIntersection(trajectory.samples, request.target, spreadPerTick, baseInflation)
  const blockedTick = isBlocking ? firstObstacleTick(trajectory.samples, isBlocking) : undefined
  const friendlyTick = request.friendlies?.length
    ? firstFriendlyBlockTick(trajectory.samples, request.friendlies, spreadPerTick, baseInflation)
    : undefined
  let peakY = trajectory.launchPosition.y
  for (const sample of trajectory.samples) {
    if (sample.position.y > peakY)
      peakY = sample.position.y
  }
  return { yaw, pitch, trajectory, intersection, ...(blockedTick !== undefined ? { blockedTick } : {}), ...(friendlyTick !== undefined ? { friendlyTick } : {}), peakY }
}

function isCandidateSafe(candidate: Candidate): boolean {
  const hit = candidate.intersection.hitTick
  if (hit === undefined)
    return false
  if (candidate.blockedTick !== undefined && candidate.blockedTick <= hit)
    return false
  if (candidate.friendlyTick !== undefined && candidate.friendlyTick <= hit)
    return false
  return true
}

function candidateScore(candidate: Candidate): number {
  const hit = candidate.intersection.hitTick ?? Number.POSITIVE_INFINITY
  // Flight time first, then the flattest arc: a low arc spends less time in the
  // uncertain target future.
  return hit * 1000 + candidate.peakY
}

function toSolution(request: BallisticRequest, candidate: Candidate, directPitch: number): BallisticSolution {
  const hit = candidate.intersection.hitTick
  const tick = hit ?? candidate.intersection.closestTick
  const predictedTarget = predictTargetPosition(request.target, tick)
  const solution: BallisticSolution = {
    profileId: request.profile.id,
    version: request.profile.version,
    solutionRevision: SOLUTION_REVISION,
    yaw: candidate.yaw,
    pitch: candidate.pitch,
    arc: candidate.pitch > directPitch + 25 ? 'high' : 'low',
    predictedFlightTicks: tick,
    closestDistance: candidate.intersection.closestDistance,
    predictedTarget,
    trajectory: candidate.trajectory,
  }
  if (hit !== undefined)
    solution.hitTick = hit
  return solution
}

/**
 * Solves one intercept with a bounded coarse-to-fine search.
 *
 * @example
 * solveBallisticShot({ profile: PROJECTILE_PROFILES['bow-arrow'], launchPosition: { x: 0, y: 65.5, z: 0 }, speed: 3, target }).ok
 * // => true
 */
export function solveBallisticShot(request: BallisticRequest): BallisticPlan {
  if (request.profile.solver === 'unsupported')
    return { ok: false, reason: 'unsupported_projectile_profile', detail: request.profile.id }

  const target = request.target
  const nominalTicks = clamp(Math.hypot(target.position.x - request.launchPosition.x, target.position.z - request.launchPosition.z) / Math.max(request.speed, 0.1), 1, request.maxTicks ?? DEFAULT_MAX_TICKS)
  const aimPoint = predictTargetPosition(target, nominalTicks)
  const aimYaw = yawTowards(request.launchPosition, aimPoint)
  const directPitch = pitchTowards(request.launchPosition, aimPoint)
  const obstacle = request.isObstacle
  const isBlocking = obstacle ? (cell: Vec3) => obstacle(cell) !== false : undefined

  let best: Candidate | undefined
  let bestSafe: Candidate | undefined
  let bestSafeScore = Number.POSITIVE_INFINITY
  let anyHit = false

  const consider = (candidate: Candidate) => {
    if (candidate.intersection.hitTick !== undefined)
      anyHit = true
    if (!isCandidateSafe(candidate)) {
      if (!best || candidateScore(candidate) < candidateScore(best))
        best = candidate
      return
    }
    const score = candidateScore(candidate)
    if (score < bestSafeScore) {
      bestSafeScore = score
      bestSafe = candidate
    }
  }

  for (let pitch = COARSE_PITCH_MIN; pitch <= COARSE_PITCH_MAX; pitch += COARSE_PITCH_STEP) {
    for (const offset of COARSE_YAW_OFFSETS)
      consider(buildCandidate(request, aimYaw + offset, pitch, isBlocking))
  }

  if (!bestSafe) {
    const refinePitch = best?.pitch ?? directPitch
    const refineYaw = best?.yaw ?? aimYaw
    for (const pitchOffset of REFINE_PITCH_OFFSETS) {
      for (const yawOffset of REFINE_YAW_OFFSETS)
        consider(buildCandidate(request, refineYaw + yawOffset, refinePitch + pitchOffset, isBlocking))
    }
  }

  if (bestSafe) {
    // Lead pass: the hit tick of the best candidate often differs from the
    // nominal one, so re-aim at the target predicted at that tick.
    const leadTicks = bestSafe.intersection.hitTick ?? bestSafe.intersection.closestTick
    const leadYaw = yawTowards(request.launchPosition, predictTargetPosition(target, leadTicks))
    for (const pitchOffset of FINE_PITCH_OFFSETS)
      consider(buildCandidate(request, leadYaw, bestSafe.pitch + pitchOffset, isBlocking))
  }

  if (bestSafe)
    return { ok: true, solution: toSolution(request, bestSafe, directPitch), observationAgeMs: target.ageMs }

  if (anyHit) {
    // Some curve reached the target but a friendly or a wall was on it first.
    const blockedByFriendly = best?.friendlyTick !== undefined && (best.blockedTick === undefined || best.friendlyTick <= best.blockedTick)
    if (blockedByFriendly)
      return { ok: false, reason: 'friendly_blocked', detail: 'a friendly entity crosses the only intersecting curve' }
  }
  return { ok: false, reason: 'no_ballistic_solution', detail: best ? `closest ${best.intersection.closestDistance.toFixed(2)} blocks` : 'no candidate curve' }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export interface ObservationPlanInput {
  observation: TargetObservation
  profile: ProjectileProfile
  chargeTicks: number
  selfEye: Vec3
  selfVelocity?: Vec3
  selfOnGround?: boolean
  nowMs: number
  friendlies?: FloatingEntityTrack[]
  isObstacle?: (cell: Vec3) => boolean | 'unknown'
  spreadUncertainty?: number
  maxTicks?: number
}

/**
 * Builds one plan from a target observation.
 *
 * The observation contract supplies the position, the optional velocity and
 * bounds, the age and the position uncertainty, so a stale or unobserved
 * target is never solved as a current one.
 */
export function planShotFromObservation(input: ObservationPlanInput): BallisticPlan {
  const observation = input.observation
  if (!observation.position)
    return { ok: false, reason: 'target_unobserved', detail: observation.missingReason ?? 'no position' }
  const speed = launchSpeed(input.profile, input.chargeTicks)
  if (speed === undefined)
    return { ok: false, reason: 'insufficient_charge', detail: `charge ${input.chargeTicks}` }
  const track: TargetTrack = {
    targetUuid: observation.targetUuid,
    position: observation.position,
    ...(observation.velocity ? { velocity: observation.velocity } : {}),
    bounds: observation.bounds ?? DEFAULT_TARGET_BOUNDS,
    onGround: observation.onGround,
    ageMs: Math.max(0, input.nowMs - observation.receivedAt),
    positionUncertainty: observation.positionUncertainty,
  }
  const plan = solveBallisticShot({
    profile: input.profile,
    launchPosition: launchPositionFor(input.profile, input.selfEye),
    speed,
    ...(input.selfVelocity ? { shooterVelocity: input.selfVelocity } : {}),
    ...(input.selfOnGround !== undefined ? { shooterOnGround: input.selfOnGround } : {}),
    target: track,
    ...(input.friendlies ? { friendlies: input.friendlies } : {}),
    ...(input.isObstacle ? { isObstacle: input.isObstacle } : {}),
    ...(input.spreadUncertainty !== undefined ? { spreadUncertainty: input.spreadUncertainty } : {}),
    ...(input.maxTicks !== undefined ? { maxTicks: input.maxTicks } : {}),
  })
  if (plan.ok)
    return { ok: true, solution: plan.solution, observationAgeMs: track.ageMs }
  return plan
}
