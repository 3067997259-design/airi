import type { MovementControlPort, MovementInput, MovementState } from './port'
import type { SnapshotEntry } from './snapshot'
import type { PathStep, Vec3 } from './types'

import { describe, expect, it, vi } from 'vitest'

import {
  buildArcPath,
  buildCorridor,
  collisionBoxesOf,
  followCorridor,
  playerBox,
  pointAt,
  projectOnPath,
  stepIndexAtProgress,
  sweepWalkSegment,
  truncatedLookahead,
} from './corridor'
import { createSnapshot } from './snapshot'
import { DEFAULT_MOVEMENT_CONFIG } from './types'

function floorWorld(options: { holes?: Array<{ x: number, z: number }>, unknown?: Vec3[], ceiling?: Array<{ x: number, y: number, z: number }> } = {}) {
  const floorY = 0
  const entries: SnapshotEntry[] = []
  const holes = new Set((options.holes ?? []).map(hole => `${hole.x},${hole.z}`))
  const unknown = new Set((options.unknown ?? []).map(cell => `${cell.x},${cell.y},${cell.z}`))
  for (let x = -2; x <= 8; x++) {
    for (let z = -2; z <= 2; z++) {
      if (unknown.has(`${x},${floorY},${z}`))
        continue
      entries.push({ x, y: floorY, z, id: holes.has(`${x},${z}`) ? 'minecraft:air' : 'minecraft:stone' })
    }
  }
  for (let x = -2; x <= 8; x++) {
    for (let z = -2; z <= 2; z++) {
      for (let y = floorY + 1; y <= floorY + 4; y++) {
        if (!unknown.has(`${x},${y},${z}`))
          entries.push({ x, y, z, id: 'minecraft:air' })
      }
    }
  }
  for (const block of options.ceiling ?? [])
    entries.push({ ...block, id: 'minecraft:stone' })
  return createSnapshot(entries)
}

function pathSteps(cells: Vec3[], from: Vec3): PathStep[] {
  return cells.map((cell, index) => ({
    ...cell,
    from: index === 0 ? from : cells[index - 1]!,
    remainingPlaceables: 0,
    cost: 1,
    toBreak: [],
    toPlace: [],
    parkour: false,
  }))
}

describe('corridor sweep', () => {
  it('verifies support and headroom on a flat floor', () => {
    const world = floorWorld()
    const result = sweepWalkSegment({ x: 0.5, y: 1, z: 0.5 }, { x: 4.5, y: 1, z: 0.5 }, world, DEFAULT_MOVEMENT_CONFIG)
    expect(result.verified).toBe(true)
  })

  it('fails a gap wider than the player box', () => {
    const world = floorWorld({ holes: [{ x: 1, z: 0 }, { x: 2, z: 0 }] })
    const result = sweepWalkSegment({ x: 0.5, y: 1, z: 0.5 }, { x: 3.5, y: 1, z: 0.5 }, world, DEFAULT_MOVEMENT_CONFIG)
    expect(result.verified).toBe(false)
    expect(result.reason).toBe('unsupported')
  })

  it('fails when a block enters the body above the step height', () => {
    const world = floorWorld({ ceiling: [{ x: 2, y: 2, z: 0 }] })
    const result = sweepWalkSegment({ x: 0.5, y: 1, z: 0.5 }, { x: 4.5, y: 1, z: 0.5 }, world, DEFAULT_MOVEMENT_CONFIG)
    expect(result.verified).toBe(false)
    expect(result.reason).toBe('no-headroom')
  })

  it('reports an uncovered cell as unknown instead of air', () => {
    const world = floorWorld({ unknown: [{ x: 2, y: 2, z: 0 }] })
    const result = sweepWalkSegment({ x: 0.5, y: 1, z: 0.5 }, { x: 4.5, y: 1, z: 0.5 }, world, DEFAULT_MOVEMENT_CONFIG)
    expect(result.verified).toBe(false)
    expect(result.reason).toBe('unknown')
  })

  it('uses an explicit top-slab collision box', () => {
    const world = createSnapshot([
      { x: 0, y: 0, z: 0, id: 'minecraft:stone_slab', collision: [{ minX: 0, minY: 0.5, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }] },
    ])
    const boxes = collisionBoxesOf(world.getBlock(0, 0, 0)!)
    expect(boxes[0]!.min.y).toBe(0.5)
    expect(boxes[0]!.max.y).toBe(1)
  })
})

