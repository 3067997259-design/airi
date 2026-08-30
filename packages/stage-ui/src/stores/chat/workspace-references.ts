import type { ContextMessage } from '@proj-airi/core-agent'

import { errorMessageFrom } from '@moeru/std'
import { ContextUpdateStrategy } from '@proj-airi/server-sdk'

import { wrapUntrusted } from '../../tools/web-search'

export const WORKSPACE_REFERENCE_TOKEN_REGEX = /(?<=^|\s)@([\w\-./]+)/g
const MAX_FILE_BYTES = 64 * 1024
const MAX_TOTAL_BYTES = 256 * 1024

export interface WorkspaceReferencePort {
  readFile: (path: string) => Promise<{ content: string, mtime?: string }>
  listDir: (path: string) => Promise<Array<{ name: string, kind: 'file' | 'dir' }>>
}

interface WorkspaceReferenceOptions {
  now?: () => number
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function truncateToBytes(text: string, limit: number): { text: string, bytes: number, truncated: boolean } {
  const bytes = encoder.encode(text)
  if (bytes.length <= limit)
    return { text, bytes: bytes.length, truncated: false }
  return {
    text: decoder.decode(bytes.subarray(0, limit)),
    bytes: limit,
    truncated: true,
  }
}

function contextMessage(path: string, text: string, createdAt: number, index: number): ContextMessage {
  return {
    id: `workspace-reference:${createdAt}:${index}`,
    contextId: `workspace:${path}`,
    lane: 'workspace',
    strategy: ContextUpdateStrategy.ReplaceSelf,
    text,
    createdAt,
  }
}

/**
 * Expands every workspace token into a bounded context message.
 *
 * The original user text stays unchanged. File and directory content enters
 * the prompt as untrusted data, while an unreadable path gets a short note.
 */
export async function expandWorkspaceReferences(
  text: string,
  port: WorkspaceReferencePort,
  options: WorkspaceReferenceOptions = {},
): Promise<ContextMessage[]> {
  const paths = [...new Set(Array.from(text.matchAll(WORKSPACE_REFERENCE_TOKEN_REGEX), match => match[1]))]
  const createdAt = options.now?.() ?? Date.now()
  const messages: ContextMessage[] = []
  let remainingBytes = MAX_TOTAL_BYTES

  for (const [index, path] of paths.entries()) {
    if (remainingBytes === 0) {
      messages.push(contextMessage(path, `Workspace reference @${path} was not expanded because the total ${MAX_TOTAL_BYTES}-byte budget is exhausted.`, createdAt, index))
      continue
    }

    try {
      const file = await port.readFile(path)
      const allowedBytes = Math.min(MAX_FILE_BYTES, remainingBytes)
      const bounded = truncateToBytes(file.content, allowedBytes)
      remainingBytes -= bounded.bytes
      const suffix = bounded.truncated ? `\n\n[truncated at ${allowedBytes} bytes]` : ''
      messages.push(contextMessage(path, wrapUntrusted(`${bounded.text}${suffix}`, `workspace:${path}`), createdAt, index))
      continue
    }
    catch (readError) {
      try {
        const entries = await port.listDir(path)
        const listing = entries
          .map(entry => `${entry.name}${entry.kind === 'dir' ? '/' : ''}`)
          .join('\n')
        const bounded = truncateToBytes(listing || '(empty directory)', remainingBytes)
        remainingBytes -= bounded.bytes
        const suffix = bounded.truncated ? `\n\n[truncated at the remaining ${bounded.bytes}-byte budget]` : ''
        messages.push(contextMessage(path, wrapUntrusted(`${bounded.text}${suffix}`, `workspace:${path}`), createdAt, index))
        continue
      }
      catch (listError) {
        const reason = errorMessageFrom(listError) ?? errorMessageFrom(readError) ?? 'unknown error'
        messages.push(contextMessage(path, `Workspace reference @${path} could not be read: ${reason}`, createdAt, index))
      }
    }
  }

  return messages
}
