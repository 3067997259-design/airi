import type { MemoryDreamIdea, MemoryDreamIdeaStatus, MemoryFragment, MemoryMood, MemoryRepository, MemoryScoreWeights, ScoredMemoryFragment } from '@proj-airi/memory-core'
import type { SQL } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

import postgres from 'postgres'

import { calculateMemoryTimeRelevance, parseMemorySourceContext, scoreMemoryFragment } from '@proj-airi/memory-core'
import { and, cosineDistance, desc, eq, gt, isNull, ne, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'

import { memoryEpisodicTable, memoryFragmentsTable, memorySchema, memoryShortTermIdeasTable, memoryTagsTable } from './schema'

type MemoryDatabase = PostgresJsDatabase<typeof memorySchema>
type MemoryFragmentRow = typeof memoryFragmentsTable.$inferSelect
type MemoryDreamIdeaRow = typeof memoryShortTermIdeasTable.$inferSelect

export interface MemoryPgvectorConnection {
  repository: MemoryRepository
  close: () => Promise<void>
}

function toMemoryFragment(row: MemoryFragmentRow): MemoryFragment {
  const sourceContext = parseMemorySourceContext(row.metadata?.sourceContext)
  return {
    id: row.id,
    content: row.content,
    memoryType: row.memory_type as MemoryFragment['memoryType'],
    category: row.category,
    importance: row.importance,
    emotionalImpact: row.emotional_impact,
    createdAt: row.created_at,
    lastAccessed: row.last_accessed,
    accessCount: row.access_count,
    valence: row.valence,
    arousal: row.arousal,
    halfLifeHours: row.half_life_hours,
    sessionIds: row.session_ids,
    triggerPattern: row.trigger_pattern,
    lastIntrudedAt: row.last_intruded_at,
    ...(row.review_status ? { reviewStatus: row.review_status as MemoryFragment['reviewStatus'] } : {}),
    contentVector: row.content_vector_768 ?? undefined,
    ...(sourceContext ? { sourceContext } : {}),
  }
}

function toMemoryDreamIdea(row: MemoryDreamIdeaRow): MemoryDreamIdea {
  return {
    id: row.id,
    content: row.content,
    sourceType: row.source_type,
    sourceId: row.source_id,
    status: row.status as MemoryDreamIdeaStatus,
    excitement: row.excitement,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    contentVector: row.content_vector_768 ?? undefined,
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min))
}

function fragmentValues(input: Parameters<MemoryRepository['insert']>[0], now: number) {
  return {
    content: input.content.trim(),
    memory_type: input.memoryType,
    category: input.category,
    importance: clamp(input.importance, 1, 10),
    valence: clamp(input.valence, -1, 1),
    arousal: clamp(input.arousal, 0, 1),
    half_life_hours: input.memoryType === 'muscle' ? 1e9 : input.halfLifeHours ?? 24,
    session_ids: input.sessionId ? [input.sessionId] : [],
    trigger_pattern: input.triggerPattern,
    review_status: input.reviewStatus ?? 'pending',
    created_at: now,
    last_accessed: now,
    access_count: 1,
    metadata: input.sourceContext ? { sourceContext: input.sourceContext } : {},
    content_vector_768: input.embedding,
  }
}

