import type { TargetReadRequest, TargetReadResponse } from './target-observation'

import { describe, expect, it } from 'vitest'

import { DimensionMismatchError } from './observation'
import {
  buildTargetObservation,
  entityListOf,
  estimatePositionUncertainty,
  selectTargetFromList,
  TARGET_QUERY_MAX_RESULTS,
  TARGET_QUERY_RADIUS,
  TargetIdentityMismatchError,
  TargetReadError,
  triStateOf,
} from './target-observation'

function request(overrides: Partial<TargetReadRequest> = {}): TargetReadRequest {
  return {
    targetUuid: 'u-1',
    dimension: 'minecraft:overworld',
    worldId: 'world-1',
    connectionGeneration: 4,
    source: 'server-entity',
    startedAt: 1_000,
    receiveTime: 1_050,
    ...overrides,
  }
}

function response(overrides: Partial<TargetReadResponse> = {}): TargetReadResponse {
  return {
    uuid: 'u-1',
    dimension: 'minecraft:overworld',
    entity: {
      uuid: 'u-1',
      type: 'minecraft:player',
      isPlayer: true,
      x: 5,
      y: 64,
      z: -2,
      onGround: true,
      fallFlying: false,
      riding: false,
      alive: true,
      yaw: 90,
      pitch: 10,
      velocity: { x: 0.2, y: 0, z: -0.1 },
    },
    ...overrides,
  }
}

describe('target observation facts', () => {
  it('keeps a missing velocity absent instead of zero', () => {
    const observation = buildTargetObservation(request(), response({
      entity: { uuid: 'u-1', type: 'minecraft:cow', x: 1, y: 2, z: 3 },
    }))
    expect(observation.velocity).toBeUndefined()
    expect(observation.position).toEqual({ x: 1, y: 2, z: 3 })
  })

  it('uses a tri-state for ground, gliding, riding and alive facts', () => {
    const observation = buildTargetObservation(request(), response({
      entity: { uuid: 'u-1', type: 'minecraft:cow', x: 0, y: 64, z: 0, onGround: false },
    }))
    expect(observation.onGround).toBe(false)
    expect(observation.fallFlying).toBe('unobserved')
    expect(observation.riding).toBe('unobserved')
    expect(observation.alive).toBe('unobserved')
    expect(triStateOf(undefined)).toBe('unobserved')
  })

  it('records the source, the source tick, the request window and the generation', () => {
    const observation = buildTargetObservation(
      request({ source: 'client-loaded-entity', sourceTick: 100 }),
      response({ source: 'client-loaded-entity', sourceTick: 104, dimension: 'minecraft:overworld' }),
    )
    expect(observation.source).toBe('client-loaded-entity')
    expect(observation.sourceTick).toBe(104)
    expect(observation.receivedAt).toBe(1_050)
    expect(observation.requestStartedAt).toBe(1_000)
    expect(observation.requestDurationMs).toBe(50)
    expect(observation.connectionGeneration).toBe(4)
    expect(observation.dimension).toBe('minecraft:overworld')
  })

  it('grows the position uncertainty with age, latency and speed', () => {
    const slow = estimatePositionUncertainty({ sampleAgeMs: 100, latencyMs: 0, speedBlocksPerSecond: 0 })
    const fast = estimatePositionUncertainty({ sampleAgeMs: 100, latencyMs: 0, speedBlocksPerSecond: 10 })
    expect(fast).toBeGreaterThan(slow)
    const stale = estimatePositionUncertainty({ sampleAgeMs: 500, latencyMs: 0, speedBlocksPerSecond: 10 })
    expect(stale).toBeGreaterThan(fast)
    const laggy = estimatePositionUncertainty({ sampleAgeMs: 500, latencyMs: 200, speedBlocksPerSecond: 10 })
    expect(laggy).toBeGreaterThan(stale)
  })
})

describe('target identity and dimension', () => {
  // D12: the overworld and the nether can share X/Z. A read that names another
  // dimension must be rejected, not applied to the requested coordinates.
  it('rejects a response from another dimension at the same coordinates', () => {
    expect(() => buildTargetObservation(
      request({ dimension: 'minecraft:overworld' }),
      response({ dimension: 'minecraft:the_nether' }),
    )).toThrow(DimensionMismatchError)
  })

  it('rejects a response whose uuid is not the requested target', () => {
    expect(() => buildTargetObservation(
      request({ targetUuid: 'u-1' }),
      response({ uuid: 'u-2' }),
    )).toThrow(TargetIdentityMismatchError)
  })

  it('throws on a failed read instead of producing an empty observation', () => {
    expect(() => buildTargetObservation(request(), { error: 'no_server' })).toThrow(TargetReadError)
  })

  it('reports an absent target with an explicit visibility and no position', () => {
    const observation = buildTargetObservation(request(), { absence: 'out-of-range', dimension: 'minecraft:overworld' })
    expect(observation.position).toBeUndefined()
    expect(observation.visibility).toBe('out-of-range')
    expect(observation.completeness).toBe('partial')
    expect(observation.missingReason).toBe('out-of-range')
  })
})

