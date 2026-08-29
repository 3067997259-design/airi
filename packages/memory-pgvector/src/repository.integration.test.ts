import { describe, expect, it } from 'vitest'

import { connectMemoryRepository, ensureMemorySchema } from './repository'

// Integration walkthrough against a real Postgres (pgvector) database.
// Skips unless DATABASE_URL points at a reachable server — the local
// workflow is `docker compose -f server/docker-compose.yaml up -d db` with
// the credentials from that compose file, then:
//   DATABASE_URL=postgresql://... pnpm -F @proj-airi/memory-pgvector exec vitest run src/repository.integration.test.ts
const connectionString = process.env.DATABASE_URL?.trim()
const vector = (seed: number) => Array.from({ length: 768 }, (_, i) => Math.sin(seed + i / 50) * 0.5)

describe.skipIf(!connectionString)('memory repository (real Postgres)', () => {
  it('ensures the schema, then inserts, searches, lists, and removes a fragment', { timeout: 60_000 }, async () => {
    await ensureMemorySchema(connectionString!)
    const { repository, close } = connectMemoryRepository(connectionString!)

    try {
      const inserted = await repository.insert({
        content: 'pgvector integration walkthrough fragment',
        memoryType: 'short_term',
        category: 'chat',
        importance: 5,
        valence: 0,
        arousal: 0.1,
        halfLifeHours: 24,
        reviewStatus: 'approved',
        tags: [],
        embedding: vector(1),
        now: Date.now(),
      })
      expect(inserted.id).toBeTruthy()
      expect(inserted.reviewStatus).toBe('approved')

      const scored = await repository.search({ embedding: vector(1), limit: 3 })
      const hit = scored.find(fragment => fragment.id === inserted.id)
      expect(hit, 'inserted fragment should be returned by vector search').toBeDefined()

      const listed = await repository.list({ memoryType: 'short_term', limit: 100 })
      expect(listed.some(fragment => fragment.id === inserted.id)).toBe(true)

      await repository.remove(inserted.id)
      const afterRemoval = await repository.list({ memoryType: 'short_term', limit: 100 })
      expect(afterRemoval.some(fragment => fragment.id === inserted.id)).toBe(false)
    }
    finally {
      await close()
    }
  })
})
