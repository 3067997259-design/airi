import type { BlockFace, BlockView, EquipmentView, InventorySlot, MovementControlPort, MovementInput, MovementState, RidingInfo } from './port'
import type { SnapshotEntry } from './snapshot'
import type { TargetObservation } from './target-observation'
import type { Vec3 } from './types'

import { describe, expect, it } from 'vitest'

import { FLIGHT_PROFILE_1_21_1 } from '../flight/profile'
import { runAirTrackMove } from './air-track'

interface FakeOptions {
  inventory?: InventorySlot[]
  chest?: EquipmentView
  /** Gliding polls before the fake touches down. */
  flightPolls?: number
  landAt?: Vec3
  /** Region reads answer a real floor-and-air world instead of an empty one. */
  scriptedTerrain?: boolean
  /** Hard region-read failure (bridge gone). */
  failRegionReads?: boolean
  /** Keeps the glider in place, so the distance to a fixed target cannot close. */
  idleGlide?: boolean
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
  /** Region reads the driver made, including the B0 corridor and rollout reads. */
  regionReads = 0
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
        this.position = this.options.idleGlide
          ? { x: 0, y: 100, z: 0 }
          : { x: this.position.x + 1, y: this.position.y - 0.2, z: this.position.z }
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

  async getBlocksRegion(from: Vec3, to: Vec3): Promise<SnapshotEntry[]> {
    this.regionReads += 1
    if (this.options.failRegionReads)
      throw new Error('bridge unavailable')
    if (!this.options.scriptedTerrain)
      return []
    // A floor at y 80 with open air above it: every read cell is known, so the
    // corridor and the rollout can both plan over it.
    const entries: SnapshotEntry[] = []
    for (let x = from.x; x <= to.x; x++) {
      for (let y = from.y; y <= to.y; y++) {
        for (let z = from.z; z <= to.z; z++)
          entries.push({ x, y, z, id: y <= 80 ? 'minecraft:stone' : 'minecraft:air' })
      }
    }
    return entries
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
    // Vanilla: using an elytra while not gliding wears it. The mover wears a
    // spare that way instead of writing the armor slot, which the bridge cannot
    // do (live 2026-09-18), so this use is not a rocket.
    const held = this.inventory.find(slot => slot.slot === this.currentHotbar)
    if (held?.id.includes('elytra')) {
      const previous = this.chest
      this.chest = { id: held.id }
      if (previous) {
        held.id = previous.id
      }
      else {
        held.id = ''
        held.count = 0
      }
      return
    }
    this.fireworkUses++
    const selected = this.inventory.find(slot => slot.slot === this.currentHotbar)
    if (selected && selected.count > 0)
      selected.count -= 1
  }

  async selectHotbar(slot: number): Promise<void> {
    this.currentHotbar = slot
  }

  async swapSlots(slotA: number, slotB: number): Promise<void> {
    // The bridge cannot write armor slots: `InventoryHandlers.toMenuSlot` reverses
    // the armor order, so a swap into 36..39 answers `swapped` and changes nothing.
    if (slotB >= 36 && slotB <= 39)
      return
    const from = this.inventory.find(slot => slot.slot === slotA)
    const to = this.inventory.find(slot => slot.slot === slotB)
    if (!from)
      return
    const moved = { ...from }
    if (to) {
      from.id = to.id
      from.count = to.count
      to.id = moved.id
      to.count = moved.count
    }
    else {
      this.inventory.push({ ...moved, slot: slotB, hotbar: slotB <= 8 })
      from.id = ''
      from.count = 0
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
    expect(port.regionReads).toBeGreaterThan(0)
    expect(result.receipt.updateStream).toBe('polling')
  })

  it('records a planned coarse corridor on the receipt', async () => {
    const clock = fakeClock()
    const port = new AirFakePort({ flightPolls: 24, scriptedTerrain: true })
    let reads = 0
    const result = await runAirTrackMove({
      port,
      flightPlanner: { enabled: true, profile: FLIGHT_PROFILE_1_21_1, calibrated: false },
      world: { worldId: 'world-1', dimension: 'minecraft:overworld', mapVersion: 'live' },
      readTarget: async () => {
        reads += 1
        return reads > 10
          ? observation({ fallFlying: false, onGround: true, velocity: { x: 0, y: 0, z: 0 }, position: { x: 40, y: 64, z: 0 } })
          : observation()
      },
      deps: clock.deps,
    })
    expect(result.status).toBe('landed')
    expect(result.receipt.corridor).toBe('planned')
    // The B0 corridor is an addition to the polling stream, not a replacement.
    expect(result.receipt.updateStream).toBe('polling')
  })

