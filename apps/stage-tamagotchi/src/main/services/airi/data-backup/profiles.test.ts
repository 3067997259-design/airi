import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createDataBackup } from '@proj-airi/stage-ui/services/data-backup'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createProfileRestore, prepareRestoreProfile } from './profiles'

const directories: string[] = []

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, writeFile: vi.fn(fs.writeFile) }
})

afterEach(async () => {
  vi.mocked(writeFile).mockClear()
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function createArchive(ownerId = 'local') {
  const card = {
    name: 'Test',
    version: '1',
    extensions: { airi: { modules: {
      consciousness: { provider: '', model: '' },
      vision: { provider: '', model: '' },
      speech: { provider: '', model: '', voice_id: '' },
    }, agents: {} } },
  }
  const identity = JSON.stringify({ userId: ownerId, activeCardId: 'card', cards: [['card', card]] })
  const chats = JSON.stringify({ format: 'chat-sessions-index:v1', index: { userId: ownerId, characters: {} }, sessions: {} })
  const settings = JSON.stringify([])
  const skills = JSON.stringify([])
  const outbox = JSON.stringify({ userId: ownerId, memory: [], chat: [], tombstones: [] })
  const bytes = (value: string) => new TextEncoder().encode(value)
  const memory = ['memory_fragments', 'memory_tags', 'memory_episodic', 'memory_long_term_goals', 'memory_short_term_ideas']
  return createDataBackup({
    snapshotId: 'restore-test',
    buildId: 'test-build',
    createdAt: 1,
    coverage: ['journal'],
    missing: ['memory'],
    prerequisites: [],
    entries: [
      { path: 'journal/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jsonl', domain: 'journal', data: bytes('') },
      { path: 'identity/cards.json', domain: 'identity', data: bytes(identity) },
      { path: 'identity/settings.json', domain: 'identity', data: bytes(settings) },
      { path: 'chats/sessions.json', domain: 'chats', data: bytes(chats) },
      { path: 'plans/plans.json', domain: 'plans', data: bytes('[]') },
      { path: 'skills/registry.json', domain: 'skills', data: bytes(skills) },
      { path: 'outbox/held.json', domain: 'outbox', data: bytes(outbox) },
      ...memory.map(table => ({ path: `memory/${table}.parquet`, domain: 'memory' as const, data: new Uint8Array() })),
    ],
  })
}

describe('isolated restore profiles', () => {
  it('allows another claim when writing the importing marker fails', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'airi-restore-test-'))
    directories.push(parent)
    const profile = await prepareRestoreProfile(parent, await createArchive())
    const restore = await createProfileRestore(profile)
    vi.mocked(writeFile).mockRejectedValueOnce(new Error('disk full'))
    await expect(restore.begin(true)).rejects.toThrow('disk full')
    const marker = JSON.parse(await readFile(join(profile, 'restore-state.json'), 'utf8')) as { state: string }
    expect(marker.state).toBe('pending')
    expect((await restore.begin(true)).data).toBeInstanceOf(Uint8Array)
  })

  it('propagates import failure to followers and preserves the failed receipt', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'airi-restore-test-'))
    directories.push(parent)
    const profile = await prepareRestoreProfile(parent, await createArchive())
    const restore = await createProfileRestore(profile)
    const follower = expect(restore.begin(false)).rejects.toThrow('incomplete')
    await restore.begin(true)
    await expect(restore.complete('wrong-snapshot')).rejects.toThrow('receipt')
    await restore.complete('restore-test', 'owner import failed')
    await follower
    await expect(restore.complete('restore-test', 'owner import failed')).resolves.toBeUndefined()
    await expect(restore.complete('restore-test')).rejects.toThrow('receipt')
    const restarted = await createProfileRestore(profile)
    await expect(restarted.begin(true)).rejects.toThrow('incomplete')
  })

  it('accepts a repeated matching receipt after its response is lost', async () => {
    // ROOT CAUSE:
    // The host persisted completion before returning the IPC response. A lost
    // response made the renderer retry, but the host rejected its own receipt.
    const parent = await mkdtemp(join(tmpdir(), 'airi-restore-test-'))
    directories.push(parent)
    const profile = await prepareRestoreProfile(parent, await createArchive())
    const restore = await createProfileRestore(profile)
    await restore.begin(true)
    await restore.complete('restore-test')
    await expect(restore.complete('restore-test')).resolves.toBeUndefined()
    const restarted = await createProfileRestore(profile)
    await expect(restarted.complete('restore-test')).resolves.toBeUndefined()
    await expect(restarted.complete('wrong-snapshot')).rejects.toThrow('receipt')
    await expect(restarted.complete('restore-test', 'late failure')).rejects.toThrow('receipt')
  })

  it('keeps followers waiting if the completion marker cannot be written', async () => {
    // ROOT CAUSE:
    // The in-memory marker advanced before the durable write. A write failure
    // let later bootstrap calls observe completion without a durable receipt.
    const parent = await mkdtemp(join(tmpdir(), 'airi-restore-test-'))
    directories.push(parent)
    const profile = await prepareRestoreProfile(parent, await createArchive())
    const restore = await createProfileRestore(profile)
    await restore.begin(true)
    let followerReleased = false
    const follower = restore.begin(false).then(() => {
      followerReleased = true
    })
    vi.mocked(writeFile).mockRejectedValueOnce(new Error('disk full'))
    await expect(restore.complete('restore-test')).rejects.toThrow('disk full')
    expect(followerReleased).toBe(false)
    await expect(restore.begin(true)).rejects.toThrow('already claimed')
    await restore.complete('restore-test')
    await follower
    expect(followerReleased).toBe(true)
    const restarted = await createProfileRestore(profile)
    await expect(restarted.begin(true)).resolves.toMatchObject({ restored: true, effectsHeld: true })
  })

  it('reports the archived owner on every bootstrap so an unauthenticated profile can name it', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'airi-restore-test-'))
    directories.push(parent)
    const profile = await prepareRestoreProfile(parent, await createArchive('restored-owner'))
    const restore = await createProfileRestore(profile)

    await expect(restore.begin(true)).resolves.toMatchObject({ restored: true, ownerId: 'restored-owner' })
    await restore.complete('restore-test')
    await expect(restore.begin(false)).resolves.toMatchObject({ restored: true, effectsHeld: true, ownerId: 'restored-owner' })
  })

  it('persists explicit adoption so a later boot does not re-hold effects', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'airi-restore-test-'))
    directories.push(parent)
    const profile = await prepareRestoreProfile(parent, await createArchive())
    const restore = await createProfileRestore(profile)
    await restore.begin(true)
    await restore.complete('restore-test')

    await restore.adopt()
    const marker = JSON.parse(await readFile(join(profile, 'restore-state.json'), 'utf8')) as { effectsHeld: boolean }
    expect(marker.effectsHeld).toBe(false)
    const restarted = await createProfileRestore(profile)
    await expect(restarted.begin(true)).resolves.toMatchObject({ restored: true, effectsHeld: false })
    await expect(restarted.adopt()).resolves.toBeUndefined()
  })

  it('publishes a pending marker only after staging succeeds', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'airi-restore-test-'))
    directories.push(parent)
    const profile = await prepareRestoreProfile(parent, await createArchive())
    const marker = JSON.parse(await readFile(join(profile, 'restore-state.json'), 'utf8')) as { state: string, snapshotId: string }
    expect(marker.state).toBe('pending')
    expect(marker.snapshotId).toBe('restore-test')
  })

  it('claims once and records a failed receipt', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'airi-restore-test-'))
    directories.push(parent)
    const profile = await prepareRestoreProfile(parent, await createArchive())
    const restore = await createProfileRestore(profile)
    const claimed = await restore.begin(true)
    expect(claimed.restored).toBe(true)
    await expect(restore.begin(true)).rejects.toThrow('already claimed')
    await restore.complete('restore-test', 'import failed')
    const marker = JSON.parse(await readFile(join(profile, 'restore-state.json'), 'utf8')) as { state: string, error: string }
    expect(marker.state).toBe('failed')
    expect(marker.error).toBe('import failed')
  })

  it('does not reuse an interrupted restore after restart', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'airi-restore-test-'))
    directories.push(parent)
    const profile = await prepareRestoreProfile(parent, await createArchive())
    const restore = await createProfileRestore(profile)
    await restore.begin(true)
    const restarted = await createProfileRestore(profile)
    await expect(restarted.begin(true)).rejects.toThrow('incomplete')
    await writeFile(join(profile, 'restore-state.json'), JSON.stringify({ state: 'failed', snapshotId: 'restore-test', workspaceRoot: join(profile, 'workspace') }))
  })
})
