/**
 * Main-process owner of the life-mode schedule and decision budget.
 *
 * A heartbeat is only an opportunity. The leader renderer builds a stimulus
 * first, then atomically claims the model budget through this service.
 */
import type { createContext as createMainEventaContext } from '@moeru/eventa/adapters/electron/main'

import type {
  LifeHeartbeatEventPayload,
  LifeModeConfigContract,
  LifeModeGate,
  LifeModeRuntimeSnapshotContract,
} from '../../../../shared/eventa'
import type { EventaWindowBroadcast } from '../../../libs/electron/eventa-window-broadcast'

import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { useLogg } from '@guiiai/logg'
import { defineInvokeHandler } from '@moeru/eventa'
import { errorMessageFrom } from '@moeru/std'
import { finite, integer, looseObject, maxValue, minValue, number, object, optional, picklist, pipe, safeParse, string } from 'valibot'

import {
  lifeHeartbeatEmitted,
  lifeModeClaimDecision,
  lifeModeGetSnapshot,
  lifeModeRecordGate,
  lifeModeRequestTestHeartbeat,
  lifeModeSetConfig,
  lifeModeSnapshotChanged,
} from '../../../../shared/eventa'
import { evaluateLifeTickGate, localDayKeyForNow, resolveNextLifeHeartbeatAt } from './gates'

const PERSISTED_FILE_NAME = 'life-mode.json'
const STARTUP_GRACE_MS = 30_000
const PENDING_HEARTBEAT_TTL_MS = 5 * 60_000

/** Global configuration routes these lines into `<userData>/logs`. */
const log = useLogg('main/life-mode').useGlobalConfig()

const lifeModeConfigSchema = object({
  mode: picklist(['off', 'respond', 'autonomous']),
  intervalMinutes: pipe(number(), finite(), integer(), minValue(1), maxValue(24 * 60)),
  quietHoursStart: pipe(number(), finite(), integer(), minValue(0), maxValue(23)),
  quietHoursEnd: pipe(number(), finite(), integer(), minValue(0), maxValue(23)),
  dailyBudget: pipe(number(), finite(), integer(), minValue(0), maxValue(10_000)),
  cooldownMinutes: pipe(number(), finite(), integer(), minValue(0), maxValue(24 * 60)),
})

const persistedLifeModeSchema = looseObject({
  config: lifeModeConfigSchema,
  revision: optional(pipe(number(), finite(), integer(), minValue(0))),
  budgetUsed: pipe(number(), finite(), integer(), minValue(0)),
  budgetDateKey: string(),
  nextHeartbeatAt: optional(pipe(number(), finite())),
  lastHeartbeatAt: optional(pipe(number(), finite())),
  lastDecisionAt: optional(pipe(number(), finite())),
  lastGate: optional(picklist([
    'mode',
    'quiet-hours',
    'budget',
    'cooldown',
    'busy',
    'focused',
    'flow-active',
    'speech-active',
    'no-session',
    'no-stimulus',
    'stale-stimulus',
    'tools-unavailable',
    'stale-heartbeat',
    'respond',
  ])),
})

export interface LifeModeOptions {
  /** Overrides where the persisted state lives. */
  persistencePath?: string
  /** Replaces the wall clock for deterministic tests. */
  now?: () => number
  /** Delay before one overdue heartbeat after startup. @default 30000 */
  startupGraceMs?: number
  /** Push channel for heartbeats and authoritative snapshots. */
  broadcast?: EventaWindowBroadcast
}

export interface PersistedLifeMode {
  config: LifeModeConfigContract
  revision: number
  budgetUsed: number
  budgetDateKey: string
  nextHeartbeatAt?: number
  lastHeartbeatAt?: number
  lastDecisionAt?: number
  lastGate?: LifeModeGate
}

interface PendingHeartbeat {
  expiresAt: number
  manual: boolean
}

export const DEFAULT_LIFE_MODE_CONFIG: LifeModeConfigContract = {
  mode: 'off',
  intervalMinutes: 15,
  quietHoursStart: 0,
  quietHoursEnd: 0,
  dailyBudget: 24,
  cooldownMinutes: 30,
}

