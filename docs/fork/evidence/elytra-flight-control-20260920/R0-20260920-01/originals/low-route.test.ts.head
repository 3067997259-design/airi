import type { MovementControlPort } from '../movement/port'
import type { SnapshotEntry } from '../movement/snapshot'
import type { Vec3 } from '../movement/types'

import { describe, expect, it } from 'vitest'

import { candidatesOfSegment, LOW_ROUTE_MAX_CELLS, LOW_ROUTE_MIN_CLEARANCE, planLowRoute, slotInColumn, walkLowRoute } from './low-route'

/** One column of blocks between `bottom` and `top`, with `solid` deciding each y. */
function column(x: number, z: number, bottom: number, top: number, solid: (y: number) => boolean): SnapshotEntry[] {
  const entries: SnapshotEntry[] = []
  for (let y = bottom; y <= top; y++)
    entries.push({ x, y, z, id: solid(y) ? 'minecraft:stone' : 'minecraft:air' })
  return entries
}

describe('slotInColumn', () => {
  it('finds the air band under a ceiling, descending from the glider', () => {
    // Water at 62, slab from 75, glider at 74: the band is the channel below the
    // slab, not the open sky above it and not any cave under the river bed.
    const entries = column(0, 0, 40, 90, y => y <= 62 || (y >= 75 && y <= 80))
    expect(slotInColumn(entries, { startY: 74, bottomY: 40, topY: 90 }))
      .toEqual({ surface: 62, ceiling: 75, clearance: 12, bandY: 64 })
  })

  it('ignores a cave under the surface', () => {
    // Ground to 62, a cave 40..50, and open sky above: the glider joins the
    // surface air, never the hole 20 blocks below it.
    const entries = column(0, 0, 40, 90, y => (y <= 62 && (!(y >= 40) || !(y <= 50))))
    expect(slotInColumn(entries, { startY: 74, bottomY: 40, topY: 90 }))
      .toEqual({ surface: 62, clearance: 28, bandY: 64 })
  })

  it('refuses a slot that is too short to fly through', () => {
    const entries = column(0, 0, 40, 90, y => y <= 62 || y >= 65)
    expect(slotInColumn(entries, { startY: 74, bottomY: 40, topY: 90 })).toBeUndefined()
  })

  it('treats an unread cell as unknown rather than as air', () => {
    const entries = column(0, 0, 40, 90, y => y <= 62).filter(entry => entry.y !== 70)
    expect(slotInColumn(entries, { startY: 74, bottomY: 40, topY: 90 })).toBeUndefined()
  })

  it('marks a column whose wall reaches the glider as impassable', () => {
    const entries = column(0, 0, 40, 90, () => true)
    expect(slotInColumn(entries, { startY: 74, bottomY: 40, topY: 90 })).toBeUndefined()
  })

  it('keeps the band below the ceiling requirement instead of just above the floor', () => {
    // A 3-high slot under a ceiling at 66, entered from inside the slot.
    const entries = column(0, 0, 40, 90, y => y <= 62 || y >= 66)
    expect(slotInColumn(entries, { startY: 64, bottomY: 40, topY: 90 }))
      .toEqual({ surface: 62, ceiling: 66, clearance: 3, bandY: 63 })
  })
})

describe('walkLowRoute', () => {
  const point = (ahead: number, bandY: number, lateral = 0) => ({
    ahead,
    lateral,
    x: 0,
    z: ahead,
    surface: bandY - 2,
    clearance: 4,
    bandY,
  })

  it('follows a descending valley floor', () => {
    const walk = walkLowRoute({
      points: [point(4, 64), point(8, 62), point(12, 60)],
      span: 12,
      step: 4,
      startBandY: 66,
    })
    expect(walk.waypoint).toEqual({ x: 0.5, y: 60, z: 12.5 })
    expect(walk.bandY).toBe(60)
    expect(walk.reached).toBe(12)
  })

  it('stops at a step with no flyable column', () => {
    const walk = walkLowRoute({ points: [point(4, 64), point(12, 60)], span: 12, step: 4, startBandY: 64 })
    expect(walk.reached).toBe(4)
    expect(walk.waypoint).toEqual({ x: 0.5, y: 64, z: 4.5 })
  })

  it('refuses a jump the band cannot follow', () => {
    // A slot 20 blocks higher is a cliff, not a route: the walk stops before it.
    const walk = walkLowRoute({ points: [point(4, 64), point(8, 84)], span: 8, step: 4, startBandY: 64 })
    expect(walk.reached).toBe(4)
  })
})

