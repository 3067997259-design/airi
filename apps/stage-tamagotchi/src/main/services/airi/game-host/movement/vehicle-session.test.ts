import type { BlockView, InventorySlot, MovementInput, MovementState, RidingInfo } from './port'
import type { TriState } from './target-observation'
import type { Vec3 } from './types'
import type { VehicleMoveOptions } from './vehicle-port'
import type { VehicleObservation, VehicleObservationRequest, VehicleQueryRequest } from './vehicle-types'

import { describe, expect, it } from 'vitest'

import { runVehicleMove } from './vehicle'
import { runVehicleTravel } from './vehicle-session'

interface FakeOptions {
  riding?: RidingInfo
  inventory?: InventorySlot[]
  vehicles?: VehicleObservation[]
  /** Blocks the vehicle moves per getState while forward is held. */
  speed?: number
  /** The cart moves on its own, independent of input. */
  rolling?: boolean
  /** Fresh player/vehicle footing facts. */
  inWater?: boolean
  onGround?: boolean
  /** Report air under the cart at the dock: no stance (V-08 fixture). */
  supportAir?: boolean
  /** useItem spawns this vehicle and seats the player. */
  placeOnUse?: { uuid: string, type: string }
  /** boardNearestVehicle mounts this type (legacy path). */
  legacyBoardType?: string
  /** Clears the riding state after this many getState calls (throw-off). */
  clearRidingAfter?: number
  /** Replaces the riding uuid after this many getState calls. */
  hijackAfter?: number
  /** Reports another dimension after this many getState calls. */
  dimensionSwitchAfter?: number
}

const FAST = { sleep: async () => {}, now: () => Date.now() }

