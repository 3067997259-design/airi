import type { SnapshotEntry } from './snapshot'
import type { CollisionBox } from './types'

import { describe, expect, it } from 'vitest'

import { MAX_JUMP_RISE, planStepUp, simulateFlight, SPRINT_SPEED, WALK_SPEED } from './jump-plan'
import { createSnapshot } from './snapshot'
import { DEFAULT_MOVEMENT_CONFIG } from './types'

const FULL: CollisionBox = { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }

/** Compact world: full cubes where listed, air everywhere else. */
function solidWorld(solids: Array<{ x: number, y: number, z: number, collision?: CollisionBox[] }>) {
  const entries: SnapshotEntry[] = solids.map(solid => ({
    x: solid.x,
    y: solid.y,
    z: solid.z,
    id: 'minecraft:stone',
    collision: solid.collision ?? [FULL],
  }))
  return createSnapshot(entries, { exactShapes: true })
}

describe('jump flight simulation', () => {
  it('matches the vanilla one-block hop: nine ticks of airtime', () => {
    expect(simulateFlight(1, WALK_SPEED)).toEqual({ ticks: 9, distance: WALK_SPEED * 9 })
    expect(simulateFlight(1, SPRINT_SPEED).distance).toBeGreaterThan(simulateFlight(1, WALK_SPEED).distance)
  })

  it('covers less ground for a higher landing', () => {
    expect(simulateFlight(1.25, WALK_SPEED).distance).toBeLessThan(simulateFlight(1, WALK_SPEED).distance)
  })
})

