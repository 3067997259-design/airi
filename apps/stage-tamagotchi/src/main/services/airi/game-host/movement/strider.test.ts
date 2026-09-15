import type { BlockFace, BlockView, InventorySlot, MovementControlPort, MovementInput, MovementState, RidingInfo } from './port'
import type { Vec3 } from './types'

import { describe, expect, it } from 'vitest'

import { runStriderMove } from './strider'
import { runVehicleMove } from './vehicle'

const FAST = { sleep: async () => {}, now: () => Date.now() }

interface FakeOptions {
  riding?: RidingInfo
  inventory?: InventorySlot[]
  boardKind?: string
  blocked?: boolean
}

class StriderFakePort implements MovementControlPort {
  position: Vec3 = { x: 0, y: 64, z: 0 }
  yaw = 0
  riding: RidingInfo | undefined
  inputs: MovementInput = {}
  inventory: InventorySlot[]
  boardCalls: Array<{ radius: number | undefined, type: string | undefined }> = []
  selectedSlots: number[] = []
  dismounts = 0
  useItemCalls = 0
  private readonly options: FakeOptions

  constructor(options: FakeOptions = {}) {
    this.options = options
    this.riding = options.riding
    this.inventory = options.inventory ?? [
      { slot: 5, id: 'minecraft:warped_fungus_on_a_stick', count: 1, hotbar: true },
    ]
  }

  async getState(): Promise<MovementState> {
    if (this.riding && this.inputs.forward && !this.options.blocked) {
      const radians = this.yaw * Math.PI / 180
      this.position = {
        x: this.position.x - Math.sin(radians) * 1.5,
        y: 64,
        z: this.position.z + Math.cos(radians) * 1.5,
      }
    }
    return { position: { ...this.position }, yaw: this.yaw, inWater: false, onGround: true }
  }

  async getBlocksRegion(): Promise<never[]> {
    return []
  }

  async getBlock(): Promise<BlockView | undefined> {
    return undefined
  }

  async getInventory(): Promise<InventorySlot[]> {
    return this.inventory
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
  }

  async selectHotbar(slot: number): Promise<void> {
    this.selectedSlots.push(slot)
  }

  async swapSlots(): Promise<void> {}

  async dismount(): Promise<void> {
    this.dismounts++
    this.riding = undefined
  }

  async getRiding(): Promise<RidingInfo | undefined> {
    return this.riding
  }

  async boardNearestVehicle(radius?: number, type?: string): Promise<{ boarded: boolean, info?: RidingInfo }> {
    this.boardCalls.push({ radius, type })
    if (this.options.boardKind) {
      this.riding = { kind: this.options.boardKind, uuid: 'ride-1' }
      return { boarded: true, info: this.riding }
    }
    return { boarded: false }
  }

  async useEntity(): Promise<void> {}
}

describe('runStriderMove', () => {
  it('steers a mounted strider to the goal with stick pulses and dismounts', async () => {
    const port = new StriderFakePort({ riding: { kind: 'minecraft:strider' } })
    const result = await runStriderMove({ port, goal: { x: 10, y: 64, z: 0 }, deps: FAST })
    expect(result.status).toBe('reached')
    expect(port.dismounts).toBe(1)
    expect(port.selectedSlots).toContain(5)
    expect(port.useItemCalls).toBeGreaterThanOrEqual(1)
  })

  it('boards a strider by type when not riding one', async () => {
    const port = new StriderFakePort({ boardKind: 'minecraft:strider' })
    const result = await runStriderMove({ port, goal: { x: 5, y: 64, z: 0 }, deps: FAST })
    expect(result.status).toBe('reached')
    expect(port.boardCalls[0]).toEqual({ radius: 6, type: 'minecraft:strider' })
  })

  it('refuses to steer without the warped fungus on a stick', async () => {
    const port = new StriderFakePort({
      riding: { kind: 'minecraft:strider' },
      inventory: [{ slot: 3, id: 'minecraft:bread', count: 2, hotbar: true }],
    })
    const result = await runStriderMove({ port, goal: { x: 5, y: 64, z: 0 }, deps: FAST })
    expect(result.status).toBe('unavailable')
    expect(result.detail).toContain('warped_fungus_on_a_stick')
    expect(port.dismounts).toBe(1)
  })

  it('fails with stuck when the strider never moves', async () => {
    const port = new StriderFakePort({ riding: { kind: 'minecraft:strider' }, blocked: true })
    const result = await runStriderMove({ port, goal: { x: 20, y: 64, z: 0 }, deps: FAST })
    expect(result.status).toBe('stuck')
  })

  it('is reachable through the vehicle dispatcher', async () => {
    const port = new StriderFakePort({ riding: { kind: 'minecraft:strider' } })
    const result = await runVehicleMove('strider', { port, goal: { x: 5, y: 64, z: 0 }, deps: FAST })
    expect(result.status).toBe('reached')
  })
})
