import type { Tool, ToolExecuteOptions } from '@xsai/shared-chat'

import type { CodingShellDescriptor } from '../../../../shared/eventa'
import type { CodingHostClient } from '../../../bridges/coding-host'

import { summarizeLineDiff } from '@proj-airi/coding-harness/hashline/diff'
import { applyHashlineEdit, applyHashlineInsertAfter } from '@proj-airi/coding-harness/hashline/edit'
import { formatSignedFileProjection } from '@proj-airi/coding-harness/hashline/read'
import { joinTextFile, parseTextFile } from '@proj-airi/coding-harness/hashline/text'
import { bashDescriptionFor, CODING_TOOL_META, WORKSPACE_ROOT_TOOL_META } from '@proj-airi/coding-harness/tools/coding-tool-meta'
import { formatWorkspaceGrep, MAX_GREP_CONTEXT_LINES } from '@proj-airi/coding-harness/tools/grep'
import { useCodingToolsStore } from '@proj-airi/stage-ui/stores/coding'
import { tool } from '@xsai/tool'
import { z } from 'zod'

import { createCodingHostClient } from '../../../bridges/coding-host'

// -- LLM Tools: list / read / write / edit (Hashline) / bash --
// The main process owns the workspace host; every execute crosses the
// coding-host Eventa bridge (WIRING-BACKLOG §2). `edit` is Hashline-gated:
// a rejection is "state changed, re-read", never a task failure.
// Descriptions and parameter docs come from CODING_TOOL_META in
// @proj-airi/coding-harness so the Code Mode bridge labels cannot drift.

const readParams = z.object({
  path: z.string().describe(CODING_TOOL_META.read.parameterDescriptions.path),
  offset: z.number().int().min(0).optional().describe(CODING_TOOL_META.read.parameterDescriptions.offset),
  limit: z.number().int().min(1).max(2_000).optional().describe(CODING_TOOL_META.read.parameterDescriptions.limit),
})

const listParams = z.object({
  path: z.string().describe(CODING_TOOL_META.list.parameterDescriptions.path),
})

const workspaceRootParams = z.object({
  root: z.string().min(1).describe(WORKSPACE_ROOT_TOOL_META.parameterDescriptions.root),
})

async function executeList(input: { path: string }): Promise<string> {
  const result = await createCodingHostClient().listDir({ path: input.path })
  return JSON.stringify({ path: input.path, entries: result.entries })
}

async function executeSetWorkspaceRoot(input: { root: string }): Promise<string> {
  const outcome = await useCodingToolsStore().setWorkspaceRoot(input.root)
  return JSON.stringify(outcome)
}

async function executeRead(input: { path: string, offset?: number, limit?: number }): Promise<string> {
  const file = await createCodingHostClient().readFile({ path: input.path })
  const snapshot = parseTextFile(file.content)
  return formatSignedFileProjection({
    path: input.path,
    lines: snapshot.lines,
    mtime: file.mtime ? file.mtime.slice(0, 16) : undefined,
    baseHash: snapshot.baseHash,
    lineEnding: snapshot.lineEnding,
    mixedLineEndings: snapshot.mixedLineEndings,
  }, { offset: input.offset, limit: input.limit })
}

const grepParams = z.object({
  pattern: z.string().describe(CODING_TOOL_META.grep.parameterDescriptions.pattern),
  path: z.string().optional().describe(CODING_TOOL_META.grep.parameterDescriptions.path),
  glob: z.string().optional().describe(CODING_TOOL_META.grep.parameterDescriptions.glob),
  maxMatches: z.number().int().min(1).max(500).optional().describe(CODING_TOOL_META.grep.parameterDescriptions.maxMatches),
  contextLines: z.number().int().min(0).max(MAX_GREP_CONTEXT_LINES).optional().describe(CODING_TOOL_META.grep.parameterDescriptions.contextLines),
})

async function executeGrep(input: { pattern: string, path?: string, glob?: string, maxMatches?: number, contextLines?: number }): Promise<string> {
  const result = await createCodingHostClient().grep(input)
  return formatWorkspaceGrep(input, result)
}

