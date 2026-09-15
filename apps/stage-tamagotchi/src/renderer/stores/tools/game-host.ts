import type { ExecutableTool, ToolRegistrationInput } from '@proj-airi/stage-ui/stores/ai/chat-llm/tools'

import { useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { useLlmToolsStore } from '@proj-airi/stage-ui/stores/ai/chat-llm/tools'
import { useGameWorldStore } from '@proj-airi/stage-ui/stores/modules/game-world'
import { defineStore } from 'pinia'

import { gameHostExecuteCommand, gameHostListDomainTools } from '../../../shared/eventa'

/**
 * Game-host domain tools on the model tool face (MC-0c).
 *
 * The renderer owns only the tool shell; every call is executed by the
 * main-process game host through the MC-0b command registry (single owner,
 * connection generation, dedup by request id).
 */
export const useTamagotchiGameHostToolsStore = defineStore('tamagotchi-game-host-tools', () => {
  const llmToolsStore = useLlmToolsStore()
  const listDomainTools = useElectronEventaInvoke(gameHostListDomainTools)
  const executeGameCommand = useElectronEventaInvoke(gameHostExecuteCommand)
  const toolIdPrefix = 'game:game-host:'

  // Boot race: the leader refreshes once when it acquires leadership, but the
  // main-process game host can answer before its RPC channel is ready — empty,
  // or never, after a renderer reload. A first failed listing used to stick
  // for the whole session, so the tool face lost every game tool while the
  // bridge stayed healthy.
  const DISCOVERY_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000]
  let discoveryRetryTimer: ReturnType<typeof setTimeout> | undefined
  let discoveryRetryAttempts = 0

  function registeredToolIds() {
    return llmToolsStore.tools
      .filter(tool => tool.id.startsWith(toolIdPrefix))
      .map(tool => tool.id)
  }

  /** Keeps exactly one follow-up pass armed; a pending pass watchdog wins. */
  function armDiscoveryRetry() {
    if (discoveryRetryTimer)
      return
    if (discoveryRetryAttempts >= DISCOVERY_RETRY_DELAYS_MS.length)
      return

    const delay = DISCOVERY_RETRY_DELAYS_MS[discoveryRetryAttempts]
    discoveryRetryAttempts++
    discoveryRetryTimer = setTimeout(() => {
      discoveryRetryTimer = undefined
      void refresh()
    }, delay)
  }

  function clearDiscoveryRetry() {
    if (discoveryRetryTimer) {
      clearTimeout(discoveryRetryTimer)
      discoveryRetryTimer = undefined
    }
    discoveryRetryAttempts = 0
  }

  async function refresh() {
    // Arm before awaiting: a pass that hangs behind an unready channel still
    // gets a follow-up attempt.
    armDiscoveryRetry()

    let descriptors: Awaited<ReturnType<typeof listDomainTools>> = []
    try {
      descriptors = await listDomainTools()
    }
    catch (error) {
      console.warn('[game-host-tools] Failed to list game domain tools:', error)
    }

    const entries = descriptors.map((descriptor): { tool: ExecutableTool, registration: ToolRegistrationInput } => {
      const id = `${toolIdPrefix}${descriptor.name}`
      return {
        tool: {
          id,
          type: 'function',
          function: {
            name: descriptor.name,
            description: descriptor.description,
            parameters: descriptor.parameters,
          },
          defaultActive: true,
          execute: async (input: unknown) => {
            // One correlation id per call: the main-process registry uses it
            // as the command id, so an IPC retry dedups instead of executing
            // twice (mc-0c C1-D3).
            const result = await executeGameCommand({
              requestId: crypto.randomUUID(),
              action: descriptor.action,
              params: (input ?? {}) as Record<string, unknown>,
            })
            // MC-1b D2: remember the world and time of the latest observation
            // so memory capture, the context provider, and consideration
            // labels can scope game facts by world.
            if (result.world) {
              useGameWorldStore().recordObservation({
                worldId: result.world.worldId,
                connectionGeneration: result.world.connectionGeneration,
                connectionId: result.world.connectionId,
                dimension: result.world.dimension,
                observedAt: Date.now(),
                ...(result.finalSnapshot?.position ? { position: result.finalSnapshot.position } : {}),
              })
            }
            return result
          },
        },
        registration: {
          toolId: id,
          toolName: descriptor.name,
          ownerKind: 'game_adapter' as const,
          ownerId: 'game-host',
          execution: { kind: 'remote' as const, chain: ['game-adapter', 'game-host'] },
        },
      }
    })

    await llmToolsStore.removeToolsByIds(...registeredToolIds())
    if (entries.length > 0)
      await llmToolsStore.addRegisteredTools(...entries)

    if (descriptors.length > 0)
      clearDiscoveryRetry()
    else
      armDiscoveryRetry()
  }

  async function dispose() {
    clearDiscoveryRetry()
    await llmToolsStore.removeToolsByIds(...registeredToolIds())
  }

  return { dispose, refresh }
}, {
  synced: {
    state: false,
    actions: ['dispose', 'refresh'],
  },
})
