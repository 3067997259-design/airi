/**
 * Bounded candidate rollout (elytra-navigation design §5, CD-E2).
 *
 * The rollout layer takes the corridor as a hint and chooses a short control
 * primitive from a finite set: a bounded yaw change, a bounded pitch change and
 * whether to fire a rocket. Each candidate is simulated for the prediction
 * window (20–40 ticks); only the first one or two ticks are executed before the
 * next observation re-plans.
 *
 * Safety and preference stay separate: a candidate that collides, enters
 * unknown space, leaves the altitude bounds or spends the landing reserve is
 * unsafe regardless of how much closer it flies to the goal. Only safe
 * candidates are compared by cost.
 */
import type { CollisionBox, Vec3 } from '../movement/types'
import type { FlightObservation } from './contracts'
import type { FlightProfile } from './profile'
import type { FlightState, FlightTrajectory } from './simulation'

import { simulateFlight } from './simulation'

/**
 * Shape source for the swept collision.
 *
 * `shapeAt` returns the cell collision boxes, or `undefined` when the read did
 * not cover the cell. A missing cell is unknown and fails a candidate; it is
 * never treated as air.
 */
export interface ShapeSource {
  shapeAt: (x: number, y: number, z: number) => CollisionBox[] | undefined
}

/** Where one candidate is evaluated from and what it may spend. */
export interface RolloutLimits {
  /** Prediction window in ticks; the design suggests 20–40. */
  horizonTicks: number
  /** Yaw change per candidate step, in degrees. */
  yawStepDeg: number
  /** Pitch change per candidate step, in degrees. */
  pitchStepDeg: number
  /** Maximum yaw change the primitive may apply from the current heading. */
  maxYawRateDeg: number
  /** Maximum pitch change the primitive may apply from the current pitch. */
  maxPitchRateDeg: number
  /** Error budget added to the pose box during the sweep, in blocks. */
  inflate: number
  minY: number
  maxY: number
  /** Rocket ticks kept in reserve for the nearest landing. */
  reserveTicks: number
  /** Rockets currently available to the session. */
  fireworks: number
  /** Corridor margin the inflate must stay under; above it the prefix shortens. */
  corridorMargin?: number
  /** Upper bound on candidates evaluated per update. */
  maxCandidates?: number
  /** Wall-clock budget for one update, in ms. */
  budgetMs?: number
}

/** One finite control primitive. */
export interface CandidateInput {
  yaw: number
  pitch: number
  useRocket: boolean
}

export interface CandidateEvaluation {
  input: CandidateInput
  safe: boolean
  /** Named safety violations; empty when `safe`. */
  violations: Array<'collision' | 'unknown' | 'altitude' | 'supply' | 'reserve'>
  /** Preference cost, only comparable between safe candidates. */
  cost: number
  trajectory: FlightTrajectory
  rocketUses: number
}

export type RolloutOutcome
  = | {
    ok: true
    chosen: CandidateEvaluation
    /** Ticks the caller may execute before re-planning (1 or 2). */
    executedTicks: number
    /** True when the error budget forced a shorter, slower execution. */
    slowDown: boolean
    plannedAtTick: number
  }
  | { ok: false, reason: 'all_candidates_unsafe', evaluations: CandidateEvaluation[] }
  | { ok: false, reason: 'budget', evaluations: CandidateEvaluation[] }

/** A pose box at one point, already inflated. */
export interface PoseAabb {
  minX: number
  minY: number
  minZ: number
  maxX: number
  maxY: number
  maxZ: number
}

function poseAabbAt(point: Vec3, width: number, height: number, inflate: number): PoseAabb {
  const half = width / 2 + inflate
  return {
    minX: point.x - half,
    minY: point.y - inflate,
    minZ: point.z - half,
    maxX: point.x + half,
    maxY: point.y + height + inflate,
    maxZ: point.z + half,
  }
}

function boxesIntersect(box: CollisionBox, cellX: number, cellY: number, cellZ: number, aabb: PoseAabb): boolean {
  return cellX + box.maxX > aabb.minX
    && cellX + box.minX < aabb.maxX
    && cellY + box.maxY > aabb.minY
    && cellY + box.minY < aabb.maxY
    && cellZ + box.maxZ > aabb.minZ
    && cellZ + box.minZ < aabb.maxZ
}

