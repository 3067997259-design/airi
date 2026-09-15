/**
 * Small experiment flow (RS-E, optional, §7).
 *
 * A small experiment records a question, a hypothesis, steps, observations, a
 * conclusion, applicability and open items. It runs inside plot, material, time
 * and attempt budgets. Controls live in recoverable structures, accepted
 * facilities are preserved, and at budget end the temporary operations are
 * cleaned up. Complex machines are out of scope.
 *
 * A conclusion is only written as supported or refuted when complete
 * observations exist. With no evidence the outcome stays inconclusive instead
 * of turning a guess into a rule.
 */
import type { Bounds, Vec3 } from './geometry'

import { vecKey } from './geometry'

/** Testable outcome of a small experiment. */
export type ExperimentOutcome = 'supported' | 'refuted' | 'inconclusive'

export interface ExperimentBudget {
  plotBounds: Bounds
  /** Maximum amount of each item the experiment may consume. */
  materialBudget: Record<string, number>
  timeBudgetMs: number
  maxAttempts: number
}

export interface ExperimentStep {
  description: string
  /** Single bounded action this step performs. */
  action: string
  /** Optional position; checked against the plot budget. */
  position?: Vec3
}

export interface ExperimentObservation {
  step: number
  observation: string
  source: string
  /** A partial read does not support a conclusion. */
  complete: boolean
}

export interface ExperimentUsage {
  materials: Record<string, number>
  elapsedMs: number
  attempts: number
  now: number
}

export interface ExperimentRecord {
  question: string
  hypothesis: string
  steps: ExperimentStep[]
  observations: ExperimentObservation[]
  conclusion: string
  applicability: string[]
  openItems: string[]
  outcome: ExperimentOutcome
  budget: ExperimentBudget
  startedAt: number
  endedAt?: number
}

/** Budget check result. `exceeded` names every limit that is over. */
export function budgetStatus(budget: ExperimentBudget, usage: ExperimentUsage): { withinBudget: boolean, exceeded: string[] } {
  const exceeded: string[] = []
  for (const [itemId, used] of Object.entries(usage.materials)) {
    const limit = budget.materialBudget[itemId] ?? 0
    if (used > limit)
      exceeded.push(`material:${itemId}`)
  }
  if (usage.elapsedMs > budget.timeBudgetMs)
    exceeded.push('time')
  if (usage.attempts > budget.maxAttempts)
    exceeded.push('attempts')
  return { withinBudget: exceeded.length === 0, exceeded }
}

/** True when every step position stays inside the plot. */
export function stepsWithinPlot(budget: ExperimentBudget, steps: readonly ExperimentStep[]): boolean {
  return steps.every((step) => {
    if (!step.position)
      return true
    return step.position.x >= budget.plotBounds.min.x && step.position.x <= budget.plotBounds.max.x
      && step.position.y >= budget.plotBounds.min.y && step.position.y <= budget.plotBounds.max.y
      && step.position.z >= budget.plotBounds.min.z && step.position.z <= budget.plotBounds.max.z
  })
}

/** Whether the experiment may keep running. */
export function canContinueExperiment(budget: ExperimentBudget, usage: ExperimentUsage): { allowed: boolean, reason?: string } {
  if (usage.attempts >= budget.maxAttempts)
    return { allowed: false, reason: 'attempts_budget_exhausted' }
  if (usage.elapsedMs >= budget.timeBudgetMs)
    return { allowed: false, reason: 'time_budget_exhausted' }
  const status = budgetStatus(budget, usage)
  if (!status.withinBudget)
    return { allowed: false, reason: `budget_exceeded:${status.exceeded.join(',')}` }
  return { allowed: true }
}

/**
 * Cleanup plan at budget end.
 *
 * Only temporary positions the experiment created are cleaned; positions of
 * accepted facilities are preserved even when they overlap.
 */
export function planCleanup(temporaryCreated: readonly Vec3[], acceptedFacilities: readonly Vec3[]): Vec3[] {
  const accepted = new Set(acceptedFacilities.map(vecKey))
  return temporaryCreated.filter(vec => !accepted.has(vecKey(vec)))
}

/**
 * Concludes an experiment from complete observations only.
 *
 * A claim without at least one complete observation is `inconclusive`; the
 * proposed conclusion is kept as an open item instead of a known rule.
 */
export function concludeExperiment(record: ExperimentRecord, input: {
  supported: boolean | undefined
  conclusion: string
  applicability?: string[]
  endedAt: number
}): ExperimentRecord {
  const complete = record.observations.filter(observation => observation.complete)
  if (input.supported === undefined || complete.length === 0) {
    const openItems = [...record.openItems]
    if (input.conclusion && !openItems.includes(input.conclusion))
      openItems.push(input.conclusion)
    return { ...record, outcome: 'inconclusive', conclusion: '', openItems, endedAt: input.endedAt, applicability: [] }
  }
  return {
    ...record,
    outcome: input.supported ? 'supported' : 'refuted',
    conclusion: input.conclusion,
    applicability: input.applicability ?? [],
    endedAt: input.endedAt,
  }
}
