/**
 * The four coding tools (CODING-HARNESS-DESIGN §2.3): read / write / edit /
 * bash, exposed as Code Mode bridge capabilities. `edit` is Hashline-gated;
 * `bash` is statically tiered and approval-checked. All path arguments are
 * contained inside the workspace host.
 */
import type { BashRiskTier } from '@proj-airi/core-agent'

import type { CodeModeTool } from '../ptc/code-mode'
import type { WorkspaceHost } from './workspace-host'

import { classifyBashCommand } from '@proj-airi/core-agent'

import { applyHashlineEdit } from '../hashline/edit'
import { formatSignedFileProjection } from '../hashline/read'

export type { BashRiskTier }

export interface CodingToolsOptions {
  /** Decides bash escalation; absent means deny everything above read-only. */
  approveBash?: (tier: BashRiskTier, command: string) => boolean | ApprovalOutcome | Promise<boolean | ApprovalOutcome>
  mediumBashApprovalRequired?: boolean
}

export interface ApprovalOutcome {
  approved: boolean
  requestId?: string
}

export type ToolArgs = readonly unknown[]

function requireString(args: ToolArgs, index: number, name: string): string {
  const value = args[index]
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`tool argument "${name}" must be a non-empty string`)
  return value
}

export function createCodingTools(host: WorkspaceHost, options: CodingToolsOptions = {}): CodeModeTool[] {
  const approve = options.approveBash
    ?? (() => false)

  return [
    {
      name: 'read',
      description: 'Read a file inside the workspace; every line carries a short content signature the model must use for edits.',
      async run(args) {
        const toolArgs = args as ToolArgs
        const path = requireString(toolArgs, 0, 'path')
        const file = await host.readFile(path)
        return {
          path,
          projection: formatSignedFileProjection({
            path: String(path),
            lines: file.content.split('\n'),
            mtime: file.mtime ? file.mtime.slice(0, 16) : undefined,
          }),
        }
      },
    },
    {
      name: 'write',
      description: 'Replace a whole file inside the workspace with new content.',
      async run(args) {
        const toolArgs = args as ToolArgs
        const path = requireString(toolArgs, 0, 'path')
        const content = requireString(toolArgs, 1, 'content')
        await host.writeFile(path, content)
        return { status: 'written', path }
      },
    },
    {
      name: 'edit',
      description: 'Hashline edit: replace one line identified by its content signature, confirmed by an expected prefix.',
      async run(args) {
        const toolArgs = args as ToolArgs
        const path = requireString(toolArgs, 0, 'path')
        const signature = requireString(toolArgs, 1, 'signature')
        const expectedPrefix = requireString(toolArgs, 2, 'expectedPrefix')
        const newLineContent = requireString(toolArgs, 3, 'newLineContent')
        const file = await host.readFile(path)
        const outcome = applyHashlineEdit({
          lines: file.content.split('\n'),
          signature,
          expectedPrefix,
          newLineContent,
        })

        // Rejections carry the mechanical verdict; the model re-reads instead
        // of guessing. Only `applied` mutates the file.
        if (outcome.result.status === 'applied')
          await host.writeFile(path, outcome.lines.join('\n'))

        return { path, result: outcome.result }
      },
    },
    {
      name: 'bash',
      description: 'Run a shell command in the workspace. Static risk tiers: high-tier commands require approval.',
      async run(args) {
        const toolArgs = args as ToolArgs
        const line = requireString(toolArgs, 0, 'command')
        const tier = classifyBashCommand(line)

        if (tier === 'high' || (tier === 'medium' && options.mediumBashApprovalRequired)) {
          const decision = await approve(tier, line)
          const outcome = typeof decision === 'boolean' ? { approved: decision } : decision
          if (!outcome.approved)
            return { tier, status: 'denied', reason: 'approval_required', requestId: outcome.requestId }
        }

        const result = await host.runCommand(line)
        return {
          tier,
          status: result.exitCode === 0 ? 'ok' : 'error',
          exitCode: result.exitCode,
          stdout: result.stdout.slice(0, 8_000),
          stderr: result.stderr.slice(0, 2_000),
        }
      },
    },
  ]
}
