import { defineInvoke } from '@moeru/eventa'
import { getElectronEventaContext } from '@proj-airi/electron-vueuse'
import { installAppearanceJournalPort } from '@proj-airi/stage-ui-live2d/stores/custom-parameters'
import { installExpressionJournalPort } from '@proj-airi/stage-ui-live2d/stores/expression-store'
/**
 * Installs the coding host bridge client for this renderer process.
 *
 * Called from renderer main before the app mounts; the stage-ui stores
 * (`useCodingToolsStore`, `useApprovalsStore`) then work from any window
 * (stage, settings, ...). The client shapes mirror the stage-ui port types
 * structurally — the shared Eventa contracts stay in the app shell.
 */
import { installLongGoalSchedulerPort } from '@proj-airi/stage-ui/services/long-goal-scheduler'
import { releaseRestoreEffectHold } from '@proj-airi/stage-ui/services/restore-gate'
import { installApprovalsBridge } from '@proj-airi/stage-ui/stores/approvals'
import { useAuthStore } from '@proj-airi/stage-ui/stores/auth'
import { installCodingHostClient, useCodingToolsStore } from '@proj-airi/stage-ui/stores/coding'
import { installDataBackupPort } from '@proj-airi/stage-ui/stores/data-backup'
import { installJournalPersistence, useJournalStore } from '@proj-airi/stage-ui/stores/journal'
import { useAiriCardStore } from '@proj-airi/stage-ui/stores/modules/airi-card'
import { installLifeModePort } from '@proj-airi/stage-ui/stores/modules/life-mode'
import { useLongGoalSchedulerStore } from '@proj-airi/stage-ui/stores/modules/long-goals'
import { installMemoryHostPort } from '@proj-airi/stage-ui/stores/modules/memory'
import { installSkillRuntime, useSkillsReviewStore } from '@proj-airi/stage-ui/stores/skills'
import { installFetchTextPort } from '@proj-airi/stage-ui/tools/fetch'

import { backupAdopt, backupAdopted, backupPrepare, backupRelaunch, backupSave, extensionPackagesExport } from '../../shared/eventa'
import { createCodingHostClient } from './coding-host'
import { createJournalHostClient } from './journal-host'
import { createLifeModeClient } from './life-mode'
import { createLongGoalSchedulerClient } from './long-goal'
import { createMemoryHostClient } from './memory-host'
import { createWebFetchClient } from './web-fetch'