  it('records a failed corridor read without blocking the flight', async () => {
    const clock = fakeClock()
    const port = new AirFakePort({ flightPolls: 24, failRegionReads: true })
    let reads = 0
    const result = await runAirTrackMove({
      port,
      flightPlanner: { enabled: true, profile: FLIGHT_PROFILE_1_21_1, calibrated: false },
      world: { worldId: 'world-1', dimension: 'minecraft:overworld', mapVersion: 'live' },
      readTarget: async () => {
        reads += 1
        return reads > 10
          ? observation({ fallFlying: false, onGround: true, velocity: { x: 0, y: 0, z: 0 }, position: { x: 40, y: 64, z: 0 } })
          : observation()
      },
      deps: clock.deps,
    })
    // A missing read is a missing route, not a missing flight: the driver keeps
    // its own goal and the receipt names the refusal.
    expect(result.status).toBe('landed')
    expect(result.receipt.corridor).toBe('read_failed')
  })

  it('refuses the takeoff when the escort gate cannot afford the chase', async () => {
    const clock = fakeClock()
    // 4 fireworks against a 2-rocket reserve leaves 2 spendable. A target 300
    // blocks out and running at 20 blocks/s cannot be closed by 2 rockets at the
    // calibrated boost window (35 ticks x (1.5 - 1.0) = 17.5 blocks each), so the
    // launch must not happen (escort design D2/D8).
    //
    // The fixture used to be a 20-block chase at 8 blocks/s, which the gate
    // refused only because it still assumed a 10-tick boost window. E-01 measured
    // 35, and with the calibrated number that chase is genuinely affordable.
    const port = new AirFakePort({
      flightPolls: 24,
      inventory: [
        { slot: 4, id: 'minecraft:firework_rocket', count: 4, hotbar: true },
        { slot: 12, id: 'minecraft:elytra', count: 1, hotbar: false },
      ],
    })
    const result = await runAirTrackMove({
      port,
      escort: 'on',
      readTarget: async () => observation({ position: { x: 300, y: 80, z: 0 }, velocity: { x: 1, y: 0, z: 0 } }),
      deps: clock.deps,
    })
    expect(result.status).toBe('low_supply')
    expect(result.detail).toContain('escort refused the takeoff')
    expect(result.receipt.escortGate).toBe('cannot_catch_up')
    // No launch attempt was spent on the refused chase.
    expect(port.fireworkUses).toBe(0)
    expect(port.jumps).toBe(0)
  })

  it('ends the chase honestly after two non-closing closure windows', async () => {
    const clock = fakeClock()
    // The glider holds station while the target holds its distance, so the gap
    // never closes. The injected window is short so the test stays bounded; the
    // production default is 5 s (escort design D4).
    const port = new AirFakePort({ flightPolls: 60, idleGlide: true })
    const result = await runAirTrackMove({
      port,
      escort: 'on',
      escortClosure: { windowMs: 400, stalledWindowsLimit: 2 },
      readTarget: async () => observation(),
      deps: clock.deps,
    })
    expect(result.receipt.endReason).toBe('escort_inconclusive')
    // The series is kept so the failed chase can be explained after the fact.
    expect(result.receipt.escortClosure?.length).toBeGreaterThan(1)
    expect(result.receipt.escortClosure?.at(-1)?.status).toBe('escort_inconclusive')
    expect(result.receipt.reserveFireworks).toBe(2)
  })

  it('leaves the flight unchanged when escort is off', async () => {
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
    // No escort fields at all: the pre-LR-1 receipt shape is preserved.
    expect(result.receipt.escortGate).toBeUndefined()
    expect(result.receipt.escortClosure).toBeUndefined()
    expect(result.receipt.reserveFireworks).toBeUndefined()
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