/** Reads and validates the persisted life-mode state. */
export async function readPersistedLifeMode(path: string): Promise<PersistedLifeMode | undefined> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  }
  catch (error) {
    // A missing file is the first-run case. Any other read error deserves a
    // line in the log; both fall back to the default configuration.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      console.warn(`[life-mode] Could not read ${path}:`, errorMessageFrom(error))
    return undefined
  }

  try {
    const parsed = safeParse(persistedLifeModeSchema, JSON.parse(raw))
    if (!parsed.success)
      throw new Error('the persisted snapshot does not match the life-mode schema')

    return {
      config: parsed.output.config,
      revision: parsed.output.revision ?? 0,
      budgetUsed: parsed.output.budgetUsed,
      budgetDateKey: parsed.output.budgetDateKey,
      ...(parsed.output.nextHeartbeatAt != null ? { nextHeartbeatAt: parsed.output.nextHeartbeatAt } : {}),
      ...(parsed.output.lastHeartbeatAt != null ? { lastHeartbeatAt: parsed.output.lastHeartbeatAt } : {}),
      ...(parsed.output.lastDecisionAt != null ? { lastDecisionAt: parsed.output.lastDecisionAt } : {}),
      ...(parsed.output.lastGate != null ? { lastGate: parsed.output.lastGate } : {}),
    }
  }
  catch (error) {
    // The setup path persists defaults over this file immediately, so the
    // unreadable bytes are copied first. A silent reset once turned
    // `autonomous` into `off` with nothing left to inspect (S03-S18,
    // 2026-09-10). The warning goes through the global logger: a bare
    // `console.warn` never reaches `<userData>/logs`, so the only durable
    // trace of a reset would be the `.corrupt-*` copy.
    const preservedPath = `${path}.corrupt-${Date.now()}`
    try {
      await copyFile(path, preservedPath)
      log.withError(error).warn(`Ignoring unreadable ${path}; preserved a copy at ${preservedPath}.`)
    }
    catch (preserveError) {
      log.withError(error).warn(`Ignoring unreadable ${path}; could not preserve a copy at ${preservedPath}: ${errorMessageFrom(preserveError) ?? 'unknown error'}.`)
    }
    return undefined
  }
}

/**
 * Writes one complete main-process snapshot through a temporary file.
 *
 * A crash mid-write previously truncated `life-mode.json`, and the next boot
 * silently reset the user's configuration to defaults. The rename makes the
 * visible file either the old or the new complete snapshot.
 */
export async function writePersistedLifeMode(path: string, snapshot: PersistedLifeMode): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(temporaryPath, JSON.stringify(snapshot, null, 2), 'utf8')
    await rename(temporaryPath, path)
  }
  catch {
    // Persistence failure does not stop the running scheduler. The next
    // snapshot broadcast still exposes the live state to every renderer.
    await rm(temporaryPath, { force: true }).catch(() => {})
  }
}

