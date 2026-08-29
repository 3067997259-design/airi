import type { MemoryDreamIdea, MemoryDreamIdeaStatus, MemoryExtraction, MemoryFragment, MemoryMood, MemoryRepository, MemoryReviewStatus, MemoryScoreWeights, ScoredMemoryFragment } from '@proj-airi/memory-core'

import { parseMemorySourceContext, scoreMemoryFragment, shouldPromoteMemory } from '@proj-airi/memory-core'

interface MemoryDbExecutor {
  execute: (query: string) => Promise<unknown>
}

type MemoryRow = Record<string, unknown>

function isRecord(value: unknown): value is MemoryRow {
  return typeof value === 'object' && value !== null
}

function rowsFromResult(result: unknown): MemoryRow[] {
  if (Array.isArray(result))
    return result.filter(isRecord)

  if (!isRecord(result) || !('toArray' in result) || typeof result.toArray !== 'function')
    return []

  const rows = result.toArray()
  return Array.isArray(rows) ? rows.filter(isRecord) : []
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function quote(value: string): string {
  return `'${value.replaceAll('\'', '\'\'')}'`
}

function jsonLiteral(value: unknown): string {
  return quote(JSON.stringify(value))
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string')
    return value

  try {
    return JSON.parse(value) as unknown
  }
  catch {
    return undefined
  }
}

function vectorLiteral(vector: number[]): string {
  if (vector.length !== 768)
    throw new Error(`Memory embeddings must contain 768 values, received ${vector.length}`)

  const values = vector.map(value => Number.isFinite(value) ? String(value) : '0')
  return `[${values.join(',')}]::FLOAT[768]`
}

function rowToFragment(row: MemoryRow): MemoryFragment {
  const sessionIds = stringValue(row.session_ids_json, '[]')
  let parsedSessionIds: string[] = []
  try {
    const parsed = JSON.parse(sessionIds) as unknown
    if (Array.isArray(parsed))
      parsedSessionIds = parsed.filter((value): value is string => typeof value === 'string')
  }
  catch {
    parsedSessionIds = []
  }

  const vector = row.content_vector_768
  const sourceContext = parseMemorySourceContext(parseJson(row.source_context_json))
  const reviewStatus = stringValue(row.review_status, '')
  return {
    id: stringValue(row.id),
    content: stringValue(row.content),
    memoryType: stringValue(row.memory_type) as MemoryFragment['memoryType'],
    category: stringValue(row.category),
    importance: numberValue(row.importance, 5),
    emotionalImpact: numberValue(row.emotional_impact),
    createdAt: numberValue(row.created_at),
    lastAccessed: numberValue(row.last_accessed),
    accessCount: numberValue(row.access_count, 1),
    valence: numberValue(row.valence),
    arousal: numberValue(row.arousal),
    halfLifeHours: numberValue(row.half_life_hours, 24),
    sessionIds: parsedSessionIds,
    triggerPattern: row.trigger_pattern == null ? null : stringValue(row.trigger_pattern),
    lastIntrudedAt: row.last_intruded_at == null ? null : numberValue(row.last_intruded_at),
    ...(reviewStatus ? { reviewStatus: reviewStatus as MemoryReviewStatus } : {}),
    contentVector: Array.isArray(vector) ? vector.filter((value): value is number => typeof value === 'number') : undefined,
    ...(sourceContext ? { sourceContext } : {}),
  }
}

function rowToDreamIdea(row: MemoryRow): MemoryDreamIdea {
  const vector = row.content_vector_768
  return {
    id: stringValue(row.id),
    content: stringValue(row.content),
    sourceType: stringValue(row.source_type, 'dream'),
    sourceId: row.source_id == null ? null : stringValue(row.source_id),
    status: stringValue(row.status, 'new') as MemoryDreamIdeaStatus,
    excitement: numberValue(row.excitement, 5),
    createdAt: numberValue(row.created_at),
    updatedAt: numberValue(row.updated_at),
    contentVector: Array.isArray(vector) ? vector.filter((value): value is number => typeof value === 'number') : undefined,
  }
}

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

/** Creates the browser DuckDB fallback for the storage-neutral memory contract. */
export function createDuckDbMemoryRepository(db: MemoryDbExecutor): MemoryRepository {
  async function search(input: {
    embedding: number[]
    now?: number
    mood?: MemoryMood
    limit?: number
    similarityThreshold?: number
    weights?: Partial<MemoryScoreWeights>
  }): Promise<ScoredMemoryFragment[]> {
    const limit = input.limit ?? 3
    const threshold = input.similarityThreshold ?? 0.5
    const vector = vectorLiteral(input.embedding)
    const result = await db.execute(`
      SELECT * FROM (
        SELECT id, content, memory_type, category, importance, emotional_impact,
          valence, arousal, half_life_hours, session_ids_json, trigger_pattern,
          last_intruded_at, created_at, last_accessed, access_count, review_status,
          content_vector_768, source_context_json,
          array_cosine_similarity(content_vector_768, ${vector}) AS similarity
        FROM memory_fragments
        WHERE deleted_at IS NULL
          AND review_status != 'rejected'
          AND memory_type != 'muscle'
          AND content_vector_768 IS NOT NULL
      ) candidates
      WHERE similarity > ${threshold}
      ORDER BY similarity DESC
      LIMIT ${Math.max(50, limit * 10)}
    `)

    return rowsFromResult(result)
      .map(row => scoreMemoryFragment({
        fragment: rowToFragment(row),
        similarity: numberValue(row.similarity),
        now: input.now ?? Date.now(),
        mood: input.mood,
        weights: input.weights,
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
  }

  async function insert(input: MemoryExtraction & { embedding?: number[], now?: number }): Promise<MemoryFragment> {
    if (!input.embedding)
      throw new Error('Memory inserts require an embedding')

    const now = input.now ?? Date.now()
    const id = createId()
    const triggerPattern = input.triggerPattern ?? null
    await db.execute(`
      INSERT INTO memory_fragments (
        id, content, memory_type, category, importance, emotional_impact,
        valence, arousal, half_life_hours, session_ids_json, trigger_pattern,
        created_at, last_accessed, access_count, review_status, content_vector_768, source_context_json
      ) VALUES (
        ${quote(id)}, ${quote(input.content.trim())}, ${quote(input.memoryType)},
        ${quote(input.category)}, ${Math.max(1, Math.min(10, input.importance))}, 0,
        ${Math.max(-1, Math.min(1, input.valence))}, ${Math.max(0, Math.min(1, input.arousal))},
        ${input.memoryType === 'muscle' ? 1e9 : input.halfLifeHours ?? 24}, ${jsonLiteral(input.sessionId ? [input.sessionId] : [])},
        ${triggerPattern == null ? 'NULL' : quote(triggerPattern)},
        ${now}, ${now}, 1, ${quote(input.reviewStatus ?? 'pending')}, ${vectorLiteral(input.embedding)}, ${jsonLiteral(input.sourceContext ?? {})}
      )
    `)
    for (const tag of input.tags) {
      await db.execute(`
        INSERT INTO memory_tags (id, memory_id, tag, created_at)
        VALUES (${quote(createId())}, ${quote(id)}, ${quote(tag)}, ${now})
      `)
    }
    if (input.episodic) {
      await db.execute(`
        INSERT INTO memory_episodic (id, memory_id, event_type, participants, location, created_at)
        VALUES (
          ${quote(createId())}, ${quote(id)}, ${quote(input.episodic.eventType)},
          ${jsonLiteral(input.episodic.participants)}, ${quote(input.episodic.location ?? '')}, ${now}
        )
      `)
    }

    return {
      id,
      content: input.content.trim(),
      memoryType: input.memoryType,
      category: input.category,
      importance: Math.max(1, Math.min(10, input.importance)),
      emotionalImpact: 0,
      createdAt: now,
      lastAccessed: now,
      accessCount: 1,
      valence: Math.max(-1, Math.min(1, input.valence)),
      arousal: Math.max(0, Math.min(1, input.arousal)),
      halfLifeHours: input.memoryType === 'muscle' ? 1e9 : input.halfLifeHours ?? 24,
      sessionIds: input.sessionId ? [input.sessionId] : [],
      triggerPattern,
      lastIntrudedAt: null,
      reviewStatus: input.reviewStatus ?? 'pending',
      contentVector: input.embedding,
      ...(input.sourceContext ? { sourceContext: input.sourceContext } : {}),
    }
  }

  async function recordAccess(input: { memoryIds: string[], sessionId?: string, now?: number }): Promise<void> {
    const now = input.now ?? Date.now()
    for (const id of input.memoryIds) {
      const rows = rowsFromResult(await db.execute(`SELECT session_ids_json FROM memory_fragments WHERE id = ${quote(id)} AND deleted_at IS NULL`))
      const current = rows[0] ? rowToFragment({ id, ...rows[0] }).sessionIds : []
      const sessionIds = input.sessionId && !current.includes(input.sessionId) ? [...current, input.sessionId] : current
      await db.execute(`
        UPDATE memory_fragments
        SET access_count = access_count + 1,
            last_accessed = ${now},
            session_ids_json = ${jsonLiteral(sessionIds)}
        WHERE id = ${quote(id)} AND deleted_at IS NULL
      `)
    }
  }

  async function promoteEligible(input: { minAccessCount?: number, minSessionCount?: number, halfLifeHours?: number } = {}): Promise<string[]> {
    const fragments = await list({ memoryType: 'short_term', limit: 10_000 })
    const eligible = fragments.filter(fragment => shouldPromoteMemory(fragment, input))
    for (const fragment of eligible) {
      await db.execute(`
        UPDATE memory_fragments
        SET memory_type = 'long_term', half_life_hours = ${input.halfLifeHours ?? 4_320}
        WHERE id = ${quote(fragment.id)} AND deleted_at IS NULL
      `)
    }
    return eligible.map(fragment => fragment.id)
  }

  async function list(input: { memoryType?: MemoryFragment['memoryType'], reviewStatus?: MemoryReviewStatus, limit?: number } = {}): Promise<MemoryFragment[]> {
    const typeFilter = input.memoryType ? `AND memory_type = ${quote(input.memoryType)}` : ''
    const statusFilter = input.reviewStatus ? `AND review_status = ${quote(input.reviewStatus)}` : ''
    const result = await db.execute(`
      SELECT id, content, memory_type, category, importance, emotional_impact,
        valence, arousal, half_life_hours, session_ids_json, trigger_pattern,
        last_intruded_at, created_at, last_accessed, access_count, review_status, content_vector_768, source_context_json
      FROM memory_fragments
      WHERE deleted_at IS NULL ${typeFilter} ${statusFilter}
      ORDER BY last_accessed DESC
      LIMIT ${input.limit ?? 100}
    `)
    return rowsFromResult(result).map(rowToFragment)
  }

  async function update(id: string, patch: Partial<Pick<MemoryFragment, 'content' | 'category' | 'importance' | 'valence' | 'arousal' | 'triggerPattern' | 'lastIntrudedAt' | 'reviewStatus' | 'contentVector'>>): Promise<MemoryFragment | undefined> {
    const assignments: string[] = []
    if (patch.content !== undefined)
      assignments.push(`content = ${quote(patch.content.trim())}`)
    if (patch.category !== undefined)
      assignments.push(`category = ${quote(patch.category)}`)
    if (patch.importance !== undefined)
      assignments.push(`importance = ${Math.max(1, Math.min(10, patch.importance))}`)
    if (patch.valence !== undefined)
      assignments.push(`valence = ${Math.max(-1, Math.min(1, patch.valence))}`)
    if (patch.arousal !== undefined)
      assignments.push(`arousal = ${Math.max(0, Math.min(1, patch.arousal))}`)
    if (patch.triggerPattern !== undefined)
      assignments.push(`trigger_pattern = ${patch.triggerPattern == null ? 'NULL' : quote(patch.triggerPattern)}`)
    if (patch.lastIntrudedAt !== undefined)
      assignments.push(`last_intruded_at = ${patch.lastIntrudedAt == null ? 'NULL' : String(patch.lastIntrudedAt)}`)
    if (patch.reviewStatus !== undefined)
      assignments.push(`review_status = ${quote(patch.reviewStatus)}`)
    if (patch.contentVector !== undefined)
      assignments.push(`content_vector_768 = ${vectorLiteral(patch.contentVector)}`)

    if (assignments.length === 0)
      return (await list({ limit: 10_000 })).find(fragment => fragment.id === id)

    await db.execute(`UPDATE memory_fragments SET ${assignments.join(', ')} WHERE id = ${quote(id)} AND deleted_at IS NULL`)
    return (await list({ limit: 10_000 })).find(fragment => fragment.id === id)
  }

  async function remove(id: string): Promise<void> {
    await db.execute(`UPDATE memory_fragments SET deleted_at = ${Date.now()} WHERE id = ${quote(id)} AND deleted_at IS NULL`)
  }

  async function addDreamIdea(input: Parameters<MemoryRepository['addDreamIdea']>[0]): Promise<MemoryDreamIdea> {
    const content = input.content.trim()
    if (!content)
      throw new Error('Dream ideas must not be empty')
    const now = input.now ?? Date.now()
    const id = createId()
    await db.execute(`
      INSERT INTO memory_short_term_ideas (
        id, content, source_type, source_id, status, excitement,
        created_at, updated_at, content_vector_768
      ) VALUES (
        ${quote(id)}, ${quote(content)}, ${quote(input.sourceType ?? 'dream')},
        ${input.sourceId == null ? 'NULL' : quote(input.sourceId)},
        'new', ${Math.max(0, Math.min(10, input.excitement ?? 5))},
        ${now}, ${now}, ${input.embedding ? vectorLiteral(input.embedding) : 'NULL'}
      )
    `)
    return {
      id,
      content,
      sourceType: input.sourceType ?? 'dream',
      sourceId: input.sourceId ?? null,
      status: 'new',
      excitement: Math.max(0, Math.min(10, input.excitement ?? 5)),
      createdAt: now,
      updatedAt: now,
      ...(input.embedding ? { contentVector: input.embedding } : {}),
    }
  }

  async function listDreamIdeas(input: { status?: MemoryDreamIdeaStatus, limit?: number } = {}): Promise<MemoryDreamIdea[]> {
    const statusFilter = input.status ? `AND status = ${quote(input.status)}` : ''
    const result = await db.execute(`
      SELECT id, content, source_type, source_id, status, excitement,
        created_at, updated_at, content_vector_768
      FROM memory_short_term_ideas
      WHERE deleted_at IS NULL ${statusFilter}
      ORDER BY updated_at DESC
      LIMIT ${input.limit ?? 100}
    `)
    return rowsFromResult(result).map(rowToDreamIdea)
  }

  async function updateDreamIdea(id: string, patch: Partial<Pick<MemoryDreamIdea, 'content' | 'status' | 'excitement' | 'contentVector'>>): Promise<MemoryDreamIdea | undefined> {
    const assignments: string[] = []
    if (patch.content !== undefined) {
      const content = patch.content.trim()
      if (!content)
        throw new Error('Dream ideas must not be empty')
      assignments.push(`content = ${quote(content)}`)
    }
    if (patch.status !== undefined)
      assignments.push(`status = ${quote(patch.status)}`)
    if (patch.excitement !== undefined)
      assignments.push(`excitement = ${Math.max(0, Math.min(10, patch.excitement))}`)
    if (patch.contentVector !== undefined)
      assignments.push(`content_vector_768 = ${vectorLiteral(patch.contentVector)}`)
    if (assignments.length > 0) {
      assignments.push(`updated_at = ${Date.now()}`)
      await db.execute(`UPDATE memory_short_term_ideas SET ${assignments.join(', ')} WHERE id = ${quote(id)} AND deleted_at IS NULL`)
    }
    return (await listDreamIdeas({ limit: 10_000 })).find(idea => idea.id === id)
  }

  return { search, insert, recordAccess, promoteEligible, list, update, remove, addDreamIdea, listDreamIdeas, updateDreamIdea }
}
