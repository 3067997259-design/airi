/**
 * MC-2c exploration state machine (pure helpers).
 *
 * The loop is deterministic on purpose: it chooses known sources in a fixed
 * order, counts every step against a budget, and only an in-game inventory
 * check may reach `verified`. It never designs experiments and never treats
 * fetched text as instructions.
 */
import type { MemoryTier } from './knowledge'
import type { Mc2RecipeCandidate } from './recipe'

export interface ExplorationTarget {
  /** Item or recipe id, e.g. `farmersdelight:flint_knife`. */
  itemId: string
  modId: string
}

export type ExplorationStepKind = 'reuse-check' | 'jar' | 'web' | 'craft' | 'record'

export interface ExplorationPlanStep {
  kind: ExplorationStepKind
  /** Why this step is in the plan; skipped steps keep their reason visible. */
  reason: string
}

export interface ExplorationBudget {
  maxSteps: number
  maxDurationMs: number
  maxCraftAttempts: number
}

export const DEFAULT_EXPLORATION_BUDGET: ExplorationBudget = {
  maxSteps: 8,
  maxDurationMs: 120_000,
  maxCraftAttempts: 5,
}

export type ExplorationPhase = 'planned' | 'running' | 'done' | 'stopped' | 'failed'
export type ExplorationStopReason = 'user' | 'budget-steps' | 'budget-time' | 'craft-attempts' | 'error'
export type ExplorationStepStatus = 'done' | 'skipped' | 'failed'

export interface ExplorationStepRecord {
  kind: ExplorationStepKind
  status: ExplorationStepStatus
  note?: string
  at: number
}

export interface ExplorationState {
  target: ExplorationTarget
  phase: ExplorationPhase
  plan: ExplorationPlanStep[]
  steps: ExplorationStepRecord[]
  budget: ExplorationBudget
  startedAt: number
  stopReason?: ExplorationStopReason
  tier?: MemoryTier
}

export interface PlanExplorationOptions {
  /** Adds the optional web step (MC-2b lead/cross-check path). */
  allowWeb?: boolean
  /** Adds the experiment step; false when the recipe is out of reach. */
  craftable?: boolean
  /** Adds the `jar` step only when a jar can be read for this mod. */
  jarReadable?: boolean
}

/**
 * Builds the fixed source order: reuse first, then local data, then optional
 * web, then the in-game experiment, then the record step.
 *
 * @example
 * planExploration({ itemId: 'farmersdelight:flint_knife', modId: 'farmersdelight' }, { craftable: true })
 * // => [{ kind: 'reuse-check', … }, { kind: 'jar', … }, { kind: 'craft', … }, { kind: 'record', … }]
 */
export function planExploration(target: ExplorationTarget, options: PlanExplorationOptions = {}): ExplorationPlanStep[] {
  const plan: ExplorationPlanStep[] = [
    { kind: 'reuse-check', reason: 'fresh verified/candidate knowledge skips all other steps' },
  ]
  if (options.jarReadable !== false)
    plan.push({ kind: 'jar', reason: `read local data for ${target.modId}` })
  if (options.allowWeb)
    plan.push({ kind: 'web', reason: 'optional web cross-check (lead stays unverified)' })
  if (options.craftable)
    plan.push({ kind: 'craft', reason: 'in-game inventory check is the only path to verified' })
  plan.push({ kind: 'record', reason: 'store the best tier reached and the trace' })
  return plan
}

export function startExploration(target: ExplorationTarget, budget: ExplorationBudget = DEFAULT_EXPLORATION_BUDGET, options: PlanExplorationOptions = {}, now = Date.now()): ExplorationState {
  return {
    target,
    phase: 'planned',
    plan: planExploration(target, options),
    steps: [],
    budget,
    startedAt: now,
  }
}

export type BudgetVerdict = { allowed: true } | { allowed: false, reason: 'budget-steps' | 'budget-time' }

/** Budget check between steps; skipped no-ops do not consume the step budget. */
export function stepAllowed(state: ExplorationState, now = Date.now()): BudgetVerdict {
  const executed = state.steps.filter(step => step.status !== 'skipped').length
  if (executed >= state.budget.maxSteps)
    return { allowed: false, reason: 'budget-steps' }
  if (now - state.startedAt >= state.budget.maxDurationMs)
    return { allowed: false, reason: 'budget-time' }
  return { allowed: true }
}

export function recordStep(state: ExplorationState, kind: ExplorationStepKind, status: ExplorationStepStatus, at = Date.now(), note?: string): ExplorationState {
  const record: ExplorationStepRecord = {
    kind,
    status,
    at,
    ...(note ? { note } : {}),
  }
  return { ...state, phase: state.phase === 'planned' ? 'running' : state.phase, steps: [...state.steps, record] }
}

export function stopExploration(state: ExplorationState, reason: ExplorationStopReason): ExplorationState {
  return {
    ...state,
    phase: reason === 'error' ? 'failed' : 'stopped',
    stopReason: reason,
  }
}

export function finishExploration(state: ExplorationState, tier: MemoryTier): ExplorationState {
  return { ...state, phase: 'done', tier }
}

