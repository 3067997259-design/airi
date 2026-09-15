<script setup lang="ts">
/**
 * Game host devtools probe (MC-0a).
 *
 * There is no product UI for the game host yet. This page exposes the
 * renderer-side bridge on `window.__AIRI_GAME_HOST_SMOKE__` so a CDP session
 * can drive connect/observe/whitelist checks and snapshot the LLM tool face.
 */
import type { GameHostConfig, GameHostConfigView, GameHostObservationResult, GameHostStatus } from '../../../shared/eventa'

import { useLlmToolsStore } from '@proj-airi/stage-ui/stores/ai/chat-llm/tools'
import { onMounted, onUnmounted, ref } from 'vue'

import { createGameHostClient } from '../../bridges/game-host'

declare global {
  interface Window {
    __AIRI_GAME_HOST_SMOKE__?: {
      applyConfig: (config: GameHostConfig) => Promise<GameHostStatus>
      getStatus: () => Promise<GameHostStatus>
      getConfig: () => Promise<GameHostConfigView>
      observe: (params: { toolName: string, arguments?: Record<string, unknown> }) => Promise<GameHostObservationResult>
      toolNames: () => string[]
      /** Runs one registered model tool through the full tool face. */
      executeGameTool: (toolName: string, input?: Record<string, unknown>) => Promise<unknown>
    }
  }
}

const client = createGameHostClient()
const status = ref('idle')

onMounted(() => {
  window.__AIRI_GAME_HOST_SMOKE__ = {
    applyConfig: config => client.applyConfig(config),
    getStatus: () => client.getStatus(),
    getConfig: () => client.getConfig(),
    observe: params => client.observe(params),
    toolNames: () => useLlmToolsStore().tools.map(tool => tool.function.name),
    executeGameTool: async (toolName, input) => {
      const tool = useLlmToolsStore().getToolsByNames(toolName)[0]
      if (!tool?.execute)
        throw new Error(`Tool "${toolName}" is not registered.`)
      return await tool.execute(input ?? {}, { messages: [], toolCallId: 'game-host-smoke' })
    },
  }
  status.value = 'probe ready'
})

onUnmounted(() => {
  delete window.__AIRI_GAME_HOST_SMOKE__
})
</script>

<template>
  <div :class="['p-4', 'space-y-2']">
    <h1 :class="['text-lg', 'font-semibold']">
      Game Host
    </h1>
    <p :class="['text-sm', 'opacity-70']">
      {{ status }}
    </p>
  </div>
</template>