describe('candidatesOfSegment', () => {
  it('samples columns across the width and keeps the flyable ones', () => {
    const entries: SnapshotEntry[] = []
    for (let dx = -4; dx <= 4; dx++) {
      for (let dz = 0; dz <= 20; dz++) {
        // A wall on the east half: those columns have no slot.
        const wall = dx >= 2
        entries.push(...column(dx, dz, 40, 90, y => y <= 62 || (wall && y <= 90)))
      }
    }
    const points = candidatesOfSegment(entries, { x: 0, z: 0 }, { dirX: 0, dirZ: 1 }, { bottomY: 55, topY: 90, startY: 74 })
    expect(points.length).toBeGreaterThan(0)
    // The wall occupies x >= 2, so no sampled column may come from it.
    expect(points.every(entry => entry.x < 2)).toBe(true)
  })
})

describe('planLowRoute', () => {
  /** A port that serves a synthetic valley: ground at 62, a ceiling from 75. */
  function fakePort(options: { ceilingFrom?: number, wallAt?: number, fail?: boolean }) {
    const reads: Array<{ from: Vec3, to: Vec3 }> = []
    const port = {
      async getBlocksRegion(from: Vec3, to: Vec3): Promise<SnapshotEntry[]> {
        reads.push({ from, to })
        if (options.fail)
          throw new Error('no_server')
        const entries: SnapshotEntry[] = []
        for (let x = from.x; x <= to.x; x++) {
          for (let z = from.z; z <= to.z; z++) {
            for (let y = from.y; y <= to.y; y++) {
              const wall = options.wallAt !== undefined && z >= options.wallAt
              // A slab, not a solid sky: 6 layers, so the air below it is a slot.
              const ceiling = options.ceilingFrom !== undefined && y >= options.ceilingFrom && y <= options.ceilingFrom + 5
              const solid = y <= 62 || wall || ceiling
              entries.push({ x, y, z, id: solid ? 'minecraft:stone' : 'minecraft:air' })
            }
          }
        }
        return entries
      },
    } as unknown as MovementControlPort
    return { port, reads }
  }

  const self: Vec3 = { x: 0, y: 78, z: 0 }
  const goal: Vec3 = { x: 0, y: 64, z: 380 }

  it('plans a low route to a far goal and keeps the band under a ceiling', async () => {
    const { port } = fakePort({ ceilingFrom: 75 })
    // Under the slab, over the water: the route must find the channel below it.
    const plan = await planLowRoute({ port, self: { x: 0, y: 70, z: 0 }, goal })
    expect(plan.status).toBe('planned')
    expect(plan.reached).toBeGreaterThan(0)
    expect(plan.bandY).toBeLessThan(75 - LOW_ROUTE_MIN_CLEARANCE + 1)
    expect(plan.waypoint!.z).toBeGreaterThan(0)
  })

  it('stops the route at a wall that has no slot', async () => {
    const { port } = fakePort({ wallAt: 40 })
    const plan = await planLowRoute({ port, self, goal })
    expect(plan.status).toBe('planned')
    expect(plan.reached).toBeLessThan(96)
  })

  it('reports a failed read instead of inventing a route', async () => {
    const { port } = fakePort({ fail: true })
    const plan = await planLowRoute({ port, self, goal })
    expect(plan.status).toBe('read_failed')
    expect(plan.waypoint).toBeUndefined()
  })

  it('keeps every read inside the bridge cell cap, diagonal headings included', async () => {
    // A diagonal goal widens the segment box in both axes, and the wide drop
    // makes it tall too: the window has to shrink itself to stay readable.
    const { port, reads } = fakePort({ ceilingFrom: 75 })
    await planLowRoute({ port, self, goal: { x: 260, y: 64, z: 280 } })
    expect(reads.length).toBeGreaterThan(0)
    for (const read of reads) {
      const volume = (read.to.x - read.from.x + 1) * (read.to.y - read.from.y + 1) * (read.to.z - read.from.z + 1)
      expect(volume).toBeLessThanOrEqual(LOW_ROUTE_MAX_CELLS)
    }
  })

  it('still sees the valley floor from high above it', async () => {
    // ROOT CAUSE (live, 2026-09-18): with a 40-block drop, a run that had climbed
    // to y=130 could not see the river at y=62, found no low slot, and locked onto
    // the cliff top it could see (band 109), then kept climbing.
    const { port } = fakePort({ ceilingFrom: 200 })
    const plan = await planLowRoute({ port, self: { x: 0, y: 130, z: 0 }, goal: { x: 0, y: 64, z: 380 } })
    expect(plan.status).toBe('planned')
    expect(plan.bandY).toBeLessThan(70)
  })

  it('caps the scan under a roof over the goal', async () => {
    // Live 2026-09-19 (E-02 canyon): the endpoint sits in a roofed cave at
    // y=65 under glass at y=85. The roofY cap enters every column from below
    // the roof, so even a glider at y=130 plans a band it can hold under the
    // roof instead of overflying the glass.
    const { port } = fakePort({ ceilingFrom: 200 })
    const plan = await planLowRoute({ port, self: { x: 0, y: 130, z: 0 }, goal: { x: 0, y: 65, z: 380 }, roofY: 85 })
    expect(plan.status).toBe('planned')
    expect(plan.bandY).toBeLessThanOrEqual(84)
  })
})