/** Sub-samples per tick the segment sweep tests. */
const SWEEP_SUBSTEPS = 4

export type SweepResult
  = | { kind: 'clear' }
    | { kind: 'obstacle', at: Vec3 }
    | { kind: 'unknown', at: Vec3 }

/**
 * Sweeps the pose box along one segment against real shapes.
 *
 * The whole read is per-cell: a missing cell is `unknown`, never air. A cell
 * whose shapes intersect the box is `obstacle`.
 */
export function sweepPoseBox(source: ShapeSource, from: Vec3, to: Vec3, poseBox: { width: number, height: number }, inflate: number): SweepResult {
  for (let step = 1; step <= SWEEP_SUBSTEPS; step++) {
    const t = step / SWEEP_SUBSTEPS
    const point = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, z: from.z + (to.z - from.z) * t }
    const aabb = poseAabbAt(point, poseBox.width, poseBox.height, inflate)
    for (let x = Math.floor(aabb.minX); x <= Math.floor(aabb.maxX); x++) {
      for (let y = Math.floor(aabb.minY); y <= Math.floor(aabb.maxY); y++) {
        for (let z = Math.floor(aabb.minZ); z <= Math.floor(aabb.maxZ); z++) {
          const boxes = source.shapeAt(x, y, z)
          if (boxes === undefined)
            return { kind: 'unknown', at: point }
          if (boxes.some(box => boxesIntersect(box, x, y, z, aabb)))
            return { kind: 'obstacle', at: point }
        }
      }
    }
  }
  return { kind: 'clear' }
}

