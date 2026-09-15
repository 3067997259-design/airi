import type { ExperimentRecord } from './experiment'

import { describe, expect, it } from 'vitest'

import { budgetStatus, canContinueExperiment, concludeExperiment, planCleanup, stepsWithinPlot } from './experiment'

const BUDGET = {
  plotBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } },
  materialBudget: { 'minecraft:sugar_cane': 4 },
  timeBudgetMs: 1_000,
  maxAttempts: 3,
}

function record(overrides: Partial<ExperimentRecord> = {}): ExperimentRecord {
  return {
    question: 'does a longer delay change the harvest order?',
    hypothesis: 'a longer delay skips the first column',
    steps: [{ description: 'observe one run', action: 'observe', position: { x: 1, y: 1, z: 1 } }],
    observations: [],
    conclusion: '',
    applicability: [],
    openItems: [],
    outcome: 'inconclusive',
    budget: BUDGET,
    startedAt: 0,
    ...overrides,
  }
}

describe('experiment budgets', () => {
  it('names the material limit that is over budget', () => {
    const status = budgetStatus(BUDGET, { materials: { 'minecraft:sugar_cane': 5 }, elapsedMs: 10, attempts: 0, now: 10 })
    expect(status).toEqual({ withinBudget: false, exceeded: ['material:minecraft:sugar_cane'] })
  })

  it('stops when the attempt budget is reached', () => {
    expect(canContinueExperiment(BUDGET, { materials: {}, elapsedMs: 0, attempts: 3, now: 0 })).toEqual({ allowed: false, reason: 'attempts_budget_exhausted' })
  })

  it('rejects a step outside the plot', () => {
    expect(stepsWithinPlot(BUDGET, [{ description: 'far', action: 'observe', position: { x: 99, y: 0, z: 0 } }])).toBe(false)
  })
})

describe('experiment cleanup and conclusion', () => {
  it('cleans temporary blocks but preserves accepted facilities', () => {
    expect(planCleanup([{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }], [{ x: 1, y: 0, z: 0 }])).toEqual([{ x: 0, y: 0, z: 0 }])
  })

  it('keeps a claim as an open item when no complete observation exists', () => {
    const concluded = concludeExperiment(record({ observations: [{ step: 0, observation: 'partial read', source: 'server-region-recorder', complete: false }] }), {
      supported: true,
      conclusion: 'delay changes the order',
      endedAt: 50,
    })
    expect(concluded.outcome).toBe('inconclusive')
    expect(concluded.conclusion).toBe('')
    expect(concluded.openItems).toContain('delay changes the order')
  })

  it('records a supported conclusion from complete observations', () => {
    const concluded = concludeExperiment(record({ observations: [{ step: 0, observation: 'column 1 was skipped', source: 'server-region-recorder', complete: true }] }), {
      supported: true,
      conclusion: 'delay changes the order',
      applicability: ['tested under delay=4'],
      endedAt: 50,
    })
    expect(concluded.outcome).toBe('supported')
    expect(concluded.conclusion).toBe('delay changes the order')
    expect(concluded.applicability).toEqual(['tested under delay=4'])
  })
})