function makeObservation(input: {
  uuid: string
  type: string
  kind: VehicleObservation['kind']
  state: VehicleObservation['state']
  position?: Vec3
  free?: TriState
  yaw?: number
  dimension?: string
}): VehicleObservation {
  return {
    uuid: input.uuid,
    type: input.type,
    kind: input.kind,
    worldId: 'world',
    dimension: input.dimension ?? 'minecraft:overworld',
    position: input.position ?? { x: 0, y: 64, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    ...(input.yaw !== undefined ? { yaw: input.yaw } : {}),
    passengers: [],
    free: input.free ?? true,
    owned: 'unobserved',
    state: input.state,
    source: 'client-loaded-entity',
    receivedAt: 0,
    requestStartedAt: 0,
    requestEndedAt: 0,
    requestDurationMs: 0,
    connectionGeneration: 1,
    completeness: 'complete',
  }
}

class VehicleFakePort {
  position: Vec3 = { x: 0, y: 64, z: 0 }
  yaw = 0
  pitch = 0
  dimension = 'minecraft:overworld'
  inputs: MovementInput = {}
  riding: RidingInfo | undefined
  vehicles = new Map<string, VehicleObservation>()
  inventory: InventorySlot[]
  useItemCalls = 0
  dismounts = 0
  boardCalls: Array<{ uuid?: string, radius?: number, type?: string }> = []
  interactCalls: Array<{ uuid: string, action: string }> = []
  private getStateCalls = 0
  private readonly options: FakeOptions

  constructor(options: FakeOptions = {}) {
    this.options = options
    this.riding = options.riding
    this.inventory = options.inventory ? [...options.inventory] : []
    for (const observation of options.vehicles ?? [])
      this.vehicles.set(observation.uuid, observation)
  }

  private syncObservation(): void {
    if (!this.riding?.uuid)
      return
    const observation = this.vehicles.get(this.riding.uuid)
    if (observation) {
      observation.position = { ...this.position }
      observation.yaw = this.yaw
    }
  }

  async getState(): Promise<MovementState> {
    this.getStateCalls++
    if (this.options.dimensionSwitchAfter !== undefined && this.getStateCalls > this.options.dimensionSwitchAfter) {
      this.dimension = 'minecraft:nether'
      for (const observation of this.vehicles.values())
        observation.dimension = 'minecraft:nether'
    }
    if (this.options.clearRidingAfter !== undefined && this.getStateCalls > this.options.clearRidingAfter)
      this.riding = undefined
    if (this.options.hijackAfter !== undefined && this.getStateCalls > this.options.hijackAfter)
      this.riding = { kind: 'minecraft:oak_boat', uuid: 'other-boat' }

    if (this.riding) {
      if (this.options.rolling) {
        this.position = { ...this.position, x: this.position.x + 0.8 }
      }
      else if (this.inputs.forward) {
        const speed = this.options.speed ?? 1
        const radians = this.yaw * Math.PI / 180
        this.position = {
          x: this.position.x - Math.sin(radians) * speed,
          y: this.position.y,
          z: this.position.z + Math.cos(radians) * speed,
        }
      }
      this.syncObservation()
    }
    return {
      position: { ...this.position },
      yaw: this.yaw,
      inWater: this.options.inWater ?? false,
      onGround: this.options.onGround ?? true,
      observation: {
        source: 'client-loaded-world',
        worldId: 'world',
        dimension: this.dimension,
        connectionGeneration: 1,
        receivedAt: 0,
        requestStartedAt: 0,
        requestEndedAt: 0,
        completeness: 'complete',
      },
    }
  }

  async getBlocksRegion(): Promise<Array<{ x: number, y: number, z: number, id: string }>> {
    return []
  }

  async getBlock(): Promise<BlockView | undefined> {
    return this.options.supportAir === true ? { id: 'minecraft:air', air: true } : { id: 'minecraft:stone', air: false }
  }

  async getInventory(): Promise<InventorySlot[]> {
    return this.inventory
  }

  async look(yaw: number, pitch?: number): Promise<void> {
    this.yaw = yaw
    this.pitch = pitch ?? 0
    this.syncObservation()
  }

  async setInput(input: MovementInput): Promise<void> {
    this.inputs = { ...this.inputs, ...input }
  }

  async stopMovement(): Promise<void> {
    this.inputs = {}
  }

  async jumpOnce(): Promise<void> {}
  async breakBlock(): Promise<void> {}
  async placeBlock(): Promise<void> {}
  async useBlock(): Promise<void> {}

  async useItem(): Promise<void> {
    this.useItemCalls++
    if (this.options.placeOnUse) {
      const { uuid, type } = this.options.placeOnUse
      const observation = makeObservation({
        uuid,
        type,
        kind: type.includes('minecart') ? 'minecart' : 'boat',
        state: type.includes('minecart')
          ? { kind: 'minecart', powered: true, onRail: true, speed: 0 }
          : { kind: 'boat', inWater: true, boatItemId: type },
        position: { ...this.position },
      })
      this.vehicles.set(uuid, observation)
      this.riding = { kind: type, uuid }
      const index = this.inventory.findIndex(slot => slot.count > 0 && (slot.id.includes('boat') || slot.id.includes('minecart')))
      if (index >= 0) {
        const slot = this.inventory[index]!
        this.inventory[index] = { ...slot, count: slot.count - 1 }
      }
    }
  }

  async selectHotbar(): Promise<void> {}

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
    if (this.options.legacyBoardType) {
      this.riding = { kind: this.options.legacyBoardType, uuid: 'legacy-1' }
      return { boarded: true, info: this.riding }
    }
    return { boarded: false }
  }

  async useEntity(uuid: string): Promise<void> {
    this.interactCalls.push({ uuid, action: 'use' })
  }

  async observeVehicle(request: VehicleObservationRequest): Promise<VehicleObservation | undefined> {
    return this.vehicles.get(request.uuid)
  }

  async queryVehicles(request: VehicleQueryRequest): Promise<VehicleObservation[]> {
    return [...this.vehicles.values()].filter((observation) => {
      if (request.kind && observation.kind !== request.kind)
        return false
      if (request.origin && observation.position) {
        const distance = Math.hypot(observation.position.x - request.origin.x, observation.position.z - request.origin.z)
        if (request.radius !== undefined && distance > request.radius)
          return false
      }
      return true
    })
  }

  async boardVehicle(uuid: string): Promise<{ boarded: boolean, info?: RidingInfo }> {
    this.boardCalls.push({ uuid })
    const observation = this.vehicles.get(uuid)
    if (!observation)
      return { boarded: false }
    this.riding = { kind: observation.type, uuid }
    return { boarded: true, info: this.riding }
  }

  async interactVehicle(input: { uuid: string, action: 'tame' | 'saddle' | 'mount' }): Promise<{ ok: boolean }> {
    this.interactCalls.push({ uuid: input.uuid, action: input.action })
    const observation = this.vehicles.get(input.uuid)
    if (observation && (observation.state.kind === 'horse' || observation.state.kind === 'donkey' || observation.state.kind === 'mule')) {
      if (input.action === 'tame') {
        observation.state.tamed = true
        observation.state.controlledByPassenger = true
      }
      if (input.action === 'saddle') {
        observation.state.saddled = true
        const index = this.inventory.findIndex(slot => slot.id === 'minecraft:saddle')
        if (index >= 0) {
          const slot = this.inventory[index]!
          this.inventory[index] = { ...slot, count: slot.count - 1 }
        }
      }
    }
    return { ok: true }
  }
}

