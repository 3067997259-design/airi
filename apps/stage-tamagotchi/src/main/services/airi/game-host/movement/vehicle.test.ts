import type { BlockFace, BlockView, InventorySlot, MovementControlPort, MovementInput, MovementState, RidingInfo } from './port'
import type { Vec3 } from './types'

import { describe, expect, it } from 'vitest'

import { runVehicleMove } from './vehicle'

interface FakeOptions {
  riding?: RidingInfo
  inventory?: InventorySlot[]
  blocked?: boolean
  /** Mounts the boat on the first useItem call. */
  mountsOnUse?: boolean
  /** Places a boat without mounting; the mover must right-click it. */
  placesBoat?: boolean
  /** What `boardNearestVehicle` mounts. */
  boardKind?: string
  /** Minecart physics: the rideable moves on its own toward +x. */
  rolling?: boolean
}

class BoatFakePort implements MovementControlPort {
  position: Vec3 = { x: 0, y: 64, z: 0 }
  yaw = 0
  inputs: MovementInput = {}
  riding: RidingInfo | undefined
  placedBoat: RidingInfo | undefined
  useItemCalls = 0
  boardCalls = 0
  dismounts = 0
  useEntityCalls: string[] = []
  selectedSlots: number[] = []
  swaps: Array<[number, number]> = []
  private readonly options: FakeOptions

  constructor(options: FakeOptions = {}) {
    this.options = options
    this.riding = options.riding
  }

  async getState(): Promise<MovementState> {
    if (!this.options.blocked && this.riding) {
      if (this.options.rolling) {
        this.position = { ...this.position, x: this.position.x + 0.8 }
      }
      else if (this.inputs.forward) {
        const radians = this.yaw * Math.PI / 180
        this.position = {
          x: this.position.x - Math.sin(radians) * 1.2,
          y: this.position.y,
          z: this.position.z + Math.cos(radians) * 1.2,
        }
      }
    }
    return { position: { ...this.position }, yaw: this.yaw, inWater: true, onGround: false }
  }

  async getBlocksRegion(): Promise<never[]> {
    return []
  }

  async getBlock(): Promise<BlockView | undefined> {
    // The fixture fakes a deck under the cart: the dock requires a support.
    return { id: 'minecraft:stone', air: false }
  }

  async getInventory(): Promise<InventorySlot[]> {
    return this.options.inventory ?? [{ slot: 4, id: 'minecraft:oak_boat', count: 1, hotbar: true }]
  }

  async look(yaw: number): Promise<void> {
    this.yaw = yaw
  }

  async setInput(input: MovementInput): Promise<void> {
    this.inputs = { ...this.inputs, ...input }
  }

  async stopMovement(): Promise<void> {
    this.inputs = {}
  }

  async jumpOnce(): Promise<void> {}

  async breakBlock(): Promise<void> {}

  async placeBlock(_support: Vec3, _face: BlockFace): Promise<void> {}

  async useBlock(): Promise<void> {}

  async useItem(): Promise<void> {
    this.useItemCalls++
    if (this.options.mountsOnUse)
      this.riding = { kind: 'minecraft:oak_boat', uuid: 'boat-1' }
    if (this.options.placesBoat)
      this.placedBoat = { kind: 'minecraft:oak_boat', uuid: 'boat-2' }
  }

  async selectHotbar(slot: number): Promise<void> {
    this.selectedSlots.push(slot)
  }

  async swapSlots(slotA: number, slotB: number): Promise<void> {
    this.swaps.push([slotA, slotB])
  }

  async dismount(): Promise<void> {
    this.dismounts++
    this.riding = undefined
  }

  async getRiding(): Promise<RidingInfo | undefined> {
    return this.riding
  }

  async boardNearestVehicle(): Promise<{ boarded: boolean, info?: RidingInfo }> {
    this.boardCalls++
    if (this.options.boardKind) {
      this.riding = { kind: this.options.boardKind, uuid: 'ride-1' }
      return { boarded: true, info: this.riding }
    }
    if (this.placedBoat) {
      this.riding = this.placedBoat
      return { boarded: true, info: this.placedBoat }
    }
    return { boarded: false }
  }

  async useEntity(uuid: string): Promise<void> {
    this.useEntityCalls.push(uuid)
  }
}

const FAST = { sleep: async () => {}, now: () => Date.now() }

