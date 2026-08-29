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
import { installMemoryHostPort } from '@proj-airi/stage-ui/stores/modules/memory'
import { installSkillRuntime } from '@proj-airi/stage-ui/stores/skills'

import { createCodingHostClient } from './coding-host'
import { createMemoryHostClient } from './memory-host'

export function installCodingHostBridge(): void {
  const client = createCodingHostClient()
  installCodingHostClient({
    listTools: () => client.listTools(),
    runCommand: params => client.runCommand(params),
    runProgram: params => client.runProgram(params),
  })
  installSkillRuntime({
    runCommand: params => client.runCommand(params),
  })
  installApprovalsBridge({
    onRequest: listener => client.onApprovalRequested(listener),
    onDecision: listener => client.onApprovalDecided(listener),
    decide: (requestId, decision) => client.decideApproval({ requestId, decision }),
  })
  installMemoryHostBridge()
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