function boatUuid(uuid: string, overrides: Partial<VehicleObservation> = {}): VehicleObservation {
  return makeObservation({ uuid, type: 'minecraft:oak_boat', kind: 'boat', state: { kind: 'boat', inWater: true }, ...overrides })
}

function horseUuid(uuid: string, state: Partial<{ tamed: TriState, saddled: TriState, controlledByPassenger: TriState }> = {}): VehicleObservation {
  return makeObservation({
    uuid,
    type: 'minecraft:horse',
    kind: 'horse',
    state: { kind: 'horse', tamed: state.tamed ?? true, saddled: state.saddled ?? true, controlledByPassenger: state.controlledByPassenger ?? true },
  })
}

function cartUuid(uuid: string, powered: TriState = true, speed = 0): VehicleObservation {
  return makeObservation({
    uuid,
    type: 'minecraft:minecart',
    kind: 'minecart',
    state: { kind: 'minecart', powered, onRail: true, speed },
  })
}

function optionsFor(port: VehicleFakePort, overrides: Partial<VehicleMoveOptions> = {}): VehicleMoveOptions {
  return {
    port,
    goal: { x: 6, y: 64, z: 0 },
    tolerance: 1.5,
    deps: FAST,
    commandId: 'cmd-1',
    controlSessionId: 'ctl-1',
    controlSessionGeneration: 3,
    playerUuid: 'p-1',
    ...overrides,
  }
}

