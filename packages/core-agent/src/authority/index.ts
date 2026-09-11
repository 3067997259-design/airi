export {
  bashApprovalRequired,
  classifyBashCommand,
  DEFAULT_APPROVAL_REQUIRED_BY_RISK,
  resolveApprovalRequired,
} from './approval'
export type { ApprovalConfig, BashRiskTier } from './approval'

export {
  applyLongGoalTransition,
  buildPlanningGuidanceBlock,
  compareLongGoalEnvironment,
  comparePlanningAuthority,
  createLongGoalState,
  describeLongGoalEnvironmentChanges,
  getPlanningAuthorityRule,
  hasHigherPlanningAuthority,
  normalizeLongGoalEnvironment,
  PLAN_LANES,
  PLAN_RECONCILER_DECISIONS,
  PLANNING_AUTHORITY_ORDER,
  PLANNING_ORCHESTRATION_TRUST_BOUNDARY_LINES,
  PLANNING_ORCHESTRATION_TRUST_LABEL,
  sanitizePlanProjectionText,
  summarizePlanStateForProjection,
} from './contract'
export type {
  LongGoalEnvironmentField,
  LongGoalEnvironmentSnapshot,
  LongGoalLifecycle,
  LongGoalPendingQuestion,
  LongGoalRunOutcome,
  LongGoalRunRecord,
  LongGoalState,
  LongGoalTransitionInput,
  LongGoalTransitionRecord,
  LongGoalTransitionSource,
  PlanEvidenceRef,
  PlanExpectedEvidence,
  PlanLane,
  PlanningAuthorityRule,
  PlanningAuthoritySource,
  PlanReconcilerDecision,
  PlanReconcilerDecisionRecord,
  PlanRiskLevel,
  PlanSpec,
  PlanSpecStep,
  PlanState,
  PlanStateProjectionSummary,
  PlanStepStatus,
} from './contract'

export { evaluateVerificationGate, stepHasSideEffects } from './gate'
export type { GateRef, VerificationGateInput, VerificationGateMissing, VerificationGateSatisfied, VerificationGateVerdict } from './gate'

export { canProveMutation, resolveEvidenceAuthority } from './provenance'
export type { EvidenceRefLike, ToolEvidenceAuthor } from './provenance'
