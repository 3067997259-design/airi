import type { Tool } from '@xsai/shared-chat'

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
]

export const codingTools = async () => Promise.all(tools)