describe('runVehicleMove boat', () => {
  it('steers an already-mounted boat to the goal and stays mounted on water', async () => {
    const port = new BoatFakePort({ riding: { kind: 'minecraft:oak_boat' } })
    const result = await runVehicleMove('boat', {
      port,
      goal: { x: 6, y: 64, z: 0 },
      tolerance: 1.5,
      deps: FAST,
    })
    expect(result.status).toBe('reached')
    // The fake reports open water at the goal, so no bank exists: the receipt
    // must say the player is still mounted (design §4).
    expect(port.dismounts).toBe(0)
    expect(result.receipt?.arrivedMounted).toBe(true)
    expect(result.receipt?.dismounted).toBe(false)
    expect(port.useItemCalls).toBe(0)
  })

  it('places and mounts a boat when not riding one', async () => {
    const port = new BoatFakePort({ mountsOnUse: true })
    const result = await runVehicleMove('boat', {
      port,
      goal: { x: 4, y: 64, z: 0 },
      deps: FAST,
    })
    expect(result.status).toBe('reached')
    expect(port.useItemCalls).toBeGreaterThanOrEqual(1)
    expect(port.selectedSlots).toContain(4)
  })

  it('swaps a main-inventory boat into a hotbar slot before mounting', async () => {
    const port = new BoatFakePort({
      mountsOnUse: true,
      inventory: [{ slot: 12, id: 'minecraft:oak_boat', count: 1, hotbar: false }],
    })
    const result = await runVehicleMove('boat', {
      port,
      goal: { x: 4, y: 64, z: 0 },
      deps: FAST,
    })
    expect(result.status).toBe('reached')
    // The first genuinely empty hotbar slot is 0, not a fixed slot that may be
    // occupied (design §4: reuse the existing slot-selection capability).
    expect(port.swaps).toEqual([[12, 0]])
    expect(port.selectedSlots).toContain(0)
  })

  it('right-clicks a placed but unmounted boat before steering', async () => {
    const port = new BoatFakePort({ placesBoat: true })
    const result = await runVehicleMove('boat', {
      port,
      goal: { x: 4, y: 64, z: 0 },
      deps: FAST,
    })
    expect(result.status).toBe('reached')
    expect(port.boardCalls).toBe(1)
  })

  it('reports unavailable when no boat item is carried', async () => {
    const port = new BoatFakePort({ inventory: [] })
    const result = await runVehicleMove('boat', {
      port,
      goal: { x: 4, y: 64, z: 0 },
      deps: FAST,
    })
    expect(result.status).toBe('unavailable')
  })

  it('backs out of a stuck boat and reports a typed route failure', async () => {
    const port = new BoatFakePort({ riding: { kind: 'minecraft:oak_boat' }, blocked: true })
    const result = await runVehicleMove('boat', {
      port,
      goal: { x: 6, y: 64, z: 0 },
      deps: FAST,
    })
    expect(result.status).toBe('stuck')
    expect(result.failure).toBe('route_unavailable')
    expect(result.receipt?.dismounted).toBe(false)
  })

  it('cancelling on open water stops input but does not blindly dismount', async () => {
    const port = new BoatFakePort({ riding: { kind: 'minecraft:oak_boat' } })
    let calls = 0
    const result = await runVehicleMove('boat', {
      port,
      goal: { x: 20, y: 64, z: 0 },
      shouldStop: () => ++calls > 2,
      deps: FAST,
    })
    expect(result.status).toBe('cancelled')
    // A boat on water has no safe footing: the player stays mounted and the
    // receipt names the unsafe dismount (design §4, §7).
    expect(port.dismounts).toBe(0)
    expect(result.failure).toBe('unsafe_dismount')
    expect(result.receipt?.dismounted).toBe(false)
  })

  it('reports horse and minecart as not implemented yet', async () => {
    const port = new BoatFakePort()
    expect((await runVehicleMove('horse', { port, goal: { x: 1, y: 64, z: 0 }, deps: FAST })).status).toBe('unavailable')
    expect((await runVehicleMove('minecart', { port, goal: { x: 1, y: 64, z: 0 }, deps: FAST })).status).toBe('unavailable')
  })

  it('rides a horse to the goal and dismounts', async () => {
    const port = new BoatFakePort({ boardKind: 'minecraft:horse' })
    const result = await runVehicleMove('horse', {
      port,
      goal: { x: 6, y: 64, z: 0 },
      deps: FAST,
    })
    expect(result.status).toBe('reached')
    expect(port.dismounts).toBe(1)
    expect(port.boardCalls).toBeGreaterThanOrEqual(1)
  })

  it('reports stuck when a blocked horse keeps refusing to move', async () => {
    const port = new BoatFakePort({ riding: { kind: 'minecraft:horse' }, blocked: true })
    const result = await runVehicleMove('horse', {
      port,
      goal: { x: 6, y: 64, z: 0 },
      deps: { sleep: async () => {}, now: () => Date.now() },
    })
    expect(result.status).toBe('stuck')
    expect(port.dismounts).toBe(1)
  })

  it('waits for a rolling minecart to arrive and dismounts', async () => {
    const port = new BoatFakePort({ riding: { kind: 'minecraft:minecart' }, rolling: true })
    const result = await runVehicleMove('minecart', {
      port,
      goal: { x: 6, y: 64, z: 0 },
      deps: FAST,
    })
    expect(result.status).toBe('reached')
    expect(port.dismounts).toBe(1)
  })

  it('reports stuck when the minecart never arrives', async () => {
    const port = new BoatFakePort({ riding: { kind: 'minecraft:minecart' }, blocked: true })
    let clock = 0
    const result = await runVehicleMove('minecart', {
      port,
      goal: { x: 6, y: 64, z: 0 },
      deps: { sleep: async () => {}, now: () => (clock += 300) },
    })
    expect(result.status).toBe('stuck')
    expect(port.dismounts).toBe(1)
  })
})
