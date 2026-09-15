/**
 * Journal event types (CODING-HARNESS-DESIGN §4.4).
 *
 * The journal is the single append-only source of truth; every state in the
 * fork (PlanState, TaskMemory, reactions, evidence index, compaction
 * summaries) is a projection of these events. Events are raw snapshots, not
 * summaries, and must stay JSON-serializable so a branch can be replayed.
 */
export const JOURNAL_EVENT_TYPES = [
  'session/header',
  'turn/start',
  'turn/end',
  'user/message',
  'assistant/start',
  'assistant/chunk',
  'assistant/done',
  'tool/call',
  'tool/result',
  'flow/start',
  'flow/step',
  'flow/end',
  'flow/resumed',
  'plan/update',
  'goal/update',
  'plan/hint',
  'todo/write',
  'prompt/supplement-changed',
  'task/update',
  'context/inject',
  'event/reaction',
  'approval/asked',
  'approval/decided',
  'review/asked',
  'review/decided',
  'user/asked',
  'user/answered',
  'user/steering',
  'flow/completion-review',
  'fork/point',
  'archived/pointer',
  'appearance/changed',
  'life/tick',
  'life/heartbeat',
  'life/decision',
  'memory/retrieved',
  'memory/applied',
  'memory/dream',
  'memory/migrated',
  'memory/revised',
] as const

export type JournalEventType = (typeof JOURNAL_EVENT_TYPES)[number]

export type TurnEndReason = 'completed' | 'aborted' | 'steered' | 'max-steps' | 'error'

export type FlowTrigger = 'tool' | 'declared' | 'command'

export type FlowEndReason = 'done' | 'blocked' | 'interrupted' | 'budget' | 'no-progress'

export type ToolResultOutcome = 'ok' | 'failed' | 'denied' | 'timeout' | 'revoked'

export type ToolResultTier = 'read-only' | 'medium' | 'high'

export interface TurnStartEvent {
  type: 'turn/start'
  seq: number
  turnId: string
  source: 'text' | 'voice' | 'self-initiative' | 'btw' | 'flow'
  timestamp: number
  planId?: string
  flowId?: string
  /**
   * Task this turn advances. Present on flow continuation turns; a flow may
   * also start mid-turn, so ordinary turns only carry it when one is open.
   */
  taskId?: string
  iteration?: number
  maxSteps: number
  /** Effective per-iteration step budget of a flow turn; `maxSteps` is only the provider cap. */
  stepBudget?: number
}

export interface TurnEndEvent {
  type: 'turn/end'
  seq: number
  turnId: string
  reason: TurnEndReason
  timestamp: number
  error?: string
}

export interface SessionHeaderEvent {
  type: 'session/header'
  seq: number
  sessionId: string
  parentSessionId?: string
  cwd?: string
  createdAt: number
  agentPreset?: string
  delegationDepth: number
}

export interface UserMessageEvent {
  type: 'user/message'
  seq: number
  text: string
  timestamp: number
}

export interface AssistantStartEvent {
  type: 'assistant/start'
  seq: number
}

export interface AssistantChunkEvent {
  type: 'assistant/chunk'
  seq: number
  turnId?: string
  text: string
}

export interface AssistantDoneEvent {
  type: 'assistant/done'
  seq: number
}

export interface ToolCallEvent {
  type: 'tool/call'
  seq: number
  toolName: string
  args: unknown
  planId?: string
  /** Open task this call belongs to; stamped by the runtime while a flow runs. */
  taskId?: string
}

export interface ToolResultEvent {
  type: 'tool/result'
  seq: number
  toolName: string
  ok: boolean
  /** Whether the tool result completed, failed, was denied, timed out, or arrived after its registration was revoked. */
  outcome?: ToolResultOutcome
  /** Bash risk tier, when the tool reports one. */
  tier?: ToolResultTier
  summary: string
  /** Serialized evidence provenance (author bucketing), set by the caller. */
  provenance?: string
  /**
   * Registration surface that executed the tool, for example
   * `plugin:adapter-x`; kept beside the evidence author so a wrapper stays
   * visible in the receipt without raising its trust.
   */
  surface?: string
  /** Plan step this result belongs to; drives the verification gate. */
  stepId?: string
  /** Plan that owns the step when more than one plan is active. */
  planId?: string
  /** Open task this result belongs to; stamped by the writer while a flow runs. */
  taskId?: string
  /**
   * Wall-clock time the writing owner recorded the result. Optional because
   * journals written before the field exist; social consideration uses it to
   * age activity candidates instead of trusting the model's sense of "now".
   */
  timestamp?: number
}

