import type { ElectronMainContextExtensions, ElectronMainEmitOptions } from '@moeru/eventa/adapters/electron/main'

import type { EventaWindowBroadcast } from '../../../libs/electron/eventa-window-broadcast'

import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as realSetTimeout } from 'node:timers/promises'

import { createContext, defineInvoke } from '@moeru/eventa'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  lifeModeClaimDecision,
  lifeModeGetSnapshot,
  lifeModeRecordGate,
  lifeModeRequestTestHeartbeat,
  lifeModeSetConfig,
} from '../../../../shared/eventa'
import { readPersistedLifeMode, setupLifeMode } from './index'

// The unreadable-file warning must reach the global logger: a bare
// `console.warn` never lands in `<userData>/logs`, so a reset configuration
// would leave no durable trace beyond the `.corrupt-*` copy.
const { loggWarn } = vi.hoisted(() => ({ loggWarn: vi.fn() }))

vi.mock('@guiiai/logg', () => ({
  useLogg: () => ({
    useGlobalConfig: () => ({
      debug: vi.fn(),
      warn: loggWarn,
      withError: () => ({ warn: loggWarn }),
      withFields: () => ({ debug: vi.fn(), warn: loggWarn }),
    }),
  }),
}))

const AUTONOMOUS_CONFIG = {
  mode: 'autonomous' as const,
  intervalMinutes: 1,
  quietHoursStart: 0,
  quietHoursEnd: 0,
  dailyBudget: 1,
  cooldownMinutes: 0,
}

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function createService() {
  const { tmpdir } = await import('node:os')
  const directory = await mkdtemp(join(tmpdir(), 'airi-life-mode-test-'))
  temporaryDirectories.push(directory)

  const heartbeats: Array<{ heartbeatId: string, reason: string }> = []
  const snapshots: Array<{ revision: number }> = []
  const context = createContext<ElectronMainContextExtensions, ElectronMainEmitOptions>()
  type EmitArgs = Parameters<typeof context.emit>
  const broadcastFn = vi.fn((...args: EmitArgs) => {
    const payload = args[1]
    if (typeof payload !== 'object' || payload === null)
      return
    if ('heartbeatId' in payload && typeof payload.heartbeatId === 'string' && 'reason' in payload && typeof payload.reason === 'string')
      heartbeats.push({ heartbeatId: payload.heartbeatId, reason: payload.reason })
    if ('config' in payload && 'revision' in payload && typeof payload.revision === 'number')
      snapshots.push({ revision: payload.revision })
  })
  const broadcast: EventaWindowBroadcast = { broadcast: broadcastFn, dispose: vi.fn() }
  const persistencePath = join(directory, 'life-mode.json')

  await setupLifeMode(context, {
    persistencePath,
    now: () => Date.now(),
    startupGraceMs: 30_000,
    broadcast,
  }, directory)

  return {
    claimDecision: defineInvoke(context, lifeModeClaimDecision),
    getSnapshot: defineInvoke(context, lifeModeGetSnapshot),
    recordGate: defineInvoke(context, lifeModeRecordGate),
    requestTestHeartbeat: defineInvoke(context, lifeModeRequestTestHeartbeat),
    setConfig: defineInvoke(context, lifeModeSetConfig),
    broadcastFn,
    directory,
    heartbeats,
    persistencePath,
    snapshots,
  }
}

