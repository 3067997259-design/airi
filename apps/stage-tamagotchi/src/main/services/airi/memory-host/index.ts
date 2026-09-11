/**
 * Memory host service (MAINTENANCE-PLAN P2.4).
 *
 * The Electron main-process owner of the long-term Postgres/pgvector store.
 * Follows the coding-host pattern: Eventa invoke contracts, connection state
 * held here, renderers ship embeddings they computed locally because the
 * embed worker only runs in a browser context. Unconfigured or failing
 * connections degrade to `status: 'unconfigured' | 'error'` — the local
 * DuckDB memory layer stays authoritative regardless.
 *
 * The last successful connection string is persisted next to the app config
 * and re-applied at boot, so long-term mirroring resumes without a manual
 * visit to the settings page (the container itself is kept alive by the
 * compose `restart: unless-stopped` policy).
 */
import type { createContext as createMainEventaContext } from '@moeru/eventa/adapters/electron/main'

import type { MemoryHostFragment, MemoryHostInsertParams, MemoryHostListParams, MemoryHostRemoveParams, MemoryHostSearchParams, MemoryHostStatus, MemoryHostUpdateParams } from '../../../../shared/eventa'

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { defineInvokeHandler } from '@moeru/eventa'
import { errorMessageFrom } from '@moeru/std'
import { connectMemoryRepository, ensureMemorySchema } from '@proj-airi/memory-pgvector/repository'

import {
  memoryHostConfigure,
  memoryHostGetStatus,
  memoryHostInsert,
  memoryHostList,
  memoryHostRemove,
  memoryHostSearch,
  memoryHostUpdate,
} from '../../../../shared/eventa'

export interface MemoryHostOptions {
  /** Overrides the persisted connection string at boot (env fallback). */
  connectionString?: string
  /** Overrides where the last successful connection string is stored. */
  persistencePath?: string
}

interface MemoryHostConnection {
  repository: {
    search: (input: { embedding: number[], limit?: number, weights?: Record<string, number>, embeddingMetadata?: MemoryHostSearchParams['embeddingMetadata'], scope?: MemoryHostSearchParams['scope'] }) => Promise<MemoryHostFragment[]>
    insert: (input: MemoryHostRepositoryInsertParams) => Promise<MemoryHostFragment>
    list: (input?: MemoryHostListParams) => Promise<MemoryHostFragment[]>
    updateByOriginId: (originId: string, patch: MemoryHostUpdateParams['patch']) => Promise<MemoryHostFragment | undefined>
    removeByOriginId: (originId: string) => Promise<void>
  }
  close: () => Promise<void>
}

type MemoryHostRepositoryInsertParams = MemoryHostInsertParams & { tags: string[] }

const PERSISTED_FILE_NAME = 'memory-host.json'

function memoryScopeOf(value: unknown): MemoryHostFragment['scope'] {
  if (typeof value !== 'object' || value === null)
    return undefined
  const scope = value as Record<string, unknown>
  if (typeof scope.userId !== 'string' || typeof scope.characterId !== 'string')
    return undefined
  return { userId: scope.userId, characterId: scope.characterId }
}

function memorySourceContextOf(value: unknown): MemoryHostFragment['sourceContext'] {
  if (typeof value !== 'object' || value === null)
    return undefined
  const source = value as Record<string, unknown>
  if (typeof source.sessionId !== 'string' || !Array.isArray(source.neighbors))
    return undefined
  const neighbors = source.neighbors.filter((neighbor): neighbor is string => typeof neighbor === 'string')
  return {
    sessionId: source.sessionId,
    ...(typeof source.messageId === 'string' ? { messageId: source.messageId } : {}),
    ...(typeof source.sourceEventId === 'string' ? { sourceEventId: source.sourceEventId } : {}),
    ...(typeof source.sourceType === 'string' ? { sourceType: source.sourceType } : {}),
    neighbors,
  }
}

function persistencePathFor(userDataDir: string): string {
  return join(userDataDir, PERSISTED_FILE_NAME)
}

/** Reads the last successful connection string; missing file means none. */
export async function readPersistedConnectionString(path: string): Promise<string | undefined> {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as { connectionString?: unknown }
    return typeof parsed.connectionString === 'string' && parsed.connectionString.trim()
      ? parsed.connectionString
      : undefined
  }
  catch {
    return undefined
  }
}

