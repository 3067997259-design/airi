import type { DataBackupDomain, DataBackupEntry } from '../services/data-backup'

import { defineStore } from 'pinia'
import { toRaw } from 'vue'

import { useDuckDb } from '../composables/use-duck-db'
import { chatSessionsRepo } from '../database/repos/chat-sessions.repo'
import { createDataBackup, inspectDataBackup } from '../services/data-backup'
import { backupSettingsKeys, checkRestoreData } from '../services/data-restore'
import { releaseRestoreEffectHold } from '../services/restore-gate'
import { profileSnapshotBarrier } from '../services/snapshot-barrier'
import { useAuthStore } from './auth'
import { useChatStore } from './chat'
import { useChatSessionStore } from './chat/session-store'
import { useJournalStore } from './journal'
import { useAiriCardStore } from './modules/airi-card'
import { useConsciousnessSettingsStore } from './modules/consciousness-settings'
import { useMemoryStore } from './modules/memory'
import { usePlanStore } from './plans'
import { OPENCODE_ADAPTER_SKELETON, useSkillsReviewStore } from './skills'

/** Shell-owned IO. A skill path is always relative to its recorded workspace. */
export interface DataBackupPort {
  buildId: () => Promise<string>
  readArtifact: (path: string, workspaceRoot: string) => Promise<string>
  stageRestore?: (data: Uint8Array) => Promise<string>
  relaunchRestore?: (profilePath: string) => Promise<void>
  adoptRestore?: () => Promise<void>
  /**
   * Reads approved package versions and the approval registry (EP-2a). The
   * paths already use the `packages/...` domain layout. Absent in builds
   * without the package host; coverage then omits the domain.
   */
  readPackageEntries?: () => Promise<Array<{ path: string, data: Uint8Array }>>
}

let port: DataBackupPort | undefined

/** Installs the desktop boundary before backup actions become available. */
export function installDataBackupPort(next: DataBackupPort): void {
  port = next
}

