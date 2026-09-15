import type { SnapshotEntry } from './snapshot'
import type { MovementConfig, Vec3 } from './types'

import { describe, expect, it } from 'vitest'

import { planPath } from './planner'
import { createSnapshot } from './snapshot'
import { DEFAULT_MOVEMENT_CONFIG } from './types'

interface Bounds {
  min: Vec3
  max: Vec3
}

/** Builds a complete air-filled box and stamps the given blocks over it. */
function buildWorld(bounds: Bounds, places: SnapshotEntry[]) {
  const entries: SnapshotEntry[] = []
  for (let x = bounds.min.x; x <= bounds.max.x; x++) {
    for (let y = bounds.min.y; y <= bounds.max.y; y++) {
      for (let z = bounds.min.z; z <= bounds.max.z; z++)
        entries.push({ x, y, z, id: 'minecraft:air' })
    }
  }
  entries.push(...places)
  return createSnapshot(entries)
}

function stamp(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, id: string): SnapshotEntry[] {
  const out: SnapshotEntry[] = []
  for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
    for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) {
      for (let z = Math.min(z1, z2); z <= Math.max(z1, z2); z++)
        out.push({ x, y, z, id })
    }
  }
  return out
}

function config(overrides: Partial<MovementConfig> = {}): MovementConfig {
  return { ...DEFAULT_MOVEMENT_CONFIG, ...overrides }
}

const STUB = { onMissingBlock: 'stub' as const }

describe('planPath flat ground', () => {
  const bounds = { min: { x: 0, y: 60, z: 0 }, max: { x: 8, y: 70, z: 8 } }
  const floor = stamp(0, 63, 0, 8, 63, 8, 'minecraft:stone')

  it('walks straight to the goal with one step per block', () => {
    const result = planPath({
      source: buildWorld(bounds, floor),
      start: { x: 1, y: 64, z: 4 },
      goal: { x: 5, y: 64, z: 4 },
      config: config(),
      ...STUB,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.steps).toHaveLength(4)
      expect(result.cost).toBe(4)
      expect(result.steps.every(step => step.parkour === false)).toBe(true)
    }
  })

  it('reports no_path when the goal is outside every walkable area', () => {
    const result = planPath({
      source: buildWorld(bounds, floor),
      start: { x: 1, y: 64, z: 4 },
      goal: { x: 5, y: 90, z: 4 },
      config: config(),
      ...STUB,
    })
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.reason).toBe('no_path')
  })
})

describe('planPath obstacles', () => {
  const bounds = { min: { x: 0, y: 60, z: 0 }, max: { x: 8, y: 70, z: 8 } }
  const floor = stamp(0, 63, 0, 8, 63, 8, 'minecraft:stone')
  const wall = stamp(3, 64, 0, 3, 65, 8, 'minecraft:stone_bricks')

  it('cannot cross a wall without digging', () => {
    const result = planPath({
      source: buildWorld(bounds, [...floor, ...wall]),
      start: { x: 1, y: 64, z: 4 },
      goal: { x: 5, y: 64, z: 4 },
      config: config({ canDig: false, allowParkour: false }),
      ...STUB,
    })
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.reason).toBe('no_path')
  })

  it('digs through the wall when digging is allowed', () => {
    const result = planPath({
      source: buildWorld(bounds, [...floor, ...wall]),
      start: { x: 1, y: 64, z: 4 },
      goal: { x: 5, y: 64, z: 4 },
      config: config({ canDig: true, allowParkour: false }),
      ...STUB,
    })
    expect(result.ok).toBe(true)
    if (result.ok)
      expect(result.steps.some(step => step.toBreak.length > 0)).toBe(true)
  })
})

describe('planPath gaps', () => {
  const bounds = { min: { x: 0, y: 60, z: 0 }, max: { x: 9, y: 70, z: 8 } }
  // Floor with a full-width 3 block gap at x = 3..5.
  const floor = [
    ...stamp(0, 63, 0, 2, 63, 8, 'minecraft:stone'),
    ...stamp(6, 63, 0, 9, 63, 8, 'minecraft:stone'),
  ]

  it('sprint-jumps the gap when parkour is allowed', () => {
    const result = planPath({
      source: buildWorld(bounds, floor),
      start: { x: 1, y: 64, z: 4 },
      goal: { x: 7, y: 64, z: 4 },
      config: config({ allowParkour: true, allowSprinting: true }),
      ...STUB,
    })
    expect(result.ok).toBe(true)
    if (result.ok)
      expect(result.steps.some(step => step.parkour)).toBe(true)
  })

  it('bridges the gap by placing blocks when parkour is disabled', () => {
    const result = planPath({
      source: buildWorld(bounds, floor),
      start: { x: 1, y: 64, z: 4 },
      goal: { x: 7, y: 64, z: 4 },
      config: config({ allowParkour: false, allow1by1towers: true, canDig: false }),
      remainingPlaceables: 4,
      ...STUB,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      const placements = result.steps.flatMap(step => step.toPlace).filter(action => action.kind === 'place')
      expect(placements).toHaveLength(3)
      expect(placements.every(action => action.y === 63)).toBe(true)
    }
  })

  it('reports no_path when the gap cannot be jumped or bridged', () => {
    const result = planPath({
      source: buildWorld(bounds, floor),
      start: { x: 1, y: 64, z: 4 },
      goal: { x: 7, y: 64, z: 4 },
      config: config({ allowParkour: false, canDig: false }),
      remainingPlaceables: 0,
      ...STUB,
    })
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.reason).toBe('no_path')
  })
})

