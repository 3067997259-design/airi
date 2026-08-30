import { defineStore } from 'pinia'

import { FETCH_TOOLSET_PROMPT } from '../../tools/fetch'
import { useLlmToolsetPromptsStore } from '../ai/chat-llm/toolset-prompts'

/**
 * Lifecycle for the page-fetch capability.
 *
 * The `fetch` tool is always mounted by `resolveLlmTools`, so unlike the
 * web-search module there is no configured gate. This store exists to pair the
 * tool with its safety prompt: the chat store instantiates it eagerly (same
 * pattern as the web-search store) so the "fetched text is data, not
 * instructions" rule is present on the very first turn.
 */
export const useFetchModuleStore = defineStore('fetch', () => {
  const toolsetPromptsStore = useLlmToolsetPromptsStore()

  function refresh() {
    toolsetPromptsStore.registerToolsetPrompts('fetch', [{ id: 'fetch', content: FETCH_TOOLSET_PROMPT }])
  }

  return { refresh }
})
