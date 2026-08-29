/**
 * Append-only journal store (CODING-HARNESS-DESIGN §4.4).
 *
 * Invariants, all enforced here so projections can trust them:
 *
 * - The first event is a `session/header` and there is exactly one.
 * - `events[i].seq === i` for every stored event (matching dsh's session
 *   JSONL continuity rule).
 * - Nothing is ever deleted or rewritten; archive only adds a pointer event.
 *
 * The store is in-memory and inert by design: file persistence and zstd
 * framing belong to the wiring layer, which can serialize with
 * `journalToJSONL` / `journalFromJSONL` on its own schedule.
 */
import type { JournalEvent, JournalEventInput } from './types'

export interface JournalStore {
  readonly sessionId: string
  readonly nextSeq: number
  readonly size: number
  append: (event: JournalEventInput) => JournalEvent
  readAll: () => JournalEvent[]
  readSince: (afterSeq: number) => JournalEvent[]
}

export interface JournalStoreOptions {
  /** Pre-seeded events; a fork's branch events are the typical use. */
  initialEvents?: JournalEvent[]
  /**
   * Session id expected in a seeded header.
   *
   * Branch stores keep the parent session header for replay while their live
   * store uses the branch id. Ordinary stores should leave this unset.
   */
  initialSessionId?: string
}

export function createJournalStore(sessionId: string, options: JournalStoreOptions = {}): JournalStore {
  const events: JournalEvent[] = []

  // NOTICE:
  // Seeding runs through the same validation as appends so a malformed
  // branch can never produce a store with broken seq continuity.
  for (const event of options.initialEvents ?? []) {
    validateSeededEvent(event, events, options.initialSessionId ?? sessionId)
    events.push(structuredClone(event))
  }

  return {
    sessionId,
    get size() {
      return events.length
    },
    get nextSeq() {
      return events.length
    },
    append(event: JournalEventInput): JournalEvent {
      const record = { ...structuredClone(event), seq: events.length } as JournalEvent

      if (record.type === 'session/header') {
        if (events.length !== 0)
          throw new Error('journal: session/header must be the first event')
        if (record.seq !== 0)
          throw new Error('journal: session/header seq must be 0')
        if (record.sessionId !== sessionId)
          throw new Error(`journal: session/header sessionId ${record.sessionId} does not match store ${sessionId}`)
      }
      else if (events.length === 0) {
        throw new Error('journal: first event must be session/header')
      }

      events.push(record)
      return structuredClone(record)
    },
    readAll() {
      return structuredClone(events)
    },
    readSince(afterSeq: number) {
      if (afterSeq < 0 || afterSeq >= events.length)
        return []
      return structuredClone(events.slice(afterSeq + 1))
    },
  }
}

function validateSeededEvent(event: JournalEvent, already: JournalEvent[], sessionId: string): void {
  if (event.seq !== already.length)
    throw new Error(`journal: seeded event seq ${event.seq} breaks continuity (expected ${already.length})`)
  if (event.type === 'session/header' && already.length !== 0)
    throw new Error('journal: session/header must be the first event')
  if (already.length === 0 && event.type !== 'session/header')
    throw new Error('journal: first event must be session/header')
  if (event.type === 'session/header' && event.sessionId !== sessionId)
    throw new Error(`journal: session/header sessionId ${event.sessionId} does not match store ${sessionId}`)
}

/** Serializes events to JSONL; each event is one line, seq order preserved. */
export function journalToJSONL(events: JournalEvent[]): string {
  return events.map(event => JSON.stringify(event)).join('\n')
}

/**
 * Parses JSONL back into events, validating the two store invariants:
 * header first and seq continuity.
 */
export function journalFromJSONL(text: string): JournalEvent[] {
  const lines = text.split('\n').filter(line => line.trim().length > 0)
  const events: JournalEvent[] = []

  for (let i = 0; i < lines.length; i++) {
    let event: JournalEvent
    try {
      event = JSON.parse(lines[i]!) as JournalEvent
    }
    catch {
      throw new Error(`journal: line ${i} is not valid JSON`)
    }
    if (event.type !== 'session/header' && i === 0)
      throw new Error('journal: first event must be session/header')
    if (event.type === 'session/header' && i !== 0)
      throw new Error('journal: session/header must be the first event')
    if (event.seq !== i)
      throw new Error(`journal: seq ${event.seq} breaks continuity at line ${i}`)
    events.push(event)
  }

  return events
}
