export {
  buildAttentionModeSection,
  normalizeTaskMemory,
  resolveAttentionMode,
  TASK_MEMORY_LIMITS,
} from './attention'
export type { AttentionMode, TaskMemory } from './attention'

export {
  bashApprovalRequired,
  buildPlanningGuidanceBlock,
  classifyBashCommand,
  comparePlanningAuthority,
  DEFAULT_APPROVAL_REQUIRED_BY_RISK,
  evaluateVerificationGate,
  getPlanningAuthorityRule,
  hasHigherPlanningAuthority,
  PLAN_LANES,
  PLAN_RECONCILER_DECISIONS,
  PLANNING_AUTHORITY_ORDER,
  PLANNING_ORCHESTRATION_TRUST_BOUNDARY_LINES,
  PLANNING_ORCHESTRATION_TRUST_LABEL,
  resolveApprovalRequired,
  resolveEvidenceAuthority,
  sanitizePlanProjectionText,
  stepHasSideEffects,
  summarizePlanStateForProjection,
} from './authority'
export type {
  ApprovalConfig,
  BashRiskTier,
  EvidenceRefLike,
  GateRef,
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
  ToolEvidenceAuthor,
  VerificationGateInput,
  VerificationGateMissing,
  VerificationGateSatisfied,
  VerificationGateVerdict,
} from './authority'

export type { AgentContextPort } from './contracts/context-port'
export type { ChatHookRegistry } from './contracts/hook-types'

export type { AgentLLMPort } from './contracts/llm-port'
export type { AgentSessionPort } from './contracts/session-port'
export type { AgentForegroundStreamPort } from './contracts/stream-port'
export {
  createArchivePointer,
  createBranch,
  createBranchStore,
  createContextSectionUnit,
  createJournalStore,
  createTaskMemoryUnit,
  createToolEvidenceIndexUnit,
  DEFAULT_ARCHIVE_THRESHOLD_BYTES,
  deserializeBranch,
  estimateJournalBytes,
  JOURNAL_EVENT_TYPES,
  journalFromJSONL,
  journalToJSONL,
  ProjectionRegistry,
  serializeBranch,
  shouldArchiveJournal,
} from './journal'
export type {
  ArchiveDecision,
  ArchiveDecisionOptions,
  ArchivePointerEvent,
  CreateArchivePointerInput,
  CreateBranchOptions,
  JournalBranch,
  JournalEvent,
  JournalEventInput,
  JournalEventType,
  JournalStore,
  JournalStoreOptions,
  ProjectionChangeListener,
  ProjectionSnapshot,
  ProjectionUnit,
  SessionHeaderEvent,
  ToolEvidenceEntry,
} from './journal'

export {
  buildContextPromptMessage,
  formatContextPromptText,
} from './messages/context-prompt'
export type { ContextSnapshot } from './messages/context-prompt'
export { formatTimePrefix } from './messages/datetime-prefix'
export type {
  HistoryItem,
  HistoryReaction,
  HistorySummary,
  HistoryTurn,
  MessageSegment,
  RawMessage,
  SegmentReference,
  SegmentSummary,
  Message as StructuredMessage,
} from './messages/types'
export { collectStepGateRefs, projectStepGateStates, verdictForStep } from './planning/evidence-gate'
export type { EvidenceGateSnapshot, StepGateSpec, StepGateState, StepGateStatus } from './planning/evidence-gate'
export { buildTurnProjection } from './planning/turn-projection'
export type { TurnProjection, TurnProjectionInput } from './planning/turn-projection'
export { createChatHooks } from './runtime/agent-hooks'
export type {
  ChatCommandDirective,
  ChatMemoryContextItem,
  ChatOrchestratorCompactionOptions,
  ChatOrchestratorCompactionSnapshot,
  ChatOrchestratorCompactionSummaryInput,
  ChatOrchestratorJournalPort,
  ChatOrchestratorLifecycleRecord,
  ChatOrchestratorLLMPort,
  ChatOrchestratorMemoryPort,
  ChatOrchestratorPromptProjection,
  ChatOrchestratorRuntime,
  ChatOrchestratorRuntimeDeps,
  ChatOrchestratorRuntimeState,
  ChatOrchestratorSendOptions,
  ChatOrchestratorSessionPort,
  ChatSendSource,
  QueuedSendSnapshot,
} from './runtime/chat-orchestrator-runtime'
export { createChatOrchestratorRuntime } from './runtime/chat-orchestrator-runtime'
export type { ContextHistoryEntry, ContextIngestResult, ContextRegistry } from './runtime/context-registry'
export { createContextRegistry } from './runtime/context-registry'
export { useLlmmarkerParser } from './runtime/llm-marker-parser'
export {
  isContentArrayRelatedError,
  isToolRelatedError,
  modelKey,
  sanitizeMessages,
  streamFrom,
  streamOptionsContentArrayCompatibilityOk,
  streamOptionsToolsCompatibilityOk,
} from './runtime/llm-service'
export {
  categorizeResponse,
  createStreamingCategorizer,
} from './runtime/response-categoriser'
export type {
  CategorizedResponse,
  CategorizedSegment,
  ResponseCategory,
} from './runtime/response-categoriser'
export { mergeLoadedSessionMessages } from './session/merge-loaded-session-messages'
export type {
  ChatAssistantMessage,
  ChatHistoryItem,
  ChatMessage,
  ChatSlices,
  ChatSlicesText,
  ChatSlicesToolCall,
  ChatSlicesToolCallResult,
  ChatStreamEvent,
  ChatStreamEventContext,
  ChatToolReference,
  ContextMessage,
  ErrorMessage,
  StreamingAssistantMessage,
} from './types/chat'

export type {
  BuiltinToolsResolver,
  StreamEvent,
  StreamFromOptions,
  StreamOptions,
} from './types/llm'
