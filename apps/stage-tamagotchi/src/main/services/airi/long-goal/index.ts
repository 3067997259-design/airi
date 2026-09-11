/**
 * Main-process clock and single-run lease for long-horizon goals.
 *
 * Call stack:
 *
 * {@link setupLongGoalScheduler}
 *   -> scheduleNextWake
 *     -> emitDueWakes
 *       -> longGoalWakeEmitted
 *   -> longGoalClaim
 *     -> one renderer-owned Flow run
 */
import type { createContext as createMainEventaContext } from '@moeru/eventa/adapters/electron/main'

import type {
  LongGoalClaimResult,
  LongGoalSchedulePayload,
  LongGoalWakeEventPayload,
} from '../../../../shared/eventa'
import type { EventaWindowBroadcast } from '../../../libs/electron/eventa-window-broadcast'

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { defineInvokeHandler } from '@moeru/eventa'
import { array, finite, looseObject, maxLength, minLength, number, object, pipe, safeParse, string } from 'valibot'

import {
  longGoalClaim,
  longGoalRelease,
  longGoalSchedule,
  longGoalUnschedule,
  longGoalWakeEmitted,
} from '../../../../shared/eventa'

const PERSISTED_FILE_NAME = 'long-goals.json'
const DEFAULT_RETRY_DELAY_MS = 60_000
const DEFAULT_PENDING_WAKE_TTL_MS = 5 * 60_000
const DEFAULT_LEASE_TTL_MS = 30 * 60_000

const persistedScheduleSchema = looseObject({
  schedules: array(object({
    goalId: pipe(string(), minLength(1), maxLength(256)),
    nextReviewAt: pipe(number(), finite()),
  })),
})

interface PendingWake {
  goalId: string
  expiresAt: number
}

interface ActiveLease {
  leaseId: string
  expiresAt: number
}

export interface LongGoalSchedulerOptions {
  /** Overrides where the main-process schedule is persisted. */
  persistencePath?: string
  /** Replaces the wall clock for deterministic tests. */
  now?: () => number
  /** Delay before an unclaimed wake is emitted again. @default 60000 */
  retryDelayMs?: number
  /** Time for which one wake can be claimed. @default 300000 */
  pendingWakeTtlMs?: number
  /** Time after which a crashed renderer lease can be reclaimed. @default 1800000 */
  leaseTtlMs?: number
  /** Push channel for wake events to every renderer window. */
  broadcast?: EventaWindowBroadcast
}

export interface LongGoalSchedulerHandle {
  dispose: () => void
}

/** Reads and validates the persisted long-goal schedule. */
export async function readPersistedLongGoalSchedules(path: string): Promise<LongGoalSchedulePayload[]> {
  try {
    const parsed = safeParse(persistedScheduleSchema, JSON.parse(await readFile(path, 'utf8')))
    if (!parsed.success)
      return []

    return parsed.output.schedules.map(schedule => ({ ...schedule }))
  }
  catch {
    return []
  }
}

/** Writes the complete main-process schedule snapshot. */
export async function writePersistedLongGoalSchedules(path: string, schedules: readonly LongGoalSchedulePayload[]): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify({ schedules }, null, 2), 'utf8')
  }
  catch {
    // A transient profile or shutdown failure must not drop the live lease;
    // the next schedule mutation retries the complete snapshot.
  }
}

