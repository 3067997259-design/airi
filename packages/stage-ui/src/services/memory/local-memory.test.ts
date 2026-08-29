import { describe, expect, it, vi } from 'vitest'

import { createDuckDbMemoryRepository } from './local-memory'

const EMBEDDING = Array.from(new Uint8Array(768))

function memoryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'memory-1',
    content: 'A durable fact',
    memory_type: 'short_term',
    category: 'chat',
    importance: 5,
    emotional_impact: 0,
    valence: 0.4,
    arousal: 0.5,
    half_life_hours: 24,
    session_ids_json: '["session-1"]',
    trigger_pattern: null,
    last_intruded_at: null,
    created_at: 1,
    last_accessed: 1,
    access_count: 1,
    content_vector_768: EMBEDDING,
    source_context_json: JSON.stringify({
      sessionId: 'session-1',
      messageId: 'message-1',
      neighbors: ['Assistant: Earlier context'],
    }),
    similarity: 0.9,
    ...overrides,
  }
}

describe('createDuckDbMemoryRepository', () => {
  it('restores source-turn neighbors from persisted search rows', async () => {
    const execute = vi.fn<(query: string) => Promise<unknown[]>>(async (query: string) => query.includes('SELECT * FROM') ? [memoryRow()] : [])
    const repository = createDuckDbMemoryRepository({ execute })

    const results = await repository.search({
      embedding: EMBEDDING,
      now: 1,
    })

    expect(results[0]?.sourceContext).toEqual({
      sessionId: 'session-1',
      messageId: 'message-1',
      neighbors: ['Assistant: Earlier context'],
    })
  })

  it('writes source-turn neighbors with the memory fragment', async () => {
    const execute = vi.fn<(query: string) => Promise<unknown[]>>(async (_query: string) => [])
    const repository = createDuckDbMemoryRepository({ execute })
    const sourceContext = {
      sessionId: 'session-1',
      messageId: 'message-1',
      neighbors: ['User: Earlier context'],
    }

    await repository.insert({
      content: 'A durable fact',
      category: 'chat',
      memoryType: 'short_term',
      importance: 5,
      valence: 0,
      arousal: 0,
      tags: ['important'],
      episodic: {
        eventType: 'conversation',
        participants: ['user'],
        location: 'home',
      },
      sessionId: 'session-1',
      sourceContext,
      embedding: EMBEDDING,
      now: 1,
    })

    const insertQuery = execute.mock.calls.find(([query]) => query.includes('INSERT INTO memory_fragments'))?.[0]
    expect(insertQuery).toContain('source_context_json')
    expect(insertQuery).toContain('Earlier context')
    expect(insertQuery).toContain('\'pending\'')
    expect(execute.mock.calls.some(([query]) => query.includes('INSERT INTO memory_tags'))).toBe(true)
    expect(execute.mock.calls.some(([query]) => query.includes('INSERT INTO memory_episodic'))).toBe(true)
  })

  // ROOT CAUSE:
  //
  // Editing memory content changed only the text column. Semantic retrieval
  // kept comparing queries against the embedding of the old text.
  it('updates content and its embedding in one repository write', async () => {
    const execute = vi.fn<(query: string) => Promise<unknown[]>>(async (query: string) => query.includes('SELECT id') ? [memoryRow({ content: 'Updated fact' })] : [])
    const repository = createDuckDbMemoryRepository({ execute })

    await repository.update('memory-1', {
      content: 'Updated fact',
      contentVector: EMBEDDING,
    })

    const updateQuery = execute.mock.calls.find(([query]) => query.includes('UPDATE memory_fragments SET'))?.[0]
    expect(updateQuery).toContain('content = \'Updated fact\'')
    expect(updateQuery).toContain('content_vector_768 = [')
  })

  it('keeps dream ideas in their own short-term table', async () => {
    const execute = vi.fn<(query: string) => Promise<unknown[]>>(async (query: string) => query.includes('FROM memory_short_term_ideas')
      ? [{
          id: 'idea-1',
          content: 'Try a smaller build loop',
          source_type: 'dream-pass',
          source_id: 'memory-1',
          status: 'new',
          excitement: 7,
          created_at: 1,
          updated_at: 1,
          content_vector_768: EMBEDDING,
        }]
      : [])
    const repository = createDuckDbMemoryRepository({ execute })

    const idea = await repository.addDreamIdea({
      content: 'Try a smaller build loop',
      sourceType: 'dream-pass',
      sourceId: 'memory-1',
      excitement: 7,
      embedding: EMBEDDING,
      now: 1,
    })

    expect(idea.status).toBe('new')
    expect(idea.sourceType).toBe('dream-pass')
    expect(execute.mock.calls.some(([query]) => query.includes('INSERT INTO memory_short_term_ideas'))).toBe(true)
    expect((await repository.listDreamIdeas())[0]?.content).toBe('Try a smaller build loop')
  })
})
