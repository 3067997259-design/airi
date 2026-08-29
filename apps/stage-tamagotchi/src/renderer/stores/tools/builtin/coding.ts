import type { Tool } from '@xsai/shared-chat'

import { applyHashlineEdit } from '@proj-airi/coding-harness/hashline/edit'
import { formatSignedFileProjection } from '@proj-airi/coding-harness/hashline/read'
import { tool } from '@xsai/tool'
import { z } from 'zod'

import { createCodingHostClient } from '../../../bridges/coding-host'

// -- LLM Tools: read / write / edit (Hashline) / bash --
// The main process owns the workspace host; every execute crosses the
// coding-host Eventa bridge (WIRING-BACKLOG §2). `edit` is Hashline-gated:
// a rejection is "state changed, re-read", never a task failure.

const readParams = z.object({
  path: z.string().describe('Path inside the workspace, relative or absolute.'),
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
  path: z.string().describe('Path inside the workspace, relative or absolute.'),
  content: z.string().describe('Full new file content.'),
})

async function executeWrite(input: { path: string, content: string }): Promise<string> {
  await createCodingHostClient().writeFile({ path: input.path, content: input.content })
  return `wrote ${input.path}`
}

const editParams = z.object({
  path: z.string().describe('Path inside the workspace, relative or absolute.'),
  signature: z.string().describe('The 2-4 character content signature of the target line from the read projection.'),
  expectedPrefix: z.string().describe('Leading characters of the line as shown by read (16-32 chars).'),
  newLineContent: z.string().describe('The full replacement line content.'),
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
  command: z.string().describe('Shell command to run inside the workspace. High-risk commands require approval.'),
  mediumApprovalRequired: z.boolean().optional().describe('Force approval for medium-tier commands (default false).'),
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
    name: 'read',
    description: 'Read a text file inside the workspace. Every line carries a short content signature; use signatures (not copied lines) for edit.',
    execute: executeRead,
    parameters: readParams,
  }),
  tool({
    name: 'write',
    description: 'Replace a whole text file inside the workspace with new content.',
    execute: executeWrite,
    parameters: writeParams,
  }),
  tool({
    name: 'edit',
    description: 'Line-level edit gated by Hashline: pass the target line\'s signature from read plus its expected prefix. Rejection means the file changed — re-read first.',
    execute: executeEdit,
    parameters: editParams,
  }),
  tool({
    name: 'bash',
    description: 'Run a shell command inside the workspace. Read-only/tests run freely; high-risk commands (push, delete, network, production) require user approval.',
    execute: executeBash,
    parameters: bashParams,
  }),
]

export const codingTools = async () => Promise.all(tools)
