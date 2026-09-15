import type { CollisionBox, Vec3 } from '../movement/types'
import type { FlightObservation } from './contracts'
import type { ShapeSource } from './rollout'

import { describe, expect, it } from 'vitest'

import { FLIGHT_PROFILE_1_21_1 } from './profile'
import { evaluateCandidate, generateCandidateInputs, planRollout, sweepPoseBox } from './rollout'

const FULL: CollisionBox = { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }

function openSource(): ShapeSource {
  return { shapeAt: () => [] }
}

function observation(overrides: Partial<FlightObservation> = {}): FlightObservation {
  return {
    tick: 100,
    position: { x: 0, y: 80, z: 0 },
    velocity: { x: 0, y: 0, z: 1 },
    yaw: 0,
    pitch: 0,
    poseBox: { width: 0.6, height: 1.8 },
    health: 20,
    firework: { active: false, ticksRemaining: 0 },
    onGround: false,
    inWater: false,
    ...overrides,
  }
}

const limits = {
  horizonTicks: 20,
  yawStepDeg: 10,
  pitchStepDeg: 10,
  maxYawRateDeg: 6,
  maxPitchRateDeg: 6,
  inflate: 0.1,
  minY: -64,
  maxY: 320,
  reserveTicks: 2,
  fireworks: 8,
}

const goal: Vec3 = { x: 0, y: 80, z: 40 }

describe('generateCandidateInputs', () => {
  it('builds 5 yaw × 3 pitch × 2 thrust primitives', () => {
    const candidates = generateCandidateInputs(observation(), limits)
    expect(candidates).toHaveLength(30)
  })

  it('drops rocket primitives when no rocket remains', () => {
    const candidates = generateCandidateInputs(observation(), { ...limits, fireworks: 0 })
    expect(candidates).toHaveLength(15)
    expect(candidates.every(candidate => !candidate.useRocket)).toBe(true)
  })

  it('limits the turn by the turn-rate budget', () => {
    const candidates = generateCandidateInputs(observation(), limits)
    for (const candidate of candidates)
      expect(Math.abs(candidate.yaw)).toBeLessThanOrEqual(limits.maxYawRateDeg * 5)
  })
})

describe('sweepPoseBox', () => {
  it('sees a thin obstacle between the endpoints', () => {
    const source: ShapeSource = { shapeAt: x => (x === 1 ? [FULL] : []) }
    const result = sweepPoseBox(source, { x: 0.5, y: 80, z: 0 }, { x: 2.5, y: 80, z: 0 }, { width: 0.6, height: 1.8 }, 0.1)
    expect(result.kind).toBe('obstacle')
  })

  it('treats a missing cell as unknown, never air', () => {
    const source: ShapeSource = { shapeAt: () => undefined }
    const result = sweepPoseBox(source, { x: 0.5, y: 80, z: 0 }, { x: 1.5, y: 80, z: 0 }, { width: 0.6, height: 1.8 }, 0.1)
    expect(result.kind).toBe('unknown')
  })

  it('is clear when every cell is known air', () => {
    const result = sweepPoseBox(openSource(), { x: 0.5, y: 80, z: 0 }, { x: 4.5, y: 80, z: 0 }, { width: 0.6, height: 1.8 }, 0.1)
    expect(result.kind).toBe('clear')
  })
})

describe('evaluateCandidate', () => {
  it('marks a straight-ahead primitive safe in open air', () => {
    const evaluation = evaluateCandidate({
      profile: FLIGHT_PROFILE_1_21_1,
      observation: observation(),
      candidate: { yaw: 0, pitch: 0, useRocket: false },
      source: openSource(),
      limits,
      goal,
    })
    expect(evaluation.safe).toBe(true)
    expect(evaluation.violations).toEqual([])
  })

  it('rejects a candidate that hits an obstacle', () => {
    // The observation glides south (+z), so the obstacle spans the z axis.
    const source: ShapeSource = { shapeAt: (_x, _y, z) => (z >= 2 ? [FULL] : []) }
    const evaluation = evaluateCandidate({
      profile: FLIGHT_PROFILE_1_21_1,
      observation: observation(),
      candidate: { yaw: 0, pitch: 0, useRocket: false },
      source,
      limits,
      goal,
    })
    expect(evaluation.safe).toBe(false)
    expect(evaluation.violations).toContain('collision')
  })

  it('rejects a candidate that spends the landing reserve', () => {
    const evaluation = evaluateCandidate({
      profile: FLIGHT_PROFILE_1_21_1,
      observation: observation(),
      candidate: { yaw: 0, pitch: 0, useRocket: true },
      source: openSource(),
      limits: { ...limits, fireworks: 2, reserveTicks: 2 },
      goal,
    })
    expect(evaluation.violations).toContain('reserve')
  })

  it('rejects a candidate that leaves the altitude bounds', () => {
    const evaluation = evaluateCandidate({
      profile: FLIGHT_PROFILE_1_21_1,
      observation: observation({ position: { x: 0, y: 70, z: 0 } }),
      candidate: { yaw: 0, pitch: 60, useRocket: false },
      source: openSource(),
      limits: { ...limits, minY: 68 },
      goal,
    })
    expect(evaluation.violations).toContain('altitude')
  })
})

describe('planRollout', () => {
  it('chooses a safe candidate in open air', () => {
    const outcome = planRollout({ profile: FLIGHT_PROFILE_1_21_1, observation: observation(), source: openSource(), limits, goal })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.chosen.safe).toBe(true)
      expect(outcome.executedTicks).toBe(2)
    }
  })

  it('reports all_candidates_unsafe when a wall fills the prediction window', () => {
    const source: ShapeSource = { shapeAt: () => [FULL] }
    const outcome = planRollout({ profile: FLIGHT_PROFILE_1_21_1, observation: observation(), source, limits, goal })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok)
      expect(outcome.reason).toBe('all_candidates_unsafe')
  })

  it('shortens the executed prefix when the wall-clock budget is exceeded', () => {
    let clock = 0
    const outcome = planRollout({
      profile: FLIGHT_PROFILE_1_21_1,
      observation: observation(),
      source: openSource(),
      limits: { ...limits, budgetMs: 1 },
      goal,
      now: () => {
        clock += 100
        return clock
      },
    })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.slowDown).toBe(true)
      expect(outcome.executedTicks).toBe(1)
    }
  })

  it('shortens the prefix when the error budget exceeds the corridor margin', () => {
    const outcome = planRollout({
      profile: FLIGHT_PROFILE_1_21_1,
      observation: observation(),
      source: openSource(),
      limits: { ...limits, inflate: 2, corridorMargin: 1 },
      goal,
    })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.slowDown).toBe(true)
      expect(outcome.executedTicks).toBe(1)
    }
  })
})
