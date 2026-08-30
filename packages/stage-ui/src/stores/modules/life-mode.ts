import type { JournalEvent } from '@proj-airi/core-agent'

import { defineStore } from 'pinia'
import { ref } from 'vue'

import { useChatStore } from '../chat'
import { useChatSessionStore } from '../chat/session-store'
import { useJournalStore } from '../journal'
import { useMemoryStore } from '../modules/memory'

/**
 * Life-mode configuration (LIFE-PLAN §四).
 *
 * - `off`: today's behavior — pure input-driven, nothing changes.
 * - `respond`: triggers still journal, but SHE never initiates a round.
 * - `autonomous`: consideration turns run; she may speak on her own.
 */
export type LifeMode = 'off' | 'respond' | 'autonomous'

export interface LifeModeConfig {
  mode: LifeMode
  /** Heartbeat interval in minutes. @default 15 */
  intervalMinutes: number
  /** Quiet-hours window (24h local clock, half-open). Disable with start === end. */
  quietHoursStart: number
  quietHoursEnd: number
  /** Per-day consideration budget; 0 = unlimited. */
  dailyBudget: number
  /** Minimum minutes between consideration rounds. */
  cooldownMinutes: number
}

export const DEFAULT_LIFE_MODE_CONFIG: LifeModeConfig = {
  mode: 'off',
  intervalMinutes: 15,
  quietHoursStart: 0,
  quietHoursEnd: 0,
  dailyBudget: 24,
  cooldownMinutes: 30,
}

export interface LifeTickPayload {
  tickId: string
  reason: string
  timestamp: number
}

export interface LifeModePort {
  getConfig: () => Promise<LifeModeConfig>
  setConfig: (config: LifeModeConfig) => Promise<LifeModeConfig>
  onTick: (listener: (payload: LifeTickPayload) => void) => () => void
}

let port: LifeModePort | undefined
let disposeTickListener: (() => void) | undefined

export type LifeTickOutcome = 'gated' | 'considered-silent' | 'spoke' | 'noted'

/**
 * Builds one structured stimulus brief from real journal facts (LIFE-PLAN
 * §二.1 — she narrates only what actually happened). Pure so tests can drive
 * the exact shape without the store.
 *
 * @example
 * buildStimulusBrief({
 *   mood: { valence: 0.4, arousal: 0.5 },
 *   spotlight: 'plan step "step-1" completed',
 *   recentEvents: ['tool/result read ok: 12 lines'],
 * })
 * // => multi-line brief including "Mood: warm"
 */
export function buildStimulusBrief(input: {
  mood?: { valence: number, arousal?: number }
  spotlight?: string
  recentEvents: string[]
}): string {
  const lines: string[] = ['[Stimulus brief — real events from your own journal; no user is waiting for a reply]']
  if (input.mood)
    lines.push(`Mood: ${input.mood.valence >= 0.4 ? 'warm' : input.mood.valence <= -0.4 ? 'cool' : 'neutral'} (valence ${input.mood.valence.toFixed(2)}, arousal ${input.mood.arousal?.toFixed(2) ?? 'n/a'}).`)
  if (input.spotlight)
    lines.push(`Spotlight: ${input.spotlight}`)
  if (input.recentEvents.length > 0)
    lines.push(`Recent activity: ${input.recentEvents.slice(0, 5).join(' | ')}`)
  return lines.join('\n')
}

function journalEventToFact(event: JournalEvent): string | undefined {
  switch (event.type) {
    case 'tool/result':
      return `${event.toolName} ${event.ok ? 'ok' : 'failed'}: ${event.summary.slice(0, 80)}`
    case 'plan/update':
      return `plan ${event.status ?? 'updated'}${event.stepId ? ` step "${event.stepId}"` : ''}${event.reason ? ` — ${event.reason}` : ''}`
    case 'appearance/changed':
      return `${event.source === 'expression' ? 'expression' : 'parameter'} changed: ${event.target}${event.value !== undefined ? ` → ${event.value}` : ''}`
    case 'approval/asked':
      return `approval requested: ${event.reason.slice(0, 60)}`
    default:
      return undefined
  }
}

/**
 * Life-mode store: mirrors the main-process config, receives ticks, and runs
 * consideration turns through the chat store. The tick listener is installed
 * per renderer; `send` is a synced leader action, so follower windows fail
 * safely (their send is rejected before any stream starts).
 */