/** Creates a memory repository over an existing Drizzle Postgres connection. */
export function createMemoryRepository(db: MemoryDatabase): MemoryRepository {
  async function search(input: {
    embedding: number[]
    now?: number
    mood?: MemoryMood
    limit?: number
    similarityThreshold?: number
    weights?: Partial<MemoryScoreWeights>
  }): Promise<ScoredMemoryFragment[]> {
    const limit = input.limit ?? 3
    const similarityThreshold = input.similarityThreshold ?? 0.5
    const now = input.now ?? Date.now()
    const similarity = sql<number>`(1 - ${cosineDistance(memoryFragmentsTable.content_vector_768, input.embedding)})`
    const rows = await db
      .select({
        fragment: memoryFragmentsTable,
        similarity,
      })
      .from(memoryFragmentsTable)
      .where(and(
        ne(memoryFragmentsTable.memory_type, 'muscle'),
        ne(memoryFragmentsTable.review_status, 'rejected'),
        isNull(memoryFragmentsTable.deleted_at),
        gt(similarity, similarityThreshold),
      ))
      .orderBy(desc(similarity))
      .limit(Math.max(limit * 10, 50))

    return rows
      .map(row => scoreMemoryFragment({
        fragment: toMemoryFragment(row.fragment),
        similarity: row.similarity,
        now,
        mood: input.mood,
        weights: input.weights,
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
  }

  async function insert(input: Parameters<MemoryRepository['insert']>[0]): Promise<MemoryFragment> {
    const now = input.now ?? Date.now()
    const values = fragmentValues(input, now)
    const [row] = await db.insert(memoryFragmentsTable).values(values).returning()
    if (!row)
      throw new Error('Memory insert did not return a fragment')

    if (input.tags.length > 0) {
      await db.insert(memoryTagsTable).values(input.tags.map(tag => ({
        memory_id: row.id,
        tag,
        created_at: now,
      })))
    }

    if (input.episodic) {
      await db.insert(memoryEpisodicTable).values({
        memory_id: row.id,
        event_type: input.episodic.eventType,
        participants: input.episodic.participants,
        location: input.episodic.location,
        created_at: now,
      })
    }

    return toMemoryFragment(row)
  }

  async function recordAccess(input: { memoryIds: string[], sessionId?: string, now?: number }): Promise<void> {
    const now = input.now ?? Date.now()
    for (const memoryId of input.memoryIds) {
      const sessionIds: SQL<unknown> = input.sessionId
        ? sql`CASE WHEN ${memoryFragmentsTable.session_ids} ? ${input.sessionId} THEN ${memoryFragmentsTable.session_ids} ELSE ${memoryFragmentsTable.session_ids} || ${JSON.stringify([input.sessionId])}::jsonb END`
        : sql`${memoryFragmentsTable.session_ids}`

      await db.update(memoryFragmentsTable)
        .set({
          access_count: sql`${memoryFragmentsTable.access_count} + 1`,
          last_accessed: now,
          session_ids: sessionIds,
        })
        .where(and(eq(memoryFragmentsTable.id, memoryId), isNull(memoryFragmentsTable.deleted_at)))
    }
  }

  async function promoteEligible(input: { minAccessCount?: number, minSessionCount?: number, halfLifeHours?: number } = {}): Promise<string[]> {
    const minAccessCount = input.minAccessCount ?? 3
    const minSessionCount = input.minSessionCount ?? 2
    const halfLifeHours = input.halfLifeHours ?? 4_320
    const rows = await db.update(memoryFragmentsTable)
      .set({
        memory_type: 'long_term',
        half_life_hours: halfLifeHours,
      })
      .where(and(
        eq(memoryFragmentsTable.memory_type, 'short_term'),
        eq(memoryFragmentsTable.review_status, 'approved'),
        isNull(memoryFragmentsTable.deleted_at),
        gt(memoryFragmentsTable.access_count, minAccessCount - 1),
        gt(sql`jsonb_array_length(${memoryFragmentsTable.session_ids})`, minSessionCount - 1),
      ))
      .returning({ id: memoryFragmentsTable.id })

    return rows.map(row => row.id)
  }

  async function list(input: { memoryType?: MemoryFragment['memoryType'], reviewStatus?: MemoryFragment['reviewStatus'], limit?: number } = {}): Promise<MemoryFragment[]> {
    const filters = [isNull(memoryFragmentsTable.deleted_at)]
    if (input.memoryType)
      filters.push(eq(memoryFragmentsTable.memory_type, input.memoryType))
    if (input.reviewStatus)
      filters.push(eq(memoryFragmentsTable.review_status, input.reviewStatus))

    const rows = await db.select()
      .from(memoryFragmentsTable)
      .where(and(...filters))
      .orderBy(desc(memoryFragmentsTable.last_accessed))
      .limit(input.limit ?? 100)

    return rows.map(toMemoryFragment)
  }

  async function update(id: string, patch: Partial<Pick<MemoryFragment, 'content' | 'category' | 'importance' | 'valence' | 'arousal' | 'triggerPattern' | 'lastIntrudedAt' | 'reviewStatus' | 'contentVector'>>): Promise<MemoryFragment | undefined> {
    const [row] = await db.update(memoryFragmentsTable)
      .set({
        content: patch.content,
        category: patch.category,
        importance: patch.importance == null ? undefined : clamp(patch.importance, 1, 10),
        valence: patch.valence == null ? undefined : clamp(patch.valence, -1, 1),
        arousal: patch.arousal == null ? undefined : clamp(patch.arousal, 0, 1),
        trigger_pattern: patch.triggerPattern,
        last_intruded_at: patch.lastIntrudedAt,
        review_status: patch.reviewStatus,
        content_vector_768: patch.contentVector,
      })
      .where(and(eq(memoryFragmentsTable.id, id), isNull(memoryFragmentsTable.deleted_at)))
      .returning()

    return row ? toMemoryFragment(row) : undefined
  }

  async function remove(id: string): Promise<void> {
    await db.update(memoryFragmentsTable)
      .set({ deleted_at: Date.now() })
      .where(and(eq(memoryFragmentsTable.id, id), isNull(memoryFragmentsTable.deleted_at)))
  }

  async function addDreamIdea(input: Parameters<MemoryRepository['addDreamIdea']>[0]): Promise<MemoryDreamIdea> {
    const content = input.content.trim()
    if (!content)
      throw new Error('Dream ideas must not be empty')
    const now = input.now ?? Date.now()
    const [row] = await db.insert(memoryShortTermIdeasTable).values({
      content,
      source_type: input.sourceType ?? 'dream',
      source_id: input.sourceId,
      status: 'new',
      excitement: clamp(input.excitement ?? 5, 0, 10),
      created_at: now,
      updated_at: now,
      content_vector_768: input.embedding,
    }).returning()
    if (!row)
      throw new Error('Dream idea insert did not return an idea')
    return toMemoryDreamIdea(row)
  }

  async function listDreamIdeas(input: { status?: MemoryDreamIdeaStatus, limit?: number } = {}): Promise<MemoryDreamIdea[]> {
    const filters = [isNull(memoryShortTermIdeasTable.deleted_at)]
    if (input.status)
      filters.push(eq(memoryShortTermIdeasTable.status, input.status))
    const rows = await db.select()
      .from(memoryShortTermIdeasTable)
      .where(and(...filters))
      .orderBy(desc(memoryShortTermIdeasTable.updated_at))
      .limit(input.limit ?? 100)
    return rows.map(toMemoryDreamIdea)
  }

  async function updateDreamIdea(id: string, patch: Partial<Pick<MemoryDreamIdea, 'content' | 'status' | 'excitement' | 'contentVector'>>): Promise<MemoryDreamIdea | undefined> {
    const updates: Partial<typeof memoryShortTermIdeasTable.$inferInsert> = { updated_at: Date.now() }
    if (patch.content !== undefined) {
      const content = patch.content.trim()
      if (!content)
        throw new Error('Dream ideas must not be empty')
      updates.content = content
    }
    if (patch.status !== undefined)
      updates.status = patch.status
    if (patch.excitement !== undefined)
      updates.excitement = clamp(patch.excitement, 0, 10)
    if (patch.contentVector !== undefined)
      updates.content_vector_768 = patch.contentVector

    await db.update(memoryShortTermIdeasTable)
      .set(updates)
      .where(and(eq(memoryShortTermIdeasTable.id, id), isNull(memoryShortTermIdeasTable.deleted_at)))
    return (await listDreamIdeas({ limit: 10_000 })).find(idea => idea.id === id)
  }

  return { search, insert, recordAccess, promoteEligible, list, update, remove, addDreamIdea, listDreamIdeas, updateDreamIdea }
}

/** Opens a Postgres connection and creates a memory repository over it. */
export function connectMemoryRepository(connectionString: string): MemoryPgvectorConnection {
  const client = postgres(connectionString)
  const db = drizzle(client, { schema: memorySchema })
  return {
    repository: createMemoryRepository(db),
    close: async () => {
      await client.end()
    },
  }
}

/**
 * Creates the memory tables, vector extension, and indexes when missing.
 *
 * No migration script ships with the package, and the schema below mirrors
 * `schema.ts` one-to-one; embedders of different dimensions can coexist, so
 * all three vector columns are always created.
 */
export async function ensureMemorySchema(connectionString: string): Promise<void> {
  const client = postgres(connectionString)
  try {
    await client`CREATE EXTENSION IF NOT EXISTS vector`
    await client`CREATE TABLE IF NOT EXISTS memory_fragments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      content text NOT NULL,
      memory_type text NOT NULL,
      category text NOT NULL,
      importance integer NOT NULL DEFAULT 5,
      emotional_impact integer NOT NULL DEFAULT 0,
      valence real NOT NULL DEFAULT 0,
      arousal real NOT NULL DEFAULT 0,
      half_life_hours real NOT NULL DEFAULT 24,
      session_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
      trigger_pattern text,
      last_intruded_at bigint,
      review_status text NOT NULL DEFAULT 'pending',
      created_at bigint NOT NULL DEFAULT 0,
      last_accessed bigint NOT NULL DEFAULT 0,
      access_count integer NOT NULL DEFAULT 1,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      content_vector_1536 vector(1536),
      content_vector_1024 vector(1024),
      content_vector_768 vector(768),
      deleted_at bigint
    )`
    await client`CREATE TABLE IF NOT EXISTS memory_tags (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      memory_id uuid NOT NULL REFERENCES memory_fragments (id) ON DELETE CASCADE,
      tag text NOT NULL,
      created_at bigint NOT NULL DEFAULT 0,
      deleted_at bigint
    )`
    await client`CREATE TABLE IF NOT EXISTS memory_episodic (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      memory_id uuid NOT NULL REFERENCES memory_fragments (id) ON DELETE CASCADE,
      event_type text NOT NULL,
      participants jsonb NOT NULL DEFAULT '[]'::jsonb,
      location text DEFAULT '',
      created_at bigint NOT NULL DEFAULT 0,
      deleted_at bigint
    )`
    await client`CREATE TABLE IF NOT EXISTS memory_long_term_goals (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      title text NOT NULL,
      description text NOT NULL,
      priority integer NOT NULL DEFAULT 5,
      progress integer NOT NULL DEFAULT 0,
      deadline bigint,
      status text NOT NULL DEFAULT 'planned',
      parent_goal_id uuid,
      category text NOT NULL DEFAULT 'personal',
      created_at bigint NOT NULL DEFAULT 0,
      updated_at bigint NOT NULL DEFAULT 0,
      deleted_at bigint
    )`
    await client`CREATE TABLE IF NOT EXISTS memory_short_term_ideas (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      content text NOT NULL,
      source_type text NOT NULL DEFAULT 'dream',
      source_id text,
      status text NOT NULL DEFAULT 'new',
      excitement integer NOT NULL DEFAULT 5,
      created_at bigint NOT NULL DEFAULT 0,
      updated_at bigint NOT NULL DEFAULT 0,
      content_vector_1536 vector(1536),
      content_vector_1024 vector(1024),
      content_vector_768 vector(768),
      deleted_at bigint
    )`
    await client`CREATE INDEX IF NOT EXISTS memory_items_content_vector_1536_index ON memory_fragments USING hnsw (content_vector_1536 vector_cosine_ops)`
    await client`CREATE INDEX IF NOT EXISTS memory_items_content_vector_1024_index ON memory_fragments USING hnsw (content_vector_1024 vector_cosine_ops)`
    await client`CREATE INDEX IF NOT EXISTS memory_items_content_vector_768_index ON memory_fragments USING hnsw (content_vector_768 vector_cosine_ops)`
    await client`CREATE INDEX IF NOT EXISTS memory_items_memory_type_index ON memory_fragments (memory_type)`
    await client`CREATE INDEX IF NOT EXISTS memory_items_category_index ON memory_fragments (category)`
    await client`CREATE INDEX IF NOT EXISTS memory_items_importance_index ON memory_fragments (importance)`
    await client`CREATE INDEX IF NOT EXISTS memory_items_created_at_index ON memory_fragments (created_at)`
    await client`CREATE INDEX IF NOT EXISTS memory_items_last_accessed_index ON memory_fragments (last_accessed)`
    await client`CREATE INDEX IF NOT EXISTS memory_tags_memory_id_index ON memory_tags (memory_id)`
    await client`CREATE INDEX IF NOT EXISTS memory_tags_tag_index ON memory_tags (tag)`
    await client`CREATE INDEX IF NOT EXISTS memory_episodic_memory_id_index ON memory_episodic (memory_id)`
    await client`CREATE INDEX IF NOT EXISTS memory_episodic_event_type_index ON memory_episodic (event_type)`
    await client`CREATE INDEX IF NOT EXISTS memory_short_term_ideas_content_vector_768_index ON memory_short_term_ideas USING hnsw (content_vector_768 vector_cosine_ops)`
    await client`CREATE INDEX IF NOT EXISTS memory_short_term_ideas_status_index ON memory_short_term_ideas (status)`
  }
  finally {
    await client.end()
  }
}

export { calculateMemoryTimeRelevance }