/** Installs the main-process long-goal clock and lease handlers. */
export async function setupLongGoalScheduler(
  context: ReturnType<typeof createMainEventaContext>['context'],
  options: LongGoalSchedulerOptions = {},
  userDataDir: string,
): Promise<LongGoalSchedulerHandle> {
  const persistencePath = options.persistencePath ?? join(userDataDir, PERSISTED_FILE_NAME)
  const now = options.now ?? (() => Date.now())
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  const pendingWakeTtlMs = options.pendingWakeTtlMs ?? DEFAULT_PENDING_WAKE_TTL_MS
  const leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS
  const schedules = new Map<string, LongGoalSchedulePayload>()
  const pendingWakes = new Map<string, PendingWake>()
  const leases = new Map<string, ActiveLease>()
  const startupScheduleIds = new Set<string>()
  let timer: NodeJS.Timeout | undefined

  for (const schedule of await readPersistedLongGoalSchedules(persistencePath)) {
    schedules.set(schedule.goalId, schedule)
    startupScheduleIds.add(schedule.goalId)
  }

  function emit(payload: LongGoalWakeEventPayload): void {
    ;(options.broadcast?.broadcast ?? context.emit)(longGoalWakeEmitted, payload)
  }

  async function persist(): Promise<void> {
    await writePersistedLongGoalSchedules(persistencePath, [...schedules.values()])
  }

  function prunePendingWakes(timestamp: number): void {
    for (const [wakeId, pending] of pendingWakes) {
      if (pending.expiresAt <= timestamp)
        pendingWakes.delete(wakeId)
    }
  }

  function pruneLeases(timestamp: number): void {
    for (const [goalId, lease] of leases) {
      if (lease.expiresAt <= timestamp)
        leases.delete(goalId)
    }
  }

  function scheduleNextWake(): void {
    if (timer)
      clearTimeout(timer)
    timer = undefined
    const next = [...schedules.values()].sort((left, right) => left.nextReviewAt - right.nextReviewAt)[0]
    if (!next)
      return

    timer = setTimeout(() => void emitDueWakes(), Math.max(0, next.nextReviewAt - now()))
    timer.unref?.()
  }

  async function emitDueWakes(): Promise<void> {
    timer = undefined
    const timestamp = now()
    prunePendingWakes(timestamp)
    const due = [...schedules.values()].filter(schedule => schedule.nextReviewAt <= timestamp)
    if (due.length === 0) {
      scheduleNextWake()
      return
    }

    for (const schedule of due) {
      schedules.delete(schedule.goalId)
      const wakeReason = startupScheduleIds.has(schedule.goalId) ? 'startup' : 'schedule'
      startupScheduleIds.delete(schedule.goalId)
      const wakeId = randomUUID()
      pendingWakes.set(wakeId, { goalId: schedule.goalId, expiresAt: timestamp + pendingWakeTtlMs })
      // Keep a retry schedule until a renderer claims the wake and explicitly
      // removes it. A late renderer therefore cannot lose the goal forever.
      schedules.set(schedule.goalId, { goalId: schedule.goalId, nextReviewAt: timestamp + retryDelayMs })
      emit({
        goalId: schedule.goalId,
        wakeId,
        reason: wakeReason,
        timestamp,
      })
    }
    scheduleNextWake()
    await persist()
  }

  defineInvokeHandler(context, longGoalSchedule, async (payload) => {
    if (!payload.goalId.trim() || !Number.isFinite(payload.nextReviewAt))
      throw new TypeError('Invalid long-goal schedule.')

    startupScheduleIds.delete(payload.goalId)
    for (const [wakeId, pending] of pendingWakes) {
      if (pending.goalId === payload.goalId)
        pendingWakes.delete(wakeId)
    }
    schedules.set(payload.goalId, { ...payload })
    await persist()
    scheduleNextWake()
  })

  defineInvokeHandler(context, longGoalUnschedule, async ({ goalId }) => {
    schedules.delete(goalId)
    startupScheduleIds.delete(goalId)
    for (const [wakeId, pending] of pendingWakes) {
      if (pending.goalId === goalId)
        pendingWakes.delete(wakeId)
    }
    await persist()
    scheduleNextWake()
  })

  defineInvokeHandler(context, longGoalClaim, async ({ goalId, wakeId }): Promise<LongGoalClaimResult> => {
    const timestamp = now()
    prunePendingWakes(timestamp)
    pruneLeases(timestamp)
    if (leases.has(goalId))
      return { claimed: false, reason: 'already-running' }

    const pending = pendingWakes.get(wakeId)
    if (!pending || pending.goalId !== goalId)
      return { claimed: false, reason: schedules.has(goalId) ? 'stale-wake' : 'unknown-goal' }

    pendingWakes.delete(wakeId)
    const leaseId = randomUUID()
    leases.set(goalId, { leaseId, expiresAt: timestamp + leaseTtlMs })
    return { claimed: true, leaseId }
  })

  defineInvokeHandler(context, longGoalRelease, async ({ goalId, leaseId }) => {
    if (leases.get(goalId)?.leaseId === leaseId)
      leases.delete(goalId)
  })

  scheduleNextWake()
  await persist()
  return {
    dispose() {
      if (timer)
        clearTimeout(timer)
      timer = undefined
      pendingWakes.clear()
      leases.clear()
      startupScheduleIds.clear()
    },
  }
}