describe('arc-length path', () => {
  it('interpolates a point at arc length', () => {
    const path = buildArcPath([{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 10, y: 0, z: 10 }])
    expect(path.total).toBe(20)
    expect(pointAt(path, 5)).toEqual({ x: 5, y: 0, z: 0 })
    expect(pointAt(path, 15)).toEqual({ x: 10, y: 0, z: 5 })
  })

  it('truncates the lookahead at the next bend', () => {
    const path = buildArcPath([{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 10, y: 0, z: 10 }])
    expect(truncatedLookahead(path, 5, 10)).toEqual({ x: 10, y: 0, z: 0 })
  })

  it('does not truncate on a straight line', () => {
    const path = buildArcPath([{ x: 0, y: 0, z: 0 }, { x: 20, y: 0, z: 0 }])
    expect(truncatedLookahead(path, 5, 10)).toEqual({ x: 15, y: 0, z: 0 })
  })

  it('never projects onto the other arm of a U-turn inside the local window', () => {
    const path = buildArcPath([
      { x: 0, y: 0, z: 0 },
      { x: 3, y: 0, z: 0 },
      { x: 3, y: 0, z: 1 },
      { x: 0, y: 0, z: 1 },
    ])
    const position = { x: 1.5, y: 0, z: 0.9 }
    // Without a window the nearby return arm wins; the local window excludes it.
    const global = projectOnPath(path, position, { from: 0, to: path.total })
    const local = projectOnPath(path, position, { from: 0, to: 4 })
    expect(global!.s).toBeGreaterThan(4)
    expect(local!.s).toBeCloseTo(1.5, 5)
  })

  it('maps arc length back to the passed run cell', () => {
    const path = buildArcPath([{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }])
    expect(stepIndexAtProgress(path, 0)).toBe(0)
    expect(stepIndexAtProgress(path, 0.5)).toBe(1)
    expect(stepIndexAtProgress(path, 1.5)).toBe(2)
  })
})

describe('corridor build and fallback', () => {
  it('builds a corridor over a verified flat run', () => {
    const world = floorWorld()
    const steps = pathSteps([
      { x: 1, y: 1, z: 0 },
      { x: 2, y: 1, z: 0 },
      { x: 3, y: 1, z: 0 },
    ], { x: 0, y: 1, z: 0 })
    const corridor = buildCorridor(steps, 0, 3, world, DEFAULT_MOVEMENT_CONFIG)
    expect(corridor).toBeDefined()
    expect(corridor!.stepCount).toBe(3)
  })

  it('returns undefined when a cell is unknown so the caller falls back', () => {
    const world = floorWorld({ unknown: [{ x: 2, y: 2, z: 0 }] })
    const steps = pathSteps([
      { x: 1, y: 1, z: 0 },
      { x: 2, y: 1, z: 0 },
      { x: 3, y: 1, z: 0 },
    ], { x: 0, y: 1, z: 0 })
    expect(buildCorridor(steps, 0, 3, world, DEFAULT_MOVEMENT_CONFIG)).toBeUndefined()
  })

  it('rejects a run that contains a non-walk edge', () => {
    const world = floorWorld()
    const steps = pathSteps([{ x: 1, y: 1, z: 0 }, { x: 2, y: 1, z: 0 }], { x: 0, y: 1, z: 0 })
    steps[1]!.supportHeight = 1.5
    steps[1]!.fromSupportHeight = 1
    expect(buildCorridor(steps, 0, 2, world, DEFAULT_MOVEMENT_CONFIG)).toBeUndefined()
  })

  it('exposes the player box used by the sweep', () => {
    expect(playerBox({ x: 1, y: 2, z: 3 })).toEqual({ min: { x: 0.7, y: 2, z: 2.7 }, max: { x: 1.3, y: 3.8, z: 3.3 } })
  })
})

function movingPort(end: Vec3, step = 1) {
  const state: MovementState = { position: { x: 0.5, y: 1, z: 0.5 }, yaw: -90, onGround: true, inWater: false }
  const setInput = vi.fn(async (input: MovementInput) => {
    if (!input.forward)
      return
    state.position = { ...state.position, x: Math.min(end.x, state.position.x + step) }
  })
  const stopMovement = vi.fn(async () => {})
  const port = {
    getState: vi.fn(async () => ({ ...state, position: { ...state.position } })),
    getBlocksRegion: vi.fn(async () => []),
    getBlock: vi.fn(async () => ({ id: 'minecraft:stone', air: false })),
    getInventory: vi.fn(async () => []),
    look: vi.fn(async () => {}),
    setInput,
    stopMovement,
    jumpOnce: vi.fn(async () => {}),
    breakBlock: vi.fn(async () => {}),
    placeBlock: vi.fn(async () => {}),
    useBlock: vi.fn(async () => {}),
    useItem: vi.fn(async () => {}),
    selectHotbar: vi.fn(async () => {}),
    swapSlots: vi.fn(async () => {}),
    dismount: vi.fn(async () => {}),
    getRiding: vi.fn(async () => undefined),
    boardNearestVehicle: vi.fn(async () => ({ boarded: false })),
    useEntity: vi.fn(async () => {}),
  } satisfies MovementControlPort
  return { port, setInput, stopMovement }
}

describe('corridor follow', () => {
  it('advances sProgress to the end and arrives', async () => {
    const world = floorWorld()
    const steps = pathSteps([
      { x: 1, y: 1, z: 0 },
      { x: 2, y: 1, z: 0 },
      { x: 3, y: 1, z: 0 },
    ], { x: 0, y: 1, z: 0 })
    const corridor = buildCorridor(steps, 0, 3, world, DEFAULT_MOVEMENT_CONFIG)!
    const { port, stopMovement } = movingPort({ x: 3.5, y: 1, z: 0.5 })
    const result = await followCorridor({
      port,
      path: corridor.path,
      config: DEFAULT_MOVEMENT_CONFIG,
      shouldStop: () => false,
      sleep: async () => {},
      now: () => 0,
      tickMs: 150,
      stepTimeoutMs: 8000,
    })
    expect(result.status).toBe('arrived')
    expect(result.sProgress).toBeCloseTo(corridor.path.total, 3)
    expect(stopMovement).toHaveBeenCalled()
  })
})
