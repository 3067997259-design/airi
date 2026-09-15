import type { AirCorridorRegion } from './air-spacing'

import { describe, expect, it } from 'vitest'

import {
  acceptAirFollowUpdate,
  corridorAllowsAutoLand,
  corridorRoleOf,
  createAirSpacingPolicy,
  DEFAULT_AIR_SPACING_BAND,
  planRendezvous,
} from './air-spacing'

function region(min: [number, number, number], max: [number, number, number]): AirCorridorRegion {
  return { min: { x: min[0], y: min[1], z: min[2] }, max: { x: max[0], y: max[1], z: max[2] } }
}

describe('air spacing band', () => {
  it('classifies distances and never pursues inside the band', () => {
    const spacing = createAirSpacingPolicy()
    expect(spacing.classify(DEFAULT_AIR_SPACING_BAND.min - 1)).toBe('near')
    expect(spacing.classify(DEFAULT_AIR_SPACING_BAND.min)).toBe('band')
    expect(spacing.classify(DEFAULT_AIR_SPACING_BAND.max)).toBe('band')
    expect(spacing.classify(DEFAULT_AIR_SPACING_BAND.max + 1)).toBe('far')
    expect(spacing.pursuitStrength(0)).toBe(0)
    expect(spacing.pursuitStrength(DEFAULT_AIR_SPACING_BAND.min)).toBe(0)
    expect(spacing.pursuitStrength(DEFAULT_AIR_SPACING_BAND.max)).toBe(1)
  })
})

describe('air spacing aim', () => {
  function buildPolicy() {
    const spacing = createAirSpacingPolicy({ lagMs: 1500, lateralOffset: 3 })
    // Four samples one second apart along +x: the lag window lands on the first
    // sample, and the recent window has enough samples to build a tangent.
    spacing.push({ at: 0, position: { x: 0, y: 80, z: 0 }, velocity: { x: 0.5, y: 0, z: 0 } })
    spacing.push({ at: 1000, position: { x: 10, y: 80, z: 0 }, velocity: { x: 0.5, y: 0, z: 0 } })
    spacing.push({ at: 1500, position: { x: 15, y: 80, z: 0 }, velocity: { x: 0.5, y: 0, z: 0 } })
    spacing.push({ at: 2000, position: { x: 20, y: 80, z: 0 }, velocity: { x: 0.5, y: 0, z: 0 } })
    return spacing
  }

  it('follows a lagged point with a lateral offset', () => {
    const spacing = buildPolicy()
    const aim = spacing.aimAt(2000, { x: 20, y: 80, z: 5 })!
    expect(aim.source).toBe('lag')
    // The lag window (2000 - 1500 = 500) selects the first sample at x = 0.
    expect(aim.point.x).toBeCloseTo(0, 5)
    // The lateral offset is perpendicular to the +x tangent, so it stays on z.
    expect(Math.abs(aim.point.z)).toBeCloseTo(3, 5)
    expect(aim.tangent.x).toBeGreaterThan(0.9)
  })

  it('holds the tangent and side when the target slows down', () => {
    const spacing = createAirSpacingPolicy({ lagMs: 100, lateralOffset: 3 })
    spacing.push({ at: 0, position: { x: 0, y: 80, z: 0 }, velocity: { x: 0.5, y: 0, z: 0 } })
    spacing.push({ at: 1000, position: { x: 10, y: 80, z: 0 }, velocity: { x: 0.5, y: 0, z: 0 } })
    const first = spacing.aimAt(1000, { x: 10.2, y: 80, z: 0 })!
    // The target stops: the newest sample has zero speed.
    spacing.push({ at: 1100, position: { x: 10, y: 80, z: 0 }, velocity: { x: 0, y: 0, z: 0 } })
    const second = spacing.aimAt(1100, { x: 10, y: 80, z: 0 })!
    expect(second.tangent.x).toBeCloseTo(first.tangent.x, 5)
    expect(second.tangent.z).toBeCloseTo(first.tangent.z, 5)
  })
})