describe('vehicle travel session: boat', () => {
  it('uses an existing free boat, docks on land and records a full receipt', async () => {
    const port = new VehicleFakePort({ vehicles: [boatUuid('boat-1')] })
    const result = await runVehicleTravel('boat', optionsFor(port))
    expect(result.status).toBe('reached')
    expect(port.dismounts).toBe(1)
    expect(result.receipt).toMatchObject({
      commandId: 'cmd-1',
      controlSessionId: 'ctl-1',
      controlSessionGeneration: 3,
      acquireMethod: 'existing',
      vehicleUuid: 'boat-1',
      dismounted: true,
      endReason: 'reached',
    })
    expect(result.receipt?.distanceTravelled).toBeGreaterThan(0)
    expect(result.receipt?.phases).toEqual(['discover', 'prepare', 'acquire', 'verify-control', 'plan', 'travel', 'dock', 'finish'])
  })

  it('places exactly one boat from own materials and verifies the item delta', async () => {
    const port = new VehicleFakePort({
      inventory: [{ slot: 4, id: 'minecraft:oak_boat', count: 1, hotbar: true }],
      placeOnUse: { uuid: 'boat-new', type: 'minecraft:oak_boat' },
      vehicles: [boatUuid('boat-occupied', { free: false })],
    })
    // ROOT CAUSE:
    //
    // Placing a boat is a normal item use that reads the crosshair. The
    // prepare_owned path aimed level at the far goal, which hits nothing inside
    // the interaction reach, so the item was never consumed and no boat spawned
    // (live F-14, 2026-07-17 probe).
    //
    // <before-patch behavior/code>
    // await port.look(yawToGoal, 0)
    //
    // We fixed this by looking down at the water beside the player.
    const looks: Array<{ yaw: number, pitch: number }> = []
    const originalLook = port.look.bind(port)
    port.look = async (yaw: number, pitch?: number) => {
      looks.push({ yaw, pitch: pitch ?? 0 })
      await originalLook(yaw)
    }
    const result = await runVehicleTravel('boat', optionsFor(port, { strategy: 'prepare_owned' }))
    expect(result.status).toBe('reached')
    expect(looks.some(look => look.pitch > 30)).toBe(true)
    expect(port.useItemCalls).toBe(1)
    expect(result.receipt?.acquireMethod).toBe('prepare_owned')
    expect(result.receipt?.vehicleUuid).toBe('boat-new')
    expect(result.receipt?.asset).toMatchObject({ itemId: 'minecraft:oak_boat', consumed: 1, location: 'vehicle' })
  })

  it('retries the board until the client sees the vehicle', async () => {
    // ROOT CAUSE:
    //
    // The client receives entities a moment after the player arrives, so one
    // immediate interaction missed a boat that was already in the world (live
    // deck run 2026-09-17: boarded=false right after the teleport, then true
    // ~1 s later).
    //
    // <before-patch behavior/code>
    // const boarded = await board(ctx, uuid, type)
    //
    // We fixed this by retrying the board inside a bounded window.
    const port = new VehicleFakePort({ vehicles: [boatUuid('boat-late')] })
    let boards = 0
    const original = port.boardVehicle.bind(port)
    port.boardVehicle = async (uuid: string) => {
      boards++
      return boards <= 2 ? { boarded: false } : await original(uuid)
    }
    const result = await runVehicleTravel('boat', optionsFor(port))
    expect(result.status).toBe('reached')
    expect(boards).toBeGreaterThan(2)
  })
  it('steers along the read water route instead of straight at the goal', async () => {
    // ROOT CAUSE:
    //
    // The boat drove straight at the goal, so a bend pushed the hull into the
    // bank and the trip stalled with route_unavailable (live V-01/V-02,
    // 2026-09-17: the diagonal bend stopped the cart at 21-25 blocks).
    //
    // <before-patch behavior/code>
    // const plan = observation ? planBoatApproach({ ..., waypoint: goal, goal, ... }) : undefined
    //
    // We fixed this by planning a route over the read water cells and steering
    // at the next route cell.
    const port = new VehicleFakePort({ vehicles: [boatUuid('boat-1')] })
    port.position = { x: 0.5, y: 64, z: 1.5 }
    // A 3-wide L: east along z 0..2, then south along x 4..6. The wide corner
    // absorbs the fake's instant one-block steps, the same way the fixture's
    // banks absorb a real hull's turn radius.
    const water: Array<{ x: number, y: number, z: number, id: string }> = []
    for (let x = 0; x <= 5; x++) {
      for (let z = 0; z <= 2; z++) water.push({ x, y: 64, z, id: 'minecraft:water' })
    }
    for (let x = 4; x <= 6; x++) {
      for (let z = 2; z <= 6; z++) water.push({ x, y: 64, z, id: 'minecraft:water' })
    }
    port.getBlocksRegion = async () => water
    const looks: number[] = []
    const originalLook = port.look.bind(port)
    port.look = async (yaw: number, pitch?: number) => {
      looks.push(yaw)
      await originalLook(yaw, pitch)
    }
    const result = await runVehicleTravel('boat', optionsFor(port, { goal: { x: 5, y: 64, z: 4 }, tolerance: 1.5 }))
    expect(result.status).toBe('reached')
    // A straight-line follower keeps one yaw; steering along the route turns the
    // hull through the bend, so the commanded yaw spread is the observable fact.
    const spread = Math.max(...looks) - Math.min(...looks)
    expect(spread).toBeGreaterThanOrEqual(45)
  })

  it('reports an occupied explicit boat instead of claiming it', async () => {
    const port = new VehicleFakePort({ vehicles: [boatUuid('boat-taken', { free: false })] })
    const result = await runVehicleTravel('boat', optionsFor(port, { vehicleUuid: 'boat-taken' }))
    expect(result.status).toBe('unavailable')
    expect(result.failure).toBe('occupied')
  })

  it('stops input but does not dismount on open water when cancelled', async () => {
    let calls = 0
    const port = new VehicleFakePort({ vehicles: [boatUuid('boat-1')], inWater: true, onGround: false })
    const result = await runVehicleTravel('boat', optionsFor(port, {
      goal: { x: 40, y: 64, z: 0 },
      shouldStop: () => {
        return ++calls > 3
      },
    }))
    expect(result.status).toBe('cancelled')
    expect(port.dismounts).toBe(0)
    expect(result.failure).toBe('unsafe_dismount')
    expect(result.receipt?.dismounted).toBe(false)
  })

  it('reports arrived_mounted when the goal has no bank', async () => {
    const port = new VehicleFakePort({ vehicles: [boatUuid('boat-1')], inWater: true, onGround: false })
    const result = await runVehicleTravel('boat', optionsFor(port))
    expect(result.status).toBe('reached')
    expect(result.receipt?.arrivedMounted).toBe(true)
    expect(port.dismounts).toBe(0)
  })

  it('ends the trip with vehicle_lost when the boat disappears', async () => {
    const port = new VehicleFakePort({ vehicles: [boatUuid('boat-1')], clearRidingAfter: 2 })
    const result = await runVehicleTravel('boat', optionsFor(port, { goal: { x: 40, y: 64, z: 0 } }))
    expect(result.failure).toBe('vehicle_lost')
    expect(result.receipt?.dismounted).toBe(false)
  })

  it('ends the trip with dimension_changed when the world binding changes', async () => {
    const port = new VehicleFakePort({ vehicles: [boatUuid('boat-1')], dimensionSwitchAfter: 5 })
    const result = await runVehicleTravel('boat', optionsFor(port, { goal: { x: 40, y: 64, z: 0 } }))
    expect(result.failure).toBe('dimension_changed')
  })

  it('ends the trip when another player takes control of the vehicle', async () => {
    const port = new VehicleFakePort({ vehicles: [boatUuid('boat-1')] })
    const taken = port.vehicles.get('boat-1')!
    taken.controller = 'other-player'
    const result = await runVehicleTravel('boat', optionsFor(port, { goal: { x: 40, y: 64, z: 0 } }))
    expect(result.failure).toBe('passenger_changed')
  })

  it('does not dismount a newer vehicle a later task boarded', async () => {
    let calls = 0
    const port = new VehicleFakePort({ vehicles: [boatUuid('boat-1')], hijackAfter: 5 })
    const result = await runVehicleTravel('boat', optionsFor(port, {
      goal: { x: 40, y: 64, z: 0 },
      shouldStop: () => {
        return ++calls > 1
      },
    }))
    expect(result.status).toBe('cancelled')
    expect(port.dismounts).toBe(0)
    expect(result.failure).toBe('unverified_stop')
  })
})

