/**
 * Minimal repair (RS-4 §5).
 *
 * A repair is chosen from candidates that first satisfy the functional and
 * construction constraints, then minimize changed blocks, extra materials and
 * layout impact. Candidates run one at a time; the original state is re-checked
 * before each change and the whole structure is retested after it. A failed
 * change is undone only when the site still shows exactly what this task wrote
 * and the original state is safely restorable.
 *
 * The ledger keeps the original blueprint, the construction progress, the
 * candidate repairs and the accepted repairs separately. A candidate becomes
 * accepted only after a functional retest passes, and the structural goal is
 * always the original blueprint plus the accepted diffs.
 */
import type { BlueprintMaterialRequirement, BlueprintRecord } from './blueprint'
import type { BlockChange, BlueprintDiff } from './diff'
import type { Vec3 } from './geometry'
import type { ConstructionProgress } from './progress'
import type { BlockStateView } from './state'

import { itemIdForBlock } from './blueprint'
import { buildLayeredBlueprint, createBlueprintDiff } from './diff'
import { vecKey } from './geometry'

/** One possible minimal repair. */
export interface RepairCandidate {
  id: string
  /** Blueprint-relative position of the change. */
  position: Vec3
  originalState: BlockStateView
  newState: BlockStateView
  /** Constraint names this candidate satisfies. */
  satisfies: string[]
  /** Ordered operations, e.g. `['break', 'place']`. */
  operationOrder: string[]
  reason: string
  expectedEffect: string
  /** Relative layout disturbance used as a tie-break. */
  layoutImpact?: number
}

/** Required constraints a candidate must declare it satisfies. */
export interface RepairConstraints {
  /** Functional goals (harvest kept, other columns still powered). */
  functional: string[]
  /** Construction goals (reachable, materials, no structural conflict). */
  construction: string[]
}

export interface RankedCandidates {
  eligible: RepairCandidate[]
  rejected: Array<{ candidate: RepairCandidate, missing: string[] }>
}

function materialCount(candidate: RepairCandidate): number {
  return candidate.newState.blockId ? 1 : 0
}

function materialList(candidate: RepairCandidate): BlueprintMaterialRequirement[] {
  if (!candidate.newState.blockId)
    return []
  const { itemId, reusable } = itemIdForBlock(candidate.newState.blockId)
  return [{ itemId, count: 1, reusable }]
}

/**
 * Ranks candidates: constraint satisfaction first, then changed blocks, extra
 * materials and layout impact.
 *
 * A candidate missing any required constraint is rejected with the missing
 * names, never silently dropped.
 */
export function rankRepairCandidates(candidates: readonly RepairCandidate[], constraints: RepairConstraints): RankedCandidates {
  const required = [...constraints.functional, ...constraints.construction]
  const eligible: RepairCandidate[] = []
  const rejected: RankedCandidates['rejected'] = []
  for (const candidate of candidates) {
    const missing = required.filter(name => !candidate.satisfies.includes(name))
    if (missing.length > 0) {
      rejected.push({ candidate, missing })
      continue
    }
    eligible.push(candidate)
  }
  eligible.sort((left, right) => {
    if (materialCount(left) !== materialCount(right))
      return materialCount(left) - materialCount(right)
    const leftMaterials = materialList(left).reduce((total, entry) => total + entry.count, 0)
    const rightMaterials = materialList(right).reduce((total, entry) => total + entry.count, 0)
    if (leftMaterials !== rightMaterials)
      return leftMaterials - rightMaterials
    if ((left.layoutImpact ?? 0) !== (right.layoutImpact ?? 0))
      return (left.layoutImpact ?? 0) - (right.layoutImpact ?? 0)
    return vecKey(left.position) < vecKey(right.position) ? -1 : 1
  })
  return { eligible, rejected }
}

/** Converts a candidate into a diff against the original blueprint. */
export function candidateToDiff(candidate: RepairCandidate, base: BlueprintRecord, retestResult: 'passed' | 'failed' | 'not-run' = 'not-run'): BlueprintDiff {
  const change: BlockChange = {
    position: candidate.position,
    from: candidate.originalState.blockId,
    to: candidate.newState.blockId,
    ...(candidate.originalState.properties ? { fromProperties: candidate.originalState.properties } : {}),
    ...(candidate.newState.properties ? { toProperties: candidate.newState.properties } : {}),
  }
  return createBlueprintDiff({
    version: base.version + 1,
    baseContentDigest: base.contentDigest,
    changes: [change],
    reason: candidate.reason,
    evidence: [candidate.expectedEffect],
    appliesTo: { contentDigest: base.contentDigest, version: base.version },
    retestResult,
  })
}

