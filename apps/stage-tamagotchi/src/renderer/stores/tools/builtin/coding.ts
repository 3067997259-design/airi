import type { Tool } from '@xsai/shared-chat'

import type { CodingShellDescriptor } from '../../../../shared/eventa'
import type { CodingHostClient } from '../../../bridges/coding-host'

import { applyHashlineEdit, applyHashlineInsertAfter } from '@proj-airi/coding-harness/hashline/edit'
import { formatSignedFileProjection } from '@proj-airi/coding-harness/hashline/read'
import { joinTextFile, parseTextFile } from '@proj-airi/coding-harness/hashline/text'
import { bashDescriptionFor, CODING_TOOL_META } from '@proj-airi/coding-harness/tools/coding-tool-meta'
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

async function executeList(input: { path: string }): Promise<string> {
  const result = await createCodingHostClient().listDir({ path: input.path })
  return JSON.stringify({ path: input.path, entries: result.entries })
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

const writeParams = z.object({
  path: z.string().describe(CODING_TOOL_META.write.parameterDescriptions.path),
  content: z.string().describe(CODING_TOOL_META.write.parameterDescriptions.content),
  baseHash: z.string().nullable().describe(CODING_TOOL_META.write.parameterDescriptions.baseHash),
})

async function executeWrite(input: { path: string, content: string, baseHash: string | null }): Promise<string> {
  const result = await createCodingHostClient().writeFileIfUnchanged(input)
  return JSON.stringify({ path: input.path, ...result })
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

async function executeEdit(input: { path: string, operation: 'replace' | 'insertAfter', startSignature?: string, endSignature?: string, afterSignature?: string, expectedPrefix: string, newContent: string }): Promise<string> {
  const client = createCodingHostClient()
  const file = await client.readFile({ path: input.path })
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

  const write = await client.writeFileIfUnchanged({
    path: input.path,
    content: joinTextFile(outcome.lines, snapshot.lineEnding),
    baseHash: snapshot.baseHash,
  })
  if (write.status === 'state_changed')
    return `edit rejected: ${JSON.stringify(write)}`
  return JSON.stringify({ ...outcome.result, ...(snapshot.mixedLineEndings ? { lineEndingNormalized: true } : {}) })
}

function requiredSignature(value: string | undefined, name: string): string {
  if (!value)
    throw new Error(`${name} is required for this edit operation`)
  return value
}

const bashParams = z.object({
  command: z.string().describe(CODING_TOOL_META.bash.parameterDescriptions.command),
  mediumApprovalRequired: z.boolean().optional().describe(CODING_TOOL_META.bash.parameterDescriptions.mediumApprovalRequired),
})

async function executeBash(input: { command: string, mediumApprovalRequired?: boolean }): Promise<string> {
  const result = await createCodingHostClient().runCommand({
    command: input.command,
    mediumApprovalRequired: input.mediumApprovalRequired,
  })

  if (result.status === 'denied') {
    return `bash denied: ${result.tier}-tier command requires approval (requestId ${result.requestId ?? 'n/a'}). Ask the user to approve, or use a lower-risk command.`
  }
  if (result.status === 'timeout') {
    return `bash timed out (${result.tier} tier)\n${result.stderr}`
  }
  // The shell rides in the header of every result: a model that cannot see
  // which interpreter answered rewrites the same failing command line.
  const shell = result.shell ? `, ${result.shell}` : ''
  const header = `bash ${result.status} (${result.tier} tier, exit ${result.exitCode ?? '?'}${shell})`
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n')
  return output ? `${header}\n${output}` : header
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

async function executeCodeMode(input: { program: string, timeoutMs?: number }): Promise<string> {
  const timeoutMs = input.timeoutMs === undefined
    ? undefined
    : Math.min(Math.max(Math.round(input.timeoutMs), CODE_MODE_MIN_TIMEOUT_MS), CODE_MODE_MAX_TIMEOUT_MS)
  const result = await createCodingHostClient().runProgram({ program: input.program, timeoutMs })
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
      name: 'code_mode',
      description: 'Run a multi-step coding program in one sandboxed execution. Prefer it over many single tool calls when a task needs several read/write/edit/bash operations: control flow, loops, and conditionals run in code, and the result comes back as one summary with a trace per tool dispatch.',
      execute: executeCodeMode,
      parameters: codeModeParams,
    }),
  ]
}

export const codingTools = async (shell: CodingShellDescriptor) => Promise.all(createCodingToolDeclarations(shell))
