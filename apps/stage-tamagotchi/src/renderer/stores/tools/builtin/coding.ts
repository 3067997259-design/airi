import type { Tool } from '@xsai/shared-chat'

import type { CodingHostClient } from '../../../bridges/coding-host'

import { applyHashlineEdit } from '@proj-airi/coding-harness/hashline/edit'
import { formatSignedFileProjection } from '@proj-airi/coding-harness/hashline/read'
import { CODING_TOOL_META } from '@proj-airi/coding-harness/tools/coding-tool-meta'
import { tool } from '@xsai/tool'
import { z } from 'zod'

import { createCodingHostClient } from '../../../bridges/coding-host'

// -- LLM Tools: read / write / edit (Hashline) / bash --
// The main process owns the workspace host; every execute crosses the
// coding-host Eventa bridge (WIRING-BACKLOG §2). `edit` is Hashline-gated:
// a rejection is "state changed, re-read", never a task failure.
// Descriptions and parameter docs come from CODING_TOOL_META in
// @proj-airi/coding-harness so the Code Mode bridge labels cannot drift.

const readParams = z.object({
  path: z.string().describe(CODING_TOOL_META.read.parameterDescriptions.path),
})

async function executeRead(input: { path: string }): Promise<string> {
  const file = await createCodingHostClient().readFile({ path: input.path })
  return formatSignedFileProjection({
    path: input.path,
    lines: file.content.split('\n'),
    mtime: file.mtime ? file.mtime.slice(0, 16) : undefined,
  })
}

const writeParams = z.object({
  path: z.string().describe(CODING_TOOL_META.write.parameterDescriptions.path),
  content: z.string().describe(CODING_TOOL_META.write.parameterDescriptions.content),
})

async function executeWrite(input: { path: string, content: string }): Promise<string> {
  await createCodingHostClient().writeFile({ path: input.path, content: input.content })
  return `wrote ${input.path}`
}

const editParams = z.object({
  path: z.string().describe(CODING_TOOL_META.edit.parameterDescriptions.path),
  signature: z.string().describe(CODING_TOOL_META.edit.parameterDescriptions.signature),
  expectedPrefix: z.string().describe(CODING_TOOL_META.edit.parameterDescriptions.expectedPrefix),
  newLineContent: z.string().describe(CODING_TOOL_META.edit.parameterDescriptions.newLineContent),
})

async function executeEdit(input: { path: string, signature: string, expectedPrefix: string, newLineContent: string }): Promise<string> {
  const client = createCodingHostClient()
  const file = await client.readFile({ path: input.path })
  const outcome = applyHashlineEdit({
    lines: file.content.split('\n'),
    signature: input.signature,
    expectedPrefix: input.expectedPrefix,
    newLineContent: input.newLineContent,
  })

  if (outcome.result.status !== 'applied') {
    // Rejections are mechanical verdicts, not failures: the model re-reads .
    // and retries with a fresh signature.
    return `edit rejected: ${JSON.stringify(outcome.result)}`
  }

  await client.writeFile({ path: input.path, content: outcome.lines.join('\n') })
  return JSON.stringify(outcome.result)
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
  const header = `bash ${result.status} (${result.tier} tier, exit ${result.exitCode ?? '?'})`
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

const tools: Promise<Tool>[] = [
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
    description: CODING_TOOL_META.bash.description,
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

export const codingTools = async () => Promise.all(tools)
