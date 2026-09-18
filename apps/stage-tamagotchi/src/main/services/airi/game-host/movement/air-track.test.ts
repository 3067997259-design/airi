import type { BlockFace, BlockView, EquipmentView, InventorySlot, MovementControlPort, MovementInput, MovementState, RidingInfo } from './port'
import type { SnapshotEntry } from './snapshot'
import type { TargetObservation } from './target-observation'
import type { Vec3 } from './types'

import { describe, expect, it } from 'vitest'

import { FLIGHT_PROFILE_1_21_1 } from '../flight/profile'
import { runAirTrackMove } from './air-track'

const CHEST_SLOT = 37

interface FakeOptions {
  inventory?: InventorySlot[]
  chest?: EquipmentView
  /** Gliding polls before the fake touches down. */
  flightPolls?: number
  landAt?: Vec3
}

class AirFakePort implements MovementControlPort {
  position: Vec3 = { x: 0, y: 100, z: 0 }
  yaw = 0
  onGround = true
  fallFlying = false
  jumps = 0
  fireworkUses = 0
  currentHotbar = -1
  inputs: MovementInput = {}
  inventory: InventorySlot[]
  private chest: EquipmentView | undefined
  private glidePolls = 0
  private readonly options: FakeOptions

  constructor(options: FakeOptions) {
    this.options = options
    this.inventory = options.inventory ?? [
      { slot: 4, id: 'minecraft:firework_rocket', count: 16, hotbar: true },
      { slot: 12, id: 'minecraft:elytra', count: 1, hotbar: false },
    ]
    this.chest = options.chest
  }

  async getState(): Promise<MovementState> {
    if (this.onGround && this.inputs.forward) {
      this.onGround = false
    }
    else if (!this.onGround && !this.fallFlying && this.jumps > 0) {
      this.fallFlying = true
    }
    if (this.fallFlying) {
      this.glidePolls += 1
      if (this.glidePolls >= (this.options.flightPolls ?? 18)) {
        this.position = { ...(this.options.landAt ?? { x: this.position.x, y: 64, z: this.position.z }) }
        this.fallFlying = false
        this.onGround = true
      }
      else {
        this.position = { x: this.position.x + 1, y: this.position.y - 0.2, z: this.position.z }
      }
    }
    return {
      position: { ...this.position },
      yaw: this.yaw,
      inWater: false,
      onGround: this.onGround,
      motion: this.onGround ? { x: 0, y: 0, z: 0 } : { x: 1, y: 0, z: 0 },
      fallFlying: this.fallFlying,
      health: 20,
    }
  }

  async getBlocksRegion(): Promise<SnapshotEntry[]> {
    return []
  }