describe('vehicle travel session: horse', () => {
  it('mounts a tamed saddled horse and dismounts on the ground', async () => {
    const port = new VehicleFakePort({ vehicles: [horseUuid('horse-1')] })
    const result = await runVehicleTravel('horse', optionsFor(port))
    expect(result.status).toBe('reached')
    expect(port.dismounts).toBe(1)
    expect(result.receipt?.vehicleUuid).toBe('horse-1')
    expect(result.receipt?.dismounted).toBe(true)
  })

  it('refuses an untamed horse without explicit taming permission', async () => {
    const port = new VehicleFakePort({ vehicles: [horseUuid('horse-wild', { tamed: false, saddled: false, controlledByPassenger: false })] })
    const result = await runVehicleTravel('horse', optionsFor(port, { strategy: 'existing' }))
    expect(result.failure).toBe('not_tamed')
  })

  it('reports saddle_missing when no saddle is carried', async () => {
    const port = new VehicleFakePort({ vehicles: [horseUuid('horse-1', { saddled: false })] })
    const result = await runVehicleTravel('horse', optionsFor(port, { strategy: 'existing' }))
    expect(result.failure).toBe('saddle_missing')
  })

  it('saddles a tamed horse from the inventory and verifies the stack', async () => {
    const port = new VehicleFakePort({
      vehicles: [horseUuid('horse-1', { saddled: false })],
      inventory: [{ slot: 5, id: 'minecraft:saddle', count: 1, hotbar: true }],
    })
    const result = await runVehicleTravel('horse', optionsFor(port))
    expect(result.status).toBe('reached')
    expect(port.interactCalls.some(call => call.action === 'saddle')).toBe(true)
    expect(result.receipt?.asset).toMatchObject({ itemId: 'minecraft:saddle', consumed: 1 })
    expect(port.inventory.find(slot => slot.id === 'minecraft:saddle')?.count).toBe(0)
  })

  it('tames a wild horse only with permission and a budget, then saddles it', async () => {
    let clock = 0
    const port = new VehicleFakePort({
      vehicles: [horseUuid('horse-wild', { tamed: false, saddled: false, controlledByPassenger: false })],
      inventory: [{ slot: 5, id: 'minecraft:saddle', count: 1, hotbar: true }],
    })
    const result = await runVehicleTravel('horse', optionsFor(port, {
      strategy: 'tame',
      allowTame: true,
      acquireBudgetMs: 5_000,
      deps: { sleep: async () => {}, now: () => (clock += 1_000) },
    }))
    expect(result.status).toBe('reached')
    expect(result.receipt?.acquireMethod).toBe('tame')
    expect(port.interactCalls.some(call => call.action === 'tame')).toBe(true)
    expect(port.interactCalls.some(call => call.action === 'saddle')).toBe(true)
  })

  it('reports acquire_timeout when taming never bonds within the budget', async () => {
    let clock = 0
    // A horse the fake never tames (interactVehicle only tames horse observations
    // when the action runs; this stub port never calls it).
    const port = new VehicleFakePort({ vehicles: [horseUuid('horse-wild', { tamed: false, saddled: false, controlledByPassenger: false })] })
    port.interactVehicle = async (input) => {
      port.interactCalls.push({ uuid: input.uuid, action: input.action })
      return { ok: true }
    }
    const result = await runVehicleTravel('horse', optionsFor(port, {
      strategy: 'tame',
      allowTame: true,
      acquireBudgetMs: 2_000,
      deps: { sleep: async () => {}, now: () => (clock += 1_000) },
    }))
    expect(result.failure).toBe('acquire_timeout')
  })

  it('ends the driving state when the rider is thrown off', async () => {
    const port = new VehicleFakePort({ vehicles: [horseUuid('horse-1', { controlledByPassenger: false })] })
    const result = await runVehicleTravel('horse', optionsFor(port))
    expect(result.failure).toBe('not_controllable')
  })

  it('waits for the mount to register before calling a board uncontrollable', async () => {
    // ROOT CAUSE:
    //
    // The board interaction lands on the next client tick. A live probe showed
    // `get_vehicle` reporting not riding for about 150 ms after `board_vehicle`
    // returned boarded=true, so one immediate confirm read failed every real
    // mount with `not_controllable`.
    //
    // <before-patch behavior/code>
    // const riding = await ctx.port.getRiding()
    //
    // We fixed this by retrying the read inside a bounded attempt window.
    const port = new VehicleFakePort({ vehicles: [horseUuid('horse-slow', { tamed: true, saddled: true })] })
    let reads = 0
    port.getRiding = async () => {
      reads++
      return reads <= 2 ? undefined : { kind: 'minecraft:horse', uuid: 'horse-slow' }
    }
    const result = await runVehicleTravel('horse', optionsFor(port))
    expect(result.status).toBe('reached')
    expect(reads).toBeGreaterThan(2)
  })
})

