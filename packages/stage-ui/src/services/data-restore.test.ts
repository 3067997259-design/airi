import type { DataBackupDomain, DataBackupManifest, InspectedDataBackup } from './data-backup'

import { contentHashOf } from '@proj-airi/skill-forge'
import { describe, expect, it } from 'vitest'

import { OPENCODE_ADAPTER_SKELETON } from '../stores/skills'
import { checkRestoreData } from './data-restore'

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))

function manifest(entries: InspectedDataBackup['entries']): DataBackupManifest {
  return {
    format: 'airi-data-backup',
    version: 1,
    snapshotId: 'skill-restore-fixture',
    createdAt: 1,
    buildId: 'test',
    credentials: 'excluded',
    outbox: 'held',
    coverage: ['identity', 'chats', 'plans', 'skills', 'memory', 'outbox'] satisfies DataBackupDomain[],
    missing: [],
    prerequisites: [],
    entries: entries.map(entry => ({
      path: entry.path,
      domain: entry.domain,
      bytes: entry.data.byteLength,
      sha256: '0'.repeat(64),
    })),
  }
}

function restoreFixture(selftest: string, messages: unknown[] = []): InspectedDataBackup {
  const card = {
    name: 'Restored character',
    version: '1',
    extensions: { airi: { modules: {
      consciousness: { provider: '', model: '' },
      vision: { provider: '', model: '' },
      speech: { provider: '', model: '', voice_id: '' },
    }, agents: {} } },
  }
  const meta = { sessionId: 'session-1', userId: 'local', characterId: 'card-1', createdAt: 1, updatedAt: 1 }
  const source = 'export function run(input) { return input }'
  const skill = {
    ...OPENCODE_ADAPTER_SKELETON,
    toolId: 'fixture-skill',
    trust: 'probation' as const,
    contentHash: contentHashOf(source),
    workspaceRoot: 'D:/workspace',
    selftest: { contentHash: contentHashOf(selftest), logs: ['ok'], traceCount: 1 },
  }
  const entries: InspectedDataBackup['entries'] = [
    { path: 'identity/cards.json', domain: 'identity', data: bytes({ userId: 'local', activeCardId: 'card-1', cards: [['card-1', card]] }) },
    { path: 'identity/settings.json', domain: 'identity', data: bytes([]) },
    { path: 'chats/sessions.json', domain: 'chats', data: bytes({
      format: 'chat-sessions-index:v1',
      index: { userId: 'local', characters: { 'card-1': { activeSessionId: meta.sessionId, sessions: { [meta.sessionId]: meta } } } },
      sessions: { [meta.sessionId]: { meta, messages } },
    }) },
    { path: 'plans/plans.json', domain: 'plans', data: bytes([]) },
    { path: 'skills/registry.json', domain: 'skills', data: bytes([skill]) },
    { path: 'skills/fixture-skill/source.mjs', domain: 'skills', data: new TextEncoder().encode(source) },
    { path: 'skills/fixture-skill/meta.json', domain: 'skills', data: bytes({}) },
    { path: 'skills/fixture-skill/selftest.mjs', domain: 'skills', data: new TextEncoder().encode(selftest) },
    { path: 'outbox/held.json', domain: 'outbox', data: bytes({ userId: 'local', memory: [], chat: [], tombstones: [] }) },
    ...['memory_fragments', 'memory_tags', 'memory_episodic', 'memory_long_term_goals', 'memory_short_term_ideas'].map(table => ({
      path: `memory/${table}.parquet`,
      domain: 'memory' as const,
      data: new Uint8Array(),
    })),
  ]
  return { manifest: manifest(entries), entries }
}

describe('restore skill artifacts', () => {
  it('accepts persisted AIRI error messages', () => {
    const fixture = restoreFixture('const source = await bridge("read", ["skills/fixture-skill/source.mjs"]); return source', [
      { id: 'error-1', role: 'error', content: 'provider unavailable', createdAt: 2 },
    ])

    expect(() => checkRestoreData(fixture)).not.toThrow()
  })

  it('accepts a self-test whose evidence hash matches selftest.mjs', () => {
    const selftest = 'const source = await bridge("read", ["skills/fixture-skill/source.mjs"]); return source'

    expect(() => checkRestoreData(restoreFixture(selftest))).not.toThrow()
  })

  it('rejects a changed self-test artifact without rejecting the source review', () => {
    const fixture = restoreFixture('const source = await bridge("read", ["skills/fixture-skill/source.mjs"]); return source')
    const entry = fixture.entries.find(item => item.path === 'skills/fixture-skill/selftest.mjs')!
    entry.data = new TextEncoder().encode('const changed = true')

    expect(() => checkRestoreData(fixture)).toThrow('Skill self-test does not match its recorded evidence')
  })
})
