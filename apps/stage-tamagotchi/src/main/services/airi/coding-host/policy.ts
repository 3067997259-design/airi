import type { WorkspaceHost } from '@proj-airi/coding-harness'

/**
 * Coding host policy (CODING-HARNESS-DESIGN §11.5 + WIRING-BACKLOG §2).
 *
 * The approval-gated bash orchestration, kept free of Electron imports so
 * the whole decision surface is unit-testable: static tier classification →
 * approval gate (a rejected or unanswered request never executes) →
 * workspace host execution → bounded output.
 */
import type { CodingBashRiskTier, CodingExecRunResult } from '../../../../shared/eventa'

import { classifyBashCommand } from '@proj-airi/core-agent'

export interface CodingHostDeps {
  host: Pick<WorkspaceHost, 'runCommand' | 'jobs'>
  /** Returns true only when the human approved the exact request. */
  approve: (tier: CodingBashRiskTier, command: string) => Promise<boolean | { approved: boolean, requestId?: string }>
  mediumApprovalRequired: boolean
  approvalRequired?: boolean
  /** Starts the command as a background job instead of waiting for it. */
  runInBackground?: boolean
  /** Revocation signal; aborting kills the foreground command process. */
  signal?: AbortSignal
}

export const MAX_COMMAND_STDOUT_CHARS = 8_000
export const MAX_COMMAND_STDERR_CHARS = 2_000

/**
 * Runs one bash command through the static tier gate. Read-only commands
 * execute immediately; medium/high tier commands (per configuration) wait
 * for `approve`; a denied request returns a correlated `denied` result
 * instead of executing.
 */
export async function runBashCommand(command: string, deps: CodingHostDeps): Promise<CodingExecRunResult> {
  const tier = classifyBashCommand(command)
  const needsApproval = deps.approvalRequired === true || tier === 'high' || (tier === 'medium' && deps.mediumApprovalRequired)

  if (needsApproval) {
    const decision = await deps.approve(tier, command)
    const outcome = typeof decision === 'boolean' ? { approved: decision } : decision
    if (!outcome.approved) {
      return {
        tier,
        status: 'denied',
        stdout: '',
        stderr: '',
        ...(outcome.requestId ? { requestId: outcome.requestId } : {}),
        reason: 'approval_required',
      }
    }
  }

  // The approval gate runs first either way: a background start is still an
  // execution, and a denied command must never reach a spawn.
  if (deps.runInBackground) {
    const job = deps.host.jobs.start(command)
    return {
      tier,
      status: 'started',
      jobId: job.jobId,
      stdout: '',
      stderr: '',
    }
  }

  const result = deps.signal
    ? await deps.host.runCommand(command, { signal: deps.signal })
    : await deps.host.runCommand(command)
  return {
    tier,
    status: result.exitCode === 0 ? 'ok' : 'error',
    shell: result.shell,
    stdout: result.stdout.slice(0, MAX_COMMAND_STDOUT_CHARS),
    stderr: result.stderr.slice(0, MAX_COMMAND_STDERR_CHARS),
    exitCode: result.exitCode,
  }
}