/** Fresh `verified`/`candidate` knowledge is reused; `lead` and stale records are not. */
export function shouldReuse(candidates: ReadonlyArray<{ tier?: string, fresh?: boolean }>): boolean {
  return candidates.some(candidate => candidate.fresh === true && (candidate.tier === 'verified' || candidate.tier === 'candidate'))
}

/**
 * True when a retrieved fact is about the target.
 *
 * Retrieval is semantic, so a nearby recipe (another knife) can outrank the
 * target; reusing that fact would answer the wrong question. The fact must
 * either own the target's origin id or name the target in its lead segment —
 * cards mention other items in their material lists, so matching the whole
 * content would reuse a fact that merely contains the target id.
 */
export function knowledgeMatchesTarget(entry: { originId?: string | null, content?: string }, target: ExplorationTarget): boolean {
  if (entry.originId === `mc2:${target.itemId}`)
    return true
  // The subject of a card sits before the first full-width colon: a recipe id,
  // a web lead URL and title, or a guide title. Materials and excerpts come
  // after it, so a fact that merely mentions the target there stays excluded.
  const subject = ((entry.content ?? '').split('：')[0] ?? '').toLowerCase()
  const name = (target.itemId.split(':')[1] ?? target.itemId).replace(/_/g, ' ').toLowerCase()
  return subject.includes(target.itemId.toLowerCase()) || subject.includes(name)
}

export interface ItemCount {
  id: string
  count: number
}

export interface CraftExpectation {
  result: ItemCount
  /** Concrete items the recipe consumes; tag materials are listed by actual item. */
  materials: ItemCount[]
}

export type CraftVerdict = 'verified' | 'failed' | 'inconclusive'

/**
 * Checks an inventory delta against the recipe expectation.
 *
 * Missing readings are `inconclusive` (never `verified`); a delta that
 * contradicts the expectation is `failed`. Tag materials make the delta
 * unknown, so callers pass only the concrete materials they can compare.
 */
export function classifyCraftObservation(before: ItemCount[], after: ItemCount[], expectation: CraftExpectation): CraftVerdict {
  if (before.length === 0 || after.length === 0)
    return 'inconclusive'
  const delta = (id: string): number => countOf(after, id) - countOf(before, id)
  if (delta(expectation.result.id) !== expectation.result.count)
    return 'failed'
  for (const material of expectation.materials) {
    if (delta(material.id) !== -material.count)
      return 'failed'
  }
  return 'verified'
}

function countOf(items: ItemCount[], id: string): number {
  return items.filter(item => item.id === id).reduce((sum, item) => sum + item.count, 0)
}

/**
 * Classifies an already-measured inventory delta (for example the delta in a
 * craft command receipt) against the recipe expectation.
 */
export function classifyCraftDelta(delta: Record<string, number>, expectation: CraftExpectation): CraftVerdict {
  if ((delta[expectation.result.id] ?? 0) < expectation.result.count)
    return 'failed'
  for (const material of expectation.materials) {
    if ((delta[material.id] ?? 0) > -material.count)
      return 'failed'
  }
  return 'verified'
}

export interface CraftExpectationResult {
  expectation?: CraftExpectation
  /** Materials given as tags; the delta check counts concrete items only. */
  tagMaterials: string[]
  /** Why no expectation exists (unknown shape, missing result). */
  unsupported?: string
}

/**
 * Builds the inventory delta expectation from a parsed recipe.
 *
 * Tag materials stay out of the concrete delta (their concrete items are
 * unknown before the craft); callers keep them visible in the trace.
 */
export function craftExpectation(candidate: Pick<Mc2RecipeCandidate, 'type' | 'result' | 'pattern' | 'keys' | 'ingredients'>): CraftExpectationResult {
  if (!candidate.result)
    return { tagMaterials: [], unsupported: 'recipe has no result' }

  const tagMaterials: string[] = []
  const materials: ItemCount[] = []
  const addMaterial = (entry: unknown): void => {
    if (!entry || typeof entry !== 'object')
      return
    const record = entry as { item?: string, tag?: string }
    if (record.item)
      materials.push({ id: record.item, count: 1 })
    else if (record.tag)
      tagMaterials.push(record.tag)
  }

  if (candidate.type === 'minecraft:crafting_shaped' && candidate.pattern) {
    const keys = (candidate.keys ?? {}) as Record<string, unknown>
    for (const row of candidate.pattern) {
      for (const symbol of row) {
        const entry = keys[symbol]
        if (!entry)
          return { tagMaterials, unsupported: `pattern symbol "${symbol}" has no key entry` }
        addMaterial(entry)
      }
    }
  }
  else if (candidate.type === 'minecraft:crafting_shapeless' && candidate.ingredients) {
    for (const entry of candidate.ingredients)
      addMaterial(entry)
  }
  else {
    return { tagMaterials, unsupported: `unsupported recipe type ${candidate.type}` }
  }

  return {
    expectation: {
      result: { id: candidate.result.id, count: candidate.result.count },
      materials,
    },
    tagMaterials,
  }
}

export function summarizeExploration(state: ExplorationState): string {
  const parts = [
    `${state.target.itemId}: ${state.phase}`,
    state.tier ? `tier=${state.tier}` : undefined,
    state.stopReason ? `stop=${state.stopReason}` : undefined,
    `steps=${state.steps.map(step => `${step.kind}:${step.status}`).join('>')}`,
  ].filter(Boolean)
  return parts.join('；')
}
