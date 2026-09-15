import type { TargetObservation } from '../movement/target-observation'
import type { FloatingEntityTrack } from './intercept'
import type { ProjectileProfile } from './profile'

import { describe, expect, it } from 'vitest'

import {
  findTargetIntersection,
  firstFriendlyBlockTick,
  firstObstacleTick,
  planShotFromObservation,
  pointAabbDistance,
  predictTargetPosition,
  segmentIntersectsAabb,
  solveBallisticShot,
} from './intercept'
import { PROJECTILE_PROFILES } from './profile'
import { simulateProjectile } from './simulation'

const EYE = { x: 0, y: 65.62, z: 0 }
const BOW = PROJECTILE_PROFILES['bow-arrow']

function observation(overrides: Partial<TargetObservation> = {}): TargetObservation {
  return {
    targetUuid: 'target-uuid',
    worldId: 'world-1',
    dimension: 'minecraft:overworld',
    position: { x: 10, y: 64, z: 0 },
    onGround: true,
    fallFlying: false,
    riding: false,
    alive: true,
    source: 'server-entity',
    receivedAt: 2_000,
    requestStartedAt: 1_950,
    requestEndedAt: 2_000,
    requestDurationMs: 50,
    connectionGeneration: 1,
    visibility: 'loaded',
    completeness: 'complete',
    positionUncertainty: 0.25,
    ...overrides,
  }
}

function plan(overrides: Partial<Parameters<typeof planShotFromObservation>[0]> = {}) {
  return planShotFromObservation({
    observation: observation(),
    profile: BOW,
    chargeTicks: 20,
    selfEye: EYE,
    nowMs: 2_100,
    ...overrides,
  })
}

describe('stationary-target baseline (CD-B1 acceptance)', () => {
  it('solves a full-charge bow shot at an open stationary target', () => {
    const result = plan()
    expect(result.ok).toBe(true)
    if (!result.ok)
      return
    expect(result.solution.profileId).toBe('bow-arrow')
    expect(result.solution.hitTick).toBeGreaterThan(0)
    expect(result.solution.closestDistance).toBe(0)
    expect(result.observationAgeMs).toBe(100)
    expect(result.solution.predictedFlightTicks).toBe(result.solution.hitTick)
  })

  it('prefers the low arc for an open shot', () => {
    const result = plan()
    expect(result.ok && result.solution.arc).toBe('low')
  })

  it('is a pure function: the same input yields the same solution', () => {
    const first = plan()
    const second = plan()
    expect(first.ok && second.ok && first.solution).toEqual(second.ok ? second.solution : undefined)
  })
})

describe('moving-target intercept (CD-B2)', () => {
  it('leads a laterally moving target instead of aiming where it was', () => {
    const result = plan({
      observation: observation({ velocity: { x: 0, y: 0, z: 0.4 } }),
    })
    expect(result.ok).toBe(true)
    if (!result.ok)
      return
    expect(result.solution.hitTick).toBeGreaterThan(0)
    expect(result.solution.predictedTarget.z).toBeGreaterThan(0)
  })

  it('keeps a grounded target on its observed Y', () => {
    const track = {
      targetUuid: 'u',
      position: { x: 0, y: 64, z: 0 },
      velocity: { x: 0.2, y: -0.5, z: 0 },
      bounds: { width: 0.6, height: 1.8 },
      onGround: true as const,
      ageMs: 0,
      positionUncertainty: 0,
    }
    expect(predictTargetPosition(track, 5).y).toBe(64)
  })

  it('applies the short uniform-motion model to an airborne target', () => {
    const track = {
      targetUuid: 'u',
      position: { x: 0, y: 80, z: 0 },
      velocity: { x: 0, y: 0.3, z: 0 },
      bounds: { width: 0.6, height: 1.8 },
      onGround: false as const,
      ageMs: 0,
      positionUncertainty: 0,
    }
    expect(predictTargetPosition(track, 4).y).toBeCloseTo(81.2, 6)
  })

  it('returns no_ballistic_solution when the budget cannot reach the target', () => {
    const result = plan({
      observation: observation({ position: { x: 400, y: 64, z: 0 } }),
      maxTicks: 20,
    })
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.reason).toBe('no_ballistic_solution')
  })

  it('refuses an unsupported profile instead of falling back to a fixed speed', () => {
    const unsupported: ProjectileProfile = { ...BOW, id: 'bow-arrow', solver: 'unsupported' }
    const result = solveBallisticShot({
      profile: unsupported,
      launchPosition: { x: 0, y: 65.5, z: 0 },
      speed: 3,
      target: {
        targetUuid: 'u',
        position: { x: 10, y: 64, z: 0 },
        bounds: { width: 0.6, height: 1.8 },
        onGround: true,
        ageMs: 0,
        positionUncertainty: 0.25,
      },
    })
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.reason).toBe('unsupported_projectile_profile')
  })

  it('refuses insufficient charge before any simulation', () => {
    const result = plan({ chargeTicks: 1 })
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.reason).toBe('insufficient_charge')
  })

  it('refuses an unobserved target instead of solving a fabricated position', () => {
    const result = plan({ observation: observation({ position: undefined, missingReason: 'out-of-range' }) })
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.reason).toBe('target_unobserved')
  })
})