const writeParams = z.object({
  path: z.string().describe(CODING_TOOL_META.write.parameterDescriptions.path),
  content: z.string().describe(CODING_TOOL_META.write.parameterDescriptions.content),
  baseHash: z.string().nullable().describe(CODING_TOOL_META.write.parameterDescriptions.baseHash),
})

async function executeWrite(input: { path: string, content: string, baseHash: string | null }, executeOptions?: ToolExecuteOptions): Promise<string> {
  if (executeOptions?.abortSignal?.aborted)
    return flowInterruptedResult('write')

  const client = createCodingHostClient()
  // Read before writing so the result can show what changed. Whole-file writes
  // are the path a model actually takes, and "wrote <path>" gave the user no
  // way to review it (HARNESS-PLAN §9.1).
  const before = input.baseHash === null ? [] : await readLinesOrEmpty(client, input.path)
  if (executeOptions?.abortSignal?.aborted)
    return flowInterruptedResult('write')

  const result = await client.writeFileIfUnchanged(input)
  if (result.status === 'state_changed')
    return JSON.stringify({ path: input.path, ...result })

  const diff = summarizeLineDiff(before, parseTextFile(input.content).lines)
  return diff.text
    ? `${JSON.stringify({ path: input.path, ...result })}\n${diff.text}`
    : JSON.stringify({ path: input.path, ...result })
}

/** Reads a file for diffing; a missing file simply has no previous content. */
async function readLinesOrEmpty(client: CodingHostClient, path: string): Promise<string[]> {
  try {
    return parseTextFile((await client.readFile({ path })).content).lines
  }
  catch {
    return []
  }
}

const editParams = z.object({
  path: z.string().describe(CODING_TOOL_META.edit.parameterDescriptions.path),
  operation: z.enum(['replace', 'insertAfter']).describe(CODING_TOOL_META.edit.parameterDescriptions.operation),
  startSignature: z.string().optional().describe(CODING_TOOL_META.edit.parameterDescriptions.startSignature),
  endSignature: z.string().optional().describe(CODING_TOOL_META.edit.parameterDescriptions.endSignature),
  afterSignature: z.string().optional().describe(CODING_TOOL_META.edit.parameterDescriptions.afterSignature),
  expectedPrefix: z.string().describe(CODING_TOOL_META.edit.parameterDescriptions.expectedPrefix),
  newContent: z.string().describe(CODING_TOOL_META.edit.parameterDescriptions.newContent),
})

async function executeEdit(input: { path: string, operation: 'replace' | 'insertAfter', startSignature?: string, endSignature?: string, afterSignature?: string, expectedPrefix: string, newContent: string }, executeOptions?: ToolExecuteOptions): Promise<string> {
  if (executeOptions?.abortSignal?.aborted)
    return flowInterruptedResult('edit')

  const client = createCodingHostClient()
  const file = await client.readFile({ path: input.path })
  if (executeOptions?.abortSignal?.aborted)
    return flowInterruptedResult('edit')

  const snapshot = parseTextFile(file.content)
  const outcome = input.operation === 'replace'
    ? applyHashlineEdit({
        lines: snapshot.lines,
        startSignature: requiredSignature(input.startSignature, 'startSignature'),
        endSignature: input.endSignature,
        expectedPrefix: input.expectedPrefix,
        newContent: input.newContent,
      })
    : applyHashlineInsertAfter({
        lines: snapshot.lines,
        afterSignature: requiredSignature(input.afterSignature, 'afterSignature'),
        expectedPrefix: input.expectedPrefix,
        newContent: input.newContent,
      })

  if (outcome.result.status !== 'applied') {
    // Rejections are mechanical verdicts, not failures: the model re-reads .
    // and retries with a fresh signature.
    return `edit rejected: ${JSON.stringify(outcome.result)}`
  }

  if (executeOptions?.abortSignal?.aborted)
    return flowInterruptedResult('edit')

  const write = await client.writeFileIfUnchanged({
    path: input.path,
    content: joinTextFile(outcome.lines, snapshot.lineEnding),
    baseHash: snapshot.baseHash,
  })
  if (write.status === 'state_changed')
    return `edit rejected: ${JSON.stringify(write)}`

  const diff = summarizeLineDiff(snapshot.lines, outcome.lines)
  const applied = JSON.stringify({ ...outcome.result, ...(snapshot.mixedLineEndings ? { lineEndingNormalized: true } : {}) })
  return diff.text ? `${applied}\n${diff.text}` : applied
}