/** Budget for a repair task. */
export interface RepairBudget {
  maxAttempts: number
  /** Wall-clock budget in ms. */
  deadlineMs: number
  startedAt: number
}

/** Whether another attempt is allowed inside the budget. */
export function canAttempt(budget: RepairBudget, attempts: number, now: number): { allowed: boolean, reason?: string } {
  if (attempts >= budget.maxAttempts)
    return { allowed: false, reason: 'attempt_budget_exhausted' }
  if (now - budget.startedAt >= budget.deadlineMs)
    return { allowed: false, reason: 'time_budget_exhausted' }
  return { allowed: true }
}

/** One attempt at one candidate. */
export interface RepairAttempt {
  candidateId: string
  position: Vec3
  /** The original state was re-checked and matched before the change. */
  preStateVerified: boolean
  applied: boolean
  retestResult: 'passed' | 'failed' | 'not-run'
  undoPerformed: boolean
  failureReason?: string
  startedAt: number
  endedAt: number
}

/** A planned undo, and the changes that must not be undone. */
export interface UndoPlan {
  restore: Array<{ position: Vec3, state: BlockStateView }>
  skipped: Array<{ position: Vec3, reason: string }>
}

/**
 * Plans a bounded undo for one candidate.
 *
 * A change is undone only when the site still shows exactly the state this task
 * wrote. A cell another actor changed is skipped, so the undo never overwrites
 * a newer change.
 */
export function planUndo(candidate: RepairCandidate, observed: ReadonlyMap<string, BlockStateView>): UndoPlan {
  const state = observed.get(vecKey(candidate.position))
  if (!state)
    return { restore: [], skipped: [{ position: candidate.position, reason: 'not_observable' }] }
  if (state.blockId !== candidate.newState.blockId)
    return { restore: [], skipped: [{ position: candidate.position, reason: 'not_attributable' }] }
  return { restore: [{ position: candidate.position, state: candidate.originalState }], skipped: [] }
}

/**
 * Separate stores for original, progress, candidates and accepted repairs.
 *
 * The ledger never mutates the original blueprint; {@link structuralGoal}
 * returns a new record built from the original plus the accepted diffs.
 */
export class RepairLedger {
  readonly original: BlueprintRecord
  readonly constructionProgress: ConstructionProgress
  private readonly candidates = new Map<string, RepairCandidate>()
  private readonly attemptLog: RepairAttempt[] = []
  private readonly accepted: BlueprintDiff[] = []

  constructor(original: BlueprintRecord, constructionProgress: ConstructionProgress) {
    this.original = original
    this.constructionProgress = constructionProgress
  }

  register(candidate: RepairCandidate): void {
    this.candidates.set(candidate.id, candidate)
  }

  listCandidates(): RepairCandidate[] {
    return [...this.candidates.values()]
  }

  /** Candidate repairs only, before any acceptance. */
  candidateDiffs(): BlueprintDiff[] {
    return this.listCandidates().map(candidate => candidateToDiff(candidate, this.original))
  }

  recordAttempt(attempt: RepairAttempt): void {
    this.attemptLog.push(attempt)
  }

  attemptsOf(candidateId: string): RepairAttempt[] {
    return this.attemptLog.filter(attempt => attempt.candidateId === candidateId)
  }

  listAttempts(): RepairAttempt[] {
    return [...this.attemptLog]
  }

  /**
   * Accepts a repair only when the functional retest passed.
   *
   * Returns the stored diff, or undefined when the retest did not pass. A single
   * repair's entry records its position, reason, evidence, applicable version
   * and retest result.
   */
  accept(input: { candidate: RepairCandidate, retestResult: 'passed' | 'failed' | 'not-run', evidence: string[], at: number }): BlueprintDiff | undefined {
    if (input.retestResult !== 'passed')
      return undefined
    const diff: BlueprintDiff = {
      ...candidateToDiff(input.candidate, this.original, 'passed'),
      evidence: input.evidence,
      acceptedAt: input.at,
    }
    this.accepted.push(diff)
    return diff
  }

  /** Accepted repairs only. */
  acceptedDiffs(): BlueprintDiff[] {
    return [...this.accepted]
  }

  /** Structural goal: original blueprint plus accepted diffs. */
  structuralGoal(): BlueprintRecord {
    return buildLayeredBlueprint(this.original, this.accepted)
  }
}
