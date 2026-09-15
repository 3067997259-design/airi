import type { RepairCandidate } from './repair'

import { describe, expect, it } from 'vitest'

import { createBlueprintRecord } from './blueprint'
import { createProgress } from './progress'
import { canAttempt, planUndo, rankRepairCandidates, RepairLedger } from './repair'

function original() {
  return createBlueprintRecord({
    file: { fileName: 'line.litematic', digest: 'raw' },
    subregions: [{
      name: 'line',
      origin: { x: 0, y: 0, z: 0 },
      blocks: [
        { x: 0, y: 0, z: 0, blockId: 'minecraft:redstone_wire' },
        { x: 1, y: 0, z: 0, blockId: 'minecraft:piston', properties: { facing: 'up' } },
      ],
    }],
  })
}

const CONSTRAINTS = {
  functional: ['keeps-harvest', 'other-columns-powered'],
  construction: ['reachable', 'materials-available'],
}

function candidate(overrides: Partial<RepairCandidate> = {}): RepairCandidate {
  return {
    id: 'candidate-a',
    position: { x: 0, y: 0, z: 0 },
    originalState: { blockId: 'minecraft:redstone_wire' },
    newState: { blockId: 'minecraft:repeater', properties: { delay: '1' } },
    satisfies: [...CONSTRAINTS.functional, ...CONSTRAINTS.construction],
    operationOrder: ['break', 'place'],
    reason: 'restore the far signal',
    expectedEffect: 'the far piston extends',
    layoutImpact: 0,
    ...overrides,
  }
}

describe('repair candidate ranking', () => {
  it('rejects a candidate that does not satisfy every required constraint', () => {
    const { eligible, rejected } = rankRepairCandidates([candidate(), candidate({ id: 'candidate-b', satisfies: ['keeps-harvest'] })], CONSTRAINTS)
    expect(eligible.map(entry => entry.id)).toEqual(['candidate-a'])
    expect(rejected[0].missing).toEqual(['other-columns-powered', 'reachable', 'materials-available'])
  })

  it('prefers the candidate with the smaller layout impact', () => {
    const { eligible } = rankRepairCandidates([candidate({ id: 'big', layoutImpact: 3 }), candidate({ id: 'small', layoutImpact: 1 })], CONSTRAINTS)
    expect(eligible.map(entry => entry.id)).toEqual(['small', 'big'])
  })
})

describe('repair ledger', () => {
  it('accepts a candidate only when the functional retest passed', () => {
    const base = original()
    const ledger = new RepairLedger(base, createProgress({ projectionId: 'proj', taskId: 'task', blueprintContentDigest: base.contentDigest }))
    ledger.register(candidate())
    expect(ledger.accept({ candidate: candidate(), retestResult: 'failed', evidence: [], at: 1 })).toBeUndefined()
    const diff = ledger.accept({ candidate: candidate(), retestResult: 'passed', evidence: ['piston p0 extended'], at: 2 })
    expect(diff?.retestResult).toBe('passed')
    expect(diff?.evidence).toEqual(['piston p0 extended'])
    expect(ledger.acceptedDiffs()).toHaveLength(1)
  })

  it('keeps the original and applies accepted diffs to the structural goal only', () => {
    const base = original()
    const ledger = new RepairLedger(base, createProgress({ projectionId: 'proj', taskId: 'task', blueprintContentDigest: base.contentDigest }))
    ledger.accept({ candidate: candidate(), retestResult: 'passed', evidence: [], at: 2 })
    const goal = ledger.structuralGoal()
    expect(goal.subregions[0].blocks.find(block => block.x === 0)?.blockId).toBe('minecraft:repeater')
    expect(base.subregions[0].blocks.find(block => block.x === 0)?.blockId).toBe('minecraft:redstone_wire')
  })
})

describe('repair undo', () => {
  it('restores the original state when the site still shows this task\'s change', () => {
    const plan = planUndo(candidate(), new Map([['0,0,0', { blockId: 'minecraft:repeater' }]]))
    expect(plan.restore).toEqual([{ position: { x: 0, y: 0, z: 0 }, state: { blockId: 'minecraft:redstone_wire' } }])
  })

  it('skips a cell another actor changed', () => {
    const plan = planUndo(candidate(), new Map([['0,0,0', { blockId: 'minecraft:gold_block' }]]))
    expect(plan.restore).toEqual([])
    expect(plan.skipped).toEqual([{ position: { x: 0, y: 0, z: 0 }, reason: 'not_attributable' }])
  })
})

describe('repair budget', () => {
  it('stops when the attempt budget is exhausted', () => {
    expect(canAttempt({ maxAttempts: 2, deadlineMs: 1000, startedAt: 0 }, 2, 10)).toEqual({ allowed: false, reason: 'attempt_budget_exhausted' })
  })

  it('stops when the time budget is exhausted', () => {
    expect(canAttempt({ maxAttempts: 2, deadlineMs: 1000, startedAt: 0 }, 0, 1001)).toEqual({ allowed: false, reason: 'time_budget_exhausted' })
  })
})