function requiredSignature(value: string | undefined, name: string): string {
  if (!value)
    throw new Error(`${name} is required for this edit operation`)
  return value
}

function flowInterruptedResult(toolName: string): string {
  return JSON.stringify({
    status: 'blocked',
    reason: 'flow_interrupted',
    toolName,
    message: 'This mutation was cancelled because its owning Flow was interrupted.',
  })
}

const bashParams = z.object({
  command: z.string().describe(CODING_TOOL_META.bash.parameterDescriptions.command),
  mediumApprovalRequired: z.boolean().optional().describe(CODING_TOOL_META.bash.parameterDescriptions.mediumApprovalRequired),
  runInBackground: z.boolean().optional().describe(CODING_TOOL_META.bash.parameterDescriptions.runInBackground),
})

const jobOutputParams = z.object({
  jobId: z.string().describe(CODING_TOOL_META.jobOutput.parameterDescriptions.jobId),
  tail: z.number().int().min(1).max(8_000).optional().describe(CODING_TOOL_META.jobOutput.parameterDescriptions.tail),
})

const jobKillParams = z.object({
  jobId: z.string().describe(CODING_TOOL_META.jobKill.parameterDescriptions.jobId),
})

async function executeJobOutput(input: { jobId: string, tail?: number }): Promise<string> {
  const job = await createCodingHostClient().jobOutput(input)
  if (job.status === 'unknown')
    return `job ${input.jobId} is unknown; it may have been started before a workspace root switch.`

  const header = `job ${job.jobId} ${job.status}${job.exitCode != null ? ` (exit ${job.exitCode})` : ''}${job.truncated ? ' · earlier output dropped' : ''}`
  return job.output ? `${header}\n${job.output}` : header
}

async function executeJobKill(input: { jobId: string }): Promise<string> {
  const result = await createCodingHostClient().jobKill(input)
  return `job ${result.jobId} ${result.outcome}`
}

async function executeBash(input: { command: string, mediumApprovalRequired?: boolean, runInBackground?: boolean }, executeOptions?: ToolExecuteOptions): Promise<string> {
  if (executeOptions?.abortSignal?.aborted)
    return flowInterruptedResult('bash')

  const result = await createCodingHostClient().runCommand({
    command: input.command,
    mediumApprovalRequired: input.mediumApprovalRequired,
    ...(input.runInBackground ? { runInBackground: true } : {}),
  }, executeOptions?.abortSignal ? { signal: executeOptions.abortSignal } : undefined)

  // Keep the result as structured JSON so the harness can distinguish a
  // failed command from a successful tool call without parsing prose.
  return JSON.stringify(result)
}

const CODE_MODE_MIN_TIMEOUT_MS = 1_000
const CODE_MODE_MAX_TIMEOUT_MS = 60_000

const codeModeParams = z.object({
  program: z.string().describe('Program body. Call tools with `await bridge(name, [args])` (e.g. `await bridge("read", ["src/a.ts"])`) and `return` the final value. Runs in a sandboxed worker; one bridge call is one tool dispatch.'),
  timeoutMs: z.number().optional().describe(`Whole-program wall clock limit between ${CODE_MODE_MIN_TIMEOUT_MS} and ${CODE_MODE_MAX_TIMEOUT_MS} (default 10000).`),
})

