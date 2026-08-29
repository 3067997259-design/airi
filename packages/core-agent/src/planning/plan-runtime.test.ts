import type { ToolEvidenceAuthor } from '../authority/provenance'
import type { PlanRuntimeEvent, PlanRuntimeSpec, PlanRuntimeStepInput } from './plan-runtime'

import { describe, expect, it } from 'vitest'

import { canUseTool, projectPlanRuntime } from './plan-runtime'

function step(overrides: Partial<PlanRuntimeStepInput> = {}): PlanRuntimeStepInput {
  return {
    id: 'write-adapter',
    lane: 'coding',
    intent: 'write the adapter',
    allowedTools: ['read', 'edit', 'bash'],
    expectedEvidence: [{ source: 'tool_result', description: 'adapter written' }],
    riskLevel: 'medium',
    approvalRequired: false,
    ...overrides,
  }
}

function spec(steps: PlanRuntimeStepInput[] = [step()]): PlanRuntimeSpec {
  return { goal: 'fix lint', steps }
}

describe('plan runtime', () => {
  it('stays pending until a step starts', () => {
    const snapshot = projectPlanRuntime(spec(), [])
    expect(snapshot.steps['write-adapter']?.status).toBe('pending')
  })

  it('rejects tools outside the whitelist structurally', () => {
    expect(canUseTool(step(), 'bash')).toBe(true)
    expect(canUseTool(step(), 'rm')).toBe(false)

    const events: PlanRuntimeEvent[] = [{ type: 'start-step', stepId: 'write-adapter', toolName: 'rm' }]
    const snapshot = projectPlanRuntime(spec(), events)
    expect(snapshot.steps['write-adapter']?.status).toBe('blocked')
    expect(snapshot.steps['write-adapter']?.reason).toContain('not allowed')
  })

  it('completes a side-effect step only with mutation-provable builtin evidence', () => {
    const events: PlanRuntimeEvent[] = [
      { type: 'start-step', stepId: 'write-adapter', toolName: 'edit' },
      { type: 'tool-result', stepId: 'write-adapter', toolName: 'edit', ok: true, summary: 'applied', author: 'builtin' },
    ]
    const snapshot = projectPlanRuntime(spec(), events)
    expect(snapshot.steps['write-adapter']?.status).toBe('completed')
    expect(snapshot.completedStepCount).toBe(1)
  })

  it('blocks on unreviewed self-authored evidence (self-proof loop guard)', () => {
    const events: PlanRuntimeEvent[] = [
      { type: 'start-step', stepId: 'write-adapter', toolName: 'edit' },
      { type: 'tool-result', stepId: 'write-adapter', toolName: 'edit', ok: true, summary: 'applied' },
    ]
    const snapshot = projectPlanRuntime(spec(), events)
    expect(snapshot.steps['write-adapter']?.status).toBe('blocked')
    expect(snapshot.steps['write-adapter']?.reason).toContain('not_mutation_proof')
  })

  it('lets a recorded human approval pass an approval-required step', () => {
    const events: PlanRuntimeEvent[] = [
      { type: 'start-step', stepId: 'write-adapter', toolName: 'bash' },
      { type: 'approval-decided', stepId: 'write-adapter', decision: 'approved' },
      { type: 'tool-result', stepId: 'write-adapter', toolName: 'bash', ok: true, summary: 'pushed', author: 'builtin' },
    ]
    const stepWithApproval = step({ approvalRequired: true, allowedTools: ['bash'] })
    const snapshot = projectPlanRuntime(spec([stepWithApproval]), events)
    expect(snapshot.steps['write-adapter']?.status).toBe('completed')
  })

  it('a rejected approval without other evidence keeps the step blocked', () => {
    const events: PlanRuntimeEvent[] = [
      { type: 'start-step', stepId: 'write-adapter', toolName: 'bash' },
      { type: 'approval-decided', stepId: 'write-adapter', decision: 'rejected' },
    ]
    const stepWithApproval = step({ approvalRequired: true, allowedTools: ['bash'] })
    const snapshot = projectPlanRuntime(spec([stepWithApproval]), events)
    expect(snapshot.steps['write-adapter']?.status).toBe('blocked')
  })

  it('treats an unlabeled tool result as unreviewed (least trusted default)', () => {
    const events: PlanRuntimeEvent[] = [
      { type: 'start-step', stepId: 'write-adapter', toolName: 'edit' },
      { type: 'tool-result', stepId: 'write-adapter', toolName: 'edit', ok: true, summary: 'x' },
    ]
    const snapshot = projectPlanRuntime(spec(), events)
    expect(snapshot.steps['write-adapter']?.verdict?.missing[0]?.reason).toBe('not_mutation_proof')
  })

  it('projects per-step counts for the bounded turn context', () => {
    const events: PlanRuntimeEvent[] = [
      { type: 'start-step', stepId: 'write-adapter', toolName: 'edit' },
      { type: 'tool-result', stepId: 'write-adapter', toolName: 'edit', ok: true, summary: 'ok', author: 'builtin' as ToolEvidenceAuthor },
    ]
    const snapshot = projectPlanRuntime(spec(), events)
    expect(snapshot.completedStepCount).toBe(1)
    expect(snapshot.failedStepCount).toBe(0)
    expect(snapshot.blockedStepCount).toBe(0)
  })
})
