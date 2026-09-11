import { createPinia, disposePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, toRaw } from 'vue'
import { createI18n } from 'vue-i18n'

import { chatSessionsRepo } from '../database/repos/chat-sessions.repo'
import { createDataBackup } from '../services/data-backup'
import { beginRestoreGate, completeRestoreGate, isRestoreActive, releaseRestoreEffectHold } from '../services/restore-gate'
import { useLlmToolsStore } from './ai/chat-llm/tools'
import { useChatSessionStore } from './chat/session-store'
import { useDataBackupStore } from './data-backup'
import { useJournalStore } from './journal'
import { useAiriCardStore } from './modules/airi-card'
import { useConsciousnessSettingsStore } from './modules/consciousness-settings'
import { useLifeModeStore } from './modules/life-mode'
import { useMemoryStore } from './modules/memory'
import { OPENCODE_ADAPTER_SKELETON, useSkillsReviewStore } from './skills'

const database = vi.hoisted(() => ({
  db: { value: null },
  getDb: vi.fn(async () => undefined),
  importSnapshot: vi.fn(async () => undefined),
}))

vi.mock('../composables/use-duck-db', () => ({ useDuckDb: () => database }))

const cleanup: Array<() => void> = []
const pending: Promise<void>[] = []

afterEach(async () => {
  completeRestoreGate()
  await Promise.allSettled(pending.splice(0))
  cleanup.splice(0).reverse().forEach(dispose => dispose())
  await chatSessionsRepo.clear('local')
  localStorage.clear()
})

describe('profile restore owners', () => {
  it('finishes import behind the startup gate and preserves the selected chat', async () => {
    // ROOT CAUSE:
    // Import awaited memory.initialize(), which awaited the startup gate.
    // The coordinator could release that gate only after import returned.
    // Import must restore durable data before normal owner initialization.
    beginRestoreGate()
    const pinia = createPinia()
    let backup!: ReturnType<typeof useDataBackupStore>
    const app = createApp({
      setup() {
        backup = useDataBackupStore()
        return () => null
      },
    })
    app.use(pinia)
    app.use(createI18n({ legacy: false, locale: 'en', messages: { en: {} }, missingWarn: false, fallbackWarn: false }))
    app.mount(document.createElement('div'))
    cleanup.push(() => disposePinia(pinia), () => app.unmount())

    const card = {
      name: 'Restored character',
      version: '1',
      extensions: { airi: { modules: {
        consciousness: { provider: '', model: '' },
        vision: { provider: '', model: '' },
        speech: { provider: '', model: '', voice_id: '' },
      }, agents: {} } },
    }
    const meta = { sessionId: 'restored-session', userId: 'local', characterId: 'restored-card', createdAt: 1, updatedAt: 2 }
    const chats = {
      format: 'chat-sessions-index:v1',
      index: { userId: 'local', characters: { 'restored-card': { activeSessionId: meta.sessionId, sessions: { [meta.sessionId]: meta } } } },
      sessions: { [meta.sessionId]: { meta, messages: [{ role: 'user', content: 'Remember this actual conversation.' }] } },
    }
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
    const skill = {
      ...OPENCODE_ADAPTER_SKELETON,
      trust: 'reviewed',
      reviewedHash: OPENCODE_ADAPTER_SKELETON.contentHash,
      review: { reviewer: 'user', rationale: 'Existing reviewed revision', reviewedAt: 1 },
    }
    const data = await createDataBackup({
      snapshotId: 'restore-owners',
      buildId: 'test',
      createdAt: 1,
      coverage: ['identity', 'chats', 'plans', 'skills', 'memory', 'outbox'],
      missing: [],
      prerequisites: [],
      entries: [
        { path: 'identity/cards.json', domain: 'identity', data: bytes({ userId: 'local', activeCardId: 'restored-card', cards: [['restored-card', card]] }) },
        { path: 'identity/settings.json', domain: 'identity', data: bytes([
          ['settings/memory/compaction-threshold', '0.91'],
          ['settings/consciousness/reasoning', 'true'],
          ['settings/consciousness/reasoning-effort', 'high'],
        ]) },
        { path: 'chats/sessions.json', domain: 'chats', data: bytes(chats) },
        { path: 'plans/plans.json', domain: 'plans', data: bytes([]) },
        { path: 'skills/registry.json', domain: 'skills', data: bytes([skill]) },
        { path: 'outbox/held.json', domain: 'outbox', data: bytes({ userId: 'local', memory: [], chat: [], tombstones: [] }) },
        ...['memory_fragments', 'memory_tags', 'memory_episodic', 'memory_long_term_goals', 'memory_short_term_ideas'].map(table => ({
          path: `memory/${table}.parquet`,
          domain: 'memory' as const,
          data: new Uint8Array(),
        })),
      ],
    })
    let imported = false
    const importing = backup.importSnapshot(data, { staged: true }).then(() => {
      imported = true
    })
    pending.push(importing.catch(() => {}))
    await vi.waitFor(() => expect(imported).toBe(true), { timeout: 1500 })
    await importing
    expect(isRestoreActive()).toBe(true)
    expect(database.importSnapshot).toHaveBeenCalledOnce()
    expect(useAiriCardStore(pinia).activeCardId).toBe('restored-card')
    expect(useChatSessionStore(pinia).activeSessionId).toBe(meta.sessionId)
    expect(await chatSessionsRepo.getIndex('local')).toEqual(chats.index)
    expect(await chatSessionsRepo.getSession(meta.sessionId)).toEqual(chats.sessions[meta.sessionId])
    expect(useLlmToolsStore(pinia).tools).toHaveLength(0)
    expect(useSkillsReviewStore(pinia).queue[0]?.reviewedHash).toBe(skill.reviewedHash)
    expect(useMemoryStore(pinia).compactionThreshold).toBe(0.91)
    expect(useConsciousnessSettingsStore(pinia).reasoning).toBe(true)
    expect(useConsciousnessSettingsStore(pinia).reasoningEffort).toBe('high')
    completeRestoreGate(true)
    const journal = useJournalStore(pinia)
    const eventsBeforeHeartbeat = structuredClone(toRaw(journal.events))
    await useLifeModeStore(pinia).onLifeHeartbeat({ heartbeatId: 'restored-heartbeat', reason: 'schedule', timestamp: Date.now() })
    expect(journal.events).toEqual(eventsBeforeHeartbeat)
    releaseRestoreEffectHold()
    await useSkillsReviewStore(pinia).restore()
    expect(useLlmToolsStore(pinia).tools).toHaveLength(1)
  })
})
