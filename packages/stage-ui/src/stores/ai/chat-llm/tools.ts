import type { Tool } from '@xsai/shared-chat'
import type {} from 'pinia-plugin-synced'

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

/** A serializable tool definition shared between application contexts. */
export interface ToolDefinition extends Omit<Tool, 'execute'> {
  /** A stable application id. This id does not need to match the model-facing name. */
  id: string
  /** Includes this tool when a request does not select it explicitly. */
  defaultActive?: boolean
}

/** A tool definition with the executor that is available in the current runtime. */
export interface ExecutableTool extends Tool {
  /** A stable application id. This id does not need to match the model-facing name. */
  id: string
  /** Includes this tool when a request does not select it explicitly. */
  defaultActive?: boolean
}

function unavailableToolResult(name: string) {
  return `Tool "${name}" is not available now.`
}

function mergeToolDefinitions(current: ToolDefinition[], next: ToolDefinition[]) {
  const definitions = [...current]

  for (const definition of next) {
    const existingIndex = definitions.findIndex(item => item.id === definition.id)
    if (existingIndex >= 0) {
      definitions[existingIndex] = definition
      continue
    }

    definitions.push(definition)
  }

  return definitions
}

function toToolDefinition(tool: ExecutableTool): ToolDefinition {
  return structuredClone<ToolDefinition>({
    id: tool.id,
    type: tool.type,
    function: tool.function,
    ...(tool.defaultActive === undefined ? {} : { defaultActive: tool.defaultActive }),
  })
}

/**
 * Stores serializable tool definitions and runtime-local executors.
 *
 * The Pinia state contains definitions only. The executor map never enters
 * synchronized state. `addTools` and the removal methods register or remove
 * executors in the calling runtime, then route only serializable definitions
 * through the elected leader.
 */
export const useLlmToolsStore = defineStore('llm-tools', () => {
  const tools = ref<ToolDefinition[]>([])
  const executors = new Map<string, Tool['execute']>()

  function executableToolFrom(definition: ToolDefinition): Tool {
    const execute = executors.get(definition.id)
      ?? (() => unavailableToolResult(definition.function.name))

    return {
      type: definition.type,
      function: definition.function,
      execute,
    }
  }

  const activeTools = computed<Tool[]>(() => tools.value
    .filter(tool => tool.defaultActive !== false)
    .map(executableToolFrom))

  /** Resolves registered tools in the requested model-facing name order. */
  function getToolsByNames(...names: string[]): Tool[] {
    return names.flatMap((name) => {
      const definition = tools.value.findLast(tool => tool.function.name === name)
      return definition ? [executableToolFrom(definition)] : []
    })
  }

  /** Commits serializable tool definitions in the elected leader. */
  async function commitToolDefinitions(nextDefinitions: ToolDefinition[]) {
    tools.value = mergeToolDefinitions(tools.value, nextDefinitions)
  }

  /** Removes serializable tool definitions in the elected leader. */
  async function commitToolRemovals(ids: string[]) {
    if (ids.length === 0)
      return

    const idSet = new Set(ids)
    tools.value = tools.value.filter(tool => !idSet.has(tool.id))
  }

  /** Adds tools or replaces existing tools that have the same application id. */
  async function addTools(...nextTools: ExecutableTool[]) {
    const definitions = nextTools.map((tool) => {
      executors.set(tool.id, tool.execute)
      return toToolDefinition(tool)
    })

    await commitToolDefinitions(definitions)
  }

  /** Removes one tool definition and its local executor. */
  async function removeToolById(id: string) {
    await removeToolsByIds(id)
  }

  /** Removes tool definitions and their local executors. */
  async function removeToolsByIds(...ids: string[]) {
    if (ids.length === 0)
      return

    const idSet = new Set(ids)
    for (const id of idSet)
      executors.delete(id)

    await commitToolRemovals(ids)
  }

  return {
    activeTools,
    addTools,
    commitToolDefinitions,
    commitToolRemovals,
    getToolsByNames,
    removeToolById,
    removeToolsByIds,
    tools,
  }
}, {
  synced: {
    state: true,
    // Synchronized action arguments must be structured-cloneable. Executors
    // are functions, so callers register them locally and route only these
    // serializable definition/removal actions through the elected leader.
    actions: ['commitToolDefinitions', 'commitToolRemovals'],
  },
})
