import type { ContextMessage } from '../../../types/chat'

import { ContextUpdateStrategy } from '@proj-airi/server-sdk'
import { nanoid } from 'nanoid'

import { useGameHostStore } from '../../modules/game-host'
import { useGameWorldStore } from '../../modules/game-world'

const MINECRAFT_CONTEXT_ID = 'system:minecraft-integration'

/**
 * Ambient Minecraft context for Stage chat turns (MC-0c, expanded by MC-1b).
 *
 * The bridge itself is the live surface: world state is read on demand through
 * the `game_observe`/`game_move_to` tools. This provider tells the model which
 * world it is in and when the last observation happened, and it states the
 * world-scoping rule: coordinates from memory or older turns are historical
 * facts, not a current position.
 */
export function createMinecraftContext(): ContextMessage | null {
  const gameHostStore = useGameHostStore()
  void gameHostStore.ensureLoaded()

  if (!gameHostStore.configured)
    return null

  const identity = gameHostStore.status.identity
  const identityText = identity
    ? `Current world: ${identity.worldId} (Minecraft ${identity.minecraftVersion}), dimension ${identity.dimension}, local player ${identity.playerUuid}.`
    : 'The bridge has not reported world identity yet; call game_observe before assuming where the player is.'

  const observation = useGameWorldStore().latest
  const observationScope = observation
    ? `${observation.worldId}${observation.worldId === 'connection-scoped' ? `#${observation.connectionId}` : ''}`
    : ''
  const observationText = observation
    ? `Latest game observation: world ${observationScope} (${observation.dimension}) at ${new Date(observation.observedAt).toISOString()}${observation.position ? `, position ${observation.position.x.toFixed(1)}/${observation.position.y}/${observation.position.z.toFixed(1)}` : ''}.`
    : 'No game observation was recorded yet in this session; call game_observe before acting on any remembered location.'

  return {
    id: nanoid(),
    contextId: MINECRAFT_CONTEXT_ID,
    strategy: ContextUpdateStrategy.ReplaceSelf,
    text: [
      'AIRI is connected to a local Minecraft client through the MCPFabric bridge.',
      'World state is reachable on demand through the game tools; call game_observe for position/health and game_move_to for movement instead of guessing.',
      identityText,
      observationText,
      'Coordinates and game facts from memory or older turns are historical: a fact from another world or an old observation is never a current fact. Re-run game_observe before moving to a remembered location.',
    ].join(' '),
    createdAt: Date.now(),
  }
}
