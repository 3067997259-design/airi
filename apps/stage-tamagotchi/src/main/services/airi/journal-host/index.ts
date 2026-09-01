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
import { appendFile, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { defineInvokeHandler } from '@moeru/eventa'

import { journalHostAppend, journalHostClear, journalHostRead } from '../../../../shared/eventa'

const JOURNAL_DIRECTORY = 'journal'

/** Events a replay returns; older events stay on disk for inspection. */
const DEFAULT_REPLAY_LIMIT = 2_000

export interface JournalHostOptions {
  /** Overrides the journal directory; defaults to `<userData>/journal`. */
  directory?: string
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
  await mkdir(directory, { recursive: true })

  defineInvokeHandler(context, journalHostAppend, async ({ sessionId, lines }) => {
    if (lines.length === 0)
      return { appended: 0 }

    // One append per batch: the renderer batches a turn's events, and a write
    // per event would turn a tool loop into a disk-bound loop.
    await appendFile(join(directory, sessionFileName(sessionId)), `${lines.join('\n')}\n`, 'utf8')
    return { appended: lines.length }
  })

  defineInvokeHandler(context, journalHostRead, async ({ sessionId, limit }) => {
    try {
      const raw = await readFile(join(directory, sessionFileName(sessionId)), 'utf8')
      const lines = raw.split('\n').filter(line => line.trim().length > 0)
      const cap = Math.max(1, Math.floor(limit ?? DEFAULT_REPLAY_LIMIT))
      return { lines: lines.slice(-cap), truncated: lines.length > cap }
    }
    catch {
      // No file means no history for this session, which is the normal state
      // of a new session rather than a failure to report.
      return { lines: [], truncated: false }
    }
  })

  defineInvokeHandler(context, journalHostClear, async ({ sessionId }) => {
    await rm(join(directory, sessionFileName(sessionId)), { force: true })
    return { cleared: true }
  })
}
