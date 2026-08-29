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
export interface CodingToolPortAvailability {
  name: string
  description: string
  available: boolean
}

export interface CodingHostClientPort {
  listTools: () => Promise<{ workspaceRoot: string, tools: CodingToolPortAvailability[] }>
  runCommand: (params: { command: string, mediumApprovalRequired?: boolean, approvalRequired?: boolean, timeoutMs?: number }) => Promise<{
    tier: 'read-only' | 'medium' | 'high'
    status: 'ok' | 'error' | 'denied' | 'timeout'
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
}

let client: CodingHostClientPort | undefined

const statusSnapshot = shallowRef<{ workspaceRoot: string, tools: CodingToolPortAvailability[] }>()

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

export function useCodingToolsStore() {
  const journal = useJournalStore()

  async function refreshStatus() {
    if (!client)
      return undefined
    statusSnapshot.value = await client.listTools()
    return statusSnapshot.value
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
        summary: trace.resultSummary,
      })
    }
    return runView.value
  }

  return {
    status: statusSnapshot,
    runView,
    refreshStatus,
    runProgram,
  }
}
