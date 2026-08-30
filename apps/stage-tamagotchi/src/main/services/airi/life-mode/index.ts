/**
 * Life mode service (LIFE-PLAN M3).
 *
 * The Electron main-process owner of the heartbeats behind autonomous speech:
 * the durable config lives next to the app config (`<userData>/life-mode.json`,
 * same pattern as the memory host), the cheap gates (quiet hours / daily
 * budget / cooldown) run here on an interval, and every passing gate emits a
 * `lifeTick` event that the leader renderer turns into a consideration round.
 * The renderer owns the remaining gates (busy stream, stimulus availability)
 * and all prompt/tool semantics.
 */
import type { createContext as createMainEventaContext } from '@moeru/eventa/adapters/electron/main'

import type { LifeModeConfigContract, LifeTickEventPayload } from '../../../../shared/eventa'
import type { EventaWindowBroadcast } from '../../../libs/electron/eventa-window-broadcast'

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { defineInvokeHandler } from '@moeru/eventa'

import { lifeModeGetConfig, lifeModeSetConfig, lifeTickEmitted } from '../../../../shared/eventa'
import { evaluateLifeTickGate, localDayKeyForNow } from './gates'

const PERSISTED_FILE_NAME = 'life-mode.json'
/** Interval floor: never spin the tick faster than once a minute. */
const MIN_INTERVAL_MS = 60_000

export interface LifeModeOptions {
  /** Overrides where the persisted config lives. */
  persistencePath?: string
  /** Test seam: replaces the wall clock. */
  now?: () => number
  /** Push channel for heartbeats; the plain ipc context has no sender to echo to. */
  broadcast?: EventaWindowBroadcast
}

interface PersistedLifeMode {
  config: LifeModeConfigContract
  budgetUsed: number
  budgetDateKey: string
  lastTickAt?: number
}

export const DEFAULT_LIFE_MODE_CONFIG: LifeModeConfigContract = {
  mode: 'off',
  intervalMinutes: 15,
  quietHoursStart: 0,
  quietHoursEnd: 0,
  dailyBudget: 24,
  cooldownMinutes: 30,
}

export async function readPersistedLifeMode(path: string): Promise<PersistedLifeMode | undefined> {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as Partial<PersistedLifeMode>
    if (!parsed.config || typeof parsed.config.mode !== 'string')
      return undefined
    return {
      config: { ...DEFAULT_LIFE_MODE_CONFIG, ...parsed.config },
      budgetUsed: typeof parsed.budgetUsed === 'number' ? parsed.budgetUsed : 0,
      budgetDateKey: typeof parsed.budgetDateKey === 'string' ? parsed.budgetDateKey : '',
      ...(typeof parsed.lastTickAt === 'number' ? { lastTickAt: parsed.lastTickAt } : {}),
    }
  }
  catch {
    return undefined
  }
}

export async function writePersistedLifeMode(path: string, snapshot: PersistedLifeMode): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(snapshot, null, 2), 'utf8')
  }
  catch {
    // Persistence is a convenience: a failed write only costs the config
    // (and budget counter) on next boot, never the running service.
  }
}

export async function setupLifeMode(
  context: ReturnType<typeof createMainEventaContext>['context'],
  options: LifeModeOptions = {},
  userDataDir: string,
): Promise<void> {
  const persistencePath = options.persistencePath ?? join(userDataDir, PERSISTED_FILE_NAME)
  const now = options.now ?? (() => Date.now())

  const persisted = await readPersistedLifeMode(persistencePath)
  let config: LifeModeConfigContract = persisted?.config ?? { ...DEFAULT_LIFE_MODE_CONFIG }
  let budgetUsed = persisted?.budgetUsed ?? 0
  let budgetDateKey = persisted?.budgetDateKey ?? ''
  let lastTickAt = persisted?.lastTickAt
  let timer: NodeJS.Timeout | undefined

  async function persist(): Promise<void> {
    await writePersistedLifeMode(persistencePath, { config, budgetUsed, budgetDateKey, ...(lastTickAt != null ? { lastTickAt } : {}) })
  }

  function restartTimer(): void {
    if (timer)
      clearInterval(timer)
    const intervalMs = Math.max(MIN_INTERVAL_MS, config.intervalMinutes * 60_000)
    timer = setInterval(() => void tick(), intervalMs)
    timer.unref?.()
  }

  let nextTickId = 1

  async function tick(): Promise<void> {
    const timestamp = now()

    // `respond` mode records every heartbeat in the journal without spending
    // model tokens, so it skips the economic gates; only `autonomous` runs
    // quiet-hours/budget/cooldown before a consideration round may start.
    if (config.mode !== 'respond') {
      const decision = evaluateLifeTickGate(config, {
        now: timestamp,
        lastTickAt,
        budgetUsed,
        budgetDateKey,
      })
      if (!decision.pass)
        return
    }

    if (config.mode !== 'respond') {
      lastTickAt = timestamp
      budgetUsed += 1
      budgetDateKey = localDayKeyForNow(timestamp)
      await persist()
    }

    const payload: LifeTickEventPayload = {
      tickId: `life-tick-${nextTickId++}`,
      reason: config.mode === 'respond' ? 'schedule heartbeat (respond — journal only)' : 'schedule heartbeat',
      timestamp,
    }
    ;(options.broadcast?.broadcast ?? context.emit)(lifeTickEmitted, payload)
  }

  defineInvokeHandler(context, lifeModeGetConfig, () => ({ ...config }))

  defineInvokeHandler(context, lifeModeSetConfig, async (next) => {
    config = { ...DEFAULT_LIFE_MODE_CONFIG, ...next }
    restartTimer()
    await persist()
    return { ...config }
  })

  restartTimer()
}