describe('roof-capped slot mechanics', () => {
  it('enters the cave column from below the glass, not onto its top', () => {
    // The endpoint column of the live venue: floor 64, cave air 65..84,
    // glass 85, open above. Entered from y=130 the slot is the roof top;
    // entered from under the roof it is the cave itself.
    const cave = column(0, 0, 40, 132, y => y === 64 || y === 85 ? true : y < 64)
    const fromAbove = slotInColumn(cave, { startY: 130, bottomY: 40, topY: 132 })
    expect(fromAbove?.surface).toBe(85)
    const fromUnder = slotInColumn(cave, { startY: 84, bottomY: 40, topY: 132 })
    expect(fromUnder?.surface).toBe(64)
    expect(fromUnder?.bandY).toBeLessThanOrEqual(66)
  })

  it('a goal-anchored scan (startY = goal.y + 1) finds the cave interior through a multi-layer ceiling', () => {
    // User insight (2026-09-19): anchor the scan to the goal's own altitude.
    // Column: floor 60-64, cave air 65-74, obsidian 75-80, gap air 81-84,
    // glass 85, open above. Entering at startY=goal.y+1=66 finds the cave
    // interior directly, regardless of the ceiling layers above.
    const withCeiling: SnapshotEntry[] = []
    for (let y = 40; y <= 132; y++) {
      const solid = y < 65 || (y >= 75 && y <= 80) || y === 85
      withCeiling.push({ x: 0, y, z: 0, id: solid ? 'minecraft:obsidian' : 'minecraft:air' })
    }
    // From the glider's altitude: surface = 85 (glass), wrong slot.
    const fromGlider = slotInColumn(withCeiling, { startY: 130, bottomY: 40, topY: 132 })
    expect(fromGlider?.surface).toBe(85)

    // From the goal's altitude: surface = 64 (cave floor), correct slot.
    const fromGoal = slotInColumn(withCeiling, { startY: 66, bottomY: 40, topY: 132 })
    expect(fromGoal?.surface).toBe(64)
    expect(fromGoal?.ceiling).toBe(75)
    expect(fromGoal?.bandY).toBeLessThanOrEqual(67)
  })

  it('a goal-anchored scan over open terrain finds the same slot as the glider scan', () => {
    // Flat ground at 64, open sky: the goal altitude and the glider altitude
    // both find the same surface slot.
    const flat = column(0, 0, 40, 132, y => y < 64)
    const fromGlider = slotInColumn(flat, { startY: 130, bottomY: 40, topY: 132 })
    const fromGoal = slotInColumn(flat, { startY: 66, bottomY: 40, topY: 132 })
    expect(fromGoal?.surface).toBe(fromGlider?.surface)
    expect(fromGoal?.bandY).toBe(fromGlider?.bandY)
  })
})