/** Flattens one Code Mode run into a bounded text result for the model. */
export function codeModeResultToText(result: Awaited<ReturnType<CodingHostClient['runProgram']>>): string {
  const lines: string[] = []

  if (result.ok) {
    lines.push(`program finished, ${result.traces.length} tool call(s)`)
    if (result.value !== undefined)
      lines.push(`return: ${JSON.stringify(result.value)}`)
    lines.push(...result.logs.map(log => `log: ${log}`))
    lines.push(...result.traces.map(trace => `${trace.ok ? 'ok' : 'failed'} ${trace.toolName} -> ${trace.resultSummary}`))
    return lines.join('\n')
  }

  lines.push(`program failed (${result.failure.kind}): ${result.failure.message}`)
  lines.push(...result.failure.logs.map(log => `log: ${log}`))
  lines.push(...result.failure.traces.map(trace => `${trace.ok ? 'ok' : 'failed'} ${trace.toolName} -> ${trace.resultSummary}`))
  return lines.join('\n')
}

async function executeCodeMode(input: { program: string, timeoutMs?: number }, executeOptions?: ToolExecuteOptions): Promise<string> {
  if (executeOptions?.abortSignal?.aborted)
    return flowInterruptedResult('code_mode')

  const timeoutMs = input.timeoutMs === undefined
    ? undefined
    : Math.min(Math.max(Math.round(input.timeoutMs), CODE_MODE_MIN_TIMEOUT_MS), CODE_MODE_MAX_TIMEOUT_MS)
  const result = await createCodingHostClient().runProgram({ program: input.program, timeoutMs }, executeOptions?.abortSignal ? { signal: executeOptions.abortSignal } : undefined)
  return codeModeResultToText(result)
}

/**
 * Builds the coding tool declarations for one resolved workspace shell.
 *
 * The shell is a runtime fact owned by the main process, so `bash` is declared
 * per call instead of at module scope: the description must name the
 * interpreter that will actually run the command.
 */
function createCodingToolDeclarations(shell: CodingShellDescriptor): Promise<Tool>[] {
  return [
    tool({
      name: CODING_TOOL_META.list.name,
      description: CODING_TOOL_META.list.description,
      execute: executeList,
      parameters: listParams,
    }),
    tool({
      name: CODING_TOOL_META.grep.name,
      description: CODING_TOOL_META.grep.description,
      execute: executeGrep,
      parameters: grepParams,
    }),
    tool({
      name: CODING_TOOL_META.read.name,
      description: CODING_TOOL_META.read.description,
      execute: executeRead,
      parameters: readParams,
    }),
    tool({
      name: CODING_TOOL_META.write.name,
      description: CODING_TOOL_META.write.description,
      execute: executeWrite,
      parameters: writeParams,
    }),
    tool({
      name: CODING_TOOL_META.edit.name,
      description: CODING_TOOL_META.edit.description,
      execute: executeEdit,
      parameters: editParams,
    }),
    tool({
      name: CODING_TOOL_META.bash.name,
      description: bashDescriptionFor(shell),
      execute: executeBash,
      parameters: bashParams,
    }),
    tool({
      name: CODING_TOOL_META.jobOutput.name,
      description: CODING_TOOL_META.jobOutput.description,
      execute: executeJobOutput,
      parameters: jobOutputParams,
    }),
    tool({
      name: CODING_TOOL_META.jobKill.name,
      description: CODING_TOOL_META.jobKill.description,
      execute: executeJobKill,
      parameters: jobKillParams,
    }),
    tool({
      name: WORKSPACE_ROOT_TOOL_META.name,
      description: WORKSPACE_ROOT_TOOL_META.description,
      execute: executeSetWorkspaceRoot,
      parameters: workspaceRootParams,
    }),
    tool({
      name: 'code_mode',
      description: 'Run a multi-step coding program in one sandboxed execution. Prefer it over many single tool calls when a task needs several read/write/edit/bash operations: control flow, loops, and conditionals run in code, and the result comes back as one summary with a trace per tool dispatch.',
      execute: executeCodeMode,
      parameters: codeModeParams,
    }),
  ]
}

export const codingTools = async (shell: CodingShellDescriptor) => Promise.all(createCodingToolDeclarations(shell))
