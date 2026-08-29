import type {
  CodingApprovalDecisionPayload,
  CodingApprovalRequestPayload,
  CodingCodeRunParams,
  CodingCodeRunResult,
  CodingExecRunParams,
  CodingExecRunResult,
  CodingFsReadParams,
  CodingFsReadResult,
  CodingFsWriteParams,
  CodingFsWriteResult,
  CodingToolsStatusResult,
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
  codingHostCodeRun,
  codingHostExecRun,
  codingHostFsRead,
  codingHostFsWrite,
  codingHostListTools,
} from '../../shared/eventa'

export interface CodingHostClient {
  readFile: (params: CodingFsReadParams) => Promise<CodingFsReadResult>
  writeFile: (params: CodingFsWriteParams) => Promise<CodingFsWriteResult>
  runCommand: (params: CodingExecRunParams) => Promise<CodingExecRunResult>
  runProgram: (params: CodingCodeRunParams) => Promise<CodingCodeRunResult>
  listTools: () => Promise<CodingToolsStatusResult>
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
  const writeFile = defineInvoke(context, codingHostFsWrite)
  const runCommand = defineInvoke(context, codingHostExecRun)
  const runProgram = defineInvoke(context, codingHostCodeRun)
  const listTools = defineInvoke(context, codingHostListTools)

  return {
    readFile,
    writeFile,
    runCommand,
    runProgram,
    listTools,
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
