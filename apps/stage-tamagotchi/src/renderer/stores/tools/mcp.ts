import type { ExecutableTool } from '@proj-airi/stage-ui/stores/ai/chat-llm/tools'
import type { McpToolRuntime } from '@proj-airi/stage-ui/tools/mcp'
import type { Tool } from '@xsai/shared-chat'

import { useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { useLlmToolsStore } from '@proj-airi/stage-ui/stores/ai/chat-llm/tools'
import { useLlmToolsetPromptsStore } from '@proj-airi/stage-ui/stores/ai/chat-llm/toolset-prompts'
import { createMcpNativeTools, createMcpTools } from '@proj-airi/stage-ui/tools/mcp'
import { defineStore } from 'pinia'

import { electronMcpCallTool, electronMcpGetRuntimeStatus, electronMcpListTools } from '../../../shared/eventa'

export const useTamagotchiMcpToolsStore = defineStore('tamagotchi-mcp-tools', () => {
  const llmToolsStore = useLlmToolsStore()
  const llmToolsetPromptsStore = useLlmToolsetPromptsStore()
  const listMcpTools = useElectronEventaInvoke(electronMcpListTools)
  const callMcpTool = useElectronEventaInvoke(electronMcpCallTool)
  const getMcpRuntimeStatus = useElectronEventaInvoke(electronMcpGetRuntimeStatus)
  const toolIdPrefix = 'mcp:'

  function registeredToolIds() {
    return llmToolsStore.tools
      .filter(tool => tool.id.startsWith(toolIdPrefix))
      .map(tool => tool.id)
  }

  // Teaches the model where the mcp_* tools come from instead of leaving it
  // to guess from tool names alone; follows the toolset-prompt registry.
  function registerMcpToolsetPrompt(serverNames: string[], serverInstructions: Array<{ name: string, instructions?: string }>) {
    const uniqueServers = [...new Set(serverNames)]
    const guidance = serverInstructions
      .filter(entry => entry.instructions && entry.instructions.trim().length > 0)
      .map(entry => `[${entry.name}] ${entry.instructions!.trim()}`)
    const content = uniqueServers.length > 0
      ? [
          `Tools named mcp_<server>_<tool> call MCP servers (${uniqueServers.join(', ')}). Invoke them directly with plain object arguments when needed, and never fabricate their results.`,
          ...guidance,
        ].join('\n\n')
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

    let runtimeStatus: Awaited<ReturnType<typeof getMcpRuntimeStatus>> | undefined
    try {
      runtimeStatus = await getMcpRuntimeStatus()
    }
    catch (error) {
      console.warn('[tamagotchi-mcp-tools] getRuntimeStatus failed:', error)
    }

    let descriptors: Awaited<ReturnType<typeof runtime.listTools>> = []
    try {
      descriptors = await runtime.listTools()
    }
    catch (error) {
      console.warn('[tamagotchi-mcp-tools] listTools failed:', error)
    }

    // Prefer one native tool per MCP tool so the model calls them directly.
    // The proxy tools remain only for configured servers whose discovery has
    // not landed yet (boot race); with no configured server they can reach
    // nothing, and models treated them as a generic "find a tool" entry and
    // used them to hunt for self-authored skills (ACC-20260910 R05).
    const hasConfiguredServers = (runtimeStatus?.servers.length ?? 0) > 0
    let tools: Tool[]
    if (descriptors.length > 0) {
      tools = createMcpNativeTools(descriptors, runtime)
    }
    else if (hasConfiguredServers) {
      tools = await Promise.all(createMcpTools(runtime))
    }
    else {
      tools = []
    }

    if (tools.length === 0) {
      llmToolsetPromptsStore.clearToolsetPrompts('mcp-tools')
    }
    else {
      const runningServers = (runtimeStatus?.servers ?? [])
        .filter(server => server.state === 'running')
        .map(server => ({ name: server.name, instructions: server.instructions }))
      registerMcpToolsetPrompt(descriptors.map(descriptor => descriptor.serverName), runningServers)
    }

    await llmToolsStore.removeToolsByIds(...registeredToolIds())
    await llmToolsStore.addTools(...tools.map(tool => ({
      ...tool,
      id: `${toolIdPrefix}${tool.function.name}`,
    } satisfies ExecutableTool)))
    scheduleDiscoveryRetry(descriptors.length)
  }

  // Boot race (2026-09-01): App.vue refreshes once at mount, but stdio
  // servers take seconds to reach ready (npx cold start, python boot). A
  // first empty listing used to stick as proxy tools for the whole session.
  // Retry on a bounded chain until native discovery lands or attempts run
  // out; a successful listing resets the counter.
  const DISCOVERY_RETRY_DELAYS_MS = [5_000, 10_000, 15_000, 20_000, 30_000, 30_000]
  let discoveryRetryTimer: ReturnType<typeof setTimeout> | undefined
  let discoveryRetryAttempts = 0

  function scheduleDiscoveryRetry(descriptorCount: number) {
    if (discoveryRetryTimer) {
      clearTimeout(discoveryRetryTimer)
      discoveryRetryTimer = undefined
    }
    if (descriptorCount > 0) {
      discoveryRetryAttempts = 0
      return
    }
    if (discoveryRetryAttempts >= DISCOVERY_RETRY_DELAYS_MS.length)
      return

    const delay = DISCOVERY_RETRY_DELAYS_MS[discoveryRetryAttempts]
    discoveryRetryAttempts++
    discoveryRetryTimer = setTimeout(() => {
      void refresh()
    }, delay)
  }

  async function dispose() {
    llmToolsetPromptsStore.clearToolsetPrompts('mcp-tools')
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
