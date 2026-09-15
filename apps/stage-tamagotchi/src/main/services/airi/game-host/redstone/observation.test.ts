import type { ObservationBatch } from './observation'

import { describe, expect, it } from 'vitest'

import { DimensionMismatchError } from '../movement/observation'
import { buildObservationWindow, evaluateFunctionalAcceptance, readSignalAt, separateGrowthInputs, summarizeColumns } from './observation'

function batch(overrides: Partial<ObservationBatch> = {}): ObservationBatch {
  return {
    worldId: 'world',
    dimension: 'minecraft:overworld',
    source: 'server-region-recorder',
    fromTick: 0,
    toTick: 100,
    completeness: 'complete',
    signalSamples: [],
    pistonEvents: [],
    dropSamples: [],
    chestDeltas: [],
    ...overrides,
  }
}

describe('observation window', () => {
  it('rejects a batch from another dimension', () => {
    const foreign = batch({ dimension: 'minecraft:the_nether' })
    expect(() => buildObservationWindow({ worldId: 'world', dimension: 'minecraft:overworld' }, [foreign])).toThrow(DimensionMismatchError)
  })

  it('never reports signal zero for a tick that was not read', () => {
    const window = buildObservationWindow({ worldId: 'world', dimension: 'minecraft:overworld' }, [batch()])
    const reading = readSignalAt(window, 'left-observer', 50)
    expect(reading.observed).toBe(false)
    expect(reading.powered).toBeUndefined()
    expect(reading.missingReason).toBe('column_not_sampled')
  })

  it('never reports signal zero for an incomplete batch', () => {
    const window = buildObservationWindow({ worldId: 'world', dimension: 'minecraft:overworld' }, [batch({ completeness: 'truncated', missingReason: 'batch_limit' })])
    const reading = readSignalAt(window, 'left-observer', 50)
    expect(reading.observed).toBe(false)
    expect(reading.powered).toBeUndefined()
    expect(reading.missingReason).toBe('batch_limit')
  })

  it('reads a real powered value from a complete batch', () => {
    const window = buildObservationWindow({ worldId: 'world', dimension: 'minecraft:overworld' }, [
      batch({ signalSamples: [{ tick: 10, column: 'left-observer', position: { x: 0, y: 0, z: 0 }, powered: true, source: 'server-region-recorder', completeness: 'complete' }] }),
    ])
    expect(readSignalAt(window, 'left-observer', 50)).toMatchObject({ observed: true, powered: true })
  })

  it('counts unobserved ticks separately from unpowered ticks', () => {
    const window = buildObservationWindow({ worldId: 'world', dimension: 'minecraft:overworld' }, [
      batch({ signalSamples: [{ tick: 10, column: 'line-0', position: { x: 0, y: 0, z: 0 }, powered: false, source: 'server-region-recorder', completeness: 'complete' }] }),
    ])
    const summary = summarizeColumns(window, ['line-0', 'line-1'], 0, 100)
    expect(summary[0]).toMatchObject({ everPowered: false, unobservedTicks: 10 })
    expect(summary[1]).toMatchObject({ unobservedTicks: 101 })
  })
})

describe('functional acceptance', () => {
  const expectation = {
    triggerColumns: ['left-observer'],
    pistons: ['p0'],
    itemId: 'minecraft:sugar_cane',
    minChestDelta: 1,
    fromTick: 0,
    toTick: 100,
  }

  it('accepts a run whose trigger, piston and chest are all observed', () => {
    const window = buildObservationWindow({ worldId: 'world', dimension: 'minecraft:overworld' }, [
      batch({
        signalSamples: [{ tick: 10, column: 'left-observer', position: { x: 0, y: 0, z: 0 }, powered: true, source: 'server-region-recorder', completeness: 'complete' }],
        pistonEvents: [{ tick: 20, piston: 'p0', action: 'extend', position: { x: 1, y: 0, z: 0 }, source: 'server-events', completeness: 'complete' }],
        chestDeltas: [{ tick: 30, chest: 'chest', itemId: 'minecraft:sugar_cane', before: 0, after: 1, source: 'server-events', completeness: 'complete' }],
      }),
    ])
    const acceptance = evaluateFunctionalAcceptance(window, expectation)
    expect(acceptance.met).toBe(true)
    expect(acceptance.chestDelta).toBe(1)
  })

  it('reports signal_zero only when a complete read saw no power', () => {
    const window = buildObservationWindow({ worldId: 'world', dimension: 'minecraft:overworld' }, [
      batch({
        signalSamples: [{ tick: 10, column: 'left-observer', position: { x: 0, y: 0, z: 0 }, powered: false, source: 'server-region-recorder', completeness: 'complete' }],
        pistonEvents: [{ tick: 20, piston: 'p0', action: 'extend', position: { x: 1, y: 0, z: 0 }, source: 'server-events', completeness: 'complete' }],
        chestDeltas: [{ tick: 30, chest: 'chest', itemId: 'minecraft:sugar_cane', before: 0, after: 1, source: 'server-events', completeness: 'complete' }],
      }),
    ])
    const acceptance = evaluateFunctionalAcceptance(window, expectation)
    expect(acceptance.met).toBe(false)
    expect(acceptance.checks.find(check => check.check === 'trigger:left-observer')?.reason).toBe('signal_zero')
  })

  it('keeps an unread item unfinished instead of passing it', () => {
    const window = buildObservationWindow({ worldId: 'world', dimension: 'minecraft:overworld' }, [])
    const acceptance = evaluateFunctionalAcceptance(window, expectation)
    expect(acceptance.met).toBe(false)
    expect(acceptance.unfinished).toContain('trigger:left-observer')
    expect(acceptance.unfinished).toContain('chest:gain')
  })

  it('fails a root that was removed', () => {
    const window = buildObservationWindow({ worldId: 'world', dimension: 'minecraft:overworld' }, [
      batch({
        signalSamples: [{ tick: 10, column: 'left-observer', position: { x: 0, y: 0, z: 0 }, powered: true, source: 'server-region-recorder', completeness: 'complete' }],
        pistonEvents: [{ tick: 20, piston: 'p0', action: 'extend', position: { x: 1, y: 0, z: 0 }, source: 'server-events', completeness: 'complete' }],
        chestDeltas: [{ tick: 30, chest: 'chest', itemId: 'minecraft:sugar_cane', before: 0, after: 1, source: 'server-events', completeness: 'complete' }],
      }),
    ])
    const acceptance = evaluateFunctionalAcceptance(window, { ...expectation, roots: [{ x: 0, y: 0, z: 0 }] }, [
      { position: { x: 0, y: 0, z: 0 }, blockId: 'minecraft:air', expectedBlockId: 'minecraft:sugar_cane' },
    ])
    expect(acceptance.met).toBe(false)
    expect(acceptance.checks.find(check => check.check.startsWith('root:'))?.reason).toBe('root_removed')
  })

  it('separates hand-planted test input from natural growth', () => {
    const samples = separateGrowthInputs([
      { tick: 1, position: { x: 0, y: 0, z: 0 }, height: 3, input: 'manual-planting', source: 'server-region-recorder', completeness: 'complete' },
      { tick: 2, position: { x: 1, y: 0, z: 0 }, height: 2, input: 'natural-growth', source: 'server-region-recorder', completeness: 'complete' },
    ])
    expect(samples.artificial).toHaveLength(1)
    expect(samples.natural).toHaveLength(1)
  })
})