/** The finite primitive set for one observation (5 yaw × 3 pitch × 2 thrust). */
export function generateCandidateInputs(observation: FlightObservation, limits: RolloutLimits): CandidateInput[] {
  // The turn is bounded by the turn rate over a short window, not by the whole
  // prediction window, so a primitive stays near the current heading.
  const yawBudget = limits.maxYawRateDeg * 5
  const pitchBudget = limits.maxPitchRateDeg * 5
  const yawDeltas = [-2, -1, 0, 1, 2].map(step => clamp(step * limits.yawStepDeg, -yawBudget, yawBudget))
  const pitchDeltas = [-1, 0, 1].map(step => clamp(step * limits.pitchStepDeg, -pitchBudget, pitchBudget))
  const candidates: CandidateInput[] = []
  for (const yawDelta of yawDeltas) {
    for (const pitchDelta of pitchDeltas) {
      for (const useRocket of [false, true]) {
        if (useRocket && limits.fireworks <= 0)
          continue
        candidates.push({
          yaw: observation.yaw + yawDelta,
          pitch: clamp(observation.pitch + pitchDelta, -89, 89),
          useRocket,
        })
      }
    }
  }
  const cap = limits.maxCandidates ?? 30
  return candidates.slice(0, cap)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function observationState(observation: FlightObservation): FlightState {
  return {
    position: { ...observation.position },
    velocity: { ...observation.velocity },
    yaw: observation.yaw,
    pitch: observation.pitch,
    rocketTicksRemaining: observation.firework.active ? observation.firework.ticksRemaining : 0,
    onGround: observation.onGround,
    inWater: observation.inWater,
  }
}

/** Simulates one candidate and separates safety from preference. */
export function evaluateCandidate(input: {
  profile: FlightProfile
  observation: FlightObservation
  candidate: CandidateInput
  source: ShapeSource
  limits: RolloutLimits
  goal: Vec3
}): CandidateEvaluation {
  const { profile, observation, candidate, source, limits, goal } = input
  const state = observationState(observation)
  const schedule = Array.from({ length: limits.horizonTicks }, (_, index) => ({
    yaw: candidate.yaw,
    pitch: candidate.pitch,
    useRocket: index === 0 && candidate.useRocket,
    rocketAvailable: limits.fireworks > 0,
  }))
  const trajectory = simulateFlight(profile, state, schedule, {}, { maxTicks: limits.horizonTicks })

  const violations: CandidateEvaluation['violations'] = []
  // Sweep every predicted segment with the pose box; run only until a violation
  // is found so the cost is bounded.
  let previous = { ...observation.position }
  for (const sample of trajectory.samples) {
    const sweep = sweepPoseBox(source, previous, sample.position, observation.poseBox, limits.inflate)
    if (sweep.kind === 'unknown') {
      violations.push('unknown')
      break
    }
    if (sweep.kind === 'obstacle') {
      violations.push('collision')
      break
    }
    previous = sample.position
  }

  const lowest = Math.min(observation.position.y, ...trajectory.samples.map(sample => sample.position.y))
  const highest = Math.max(observation.position.y, ...trajectory.samples.map(sample => sample.position.y))
  if (lowest <= limits.minY || highest >= limits.maxY)
    violations.push('altitude')

  const rocketUses = candidate.useRocket ? 1 : 0
  if (rocketUses > limits.fireworks)
    violations.push('supply')
  if (limits.fireworks - rocketUses < limits.reserveTicks)
    violations.push('reserve')

  const cost = preferenceCost(trajectory, candidate, observation, goal, limits)
  return {
    input: candidate,
    safe: violations.length === 0,
    violations,
    cost,
    trajectory,
    rocketUses,
  }
}

/**
 * Preference cost for a safe candidate.
 *
 * Distance to the goal dominates, with small terms for input change, speed
 * error and resource use. Safety is never traded for a lower cost.
 */
function preferenceCost(trajectory: FlightTrajectory, candidate: CandidateInput, observation: FlightObservation, goal: Vec3, limits: RolloutLimits): number {
  const end = trajectory.samples.at(-1)?.position ?? observation.position
  const distance = Math.hypot(end.x - goal.x, end.y - goal.y, end.z - goal.z)
  const inputChange = Math.abs(candidate.yaw - observation.yaw) + Math.abs(candidate.pitch - observation.pitch)
  const speedError = Math.abs(Math.hypot(observation.velocity.x, observation.velocity.z) - 1)
  const resource = candidate.useRocket ? 1 + 1 / Math.max(1, limits.fireworks) : 0
  return distance + inputChange * 0.05 + speedError * 0.5 + resource
}

export type CandidateEvaluator = (candidate: CandidateInput) => CandidateEvaluation

/**
 * Plans the best bounded primitive for the current observation.
 *
 * When every candidate is unsafe the outcome is `all_candidates_unsafe` and the
 * caller must enter recovery or landing. If the wall-clock budget is exceeded
 * mid-search, the best safe candidate found so far is returned with a shorter
 * executed prefix and `slowDown` set (design §8).
 */
export function planRollout(input: {
  profile: FlightProfile
  observation: FlightObservation
  source: ShapeSource
  limits: RolloutLimits
  goal: Vec3
  /** Main-process clock, injected so the budget can be tested. */
  now?: () => number
}): RolloutOutcome {
  const now = input.now ?? (() => Date.now())
  const startedAt = now()
  const candidates = generateCandidateInputs(input.observation, input.limits)
  const evaluations: CandidateEvaluation[] = []
  let chosen: CandidateEvaluation | undefined
  let budgetExceeded = false

  for (const candidate of candidates) {
    const evaluation = evaluateCandidate({ ...input, candidate })
    evaluations.push(evaluation)
    if (evaluation.safe && (!chosen || evaluation.cost < chosen.cost))
      chosen = evaluation
    if (input.limits.budgetMs !== undefined && now() - startedAt > input.limits.budgetMs) {
      budgetExceeded = true
      break
    }
  }

  // The error budget may exceed the corridor margin; when it does, slow down
  // and execute a shorter prefix instead of trusting a wide sweep.
  const marginExceeded = input.limits.corridorMargin !== undefined && input.limits.inflate > input.limits.corridorMargin
  const slowDown = budgetExceeded || marginExceeded

  if (!chosen) {
    if (budgetExceeded)
      return { ok: false, reason: 'budget', evaluations }
    return { ok: false, reason: 'all_candidates_unsafe', evaluations }
  }
  if (budgetExceeded && evaluations.every(evaluation => !evaluation.safe))
    return { ok: false, reason: 'budget', evaluations }

  return {
    ok: true,
    chosen,
    executedTicks: slowDown ? 1 : 2,
    slowDown,
    plannedAtTick: input.observation.tick,
  }
}
