import type { ExecutableTool } from '@proj-airi/stage-ui/stores/ai/chat-llm/tools'
import type { McpToolRuntime } from '@proj-airi/stage-ui/tools/mcp'
import type { Tool } from '@xsai/shared-chat'

import { useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { useLlmToolsStore } from '@proj-airi/stage-ui/stores/ai/chat-llm/tools'
import { useLlmToolsetPromptsStore } from '@proj-airi/stage-ui/stores/ai/chat-llm/toolset-prompts'
import { createMcpNativeTools, createMcpTools } from '@proj-airi/stage-ui/tools/mcp'
import { defineStore } from 'pinia'

import { electronMcpCallTool, electronMcpListTools } from '../../../shared/eventa'

export const useTamagotchiMcpToolsStore = defineStore('tamagotchi-mcp-tools', () => {
  const llmToolsStore = useLlmToolsStore()
  const llmToolsetPromptsStore = useLlmToolsetPromptsStore()
  const listMcpTools = useElectronEventaInvoke(electronMcpListTools)
  const callMcpTool = useElectronEventaInvoke(electronMcpCallTool)
  const toolIdPrefix = 'mcp:'

  function registeredToolIds() {
    return llmToolsStore.tools
      .filter(tool => tool.id.startsWith(toolIdPrefix))
      .map(tool => tool.id)
  }

  // Teaches the model where the mcp_* tools come from instead of leaving it
  // to guess from tool names alone; follows the toolset-prompt registry.
  function registerMcpToolsetPrompt(serverNames: string[]) {
    const uniqueServers = [...new Set(serverNames)]
    const content = uniqueServers.length > 0
      ? `Tools named mcp_<server>_<tool> call MCP servers (${uniqueServers.join(', ')}). Invoke them directly with plain object arguments when needed, and never fabricate their results.`
      : 'MCP tools are reachable through builtIn_mcpListTools followed by builtIn_mcpCallTool (arguments passed as a JSON string).'
    llmToolsetPromptsStore.registerToolsetPrompts('mcp-tools', [{
      id: 'mcp-tools-overview',
      title: 'MCP Servers',
      content,
    }])
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
      registerMcpToolsetPrompt(descriptors.map(descriptor => descriptor.serverName))
    }
    catch (error) {
      console.warn('[tamagotchi-mcp-tools] listTools failed, falling back to proxy tools:', error)
      tools = await Promise.all(createMcpTools(runtime))
      registerMcpToolsetPrompt([])
    }

    llmToolsStore.removeToolsByIds(...registeredToolIds())
    llmToolsStore.addTools(...tools.map(tool => ({
      ...tool,
      id: `${toolIdPrefix}${tool.function.name}`,
    } satisfies ExecutableTool)))
  }

  function dispose() {
    llmToolsStore.removeToolsByIds(...registeredToolIds())
    llmToolsetPromptsStore.clearToolsetPrompts('mcp-tools')
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