/**
 * Non-sensitive runtime configuration a restart needs to resume a flow in
 * its original environment (TASK-RUN-AND-UI-PLAN batch D). Secrets, API keys,
 * and full prompts never belong here — the resume send re-resolves the
 * provider instance from the host, this snapshot only says WHICH one.
 */
export interface FlowResumeConfig {
  providerId: string
  model: string
  profile: 'social' | 'work'
  toolNames: string[]
  workspaceRoot?: string
}

/**
 * The full resume view of one flow, assembled from the journal at recovery
 * time: the journaled configuration plus the identity and cursor fields the
 * verifier needs before the loop may continue.
 */
export interface FlowResumeContext extends FlowResumeConfig {
  taskId: string
  flowId: string
  sessionId: string
  iteration: number
  lastJournalSeq: number
  status: 'running' | 'waiting-user' | 'interrupted' | 'ended'
}

export interface FlowStartEvent {
  type: 'flow/start'
  seq: number
  flowId: string
  /** Task identity created with the flow; every later event of the run repeats it. */
  taskId?: string
  /** Non-sensitive environment snapshot a restart resumes from, when known. */
  resume?: FlowResumeConfig
  trigger: FlowTrigger
  triggerDetail?: string
  timestamp: number
}

export interface FlowStepEvent {
  type: 'flow/step'
  seq: number
  flowId: string
  taskId?: string
  iteration: number
  reason: 'continue'
  /** Seq of the last journal event settled before this iteration started. */
  lastJournalSeq?: number
  /** Refreshed environment snapshot; the latest one on the run wins. */
  resume?: FlowResumeConfig
  pending?: string
}

export interface FlowEndEvent {
  type: 'flow/end'
  seq: number
  flowId: string
  taskId?: string
  reason: FlowEndReason
  iterations: number
  timestamp: number
  detail?: string
}

/**
 * Records that a flow was rebuilt from the journal after a restart.
 *
 * The run keeps its flow/task identity; this event marks the wall-clock and
 * seq boundary between the interrupted attempt and the recovery actions, so
 * ordinary turns can attribute evidence to the correct phase instead of
 * guessing from message order (ACC-20260911 #9).
 */
export interface FlowResumedEvent {
  type: 'flow/resumed'
  seq: number
  flowId: string
  taskId?: string
  /** Wall-clock time the renderer rebuilt the run. */
  resumedAt: number
  /** Highest journal seq of the interrupted attempt; events at or below it are pre-restart. */
  resumedFromSeq: number
  timestamp: number
}

export interface PlanUpdateEvent {
  type: 'plan/update'
  seq: number
  planId?: string
  stepId?: string
  /** Task whose flow was open when the plan changed; absent for plan activity outside any flow. */
  taskId?: string
  status?: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped' | 'blocked' | 'paused' | 'cancelled'
  reason?: string
  /**
   * Set on model-declared completions that the evidence gate did not verify.
   * The projection surfaces these as unverified (amber) instead of blocking,
   * and `human_approval` steps can never carry it.
   */
  unverified?: boolean
  /** Wall-clock time the writing owner recorded the update; see {@link ToolResultEvent.timestamp}. */
  timestamp?: number
}

export interface TaskUpdateEvent {
  type: 'task/update'
  seq: number
  taskId: string
  /** Full replace-self TaskMemory snapshot; the Nth update replaces the N-1th. */
  memory: Record<string, unknown>
  logRef?: string
  /** Wall-clock time the writing owner recorded the update; see {@link ToolResultEvent.timestamp}. */
  timestamp?: number
}

/**
 * The cached system prefix changed between turns.
 *
 * Everything before the last message is what a provider can cache, and the
 * app-owned supplement sits there. A supplement that carries volatile state
 * (plan counters, attention mode) rewrites the prefix each step and pays for
 * the whole conversation again; this event is how that cost becomes visible
 * (HARNESS-PLAN §5.1, verification T5).
 */
export interface PromptSupplementChangedEvent {
  type: 'prompt/supplement-changed'
  seq: number
  hash: string
  previousHash?: string
  timestamp: number
}

/** One line of the model's own task list. */
export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

/**
 * The model's task list, replaced whole on every write.
 *
 * This is a communication channel, not a verdict: nothing here satisfies a
 * verification gate, and no gate blocks a write. The two jobs are separate on
 * purpose — the fork's evidence gate stalled once it also had to carry
 * "what is she doing right now" (HARNESS-PLAN §1, §4.2). The list is scoped to
 * the current turn: readers take the last write after the newest turn/start,
 * so a new turn starts empty without anyone clearing it.
 */
