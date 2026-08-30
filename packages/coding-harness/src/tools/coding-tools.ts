/**
 * The coding tools (CODING-HARNESS-DESIGN §2.3): list / read / write / edit /
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
import { CODING_TOOL_META } from './coding-tool-meta'

export { CODING_TOOL_META } from './coding-tool-meta'
export type { CodingToolName } from './coding-tool-meta'

export type { BashRiskTier }

export interface CodingToolsOptions {
  /** Decides bash escalation; absent means deny everything above read-only. */
  approveBash?: (tier: BashRiskTier, command: string) => boolean | ApprovalOutcome | Promise<boolean | ApprovalOutcome>
  /**
   * Whether medium-tier commands wait for approval. A function is re-evaluated
   * per call, so a host policy switch (approval-mode tri-state) can change
   * behavior without rebuilding the tool set.
   */
  mediumBashApprovalRequired?: boolean | (() => boolean)
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
      name: CODING_TOOL_META.list.name,
      description: CODING_TOOL_META.list.description,
      async run(args) {
        const toolArgs = args as ToolArgs
        const path = requireString(toolArgs, 0, 'path')
        return { path, entries: await host.listDir(path) }
      },
    },
    {
      name: CODING_TOOL_META.read.name,
      description: CODING_TOOL_META.read.description,
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
      name: CODING_TOOL_META.readRaw.name,
      description: CODING_TOOL_META.readRaw.description,
      async run(args) {
        const toolArgs = args as ToolArgs
        const path = requireString(toolArgs, 0, 'path')
        const file = await host.readFile(path)
        return { path, content: file.content }
      },
    },
    {
      name: CODING_TOOL_META.write.name,
      description: CODING_TOOL_META.write.description,
      async run(args) {
        const toolArgs = args as ToolArgs
        const path = requireString(toolArgs, 0, 'path')
        const content = requireString(toolArgs, 1, 'content')
        await host.writeFile(path, content)
        return { status: 'written', path }
      },
    },
    {
      name: CODING_TOOL_META.edit.name,
      description: CODING_TOOL_META.edit.description,
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
      name: CODING_TOOL_META.bash.name,
      description: CODING_TOOL_META.bash.description,
      async run(args) {
        const toolArgs = args as ToolArgs
        const line = requireString(toolArgs, 0, 'command')
        const tier = classifyBashCommand(line)
        const mediumRequired = typeof options.mediumBashApprovalRequired === 'function'
          ? options.mediumBashApprovalRequired()
          : options.mediumBashApprovalRequired

        if (tier === 'high' || (tier === 'medium' && mediumRequired)) {
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
