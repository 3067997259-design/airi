/**
 * Memory host service (MAINTENANCE-PLAN P2.4).
 *
 * The Electron main-process owner of the long-term Postgres/pgvector store.
 * Follows the coding-host pattern: Eventa invoke contracts, connection state
 * held here, renderers ship embeddings they computed locally because the
 * embed worker only runs in a browser context. Unconfigured or failing
 * connections degrade to `status: 'unconfigured' | 'error'` — the local
 * DuckDB memory layer stays authoritative regardless.
 */
import type { createContext as createMainEventaContext } from '@moeru/eventa/adapters/electron/main'

import type { MemoryHostFragment, MemoryHostInsertParams, MemoryHostListParams, MemoryHostSearchParams, MemoryHostStatus } from '../../../../shared/eventa'

import { defineInvokeHandler } from '@moeru/eventa'
import { errorMessageFrom } from '@moeru/std'
import { connectMemoryRepository, ensureMemorySchema } from '@proj-airi/memory-pgvector/repository'

import {
  memoryHostConfigure,
  memoryHostGetStatus,
  memoryHostInsert,
  memoryHostList,
  memoryHostSearch,
} from '../../../../shared/eventa'

export interface MemoryHostOptions {
  /** Overrides the persisted connection string at boot (env fallback). */
  connectionString?: string
}

interface MemoryHostConnection {
  repository: {
    search: (input: { embedding: number[], limit?: number, weights?: Record<string, number> }) => Promise<MemoryHostFragment[]>
    insert: (input: MemoryHostInsertParams) => Promise<MemoryHostFragment>
    list: (input?: MemoryHostListParams) => Promise<MemoryHostFragment[]>
  }
  close: () => Promise<void>
}

export async function setupMemoryHost(
  context: ReturnType<typeof createMainEventaContext>['context'],
  options: MemoryHostOptions = {},
): Promise<void> {
  let connection: MemoryHostConnection | undefined
  let lastError: string | undefined

  function fragmentToHost(fragment: Record<string, unknown>): MemoryHostFragment {
    return {
      id: String(fragment.id),
      content: String(fragment.content),
      memoryType: String(fragment.memoryType),
      category: String(fragment.category),
      importance: Number(fragment.importance),
      createdAt: Number(fragment.createdAt),
      lastAccessed: Number(fragment.lastAccessed),
      accessCount: Number(fragment.accessCount),
      ...(fragment.reviewStatus ? { reviewStatus: String(fragment.reviewStatus) } : {}),
      ...(Array.isArray(fragment.sessionIds) ? { sessionIds: fragment.sessionIds.map(String) } : {}),
      ...(fragment.score !== undefined ? { score: Number(fragment.score) } : {}),
    }
  }

  async function configure(connectionString?: string): Promise<MemoryHostStatus> {
    const previous = connection
    connection = undefined
    await previous?.close().catch(() => {})

    if (!connectionString?.trim()) {
      lastError = undefined
      return { status: 'unconfigured' }
    }

    try {
      // The DDL never shipped anywhere, so the host ensures the schema on
      // every configure; all statements are idempotent.
      await ensureMemorySchema(connectionString.trim())
      const next = connectMemoryRepository(connectionString.trim()) as unknown as MemoryHostConnection
      // Fail fast on unreachable hosts instead of reporting ready.
      await next.repository.list({ limit: 1 })
      connection = next
      lastError = undefined
      return { status: 'ready' }
    }
    catch (error) {
      lastError = errorMessageFrom(error) ?? 'Failed to connect memory host'
      return { status: 'error', error: lastError }
    }
  }

  defineInvokeHandler(context, memoryHostConfigure, async ({ connectionString }) => await configure(connectionString))
  defineInvokeHandler(context, memoryHostGetStatus, () => ({ status: connection ? 'ready' : lastError ? 'error' : 'unconfigured', ...(lastError ? { error: lastError } : {}) }) as MemoryHostStatus)

  defineInvokeHandler(context, memoryHostList, async (params) => {
    if (!connection)
      throw new Error('Memory host is not configured')
    const fragments = await connection.repository.list((params ?? {}) as MemoryHostListParams)
    return fragments.map(fragment => fragmentToHost(fragment as unknown as Record<string, unknown>))
  })

  defineInvokeHandler(context, memoryHostSearch, async (params: MemoryHostSearchParams) => {
    if (!connection)
      throw new Error('Memory host is not configured')
    const scored = await connection.repository.search({
      embedding: params.embedding,
      ...(params.limit ? { limit: params.limit } : {}),
      ...(params.weights ? { weights: params.weights } : {}),
    })
    return scored.map(fragment => fragmentToHost(fragment as unknown as Record<string, unknown>))
  })

  defineInvokeHandler(context, memoryHostInsert, async (params: MemoryHostInsertParams) => {
    if (!connection)
      throw new Error('Memory host is not configured')
    const fragment = await connection.repository.insert(params)
    return fragmentToHost(fragment as unknown as Record<string, unknown>)
  })

  // Boot-time configuration: persisted renderer settings arrive through the
  // configure invoke; the env var is a headless fallback.
  const bootConnectionString = options.connectionString?.trim()
  if (bootConnectionString)
    await configure(bootConnectionString)
}