describe('planPath vertical', () => {
  // Solid terrain up to y = 63 with a 3x3 dry pit (floor y = 60).
  const bounds = { min: { x: 0, y: 58, z: 0 }, max: { x: 8, y: 70, z: 8 } }
  const terrain = [
    ...stamp(0, 60, 0, 8, 63, 8, 'minecraft:stone'),
    ...stamp(3, 61, 3, 5, 63, 5, 'minecraft:air'),
  ]

  it('cannot climb out of a 3 deep pit without placing or digging', () => {
    const result = planPath({
      source: buildWorld(bounds, terrain),
      start: { x: 4, y: 61, z: 4 },
      goal: { x: 1, y: 64, z: 4 },
      config: config({ canDig: false, allowParkour: false }),
      remainingPlaceables: 0,
      ...STUB,
    })
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.reason).toBe('no_path')
  })

  it('piles out of the pit when blocks are available', () => {
    const result = planPath({
      source: buildWorld(bounds, terrain),
      start: { x: 4, y: 61, z: 4 },
      goal: { x: 1, y: 64, z: 4 },
      config: config({ canDig: false, allowParkour: false, allow1by1towers: true }),
      remainingPlaceables: 5,
      ...STUB,
    })
    expect(result.ok).toBe(true)
    if (result.ok)
      expect(result.steps.some(step => step.toPlace.some(action => action.kind === 'place' && action.jump === true))).toBe(true)
  })

  it('drops within maxDropDown and refuses taller drops', () => {
    const dropWorld = buildWorld(
      { min: { x: 0, y: 60, z: 0 }, max: { x: 6, y: 70, z: 4 } },
      [
        ...stamp(0, 60, 0, 6, 63, 4, 'minecraft:stone'),
        ...stamp(0, 64, 0, 2, 65, 4, 'minecraft:stone'),
      ],
    )
    const start = { x: 1, y: 66, z: 2 }
    const goal = { x: 5, y: 64, z: 2 }

    const refused = planPath({
      source: dropWorld,
      start,
      goal,
      config: config({ maxDropDown: 1, allowParkour: false, canDig: false }),
      ...STUB,
    })
    expect(refused.ok).toBe(false)

    const allowed = planPath({
      source: dropWorld,
      start,
      goal,
      config: config({ maxDropDown: 4, allowParkour: false, canDig: false }),
      ...STUB,
    })
    expect(allowed.ok).toBe(true)
  })

  it('swims out of a flush pool onto the bank without placing or breaking', () => {
    // Solid stone up to y=66; the 3x3 pool is carved to y=65..66 water with a
    // stone floor at y=64. The bank surface is flush with the water surface.
    const poolWorld = buildWorld(
      { min: { x: 0, y: 60, z: 0 }, max: { x: 8, y: 70, z: 8 } },
      [
        ...stamp(0, 60, 0, 8, 66, 8, 'minecraft:stone'),
        ...stamp(3, 65, 3, 5, 66, 5, 'minecraft:water'),
      ],
    )
    const result = planPath({
      source: poolWorld,
      start: { x: 4, y: 65, z: 4 },
      goal: { x: 1, y: 67, z: 4 },
      config: config({ canDig: false, allowParkour: false }),
      remainingPlaceables: 0,
      ...STUB,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.steps.some(step => step.x === 2 && step.y === 67 && step.toBreak.length === 0 && step.toPlace.length === 0)).toBe(true)
    }
  })
})

