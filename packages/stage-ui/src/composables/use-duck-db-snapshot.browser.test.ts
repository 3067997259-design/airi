import { afterEach, describe, expect, it } from 'vitest'

import { createDuckDbMemoryRepository } from '../services/memory/local-memory'
import { useDuckDb } from './use-duck-db'

const originalUrl = location.href

afterEach(async () => {
  await useDuckDb().closeDb()
  history.replaceState(null, '', originalUrl)
})

describe('memory snapshot owner', () => {
  it('restores native table values and rolls back damaged snapshots in an empty target', async () => {
    const url = new URL(location.href)
    url.searchParams.set('synced-leader', 'true')
    history.replaceState(null, '', url)
    const owner = useDuckDb()
    const database = await owner.getDb()
    const tables = ['memory_fragments', 'memory_tags', 'memory_episodic', 'memory_long_term_goals', 'memory_short_term_ideas'] as const
    await database.value!.execute(`
      INSERT INTO memory_fragments
        (id, content, memory_type, category, created_at, last_accessed, review_status,
         fact_status, supersedes_id, origin_id, scope_json, source_context_json,
         content_vector_json, embedding_provider, embedding_model, embedding_dimensions,
         embedding_input_type, embedding_source_fingerprint, embedding_status)
      VALUES
        ('fact-old', '旧事实', 'long_term', 'life', 1, 2, 'approved', 'superseded', NULL,
         'origin-old', '{"userId":"local","characterId":"card"}', '{"sessionId":"session","messageId":"message-old"}',
         '[0.25,0.75]', 'fixture', 'old-model', 2, 'document', 'old-space', 'stale'),
        ('fact-source', '纠正后的事实', 'long_term', 'life', 3, 4, 'approved', 'active', 'fact-old',
         'origin-new', '{"userId":"local","characterId":"card"}', '{"sessionId":"session","messageId":"message-new"}',
         '[0.5,0.5]', 'fixture', 'new-model', 2, 'document', 'new-space', 'active'),
        ('skill-muscle', '已审技能的调用方法', 'muscle', 'coding', 5, 6, 'approved', 'active', NULL,
         'origin-skill', '{"userId":"local","characterId":"card"}', '{"toolId":"reviewed-skill","contentHash":"fixture-hash"}',
         NULL, NULL, NULL, NULL, NULL, NULL, NULL)
    `)
    await database.value!.execute(`INSERT INTO memory_tags (id, memory_id, tag, created_at) VALUES ('snapshot-tag', 'fact-source', '中文标签', 9007199254740993)`)
    await database.value!.execute(`
      INSERT INTO memory_episodic (id, memory_id, event_type, participants, location, created_at)
      VALUES ('episode', 'fact-source', 'collaboration', '["local","card"]', 'workspace', 7)
    `)
    await database.value!.execute(`
      INSERT INTO memory_long_term_goals
        (id, session_id, title, description, created_at, updated_at, horizon, spec_json, state_json)
      VALUES ('goal', 'session', '恢复验证', '保留目标与旧运行的关系', 8, 9, 'long',
        '{"goal":"恢复验证","horizon":"long","steps":[],"scope":{"userId":"local","characterId":"card"}}',
        '{"completedSteps":[],"failedSteps":[],"skippedSteps":[],"longGoal":{"goalId":"goal","lifecycle":"waiting-condition","constraintVersion":3,"lastRun":{"taskId":"task","flowId":"flow","sessionId":"session"}}}')
    `)
    await database.value!.execute(`
      INSERT INTO memory_short_term_ideas (id, content, source_type, source_id, created_at, updated_at, scope_json)
      VALUES ('idea', '对已发生事件的后续想法', 'dream', 'fact-source', 10, 11, '{"userId":"local","characterId":"card"}'),
        ('other-idea', '另一个角色的想法', 'dream', NULL, 10, 12, '{"userId":"local","characterId":"other"}'),
        ('unowned-idea', '归属未知', 'dream', NULL, 10, 13, NULL)
    `)
    const scopedIdeas = await createDuckDbMemoryRepository(database.value!).listDreamIdeas({ scope: { userId: 'local', characterId: 'card' }, limit: 1 })
    expect(scopedIdeas.map(idea => idea.id)).toEqual(['idea'])
    expect(scopedIdeas[0]?.scope).toEqual({ userId: 'local', characterId: 'card' })
    const before: string[][] = []
    for (const table of tables) {
      const rows = await (await database.value!.$client).conn.query(`SELECT to_json(t) AS row FROM ${table} t ORDER BY id`)
      before.push(rows.toArray().map(row => String(row.row)))
    }
    const snapshot = await owner.exportSnapshot()
    expect(snapshot).toHaveLength(5)
    await expect(owner.importSnapshot(snapshot)).rejects.toThrow('empty profile')

    // This browser test has its own temporary origin. Clear its fixture to
    // exercise the empty-target contract without touching a user profile.
    for (const table of tables)
      await database.value!.execute(`DELETE FROM ${table}`)
    const damaged = snapshot.map(entry => entry.path.endsWith('memory_long_term_goals.parquet') ? { ...entry, data: new Uint8Array([0, 1, 2]) } : entry)
    await expect(owner.importSnapshot(damaged)).rejects.toThrow()
    // A damaged later table must roll back earlier imported facts and their
    // relationships, not merely the table whose Parquet decoder failed.
    for (const table of tables) {
      const afterFailure = await (await database.value!.$client).conn.query(`SELECT count(*) AS count FROM ${table}`)
      expect(Number(afterFailure.toArray()[0]?.count)).toBe(0)
    }

    await owner.importSnapshot(snapshot)
    await owner.closeDb()
    const reopened = await owner.getDb()
    const after: string[][] = []
    for (const table of tables) {
      const rows = await (await reopened.value!.$client).conn.query(`SELECT to_json(t) AS row FROM ${table} t ORDER BY id`)
      after.push(rows.toArray().map(row => String(row.row)))
    }
    expect(after).toEqual(before)
    const restored = await (await reopened.value!.$client).conn.query('SELECT id, memory_id, tag, created_at FROM memory_tags')
    expect(restored.toArray()[0]?.id).toBe('snapshot-tag')
    expect(restored.toArray()[0]?.memory_id).toBe('fact-source')
    expect(restored.toArray()[0]?.tag).toBe('中文标签')
    expect(restored.toArray()[0]?.created_at).toBe(9007199254740993n)
    for (const table of tables)
      await reopened.value!.execute(`DELETE FROM ${table}`)
  }, 60_000)
})
