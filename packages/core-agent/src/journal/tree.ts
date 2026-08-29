import type { JournalEvent } from './types'

/**
 * Journal branching (CODING-HARNESS-DESIGN §4.4 `fork/point`).
 *
 * A fork keeps the parent's event prefix, then appends one `fork/point`
 * event naming the branch and its parent seq. A branch store built from the
 * result continues numbering from the fork point, so replaying any branch
 * reproduces exactly the events that branch's model saw.
 */
import { createJournalStore, journalFromJSONL, journalToJSONL } from './store'

export interface JournalBranch {
  branchId: string
  parentSeq: number
  /** The fork/point event itself, as recorded in the branch. */
  forkEvent: Extract<JournalEvent, { type: 'fork/point' }>
  /** Parent prefix (0..parentSeq) plus the fork event. */
  events: JournalEvent[]
}

export interface CreateBranchOptions {
  branchId?: string
}

/**
 * Forks `events` at `atSeq`. The new branch contains
 * `events[0..atSeq]` plus one `fork/point` record; the parent's journal is
 * never touched. `atSeq` must point at an existing event.
 */
export function createBranch(events: JournalEvent[], atSeq: number, options: CreateBranchOptions = {}): JournalBranch {
  if (atSeq < 0 || atSeq >= events.length)
    throw new Error(`journal: cannot fork at seq ${atSeq} of ${events.length} events`)
  const branchId = options.branchId ?? `branch-${atSeq}-${events.length}`
  const forkEvent: JournalBranch['forkEvent'] = {
    type: 'fork/point',
    seq: atSeq + 1,
    branchId,
    parentSeq: atSeq,
  }
  return {
    branchId,
    parentSeq: atSeq,
    forkEvent,
    events: [...events.slice(0, atSeq + 1), forkEvent],
  }
}

/** Builds a live store on top of a branch, continuing seq from the fork. */
export function createBranchStore(branch: JournalBranch): ReturnType<typeof createJournalStore> {
  const header = branch.events[0]
  if (header?.type !== 'session/header')
    throw new Error('journal: branch must start with a session/header')

  return createJournalStore(branch.branchId, {
    initialEvents: branch.events,
    initialSessionId: header.sessionId,
  })
}

/**
 * Serializes a branch as JSONL, header included, so it stays
 * self-describing (session id, agent preset, delegation depth).
 */
export function serializeBranch(branch: JournalBranch): string {
  return journalToJSONL(branch.events)
}

/**
 * Parses a serialized branch. Returns `null` (never throws) when the payload
 * lacks a session header or a valid fork/point — the error surfaces at the
 * caller as a broken branch, not a crash.
 */
export function deserializeBranch(text: string): JournalBranch | null {
  let events: JournalEvent[]
  try {
    events = journalFromJSONL(text)
  }
  catch {
    return null
  }
  const forkEvent = events.find((event): event is Extract<JournalEvent, { type: 'fork/point' }> => event.type === 'fork/point')
  if (!forkEvent)
    return null
  return {
    branchId: forkEvent.branchId,
    parentSeq: forkEvent.parentSeq,
    forkEvent,
    events,
  }
}