describe('lateral connectivity walk', () => {
  /**
   * ROOT CAUSE (user review, 2026-09-19): the walk was purely greedy. A
   * candidate in a sealed underground cave at the goal's altitude was accepted
   * because the band delta was within limits, even though the cave's column
   * has solid rock at the current band altitude (no air pocket extends there).
   * The fix checks that the candidate's column has air at the current band.
   */
  it('rejects a candidate whose column is solid at the current band altitude', () => {
    // Surface channel at band 66, then an underground cave also at 66 but
    // separated by solid rock at the surface level.
    const points = [
      { x: 0, z: 4, surface: 62, y: 66, bandY: 66, lateral: 0, clearance: 10, ahead: 4 },
      { x: 0, z: 8, surface: 62, y: 66, bandY: 66, lateral: 0, clearance: 10, ahead: 8 },
    ]
    // Column (0,4) has air at 66 (surface channel); column (0,8) has solid
    // at 66 (underground cave sealed from the surface path).
    const columns = new Map<string, SnapshotEntry[]>([
      ['0,4', column(0, 4, 40, 100, y => y < 62 || y > 70)],
      ['0,8', column(0, 8, 40, 100, () => true)], // all solid: no air anywhere
    ])
    const walk = walkLowRoute({ points, span: 8, step: 4, startBandY: 66, columns })
    // The first step (0,4) connects (air at 66). The second step (0,8) is
    // rejected: its column has no air at band 66.
    expect(walk.reached).toBe(4)
    expect(walk.accepted).toHaveLength(1)
  })

  it('accepts consecutive candidates when air extends through all columns', () => {
    const points = [
      { x: 0, z: 4, surface: 62, y: 66, bandY: 66, lateral: 0, clearance: 10, ahead: 4 },
      { x: 0, z: 8, surface: 62, y: 66, bandY: 66, lateral: 0, clearance: 10, ahead: 8 },
    ]
    // Both columns have air at 66 (continuous surface channel).
    const columns = new Map<string, SnapshotEntry[]>([
      ['0,4', column(0, 4, 40, 100, y => y < 62 || y > 70)],
      ['0,8', column(0, 8, 40, 100, y => y < 62 || y > 70)],
    ])
    const walk = walkLowRoute({ points, span: 8, step: 4, startBandY: 66, columns })
    expect(walk.reached).toBe(8)
    expect(walk.accepted).toHaveLength(2)
  })

  it('without column data the walk falls back to the greedy behavior (compatibility)', () => {
    const points = [
      { x: 0, z: 4, surface: 62, y: 66, bandY: 66, lateral: 0, clearance: 10, ahead: 4 },
      { x: 0, z: 8, surface: 62, y: 66, bandY: 66, lateral: 0, clearance: 10, ahead: 8 },
    ]
    const walk = walkLowRoute({ points, span: 8, step: 4, startBandY: 66 })
    expect(walk.reached).toBe(8)
    expect(walk.accepted).toHaveLength(2)
  })
})
