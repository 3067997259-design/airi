import type { ExecutableTool } from '@proj-airi/stage-ui/stores/ai/chat-llm/tools'
import type { McpToolRuntime } from '@proj-airi/stage-ui/tools/mcp'
import type { Tool } from '@xsai/shared-chat'

import { useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { useLlmToolsStore } from '@proj-airi/stage-ui/stores/ai/chat-llm/tools'
import { createMcpNativeTools, createMcpTools } from '@proj-airi/stage-ui/tools/mcp'
import { defineStore } from 'pinia'

import { electronMcpCallTool, electronMcpListTools } from '../../../shared/eventa'

export const useTamagotchiMcpToolsStore = defineStore('tamagotchi-mcp-tools', () => {
  const llmToolsStore = useLlmToolsStore()
  const listMcpTools = useElectronEventaInvoke(electronMcpListTools)
  const callMcpTool = useElectronEventaInvoke(electronMcpCallTool)
  const toolIdPrefix = 'mcp:'

  function registeredToolIds() {
    return llmToolsStore.tools
      .filter(tool => tool.id.startsWith(toolIdPrefix))
      .map(tool => tool.id)
  }

  async function refresh() {
    const runtime: McpToolRuntime = {
      listTools: () => listMcpTools(),
      callTool: payload => callMcpTool(payload),
    }

    // Prefer one native tool per MCP tool so the model calls them directly;
    // fall back to the two list/call proxy tools when discovery yields
    // nothing usable (no servers configured, or listing failed).
    let tools: Tool[]
    try {
      const descriptors = await runtime.listTools()
      tools = descriptors.length > 0
        ? createMcpNativeTools(descriptors, runtime)
        : await Promise.all(createMcpTools(runtime))
    }
    catch (error) {
      console.warn('[tamagotchi-mcp-tools] listTools failed, falling back to proxy tools:', error)
      tools = await Promise.all(createMcpTools(runtime))
    }

    llmToolsStore.removeToolsByIds(...registeredToolIds())
    llmToolsStore.addTools(...tools.map(tool => ({
      ...tool,
      id: `${toolIdPrefix}${tool.function.name}`,
    } satisfies ExecutableTool)))
  }

  function dispose() {
    llmToolsStore.removeToolsByIds(...registeredToolIds())
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