/** Captures business data through the elected leader and the existing owners. */
export const useDataBackupStore = defineStore('data-backup', () => {
  const chat = useChatStore()
  const sessions = useChatSessionStore()
  const memory = useMemoryStore()
  const consciousnessSettings = useConsciousnessSettingsStore()
  const journal = useJournalStore()
  const skills = useSkillsReviewStore()
  const cards = useAiriCardStore()
  const auth = useAuthStore()
  const plans = usePlanStore()

  /**
   * Returns a ZIP plus explicit omissions. Delivery queues are archival data;
   * the restore path must keep them held until a user reconciles the account.
   */
  async function exportSnapshot(): Promise<Uint8Array> {
    if (!port)
      throw new Error('The desktop backup port is unavailable.')
    if (chat.sending || Object.values(chat.flowStates).some(flow => flow.status === 'running') || memory.dreaming)
      throw new Error('Finish current chat, Flow and dreaming work before exporting.')
    if (!sessions.isReady)
      await sessions.initialize()
    await useDuckDb().getDb()
    const buildId = await port.buildId()

    return profileSnapshotBarrier.capture(async () => {
      const entries: DataBackupEntry[] = []
      const missing = ['Display model assets and remote-only PostgreSQL records are not included.']
      const sourceState = () => JSON.stringify({
        skills: skills.queue,
        cards: [...cards.cards],
        activeCardId: cards.activeCardId,
        outbox: memory.longTermSyncOutbox,
        embedding: memory.embeddingMigration,
      })
      const before = sourceState()
      const addJson = (path: string, domain: DataBackupEntry['domain'], data: unknown) => {
        entries.push({ path, domain, data: new TextEncoder().encode(JSON.stringify(data)) })
      }
      const archives = await journal.exportSnapshot()
      for (const file of archives.files)
        entries.push({ path: `journal/${file.name}`, domain: 'journal', data: new TextEncoder().encode(file.content) })
      entries.push(...await useDuckDb().exportSnapshot())
      addJson('chats/sessions.json', 'chats', await sessions.exportSessions())
      addJson('plans/plans.json', 'plans', toRaw(plans.plans))
      addJson('identity/cards.json', 'identity', { cards: [...toRaw(cards.cards).entries()], activeCardId: cards.activeCardId, userId: auth.userId })
      if (typeof localStorage === 'undefined')
        throw new Error('Browser storage is unavailable for settings export.')
      addJson('identity/settings.json', 'identity', backupSettingsKeys
        .map(key => [key, localStorage.getItem(key)] as [string, string | null])
        .filter((entry): entry is [string, string] => entry[1] !== null))
      addJson('skills/registry.json', 'skills', toRaw(skills.queue))
      addJson('outbox/held.json', 'outbox', {
        userId: auth.userId,
        memory: toRaw(memory.longTermSyncOutbox),
        chat: await chatSessionsRepo.getOutbox(auth.userId),
        tombstones: await chatSessionsRepo.getTombstones(auth.userId),
      })
      for (const entry of skills.queue) {
        if (entry.toolId === OPENCODE_ADAPTER_SKELETON.toolId && entry.contentHash === OPENCODE_ADAPTER_SKELETON.contentHash)
          continue
        if (!entry.workspaceRoot)
          throw new Error(`Skill ${entry.toolId} has no recorded workspace.`)
        const names = ['source.mjs', 'meta.json', ...(entry.selftest ? ['selftest.mjs'] : [])]
        for (const name of names) {
          const path = `skills/${entry.toolId}/${name}`
          const content = await port!.readArtifact(path, entry.workspaceRoot)
          entries.push({ path, domain: 'skills', data: new TextEncoder().encode(content) })
        }
      }
      const coverage: DataBackupDomain[] = ['memory', 'plans', 'journal', 'skills', 'chats', 'identity', 'outbox']
      const readPackageEntries = port!.readPackageEntries
      if (readPackageEntries) {
        for (const entry of await readPackageEntries())
          entries.push({ path: entry.path, domain: 'packages', data: entry.data })
        coverage.push('packages')
      }
      if (before !== sourceState())
        throw new Error('Profile state changed during the snapshot. Export again when all owners are idle.')
      return createDataBackup({
        snapshotId: crypto.randomUUID(),
        createdAt: Date.now(),
        buildId,
        coverage,
        missing,
        prerequisites: ['Configure provider credentials separately.', 'Keep outbox delivery and goal scheduling paused.', 'Recheck skill artifacts and embedding source before use.'],
        entries,
      })
    })
  }

  /** Imports a validated archive into an empty isolated browser profile. */
  async function importSnapshot(data: Uint8Array, options: { staged?: boolean } = {}): Promise<void> {
    if (!options.staged && port?.stageRestore && port.relaunchRestore) {
      const profilePath = await port.stageRestore(data)
      await port.relaunchRestore(profilePath)
      return
    }
    const inspected = await inspectDataBackup(data)
    const restored = checkRestoreData(inspected)
    // Session import selects the active character. Restore that identity first
    // so the chat owner does not create a replacement session for the old card.
    cards.cards.clear()
    for (const [id, card] of restored.identity.cards)
      cards.cards.set(id, card)
    cards.activeCardId = restored.identity.activeCardId
    await sessions.importSessions(restored.chats)
    if (Array.isArray(restored.plans))
      plans.plans = restored.plans as typeof plans.plans
    await skills.restoreQueue(restored.skills)
    memory.longTermSyncOutbox = restored.outbox.memory as typeof memory.longTermSyncOutbox
    await chatSessionsRepo.restoreOutbox(auth.userId, restored.outbox.chat, restored.outbox.tombstones)
    if (typeof localStorage !== 'undefined') {
      for (const [key, value] of restored.settings)
        localStorage.setItem(key, value)
    }
    memory.restorePersistedSettings()
    consciousnessSettings.restorePersistedSettings()
    await useDuckDb().importSnapshot(inspected.entries.filter(entry => entry.domain === 'memory'))
    // Runtime initialization belongs to normal boot after the durable receipt.
    // Memory startup waits for that receipt; card startup resolves UI modules.
    // Neither can be awaited by the import that the coordinator must finish.
  }

  /** Persists the user's decision to resume external effects in a restored profile. */
  async function adoptRestoredProfile(): Promise<void> {
    if (!port?.adoptRestore)
      throw new Error('The desktop restore adoption port is unavailable.')
    await port.adoptRestore()
    releaseRestoreEffectHold()
  }

  return { exportSnapshot, importSnapshot, adoptRestoredProfile }
}, { synced: { state: false, actions: ['exportSnapshot'] } })
