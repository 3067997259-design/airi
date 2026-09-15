import type { GameHostChatCommandPayload } from '../../shared/eventa'

import { errorMessageFrom } from '@moeru/std'
import { useLlmToolsStore } from '@proj-airi/stage-ui/stores/ai/chat-llm/tools'
import { useChatStore } from '@proj-airi/stage-ui/stores/chat'
import { useChatSessionStore } from '@proj-airi/stage-ui/stores/chat/session-store'
import { installGameHostBridgeClient } from '@proj-airi/stage-ui/stores/modules/game-host'
import { useGameWorldStore } from '@proj-airi/stage-ui/stores/modules/game-world'

import { resolveRendererWindowContext } from '../window-context'
import { createGameHostClient } from './game-host'

/** Renders one delivered MC chat message into a turn with its trigger rules. */
function gameChatTurnText(payload: GameHostChatCommandPayload): string {
  const context = payload.context.length > 0
    ? `\n（附近的聊天：${payload.context.map(line => `${line.sender}: ${line.text}`).join('；')}）`
    : ''
  if (payload.trigger === 'admin') {
    return `[Minecraft 服务器聊天 · 管理员 ${payload.sender}] ${payload.text}${context}\n（这条消息不一定说给你听。与你无关时不要执行动作、不要使用 game_say，可以只留一句很短的说明。需要回话时用 game_say 发到游戏聊天；需要动作时用对应的 game_* 工具。）`
  }
  if (payload.trigger === 'mentionless-sample') {
    return `[Minecraft 服务器聊天 · 采样对话 · ${payload.sender}] ${payload.text}${context}\n（这是你旁听到的对话，不一定说给你听。愿意参与时用 game_say 回应；不想参与就保持沉默，不执行动作。）`
  }
  return `[Minecraft 服务器聊天 · ${payload.sender}] ${payload.text}${context}\n（这是对你说的话。需要回话时用 game_say 发到游戏聊天；需要动作时用对应的 game_* 工具。）`
}

/**
 * Installs the game-host bridge client for this renderer process.
 *
 * Called from renderer main before the app mounts; `useGameHostStore` then
 * works from any window (stage, settings, ...). The port shapes mirror the
 * stage-ui types structurally — the shared Eventa contracts stay in the app
 * shell.
 */
export function installGameHostBridge(): void {
  const client = createGameHostClient()

  installGameHostBridgeClient({
    getStatus: async () => {
      const status = await client.getStatus()
      // MC-1b D2: a disconnected bridge has no current world; drop the cached
      // observation instead of letting it read as current.
      if (status.status !== 'connected')
        useGameWorldStore().clear()
      return {
        phase: status.status,
        ...(status.error ? { error: status.error } : {}),
        ...(status.identity ? { identity: status.identity } : {}),
      }
    },
    getConfig: () => client.getConfig(),
    applyConfig: async (config) => {
      const status = await client.applyConfig(config)
      return {
        phase: status.status,
        ...(status.error ? { error: status.error } : {}),
        ...(status.identity ? { identity: status.identity } : {}),
      }
    },
  })

  // MC-3c D4: a chat message accepted by the main process becomes a user turn
  // only in the leader renderer; other windows observe nothing.
  const leadership = resolveRendererWindowContext().leadership
  console.info('[game-host] chat command bridge', leadership)
  if (leadership === 'leader-only') {
    /**
     * Deterministic interruption: an explicit stop or a new instruction must
     * not wait behind a long game tool call. Cancelling the active write
     * command unblocks the running turn so the queued turn can start.
     */
    const cancelActiveGameCommand = async (): Promise<void> => {
      const tool = useLlmToolsStore().getToolsByNames('game_cancel')[0]
      if (!tool?.execute)
        return
      try {
        await tool.execute({}, { messages: [], toolCallId: 'mc-chat-interrupt' })
      }
      catch {
        // No active command or an already stopped one is not an error here.
      }
    }

    client.onChatCommand((payload) => {
      console.info('[game-host] chat command received', payload.messageId, payload.sender, payload.trigger)
      const sessionId = useChatSessionStore().activeSessionId || undefined
      if (!sessionId) {
        console.warn('[game-host] chat command dropped: no active session')
        return
      }
      void cancelActiveGameCommand()
      // MC-3c D4 v1: the turn carries its channel so replies land where the
      // command came from. The multichannel design will formalize this as
      // channel metadata; until then the context rides the turn text.
      void useChatStore().send({ sessionId, text: gameChatTurnText(payload) }).then(() => {
        console.info('[game-host] chat command turn finished', payload.messageId)
      }).catch((error) => {
        // A failed turn only costs this command; the chat path reports its own
        // provider errors and the next accepted message retries.
        console.warn('[game-host] chat command turn failed', errorMessageFrom(error) ?? error)
      })
    })
  }
}
