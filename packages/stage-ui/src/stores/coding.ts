import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { shallowRef } from 'vue'

import { useJournalStore } from './journal'

/**
 * Coding tools status + PTC (Code Mode) panel state (WIRING-BACKLOG §2).
 *
 * The actual host lives in the Electron main process; this store is the
 * renderer-side injection port for any window (stage, settings, ...). The
 * app shell installs the bridge client once per renderer process (module
 * singleton), pages only consume `useCodingToolsStore`.
 */

/** Bash approval tri-state (CAPABILITY-PLAN §三). */
export type CodingApprovalMode = 'require' | 'substitute' | 'full'

export const CODING_APPROVAL_MODES: readonly CodingApprovalMode[] = Object.freeze(['require', 'substitute', 'full'])
export interface CodingToolPortAvailability {
  name: string
  description: string
  available: boolean
}

/** Host status as the settings surface reads it. */
export interface CodingToolsStatusSnapshot {
  workspaceRoot: string
  /** Interpreter the host spawns for bash; absent on an older host build. */
  shell?: { kind: string, label: string, syntax: string }
  tools: CodingToolPortAvailability[]
}

export interface CodingHostClientPort {
  listDir: (params: { path: string }) => Promise<{ entries: Array<{ name: string, kind: 'file' | 'dir' }> }>
  readFile: (params: { path: string }) => Promise<{ content: string, mtime?: string }>
  listTools: () => Promise<CodingToolsStatusSnapshot>
  runCommand: (params: { command: string, mediumApprovalRequired?: boolean, approvalRequired?: boolean, timeoutMs?: number }) => Promise<{
    tier: 'read-only' | 'medium' | 'high'
    /** `started` reports a background job; its output arrives through job reads. */
    status: 'ok' | 'error' | 'denied' | 'timeout' | 'started'
    jobId?: string
    stdout: string
    stderr: string
    exitCode?: number
    requestId?: string
  }>
  runProgram: (params: { program: string, timeoutMs?: number }) => Promise<{
    ok: true
    value?: unknown
    logs: string[]
    traces: Array<{ toolName: string, args: unknown[], ok: boolean, resultSummary: string }>
  } | {
    ok: false
    failure: { kind: string, message: string, logs: string[], traces: Array<{ toolName: string, args: unknown[], ok: boolean, resultSummary: string }> }
  }>
  /** Applies the bash approval tri-state on the host. */
  setApprovalMode: (mode: CodingApprovalMode) => Promise<void>
  /**
   * Points the workspace tools at another directory.
   *
   * A rejection keeps the previous root: the host validates the directory
   * before it rebuilds anything, so the caller renders `reason` instead of
   * assuming the switch happened.
   */
  setWorkspaceRoot: (params: { root: string }) => Promise<CodingWorkspaceRootOutcome>
}

export type CodingWorkspaceRootOutcome
  = | { status: 'switched', workspaceRoot: string }
    | { status: 'rejected', workspaceRoot: string, reason: string }

let client: CodingHostClientPort | undefined

const statusSnapshot = shallowRef<CodingToolsStatusSnapshot>()

/** Registers the main-process bridge client for this renderer. */
export function installCodingHostClient(next: CodingHostClientPort): void {
  client = next
  statusSnapshot.value = undefined
}

export function hasCodingHostClient(): boolean {
  return client !== undefined
}

export interface CodeRunViewState {
  running: boolean
  logs: string[]
  traces: Array<{ toolName: string, args: unknown[], ok: boolean, resultSummary: string }>
  value?: unknown
  error?: string
}

const runView = shallowRef<CodeRunViewState>({ running: false, logs: [], traces: [] })
const approvalMode = useLocalStorageManualReset<CodingApprovalMode>('settings/coding/approval-mode', 'substitute')

export function useCodingToolsStore() {
  const journal = useJournalStore()

  async function refreshStatus() {
    if (!client)
      return undefined
    // Re-assert the persisted tri-state on every status refresh (window boot
    // ordering): the host defaults to `substitute` but the user may have
    // switched modes in a previous session.
    await client.setApprovalMode(approvalMode.value)
    statusSnapshot.value = await client.listTools()
    return statusSnapshot.value
  }

  async function listDir(path: string) {
    if (!client)
      throw new Error('Coding host is not available in this window.')
    return (await client.listDir({ path })).entries
  }

  async function readFile(path: string) {
    if (!client)
      throw new Error('Coding host is not available in this window.')
    return client.readFile({ path })
  }

  async function setApprovalMode(mode: CodingApprovalMode) {
    approvalMode.value = mode
    await client?.setApprovalMode(mode)
  }

  /**
   * Switches the workspace root and records the move in the journal.
   *
   * The journal entry is the point: the model keeps reading paths relative to
   * a root it never chose, so a silent switch would make every earlier path in
   * the conversation wrong without saying so.
   */
  async function setWorkspaceRoot(root: string): Promise<CodingWorkspaceRootOutcome> {
    if (!client)
      throw new Error('Coding host is not available in this window.')

    const outcome = await client.setWorkspaceRoot({ root })
    if (outcome.status === 'switched') {
      journal.appendActive({
        type: 'context/inject',
        contextId: 'coding-workspace-root',
        source: 'coding-host',
        text: `Workspace root switched to ${outcome.workspaceRoot}. Paths in earlier turns refer to the previous root.`,
      })
      await refreshStatus()
    }
    return outcome
  }

  async function runProgram(program: string, timeoutMs?: number) {
    if (!client) {
      runView.value = { running: false, logs: [], traces: [], error: 'Coding host is not available in this window.' }
      return runView.value
    }

    runView.value = { running: true, logs: [], traces: [] }
    const result = await client.runProgram({ program, timeoutMs })
    runView.value = result.ok
      ? { running: false, logs: result.logs, traces: result.traces, value: result.value }
      : { running: false, logs: result.failure.logs, traces: result.failure.traces, error: `[${result.failure.kind}] ${result.failure.message}` }
    for (const trace of result.ok ? result.traces : result.failure.traces) {
      journal.appendActive({
        type: 'tool/call',
        toolName: trace.toolName,
        args: trace.args,
      })
      journal.appendActive({
        type: 'tool/result',
        toolName: trace.toolName,
        ok: trace.ok,
        outcome: trace.ok ? 'ok' : 'failed',
        summary: trace.resultSummary,
      })
    }
    return runView.value
  }

  return {
    status: statusSnapshot,
    runView,
    approvalMode,
    refreshStatus,
    listDir,
    readFile,
    runProgram,
    setApprovalMode,
    setWorkspaceRoot,
  }
}
