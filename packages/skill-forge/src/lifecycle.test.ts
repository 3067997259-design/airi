import type { SelfAuthoredSkill } from './types'

import { describe, expect, it } from 'vitest'

import { applyLifecycleAction, canEnterProbation, canTransition, lifecycleActionOf } from './lifecycle'
import { MAX_PROBATION_TOOLS } from './types'

function skill(overrides: Partial<SelfAuthoredSkill> = {}): SelfAuthoredSkill {
  return {
    tool: { ownerExtensionId: 'airi', name: 'opencode-adapter', description: 'drives opencode', parameters: {} },
    activation: { keywords: ['opencode'], patterns: ['/opencode/'] },
    prompt: { id: 'opencode-adapter', content: 'Use the adapter to drive opencode.' },
    trust: 'draft',
    contentHash: 'aaaabbbbccccdddd',
    externalSources: [],
    ...overrides,
  }
}

describe('skill lifecycle', () => {
  it('moves draft → probation → reviewed', () => {
    const drafted = skill()
    expect(canTransition('promote_to_probation', drafted)).toBe(true)
    const probation = applyLifecycleAction(drafted, 'promote_to_probation')
    expect(probation.trust).toBe('probation')

    const reviewed = applyLifecycleAction(probation, 'approve_review', {
      review: { reviewer: 'you', rationale: 'read the 40 lines', reviewedAt: 1 },
    })
    expect(reviewed.trust).toBe('reviewed')
    expect(reviewed.review?.reviewer).toBe('you')
  })

  it('rejects promotion from non-draft states', () => {
    const reviewed = applyLifecycleAction(skill({ trust: 'probation' }), 'approve_review', {
      review: { reviewer: 'you', rationale: 'ok', reviewedAt: 1 },
    })
    expect(canTransition('promote_to_probation', reviewed)).toBe(false)
    expect(applyLifecycleAction(reviewed, 'promote_to_probation')).toBe(reviewed)
  })

  it('any content diff drops reviewed back to probation and voids the review', () => {
    const reviewed = applyLifecycleAction(skill({ trust: 'probation' }), 'approve_review', {
      review: { reviewer: 'you', rationale: 'ok', reviewedAt: 1 },
    })
    const changed = applyLifecycleAction(reviewed, 'content_changed', { newContentHash: 'eeeeffff00001111' })
    expect(changed.trust).toBe('probation')
    expect(changed.review).toBeUndefined()
    expect(changed.contentHash).toBe('eeeeffff00001111')
  })

  it('content change without a hash is a programming error', () => {
    expect(() => applyLifecycleAction(skill(), 'content_changed', {} as never)).toThrow(/newContentHash/)
  })

  it('quarantines on compatibility mismatch and clears on fix', () => {
    const reviewed = applyLifecycleAction(skill({ trust: 'probation' }), 'approve_review', {
      review: { reviewer: 'you', rationale: 'ok', reviewedAt: 1 },
    })
    const quarantined = applyLifecycleAction(reviewed, 'compatibility_mismatch', { detectedAt: 9 })
    expect(quarantined.trust).toBe('probation')
    expect(quarantined.review).toBeUndefined()
    expect(quarantined.quarantine).toEqual({ reason: 'compatibility_mismatch', detectedAt: 9 })

    const fixed = applyLifecycleAction(quarantined, 'reset_fix', { fixedAt: 10 })
    expect(fixed.quarantine).toBeUndefined()
    expect(fixed.trust).toBe('probation')
  })

  it('returns a reviewed tool to probation for a failed-call revision', () => {
    const reviewed = applyLifecycleAction(skill({ trust: 'probation' }), 'approve_review', {
      review: { reviewer: 'you', rationale: 'ok', reviewedAt: 1 },
    })
    const revision = applyLifecycleAction(reviewed, 'propose_revision', {
      revision: { sourceEventSeq: 4, reason: 'the adapter returned an error', proposedAt: 5 },
    })
    expect(revision.trust).toBe('probation')
    expect(revision.review).toBeUndefined()
    expect(revision.revision?.sourceEventSeq).toBe(4)
  })

  it('review approval binds to the current content hash', () => {
    const probation = applyLifecycleAction(skill(), 'promote_to_probation')
    const reviewed = applyLifecycleAction(probation, 'approve_review', {
      review: { reviewer: 'you', rationale: 'ok', reviewedAt: 1 },
    })
    // The approval carried no hash of its own: it approved the skill as-is.
    expect(reviewed.contentHash).toBe(probation.contentHash)
  })

  it('rejects an approval without a complete review record', () => {
    expect(() => applyLifecycleAction(skill({ trust: 'probation' }), 'approve_review'))
      .toThrow(/complete review/)
  })

  it('rejects a compatibility mismatch without a detection time', () => {
    expect(() => applyLifecycleAction(skill({ trust: 'reviewed' }), 'compatibility_mismatch'))
      .toThrow(/detectedAt/)
  })

  it('caps concurrent probation tools at 5', () => {
    const probationTools: SelfAuthoredSkill[] = Array.from({ length: MAX_PROBATION_TOOLS }, () =>
      skill({ trust: 'probation' }))
    expect(canEnterProbation(probationTools)).toBe(false)

    const roomAfterOneGraduates = probationTools.slice(0, MAX_PROBATION_TOOLS - 1)
    expect(canEnterProbation(roomAfterOneGraduates)).toBe(true)
  })

  it('does not disguise an unsupported state transition as a content change', () => {
    expect(lifecycleActionOf('reviewed', 'draft')).toBeUndefined()
    expect(lifecycleActionOf('draft', 'probation')).toBe('promote_to_probation')
  })
})
