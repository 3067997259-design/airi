import type {
  GameHostChatCommandPayload,
  GameHostConfig,
  GameHostConfigView,
  GameHostObservationResult,
  GameHostStatus,
} from '../../shared/eventa'

import { defineInvoke } from '@moeru/eventa'
import { getElectronEventaContext } from '@proj-airi/electron-vueuse'

import {
  gameHostApplyConfig,
  gameHostChatCommandEmitted,
  gameHostGetConfig,
  gameHostGetStatus,
  gameHostObserve,
} from '../../shared/eventa'

export interface GameHostClient {
  getStatus: () => Promise<GameHostStatus>
  getConfig: () => Promise<GameHostConfigView>
  applyConfig: (config: GameHostConfig) => Promise<GameHostStatus>
  observe: (params: { toolName: string, arguments?: Record<string, unknown> }) => Promise<GameHostObservationResult>
  /** MC-3c D4: owner chat messages accepted as commands by the main process. */
  onChatCommand: (listener: (payload: GameHostChatCommandPayload) => void) => () => void
}

let cachedClient: GameHostClient | undefined

/** Creates (or reuses) the game host client for the current renderer. */
export function createGameHostClient(): GameHostClient {
  cachedClient ??= createGameHostClientInner()
  return cachedClient
}

function createGameHostClientInner(): GameHostClient {
  const context = getElectronEventaContext()

  return {
    getStatus: defineInvoke(context, gameHostGetStatus),
    getConfig: defineInvoke(context, gameHostGetConfig),
    applyConfig: defineInvoke(context, gameHostApplyConfig),
    observe: defineInvoke(context, gameHostObserve),
    onChatCommand(listener) {
      const off = context.on(gameHostChatCommandEmitted, (event) => {
        if (event.body)
          listener(event.body)
      })
      return () => off()
    },
  }
}
