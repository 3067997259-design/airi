import type { MemorySourceContext } from '@proj-airi/memory-core'

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

/** Latest world-scoped game observation, as recorded from game tool results. */
export interface GameWorldObservation {
  worldId: string
  /** Connection generation the observation belongs to (mc-1b world scope key). */
  connectionGeneration: number
  /** Per-connect unique id; the scope key when `worldId` is generic. */
  connectionId: string
  dimension: string
  observedAt: number
  position?: { x: number, y: number, z: number }
}

/** The world fields one comparison or memory write needs. */
export interface GameWorldScope {
  worldId: string
  connectionId?: string
  connectionGeneration: number
  dimension?: string
}

/** Same-world game facts older than this need a fresh observation before acting. */
export const GAME_FACT_STALE_MS = 30 * 60_000

/**
 * The scope key of one game world binding.
 *
 * The fork reports no stable world id, so `connection-scoped` relies on the
 * per-connect id; without it (older persisted facts) the generation is the
 * best available discriminator.
 */
export function gameWorldScopeKey(world: GameWorldScope): string {
  return world.worldId === 'connection-scoped'
    ? `${world.worldId}#${world.connectionId ?? world.connectionGeneration}`
    : world.worldId
}

/**
 * Labels a world-scoped game fact for prompts and consideration stimuli (mc-1b D2).
 *
 * A fact from another world or connection is history, never a current
 * coordinate; a fact from the current world that was observed longer ago than
 * the freshness window needs a new observation before the model may act on it.
 */
export function labelGameFact(
  content: string,
  gameWorld: MemorySourceContext['gameWorld'] | undefined,
  current: GameWorldScope | undefined,
  now: number,
): string {
  if (!gameWorld)
    return content
  const scope = gameWorldScopeKey(gameWorld)
  const label = gameWorld.dimension ? `${scope}, ${gameWorld.dimension}` : scope
  const sameScope = current?.worldId === gameWorld.worldId
    && (gameWorld.worldId !== 'connection-scoped' || gameWorldScopeKey(current) === scope)
  if (!current?.worldId || !sameScope)
    return `Historical (world ${label}): ${content} Not a current fact; re-observe before acting on it.`
  if (now - gameWorld.observedAt > GAME_FACT_STALE_MS) {
    const ageMinutes = Math.max(1, Math.round((now - gameWorld.observedAt) / 60_000))
    return `Needs re-observation (world ${label}, last seen ${ageMinutes} minutes ago): ${content}`
  }
  return content
}

/**
 * Latest game-world observation (mc-1b D2).
 *
 * Game facts are world-scoped. This store is the renderer's single memory of
 * where and when the last observation happened; the Minecraft context
 * provider, memory capture, and the life-mode consideration labels all read
 * this instead of re-deriving world identity from chat text.
 */
export const useGameWorldStore = defineStore('game-world', () => {
  const latest = ref<GameWorldObservation>()

  function recordObservation(observation: GameWorldObservation): void {
    latest.value = {
      ...observation,
      ...(observation.position ? { position: { ...observation.position } } : {}),
    }
  }

  function clear(): void {
    latest.value = undefined
  }

  const worldId = computed(() => latest.value?.worldId)

  return {
    latest,
    worldId,
    recordObservation,
    clear,
  }
})
