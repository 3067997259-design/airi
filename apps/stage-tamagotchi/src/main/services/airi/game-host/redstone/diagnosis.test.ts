import type { ObservationBatch } from './observation'

import { describe, expect, it } from 'vitest'

import { compareColumnsToReference, diagnose } from './diagnosis'
import { buildObservationWindow } from './observation'

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

const SPEC = { triggerColumns: ['left-observer'], lineColumns: ['line-0', 'line-1'], pistons: ['p0'], fromTick: 0, toTick: 100 }

function signal(column: string, powered: boolean, tick = 10) {
  return { tick, column, position: { x: 0, y: 0, z: 0 }, powered, source: 'server-region-recorder' as const, completeness: 'complete' as const }
}

describe('signal diagnosis', () => {
  it('reports every stage ok when the run worked', () => {
    const window = buildObservationWindow({ worldId: 'world', dimension: 'minecraft:overworld' }, [
      batch({
        signalSamples: [signal('left-observer', true), signal('line-0', true), signal('line-1', true)],
        pistonEvents: [{ tick: 20, piston: 'p0', action: 'extend', position: { x: 1, y: 0, z: 0 }, source: 'server-events', completeness: 'complete' }],
        chestDeltas: [{ tick: 30, chest: 'chest', itemId: 'minecraft:sugar_cane', before: 0, after: 1, source: 'server-events', completeness: 'complete' }],
      }),
    ])
    const report = diagnose(window, SPEC)
    expect(report.stages.map(stage => stage.status)).toEqual(['ok', 'ok', 'ok', 'ok'])
    expect(report.candidates).toEqual([])
    expect(report.inconclusive).toBe(false)
  })

  it('compares columns and names generic causes without the fixture answer', () => {
    const window = buildObservationWindow({ worldId: 'world', dimension: 'minecraft:overworld' }, [
      batch({
        signalSamples: [signal('left-observer', true), signal('line-0', true), signal('line-1', false)],
      }),
    ])
    const report = diagnose(window, SPEC)
    expect(report.stages.find(stage => stage.stage === 'transmission')?.status).toBe('abnormal')
    expect(report.candidates.map(candidate => candidate.id)).toContain('signal_attenuation')
    expect(report.nextProbes.length).toBeGreaterThan(0)
    expect(JSON.stringify(report).toLowerCase()).not.toContain('repeater')
  })

  it('reports the first divergence from the reference column', () => {
    const window = buildObservationWindow({ worldId: 'world', dimension: 'minecraft:overworld' }, [
      batch({ signalSamples: [signal('line-0', true), signal('line-1', false)] }),
    ])
    const comparison = compareColumnsToReference(window, ['line-0', 'line-1'], 0, 100)
    expect(comparison.find(entry => entry.column === 'line-1')).toMatchObject({ reference: 'line-0', status: 'unpowered' })
  })

  it('stays inconclusive when the line was not completely read', () => {
    const window = buildObservationWindow({ worldId: 'world', dimension: 'minecraft:overworld' }, [
      batch({ completeness: 'partial', missingReason: 'batch_limit' }),
    ])
    const report = diagnose(window, SPEC)
    expect(report.inconclusive).toBe(true)
    expect(report.stages.find(stage => stage.stage === 'transmission')?.status).toBe('unknown')
  })
})