export interface TodoWriteEvent {
  type: 'todo/write'
  seq: number
  todos: TodoItem[]
  timestamp: number
}

/**
 * A tool result that no open plan step accepts.
 *
 * The evidence gate reads stamped tool results only, so an unstamped result is
 * invisible to it. Recording why keeps the mismatch visible to the model
 * through the plan projection, instead of leaving a step pending forever with
 * no explanation (HARNESS-PLAN §4.1).
 */
export interface PlanHintEvent {
  type: 'plan/hint'
  seq: number
  planId: string
  /** Tool whose result could not be attached. */
  toolName: string
  /** Tools the plan's open steps accept right now. */
  allowedTools: string[]
  focusedStepId?: string
  timestamp: number
}

export interface ContextInjectEvent {
  type: 'context/inject'
  seq: number
  eventId?: string
  contextId: string
  source: string
  text: string
}

export interface EventReactionJournalEvent {
  type: 'event/reaction'
  seq: number
  eventId: string
  reaction: string
  source?: string
  timestamp: number
}

export interface ApprovalAskedEvent {
  type: 'approval/asked'
  seq: number
  requestId: string
  stepId?: string
  planId?: string
  riskLevel?: 'low' | 'medium' | 'high'
  reason: string
  /** The concrete thing awaiting approval (e.g. the bash command line). */
  subject?: string
}

export interface ApprovalDecidedEvent {
  type: 'approval/decided'
  seq: number
  requestId: string
  planId?: string
  decision: 'allowed-once' | 'rejected' | 'cancelled'
}

export interface UserAskedEvent {
  type: 'user/asked'
  seq: number
  requestId: string
  question: string
  choices?: string[]
  /** Task that is waiting for this answer, when one is open. */
  taskId?: string
  source?: 'user_ask' | 'btw'
}

export interface UserAnsweredEvent {
  type: 'user/answered'
  seq: number
  requestId: string
  answer: string
  /** Task whose pending question this answer settles. */
  taskId?: string
  channel?: 'choice' | 'text' | 'dismissed'
  source?: 'user_ask' | 'btw'
}

/**
 * User text captured while a flow was running.
 *
 * During a flow every queued user send is steering, not a new turn: the text
 * rides the next iteration's opening prompt instead of killing the loop.
 */
export interface UserSteeringEvent {
  type: 'user/steering'
  seq: number
  text: string
  flowId?: string
  /** Task the steering feeds; steering never opens a task of its own. */
  taskId?: string
  /** This push displaced the oldest queued steering text (queue cap reached). */
  droppedOldest?: boolean
  timestamp: number
}

/**
 * The outcome of a done-declaration check at the turn boundary.
 *
 * `gate` is the mechanical plan-step conjunction (L1); `review` is the
 * host-supplied completion reviewer over the journal slice (L3). `rejected`
 * keeps the flow running and feeds `feedback` to the next iteration.
 */
export interface FlowCompletionReviewEvent {
  type: 'flow/completion-review'
  seq: number
  flowId: string
  taskId?: string
  layer: 'gate' | 'review'
  verdict: 'pass' | 'rejected' | 'abstain'
  blockers?: string[]
  feedback?: string
  timestamp: number
}

export interface ReviewAskedEvent {
  type: 'review/asked'
  seq: number
  reviewRequestId: string
  toolId: string
  contentHash: string
  reason: string
}

export interface ReviewDecidedEvent {
  type: 'review/decided'
  seq: number
  reviewRequestId: string
  toolId: string
  decision: 'approved' | 'rejected'
  reviewer: string
  rationale?: string
}

export interface ForkPointEvent {
  type: 'fork/point'
  seq: number
  branchId: string
  parentSeq: number
}

export interface ArchivePointerEvent {
  type: 'archived/pointer'
  seq: number
  archivePath: string
  startSeq: number
  endSeq: number
  archivedAt: number
  byteLength: number
}

/**
 * One visual change the character made (LIFE-PLAN M2). The journal becomes
 * her narratable life: "the coat went on Wednesday, hair changed twice last
 * week" replays from these events.
 */
export interface AppearanceChangedEvent {
  type: 'appearance/changed'
  seq: number
  source: 'parameter' | 'expression' | 'expression-reset'
  /** Parameter id or expression name; '*' for full resets. */
  target: string
  value?: number
  enabled?: boolean
  timestamp: number
}