describe('same curve for block and friendly checks (CD-B2)', () => {
  const track = {
    targetUuid: 'target-uuid',
    position: { x: 10, y: 64, z: 0 },
    bounds: { width: 0.6, height: 1.8 },
    onGround: true,
    ageMs: 0,
    positionUncertainty: 0.25,
  }

  it('treats a single thin wall cell on the curve as blocking', () => {
    const trajectory = simulateProjectile({
      profile: BOW,
      launchPosition: { x: 0, y: 65.5, z: 0 },
      yaw: 0,
      pitch: 0,
      speed: 3,
      maxTicks: 12,
    })
    const middle = trajectory.samples[5].position
    const wall = { x: Math.floor(middle.x), y: Math.floor(middle.y), z: Math.floor(middle.z) }
    const blocked = firstObstacleTick(trajectory.samples, cell => cell.x === wall.x && cell.y === wall.y && cell.z === wall.z)
    expect(blocked).toBeDefined()
    const away = firstObstacleTick(trajectory.samples, cell => cell.x === wall.x + 100)
    expect(away).toBeUndefined()
  })

  it('refuses a shot through a terrain wall', () => {
    const result = solveBallisticShot({
      profile: BOW,
      launchPosition: { x: 0, y: 65.5, z: 0 },
      speed: 3,
      target: track,
      isObstacle: cell => cell.x === 5 && cell.y >= 0 && cell.y <= 320 && cell.z >= -200 && cell.z <= 200,
    })
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.reason).toBe('no_ballistic_solution')
  })

  it('reports friendly_blocked when a bystander covers the target box', () => {
    const friendlies: FloatingEntityTrack[] = [
      { uuid: 'friend-uuid', position: { x: 10, y: 64, z: 0 }, bounds: { width: 0.6, height: 1.8 } },
    ]
    const result = solveBallisticShot({
      profile: BOW,
      launchPosition: { x: 0, y: 65.5, z: 0 },
      speed: 3,
      target: track,
      friendlies,
    })
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.reason).toBe('friendly_blocked')
  })

  it('finds the earliest friendly intersection on a moving curve', () => {
    const result = plan({ observation: observation({ velocity: { x: 0, y: 0, z: 0.4 } }) })
    expect(result.ok).toBe(true)
    if (!result.ok)
      return
    const middle = result.solution.trajectory.samples[Math.floor(result.solution.trajectory.samples.length / 2)].position
    const friendlies: FloatingEntityTrack[] = [
      { uuid: 'friend-uuid', position: middle, bounds: { width: 0.6, height: 1.8 } },
    ]
    const firstTick = firstFriendlyBlockTick(result.solution.trajectory.samples, friendlies, 0)
    expect(firstTick).toBeDefined()
  })
})

describe('geometry helpers', () => {
  it('intersects a segment with a box by the slab method', () => {
    expect(segmentIntersectsAabb(
      { x: 0, y: 0, z: 0 },
      { x: 2, y: 0, z: 0 },
      { min: { x: 1, y: -1, z: -1 }, max: { x: 1.5, y: 1, z: 1 } },
    )).toBe(true)
    expect(segmentIntersectsAabb(
      { x: 0, y: 0, z: 0 },
      { x: 2, y: 0, z: 0 },
      { min: { x: 1, y: 3, z: -1 }, max: { x: 1.5, y: 4, z: 1 } },
    )).toBe(false)
  })

  it('measures the distance to a box, zero inside', () => {
    const box = { min: { x: 1, y: 1, z: 1 }, max: { x: 2, y: 2, z: 2 } }
    expect(pointAabbDistance({ x: 1.5, y: 1.5, z: 1.5 }, box)).toBe(0)
    expect(pointAabbDistance({ x: 4, y: 1.5, z: 1.5 }, box)).toBeCloseTo(2, 6)
  })

  it('finds the target intersection tick against a moving box', () => {
    const planned = plan()
    expect(planned.ok).toBe(true)
    if (!planned.ok)
      return
    const intersection = findTargetIntersection(
      planned.solution.trajectory.samples,
      {
        targetUuid: 'u',
        position: { x: 10, y: 64, z: 0 },
        bounds: { width: 0.6, height: 1.8 },
        onGround: true,
        ageMs: 0,
        positionUncertainty: 0.25,
      },
      0,
    )
    expect(intersection.hitTick).toBeDefined()
  })
})
