import { describe, expect, it, vi } from 'vitest'

import { createMemoryRepository } from './repository'

const EMBEDDING = Array.from(new Uint8Array(768))

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    content: 'A durable fact',
    memory_type: 'short_term',
    category: 'chat',
    importance: 5,
    emotional_impact: 0,
    valence: 0,
    arousal: 0,
    half_life_hours: 24,
    session_ids: [],
    trigger_pattern: null,
    last_intruded_at: null,
    review_status: 'pending',
    created_at: 1,
    last_accessed: 1,
    access_count: 1,
    metadata: {},
    content_vector_1536: null,
    content_vector_1024: null,
    content_vector_768: EMBEDDING,
    deleted_at: null,
    ...overrides,
  }
}

describe('pgvector memory repository', () => {
  it('defaults a fresh extraction to pending human review', async () => {
    const values = vi.fn((input: Record<string, unknown>) => ({
      returning: async () => [row(input)],
    }))
    const repository = createMemoryRepository({
      insert: vi.fn(() => ({ values })),
    } as never)

    const fragment = await repository.insert({
      content: 'A durable fact',
      category: 'chat',
      memoryType: 'short_term',
      importance: 5,
      valence: 0,
      arousal: 0,
      tags: [],
      embedding: EMBEDDING,
      now: 1,
    })

    expect(values).toHaveBeenCalledWith(expect.objectContaining({ review_status: 'pending' }))
    expect(fragment.reviewStatus).toBe('pending')
  })

  it('updates content and its embedding in one database write', async () => {
    const set = vi.fn((patch: Record<string, unknown>) => ({
      where: () => ({ returning: async () => [row({ content: patch.content, content_vector_768: patch.content_vector_768 })] }),
    }))
    const repository = createMemoryRepository({
      update: vi.fn(() => ({ set })),
    } as never)

    await repository.update('00000000-0000-0000-0000-000000000001', {
      content: 'Updated fact',
      contentVector: EMBEDDING,
    })

    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      content: 'Updated fact',
      content_vector_768: EMBEDDING,
    }))
  })
})
