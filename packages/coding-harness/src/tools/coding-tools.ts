/**
 * The coding tools (CODING-HARNESS-DESIGN §2.3): list / read / write / edit /
 * bash, exposed as Code Mode bridge capabilities. `edit` is Hashline-gated;
 * `bash` is statically tiered and approval-checked. All path arguments are
 * contained inside the workspace host.
 */
import type { BashRiskTier } from '@proj-airi/core-agent'

import type { CodeModeTool } from '../ptc/code-mode'
import type { WorkspaceGrepQuery } from './grep'
import type { WorkspaceHost } from './workspace-host'

import { classifyBashCommand } from '@proj-airi/core-agent'

import { applyHashlineEdit, applyHashlineInsertAfter } from '../hashline/edit'
import { formatSignedFileProjection } from '../hashline/read'
import { joinTextFile, parseTextFile } from '../hashline/text'
import { bashDescriptionFor, CODING_TOOL_META } from './coding-tool-meta'
import { formatWorkspaceGrep } from './grep'

export { bashDescriptionFor, CODING_TOOL_META } from './coding-tool-meta'
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

function optionalString(args: ToolArgs, index: number, name: string): string | undefined {
  const value = args[index]
  if (value === undefined)
    return undefined
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`tool argument "${name}" must be a non-empty string when provided`)
  return value
}

function optionalNonNegativeInteger(args: ToolArgs, index: number, name: string): number | undefined {
  const value = args[index]
  if (value === undefined)
    return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
    throw new Error(`tool argument "${name}" must be a non-negative integer when provided`)
  return value
}

function requireBaseHash(args: ToolArgs, index: number): string | null {
  const value = args[index]
  if (value === null || (typeof value === 'string' && value.length > 0))
    return value
  throw new Error('tool argument "baseHash" must be a non-empty string or null')
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
        const snapshot = parseTextFile(file.content)
        return {
          path,
          projection: formatSignedFileProjection({
            path: String(path),
            lines: snapshot.lines,
            mtime: file.mtime ? file.mtime.slice(0, 16) : undefined,
            baseHash: snapshot.baseHash,
            lineEnding: snapshot.lineEnding,
            mixedLineEndings: snapshot.mixedLineEndings,
          }, {
            offset: optionalNonNegativeInteger(toolArgs, 1, 'offset'),
            limit: optionalNonNegativeInteger(toolArgs, 2, 'limit'),
          }),
        }
      },
    },
    {
      name: CODING_TOOL_META.grep.name,
      description: CODING_TOOL_META.grep.description,
      async run(args) {
        const toolArgs = args as ToolArgs
        const path = optionalString(toolArgs, 1, 'path')
        const glob = optionalString(toolArgs, 2, 'glob')
        const query: WorkspaceGrepQuery = {
          pattern: requireString(toolArgs, 0, 'pattern'),
          ...(path ? { path } : {}),
          ...(glob ? { glob } : {}),
          ...(optionalNonNegativeInteger(toolArgs, 3, 'maxMatches') !== undefined
            ? { maxMatches: optionalNonNegativeInteger(toolArgs, 3, 'maxMatches') }
            : {}),
          ...(optionalNonNegativeInteger(toolArgs, 4, 'contextLines') !== undefined
            ? { contextLines: optionalNonNegativeInteger(toolArgs, 4, 'contextLines') }
            : {}),
        }
        const result = await host.grep(query)
        return {
          projection: formatWorkspaceGrep(query, result),
          matches: result.matches,
          matchCount: result.matchCount,
          truncated: result.truncated,
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
        const baseHash = requireBaseHash(toolArgs, 2)
        return { path, ...await host.writeFileIfUnchanged(path, content, baseHash) }
      },
    },
    {
      name: CODING_TOOL_META.edit.name,
      description: CODING_TOOL_META.edit.description,
      async run(args) {
        const toolArgs = args as ToolArgs
        const path = requireString(toolArgs, 0, 'path')
        const operation = requireString(toolArgs, 1, 'operation')
        const signature = requireString(toolArgs, 2, operation === 'replace' ? 'startSignature' : 'afterSignature')
        const expectedPrefix = requireString(toolArgs, 3, 'expectedPrefix')
        const newContent = toolArgs[4]
        if (typeof newContent !== 'string')
          throw new Error('tool argument "newContent" must be a string')
        const file = await host.readFile(path)
        const snapshot = parseTextFile(file.content)
        const outcome = operation === 'replace'
          ? applyHashlineEdit({
              lines: snapshot.lines,
              startSignature: signature,
              endSignature: optionalString(toolArgs, 5, 'endSignature'),
              expectedPrefix,
              newContent,
            })
          : operation === 'insertAfter'
            ? applyHashlineInsertAfter({
                lines: snapshot.lines,
                afterSignature: signature,
                expectedPrefix,
                newContent,
              })
            : (() => { throw new Error('tool argument "operation" must be "replace" or "insertAfter"') })()

        // Rejections carry the mechanical verdict; the model re-reads instead
        // of guessing. Only `applied` mutates the file.
        if (outcome.result.status === 'applied') {
          const write = await host.writeFileIfUnchanged(path, joinTextFile(outcome.lines, snapshot.lineEnding), snapshot.baseHash)
          if (write.status === 'state_changed')
            return { path, result: write }
        }

        return {
          path,
          result: outcome.result,
          ...(snapshot.mixedLineEndings && outcome.result.status === 'applied' ? { lineEndingNormalized: true } : {}),
        }
      },
    },
    {
      name: CODING_TOOL_META.bash.name,
      description: bashDescriptionFor(host.shell),
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

        // A background start hands back the job id instead of output: the
        // command is expected to outlive the turn.
        if (toolArgs[1] === true) {
          const job = host.jobs.start(line)
          return { tier, status: 'started', shell: host.shell.kind, jobId: job.jobId }
        }

        const result = await host.runCommand(line)
        return {
          tier,
          status: result.exitCode === 0 ? 'ok' : 'error',
          shell: result.shell,
          exitCode: result.exitCode,
          stdout: result.stdout.slice(0, 8_000),
          stderr: result.stderr.slice(0, 2_000),
        }
      },
    },
    {
      name: CODING_TOOL_META.jobOutput.name,
      description: CODING_TOOL_META.jobOutput.description,
      async run(args) {
        const toolArgs = args as ToolArgs
        const jobId = requireString(toolArgs, 0, 'jobId')
        const tail = optionalNonNegativeInteger(toolArgs, 1, 'tail')
        return host.jobs.read(jobId, tail != null ? { tail } : undefined) ?? { jobId, status: 'unknown' }
      },
    },
    {
      name: CODING_TOOL_META.jobKill.name,
      description: CODING_TOOL_META.jobKill.description,
      async run(args) {
        const toolArgs = args as ToolArgs
        const jobId = requireString(toolArgs, 0, 'jobId')
        return { jobId, outcome: host.jobs.kill(jobId) }
      },
    },
  ]
}
