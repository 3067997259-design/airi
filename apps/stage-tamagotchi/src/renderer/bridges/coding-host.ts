import type {
  CodingApprovalDecisionPayload,
  CodingApprovalMode,
  CodingApprovalRequestPayload,
  CodingCodeRunParams,
  CodingCodeRunResult,
  CodingExecRunParams,
  CodingExecRunResult,
  CodingFsListParams,
  CodingFsListResult,
  CodingFsReadParams,
  CodingFsReadResult,
  CodingFsWriteGuardedParams,
  CodingFsWriteGuardedResult,
  CodingFsWriteParams,
  CodingFsWriteResult,
  CodingGrepParams,
  CodingGrepResult,
  CodingJobKillParams,
  CodingJobKillResult,
  CodingJobOutputParams,
  CodingJobOutputResult,
  CodingToolsStatusResult,
  CodingWorkspaceRootChangedPayload,
  CodingWorkspaceRootParams,
  CodingWorkspaceRootResult,
} from '../../shared/eventa'

import { defineInvoke } from '@moeru/eventa'
/**
 * Renderer-side coding host client (WIRING-BACKLOG §2).
 *
 * Thin facade over the main-process `eventa:invoke:*:coding-host`
 * contracts; also wires the approval card channel: the main process emits
 * `codingApprovalRequested`, this bridge surfaces it and forwards the
 * decision event.
 */
import { getElectronEventaContext } from '@proj-airi/electron-vueuse'

import {
  codingApprovalDecided,
  codingApprovalRequested,
  codingHostCodeCancel,
  codingHostCodeRun,
  codingHostExecRun,
  codingHostFsGrep,
  codingHostFsList,
  codingHostFsRead,
  codingHostFsWrite,
  codingHostFsWriteGuarded,
  codingHostJobKill,
  codingHostJobOutput,
  codingHostListTools,
  codingHostSetApprovalMode,
  codingHostSetWorkspaceRoot,
  codingWorkspaceRootChanged,
} from '../../shared/eventa'

export interface CodingHostClient {
  listDir: (params: CodingFsListParams) => Promise<CodingFsListResult>
  readFile: (params: CodingFsReadParams) => Promise<CodingFsReadResult>
  grep: (params: CodingGrepParams) => Promise<CodingGrepResult>
  writeFile: (params: CodingFsWriteParams) => Promise<CodingFsWriteResult>
  writeFileIfUnchanged: (params: CodingFsWriteGuardedParams) => Promise<CodingFsWriteGuardedResult>
  runCommand: (params: CodingExecRunParams, options?: { signal?: AbortSignal }) => Promise<CodingExecRunResult>
  runProgram: (params: CodingCodeRunParams, options?: { signal?: AbortSignal }) => Promise<CodingCodeRunResult>
  /** Aborts a running sandbox program by its renderer-minted run id (mc-1c D3). */
  cancelProgram: (params: { runId: string }) => Promise<void>
  jobOutput: (params: CodingJobOutputParams) => Promise<CodingJobOutputResult>
  jobKill: (params: CodingJobKillParams) => Promise<CodingJobKillResult>
  listTools: () => Promise<CodingToolsStatusResult>
  setApprovalMode: (mode: CodingApprovalMode) => Promise<void>
  setWorkspaceRoot: (params: CodingWorkspaceRootParams) => Promise<CodingWorkspaceRootResult>
  onWorkspaceRootChanged: (listener: (payload: CodingWorkspaceRootChangedPayload) => void) => () => void
  onApprovalRequested: (listener: (payload: CodingApprovalRequestPayload) => void) => () => void
  onApprovalDecided: (listener: (payload: CodingApprovalDecisionPayload) => void) => () => void
  decideApproval: (payload: CodingApprovalDecisionPayload) => void
}

let cachedClient: CodingHostClient | undefined

/** Creates (or reuses) the coding host client for the current renderer. */
export function createCodingHostClient(): CodingHostClient {
  cachedClient ??= createCodingHostClientInner()
  return cachedClient
}

function createCodingHostClientInner(): CodingHostClient {
  const context = getElectronEventaContext()

  const readFile = defineInvoke(context, codingHostFsRead)
  const listDir = defineInvoke(context, codingHostFsList)
  const grep = defineInvoke(context, codingHostFsGrep)
  const writeFile = defineInvoke(context, codingHostFsWrite)
  const writeFileIfUnchanged = defineInvoke(context, codingHostFsWriteGuarded)
  const runCommand = defineInvoke(context, codingHostExecRun)
  const runProgram = defineInvoke(context, codingHostCodeRun)
  const cancelProgram = defineInvoke(context, codingHostCodeCancel)
  const jobOutput = defineInvoke(context, codingHostJobOutput)
  const jobKill = defineInvoke(context, codingHostJobKill)
  const listTools = defineInvoke(context, codingHostListTools)
  const setApprovalMode = defineInvoke(context, codingHostSetApprovalMode)
  const setWorkspaceRoot = defineInvoke(context, codingHostSetWorkspaceRoot)

  return {
    listDir,
    readFile,
    grep,
    writeFile,
    writeFileIfUnchanged,
    runCommand,
    runProgram,
    cancelProgram,
    jobOutput,
    jobKill,
    listTools,
    setApprovalMode: async (mode) => {
      await setApprovalMode({ mode })
    },
    setWorkspaceRoot,
    onWorkspaceRootChanged(listener) {
      const off = context.on(codingWorkspaceRootChanged, (event) => {
        if (event.body)
          listener(event.body)
      })
      return () => off()
    },
    onApprovalRequested(listener) {
      const off = context.on(codingApprovalRequested, (event) => {
        if (event.body)
          listener(event.body)
      })
      return () => off()
    },
    onApprovalDecided(listener) {
      const off = context.on(codingApprovalDecided, (event) => {
        if (event.body)
          listener(event.body)
      })
      return () => off()
    },
    decideApproval(payload) {
      context.emit(codingApprovalDecided, payload)
    },
  }
}