describe('client pose fields (CD-L3)', () => {
  it('reads fallFlying, riding, bounds and velocity from one loaded-entity record', () => {
    const observation = buildTargetObservation(request({ source: 'client-loaded-entity' }), response({
      source: 'client-loaded-entity',
      entity: {
        uuid: 'u-1',
        type: 'minecraft:player',
        isPlayer: true,
        x: 10,
        y: 70,
        z: -3,
        yaw: 45,
        pitch: -10,
        onGround: false,
        fallFlying: true,
        riding: false,
        alive: true,
        velocity: { x: 0.4, y: -0.1, z: 0.2 },
        bounds: { width: 0.6, height: 1.8 },
        sourceTick: 4242,
      },
    }))
    expect(observation.fallFlying).toBe(true)
    expect(observation.riding).toBe(false)
    expect(observation.alive).toBe(true)
    expect(observation.onGround).toBe(false)
    expect(observation.bounds).toEqual({ width: 0.6, height: 1.8 })
    expect(observation.velocity).toEqual({ x: 0.4, y: -0.1, z: 0.2 })
    expect(observation.yaw).toBe(45)
    expect(observation.pitch).toBe(-10)
    expect(observation.source).toBe('client-loaded-entity')
    expect(observation.sourceTick).toBe(4242)
  })

  it('reads a riding record when the source reports a vehicle', () => {
    const observation = buildTargetObservation(request(), response({
      entity: { uuid: 'u-1', type: 'minecraft:player', x: 0, y: 64, z: 0, vehicle: { uuid: 'v-1', type: 'minecraft:boat' } },
    }))
    expect(observation.riding).toBe(true)
  })
})

describe('target list selection', () => {
  it('exposes the 64-block query radius and the 100-entry cap', () => {
    expect(TARGET_QUERY_RADIUS).toBe(64)
    expect(TARGET_QUERY_MAX_RESULTS).toBe(100)
  })

  // Acceptance: a target just outside the 64-block read is out of range, not
  // lost. The read reports the absence so the tracker can fall back to coarse.
  it('reports an out-of-range read as an absence, not a lost target', () => {
    const observation = buildTargetObservation(request(), {
      absence: 'out-of-range',
      dimension: 'minecraft:overworld',
    })
    expect(observation.visibility).toBe('out-of-range')
    expect(observation.targetUuid).toBe('u-1')
  })

  // Acceptance: a list longer than the cap is truncated. A missing match in a
  // truncated list is reported, so the caller does not end with target_lost.
  it('reports truncation when the list exceeds its cap', () => {
    const list = Array.from({ length: 100 }, (_, index) => ({ uuid: `u-${index}`, name: `Entity${index}` }))
    const selection = selectTargetFromList(list, 'Ghost', { total: 130, maxResults: 100 })
    expect(selection.match).toBeUndefined()
    expect(selection.truncated).toBe(true)
    expect(selection.returned).toBe(100)
  })

  it('does not call a short list truncated', () => {
    const selection = selectTargetFromList([{ uuid: 'u-1', name: 'Alice' }], 'Ghost', { total: 1, maxResults: 100 })
    expect(selection.truncated).toBe(false)
  })

  it('does not call a full-but-complete list truncated', () => {
    const list = Array.from({ length: 100 }, (_, index) => ({ uuid: `u-${index}`, name: `Entity${index}` }))
    const selection = selectTargetFromList(list, 'Entity50', { total: 100, maxResults: 100 })
    expect(selection.match?.uuid).toBe('u-50')
    expect(selection.truncated).toBe(false)
  })

  // Acceptance: duplicate names. An exact uuid wins, and a name that matches
  // several distinct uuids is flagged as ambiguous.
  it('prefers the exact uuid over a duplicate name', () => {
    const list = [
      { uuid: 'u-a', name: 'Alice' },
      { uuid: 'u-b', name: 'Alice' },
    ]
    expect(selectTargetFromList(list, 'u-b').match?.uuid).toBe('u-b')
    const byName = selectTargetFromList(list, 'Alice')
    expect(byName.match?.uuid).toBe('u-a')
    expect(byName.ambiguous).toBe(true)
  })

  it('reads the entity list and its totals from a raw record', () => {
    const parsed = entityListOf({ entities: [{ uuid: 'u-1' }, null, 'nope'], total: 3, returned: 1 })
    expect(parsed.list).toHaveLength(1)
    expect(parsed.total).toBe(3)
    expect(parsed.returned).toBe(1)
  })
})
