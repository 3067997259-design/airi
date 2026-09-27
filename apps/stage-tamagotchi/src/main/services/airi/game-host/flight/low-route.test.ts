import type { MovementControlPort } from '../movement/port'
import type { SnapshotEntry } from '../movement/snapshot'
import type { Vec3 } from '../movement/types'

import { describe, expect, it } from 'vitest'

import { candidatesOfSegment, crossingOfSection, extractCrossSection, insideSection, LOW_ROUTE_MAX_CELLS, LOW_ROUTE_MIN_CLEARANCE, parseCrossSections, planLowRoute, shrinkCrossSection, slotInColumn, walkLowRoute } from './low-route'

describe('crossSection', () => {
  it('interpolates the crossing point and reports whether it is inside', () => {
    const path: Vec3[] = [{ x: 0, y: 70, z: 0 }, { x: 4, y: 74, z: 0 }]
    const section = { axis: 'x' as const, at: 2, lateralMin: -1, lateralMax: 1, yMin: 69, yMax: 75 }
    const crossing = crossingOfSection(path, section)!
    expect(crossing.x).toBeCloseTo(2)
    expect(crossing.y).toBeCloseTo(72)
    expect(crossing.inside).toBe(true)
    expect(crossingOfSection(path, { ...section, yMin: 73, yMax: 75 })!.inside).toBe(false)
  })

  it('reports no crossing when the path never reaches the plane', () => {
    const path: Vec3[] = [{ x: 0, y: 70, z: 0 }, { x: 1, y: 70, z: 0 }]
    expect(crossingOfSection(path, { axis: 'x', at: 2, lateralMin: -1, lateralMax: 1, yMin: 69, yMax: 71 })).toBeUndefined()
  })

  it('shrinks a section on every side', () => {
    const shrunk = shrinkCrossSection({ axis: 'z', at: 60, lateralMin: -4, lateralMax: 4, yMin: 65, yMax: 73 }, 1.5)
    expect(shrunk.lateralMin).toBeCloseTo(-2.5)
    expect(shrunk.lateralMax).toBeCloseTo(2.5)
    expect(shrunk.yMin).toBeCloseTo(66.5)
    expect(shrunk.yMax).toBeCloseTo(71.5)
    expect(insideSection({ x: 0, y: 70, z: 60 }, shrunk)).toBe(true)
    expect(insideSection({ x: 0, y: 73, z: 60 }, shrunk)).toBe(false)
  })

  it('extracts the widest opening from terrain and shrinks it', () => {
    // A 7-wide (z 57..63), 6-tall (y 66..71) hole in an otherwise solid wall
    // at x=0, with a narrower 2-tall band inside it.
    const cells = new Map<string, string>()
    for (let z = 55; z <= 65; z++) {
      for (let y = 63; y <= 74; y++) {
        const open = Math.abs(z - 60) <= 3 && y >= 66 && y <= 71
        cells.set(`0,${y},${z}`, open ? 'minecraft:air' : 'minecraft:stone')
      }
    }
    const section = extractCrossSection({ cells, axis: 'x', at: 0, lateralFrom: 55, lateralTo: 65, yFrom: 63, yTo: 74, margin: 0.5 })!
    expect(section.axis).toBe('x')
    // The hole is z 57..63, y 66..71; after the 0.5 shrink the section stays
    // inside it and still contains its centre.
    expect(section.yMin).toBeGreaterThanOrEqual(66)
    expect(section.yMax).toBeLessThanOrEqual(71)
    expect(section.lateralMin).toBeGreaterThanOrEqual(57)
    expect(section.lateralMax).toBeLessThanOrEqual(63)
    expect(section.lateralMax - section.lateralMin).toBeGreaterThanOrEqual(5)
    expect(insideSection({ x: 0, y: 68, z: 60 }, section)).toBe(true)
    // Unread columns are not openings: a query reaching past the read region
    // must not widen the section into unknown space.
    const far = extractCrossSection({ cells, axis: 'x', at: 0, lateralFrom: 40, lateralTo: 90, yFrom: 63, yTo: 74, margin: 0.5 })!
    expect(far.lateralMin).toBeGreaterThanOrEqual(55)
    expect(far.lateralMax).toBeLessThanOrEqual(65)
  })

  it('returns undefined when the opening is smaller than the margin', () => {
    const cells = new Map<string, string>()
    cells.set('0,70,60', 'minecraft:air')
    expect(extractCrossSection({ cells, axis: 'x', at: 0, lateralFrom: 0, lateralTo: 0, yFrom: 70, yTo: 70, margin: 1 })).toBeUndefined()
  })

  it('parses diagnostic specs and drops invalid entries', () => {
    expect(parseCrossSections('z:60:-6:6:63:74;x:-1004:60:64:68:72')).toEqual([
      { axis: 'z', at: 60, lateralMin: -6, lateralMax: 6, yMin: 63, yMax: 74 },
      { axis: 'x', at: -1004, lateralMin: 60, lateralMax: 64, yMin: 68, yMax: 72 },
    ])
    expect(parseCrossSections('nope;z:60:6:-6:63:74;z:60:-6:6:74:63;')).toEqual([])
    expect(parseCrossSections(undefined)).toEqual([])
  })
})

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
  function fakePort(options: { ceilingFrom?: number, wallAt?: number, gap?: { y0: number, y1: number }, fail?: boolean }) {
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
                && (options.gap === undefined || !(y >= options.gap.y0) || !(y <= options.gap.y1))
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

  it('verifies a channel whose inflated body ends below the ceiling voxel', async () => {
    // ROOT CAUSE:
    // Inclusive ceil(bodyTop) sampled the untouched ceiling at 66. The
    // route at feet 63.5 ends at 65.45 including its safety inflation.
    const { port } = fakePort({ ceilingFrom: 66 })
    const plan = await planLowRoute({ port, self: { x: 0, y: 63.5, z: 0 }, goal: { x: 0, y: 63.5, z: 20 } })
    expect(plan.status).toBe('planned')
    expect(plan.channelPath!.length).toBeGreaterThan(1)
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
    expect(plan.bandY).toBeLessThanOrEqual(67)
  })

  it('crosses a must-pass section under the slab instead of routing over it', async () => {
    // ab-30 plan §1: an open-sky candidate must not preempt a covered one.
    // The whole slot (y 63..74) is the opening, so any under-slab route
    // through z=20 is a valid crossing.
    const { port } = fakePort({ ceilingFrom: 75 })
    const section = { axis: 'z' as const, at: 20, lateralMin: -6, lateralMax: 6, yMin: 63, yMax: 74 }
    const plan = await planLowRoute({ port, self: { x: 0, y: 70, z: 0 }, goal, mustPass: [section] })
    expect(plan.status).toBe('planned')
    const crossing = crossingOfSection(plan.channelPath!, section)
    expect(crossing).toBeDefined()
    expect(crossing!.inside).toBe(true)
    expect(crossing!.y).toBeLessThan(75)
  })

  it('refuses with no_section_path when the section cannot be reached', async () => {
    const { port } = fakePort({ wallAt: 40 })
    const section = { axis: 'z' as const, at: 60, lateralMin: -6, lateralMax: 6, yMin: 63, yMax: 74 }
    const blocked = await planLowRoute({ port, self, goal, mustPass: [section] })
    expect(blocked.status).toBe('blocked')
    expect(blocked.reason).toMatch(/^no_section_path/)
    // Control: the same wall without the constraint still yields a local plan.
    const control = await planLowRoute({ port, self, goal })
    expect(control.status).toBe('planned')
  })

  it('decomposes a must-pass leg and marks frontier handovers as through', async () => {
    // ab-30 plan §2: the client must be able to tell a handover point from the
    // trip's end, and the leg must say what is inside the opening and what
    // continues after it.
    const { port } = fakePort({ ceilingFrom: 75 })
    const entry = { axis: 'z' as const, at: 8, lateralMin: -6, lateralMax: 6, yMin: 63, yMax: 74 }
    const exit = { axis: 'z' as const, at: 16, lateralMin: -6, lateralMax: 6, yMin: 63, yMax: 74 }
    const plan = await planLowRoute({ port, self: { x: 0, y: 70, z: 0 }, goal, mustPass: [entry, exit], speed: 1.6 })
    expect(plan.status).toBe('planned')
    expect(plan.waypointKind).toBe('through')
    expect(plan.leg!.entry).toEqual(entry)
    expect(plan.leg!.exit).toEqual(exit)
    expect(plan.leg!.approach.length).toBeGreaterThan(0)
    expect(plan.leg!.interior.length).toBeGreaterThan(0)
    expect(plan.leg!.suffix.length).toBeGreaterThan(0)
    // The interior lies between the two planes.
    for (const point of plan.leg!.interior)
      expect(point.z).toBeGreaterThanOrEqual(8 - 1)
    for (const point of plan.leg!.suffix)
      expect(point.z).toBeGreaterThanOrEqual(16 - 1)
    // A covered goal is a stop, not a handover.
    const close = await planLowRoute({ port, self: { x: 0, y: 70, z: 0 }, goal: { x: 0, y: 64, z: 40 } })
    expect(close.status).toBe('planned')
    expect(close.waypointKind).toBe('stop')
  })

  it('refuses to enter a section whose exit has no visible continuation', async () => {
    // ab-30 plan §2: a route that stops right after the opening leaves the next
    // replan nothing to hand over to, so the client holds or climbs inside it.
    // The requirement is speed-derived: the same section and route pass at
    // cruise speed and are refused when the glider is much faster.
    const { port } = fakePort({ ceilingFrom: 75 })
    const early = { axis: 'z' as const, at: 20, lateralMin: -6, lateralMax: 6, yMin: 63, yMax: 74 }
    const cruise = await planLowRoute({ port, self: { x: 0, y: 70, z: 0 }, goal, mustPass: [early], speed: 1.6 })
    expect(cruise.status).toBe('planned')
    const fast = await planLowRoute({ port, self: { x: 0, y: 70, z: 0 }, goal, mustPass: [early], speed: 200 })
    expect(fast.status).toBe('blocked')
    expect(fast.reason).toBe('section_suffix_short')
  })

  it('accepts the client roofY argument and still plans', async () => {
    // The client has always passed `roofY`; the field was missing from the
    // input type, so the spread-based call silently dropped it. This test locks
    // that the argument is part of the contract; applying it to the window is
    // deferred to the ab-30 plan §2 design (the cap experiment refused).
    const { port } = fakePort({ ceilingFrom: 200 })
    const plan = await planLowRoute({ port, self: { x: 0, y: 70, z: 0 }, goal: { x: 0, y: 64, z: 380 }, roofY: 75 })
    expect(plan.status).toBe('planned')
    expect(plan.bandY).toBeGreaterThan(0)
  })

  it('emits a thinned channel path that only removes raw path points', async () => {
    // Recovered regression (the file was lost to a PowerShell rewrite). The
    // channel path is what the client flies: thinning must only drop points
    // from the verified raw path, keep both endpoints, and never invent a
    // shortcut point of its own.
    const { port } = fakePort({ ceilingFrom: 200 })
    const plan = await planLowRoute({ port, self: { x: 0, y: 74, z: 0 }, goal })
    expect(plan.status).toBe('planned')
    const channel = plan.channelPath!
    expect(channel.length).toBeGreaterThan(1)
    expect(channel[0]).toMatchObject({ x: plan.path![0]!.x, y: plan.path![0]!.y, z: plan.path![0]!.z })
    expect(channel.at(-1)).toMatchObject({ x: plan.path!.at(-1)!.x, y: plan.path!.at(-1)!.y, z: plan.path!.at(-1)!.z })
    for (const point of channel) {
      expect(plan.path!.some(raw => raw.x === point.x && raw.y === point.y && raw.z === point.z)).toBe(true)
    }
    // Thinning exists to cut the point count, not to re-route: it must be a
    // subsequence of the raw path here (a two-point raw path stays two points).
    // NOTICE: the corner-cut property (a thinned chord must not leave verified
    // air) needs a fixture whose route bends around a wall; the current fake
    // port cannot express that geometry yet, so it is tracked in the ab-30
    // plan §1 follow-ups instead of being asserted here.
  })

  it('routes around a sphere the flight proved unflyable', async () => {
    const { port } = fakePort({ ceilingFrom: 200 })
    const plain = await planLowRoute({ port, self: { x: 0, y: 70, z: 0 }, goal })
    expect(plain.status).toBe('planned')
    // Invalidate a sphere in front of the glider: a valid detour can reach
    // farther than the old route, but no returned segment may enter it.
    const excluded = await planLowRoute({
      port,
      self: { x: 0, y: 70, z: 0 },
      goal,
      exclude: [{ position: { x: 0, y: 70, z: 40 }, radius: 30 }],
    })
    expect(['blocked', 'planned']).toContain(excluded.status)
    if (excluded.status === 'planned') {
      const path = excluded.channelPath!
      for (let index = 1; index < path.length; index++) {
        const from = path[index - 1]!
        const to = path[index]!
        const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z) / 0.25))
        for (let step = 0; step <= steps; step++) {
          const t = step / steps
          expect(Math.hypot(
            Math.floor(from.x + (to.x - from.x) * t),
            Math.floor(from.y + (to.y - from.y) * t) - 70,
            Math.floor(from.z + (to.z - from.z) * t) - 40,
          )).toBeGreaterThan(30)
        }
      }
    }
  })

  it('follows the corridor bearing for its read window when one is given', async () => {
    // The E-02 canyon bends away from the goal bearing; the corridor bearing
    // keeps the window on the glider's own direction instead of the goal line.
    const straight = fakePort({ ceilingFrom: 200 })
    await planLowRoute({ port: straight.port, self: { x: 0, y: 70, z: 0 }, goal })
    const bent = fakePort({ ceilingFrom: 200 })
    await planLowRoute({ port: bent.port, self: { x: 0, y: 70, z: 0 }, goal, bearing: { x: 1, z: 0 } })
    const extent = (reads: Array<{ from: Vec3, to: Vec3 }>): number =>
      Math.max(...reads.map(read => read.to.x)) - Math.min(...reads.map(read => read.from.x))
    expect(extent(bent.reads)).toBeGreaterThan(extent(straight.reads))
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
