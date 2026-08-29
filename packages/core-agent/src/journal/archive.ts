/**
 * Cold archive policy (CODING-HARNESS-DESIGN §4.4).
 *
 * The journal never deletes; archiving exports a closed session's raw log
 * and leaves an `archived/pointer` event behind. Everything here is pure
 * bookkeeping — the actual file export belongs to the wiring layer.
 */
import type { ArchivePointerEvent, JournalEvent } from './types'

export const DEFAULT_ARCHIVE_THRESHOLD_BYTES = 10 * 1024 * 1024

export interface ArchiveDecisionOptions {
  thresholdBytes?: number
  /** Only closed sessions are eligible; archives never touch live logs. */
  sessionClosed?: boolean
}

export interface ArchiveDecision {
  shouldArchive: boolean
  byteLength: number
  thresholdBytes: number
  reason: 'open_session' | 'under_threshold' | 'over_threshold'
}

/** Estimates serialized size: one JSON line per event, plus separators. */
export function estimateJournalBytes(events: JournalEvent[]): number {
  let total = 0
  for (const event of events)
    total += JSON.stringify(event).length + 1
  return total
}

export function shouldArchiveJournal(events: JournalEvent[], options: ArchiveDecisionOptions = {}): ArchiveDecision {
  const thresholdBytes = options.thresholdBytes ?? DEFAULT_ARCHIVE_THRESHOLD_BYTES
  const byteLength = estimateJournalBytes(events)

  if (!options.sessionClosed)
    return { shouldArchive: false, byteLength, thresholdBytes, reason: 'open_session' }
  if (byteLength <= thresholdBytes)
    return { shouldArchive: false, byteLength, thresholdBytes, reason: 'under_threshold' }
  return { shouldArchive: true, byteLength, thresholdBytes, reason: 'over_threshold' }
}

export interface CreateArchivePointerInput {
  archivePath: string
  startSeq: number
  endSeq: number
  byteLength: number
  archivedAt?: number
}

/** Builds the pointer event payload; the store assigns `seq` on append. */
export function createArchivePointer(input: CreateArchivePointerInput): Omit<ArchivePointerEvent, 'seq'> {
  return {
    type: 'archived/pointer',
    archivePath: input.archivePath,
    startSeq: input.startSeq,
    endSeq: input.endSeq,
    archivedAt: input.archivedAt ?? Date.now(),
    byteLength: input.byteLength,
  }
}
