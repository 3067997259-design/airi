import type { PlanEvidenceRef, PlanningAuthorityRule } from './contract'

/**
 * Evidence provenance: maps an `PlanEvidenceRef` back to the planning
 * authority it belongs to (SELF-AUTHORED-TOOLS-DESIGN §1.3).
 *
 * The binding constraint of the whole fork: whether evidence may prove a
 * mutation depends on *who produced it*, not on what it says. `tool_result`
 * refs therefore require the producer to be named; refs without a producer
 * default to the least trusted bucket instead of silently passing as builtin.
 */
import { getPlanningAuthorityRule } from './contract'

export type ToolEvidenceAuthor = 'builtin' | 'reviewed_self_authored' | 'unreviewed_self_authored' | 'remote_agent'

export interface EvidenceRefLike {
  source: PlanEvidenceRef['source']
}

/**
 * Resolves the authority rule for an evidence ref.
 *
 * `author` is required when `ref.source` is `'tool_result'`: a bare
 * `tool_result` has no intrinsic trust level, so omitting the producer is a
 * programming error, not a shortcut.
 *
 * Mapping:
 *
 * | ref source | author | authority |
 * |---|---|---|
 * | `tool_result` | builtin | `trusted_current_run_tool_evidence` (40) |
 * | `tool_result` | reviewed_self_authored | `reviewed_self_authored_tool_result` (42) |
 * | `tool_result` | remote_agent | `remote_agent_report` (45) |
 * | `tool_result` | unreviewed_self_authored | `unreviewed_self_authored_tool_result` (47) |
 * | `verification_gate` | — | `verification_gate_decision` (30) |
 * | `human_approval` | — | `approval_safety_policy` (20) |
 * | `runtime_trace` | — | `current_run_task_memory` (60) |
 *
 * `runtime_trace` intentionally lands next to task memory: it is a runtime
 * record, guidance-grade information, and can never prove a mutation.
 */
export function resolveEvidenceAuthority(ref: EvidenceRefLike, author?: ToolEvidenceAuthor): PlanningAuthorityRule {
  switch (ref.source) {
    case 'tool_result': {
      if (!author)
        throw new Error('resolveEvidenceAuthority: tool_result evidence requires a producer')
      switch (author) {
        case 'builtin':
          return getPlanningAuthorityRule('trusted_current_run_tool_evidence')
        case 'reviewed_self_authored':
          return getPlanningAuthorityRule('reviewed_self_authored_tool_result')
        case 'remote_agent':
          return getPlanningAuthorityRule('remote_agent_report')
        case 'unreviewed_self_authored':
          return getPlanningAuthorityRule('unreviewed_self_authored_tool_result')
      }
      break
    }
    case 'verification_gate':
      return getPlanningAuthorityRule('verification_gate_decision')
    case 'human_approval':
      return getPlanningAuthorityRule('approval_safety_policy')
    case 'runtime_trace':
      return getPlanningAuthorityRule('current_run_task_memory')
  }
}

/**
 * Whether evidence of this source can ever satisfy mutation proof,
 * regardless of producer. Only builtin and reviewed self-authored tools can.
 */
export function canProveMutation(ref: EvidenceRefLike, author?: ToolEvidenceAuthor): boolean {
  return resolveEvidenceAuthority(ref, author).maySatisfyMutationProof
}
