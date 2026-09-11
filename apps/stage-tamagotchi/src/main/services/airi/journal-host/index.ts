/**
 * Journal persistence host (HARNESS-PLAN §9.1).
 *
 * The runtime journal was in-memory and inert: `journalToJSONL` existed with
 * no caller, so "restart and continue" was a design intention, not a running
 * fact. This service is the durable owner — one append-only JSONL file per
 * session under `<userData>/journal`, written by the leader renderer and read
 * back on the next start.
 *
 * Bounded on purpose: a read returns the newest events up to a cap, because a
 * replay exists to restore state, not to re-inflate a whole history into a
 * renderer.
 */
import type { createContext as createMainEventaContext } from '@moeru/eventa/adapters/electron/main'

import { createHash } from 'node:crypto'
import { appendFile, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { defineInvokeHandler } from '@moeru/eventa'
import { Mutex } from 'async-mutex'

import { journalHostAppend, journalHostClear, journalHostExport, journalHostRead } from '../../../../shared/eventa'

const JOURNAL_DIRECTORY = 'journal'

/**
 * Events a replay returns; older events stay on disk for inspection.
 *
 * The cap exists so one giant session cannot re-inflate a whole history into a
 * renderer, not as a durability limit — the renderer surfaces `truncated` when
 * it fires.
 */
const DEFAULT_REPLAY_LIMIT = 50_000

/**
 * Persisted sequence IDs for a session, plus the highest ID observed.
 *
 * The append dedup relies on the ID set: a renderer retry after a lost IPC
 * receipt re-sends lines the host already wrote, and every line carries the
 * event's `seq`, so an existing ID is skipped while a missing ID can still
 * fill a legacy gap. `lastSeq` is retained for diagnostics and gap reporting.
 */

function parseSeq(line: string): number | undefined {
  try {
    const seq = (JSON.parse(line) as { seq?: unknown }).seq
    return typeof seq === 'number' && Number.isInteger(seq) ? seq : undefined
  }
  catch {
    return undefined
  }
}

/**
 * Content fingerprint of one persisted line.
 *
 * A renderer retry re-sends lines whose seq the host already holds; only an
 * identical line is a safe duplicate to skip. The same seq with different
 * content means the renderer appended without replaying the file first, and
 * treating that as a duplicate silently discarded the run
 * (R04-adoption, 2026-09-10).
 */
function lineFingerprint(line: string): string {
  return createHash('sha256').update(line).digest('hex')
}

interface SessionFileAnalysis {
  lastSeq: number
  gaps: number[]
  corruptLines: number
  duplicateLines: number
  totalLines: number
  /** seq -> line fingerprint for every unique seq present in the file. */
  seqFingerprints: Map<number, string>
}

/** Reads a session file and reports its seq structure without rewriting it. */
async function analyzeSessionFile(directory: string, sessionId: string): Promise<SessionFileAnalysis> {
  let raw: string
  try {
    raw = await readFile(join(directory, sessionFileName(sessionId)), 'utf8')
  }
  catch {
    // No file means no history for this session, which is the normal state of
    // a new session rather than a failure to report.
    return { lastSeq: -1, gaps: [], corruptLines: 0, duplicateLines: 0, totalLines: 0, seqFingerprints: new Map() }
  }

  const lines = raw.split('\n').filter(line => line.trim().length > 0)
  const fingerprints = new Map<number, string>()
  let corruptLines = 0
  let duplicateLines = 0
  for (const line of lines) {
    const seq = parseSeq(line)
    if (seq === undefined) {
      corruptLines += 1
      continue
    }
    if (fingerprints.has(seq)) {
      duplicateLines += 1
      continue
    }
    fingerprints.set(seq, lineFingerprint(line))
  }

  const seqs = [...fingerprints.keys()]
  const maxSeq = seqs.length > 0 ? Math.max(...seqs) : -1
  const minSeq = seqs.length > 0 ? Math.min(...seqs) : -1
  const gaps: number[] = []
  for (let seq = minSeq; seq <= maxSeq; seq++) {
    if (!fingerprints.has(seq))
      gaps.push(seq)
  }

  // `lastSeq` is the contiguous run from the file's first seq, so a legacy gap
  // does not make the dedup reject the renderer's new events, which resume at
  // the hole. Runs start at the file's own minimum (not 0): files written
  // before the header was persisted begin at seq 1 and are still intact.
  const firstGap = gaps[0]
  const lastSeq = firstGap === undefined ? maxSeq : firstGap - 1
  return { lastSeq, gaps, corruptLines, duplicateLines, totalLines: lines.length, seqFingerprints: fingerprints }
}

export interface JournalHostOptions {
  /** Overrides the journal directory; defaults to `<userData>/journal`. */
  directory?: string
  /** File append boundary, replaceable for deterministic write-failure checks. */
  appendFile?: typeof appendFile
}

/**
 * Maps a session id to a file name.
 *
 * Session ids come from chat sessions and can hold characters no filesystem
 * accepts, so the name is a hash. The id itself is inside every line, which is
 * where a human looks anyway.
 */
function sessionFileName(sessionId: string): string {
  return `${createHash('sha256').update(sessionId).digest('hex').slice(0, 32)}.jsonl`
}

export async function setupJournalHost(
  context: ReturnType<typeof createMainEventaContext>['context'],
  options: JournalHostOptions = {},
  userDataDir = '',
): Promise<void> {
  const directory = options.directory ?? join(userDataDir, JOURNAL_DIRECTORY)
  const appendJournalFile = options.appendFile ?? appendFile
  await mkdir(directory, { recursive: true })
  // The persisted sequence map belongs to this profile. File IO and cache
  // transitions run together so concurrent retries, clears and exports cannot
  // observe half a write or inherit a different profile's sequence numbers.
  // A map is required instead of only a contiguous watermark: a damaged file
  // may contain seq 1 and 3 while a later retry legitimately fills seq 2, and
  // the fingerprint distinguishes a retry from a conflicting reuse of a seq.
  const persistedSeqsBySession = new Map<string, Map<number, string>>()
  const mutex = new Mutex()

  defineInvokeHandler(context, journalHostAppend, async ({ sessionId, lines }) => mutex.runExclusive(async () => {
    if (lines.length === 0)
      return { appended: 0, skipped: 0 }

    let persistedSeqs = persistedSeqsBySession.get(sessionId)
    if (persistedSeqs === undefined) {
      persistedSeqs = (await analyzeSessionFile(directory, sessionId)).seqFingerprints
      persistedSeqsBySession.set(sessionId, persistedSeqs)
    }

    // One append per batch: the renderer batches a turn's events, and a write
    // per event would turn a tool loop into a disk-bound loop.
    const accepted: string[] = []
    const acceptedSeqs = new Map<number, string>()
    let skipped = 0
    for (const line of lines) {
      const seq = parseSeq(line)
      // Unsequenced lines cannot be deduplicated; write them rather than drop
      // data on the floor.
      if (seq === undefined) {
        accepted.push(line)
        continue
      }
      const fingerprint = lineFingerprint(line)
      const existing = persistedSeqs.get(seq) ?? acceptedSeqs.get(seq)
      if (existing !== undefined) {
        if (existing === fingerprint) {
          skipped += 1
          continue
        }
        // The same seq with different content is not a retry. Continuing would
        // either overwrite history or silently discard the renderer's run; the
        // renderer must replay the file before it appends (R04-adoption).
        throw new Error(`journal sequence conflict at seq ${seq}: the renderer appended without replaying the persisted session`)
      }
      accepted.push(line)
      acceptedSeqs.set(seq, fingerprint)
    }

    if (accepted.length > 0) {
      try {
        await appendJournalFile(join(directory, sessionFileName(sessionId)), `${accepted.join('\n')}\n`, 'utf8')
      }
      catch (error) {
        // The filesystem may have appended bytes before the IPC call failed.
        // Re-scan on the next attempt so a lost receipt cannot duplicate or
        // swallow the lines that actually reached disk.
        persistedSeqsBySession.delete(sessionId)
        throw error
      }
      for (const [seq, fingerprint] of acceptedSeqs)
        persistedSeqs.set(seq, fingerprint)
    }
    return { appended: accepted.length, skipped }
  }))

  defineInvokeHandler(context, journalHostRead, async ({ sessionId, limit }) => mutex.runExclusive(async () => {
    const analysis = await analyzeSessionFile(directory, sessionId)
    if (analysis.totalLines === 0)
      return { lines: [], truncated: false, lastSeq: -1, gaps: [], corruptLines: 0, duplicateLines: 0 }

    const raw = await readFile(join(directory, sessionFileName(sessionId)), 'utf8')
    const lines = raw.split('\n').filter(line => line.trim().length > 0)
    const cap = Math.max(1, Math.floor(limit ?? DEFAULT_REPLAY_LIMIT))
    return {
      lines: lines.slice(-cap),
      truncated: lines.length > cap,
      lastSeq: analysis.lastSeq,
      gaps: analysis.gaps,
      corruptLines: analysis.corruptLines,
      duplicateLines: analysis.duplicateLines,
    }
  }))

  defineInvokeHandler(context, journalHostClear, async ({ sessionId }) => mutex.runExclusive(async () => {
    await rm(join(directory, sessionFileName(sessionId)), { force: true })
    // The dedup sequence set belongs to the deleted file; a fresh session must
    // not inherit it.
    persistedSeqsBySession.delete(sessionId)
    return { cleared: true }
  }))

  defineInvokeHandler(context, journalHostExport, async () => mutex.runExclusive(async () => {
    const files: Array<{ name: string, content: string }> = []
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isFile() && /^[a-f0-9]{32}\.jsonl$/.test(entry.name))
        files.push({ name: entry.name, content: await readFile(join(directory, entry.name), 'utf8') })
    }
    return { files }
  }))
}
