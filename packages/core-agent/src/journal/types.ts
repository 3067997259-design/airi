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
  'user/message',
  'assistant/start',
  'assistant/chunk',
  'assistant/done',
  'tool/call',
  'tool/result',
  'plan/update',
  'task/update',
  'context/inject',
  'event/reaction',
  'approval/asked',
  'approval/decided',
  'review/asked',
  'review/decided',
  'fork/point',
  'archived/pointer',
  'appearance/changed',
  'life/tick',
] as const

export type JournalEventType = (typeof JOURNAL_EVENT_TYPES)[number]

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
  status?: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped' | 'blocked'
  reason?: string
}

export interface TaskUpdateEvent {
  type: 'task/update'
  seq: number
  taskId: string
  /** Full replace-self TaskMemory snapshot; the Nth update replaces the N-1th. */
  memory: Record<string, unknown>
  logRef?: string
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
  riskLevel?: 'low' | 'medium' | 'high'
  reason: string
  /** The concrete thing awaiting approval (e.g. the bash command line). */
  subject?: string
}

export interface ApprovalDecidedEvent {
  type: 'approval/decided'
  seq: number
  requestId: string
  decision: 'allowed-once' | 'rejected' | 'cancelled'
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
  timestamp: number
}

export type JournalEvent
  = | SessionHeaderEvent
    | UserMessageEvent
    | AssistantStartEvent
    | AssistantChunkEvent
    | AssistantDoneEvent
    | ToolCallEvent
    | ToolResultEvent
    | PlanUpdateEvent
    | TaskUpdateEvent
    | ContextInjectEvent
    | EventReactionJournalEvent
    | ApprovalAskedEvent
    | ApprovalDecidedEvent
    | ReviewAskedEvent
    | ReviewDecidedEvent
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