  async getBlock(): Promise<BlockView | undefined> {
    return { id: 'minecraft:air', air: true }
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

  async jumpOnce(): Promise<void> {
    this.jumps++
  }

  async breakBlock(): Promise<void> {}
  async placeBlock(_support: Vec3, _face: BlockFace): Promise<void> {}
  async useBlock(): Promise<void> {}

  async useItem(): Promise<void> {
    this.fireworkUses++
    const selected = this.inventory.find(slot => slot.slot === this.currentHotbar)
    if (selected && selected.count > 0)
      selected.count -= 1
  }

  async selectHotbar(slot: number): Promise<void> {
    this.currentHotbar = slot
  }

  async swapSlots(slotA: number, slotB: number): Promise<void> {
    if (slotB === CHEST_SLOT) {
      const item = this.inventory.find(slot => slot.slot === slotA)
      if (item)
        this.chest = { id: item.id }
    }
  }

  async dismount(): Promise<void> {}
  async getRiding(): Promise<RidingInfo | undefined> { return undefined }
  async boardNearestVehicle(): Promise<{ boarded: boolean }> { return { boarded: false } }
  async useEntity(): Promise<void> {}
  async getEquipment(): Promise<{ chest?: EquipmentView } | undefined> {
    return this.chest ? { chest: this.chest } : {}
  }
}

function observation(overrides: Partial<TargetObservation> = {}): TargetObservation {
  return {
    targetUuid: 'u-1',
    worldId: 'world-1',
    dimension: 'minecraft:overworld',
    onGround: false,
    fallFlying: true,
    riding: false,
    alive: true,
    source: 'server-entity',
    receivedAt: 0,
    requestStartedAt: 0,
    requestEndedAt: 0,
    requestDurationMs: 0,
    connectionGeneration: 1,
    visibility: 'loaded',
    completeness: 'complete',
    positionUncertainty: 0.25,
    position: { x: 20, y: 80, z: 0 },
    velocity: { x: 0.4, y: 0, z: 0 },
    ...overrides,
  }
}

function fakeClock() {
  let clock = 0
  return {
    deps: { now: () => clock, sleep: async (ms: number) => { clock += ms } },
    advance: (ms: number) => { clock += ms },
  }
}

describe('runAirTrackMove', () => {
  it('lands after the target touches down', async () => {
    const clock = fakeClock()
    const port = new AirFakePort({ flightPolls: 24 })
    let reads = 0
    const result = await runAirTrackMove({
      port,
      readTarget: async () => {
        reads += 1
        // The target lands after enough samples for the takeoff and track.
        return reads > 10
          ? observation({ fallFlying: false, onGround: true, velocity: { x: 0, y: 0, z: 0 }, position: { x: 40, y: 64, z: 0 } })
          : observation()
      },
      deps: clock.deps,
    })
    expect(result.status).toBe('landed')
    expect(port.onGround).toBe(true)
    expect(port.fireworkUses).toBeGreaterThanOrEqual(0)
    expect(result.receipt.activeMs).toBeGreaterThan(0)
  })

  it('annotates the receipt with the polling strategy stream', async () => {
    const clock = fakeClock()
    const port = new AirFakePort({ flightPolls: 24 })
    let reads = 0
    const result = await runAirTrackMove({
      port,
      readTarget: async () => {
        reads += 1
        return reads > 10
          ? observation({ fallFlying: false, onGround: true, velocity: { x: 0, y: 0, z: 0 }, position: { x: 40, y: 64, z: 0 } })
          : observation()
      },
      deps: clock.deps,
    })
    expect(result.status).toBe('landed')
    expect(result.receipt.updateStream).toBe('polling')
  })

  it('consults the rollout planner on cruise polls and falls back on unknown cells', async () => {
    const clock = fakeClock()
    const port = new AirFakePort({ flightPolls: 24 })
    // The fake region read returns no cells, so every swept cell is unknown:
    // the planner declines each poll and the heuristics keep driving.
    let regionReads = 0
    const original = port.getBlocksRegion.bind(port)
    port.getBlocksRegion = async (from, to) => {
      regionReads += 1
      return await original(from, to)
    }
    let reads = 0
    const result = await runAirTrackMove({
      port,
      flightPlanner: { enabled: true, profile: FLIGHT_PROFILE_1_21_1, calibrated: false },
      readTarget: async () => {
        reads += 1
        return reads > 10
          ? observation({ fallFlying: false, onGround: true, velocity: { x: 0, y: 0, z: 0 }, position: { x: 40, y: 64, z: 0 } })
          : observation()
      },
      deps: clock.deps,
    })
    expect(result.status).toBe('landed')
    expect(regionReads).toBeGreaterThan(0)
    expect(result.receipt.updateStream).toBe('polling')
  })

  it('refuses to follow without an elytra', async () => {
    const clock = fakeClock()
    const port = new AirFakePort({ inventory: [{ slot: 4, id: 'minecraft:firework_rocket', count: 16, hotbar: true }] })
    const result = await runAirTrackMove({ port, readTarget: async () => observation(), deps: clock.deps })
    expect(result.status).toBe('cannot_air_follow')
    expect(result.detail).toContain('elytra')
  })

  it('refuses to follow without fireworks', async () => {
    const clock = fakeClock()
    const port = new AirFakePort({ inventory: [{ slot: 12, id: 'minecraft:elytra', count: 1, hotbar: false }] })
    const result = await runAirTrackMove({ port, readTarget: async () => observation(), deps: clock.deps })
    expect(result.status).toBe('cannot_air_follow')
  })

  it('cancels into a bounded landing', async () => {
    const clock = fakeClock()
    const port = new AirFakePort({ flightPolls: 40 })
    let polls = 0
    const result = await runAirTrackMove({
      port,
      readTarget: async () => observation(),
      deps: clock.deps,
      shouldStop: () => {
        if (port.fallFlying)
          polls += 1
        return polls > 3
      },
    })
    expect(result.status).toBe('cancelled')
    expect(port.onGround).toBe(true)
  })

  it('lands early and reports low_supply when only the reserve remains', async () => {
    const clock = fakeClock()
    const port = new AirFakePort({
      flightPolls: 20,
      inventory: [
        { slot: 4, id: 'minecraft:firework_rocket', count: 2, hotbar: true },
        { slot: 12, id: 'minecraft:elytra', count: 1, hotbar: false },
      ],
    })
    const result = await runAirTrackMove({ port, readTarget: async () => observation(), deps: clock.deps })
    expect(result.status).toBe('low_supply')
    expect(port.onGround).toBe(true)
  })

  it('releases the input when a state read fails in flight', async () => {
    const clock = fakeClock()
    const port = new AirFakePort({ flightPolls: 40 })
    let reads = 0
    const readState = port.getState.bind(port)
    port.getState = async () => {
      reads += 1
      if (reads > 6)
        throw new Error('bridge lost')
      return readState()
    }
    await expect(runAirTrackMove({ port, readTarget: async () => observation(), deps: clock.deps })).rejects.toThrow('bridge lost')
    expect(port.inputs).toEqual({})
  })
})
