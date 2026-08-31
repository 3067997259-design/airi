import type { LifeModeConfigContract } from '../../../../shared/eventa'
import type { EventaWindowBroadcast } from '../../../libs/electron/eventa-window-broadcast'

import type { ElectronMainContextExtensions, ElectronMainEmitOptions } from '@moeru/eventa/adapters/electron/main'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as realSetTimeout } from 'node:timers/promises'

import { createContext, defineInvoke } from '@moeru/eventa'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  lifeModeConsumeTick,
  lifeModeGetConfig,
  lifeModeSetConfig,
} from '../../../../shared/eventa'
import { readPersistedLifeMode, setupLifeMode } from './index'
import { evaluateLifeTickGate } from './gates'

const BASE_CONFIG: LifeModeConfigContract = {
  mode: 'autonomous',
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

async function createService(config: LifeModeConfigContract = BASE_CONFIG) {
  const { tmpdir } = await import('node:os')
  const directory = await mkdtemp(join(tmpdir(), 'airi-life-mode-test-'))
  temporaryDirectories.push(directory)

  const events: Array<{ tickId: string }> = []
  const context = createContext<ElectronMainContextExtensions, ElectronMainEmitOptions>()
  type EmitArgs = Parameters<typeof context.emit>
  const emit = vi.fn((...args: EmitArgs) => {
    const payload = args[1]
    if (typeof payload === 'object' && payload !== null && 'tickId' in payload && typeof payload.tickId === 'string')
      events.push({ tickId: payload.tickId })
  })
  const broadcast: EventaWindowBroadcast = { broadcast: emit, dispose: vi.fn() }

  await setupLifeMode(context, {
    persistencePath: join(directory, 'life-mode.json'),
    now: () => new Date(2026, 7, 31, 12).getTime(),
    broadcast,
  }, directory)

  const getConfig = defineInvoke(context, lifeModeGetConfig)
  const setConfig = defineInvoke(context, lifeModeSetConfig)
  const consumeTick = defineInvoke(context, lifeModeConsumeTick)
  await setConfig(config)

  return {
    emit,
    consumeTick,
    directory,
    events,
    getConfig,
    join,
  }
}

describe('setupLifeMode', () => {
  it('does not start a timer while life mode is off', async () => {
    vi.useFakeTimers()
    const service = await createService({ ...BASE_CONFIG, mode: 'off' })

    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(10 * 60_000)

    expect(service.events).toHaveLength(0)
    expect(await service.getConfig()).toMatchObject({ mode: 'off' })
  })

  it('counts one autonomous round only after the leader consumes its tick', async () => {
    vi.useFakeTimers()
    const service = await createService()

    expect(await service.getConfig()).toMatchObject({ mode: 'autonomous', intervalMinutes: 1 })
    expect(evaluateLifeTickGate(await service.getConfig(), {
      now: new Date(2026, 7, 31, 12).getTime(),
      budgetUsed: 0,
      budgetDateKey: '',
    })).toEqual({ pass: true })
    expect(vi.getTimerCount()).toBe(1)

    vi.advanceTimersByTime(60_000)
    await realSetTimeout(25)

    expect(service.emit).toHaveBeenCalled()
    expect(service.events).toHaveLength(1)
    const tick = service.events[0]
    if (!tick)
      throw new Error('Expected one emitted life tick.')

    const snapshotPath = service.join(service.directory, 'life-mode.json')
    expect((await readPersistedLifeMode(snapshotPath))?.budgetUsed).toBe(0)

    await service.consumeTick({ tickId: tick.tickId })
    await service.consumeTick({ tickId: tick.tickId })

    expect((await readPersistedLifeMode(snapshotPath))?.budgetUsed).toBe(1)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(service.events).toHaveLength(1)
  })

  it('emits respond heartbeats without consuming the autonomous budget', async () => {
    vi.useFakeTimers()
    const service = await createService({ ...BASE_CONFIG, mode: 'respond' })

    await vi.advanceTimersByTimeAsync(60_000)

    expect(service.events).toHaveLength(1)
    const snapshotPath = service.join(service.directory, 'life-mode.json')
    expect((await readPersistedLifeMode(snapshotPath))?.budgetUsed).toBe(0)
  })
})
