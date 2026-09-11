import type { ElectronMainContextExtensions, ElectronMainEmitOptions } from '@moeru/eventa/adapters/electron/main'

import type { RestoreBootstrap } from '../../../../shared/eventa/data-backup'
import type { EventaWindowBroadcast } from '../../../libs/electron/eventa-window-broadcast'

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createContext, defineInvoke } from '@moeru/eventa'
import { createDataBackup } from '@proj-airi/stage-ui/services/data-backup'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { backupAdopt, backupAdopted, backupBootstrap, backupComplete } from '../../../../shared/eventa'
import { setupDataBackupHost } from './index'
import { prepareRestoreProfile } from './profiles'

vi.mock('electron', () => ({
  app: {
    exit: vi.fn(),
    getAppPath: () => '/app',
    getVersion: () => 'test',
    relaunch: vi.fn(),
  },
}))

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function createArchive(ownerId: string) {
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
      { path: 'identity/settings.json', domain: 'identity', data: bytes('[]') },
      { path: 'chats/sessions.json', domain: 'chats', data: bytes(chats) },
      { path: 'plans/plans.json', domain: 'plans', data: bytes('[]') },
      { path: 'skills/registry.json', domain: 'skills', data: bytes('[]') },
      { path: 'outbox/held.json', domain: 'outbox', data: bytes(outbox) },
      ...memory.map(table => ({ path: `memory/${table}.parquet`, domain: 'memory' as const, data: new Uint8Array() })),
    ],
  })
}

async function createHost(ownerId: string) {
  const parent = await mkdtemp(join(tmpdir(), 'airi-data-backup-test-'))
  directories.push(parent)
  const profile = await prepareRestoreProfile(parent, await createArchive(ownerId))
  const context = createContext<ElectronMainContextExtensions, ElectronMainEmitOptions>()
  const emit = vi.spyOn(context, 'emit')
  const broadcast: EventaWindowBroadcast = {
    broadcast: vi.fn(),
    dispose: vi.fn(),
  }
  await setupDataBackupHost(context, profile, { broadcast })

  const bootstrap = defineInvoke(context, backupBootstrap)
  const complete = defineInvoke(context, backupComplete)
  const adopt = defineInvoke(context, backupAdopt)

  return { adopt, bootstrap, broadcast, complete, emit }
}

describe('setupDataBackupHost adoption', () => {
  it('broadcasts adoption to every renderer so the leader releases its effect hold', async () => {
    // ROOT CAUSE:
    //
    // Adoption is clicked in the settings window, a follower. The plain main
    // context echoes `backupAdopted` only to the invoking renderer, so the
    // leader never released its restore effect hold: schedules stayed empty
    // and the goal scheduler never re-initialized after adoption
    // (ACC-20260910 R04).
    const host = await createHost('restored-owner')
    const started: RestoreBootstrap = await host.bootstrap({ leader: true })
    expect(started.restored).toBe(true)
    await host.complete({ snapshotId: 'restore-test' })

    const adopted = host.adopt()
    await adopted

    expect(host.broadcast.broadcast).toHaveBeenCalledWith(backupAdopted, undefined)
    expect(host.emit.mock.calls.filter(([event]) => event === backupAdopted)).toHaveLength(0)
  })

  it('carries the restored owner identity on every bootstrap so a follower can show it', async () => {
    const host = await createHost('restored-owner')
    const started: RestoreBootstrap = await host.bootstrap({ leader: true })

    expect(started).toMatchObject({ restored: true, ownerId: 'restored-owner' })
  })
})
