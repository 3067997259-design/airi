/**
 * Skill lifecycle (SELF-AUTHORED-TOOLS-DESIGN §3.1 / §5).
 *
 * State machine, all pure:
 *
 * ```
 * draft ──promote──▶ probation ──approve──▶ reviewed
 *   ▲                  ▲  ▲                   │
 *   │                  │  └─ content changed ─┤
 *   └──── reset ───────┘  ◀─ any diff ────────┘
 *
 * compatibility mismatch ──▶ probation + quarantine
 * ```
 *
 * The binding rule: review attaches to `contentHash`, not to the tool id.
 * `graduateAfterReview` approves exactly the hash it is given, so a tool
 * edited after review can never ride on the old approval.
 */
import type { SelfAuthoredSkill, SkillReview, SkillRevisionProposal, SkillTrustState } from './types'

import { MAX_PROBATION_TOOLS } from './types'

export type SkillLifecycleAction
  = | 'promote_to_probation'
    | 'approve_review'
    | 'content_changed'
    | 'propose_revision'
    | 'compatibility_mismatch'
    | 'reset_fix'

export interface ApproveReviewInput {
  review: SkillReview
}

export interface ContentChangeInput {
  newContentHash: string
}

export interface CompatibilityMismatchInput {
  detectedAt: number
}

export interface ResetFixInput {
  fixedAt: number
}

export interface RevisionProposalInput {
  revision: SkillRevisionProposal
}

/** Empty input for actions that need no payload (promote / no-op). */
export interface EmptyActionInput {}

export type SkillLifecycleActionInput
  = | ApproveReviewInput
    | ContentChangeInput
    | CompatibilityMismatchInput
    | ResetFixInput
    | RevisionProposalInput
    | EmptyActionInput

export function lifecycleActionOf(from: SkillTrustState, to: SkillTrustState): SkillLifecycleAction | undefined {
  if (from === 'draft' && to === 'probation')
    return 'promote_to_probation'
  if (from === 'probation' && to === 'reviewed')
    return 'approve_review'
  return undefined
}

/** Whether the transition is allowed by the state machine. */
export function canTransition(action: SkillLifecycleAction, skill: SelfAuthoredSkill): boolean {
  switch (action) {
    case 'promote_to_probation':
      return skill.trust === 'draft'
    case 'approve_review':
      return skill.trust === 'probation'
    case 'content_changed':
      return true
    case 'propose_revision':
      return skill.trust === 'reviewed'
    case 'compatibility_mismatch':
      return skill.trust !== 'draft'
    case 'reset_fix':
      return skill.quarantine !== undefined
  }
}

/**
 * Applies one lifecycle action immutably. Returns the input skill unchanged
 * when the action is not allowed by the current state.
 */
export function applyLifecycleAction(
  skill: SelfAuthoredSkill,
  action: SkillLifecycleAction,
  input: SkillLifecycleActionInput = {},
): SelfAuthoredSkill {
  if (!canTransition(action, skill))
    return skill

  switch (action) {
    case 'promote_to_probation':
      return { ...skill, trust: 'probation' }
    case 'approve_review': {
      const review = 'review' in input ? input.review : undefined
      if (!review?.reviewer.trim() || !review.rationale.trim() || !Number.isFinite(review.reviewedAt))
        throw new Error('skill-forge: approve_review requires a complete review')
      // Approving binds to the CURRENT content hash — the one the reviewer
      // actually read.
      return { ...skill, trust: 'reviewed', review, quarantine: undefined, revision: undefined }
    }
    case 'content_changed': {
      const { newContentHash } = input as ContentChangeInput
      if (!newContentHash)
        throw new Error('skill-forge: content_changed requires newContentHash')
      return {
        ...skill,
        contentHash: newContentHash,
        trust: skill.trust === 'reviewed' ? 'probation' : skill.trust,
        review: undefined,
        quarantine: undefined,
        revision: undefined,
      }
    }
    case 'propose_revision': {
      const revision = 'revision' in input ? input.revision : undefined
      if (!revision?.reason.trim() || !Number.isInteger(revision.sourceEventSeq) || revision.sourceEventSeq < 0 || !Number.isFinite(revision.proposedAt))
        throw new Error('skill-forge: propose_revision requires a complete revision')
      return {
        ...skill,
        trust: 'probation',
        review: undefined,
        quarantine: undefined,
        revision,
      }
    }
    case 'compatibility_mismatch': {
      const detectedAt = 'detectedAt' in input ? input.detectedAt : undefined
      if (!Number.isFinite(detectedAt))
        throw new Error('skill-forge: compatibility_mismatch requires detectedAt')
      return {
        ...skill,
        trust: 'probation',
        review: undefined,
        quarantine: { reason: 'compatibility_mismatch', detectedAt: detectedAt! },
      }
    }
    case 'reset_fix':
      return { ...skill, quarantine: undefined }
  }
}

/**
 * Whether a new tool may enter probation, honoring the structural cap
 * (SELF-AUTHORED-TOOLS-DESIGN §9.2).
 */
export function canEnterProbation(skills: readonly SelfAuthoredSkill[]): boolean {
  const probationCount = skills.filter(skill => skill.trust === 'probation').length
  return probationCount < MAX_PROBATION_TOOLS
}
