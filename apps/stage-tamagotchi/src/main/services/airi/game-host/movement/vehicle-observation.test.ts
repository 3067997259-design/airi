import type { VehicleObservation, VehicleObservationRequest } from './vehicle-types'

import { describe, expect, it } from 'vitest'

import {
  buildVehicleObservation,
  isHorseFamily,
  selectVehicleCandidate,
  VehicleIdentityMismatchError,
  vehicleKindOf,
  VehicleReadError,
  verifyVehiclePreconditions,
} from './vehicle-observation'

const REQUEST: VehicleObservationRequest = {
  uuid: 'v-1',
  dimension: 'minecraft:overworld',
  worldId: 'world',
  connectionGeneration: 1,
  playerUuid: 'p-1',
  startedAt: 1000,
}

function observation(overrides: Partial<VehicleObservation> = {}): VehicleObservation {
  return {
    uuid: 'v-1',
    type: 'minecraft:oak_boat',
    kind: 'boat',
    worldId: 'world',
    dimension: 'minecraft:overworld',
    position: { x: 0, y: 64, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    passengers: [],
    free: true,
    owned: 'unobserved',
    state: { kind: 'boat', inWater: true },
    source: 'client-loaded-entity',
    receivedAt: 1010,
    requestStartedAt: 1000,
    requestEndedAt: 1010,
    requestDurationMs: 10,
    connectionGeneration: 1,
    completeness: 'complete',
    ...overrides,
  }
}

describe('vehicleKindOf', () => {
  it('distinguishes camel from the horse family', () => {
    expect(vehicleKindOf('minecraft:horse')).toBe('horse')
    expect(vehicleKindOf('minecraft:donkey')).toBe('donkey')
    expect(vehicleKindOf('minecraft:mule')).toBe('mule')
    expect(vehicleKindOf('minecraft:camel')).toBe('camel')
    expect(isHorseFamily('camel')).toBe(false)
    expect(isHorseFamily('donkey')).toBe(true)
  })

  it('recognizes boat, raft and minecart variants', () => {
    expect(vehicleKindOf('minecraft:oak_boat')).toBe('boat')
    expect(vehicleKindOf('minecraft:cherry_raft')).toBe('boat')
    expect(vehicleKindOf('minecraft:chest_minecart')).toBe('minecart')
  })
})

describe('buildVehicleObservation', () => {
  it('parses type-specific state and keeps unobserved facts tri-state', () => {
    const built = buildVehicleObservation(REQUEST, {
      uuid: 'v-1',
      entity: {
        type: 'minecraft:horse',
        x: 1,
        y: 64,
        z: 2,
        yaw: 90,
        passengers: [],
        tamed: true,
        saddled: false,
        controlledByPassenger: false,
        health: 15,
        width: 1.4,
        height: 1.6,
      },
    })
    expect(built?.kind).toBe('horse')
    expect(built?.state).toMatchObject({ kind: 'horse', tamed: true, saddled: false, controlledByPassenger: false })
    expect(built?.free).toBe(true)
    expect(built?.owned).toBe('unobserved')
  })

  it('reads ownership only when the owner matches the requesting player', () => {
    const owner = buildVehicleObservation(REQUEST, { uuid: 'v-1', entity: { type: 'minecraft:horse', owner: 'p-1' } })
    expect(owner?.owned).toBe(true)
    const other = buildVehicleObservation(REQUEST, { uuid: 'v-1', entity: { type: 'minecraft:horse', owner: 'p-2' } })
    expect(other?.owned).toBe(false)
  })

  it('returns undefined for an absent entity instead of inventing a vehicle', () => {
    expect(buildVehicleObservation(REQUEST, { uuid: 'v-1' })).toBeUndefined()
  })

  it('rejects a foreign uuid and a failed read', () => {
    expect(() => buildVehicleObservation(REQUEST, { uuid: 'v-2', entity: { type: 'minecraft:oak_boat' } })).toThrow(VehicleIdentityMismatchError)
    expect(() => buildVehicleObservation(REQUEST, { error: 'no bridge' })).toThrow(VehicleReadError)
  })

  it('rejects a response for another dimension', () => {
    expect(() => buildVehicleObservation(REQUEST, { uuid: 'v-1', dimension: 'minecraft:nether', entity: { type: 'minecraft:oak_boat' } })).toThrow()
  })
})

describe('selectVehicleCandidate', () => {
  it('never claims an occupied or untamed candidate silently', () => {
    const occupied = observation({ uuid: 'boat-occupied', free: false })
    const selection = selectVehicleCandidate([occupied], { kind: 'boat', requireFree: true })
    expect(selection.observation).toBeUndefined()
    expect(selection.reason).toBe('occupied')

    const untamed = observation({ uuid: 'horse-1', type: 'minecraft:horse', kind: 'horse', state: { kind: 'horse', tamed: false, saddled: false, controlledByPassenger: false } })
    expect(selectVehicleCandidate([untamed], { kind: ['horse'], requireFree: true, requireTamed: true }).reason).toBe('not_tamed')
  })

  it('reports a missing saddle and an unpowered cart with their own reasons', () => {
    const unsaddled = observation({ uuid: 'h', type: 'minecraft:horse', kind: 'horse', state: { kind: 'horse', tamed: true, saddled: false, controlledByPassenger: false } })
    expect(selectVehicleCandidate([unsaddled], { kind: ['horse'], requireSaddled: true }).reason).toBe('saddle_missing')

    const unpowered = observation({ uuid: 'cart', type: 'minecraft:minecart', kind: 'minecart', state: { kind: 'minecart', powered: false, onRail: true, speed: 0 } })
    expect(selectVehicleCandidate([unpowered], { kind: 'minecart', requirePowered: true }).reason).toBe('rail_not_powered')
  })

  it('selects the nearest passing free object without an explicit uuid', () => {
    const near = observation({ uuid: 'near', position: { x: 1, y: 64, z: 0 } })
    const far = observation({ uuid: 'far', position: { x: 5, y: 64, z: 0 } })
    const selection = selectVehicleCandidate([far, near], { kind: 'boat', requireFree: true, origin: { x: 0, y: 64, z: 0 } })
    expect(selection.observation?.uuid).toBe('near')
    // Two free boats is ambiguous: the caller can see the doubt in the receipt.
    expect(selection.ambiguous).toBe(true)
  })

  it('is not ambiguous when only one candidate passes', () => {
    const free = observation({ uuid: 'free', position: { x: 1, y: 64, z: 0 } })
    const occupied = observation({ uuid: 'occupied', free: false, position: { x: 0, y: 64, z: 0 } })
    const selection = selectVehicleCandidate([free, occupied], { kind: 'boat', requireFree: true, origin: { x: 0, y: 64, z: 0 } })
    expect(selection.observation?.uuid).toBe('free')
    expect(selection.ambiguous).toBe(false)
  })

  it('honors an explicit uuid and fails when it is absent', () => {
    const first = observation({ uuid: 'a' })
    const second = observation({ uuid: 'b' })
    const chosen = selectVehicleCandidate([first, second], { kind: 'boat', explicitUuid: 'b' })
    expect(chosen.observation?.uuid).toBe('b')
    expect(selectVehicleCandidate([first], { kind: 'boat', explicitUuid: 'missing' }).reason).toBe('vehicle_not_found')
  })

  it('marks several passing candidates ambiguous', () => {
    const a = observation({ uuid: 'a', position: { x: 0, y: 64, z: 0 } })
    const b = observation({ uuid: 'b', position: { x: 0, y: 64, z: 0 } })
    expect(selectVehicleCandidate([a, b], { kind: 'boat', requireFree: true }).ambiguous).toBe(true)
  })
})

describe('verifyVehiclePreconditions', () => {
  it('treats an unobservable free fact as a capability limit, not free', () => {
    const unknown = observation({ free: 'unobserved' })
    expect(verifyVehiclePreconditions(unknown, { kind: 'boat', requireFree: true })).toBe('capability_unavailable')
    expect(verifyVehiclePreconditions(unknown, { kind: 'boat' })).toBeUndefined()
  })

  it('rejects a camel for the horse flow', () => {
    const camel = observation({ type: 'minecraft:camel', kind: 'camel', state: { kind: 'camel', tamed: true, saddled: true } })
    expect(verifyVehiclePreconditions(camel, { kind: ['horse', 'donkey', 'mule'], requireTamed: true })).toBe('vehicle_not_found')
  })
})