describe('setupLifeMode', () => {
  it('does not schedule a heartbeat while life mode is off', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 4, 12))
    const service = await createService()

    expect(vi.getTimerCount()).toBe(0)
    expect(await service.getSnapshot()).toMatchObject({ config: { mode: 'off' } })
  })

  it('charges the daily budget only after the leader claims a heartbeat', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 4, 12))
    const service = await createService()
    await service.setConfig({ patch: AUTONOMOUS_CONFIG })

    await vi.advanceTimersByTimeAsync(60_000)
    await realSetTimeout(25)

    expect(service.heartbeats).toHaveLength(1)
    expect((await service.getSnapshot()).budgetUsed).toBe(0)

    const heartbeat = service.heartbeats[0]
    if (!heartbeat)
      throw new Error('Expected one emitted heartbeat.')

    const claimed = await service.claimDecision({ heartbeatId: heartbeat.heartbeatId })
    const duplicate = await service.claimDecision({ heartbeatId: heartbeat.heartbeatId })

    expect(claimed).toMatchObject({ claimed: true, snapshot: { budgetUsed: 1 } })
    expect(duplicate).toMatchObject({ claimed: false, gate: 'stale-heartbeat' })
    expect((await readPersistedLifeMode(service.persistencePath))?.budgetUsed).toBe(1)
  })

  it('broadcasts one authoritative snapshot after a follower changes config', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 4, 12))
    const service = await createService()

    const snapshot = await service.setConfig({ patch: { mode: 'autonomous', intervalMinutes: 5 } })

    expect(snapshot.config).toMatchObject({ mode: 'autonomous', intervalMinutes: 5 })
    expect(snapshot.revision).toBe(1)
    expect(service.snapshots.at(-1)).toEqual({ revision: 1 })
  })

  it('keeps the persisted next heartbeat after restart', async () => {
    vi.useFakeTimers()
    const now = new Date(2026, 8, 4, 12).getTime()
    vi.setSystemTime(now)
    const service = await createService()
    const nextHeartbeatAt = now + 8 * 60_000
    await writeFile(service.persistencePath, JSON.stringify({
      config: AUTONOMOUS_CONFIG,
      revision: 3,
      budgetUsed: 0,
      budgetDateKey: '',
      nextHeartbeatAt,
    }))

    const restarted = await createServiceFromPath(service.directory, service.persistencePath)

    expect((await restarted.getSnapshot()).nextHeartbeatAt).toBe(nextHeartbeatAt)
    await vi.advanceTimersByTimeAsync(7 * 60_000)
    expect(restarted.heartbeats).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(60_000)
    await realSetTimeout(25)
    expect(restarted.heartbeats).toHaveLength(1)
  })

  it('lets an explicit test heartbeat bypass schedule gates but still charge a decision', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 4, 12))
    const service = await createService()
    await service.setConfig({ patch: { ...AUTONOMOUS_CONFIG, quietHoursStart: 0, quietHoursEnd: 23 } })

    const requested = await service.requestTestHeartbeat()
    const heartbeat = service.heartbeats[0]

    expect(requested.emitted).toBe(true)
    expect(heartbeat?.reason).toBe('manual-test')
    expect(await service.claimDecision({ heartbeatId: heartbeat?.heartbeatId ?? '' })).toMatchObject({
      claimed: true,
      snapshot: { budgetUsed: 1 },
    })
  })

  it('mirrors a renderer-decided gate into the shared snapshot', async () => {
    // ROOT CAUSE:
    //
    // Gated heartbeats decided in the leader renderer wrote only its local
    // snapshot; a follower settings window read the main-process snapshot and
    // never saw busy/focused/flow-active/no-session gates (S03-S18,
    // 2026-09-10).
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 4, 12))
    const service = await createService()

    const snapshot = await service.recordGate({ gate: 'no-session' })

    expect(snapshot.lastGate).toBe('no-session')
    expect(service.snapshots.at(-1)).toEqual({ revision: 0 })
    expect((await readPersistedLifeMode(service.persistencePath))?.lastGate).toBe('no-session')
  })

  it('preserves an unreadable snapshot and logs the reason before falling back to defaults', async () => {
    // ROOT CAUSE:
    //
    // A corrupt life-mode.json silently fell back to defaults and was then
    // overwritten by the first persist, so an `autonomous` configuration
    // became `off` with no log and no file left to inspect (S03-S18,
    // 2026-09-10).
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 4, 12))
    const { tmpdir } = await import('node:os')
    const directory = await mkdtemp(join(tmpdir(), 'airi-life-mode-test-'))
    temporaryDirectories.push(directory)
    const persistencePath = join(directory, 'life-mode.json')
    await writeFile(persistencePath, '{"config": {"mode": "autonomous"')
    loggWarn.mockClear()

    const service = await createServiceFromPath(directory, persistencePath)

    expect((await service.getSnapshot()).config).toMatchObject({ mode: 'off' })
    expect(loggWarn).toHaveBeenCalledWith(expect.stringContaining('Ignoring unreadable'))
    expect(loggWarn).toHaveBeenCalledWith(expect.stringContaining('preserved a copy at'))
    const files = await readdir(directory)
    expect(files.some(name => name.startsWith('life-mode.json.corrupt-'))).toBe(true)
    expect(files.some(name => name.endsWith('.tmp'))).toBe(false)
  })
})

async function createServiceFromPath(directory: string, persistencePath: string) {
  const heartbeats: Array<{ heartbeatId: string, reason: string }> = []
  const context = createContext<ElectronMainContextExtensions, ElectronMainEmitOptions>()
  type EmitArgs = Parameters<typeof context.emit>
  const broadcast: EventaWindowBroadcast = {
    broadcast: (...args: EmitArgs) => {
      const payload = args[1]
      if (typeof payload === 'object' && payload !== null && 'heartbeatId' in payload && typeof payload.heartbeatId === 'string' && 'reason' in payload && typeof payload.reason === 'string')
        heartbeats.push({ heartbeatId: payload.heartbeatId, reason: payload.reason })
    },
    dispose: vi.fn(),
  }

  await setupLifeMode(context, {
    persistencePath,
    now: () => Date.now(),
    startupGraceMs: 30_000,
    broadcast,
  }, directory)

  return {
    getSnapshot: defineInvoke(context, lifeModeGetSnapshot),
    heartbeats,
  }
}
