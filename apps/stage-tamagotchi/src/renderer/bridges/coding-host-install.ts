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
import { installApprovalsBridge } from '@proj-airi/stage-ui/stores/approvals'
import { installCodingHostClient } from '@proj-airi/stage-ui/stores/coding'
import { useJournalStore } from '@proj-airi/stage-ui/stores/journal'
import { installLifeModePort } from '@proj-airi/stage-ui/stores/modules/life-mode'
import { installMemoryHostPort } from '@proj-airi/stage-ui/stores/modules/memory'
import { installSkillRuntime } from '@proj-airi/stage-ui/stores/skills'
import { installFetchTextPort } from '@proj-airi/stage-ui/tools/fetch'

import { createCodingHostClient } from './coding-host'
import { createLifeModeClient } from './life-mode'
import { createMemoryHostClient } from './memory-host'
import { createWebFetchClient } from './web-fetch'

export function installCodingHostBridge(): void {
  const client = createCodingHostClient()
  installCodingHostClient({
    listDir: params => client.listDir(params),
    readFile: params => client.readFile(params),
    listTools: () => client.listTools(),
    runCommand: params => client.runCommand(params),
    runProgram: params => client.runProgram(params),
    setApprovalMode: mode => client.setApprovalMode(mode),
  })
  installSkillRuntime({
    runCommand: params => client.runCommand(params),
    runProgram: async (params) => {
      const result = await client.runProgram(params)
      return result.ok
        ? { ok: true, value: result.value, logs: result.logs }
        : { ok: false, failure: { kind: result.failure.kind, message: result.failure.message, logs: result.failure.logs } }
    },
  })
  installApprovalsBridge({
    onRequest: listener => client.onApprovalRequested(listener),
    onDecision: listener => client.onApprovalDecided(listener),
    decide: (requestId, decision) => client.decideApproval({ requestId, decision }),
  })
  // The fetch LLM tool reads the web through the SSRF-hardened main-process
  // service (DNS re-check + redirect re-check), never the raw renderer fetch.
  installFetchTextPort(createWebFetchClient())
  installLifeModePort(createLifeModeClient())
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
  })
}