describe('vehicle travel session: minecart', () => {
  it('powers the track through a prepared lever before failing', async () => {
    // ROOT CAUSE:
    //
    // The fixture contract (design §6) allows a prepared start: a lever beside
    // an unpowered powered rail. The travel failed with rail_not_powered on the
    // first poll and never touched the mechanism.
    //
    // <before-patch behavior/code>
    // if (!launchChecked && powered === false)
    //   return { status: 'stuck', failure: 'rail_not_powered', ... }
    //
    // We fixed this by operating one lever within reach, then letting the next
    // poll decide from the re-read rail.
    const port = new VehicleFakePort({ vehicles: [cartUuid('cart-1', false)], rolling: true })
    const cart = port.vehicles.get('cart-1')!
    let uses = 0
    port.getBlocksRegion = async () => [{ x: 1, y: 64, z: 0, id: 'minecraft:lever' }]
    port.useBlock = async () => {
      uses++
      cart.state = { kind: 'minecart', powered: true, onRail: true }
    }
    const result = await runVehicleTravel('minecart', optionsFor(port, { goal: { x: 6, y: 64, z: 0 } }))
    expect(uses).toBe(1)
    expect(result.status).toBe('reached')
  })

  it('reports rail_not_powered immediately instead of waiting thirty seconds', async () => {
    let clock = 0
    const port = new VehicleFakePort({ vehicles: [cartUuid('cart-1', false)] })
    const result = await runVehicleTravel('minecart', optionsFor(port, {
      goal: { x: 40, y: 64, z: 0 },
      deps: { sleep: async () => {}, now: () => (clock += 10) },
    }))
    expect(result.failure).toBe('rail_not_powered')
    expect(clock).toBeLessThan(30_000)
  })

  it('rides a rolling powered cart to the goal', async () => {
    const port = new VehicleFakePort({ vehicles: [cartUuid('cart-1', true)], rolling: true })
    const result = await runVehicleTravel('minecart', optionsFor(port, { goal: { x: 6, y: 64, z: 0 } }))
    expect(result.status).toBe('reached')
    expect(port.dismounts).toBe(1)
  })

  it('treats a coasting cart on a plain rail as launched', async () => {
    // ROOT CAUSE:
    //
    // After the slope launch the cart can already sit on a plain rail while it
    // is still rolling; reading only the rail mislabeled it rail_not_powered
    // (live V-06, 2026-09-17: the cart moved 2.37 blocks and the trip failed).
    //
    // <before-patch behavior/code>
    // if (!launchChecked && powered === false) {
    //   if (!session.launchMechanismUsed) { ...dispatch... }
    //   return { status: 'stuck', failure: 'rail_not_powered', ... }
    // }
    //
    // We fixed this by accepting observed motion as the launch fact.
    const port = new VehicleFakePort({ vehicles: [cartUuid('cart-1', false)], rolling: true })
    const result = await runVehicleTravel('minecart', optionsFor(port, { goal: { x: 6, y: 64, z: 0 } }))
    expect(result.status).toBe('reached')
  })

  it('keeps the rider mounted when the dock has no ground under it', async () => {
    // ROOT CAUSE:
    //
    // A reached cart over the fixture's break dismounted the player into open
    // air; the trip then reported reached and the player fell (live V-08).
    //
    // <before-patch behavior/code>
    // if (session.kind === 'minecart' && !minecartDismountSafe({ ..., atStation: true }))
    //   return { dismounted: false, ... }
    //
    // We fixed this by requiring a readable, solid support below the cart.
    const port = new VehicleFakePort({ vehicles: [cartUuid('cart-1', true)], rolling: true, supportAir: true })
    const result = await runVehicleTravel('minecart', optionsFor(port, { goal: { x: 6, y: 64, z: 0 } }))
    expect(result.receipt?.dismounted).toBe(false)
    expect(result.receipt?.arrivedMounted).toBe(true)
    expect(port.dismounts).toBe(0)
  })
  it('names a destroyed cart vehicle_lost instead of a speed failure', async () => {
    // ROOT CAUSE:
    //
    // The minecart loop had no riding check, so a cart killed mid-ride only
    // showed as a speed drop and the trip reported launch_unavailable (live
    // V-09a, 2026-09-17).
    //
    // <before-patch behavior/code>
    // if (ctx.now() > launchDeadline && speed <= 0.02)
    //   return { status: 'stuck', failure: 'launch_unavailable', ... }
    //
    // We fixed this by reading the riding state on the same cadence as the
    // other movers and naming vehicle_lost.
    const port = new VehicleFakePort({ vehicles: [cartUuid('cart-1', true)], rolling: true, clearRidingAfter: 2 })
    const result = await runVehicleTravel('minecart', optionsFor(port, { goal: { x: 40, y: 64, z: 0 } }))
    expect(result.failure).toBe('vehicle_lost')
  })
  it('reports launch_unavailable when the cart never moves', async () => {
    let clock = 0
    const port = new VehicleFakePort({ vehicles: [cartUuid('cart-1', 'unobserved')] })
    const result = await runVehicleTravel('minecart', optionsFor(port, {
      goal: { x: 40, y: 64, z: 0 },
      deps: { sleep: async () => {}, now: () => (clock += 1_000) },
    }))
    expect(result.failure).toBe('launch_unavailable')
  })

  it('reports a typed deadline when the trip budget expires', async () => {
    let clock = 0
    const port = new VehicleFakePort({ vehicles: [boatUuid('boat-1')], speed: 0.01 })
    const result = await runVehicleTravel('boat', optionsFor(port, {
      goal: { x: 100, y: 64, z: 0 },
      travelBudgetMs: 50,
      deps: { sleep: async () => {}, now: () => (clock += 100) },
    }))
    expect(result.failure).toBe('deadline')
  })
})

