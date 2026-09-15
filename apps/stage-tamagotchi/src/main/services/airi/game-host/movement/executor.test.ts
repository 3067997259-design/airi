import type { FailedEdge } from './executor'
import type { BlockFace, BlockView, InventorySlot, MovementControlPort, MovementInput, MovementState } from './port'
import type { SnapshotEntry } from './snapshot'
import type { Vec3 } from './types'

import { describe, expect, it } from 'vitest'

import { activeFailedEdges, failedEdgeKey, runTerrainMove, runTerrainRoute, SCAFFOLDING_ITEMS } from './executor'
import { MAX_REGION_BLOCKS } from './region'
import { DEFAULT_MOVEMENT_CONFIG } from './types'

function buildWorld(bounds: { min: Vec3, max: Vec3 }, places: SnapshotEntry[]) {
  const entries: SnapshotEntry[] = []
  for (let x = bounds.min.x; x <= bounds.max.x; x++) {
    for (let y = bounds.min.y; y <= bounds.max.y; y++) {
      for (let z = bounds.min.z; z <= bounds.max.z; z++)
        entries.push({ x, y, z, id: 'minecraft:air' })
    }
  }
  entries.push(...places)
  return entries
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

function keyOf(pos: Vec3): string {
  return `${pos.x},${pos.y},${pos.z}`
}

interface FakeOptions {
  blocked?: boolean
  incomplete?: boolean
  speed?: number
  inventory?: InventorySlot[]
  /** Break calls needed before a survival break removes the block. */
  breakCalls?: number
}

/** Client simulation with action side effects on a mutable block map. */
class FakePort implements MovementControlPort {
  position: Vec3
  yaw = 0
  inWater = false
  inputs: MovementInput = {}
  jumps = 0
  stops = 0
  lookCalls = 0
  lookAngles: number[] = []
  breakCalls: Vec3[] = []
  placeCalls: Array<{ support: Vec3, face: BlockFace }> = []
  useCalls: Vec3[] = []
  selectedSlots: number[] = []
  regionReads: Array<{ from: Vec3, to: Vec3 }> = []
  private readonly blocks = new Map<string, SnapshotEntry>()
  private readonly breakProgress = new Map<string, number>()
  private jumpHeld = false
  /** Polls the fake stays airborne after a jump before gravity applies. */
  private airborne = 0

  constructor(world: SnapshotEntry[], start: Vec3, private readonly options: FakeOptions = {}) {
    this.position = { ...start }
    for (const entry of world)
      this.blocks.set(keyOf(entry), entry)
  }

  async getState(): Promise<MovementState> {
    if (!this.options.blocked && this.inputs.forward) {
      const speed = this.options.speed ?? 0.9
      const radians = this.yaw * Math.PI / 180
      this.position = {
        x: this.position.x - Math.sin(radians) * speed,
        y: this.position.y,
        z: this.position.z + Math.cos(radians) * speed,
      }
    }
    // Gravity: fall until standing on solid ground (water floats instead).
    // A recent jump keeps the player airborne long enough to clear a gap or
    // climb a ledge, mirroring the real jump arc.
    if (!this.inWater) {
      if (this.airborne > 0) {
        this.airborne--
      }
      else {
        for (let guard = 0; guard < 32; guard++) {
          const below = this.blocks.get(keyOf({
            x: Math.floor(this.position.x),
            y: Math.floor(this.position.y) - 1,
            z: Math.floor(this.position.z),
          }))
          if (below && below.id !== 'minecraft:air')
            break
          this.position = { ...this.position, y: this.position.y - 1 }
        }
      }
    }
    return { position: { ...this.position }, yaw: this.yaw, inWater: this.inWater, onGround: true }
  }

  async getBlocksRegion(from: Vec3, to: Vec3): Promise<SnapshotEntry[]> {
    this.regionReads.push({ from: { ...from }, to: { ...to } })
    return [...this.blocks.values()].filter((entry) => {
      if (entry.x < from.x || entry.x > to.x || entry.y < from.y || entry.y > to.y || entry.z < from.z || entry.z > to.z)
        return false
      return this.options.incomplete ? entry.x === from.x : true
    })
  }

  async getBlock(pos: Vec3): Promise<BlockView | undefined> {
    const entry = this.blocks.get(keyOf(pos))
    if (!entry)
      return undefined
    return {
      id: entry.id,
      air: entry.id === 'minecraft:air',
      ...(entry.properties ? { properties: entry.properties } : {}),
      hardness: entry.id.includes('stone') ? 1.5 : 0.5,
    }
  }

  async getInventory(): Promise<InventorySlot[]> {
    return this.options.inventory ?? []
  }

  async look(yaw: number): Promise<void> {
    this.yaw = yaw
    this.lookCalls++
    this.lookAngles.push(yaw)
  }

  async setInput(input: MovementInput): Promise<void> {
    // A held jump lifts the feet one block and starts the airborne window.
    if (input.jump && !this.jumpHeld) {
      this.position = { ...this.position, y: this.position.y + 1 }
      this.jumpHeld = true
      this.airborne = 5
    }
    if (!input.jump)
      this.jumpHeld = false
    this.inputs = { ...this.inputs, ...input }
  }

  async stopMovement(): Promise<void> {
    this.stops++
    this.inputs = {}
  }

  async jumpOnce(): Promise<void> {
    this.jumps++
    // A discrete jump lifts the feet and starts the airborne window, exactly
    // like the held-jump edge above.
    this.position = { ...this.position, y: this.position.y + 1 }
    this.airborne = 5
  }

  async breakBlock(pos: Vec3): Promise<void> {
    this.breakCalls.push({ ...pos })
    const key = keyOf(pos)
    const needed = this.options.breakCalls ?? 1
    const done = (this.breakProgress.get(key) ?? 0) + 1
    this.breakProgress.set(key, done)
    if (done >= needed)
      this.blocks.set(key, { ...pos, id: 'minecraft:air' })
  }

  async placeBlock(support: Vec3, face: BlockFace): Promise<void> {
    this.placeCalls.push({ support: { ...support }, face })
    const deltas: Record<BlockFace, Vec3> = {
      up: { x: 0, y: 1, z: 0 },
      down: { x: 0, y: -1, z: 0 },
      north: { x: 0, y: 0, z: -1 },
      south: { x: 0, y: 0, z: 1 },
      east: { x: 1, y: 0, z: 0 },
      west: { x: -1, y: 0, z: 0 },
    }
    const delta = deltas[face]
    const target = { x: support.x + delta.x, y: support.y + delta.y, z: support.z + delta.z }
    this.blocks.set(keyOf(target), { ...target, id: 'minecraft:cobblestone' })
  }

  async useBlock(pos: Vec3): Promise<void> {
    this.useCalls.push({ ...pos })
    const entry = this.blocks.get(keyOf(pos))
    if (entry)
      this.blocks.set(keyOf(pos), { ...entry, properties: { ...entry.properties, open: 'true' } })
  }

  async useItem(): Promise<void> {}

  async selectHotbar(slot: number): Promise<void> {
    this.selectedSlots.push(slot)
  }

  swapCalls: Array<[number, number]> = []

  async swapSlots(slotA: number, slotB: number): Promise<void> {
    this.swapCalls.push([slotA, slotB])
  }

  async dismount(): Promise<void> {}

  async getRiding() {
    return undefined
  }

  async boardNearestVehicle() { return { boarded: false } }

  async useEntity(): Promise<void> {}
}

function advancingClock(stepMs = 200): () => number {
  let current = 0
  return () => {
    current += stepMs
    return current
  }
}

// The executor's region margins (±8 horizontal) must stay inside the test
// world so the snapshot is complete.
const FLAT_BOUNDS = { min: { x: -16, y: 56, z: -16 }, max: { x: 26, y: 80, z: 24 } }
const FLAT_WORLD = buildWorld(FLAT_BOUNDS, stamp(-16, 63, -16, 26, 63, 24, 'minecraft:stone'))
// A long runway for the coarse-route test: the goal is 64 blocks away, so the
// route must split into local legs instead of one wide region read.
const LONG_WORLD = buildWorld({ min: { x: -8, y: 56, z: -8 }, max: { x: 24, y: 80, z: 80 } }, stamp(-8, 63, -8, 24, 63, 80, 'minecraft:stone'))
const COBBLESTONE: InventorySlot[] = [{ slot: 5, id: 'minecraft:cobblestone', count: 64, hotbar: true }]

const FAST = { sleep: async () => {}, now: () => Date.now() }

describe('runTerrainMove walking', () => {
  it('walks a flat path to the goal and releases movement', async () => {
    const port = new FakePort(FLAT_WORLD, { x: 1, y: 64, z: 4 })
    const result = await runTerrainMove({
      port,
      goal: { x: 4, y: 64, z: 4 },
      deps: FAST,
    })
    expect(result.status).toBe('reached')
    expect(port.lookCalls).toBeGreaterThan(0)
    expect(port.stops).toBeGreaterThan(0)
    expect(port.inputs.forward).toBeUndefined()
  })

  // Batch 2: a run of plain walk cells is followed continuously. The old
  // per-node stop made a six-cell line stop five times between nodes.
  it('follows a straight run without stopping between nodes', async () => {
    const port = new FakePort(FLAT_WORLD, { x: 1, y: 64, z: 4 })
    const result = await runTerrainMove({
      port,
      goal: { x: 8, y: 64, z: 4 },
      deps: FAST,
    })
    expect(result.status).toBe('reached')
    // One stop from the final release; the run itself never stops per node.
    expect(port.stops).toBeLessThanOrEqual(2)
    expect(port.inputs.forward).toBeUndefined()
  })

  // ROOT CAUSE:
  //
  // The executor aimed at the integer corner of the next cell. From (1.5,4.5)
  // toward the cell (2,4) that is -135° and a diagonal approach (review R1);
  // the standing point (2.5,4.5) is due east (-90°).
  it('aims the first step at the stand center instead of the integer corner', async () => {
    const port = new FakePort(FLAT_WORLD, { x: 1.5, y: 64, z: 4.5 })
    const result = await runTerrainMove({
      port,
      goal: { x: 4, y: 64, z: 4 },
      deps: FAST,
    })
    expect(result.status).toBe('reached')
    expect(port.lookAngles[0]).toBeCloseTo(-90, 1)
  })

  it('jumps a parkour gap instead of walking around it', async () => {
    const world = buildWorld(
      FLAT_BOUNDS,
      [
        ...stamp(-16, 63, -16, 2, 63, 24, 'minecraft:stone'),
        ...stamp(6, 63, -16, 26, 63, 24, 'minecraft:stone'),
      ],
    )
    const port = new FakePort(world, { x: 1, y: 64, z: 4 })
    const result = await runTerrainMove({
      port,
      goal: { x: 7, y: 64, z: 4 },
      deps: FAST,
    })
    expect(result.status).toBe('reached')
    expect(port.jumps).toBeGreaterThanOrEqual(1)
  })
})

describe('runTerrainMove actions', () => {
  const wallWorld = buildWorld(
    FLAT_BOUNDS,
    [
      ...stamp(-16, 63, -16, 26, 63, 24, 'minecraft:stone'),
      ...stamp(3, 64, -16, 3, 65, 24, 'minecraft:stone_bricks'),
    ],
  )

  it('digs through a wall with stable aim polling', async () => {
    const port = new FakePort(wallWorld, { x: 1, y: 64, z: 4 }, { breakCalls: 2 })
    const result = await runTerrainMove({
      port,
      goal: { x: 5, y: 64, z: 4 },
      config: { ...DEFAULT_MOVEMENT_CONFIG, canDig: true, allowParkour: false },
      deps: FAST,
    })
    expect(result.status).toBe('reached')
    // Survival mining starts more than once until the block is gone, and the
    // view is re-aimed between attempts (the Baritone wobble regression).
    const firstBreakKey = keyOf(port.breakCalls[0]!)
    expect(port.breakCalls.filter(call => keyOf(call) === firstBreakKey).length).toBeGreaterThanOrEqual(2)
    expect(port.lookCalls).toBeGreaterThanOrEqual(port.breakCalls.length - 1)
  }, 30_000)

  it('places a step and climbs a two high wall when digging is disabled', async () => {
    const port = new FakePort(wallWorld, { x: 1, y: 64, z: 4 }, { inventory: COBBLESTONE })
    const result = await runTerrainMove({
      port,
      goal: { x: 5, y: 64, z: 4 },
      config: { ...DEFAULT_MOVEMENT_CONFIG, canDig: false, allowParkour: false },
      remainingPlaceables: 8,
      deps: FAST,
    })
    expect(result.status).toBe('reached')
    expect(port.placeCalls.length).toBeGreaterThanOrEqual(1)
    expect(port.selectedSlots.length).toBeGreaterThanOrEqual(1)
    expect(port.breakCalls).toHaveLength(0)
  }, 30_000)

  // ROOT CAUSE:
  //
  // Scaffolding was only selected from the hotbar while the host counted the
  // main inventory too, so a stack outside the hotbar made every place step
  // fail even though the material was carried (review R3).
  it('moves main-inventory scaffolding into an empty hotbar slot', async () => {
    const port = new FakePort(wallWorld, { x: 1, y: 64, z: 4 }, {
      inventory: [{ slot: 12, id: 'minecraft:cobblestone', count: 64, hotbar: false }],
    })
    const result = await runTerrainMove({
      port,
      goal: { x: 5, y: 64, z: 4 },
      config: { ...DEFAULT_MOVEMENT_CONFIG, canDig: false, allowParkour: false },
      remainingPlaceables: 8,
      deps: FAST,
    })
    expect(result.status).toBe('reached')
    expect(port.swapCalls).toContainEqual([12, 0])
    expect(port.selectedSlots).toContain(0)
  }, 30_000)

  it('never selects falling sand as scaffolding', async () => {
    expect(SCAFFOLDING_ITEMS.has('minecraft:sand')).toBe(false)
    expect(SCAFFOLDING_ITEMS.has('minecraft:cobblestone')).toBe(true)
  })

  it('reports no_path when the path needs blocks but none are carried', async () => {
    const port = new FakePort(wallWorld, { x: 1, y: 64, z: 4 }, { inventory: [] })
    const result = await runTerrainMove({
      port,
      goal: { x: 5, y: 64, z: 4 },
      config: { ...DEFAULT_MOVEMENT_CONFIG, canDig: false, allowParkour: false },
      remainingPlaceables: 0,
      deps: FAST,
    })
    expect(result.status).toBe('no_path')
    expect(port.placeCalls).toHaveLength(0)
  })

  it('opens a door instead of breaking it', async () => {
    const world = buildWorld(
      FLAT_BOUNDS,
      [
        ...stamp(-16, 63, -16, 26, 63, 24, 'minecraft:stone'),
        ...stamp(3, 64, -16, 3, 66, 3, 'minecraft:stone_bricks'),
        ...stamp(3, 64, 5, 3, 66, 24, 'minecraft:stone_bricks'),
        { x: 3, y: 64, z: 4, id: 'minecraft:oak_door', properties: { open: 'false' } },
        { x: 3, y: 65, z: 4, id: 'minecraft:oak_door', properties: { open: 'false' } },
      ],
    )
    const port = new FakePort(world, { x: 1, y: 64, z: 4 })
    const result = await runTerrainMove({
      port,
      goal: { x: 5, y: 64, z: 4 },
      config: { ...DEFAULT_MOVEMENT_CONFIG, canDig: false, allowParkour: false },
      deps: FAST,
    })
    expect(result.status).toBe('reached')
    expect(port.useCalls).toEqual([{ x: 3, y: 64, z: 4 }])
    expect(port.breakCalls).toHaveLength(0)
  })
})

describe('runTerrainMove boundaries', () => {
  it('reports no_chunk when the region read is incomplete', async () => {
    const port = new FakePort(FLAT_WORLD, { x: 1, y: 64, z: 4 }, { incomplete: true })
    const result = await runTerrainMove({
      port,
      goal: { x: 4, y: 64, z: 4 },
      deps: FAST,
    })
    expect(result.status).toBe('no_chunk')
  })

  it('reports stuck after bounded recovery attempts instead of spinning', async () => {
    const port = new FakePort(FLAT_WORLD, { x: 1, y: 64, z: 4 }, { blocked: true })
    const result = await runTerrainMove({
      port,
      goal: { x: 4, y: 64, z: 4 },
      deps: { sleep: async () => {}, now: advancingClock() },
    })
    expect(result.status).toBe('stuck')
    expect(result.stuckEscalations).toBeGreaterThan(0)
  })

  it('cancels as soon as the stop predicate is set', async () => {
    const port = new FakePort(FLAT_WORLD, { x: 1, y: 64, z: 4 })
    let calls = 0
    const result = await runTerrainMove({
      port,
      goal: { x: 4, y: 64, z: 4 },
      shouldStop: () => ++calls > 3,
      deps: FAST,
    })
    expect(result.status).toBe('cancelled')
  })
})

describe('runTerrainMove failed edges', () => {
  // ROOT CAUSE:
  //
  // Every replan searched the same region with no memory of the edge that
  // just failed, so the blocked step (1,4)->(2,4) was planned again and again
  // (review R5). The executor now records the edge and passes its destination
  // cell to the planner as disabled.
  it('records a failed edge and skips its cell on the next replan', async () => {
    const port = new FakePort(FLAT_WORLD, { x: 1, y: 64, z: 4 }, { blocked: true })
    const failedEdges = new Map<string, FailedEdge>()
    const trace: string[] = []
    const result = await runTerrainMove({
      port,
      goal: { x: 4, y: 64, z: 4 },
      failedEdges,
      debug: message => trace.push(message),
      deps: { sleep: async () => {}, now: advancingClock() },
    })
    expect(result.status).toBe('stuck')
    expect(failedEdges.size).toBeGreaterThan(0)
    const firstEdge = failedEdges.get(failedEdgeKey({ x: 1, y: 64, z: 4 }, { x: 2, y: 64, z: 4 }))
    expect(firstEdge).toMatchObject({ to: { x: 2, y: 64, z: 4 }, materials: 0, id: 'air' })
    // The first attempt walked at (2,4); after it failed no plan may start
    // there again.
    const step = 'step -> 2,64,4 break=0 place=0 parkour=false'
    const first = trace.indexOf(step)
    expect(first).toBeGreaterThanOrEqual(0)
    expect(trace.slice(first + 1)).not.toContain(step)
  })

  it('filters expired and material-invalidated failed edges', () => {
    const entries: Array<[string, FailedEdge]> = [
      [failedEdgeKey({ x: 0, y: 64, z: 0 }, { x: 1, y: 64, z: 0 }), { to: { x: 1, y: 64, z: 0 }, at: 20_000, materials: 5, id: 'air' }],
      [failedEdgeKey({ x: 0, y: 64, z: 0 }, { x: 2, y: 64, z: 0 }), { to: { x: 2, y: 64, z: 0 }, at: 0, materials: 5, id: 'air' }],
      [failedEdgeKey({ x: 0, y: 64, z: 0 }, { x: 3, y: 64, z: 0 }), { to: { x: 3, y: 64, z: 0 }, at: 20_000, materials: 2, id: 'air' }],
    ]
    const active = activeFailedEdges(entries, { now: 40_000, materials: 5 })
    expect(active.map(edge => edge.to.x)).toEqual([1])
  })

  it('shares failed edges across legs so a later leg never retries the edge', async () => {
    const port = new FakePort(FLAT_WORLD, { x: 1, y: 64, z: 4 }, { blocked: true })
    const failedEdges = new Map<string, FailedEdge>()
    await runTerrainMove({
      port,
      goal: { x: 4, y: 64, z: 4 },
      failedEdges,
      deps: { sleep: async () => {}, now: advancingClock() },
    })
    expect(failedEdges.get(failedEdgeKey({ x: 1, y: 64, z: 4 }, { x: 2, y: 64, z: 4 }))).toMatchObject({ id: 'air' })

    // The second leg receives the map a previous leg filled. Its first plan
    // must already skip the failed cell; only a fresh, empty map would retry.
    const trace: string[] = []
    await runTerrainMove({
      port,
      goal: { x: 4, y: 64, z: 4 },
      failedEdges,
      debug: message => trace.push(message),
      deps: { sleep: async () => {}, now: advancingClock() },
    })
    expect(trace).not.toContain('step -> 2,64,4 break=0 place=0 parkour=false')
  })

  it('keeps a failed edge while its destination block is unchanged', async () => {
    const port = new FakePort(FLAT_WORLD, { x: 1, y: 64, z: 4 })
    const failedEdges = new Map<string, FailedEdge>()
    const to = { x: 2, y: 64, z: 4 }
    failedEdges.set(failedEdgeKey({ x: 1, y: 64, z: 4 }, to), { to, at: Date.now(), materials: 0, id: 'air' })
    const trace: string[] = []
    const result = await runTerrainMove({ port, goal: { x: 3, y: 64, z: 4 }, failedEdges, debug: message => trace.push(message), deps: FAST })
    expect(result.status).toBe('reached')
    expect(trace).not.toContain('step -> 2,64,4 break=0 place=0 parkour=false')
  })

  it('drops a failed edge when its destination block changed', async () => {
    const port = new FakePort(FLAT_WORLD, { x: 1, y: 64, z: 4 })
    const failedEdges = new Map<string, FailedEdge>()
    const to = { x: 2, y: 64, z: 4 }
    // Recorded against stone; the world now has air there. The live read must
    // invalidate the record, otherwise a mined cell stays blocked after a
    // replan (review R5 world invalidation).
    failedEdges.set(failedEdgeKey({ x: 1, y: 64, z: 4 }, to), { to, at: Date.now(), materials: 0, id: 'stone' })
    const trace: string[] = []
    const result = await runTerrainMove({ port, goal: { x: 3, y: 64, z: 4 }, failedEdges, debug: message => trace.push(message), deps: FAST })
    expect(result.status).toBe('reached')
    expect(trace).toContain('step -> 2,64,4 break=0 place=0 parkour=false')
  })
})

describe('runTerrainRoute long distance', () => {
  it('splits a far goal into local legs and reaches it', async () => {
    const port = new FakePort(LONG_WORLD, { x: 1, y: 64, z: 4 })
    const result = await runTerrainRoute({ port, goal: { x: 1, y: 64, z: 68 }, deps: FAST })
    expect(result.status).toBe('reached')
    // A far goal becomes several legs, so several local reads happen.
    expect(port.regionReads.length).toBeGreaterThanOrEqual(3)
    for (const read of port.regionReads) {
      // Every leg reads a window around its start and the next waypoint, not
      // the whole 64-block route.
      expect(read.to.z - read.from.z).toBeLessThanOrEqual(40)
      const volume = (read.to.x - read.from.x + 1) * (read.to.y - read.from.y + 1) * (read.to.z - read.from.z + 1)
      expect(volume).toBeLessThanOrEqual(MAX_REGION_BLOCKS)
    }
  })
})