/**
 * One heartbeat of the autonomous tick (LIFE-PLAN M3). Records that a
 * consideration round ran and what it decided, including silence — the
 * journal is the black box of her inner life.
 */
export interface LifeTickEvent {
  type: 'life/tick'
  seq: number
  tickId: string
  outcome: 'considered-silent' | 'spoke' | 'noted' | 'gated'
  /** Cheap-gate that suppressed this tick before any round, when applicable. */
  gate?: 'quiet-hours' | 'budget' | 'cooldown' | 'busy' | 'respond'
  /** Why the tick fired; a short structured stimulus summary. */
  stimulus?: string
  /** Private text recorded by a `self_note` consideration tool call. */
  note?: string
  timestamp: number
}

/** One observable scheduling opportunity before a model decision. */
export interface LifeHeartbeatEvent {
  type: 'life/heartbeat'
  seq: number
  heartbeatId: string
  outcome: 'emitted' | 'gated' | 'no-stimulus' | 'tools-unavailable'
  gate?: 'mode' | 'quiet-hours' | 'budget' | 'cooldown' | 'busy' | 'focused' | 'flow-active' | 'speech-active' | 'no-session' | 'no-stimulus' | 'stale-stimulus' | 'tools-unavailable' | 'stale-heartbeat' | 'respond'
  nextHeartbeatAt?: number
  timestamp: number
}

/** The explicit result of one social consideration round. */
export interface LifeDecisionEvent {
  type: 'life/decision'
  seq: number
  heartbeatId: string
  decisionId: string
  action: 'speak' | 'note' | 'silence' | 'discarded' | 'protocol-error' | 'provider-error'
  text?: string
  reason?: string
  sourceRefs: string[]
  consideredThroughSeq: number
  timestamp: number
}

/** One bounded memory retrieval used to compose a prompt. */
export interface MemoryRetrievedEvent {
  type: 'memory/retrieved'
  seq: number
  sessionId: string
  /** Turn whose prompt consumed the retrieval; empty when sent outside a turn. */
  turnId?: string
  memoryIds: string[]
  query: string
  /** Per-memory dual-query scores kept for retrieval diagnostics. */
  scores?: Array<{
    memoryId: string
    score?: number
    originalSimilarity?: number
    normalizedSimilarity?: number
    retrievalQuery?: 'original' | 'normalized' | 'both'
  }>
  timestamp: number
}

/** One durable lifecycle transition for a long-horizon goal. */
export interface GoalUpdateEvent {
  type: 'goal/update'
  seq: number
  goalId: string
  lifecycle: import('../authority/contract').LongGoalLifecycle
  reason: string
  source: import('../authority/contract').LongGoalTransitionSource
  constraintVersion: number
  timestamp: number
  revision?: boolean
  taskId?: string
  flowId?: string
  nextReviewAt?: number
  waitReason?: string
  pendingQuestion?: import('../authority/contract').LongGoalPendingQuestion
  run?: import('../authority/contract').LongGoalRunRecord
  environment?: import('../authority/contract').LongGoalEnvironmentSnapshot
}

/**
 * Whether the answered turn actually used its recalled memories.
 *
 * The marker-based detection separates parroting the current-session context
 * from genuine cross-session recall (MEMORY-SEMANTICS-CORRECTION §5.2): an
 * answer that never cites `[memory:<id>]` stays recorded with an empty
 * `appliedMemoryIds`, so it can never serve as recall evidence.
 */
export interface MemoryAppliedEvent {
  type: 'memory/applied'
  seq: number
  sessionId: string
  turnId: string
  retrievedMemoryIds: string[]
  appliedMemoryIds: string[]
  timestamp: number
}

/** One manual muscle-to-fact migration triggered from the memory browser. */
export interface MemoryMigratedEvent {
  type: 'memory/migrated'
  seq: number
  sessionId: string
  /** Local id of the migrated fragment; the id is preserved by the migration. */
  memoryId: string
  fromType: string
  toType: string
  /** Whether the migrated fragment carried a usable trigger pattern. */
  hadTriggerPattern: boolean
  reviewStatus: string
  timestamp: number
}

/**
 * One user correction proposal against an existing claim. The revision stays
 * pending until review; approving it supersedes the previous claim, so this
 * event marks the moment the correction entered the pipeline.
 */
export interface MemoryRevisedEvent {
  type: 'memory/revised'
  seq: number
  sessionId: string
  /** Claim being corrected. */
  memoryId: string
  /** Newly created pending revision. */
  revisionId: string
  relation: 'supersedes' | 'disputes'
  timestamp: number
}