describe('vehicle travel session: type selection', () => {
  it('never takes a nearby boat when the command asked for a horse', async () => {
    const port = new VehicleFakePort({ vehicles: [boatUuid('boat-1'), horseUuid('horse-1')] })
    const result = await runVehicleTravel('horse', optionsFor(port))
    expect(result.receipt?.vehicleUuid).toBe('horse-1')
  })

  it('never takes a nearby horse when the command asked for a boat', async () => {
    const port = new VehicleFakePort({ vehicles: [boatUuid('boat-1'), horseUuid('horse-1')] })
    const result = await runVehicleTravel('boat', optionsFor(port))
    expect(result.receipt?.vehicleUuid).toBe('boat-1')
  })
})

describe('runVehicleMove dispatch', () => {
  it('routes boat, horse and minecart through the shared lifecycle', async () => {
    const boat = new VehicleFakePort({ vehicles: [boatUuid('b')] })
    expect((await runVehicleMove('boat', optionsFor(boat))).receipt?.acquireMethod).toBe('existing')

    const horse = new VehicleFakePort({ vehicles: [horseUuid('h')] })
    expect((await runVehicleMove('horse', optionsFor(horse))).status).toBe('reached')

    const cart = new VehicleFakePort({ vehicles: [cartUuid('c')], rolling: true })
    expect((await runVehicleMove('minecart', optionsFor(cart))).status).toBe('reached')
  })
})
