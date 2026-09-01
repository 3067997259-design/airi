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
  'plan/update',
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
  'fork/point',
  'archived/pointer',
  'appearance/changed',
  'life/tick',
] as const

export type JournalEventType = (typeof JOURNAL_EVENT_TYPES)[number]

export type TurnEndReason = 'completed' | 'aborted' | 'steered' | 'max-steps' | 'error'

export interface TurnStartEvent {
  type: 'turn/start'
  seq: number
  turnId: string
  source: 'text' | 'voice' | 'self-initiative' | 'btw'
  timestamp: number
  planId?: string
  maxSteps: number
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
}

export interface ToolResultEvent {
  type: 'tool/result'
  seq: number
  toolName: string
  ok: boolean
  summary: string
  /** Serialized evidence provenance (author bucketing), set by the caller. */
  provenance?: string
  /** Plan step this result belongs to; drives the verification gate. */
  stepId?: string
  /** Plan that owns the step when more than one plan is active. */
  planId?: string
}

export interface PlanUpdateEvent {
  type: 'plan/update'
  seq: number
  planId?: string
  stepId?: string
  status?: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped' | 'blocked' | 'paused'
  reason?: string
  /**
   * Set on model-declared completions that the evidence gate did not verify.
   * The projection surfaces these as unverified (amber) instead of blocking,
   * and `human_approval` steps can never carry it.
   */
  unverified?: boolean
}

export interface TaskUpdateEvent {
  type: 'task/update'
  seq: number
  taskId: string
  /** Full replace-self TaskMemory snapshot; the Nth update replaces the N-1th. */
  memory: Record<string, unknown>
  logRef?: string
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
}

export interface UserAnsweredEvent {
  type: 'user/answered'
  seq: number
  requestId: string
  answer: string
  channel?: 'choice' | 'text' | 'dismissed'
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
    | PlanUpdateEvent
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
    | ForkPointEvent
    | ArchivePointerEvent
    | AppearanceChangedEvent
    | LifeTickEvent

/** Everything that identifies an event except the store-assigned sequence. */
export type JournalEventInput = DistributiveOmit<JournalEvent, 'seq'>

// NOTICE:
// `Omit` does not distribute over unions in TypeScript, so a plain
// `Omit<JournalEvent, 'seq'>` collapses to the intersection of all variants
// and rejects every single-variant literal. The distributive conditional
// keeps per-variant field sets.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