describe('planStepUp', () => {
  const config = DEFAULT_MOVEMENT_CONFIG
  // A flat stone floor at y = 0..7 for the test area, one block up at (1,1,0).
  function flatGround(extra: Array<{ x: number, y: number, z: number, collision?: CollisionBox[] }> = []) {
    const solids: Array<{ x: number, y: number, z: number, collision?: CollisionBox[] }> = []
    for (let x = -3; x <= 8; x++) {
      for (let z = -3; z <= 3; z++)
        solids.push({ x, y: 0, z })
    }
    return solidWorld([...solids, ...extra])
  }

  it('accepts a one-block straight step and puts the takeoff behind the source', () => {
    const world = flatGround([{ x: 1, y: 1, z: 0 }])
    const plan = planStepUp({ from: { x: 0.5, y: 1, z: 0.5 }, to: { x: 1.5, y: 2, z: 0.5 }, world, config })
    expect(plan.ok).toBe(true)
    if (!plan.ok)
      return
    expect(plan.sprint).toBe(false)
    expect(plan.flight).toBeCloseTo(WALK_SPEED * 9, 6)
    // The flight is longer than the gap, so the line sits behind the source.
    expect(plan.takeoff.x).toBeLessThan(0.5)
    expect(plan.takeoff.y).toBe(1)
    expect(plan.direction).toMatchObject({ x: 1, z: 0 })
  })

  it('accepts a diagonal step the same way', () => {
    const world = flatGround([{ x: 1, y: 1, z: 1 }])
    const plan = planStepUp({ from: { x: 0.5, y: 1, z: 0.5 }, to: { x: 1.5, y: 2, z: 1.5 }, world, config })
    expect(plan.ok).toBe(true)
    if (!plan.ok)
      return
    expect(plan.gap).toBeCloseTo(Math.SQRT2, 6)
    expect(plan.direction.x).toBeCloseTo(Math.SQRT1_2, 6)
    expect(plan.direction.z).toBeCloseTo(Math.SQRT1_2, 6)
  })

  it('rejects a rise above the jump clearance', () => {
    const world = flatGround([{ x: 1, y: 1, z: 0 }, { x: 1, y: 2, z: 0 }])
    const plan = planStepUp({ from: { x: 0.5, y: 1, z: 0.5 }, to: { x: 1.5, y: 3, z: 0.5 }, world, config })
    expect(plan).toMatchObject({ ok: false, reason: 'too-high' })
    expect(MAX_JUMP_RISE).toBeLessThan(2)
  })

  it('rejects a gap beyond the sprint reach', () => {
    const world = flatGround([{ x: 5, y: 1, z: 0 }])
    const plan = planStepUp({ from: { x: 0.5, y: 1, z: 0.5 }, to: { x: 5.5, y: 2, z: 0.5 }, world, config })
    expect(plan).toMatchObject({ ok: false, reason: 'too-far' })
  })

  // A sprint is only required beyond cell-center gaps at this rise: a walk hop
  // already covers 2.0 with the landing tolerance, and the next cell-center gap
  // (2.83) exceeds the sprint reach. The branch stays for finer geometry.
  it('rejects a two-cell diagonal as beyond the sprint reach', () => {
    const world = flatGround([{ x: 2, y: 1, z: 2 }])
    const plan = planStepUp({ from: { x: 0.5, y: 1, z: 0.5 }, to: { x: 2.5, y: 2, z: 2.5 }, world, config })
    expect(plan).toMatchObject({ ok: false, reason: 'too-far' })
  })

  // ROOT CAUSE (combo fixture, the final two-cell gap):
  //
  // planStepUp rejected every level edge with `not-a-jump`, so a gap the
  // planner's own parkour move generated had no jump plan at all. The follower
  // walked to the edge, stalled, and the run ended `unreachable` even though
  // the far pad was three cells away and reachable with a sprint.
  it('accepts a level two-cell gap and names the sprint it needs', () => {
    const world = flatGround([{ x: 2, y: 1, z: 0 }])
    const plan = planStepUp({ from: { x: 0.5, y: 2, z: 0.5 }, to: { x: 2.5, y: 2, z: 0.5 }, world, config })
    expect(plan.ok).toBe(true)
    if (!plan.ok)
      return
    expect(plan.rise).toBe(0)
    expect(plan.gap).toBeCloseTo(2, 6)
    expect(plan.sprint).toBe(true)
    expect(plan.target).toMatchObject({ x: 2.5, y: 2, z: 0.5 })
  })

  it('accepts a level three-cell gap with the sprint boost', () => {
    const world = flatGround([{ x: 3, y: 1, z: 0 }])
    const plan = planStepUp({ from: { x: 0.5, y: 2, z: 0.5 }, to: { x: 3.5, y: 2, z: 0.5 }, world, config })
    expect(plan.ok).toBe(true)
    if (!plan.ok)
      return
    expect(plan.gap).toBeCloseTo(3, 6)
    // The boost makes 3.0 feasible: without it the sprint reach stops at 2.22.
    expect(plan.sprint).toBe(true)
    expect(plan.flight).toBeGreaterThan(3)
  })

  it('rejects a level gap beyond the sprint reach', () => {
    const world = flatGround([{ x: 6, y: 1, z: 0 }])
    const plan = planStepUp({ from: { x: 0.5, y: 2, z: 0.5 }, to: { x: 6.5, y: 2, z: 0.5 }, world, config })
    expect(plan).toMatchObject({ ok: false, reason: 'too-far' })
  })

  it('rejects a level gap whose far side has no support', () => {
    // The destination cell holds a plant (no collision, floor level): the
    // flight would drop into the gap instead of landing on the foot level.
    const world = flatGround([{ x: 3, y: 1, z: 0, collision: [] }])
    const plan = planStepUp({ from: { x: 0.5, y: 2, z: 0.5 }, to: { x: 3.5, y: 2, z: 0.5 }, world, config })
    expect(plan).toMatchObject({ ok: false, reason: 'no-landing' })
  })

  it('rejects a destination without a support at its foot level', () => {
    // The cell below the destination holds a plant (no collision, floor level):
    // the stand point has no support at its foot level.
    const world = solidWorld([
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 1, z: 0, collision: [] },
    ])
    const plan = planStepUp({ from: { x: 0.5, y: 1, z: 0.5 }, to: { x: 1.5, y: 2, z: 0.5 }, world, config })
    expect(plan).toMatchObject({ ok: false, reason: 'no-landing' })
  })

  // ROOT CAUSE (combo fixture staircase, edge (91,79,-26) -> (92,80,-27)):
  //
  // The flight sweep rejected this hop while every live run climbed it. The
  // rejection stayed hidden because the executor still had the discrete retry
  // as a fallback. That retry is gone now, so a false positive here ends the
  // run. The column beside the landing rises two above the foot level, and the
  // hop passes south of it.
  it('accepts a staircase hop beside a column that rises above the landing', () => {
    const world = flatGround([
      { x: 91, y: 78, z: -26 },
      { x: 92, y: 79, z: -27 },
      { x: 92, y: 79, z: -26 },
      { x: 92, y: 80, z: -26 },
      { x: 92, y: 81, z: -26 },
      { x: 92, y: 81, z: -25 },
      { x: 93, y: 80, z: -26 },
    ])
    const plan = planStepUp({ from: { x: 91.5, y: 79, z: -25.5 }, to: { x: 92.5, y: 80, z: -26.5 }, world, config })
    expect(plan.ok, plan.ok ? '' : `${plan.reason}: ${plan.detail}`).toBe(true)
  })

  // The mid-flight sweep is gone: it rejected a hop that slides along a wall\n  // face. A wall that fills the landing space is still rejected here, and the\n  // mod's predictor owns every flight that only grazes a wall.\n  it('rejects a wall that fills the landing space', () => {\n    const world = flatGround([{ x: 1, y: 1, z: 0 }, { x: 1, y: 2, z: 0 }, { x: 2, y: 2, z: 0 }, { x: 2, y: 3, z: 0 }])\n    const plan = planStepUp({ from: { x: 0.5, y: 1, z: 0.5 }, to: { x: 1.5, y: 2, z: 0.5 }, world, config })\n    expect(plan).toMatchObject({ ok: false, reason: 'no-headroom' })\n  })

  it('rejects a ceiling above the destination', () => {
    const world = flatGround([{ x: 1, y: 1, z: 0 }, { x: 1, y: 3, z: 0 }, { x: 1, y: 4, z: 0 }])
    const plan = planStepUp({ from: { x: 0.5, y: 1, z: 0.5 }, to: { x: 1.5, y: 2, z: 0.5 }, world, config })
    expect(plan).toMatchObject({ ok: false, reason: 'no-headroom' })
  })
})
