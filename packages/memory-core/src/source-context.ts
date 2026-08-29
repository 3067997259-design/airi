import type { MemorySourceContext } from './types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

const MAX_SOURCE_NEIGHBORS = 4
const MAX_SOURCE_NEIGHBOR_LENGTH = 600

/**
 * Reads persisted source context from a JSON value.
 *
 * @example
 * parseMemorySourceContext({ sessionId: 'session-1', neighbors: ['User: hello'] })
 * // => { sessionId: 'session-1', neighbors: ['User: hello'] }
 */
export function parseMemorySourceContext(value: unknown): MemorySourceContext | undefined {
  if (!isRecord(value) || typeof value.sessionId !== 'string' || !Array.isArray(value.neighbors))
    return undefined

  const neighbors = value.neighbors
    .filter((neighbor): neighbor is string => typeof neighbor === 'string' && neighbor.trim().length > 0)
    .map(neighbor => neighbor.slice(0, MAX_SOURCE_NEIGHBOR_LENGTH))
    .slice(0, MAX_SOURCE_NEIGHBORS)
  const messageId = typeof value.messageId === 'string' && value.messageId.length > 0
    ? value.messageId
    : undefined

  return {
    sessionId: value.sessionId,
    ...(messageId ? { messageId } : {}),
    neighbors,
  }
}
