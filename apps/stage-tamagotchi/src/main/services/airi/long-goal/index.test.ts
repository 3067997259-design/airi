import type { ElectronMainContextExtensions, ElectronMainEmitOptions } from '@moeru/eventa/adapters/electron/main'

import type { LongGoalSchedulePayload, LongGoalWakeEventPayload } from '../../../../shared/eventa'
import type { EventaWindowBroadcast } from '../../../libs/electron/eventa-window-broadcast'
import type { LongGoalSchedulerOptions } from './index'

import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { createContext, defineInvoke } from '@moeru/eventa'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  longGoalClaim,
  longGoalRelease,
  longGoalSchedule,
  longGoalUnschedule,
} from '../../../../shared/eventa'
import { readPersistedLongGoalSchedules, setupLongGoalScheduler, writePersistedLongGoalSchedules } from './index'

const temporaryDirectories: string[] = []
const temporaryServices: Array<{ dispose: () => void }> = []

afterEach(async () => {
  vi.useRealTimers()
  for (const service of temporaryServices.splice(0))
    service.dispose()
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function createService(
  initialSchedules: readonly LongGoalSchedulePayload[] = [],
  schedulerOptions: Pick<LongGoalSchedulerOptions, 'leaseTtlMs'> = {},
) {
  const { tmpdir } = await import('node:os')
  const directory = await mkdtemp(join(tmpdir(), 'airi-long-goal-test-'))
  temporaryDirectories.push(directory)
  const wakes: LongGoalWakeEventPayload[] = []
  const context = createContext<ElectronMainContextExtensions, ElectronMainEmitOptions>()
  type EmitArgs = Parameters<typeof context.emit>
  const broadcast: EventaWindowBroadcast = {
    broadcast: (...args: EmitArgs) => {
      const payload = args[1]
      if (typeof payload === 'object' && payload !== null && 'goalId' in payload && 'wakeId' in payload && 'reason' in payload && 'timestamp' in payload)
        wakes.push(payload as LongGoalWakeEventPayload)
    },
    dispose: vi.fn(),
  }
  const persistencePath = join(directory, 'long-goals.json')
  await writePersistedLongGoalSchedules(persistencePath, initialSchedules)

  const scheduler = await setupLongGoalScheduler(context, {
    persistencePath,
    broadcast,
    retryDelayMs: 1000,
    pendingWakeTtlMs: 5000,
    ...schedulerOptions,
  }, directory)
  temporaryServices.push(scheduler)

  return {
    claim: defineInvoke(context, longGoalClaim),
    release: defineInvoke(context, longGoalRelease),
    schedule: defineInvoke(context, longGoalSchedule),
    unschedule: defineInvoke(context, longGoalUnschedule),
    persistencePath,
    wakes,
  }
}

describe('setupLongGoalScheduler', () => {
  it('emits one startup wake and accepts only one claim for it', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const service = await createService([{ goalId: 'goal-1', nextReviewAt: 2000 }])
    await vi.advanceTimersByTimeAsync(1000)

    expect(service.wakes).toHaveLength(1)
    expect(service.wakes[0]).toMatchObject({ goalId: 'goal-1', reason: 'startup', timestamp: 2000 })
    const wake = service.wakes[0]!
    expect(await service.claim({ goalId: wake.goalId, wakeId: wake.wakeId })).toMatchObject({ claimed: true })
    expect(await service.claim({ goalId: wake.goalId, wakeId: wake.wakeId })).toMatchObject({ claimed: false, reason: 'already-running' })
  })

  it('rejects a second renderer while the goal lease is active', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const service = await createService()
    await service.schedule({ goalId: 'goal-1', nextReviewAt: 1000 })
    await vi.advanceTimersByTimeAsync(0)
    const firstWake = service.wakes[0]!
    const firstClaim = await service.claim({ goalId: firstWake.goalId, wakeId: firstWake.wakeId })

    await vi.advanceTimersByTimeAsync(1000)
    const retryWake = service.wakes[1]!
    expect(await service.claim({ goalId: retryWake.goalId, wakeId: retryWake.wakeId })).toEqual({ claimed: false, reason: 'already-running' })

    await service.release({ goalId: firstWake.goalId, leaseId: firstClaim.leaseId ?? '' })
  })

  it('reclaims a lease after the renderer stops renewing it', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const service = await createService([{ goalId: 'goal-1', nextReviewAt: 1000 }], { leaseTtlMs: 1000 })
    await vi.advanceTimersByTimeAsync(0)
    const firstWake = service.wakes[0]!
    expect(await service.claim({ goalId: firstWake.goalId, wakeId: firstWake.wakeId })).toMatchObject({ claimed: true })

    await vi.advanceTimersByTimeAsync(1000)
    const retryWake = service.wakes[1]!
    expect(await service.claim({ goalId: retryWake.goalId, wakeId: retryWake.wakeId })).toMatchObject({ claimed: true })
  })

  it('does not accept a wake after its pending claim window expires', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const service = await createService([{ goalId: 'goal-1', nextReviewAt: 1000 }])
    await vi.advanceTimersByTimeAsync(0)
    const wake = service.wakes[0]!

    vi.setSystemTime(7_000)

    expect(await service.claim({ goalId: wake.goalId, wakeId: wake.wakeId })).toEqual({
      claimed: false,
      reason: 'stale-wake',
    })
  })

  it('removes pending wakes when a goal is unscheduled', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const service = await createService()
    await service.schedule({ goalId: 'goal-1', nextReviewAt: 2000 })
    await service.unschedule({ goalId: 'goal-1' })

    await vi.advanceTimersByTimeAsync(5000)
    expect(service.wakes).toHaveLength(0)
    expect(await readPersistedLongGoalSchedules(service.persistencePath)).toEqual([])
  })
})