/** One bounded automatic dreaming pass triggered by an eligible life heartbeat. */
export interface MemoryDreamEvent {
  type: 'memory/dream'
  seq: number
  heartbeatId: string
  status: 'ran'
  addedCount: number
  timestamp: number
}

/**
 * Lifecycle of one continuous piece of work, as the journal shows it.
 *
 * `running` covers every iteration of an open flow; `waiting-user` marks an
 * open user question. The terminal statuses come from the `flow/end` reason,
 * with one status per reason so no terminal state has to be guessed back out
 * of `endDetail`.
 */
/**
 * A bounded, serializable activity row for one task projection.
 *
 * The row crosses renderer boundaries in the synchronized task snapshot.
 * It contains display data only, so it never replaces the journal as the
 * source of truth.
 */
export type TaskRunActivity
  = | {
    kind: 'tool-call'
    seq: number
    toolName: string
    args: string
  }
  | {
    kind: 'tool-result'
    seq: number
    toolName: string
    ok: boolean
    outcome?: ToolResultOutcome
    summary: string
  }
  | {
    kind: 'narration'
    seq: number
    text: string
  }
  | {
    kind: 'steering'
    seq: number
    text: string
  }
  | {
    kind: 'plan-update'
    seq: number
    planId?: string
    stepId?: string
    status?: PlanUpdateEvent['status']
    unverified?: boolean
  }
  | {
    kind: 'completion-review'
    seq: number
    layer: FlowCompletionReviewEvent['layer']
    verdict: FlowCompletionReviewEvent['verdict']
    blockers?: string[]
  }

export type TaskRunStatus
  = | 'running'
    | 'waiting-user'
    | 'completed'
    | 'blocked'
    | 'interrupted'
    | 'budget'
    | 'no-progress'

/**
 * The derived projection of one task run (TASK-RUN-AND-UI-PLAN batch A).
 *
 * A task is what one continuous piece of engineering work is called across
 * its whole lifetime. It is not a second source of truth — every field is
 * derived from journal events — and its identity never borrows another id:
 * `taskId` is minted beside (never from) `flowId`, `planId`, or message ids,
 * so an event can always be attributed by its own stamp instead of by
 * scanning time windows.
 */
export interface TaskRun {
  taskId: string
  sessionId: string
  flowId?: string
  planIds: string[]
  title: string
  status: TaskRunStatus
  startedAt: number
  updatedAt: number
  /** At most 40 rows, derived from the task window for cross-window display. */
  activity: TaskRunActivity[]
  currentIteration?: number
  currentStepId?: string
  pendingQuestion?: string
  lastFailure?: string
  endDetail?: string
  /**
   * Set on runs rebuilt from journals written before task stamps existed.
   * Their identity is synthesized for display only, so they must never be
   * resumed or continued under it.
   */
  legacy?: boolean
}

export type JournalEvent
  = | SessionHeaderEvent
    | TurnStartEvent
    | TurnEndEvent
    | UserMessageEvent
    | AssistantStartEvent
    | AssistantChunkEvent
    | AssistantDoneEvent
    | ToolCallEvent
    | ToolResultEvent
    | FlowStartEvent
    | FlowStepEvent
    | FlowEndEvent
    | FlowResumedEvent
    | PlanUpdateEvent
    | GoalUpdateEvent
    | PlanHintEvent
    | TodoWriteEvent
    | PromptSupplementChangedEvent
    | TaskUpdateEvent
    | ContextInjectEvent
    | EventReactionJournalEvent
    | ApprovalAskedEvent
    | ApprovalDecidedEvent
    | ReviewAskedEvent
    | ReviewDecidedEvent
    | UserAskedEvent
    | UserAnsweredEvent
    | UserSteeringEvent
    | FlowCompletionReviewEvent
    | ForkPointEvent
    | ArchivePointerEvent
    | AppearanceChangedEvent
    | LifeTickEvent
    | LifeHeartbeatEvent
    | LifeDecisionEvent
    | MemoryRetrievedEvent
    | MemoryAppliedEvent
    | MemoryDreamEvent
    | MemoryMigratedEvent
    | MemoryRevisedEvent

/** Everything that identifies an event except the store-assigned sequence. */
export type JournalEventInput = DistributiveOmit<JournalEvent, 'seq'>

// NOTICE:
// `Omit` does not distribute over unions in TypeScript, so a plain
// `Omit<JournalEvent, 'seq'>` collapses to the intersection of all variants
// and rejects every single-variant literal. The distributive conditional
// keeps per-variant field sets.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