describe('planPath doors', () => {
  const bounds = { min: { x: 0, y: 60, z: 0 }, max: { x: 8, y: 70, z: 8 } }
  const floor = stamp(0, 63, 0, 8, 63, 8, 'minecraft:stone')
  const wall = [
    ...stamp(3, 64, 0, 3, 66, 3, 'minecraft:stone_bricks'),
    ...stamp(3, 64, 5, 3, 66, 8, 'minecraft:stone_bricks'),
  ]
  const closedDoor: SnapshotEntry[] = [
    { x: 3, y: 64, z: 4, id: 'minecraft:oak_door', properties: { open: 'false' } },
    { x: 3, y: 65, z: 4, id: 'minecraft:oak_door', properties: { open: 'false' } },
  ]

  it('routes through a door with a use action instead of breaking it', () => {
    const result = planPath({
      source: buildWorld(bounds, [...floor, ...wall, ...closedDoor]),
      start: { x: 1, y: 64, z: 4 },
      goal: { x: 5, y: 64, z: 4 },
      config: config({ canDig: false, canOpenDoors: true, allowParkour: false }),
      ...STUB,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      const uses = result.steps.flatMap(step => step.toPlace).filter(action => action.kind === 'use')
      expect(uses).toEqual([{ kind: 'use', x: 3, y: 64, z: 4 }])
      expect(result.steps.flatMap(step => step.toBreak)).toHaveLength(0)
    }
  })

  it('reports no_path when the door cannot be opened and digging is disabled', () => {
    const result = planPath({
      source: buildWorld(bounds, [...floor, ...wall, ...closedDoor]),
      start: { x: 1, y: 64, z: 4 },
      goal: { x: 5, y: 64, z: 4 },
      config: config({ canDig: false, canOpenDoors: false, allowParkour: false }),
      ...STUB,
    })
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.reason).toBe('no_path')
  })
})

describe('planPath bounds', () => {
  it('reports no_chunk when the search needs a block outside the snapshot', () => {
    const result = planPath({
      source: buildWorld(
        { min: { x: 0, y: 60, z: 0 }, max: { x: 3, y: 70, z: 8 } },
        stamp(0, 63, 0, 3, 63, 8, 'minecraft:stone'),
      ),
      start: { x: 1, y: 64, z: 4 },
      goal: { x: 8, y: 64, z: 4 },
      config: config(),
      onMissingBlock: 'fail',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('no_chunk')
      expect(result.missing).toBeDefined()
    }
  })

  it('stops a search that exceeds the node budget', () => {
    const result = planPath({
      source: buildWorld(
        { min: { x: 0, y: 60, z: 0 }, max: { x: 40, y: 70, z: 40 } },
        stamp(0, 63, 0, 40, 63, 40, 'minecraft:stone'),
      ),
      start: { x: 1, y: 64, z: 1 },
      goal: { x: 38, y: 64, z: 38 },
      config: config(),
      maxNodes: 5,
      ...STUB,
    })
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.reason).toBe('cost_limit')
  })
})

describe('planPath disabled cells and region goals', () => {
  const bounds = { min: { x: 0, y: 60, z: 0 }, max: { x: 8, y: 70, z: 8 } }
  const floor = stamp(0, 63, 0, 8, 63, 8, 'minecraft:stone')

  it('routes around a disabled destination cell', () => {
    const result = planPath({
      source: buildWorld(bounds, floor),
      start: { x: 1, y: 64, z: 4 },
      goal: { x: 5, y: 64, z: 4 },
      config: config(),
      disabled: new Set(['2,64,4']),
      ...STUB,
    })
    expect(result.ok).toBe(true)
    if (result.ok)
      expect(result.steps.some(step => step.x === 2 && step.z === 4)).toBe(false)
  })

  it('picks the cheapest of several goal cells', () => {
    const result = planPath({
      source: buildWorld(bounds, floor),
      start: { x: 1, y: 64, z: 4 },
      goal: { x: 6, y: 64, z: 4 },
      goalCells: [{ x: 6, y: 64, z: 4 }, { x: 2, y: 64, z: 4 }],
      config: config(),
      ...STUB,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      const last = result.steps[result.steps.length - 1]!
      expect(last.x).toBe(2)
      expect(last.z).toBe(4)
    }
  })

  it('selects the only reachable goal cell when another is walled off', () => {
    const wall = stamp(4, 64, 0, 4, 65, 8, 'minecraft:stone_bricks')
    const result = planPath({
      source: buildWorld(bounds, [...floor, ...wall]),
      start: { x: 1, y: 64, z: 4 },
      goal: { x: 6, y: 64, z: 4 },
      goalCells: [{ x: 6, y: 64, z: 4 }, { x: 2, y: 64, z: 4 }],
      config: config({ canDig: false, allowParkour: false }),
      ...STUB,
    })
    expect(result.ok).toBe(true)
    if (result.ok)
      expect(result.steps[result.steps.length - 1]!.x).toBe(2)
  })

  it('reports no_path when no goal cell is reachable', () => {
    const result = planPath({
      source: buildWorld(bounds, floor),
      start: { x: 1, y: 64, z: 4 },
      goal: { x: 6, y: 64, z: 4 },
      goalCells: [{ x: 6, y: 90, z: 4 }, { x: 5, y: 90, z: 4 }],
      config: config(),
      ...STUB,
    })
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.reason).toBe('no_path')
  })
})
