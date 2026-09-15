import type { ExecutableTool, ToolRegistrationInput } from '@proj-airi/stage-ui/stores/ai/chat-llm/tools'
import type { ToolExecuteOptions } from '@xsai/shared-chat'

import { errorMessageFrom } from '@moeru/std'
import { useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { useLlmToolsStore } from '@proj-airi/stage-ui/stores/ai/chat-llm/tools'
import { useLlmToolsetPromptsStore } from '@proj-airi/stage-ui/stores/ai/chat-llm/toolset-prompts'
import { rawTool } from '@xsai/tool'
import { defineStore } from 'pinia'

import { electronPluginCancelTool, electronPluginInvokeTool, electronPluginListXsaiTools } from '../../../shared/eventa/plugin/tools'

export const useTamagotchiPluginToolsStore = defineStore('tamagotchi-plugin-tools', () => {
  const llmToolsStore = useLlmToolsStore()
  const llmToolsetPromptsStore = useLlmToolsetPromptsStore()
  const listPluginXsaiToolDefinitions = useElectronEventaInvoke(electronPluginListXsaiTools)
  const invokePluginTool = useElectronEventaInvoke(electronPluginInvokeTool)
  const cancelPluginTool = useElectronEventaInvoke(electronPluginCancelTool)
  const toolIdPrefix = 'plugin:'

  function registeredToolIds() {
    return llmToolsStore.tools
      .filter(tool => tool.id.startsWith(toolIdPrefix))
      .map(tool => tool.id)
  }

  async function refresh() {
    const abortController = new AbortController()
    const timeout = setTimeout(() => abortController.abort(new Error(`Timed out after ${5_000}ms`)), 5_000)

    const definitions = await listPluginXsaiToolDefinitions(undefined, { signal: abortController.signal })
      .catch((error) => {
        console.warn(`[plugin-tools] Failed to list plugin xsai tools: ${errorMessageFrom(error) ?? 'Unknown error'}`)
        return { prompts: [], tools: [] }
      })
      .finally(() => {
        clearTimeout(timeout)
      })

    llmToolsetPromptsStore.registerToolsetPrompts(
      'plugin-tools',
      definitions.prompts.map(definition => ({
        id: `${definition.ownerExtensionId}:${definition.id}`,
        title: definition.prompt.title,
        content: definition.prompt.content,
      })),
    )

    const entries = definitions.tools.map((definition): { tool: ExecutableTool, registration: ToolRegistrationInput } => {
      const id = `${toolIdPrefix}${definition.ownerExtensionId}:${definition.name}`
      return {
        tool: {
          ...rawTool({
            name: definition.name,
            description: definition.description,
            parameters: definition.parameters,
            execute: async (input: unknown, options?: ToolExecuteOptions) => {
              // One correlation id per call: the main process aborts exactly
              // this call when the registration is revoked.
              const requestId = crypto.randomUUID()
              const signal = options?.abortSignal
              const cancel = () => {
                void cancelPluginTool({ requestId }).catch(() => {})
              }
              if (signal?.aborted)
                cancel()
              else
                signal?.addEventListener('abort', cancel, { once: true })

              try {
                return await invokePluginTool({
                  requestId,
                  ownerExtensionId: definition.ownerExtensionId,
                  name: definition.name,
                  input,
                }, signal ? { signal } : undefined)
              }
              finally {
                signal?.removeEventListener('abort', cancel)
              }
            },
          }),
          id,
        },
        registration: {
          toolId: id,
          toolName: definition.name,
          ownerKind: 'plugin' as const,
          ownerId: definition.ownerExtensionId,
          execution: { kind: 'extension_host' as const, chain: ['plugin', definition.ownerExtensionId] },
        },
      }
    })

    await llmToolsStore.removeToolsByIds(...registeredToolIds())
    await llmToolsStore.addRegisteredTools(...entries)
  }

  async function dispose() {
    llmToolsetPromptsStore.clearToolsetPrompts('plugin-tools')
    await llmToolsStore.removeToolsByIds(...registeredToolIds())
  }

  return {
    dispose,
    refresh,
  }
}, {
  synced: {
    actions: ['dispose', 'refresh'],
    state: false,
  },
})