export function installCodingHostBridge(): void {
  const client = createCodingHostClient()
  installDataBackupPort({
    buildId: async () => {
      const status = await client.listTools()
      return `workspace:${status.workspaceRoot}`
    },
    readArtifact: async (path, workspaceRoot) => (await client.readFile({ path, expectedWorkspaceRoot: workspaceRoot })).content,
    stageRestore: async (data) => {
      const context = getElectronEventaContext()
      const save = defineInvoke(context, backupSave)
      const prepare = defineInvoke(context, backupPrepare)
      const stored = await save({ data })
      if (!stored)
        throw new Error('The backup archive was not stored.')
      return (await prepare({ token: stored.split(/[\\/]/).pop() ?? stored })).profilePath
    },
    relaunchRestore: async (profilePath) => {
      const context = getElectronEventaContext()
      await defineInvoke(context, backupRelaunch)({ profilePath })
    },
    adoptRestore: async () => {
      const context = getElectronEventaContext()
      await defineInvoke(context, backupAdopt)()
    },
    readPackageEntries: async () => {
      const context = getElectronEventaContext()
      return (await defineInvoke(context, extensionPackagesExport)()).files
    },
  })
  getElectronEventaContext().on(backupAdopted, () => {
    releaseRestoreEffectHold()
    void useSkillsReviewStore().restore().catch(error => console.warn('[Skills] Adopted profile verification failed.', error))
    // Boot skips scheduler initialization while restore effects are held.
    // The scheduler rejects followers and makes repeated adoption idempotent.
    void useLongGoalSchedulerStore().initialize().catch(error => console.warn('[LongGoal] Adopted profile initialization failed.', error))
  })
  installCodingHostClient({
    listDir: params => client.listDir(params),
    readFile: params => client.readFile(params),
    listTools: () => client.listTools(),
    runCommand: params => client.runCommand(params),
    runProgram: params => client.runProgram(params),
    setApprovalMode: mode => client.setApprovalMode(mode),
    setWorkspaceRoot: params => client.setWorkspaceRoot(params),
  })
  installSkillRuntime({
    readSource: async (toolId, expectedWorkspaceRoot) => (await client.readFile({ path: `skills/${toolId}/source.mjs`, expectedWorkspaceRoot })).content,
    readSelftest: async (toolId, expectedWorkspaceRoot) => (await client.readFile({ path: `skills/${toolId}/selftest.mjs`, expectedWorkspaceRoot })).content,
    readMeta: async (toolId, expectedWorkspaceRoot) => (await client.readFile({ path: `skills/${toolId}/meta.json`, expectedWorkspaceRoot })).content,
    getWorkspaceRoot: async () => (await client.listTools()).workspaceRoot,
    getMemoryScope: () => ({ userId: useAuthStore().userId, characterId: useAiriCardStore().activeCardId || 'default' }),
    runCommand: params => client.runCommand(params),
    runProgram: async (params) => {
      const { signal, ...ipc } = params
      if (signal?.aborted) {
        return { ok: false, failure: { kind: 'timeout', message: 'The skill run was cancelled before it started.', logs: [] } }
      }
      // Eventa 0.3.0 cannot deliver renderer cancellation to the run handler,
      // so the run gets a renderer-minted id and the abort sends a second,
      // explicit cancel invoke (mc-1c D3).
      const runId = crypto.randomUUID()
      const onAbort = () => {
        void client.cancelProgram({ runId })
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        const result = await client.runProgram({ ...ipc, runId })
        return result.ok
          ? { ok: true, value: result.value, logs: result.logs, traces: result.traces }
          : { ok: false, failure: { kind: result.failure.kind, message: result.failure.message, logs: result.failure.logs, traces: result.failure.traces } }
      }
      finally {
        signal?.removeEventListener('abort', onAbort)
      }
    },
  })
  installApprovalsBridge({
    onRequest: listener => client.onApprovalRequested(listener),
    onDecision: listener => client.onApprovalDecided(listener),
    decide: (requestId, decision) => client.decideApproval({ requestId, decision }),
  })
  // The fetch LLM tool reads the web through the SSRF-hardened main-process
  // service (DNS re-check + redirect re-check), never the raw renderer fetch.
  // A root switch reaches every window, not only the one that made it. The
  // store is resolved inside the callback because the listener is registered
  // before the app installs Pinia.
  client.onWorkspaceRootChanged(() => {
    void useCodingToolsStore().refreshStatus()
    void useSkillsReviewStore().restore().catch(error => console.warn('[Skills] Workspace verification failed.', error))
  })
  // The journal becomes durable here: the store keeps owning the live stream
  // and only mirrors it, so a renderer without this port behaves as before.
  installJournalPersistence(createJournalHostClient())
  installFetchTextPort(createWebFetchClient())
  installLifeModePort(createLifeModeClient())
  installLongGoalSchedulerPort(createLongGoalSchedulerClient())
  installAppearanceJournaling()
  installMemoryHostBridge()
  restoreApprovalMode()
}

/**
 * The bash approval tri-state persists in renderer localStorage while the
 * main-process policy resets to `substitute` on every boot; re-assert it at
 * bridge-install time so a `require` choice survives app restarts even when
 * the settings page is never opened.
 */
function restoreApprovalMode(): void {
  const stored = localStorage.getItem('settings/coding/approval-mode')
  if (stored === 'require' || stored === 'substitute' || stored === 'full')
    void createCodingHostClient().setApprovalMode(stored)
}

/**
 * LIFE-PLAN M2: every appearance mutation (LLM tools or settings panel)
 * becomes a narratable `appearance/changed` journal event, so her life
 * includes "I changed my hair" — and the history is replayable.
 */
function installAppearanceJournaling(): void {
  const journal = () => useJournalStore()
  const now = () => Date.now()
  installAppearanceJournalPort((change) => {
    journal().appendActive({
      type: 'appearance/changed',
      source: 'parameter',
      target: change.parameterId,
      ...(change.value !== undefined ? { value: change.value } : {}),
      ...(change.enabled !== undefined ? { enabled: change.enabled } : {}),
      timestamp: now(),
    })
  })
  installExpressionJournalPort((change) => {
    journal().appendActive({
      type: 'appearance/changed',
      source: change.kind,
      target: change.name,
      ...(change.value !== undefined ? { value: change.value } : {}),
      timestamp: now(),
    })
  })
}

/** Wires the long-term Postgres store port to the main-process memory host. */
function installMemoryHostBridge(): void {
  const client = createMemoryHostClient()
  installMemoryHostPort({
    configure: params => client.configure(params),
    getStatus: () => client.getStatus(),
    list: params => client.list(params),
    search: params => client.search(params),
    insert: params => client.insert(params),
    update: params => client.update(params),
    remove: params => client.remove(params),
  })
}
