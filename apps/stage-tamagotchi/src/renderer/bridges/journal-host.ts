import type { JournalPersistencePort } from '@proj-airi/stage-ui/stores/journal'

/**
 * Renderer client for the durable journal (HARNESS-PLAN §9.1).
 *
 * Thin facade over the main-process JSONL owner; the journal store stays the
 * in-memory source of truth and only mirrors through this port.
 */
import { defineInvoke } from '@moeru/eventa'
import { getElectronEventaContext } from '@proj-airi/electron-vueuse'

import { journalHostAppend, journalHostRead } from '../../shared/eventa'

export function createJournalHostClient(): JournalPersistencePort {
  const context = getElectronEventaContext()
  const append = defineInvoke(context, journalHostAppend)
  const read = defineInvoke(context, journalHostRead)

  return {
    append: async (sessionId, lines) => {
      await append({ sessionId, lines })
    },
    read: sessionId => read({ sessionId }),
  }
}
