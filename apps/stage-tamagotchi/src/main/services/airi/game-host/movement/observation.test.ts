import type { TerrainReadRequest } from './observation'

import { describe, expect, it } from 'vitest'

import {
  actionResultPhases,
  buildTerrainSnapshot,
  DimensionMismatchError,
  isWithinFreshnessBudget,
  mapSourceTickToMain,
  TerrainReadError,
} from './observation'

function request(overrides: Partial<TerrainReadRequest> = {}): TerrainReadRequest {
  return {
    bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 0, z: 0 } },
    dimension: 'minecraft:overworld',
    worldId: 'world-1',
    connectionGeneration: 3,
    startedAt: 1_000,
    receiveTime: 1_050,
    ...overrides,
  }
}

describe('observation clock mapping', () => {
  // Three clocks (client tick, server tick, main ms) must never be subtracted
  // from each other directly; a mapping carries an explicit error bound.
  it('maps a source tick with an error bound instead of subtracting clocks', () => {
    const mapped = mapSourceTickToMain(100, { from: 'client-tick', epochMs: 0, msPerTick: 50, errorBoundMs: 25 }, 5_100)
    expect(mapped.estimatedMs).toBe(5_000)
    expect(mapped.staleByMs).toBe(100)
    expect(mapped.errorBoundMs).toBe(25)
  })

  it('keeps a fact fresh when clock error explains the age', () => {
    // Budget 100 ms plus a 25 ms error bound allows a bounded age of 125 ms.
    const inside = mapSourceTickToMain(100, { from: 'client-tick', epochMs: 0, msPerTick: 50, errorBoundMs: 25 }, 5_120)
    expect(isWithinFreshnessBudget(inside, 100)).toBe(true)
    const outside = mapSourceTickToMain(100, { from: 'client-tick', epochMs: 0, msPerTick: 50, errorBoundMs: 25 }, 5_130)
    expect(isWithinFreshnessBudget(outside, 100)).toBe(false)
  })
})

describe('terrain snapshot coverage', () => {
  it('distinguishes known air, known obstacle, unloaded and uncovered', () => {
    const snapshot = buildTerrainSnapshot(request(), {
      blocks: [
        { x: 0, y: 0, z: 0, id: 'minecraft:air' },
        { x: 2, y: 0, z: 0, id: 'minecraft:stone' },
      ],
      unloaded: [{ x: 1, y: 0, z: 0 }],
      dimension: 'minecraft:overworld',
      source: 'client-loaded-world',
    })
    expect(snapshot.cellAt(0, 0, 0)?.kind).toBe('known-air')
    expect(snapshot.isKnownAir(0, 0, 0)).toBe(true)
    expect(snapshot.cellAt(1, 0, 0)?.kind).toBe('unloaded')
    expect(snapshot.isKnownObstacle(2, 0, 0)).toBe(true)
    expect(snapshot.observation.completeness).toBe('complete')
    expect(snapshot.observation.source).toBe('client-loaded-world')
    expect(snapshot.observation.connectionGeneration).toBe(3)
  })

  // D10: a missing or unloaded cell is never air, and an unreadable scan is a
  // failure rather than an empty world.
  it('never treats a missing cell as air', () => {
    const snapshot = buildTerrainSnapshot(request(), {
      blocks: [{ x: 0, y: 0, z: 0, id: 'minecraft:air' }],
      unloaded: [{ x: 1, y: 0, z: 0 }],
    })
    expect(snapshot.isKnownAir(1, 0, 0)).toBe(false)
    expect(snapshot.isKnownAir(2, 0, 0)).toBe(false)
    expect(snapshot.cellAt(2, 0, 0)).toBeUndefined()
    expect(snapshot.uncoveredCells()).toContainEqual({ x: 2, y: 0, z: 0 })
  })

  it('marks a truncated read and carries the missing reason', () => {
    const snapshot = buildTerrainSnapshot(request(), {
      blocks: [],
      truncated: true,
    })
    expect(snapshot.observation.completeness).toBe('truncated')
    expect(snapshot.observation.missingReason).toBe('truncated')
  })

  it('throws for a read with no block list instead of returning an empty world', () => {
    expect(() => buildTerrainSnapshot(request(), {})).toThrow(TerrainReadError)
  })

  it('throws for an explicit read failure', () => {
    expect(() => buildTerrainSnapshot(request(), { blocks: [], error: 'chunk_unloaded' }))
      .toThrow('chunk_unloaded')
  })

  // D12: a response for another dimension is rejected; `Levels.resolve`'s
  // overworld default is never relied on.
  it('rejects a mismatched dimension', () => {
    expect(() => buildTerrainSnapshot(request(), { blocks: [], dimension: 'minecraft:the_nether' }))
      .toThrow(DimensionMismatchError)
  })

  it('accepts a response whose dimension matches the request', () => {
    expect(() => buildTerrainSnapshot(request(), { blocks: [], dimension: 'minecraft:overworld' })).not.toThrow()
  })
})

describe('action result phases', () => {
  it('keeps every unobserved phase false', () => {
    const phases = actionResultPhases({ requested: true, accepted: true, clientExecuted: true })
    expect(phases.serverSettled).toBe(false)
    expect(phases.unobserved).toEqual(['serverSettled'])
  })

  it('reports all four phases when each was observed', () => {
    const phases = actionResultPhases({ requested: true, accepted: true, clientExecuted: true, serverSettled: true })
    expect(phases.unobserved).toEqual([])
  })
})
