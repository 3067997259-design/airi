import type { SnapshotEntry } from '../movement/snapshot'
import type { Vec3 } from '../movement/types'

import { describe, expect, it } from 'vitest'

import { buildEntrances, buildFreeSpace, DEFAULT_COARSE_RESOLUTION, DEFAULT_MIN_CLEARANCE, planCorridor } from './corridor'

interface RegionOptions {
  floorY?: number
  /** Cells forced to stone regardless of the floor. */
  walls?: Set<string>
  /** Cells the read did not cover, so they are unknown. */
  omit?: Set<string>
}

const key = (x: number, y: number, z: number) => `${x},${y},${z}`

function region(min: Vec3, max: Vec3, options: RegionOptions = {}): SnapshotEntry[] {
  const floorY = options.floorY ?? 60
  const entries: SnapshotEntry[] = []
  for (let y = min.y; y <= max.y; y++) {
    for (let z = min.z; z <= max.z; z++) {
      for (let x = min.x; x <= max.x; x++) {
        const cellKey = key(x, y, z)
        if (options.omit?.has(cellKey))
          continue
        if (options.walls?.has(cellKey)) {
          entries.push({ x, y, z, id: 'minecraft:stone' })
          continue
        }
        entries.push({ x, y, z, id: y <= floorY ? 'minecraft:stone' : 'minecraft:air' })
      }
    }
  }
  return entries
}

const request = {
  bounds: { min: { x: 0, y: 56, z: 0 }, max: { x: 31, y: 79, z: 15 } },
  resolution: DEFAULT_COARSE_RESOLUTION,
  minClearance: DEFAULT_MIN_CLEARANCE,
  dimension: 'minecraft:overworld',
  worldId: 'w',
  mapVersion: 'm1',
}

describe('buildFreeSpace', () => {
  it('marks covered open air as free', () => {
    const space = buildFreeSpace(request, region(request.bounds.min, request.bounds.max))
    const cell = space.byId.get(key(4, 64, 4))!
    expect(cell.state).toBe('free')
    expect(space.unknown).toHaveLength(0)
  })

  it('marks an uncovered column unknown instead of air', () => {
    const omit = new Set<string>()
    for (let y = 64; y <= 67; y++)
      omit.add(key(12, y, 4))
    const space = buildFreeSpace(request, region(request.bounds.min, request.bounds.max, { omit }))
    expect(space.byId.get(key(12, 64, 4))!.state).toBe('unknown')
    expect(space.unknown.length).toBeGreaterThan(0)
  })

  it('marks a cell with too little headroom as low-clearance', () => {
    const walls = new Set<string>()
    for (let y = 61; y <= 62; y++)
      walls.add(key(4, y, 4))
    const space = buildFreeSpace(request, region(request.bounds.min, request.bounds.max, { walls }))
    expect(space.byId.get(key(4, 60, 4))!.state).toBe('low-clearance')
  })
})

describe('buildEntrances', () => {
  it('connects adjacent free cells with verified headroom', () => {
    const space = buildFreeSpace(request, region(request.bounds.min, request.bounds.max))
    const entrances = buildEntrances(space, { minHeight: 3, minWidth: 4 })
    expect(entrances.some(entry => entry.from === key(4, 64, 4) && entry.to === key(8, 64, 4))).toBe(true)
  })
})

describe('planCorridor', () => {
  it('plans a coarse corridor across open terrain', () => {
    const space = buildFreeSpace(request, region(request.bounds.min, request.bounds.max))
    const plan = planCorridor(space, { start: { x: 2, y: 64, z: 4 }, goal: { x: 28, y: 64, z: 4 } })
    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(plan.corridor.regions.length).toBeGreaterThan(0)
      expect(plan.corridor.entrances.length).toBeGreaterThan(0)
      expect(plan.corridor.dimension).toBe('minecraft:overworld')
    }
  })

  it('routes over a wall when a higher band is free', () => {
    const walls = new Set<string>()
    // A full face across every z, so a side-step cannot avoid it and the route
    // must climb.
    for (let y = 60; y <= 70; y++) {
      for (let z = 0; z <= 15; z++) {
        for (let x = 12; x <= 15; x++)
          walls.add(key(x, y, z))
      }
    }
    const space = buildFreeSpace(request, region(request.bounds.min, request.bounds.max, { walls }))
    const plan = planCorridor(space, { start: { x: 2, y: 64, z: 4 }, goal: { x: 28, y: 64, z: 4 } })
    expect(plan.ok).toBe(true)
    if (plan.ok) {
      // The wall reaches y=70, so the only free route at x=12 is above it.
      expect(plan.corridor.regions.some(region => region.bounds.max.y >= 72)).toBe(true)
      expect(plan.corridor.entrances.length).toBeGreaterThan(0)
    }
  })

  it('refuses a goal inside unknown space', () => {
    const omit = new Set<string>()
    for (let y = 64; y <= 67; y++)
      omit.add(key(28, y, 4))
    const space = buildFreeSpace(request, region(request.bounds.min, request.bounds.max, { omit }))
    const plan = planCorridor(space, { start: { x: 2, y: 64, z: 4 }, goal: { x: 28, y: 64, z: 4 } })
    expect(plan).toEqual({ ok: false, reason: 'goal_unknown' })
  })

  it('accepts clearance, firework and backup cost terms', () => {
    const space = buildFreeSpace(request, region(request.bounds.min, request.bounds.max))
    const plan = planCorridor(space, {
      start: { x: 2, y: 64, z: 4 },
      goal: { x: 28, y: 64, z: 4 },
      clearanceCost: 2,
      fireworkWeight: 3,
      backupSites: [{ x: 16, y: 64, z: 4 }],
      backupWeight: 0.1,
    })
    expect(plan.ok).toBe(true)
  })

  it('records the unknown boundary beside the route', () => {
    const omit = new Set<string>()
    for (let y = 64; y <= 67; y++)
      omit.add(key(4, y, 8))
    const space = buildFreeSpace(request, region(request.bounds.min, request.bounds.max, { omit }))
    const plan = planCorridor(space, { start: { x: 2, y: 64, z: 4 }, goal: { x: 28, y: 64, z: 4 } })
    expect(plan.ok).toBe(true)
    if (plan.ok)
      expect(plan.corridor.unknownBoundary.length).toBeGreaterThan(0)
  })
})
