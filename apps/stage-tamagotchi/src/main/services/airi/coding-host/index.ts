/**
 * Coding host service (WIRING-BACKLOG §2 / CODING-HARNESS-DESIGN §5).
 *
 * The Electron main-process owner of the workspace host: renders Hashline
 * file tools, approval-gated bash and the PTC (Code Mode) runtime behind the
 * `eventa:invoke:*:coding-host` contracts. Approval is mediated through
 * `codingApprovalRequested` / `codingApprovalDecided` events so any renderer
 * can host the approval card; unanswered requests time out to rejected.
 */
import type { createContext as createMainEventaContext } from '@moeru/eventa/adapters/electron/main'

import type { CodingApprovalDecisionPayload } from '../../../../shared/eventa'

import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { env } from 'node:process'

import { defineInvokeHandler } from '@moeru/eventa'
import { createCodeModeRuntime, createCodingTools, createNodeWorkspaceHost } from '@proj-airi/coding-harness'

import {
  codingApprovalDecided,
  codingApprovalRequested,
  codingHostCodeRun,
  codingHostExecRun,
  codingHostFsRead,
  codingHostFsWrite,
  codingHostListTools,
} from '../../../../shared/eventa'
import { runBashCommand } from './policy'

const APPROVAL_TIMEOUT_MS = 60_000
const DEFAULT_WORKSPACE_ROOT = join(homedir(), 'AIRI-workspace')

export interface CodingHostOptions {
  /** Overrides the workspace root; default `~/AIRI-workspace` or `AIRI_WORKSPACE_ROOT`. */
  workspaceRoot?: string
  mediumBashApprovalRequired?: boolean
}

export async function setupCodingHost(
  context: ReturnType<typeof createMainEventaContext>['context'],
  options: CodingHostOptions = {},
): Promise<void> {
  const workspaceRoot = options.workspaceRoot ?? (env.AIRI_WORKSPACE_ROOT?.trim() || DEFAULT_WORKSPACE_ROOT)
  await mkdir(workspaceRoot, { recursive: true })

  const host = createNodeWorkspaceHost(workspaceRoot)

  let nextRequestId = 1
  const pendingApprovals = new Map<string, { resolve: (decision: CodingApprovalDecisionPayload['decision']) => void }>()

  context.on(codingApprovalDecided, (event) => {
    if (!event.body)
      return
    const { requestId, decision } = event.body
    const pending = pendingApprovals.get(requestId)
    if (!pending)
      return
    pendingApprovals.delete(requestId)
    pending.resolve(decision)
  })

  /** Ask any renderer for approval; unanswered requests reject to denied. */
  const approve = async (tier: 'read-only' | 'medium' | 'high', command: string): Promise<{ approved: boolean, requestId: string }> => {
    const requestId = `coding-approval-${nextRequestId++}`
    const decision = await new Promise<CodingApprovalDecisionPayload['decision']>((resolve) => {
      pendingApprovals.set(requestId, { resolve })
      context.emit(codingApprovalRequested, {
        requestId,
        subject: command,
        reason: `Bash command requires approval (${tier} risk tier)`,
        riskLevel: tier === 'high' ? 'high' : 'medium',
        expectedEvidence: 'tool_result (command output)',
      })
      setTimeout(() => {
        if (pendingApprovals.delete(requestId))
          resolve('rejected')
      }, APPROVAL_TIMEOUT_MS)
    })
    return { approved: decision === 'approved', requestId }
  }

  const tools = createCodingTools(host, {
    approveBash: approve,
    mediumBashApprovalRequired: options.mediumBashApprovalRequired,
  })
  const codeRuntime = createCodeModeRuntime(tools)

  defineInvokeHandler(context, codingHostFsRead, async ({ path }) => host.readFile(path))

  defineInvokeHandler(context, codingHostFsWrite, async ({ path, content }) => {
    await host.writeFile(path, content)
    return { ok: true }
  })

  defineInvokeHandler(context, codingHostExecRun, async ({ command, mediumApprovalRequired, approvalRequired, timeoutMs }) => {
    void timeoutMs
    return runBashCommand(command, {
      host,
      approve,
      mediumApprovalRequired: mediumApprovalRequired ?? options.mediumBashApprovalRequired ?? false,
      approvalRequired,
    })
  })

  defineInvokeHandler(context, codingHostCodeRun, async ({ program, timeoutMs }) =>
    codeRuntime.run(program, timeoutMs ? { timeoutMs } : undefined))

  defineInvokeHandler(context, codingHostListTools, async () => ({
    workspaceRoot,
    tools: [
      ...tools.map(tool => ({ name: tool.name, description: tool.description, available: true })),
      // The PTC runtime is host-level rather than a bridge capability, so it
      // is listed separately; renderers gate registration on this entry.
      { name: 'code_mode', description: 'Run a sandboxed program that dispatches the coding tools through bridge().', available: true },
    ],
  }))
}