/** Persists (or clears) the last successful connection string. */
export async function writePersistedConnectionString(path: string, connectionString: string | undefined): Promise<void> {
  try {
    if (!connectionString) {
      await rm(path, { force: true })
      return
    }
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify({ connectionString }, null, 2), 'utf8')
  }
  catch {
    // Persistence is a convenience: a failed write only costs the auto
    // reconnect on next boot, never the current connection.
  }
}

export async function setupMemoryHost(
  context: ReturnType<typeof createMainEventaContext>['context'],
  options: MemoryHostOptions = {},
  userDataDir: string,
): Promise<void> {
  const persistencePath = persistencePathFor(userDataDir)

  let connection: MemoryHostConnection | undefined
  let lastError: string | undefined

  function fragmentToHost(fragment: Record<string, unknown>): MemoryHostFragment {
    const scope = memoryScopeOf(fragment.scope)
    const sourceContext = memorySourceContextOf(fragment.sourceContext)
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
      ...(fragment.factStatus ? { factStatus: String(fragment.factStatus) } : {}),
      ...(fragment.supersedesId ? { supersedesId: String(fragment.supersedesId) } : {}),
      ...(fragment.conflictGroup ? { conflictGroup: String(fragment.conflictGroup) } : {}),
      ...(fragment.originId ? { originId: String(fragment.originId) } : {}),
      ...(scope ? { scope } : {}),
      ...(sourceContext ? { sourceContext } : {}),
      ...(Array.isArray(fragment.sessionIds) ? { sessionIds: fragment.sessionIds.map(String) } : {}),
      ...(fragment.embeddingProvider ? { embeddingProvider: String(fragment.embeddingProvider) } : {}),
      ...(fragment.embeddingModel ? { embeddingModel: String(fragment.embeddingModel) } : {}),
      ...(fragment.embeddingDimensions ? { embeddingDimensions: Number(fragment.embeddingDimensions) } : {}),
      ...(fragment.embeddingInputType ? { embeddingInputType: String(fragment.embeddingInputType) as 'query' | 'document' } : {}),
      ...(fragment.embeddingSourceFingerprint ? { embeddingSourceFingerprint: String(fragment.embeddingSourceFingerprint) } : {}),
      ...(fragment.embeddedAt ? { embeddedAt: Number(fragment.embeddedAt) } : {}),
      ...(fragment.embeddingStatus ? { embeddingStatus: String(fragment.embeddingStatus) as 'active' | 'stale' } : {}),
      ...(fragment.score !== undefined ? { score: Number(fragment.score) } : {}),
    }
  }

  async function configure(connectionString?: string, persist = true): Promise<MemoryHostStatus> {
    const previous = connection
    connection = undefined
    await previous?.close().catch(() => {})

    if (!connectionString?.trim()) {
      lastError = undefined
      if (persist)
        await writePersistedConnectionString(persistencePath, undefined)
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
      if (persist)
        await writePersistedConnectionString(persistencePath, connectionString.trim())
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
      ...(params.embeddingMetadata ? { embeddingMetadata: params.embeddingMetadata } : {}),
      ...(params.scope ? { scope: params.scope } : {}),
    })
    return scored.map(fragment => fragmentToHost(fragment as unknown as Record<string, unknown>))
  })

  defineInvokeHandler(context, memoryHostInsert, async (params: MemoryHostInsertParams) => {
    if (!connection)
      throw new Error('Memory host is not configured')
    // The renderer mirror contract intentionally carries no tag projection;
    // the repository insert contract still expects a concrete tag list.
    const fragment = await connection.repository.insert({ ...params, tags: [] })
    return fragmentToHost(fragment as unknown as Record<string, unknown>)
  })

  defineInvokeHandler(context, memoryHostUpdate, async ({ originId, patch }: MemoryHostUpdateParams) => {
    if (!connection)
      throw new Error('Memory host is not configured')
    const fragment = await connection.repository.updateByOriginId(originId, patch)
    return fragment ? fragmentToHost(fragment as unknown as Record<string, unknown>) : undefined
  })

  defineInvokeHandler(context, memoryHostRemove, async ({ originId }: MemoryHostRemoveParams) => {
    if (!connection)
      throw new Error('Memory host is not configured')
    await connection.repository.removeByOriginId(originId)
    return { removed: true }
  })

  // Boot order: explicit env override wins, then the persisted connection
  // string from the last successful configure. A boot failure (e.g. the
  // Docker daemon is down) degrades to status 'error' — the app works
  // without the long-term store and the next successful configure heals it.
  const bootConnectionString = options.connectionString?.trim() || await readPersistedConnectionString(persistencePath)
  if (bootConnectionString)
    await configure(bootConnectionString, false)
}
