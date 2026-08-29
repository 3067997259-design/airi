import { describe, expect, it } from 'vitest'

import {
  buildPlanningGuidanceBlock,
  getPlanningAuthorityRule,
  hasHigherPlanningAuthority,
  PLAN_LANES,
  PLANNING_AUTHORITY_ORDER,
  PLANNING_ORCHESTRATION_TRUST_LABEL,
  summarizePlanStateForProjection,
} from './contract'

describe('planning authority contract', () => {
  it('keeps the extracted base order intact', () => {
    expect(getPlanningAuthorityRule('runtime_system_rules').precedence).toBe(0)
    expect(getPlanningAuthorityRule('active_user_instruction').precedence).toBe(10)
    expect(getPlanningAuthorityRule('approval_safety_policy').precedence).toBe(20)
    expect(getPlanningAuthorityRule('verification_gate_decision').precedence).toBe(30)
    expect(getPlanningAuthorityRule('trusted_current_run_tool_evidence').precedence).toBe(40)
    expect(getPlanningAuthorityRule('plan_state_reconciler_decision').precedence).toBe(50)
    expect(getPlanningAuthorityRule('current_run_task_memory').precedence).toBe(60)
    expect(getPlanningAuthorityRule('current_run_archive_recall').precedence).toBe(70)
    expect(getPlanningAuthorityRule('active_local_workspace_memory').precedence).toBe(80)
    expect(getPlanningAuthorityRule('plast_mem_retrieved_context').precedence).toBe(90)
  })

  it('adds the three provenance sources at 42 / 45 / 47 without touching base flags', () => {
    const reviewed = getPlanningAuthorityRule('reviewed_self_authored_tool_result')
    const remote = getPlanningAuthorityRule('remote_agent_report')
    const unreviewed = getPlanningAuthorityRule('unreviewed_self_authored_tool_result')

    expect(reviewed.precedence).toBe(42)
    expect(reviewed.maySatisfyMutationProof).toBe(true)
    expect(remote.precedence).toBe(45)
    expect(remote.maySatisfyMutationProof).toBe(false)
    expect(unreviewed.precedence).toBe(47)
    expect(unreviewed.maySatisfyMutationProof).toBe(false)
  })

  // ROOT CAUSE:
  // If 47 sorted before 45, an unreviewed self-authored tool (same provenance
  // as the user) would outrank an independent remote agent, contradicting
  // SELF-AUTHORED-TOOLS-DESIGN §1.3's trust ordering.
  it('ranks unreviewed self-authored below remote agent reports', () => {
    expect(hasHigherPlanningAuthority('unreviewed_self_authored_tool_result', 'remote_agent_report')).toBe(false)
    expect(hasHigherPlanningAuthority('reviewed_self_authored_tool_result', 'unreviewed_self_authored_tool_result')).toBe(true)
  })

  it('extends lanes with mcp / websocket / conversation', () => {
    expect(PLAN_LANES).toContain('mcp')
    expect(PLAN_LANES).toContain('websocket')
    expect(PLAN_LANES).toContain('conversation')
  })

  it('orders the authority table ascending for projection', () => {
    for (let i = 1; i < PLANNING_AUTHORITY_ORDER.length; i++) {
      expect(PLANNING_AUTHORITY_ORDER[i]!.precedence).toBeGreaterThan(PLANNING_AUTHORITY_ORDER[i - 1]!.precedence)
    }
  })

  it('projects plan state to counts, never content', () => {
    const summary = summarizePlanStateForProjection({
      currentStepId: 'step-3',
      completedSteps: ['step-1', 'step-2'],
      failedSteps: [],
      skippedSteps: ['step-0'],
      evidenceRefs: [{ stepId: 'step-3', source: 'tool_result', summary: 'x' }],
      blockers: ['lint'],
      lastReplanReason: 'lint failed',
    })
    expect(summary).toEqual({
      scope: 'current_run_plan_state',
      currentStepId: 'step-3',
      completedStepCount: 2,
      failedStepCount: 0,
      skippedStepCount: 1,
      blockerCount: 1,
      evidenceRefCount: 1,
      lastReplanReason: 'lint failed',
    })
  })

  it('builds a bounded guidance block with the trust label', () => {
    const block = buildPlanningGuidanceBlock({
      plan: { goal: 'fix lint', steps: [{ id: 'a', lane: 'coding', intent: 'run lint', allowedTools: ['bash'], expectedEvidence: [{ source: 'tool_result', description: 'lint ok' }], riskLevel: 'low', approvalRequired: false }] },
      state: { completedSteps: [], failedSteps: [], skippedSteps: [], evidenceRefs: [], blockers: [] },
    })
    expect(block).toContain(PLANNING_ORCHESTRATION_TRUST_LABEL)
    expect(block).toContain('[coding/low]')
    expect(block).toContain('completedStepCount: 0')
  })
})