function toPlainConfig(config: LifeModeConfig): LifeModeConfig {
  return {
    mode: config.mode,
    intervalMinutes: config.intervalMinutes,
    quietHoursStart: config.quietHoursStart,
    quietHoursEnd: config.quietHoursEnd,
    dailyBudget: config.dailyBudget,
    cooldownMinutes: config.cooldownMinutes,
  }
}

export const useLifeModeStore = defineStore('life-mode', () => {
  const journalStore = useJournalStore()
  const config = ref<LifeModeConfig>({ ...DEFAULT_LIFE_MODE_CONFIG })
  const lastTick = ref<LifeTickPayload>()
  const outcomes = ref<LifeTickOutcome[]>([])

  function recordOutcome(outcome: LifeTickOutcome): void {
    outcomes.value = [...outcomes.value.slice(-19), outcome]
  }

  async function syncConfig(): Promise<void> {
    if (!port)
      return
    try {
      config.value = await port.getConfig()
    }
    catch {
      // Keep the last known config; boot without the host is fine.
    }
  }

  async function setMode(mode: LifeMode): Promise<void> {
    config.value = { ...config.value, mode }
    await port?.setConfig(toPlainConfig(config.value))
  }

  async function setConfigPatch(patch: Partial<LifeModeConfig>): Promise<void> {
    config.value = { ...config.value, ...patch }
    await port?.setConfig(toPlainConfig(config.value))
  }

  function spotlightFrom(eventsSnapshot: JournalEvent[]): string | undefined {
    const newest = [...eventsSnapshot].reverse().find(event =>
      event.type === 'plan/update' || event.type === 'approval/asked')
    return newest ? journalEventToFact(newest) : undefined
  }

  /**
   * Accepts a main-process tick. The main process already applied
   * quiet-hours / budget / cooldown; gates only the renderer can see run
   * here (active stream). `respond` mode journals the tick as gated instead
   * of initiating; `off` ignores it entirely (LIFE-PLAN §三).
   */
  async function onLifeTick(payload: LifeTickPayload): Promise<void> {
    lastTick.value = payload
    if (config.value.mode === 'off')
      return
    if (config.value.mode === 'respond') {
      recordOutcome('gated')
      journalStore.appendActive({
        type: 'life/tick',
        tickId: payload.tickId,
        outcome: 'gated',
        gate: 'respond',
        stimulus: 'life mode is respond — triggers journal, she does not speak',
        timestamp: payload.timestamp,
      })
      return
    }

    if (useChatStore().sending) {
      recordOutcome('gated')
      journalStore.appendActive({
        type: 'life/tick',
        tickId: payload.tickId,
        outcome: 'gated',
        gate: 'busy',
        stimulus: 'an active stream is running — nothing initiated',
        timestamp: payload.timestamp,
      })
      return
    }

    const sessionId = useChatSessionStore().activeSessionId
    if (!sessionId) {
      recordOutcome('gated')
      journalStore.appendActive({
        type: 'life/tick',
        tickId: payload.tickId,
        outcome: 'gated',
        gate: 'busy',
        stimulus: 'no active chat session',
        timestamp: payload.timestamp,
      })
      return
    }

    const snapshot = journalStore.events
    const mood = useMemoryStore().currentMood
    const stimulus = buildStimulusBrief({
      ...(mood?.valence !== undefined ? { mood } : {}),
      spotlight: spotlightFrom(snapshot),
      recentEvents: snapshot
        .map(journalEventToFact)
        .filter((fact): fact is string => !!fact)
        .slice(-4),
    })

    await useChatStore().send({
      sessionId,
      text: stimulus,
      source: 'self-initiative',
      tools: [{ name: 'self_speak' }, { name: 'self_note' }],
    })
  }

  return {
    config,
    lastTick,
    outcomes,
    syncConfig,
    setMode,
    setConfigPatch,
    onLifeTick,
  }
}, {
  synced: {
    // The main process owns the durable config; this store mirrors it. The
    // outcomes list is per-window observability, not leadership state.
    state: false,
  },
})

/** Installs the main-process port and forwards heartbeats to the store. */
export function installLifeModePort(next: LifeModePort | undefined): void {
  disposeTickListener?.()
  disposeTickListener = undefined
  port = next
  if (!next)
    return
  // Renderer main.ts installs bridges before app.use(pinia), so Pinia is not
  // active here yet. The microtask runs after the synchronous app mount
  // completes; the tick listener below already resolves the store lazily at
  // event time.
  void Promise.resolve().then(() => {
    useLifeModeStore().syncConfig()
  })
  disposeTickListener = next.onTick((payload) => {
    void useLifeModeStore().onLifeTick(payload)
  })
}