/** Installs the life-mode scheduler and its Eventa invoke handlers. */
export async function setupLifeMode(
  context: ReturnType<typeof createMainEventaContext>['context'],
  options: LifeModeOptions = {},
  userDataDir: string,
): Promise<void> {
  const persistencePath = options.persistencePath ?? join(userDataDir, PERSISTED_FILE_NAME)
  const now = options.now ?? (() => Date.now())
  const startupGraceMs = options.startupGraceMs ?? STARTUP_GRACE_MS
  const persisted = await readPersistedLifeMode(persistencePath)

  let config = persisted?.config ?? { ...DEFAULT_LIFE_MODE_CONFIG }
  let revision = persisted?.revision ?? 0
  let budgetUsed = persisted?.budgetUsed ?? 0
  let budgetDateKey = persisted?.budgetDateKey ?? ''
  let nextHeartbeatAt = persisted?.nextHeartbeatAt
  let lastHeartbeatAt = persisted?.lastHeartbeatAt
  let lastDecisionAt = persisted?.lastDecisionAt
  let lastGate = persisted?.lastGate
  let timer: NodeJS.Timeout | undefined
  const pendingHeartbeats = new Map<string, PendingHeartbeat>()

  function snapshot(): LifeModeRuntimeSnapshotContract {
    return {
      config: { ...config },
      revision,
      budgetUsed,
      budgetDateKey,
      ...(nextHeartbeatAt != null ? { nextHeartbeatAt } : {}),
      ...(lastHeartbeatAt != null ? { lastHeartbeatAt } : {}),
      ...(lastDecisionAt != null ? { lastDecisionAt } : {}),
      ...(lastGate != null ? { lastGate } : {}),
    }
  }

  async function persist(): Promise<void> {
    await writePersistedLifeMode(persistencePath, snapshot())
  }

  function broadcastSnapshot(): void {
    ;(options.broadcast?.broadcast ?? context.emit)(lifeModeSnapshotChanged, snapshot())
  }

  function schedule(preferredNextHeartbeatAt?: number): void {
    if (timer)
      clearTimeout(timer)
    timer = undefined

    nextHeartbeatAt = resolveNextLifeHeartbeatAt(config, {
      now: now(),
      ...(preferredNextHeartbeatAt != null ? { persistedNextHeartbeatAt: preferredNextHeartbeatAt } : {}),
      startupGraceMs,
    })
    if (nextHeartbeatAt == null)
      return

    timer = setTimeout(() => void emitScheduledHeartbeat(), Math.max(0, nextHeartbeatAt! - now()))
    timer.unref?.()
  }

  function prunePendingHeartbeats(timestamp: number): void {
    for (const [heartbeatId, pending] of pendingHeartbeats) {
      if (pending.expiresAt <= timestamp)
        pendingHeartbeats.delete(heartbeatId)
    }
  }

  function emitHeartbeat(reason: LifeHeartbeatEventPayload['reason'], timestamp: number, manual: boolean): LifeHeartbeatEventPayload {
    prunePendingHeartbeats(timestamp)
    const payload: LifeHeartbeatEventPayload = {
      heartbeatId: randomUUID(),
      reason,
      timestamp,
    }
    pendingHeartbeats.set(payload.heartbeatId, {
      expiresAt: timestamp + PENDING_HEARTBEAT_TTL_MS,
      manual,
    })
    ;(options.broadcast?.broadcast ?? context.emit)(lifeHeartbeatEmitted, payload)
    return payload
  }

  async function emitScheduledHeartbeat(): Promise<void> {
    timer = undefined
    const timestamp = now()
    lastHeartbeatAt = timestamp
    lastGate = undefined
    schedule(timestamp + Math.max(60_000, config.intervalMinutes * 60_000))
    await persist()
    broadcastSnapshot()
    emitHeartbeat('schedule', timestamp, false)
  }

  async function rejectClaim(gate: LifeModeGate) {
    lastGate = gate
    await persist()
    broadcastSnapshot()
    return { claimed: false as const, gate, snapshot: snapshot() }
  }

  defineInvokeHandler(context, lifeModeGetSnapshot, () => snapshot())

  // The leader renderer owns most gate decisions; followers read only this
  // snapshot. Persisting the reported gate here makes "recent gate" visible in
  // every window instead of only in the deciding renderer's local snapshot
  // (S03-S18, 2026-09-10).
  defineInvokeHandler(context, lifeModeRecordGate, async ({ gate }) => {
    lastGate = gate
    await persist()
    broadcastSnapshot()
    return snapshot()
  })

  defineInvokeHandler(context, lifeModeSetConfig, async ({ patch }) => {
    const parsed = safeParse(lifeModeConfigSchema, { ...config, ...patch })
    if (!parsed.success)
      throw new TypeError('Invalid life-mode configuration.')

    config = parsed.output
    revision += 1
    lastGate = undefined
    // A config update invalidates opportunities created under the previous
    // schedule. Otherwise a delayed follower claim could spend the new
    // configuration's budget for an old heartbeat.
    pendingHeartbeats.clear()
    schedule()
    await persist()
    broadcastSnapshot()
    return snapshot()
  })

  defineInvokeHandler(context, lifeModeClaimDecision, async ({ heartbeatId }) => {
    const timestamp = now()
    prunePendingHeartbeats(timestamp)
    const pending = pendingHeartbeats.get(heartbeatId)
    if (!pending)
      return rejectClaim('stale-heartbeat')
    pendingHeartbeats.delete(heartbeatId)

    if (config.mode !== 'autonomous')
      return rejectClaim('mode')

    const today = localDayKeyForNow(timestamp)
    if (budgetDateKey !== today) {
      budgetDateKey = today
      budgetUsed = 0
    }

    const decision = evaluateLifeTickGate(config, {
      now: timestamp,
      lastTickAt: pending.manual ? undefined : lastDecisionAt,
      budgetUsed,
      budgetDateKey,
    })
    if (!pending.manual && !decision.pass)
      return rejectClaim(decision.gate ?? 'mode')
    if (config.dailyBudget > 0 && budgetUsed >= config.dailyBudget)
      return rejectClaim('budget')

    budgetUsed += 1
    budgetDateKey = today
    lastDecisionAt = timestamp
    lastGate = undefined
    await persist()
    broadcastSnapshot()
    return { claimed: true, snapshot: snapshot() }
  })

  defineInvokeHandler(context, lifeModeRequestTestHeartbeat, async () => {
    if (config.mode !== 'autonomous')
      return { emitted: false, gate: 'mode' as const, snapshot: snapshot() }

    const timestamp = now()
    lastHeartbeatAt = timestamp
    lastGate = undefined
    await persist()
    broadcastSnapshot()
    emitHeartbeat('manual-test', timestamp, true)
    return { emitted: true, snapshot: snapshot() }
  })

  schedule(nextHeartbeatAt)
  await persist()
}