describe('planRendezvous', () => {
  const history = [{ at: 1000, position: { x: 100, y: 80, z: 0 }, velocity: { x: 0.3, y: 0, z: 0 } }]

  it('bounds the horizon by age and maneuver strength', () => {
    const plan = planRendezvous({
      self: { x: 0, y: 80, z: 0 },
      history,
      now: 1100,
      band: DEFAULT_AIR_SPACING_BAND,
      targetAgeMs: 100,
      targetSpeed: 0.3,
    })!
    expect(plan.bounded).toBe(true)
    // The rendezvous sits behind the predicted point by the band maximum, so it
    // is reachable instead of copying the target's exact gap. The predicted
    // point is ~105.7, so the rendezvous is pulled back toward the follower.
    expect(plan.point.x).toBeGreaterThan(0)
    expect(plan.point.x).toBeLessThan(history[0].position.x + 0.3 * 20)
  })

  it('is unbounded when the sample is fresh, slow and the horizon is short', () => {
    const plan = planRendezvous({
      self: { x: 0, y: 80, z: 0 },
      history,
      now: 1000,
      band: DEFAULT_AIR_SPACING_BAND,
      targetAgeMs: 0,
      targetSpeed: 0,
      maxHorizonMs: 1000,
    })!
    expect(plan.bounded).toBe(false)
    expect(plan.horizonMs).toBe(1000)
  })

  it('returns undefined without history', () => {
    expect(planRendezvous({
      self: { x: 0, y: 80, z: 0 },
      history: [],
      now: 0,
      band: DEFAULT_AIR_SPACING_BAND,
      targetAgeMs: 0,
      targetSpeed: 0,
    })).toBeUndefined()
  })
})

describe('corridor roles', () => {
  const corridor = {
    transit: [region([0, 60, 0], [10, 100, 10])],
    track: [region([20, 60, 0], [40, 100, 10])],
    landing: [region([30, 60, 0], [35, 100, 5])],
  }

  it('resolves the most specific role for a point', () => {
    expect(corridorRoleOf(corridor, { x: 5, y: 70, z: 5 })).toBe('transit')
    expect(corridorRoleOf(corridor, { x: 25, y: 70, z: 5 })).toBe('track')
    // The landing region overlaps the track region and outranks it.
    expect(corridorRoleOf(corridor, { x: 32, y: 70, z: 3 })).toBe('landing')
    expect(corridorRoleOf(corridor, { x: 99, y: 70, z: 5 })).toBe('outside')
  })

  it('never auto-lands inside a track region just because the band was entered', () => {
    expect(corridorAllowsAutoLand('track')).toBe(false)
    expect(corridorAllowsAutoLand('transit')).toBe(false)
    expect(corridorAllowsAutoLand('landing')).toBe(true)
    expect(corridorAllowsAutoLand('outside')).toBe(false)
  })
})

describe('acceptAirFollowUpdate', () => {
  const base = { sessionId: 's-1', targetUuid: 'u-1', revision: 1, validUntilTick: 100, phase: 'air-track' }

  it('rejects a stale revision, a different session and an expired lease', () => {
    expect(acceptAirFollowUpdate(base, { ...base, revision: 2 }, 0)).toBe(true)
    expect(acceptAirFollowUpdate(base, { ...base, revision: 1 }, 0)).toBe(false)
    expect(acceptAirFollowUpdate(base, { ...base, revision: 2, sessionId: 's-2' }, 0)).toBe(false)
    expect(acceptAirFollowUpdate(base, { ...base, revision: 2, targetUuid: 'u-2' }, 0)).toBe(false)
    expect(acceptAirFollowUpdate(base, { ...base, revision: 2, validUntilTick: 5 }, 10)).toBe(false)
  })

  it('accepts the first update', () => {
    expect(acceptAirFollowUpdate(undefined, base, 0)).toBe(true)
  })
})
