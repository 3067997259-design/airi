import type { ToolEvidenceAuthor } from '@proj-airi/core-agent'
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

/**
 * Who owns one registered tool and how its execution is trusted.
 *
 * The record is the only input of the evidence decision: a tool that is not
 * in this table is never trusted as a host tool, no matter how its name is
 * wrapped. `toolId` is the registration key and `toolName` is the model-facing
 * key; both must be unique across the store.
 */
export interface ToolRegistration {
  /** Registration key; unique across the store. */
  toolId: string
  /** Model-facing function name; unique across the store, unlike the opaque toolId. */
  toolName: string
  ownerKind: 'builtin' | 'reviewed_skill' | 'plugin' | 'game_adapter' | 'mcp'
  /** Per-tool owner: skill toolId, extension id, game-host service, MCP server name. */
  ownerId: string
  /**
   * Execution chain from the registration surface down to the executor.
   * The authority is read at the deepest entry, never at the wrapper.
   */
  execution: {
    kind: 'host' | 'coding_sandbox' | 'extension_host' | 'remote'
    chain: string[]
  }
  /** Required when ownerKind is reviewed_skill; plugins carry it only when approved. */
  approvedContentHash?: string
  registeredAt: number
}

/** A registration before the store stamps `registeredAt`. */
export type ToolRegistrationInput = Omit<ToolRegistration, 'registeredAt'>

/** Raised when a registration would violate single-owner or name uniqueness. */
export class DuplicateToolRegistrationError extends Error {
  readonly toolId: string
  readonly conflicting: 'toolId' | 'toolName'
  readonly existingOwnerId: string

  constructor(input: { toolId: string, conflicting: 'toolId' | 'toolName', existingOwnerId: string }) {
    const key = input.conflicting === 'toolId' ? `id "${input.toolId}"` : `name "${input.toolId}"`
    super(`Tool registration ${key} is already owned by "${input.existingOwnerId}".`)
    this.name = 'DuplicateToolRegistrationError'
    this.toolId = input.toolId
    this.conflicting = input.conflicting
    this.existingOwnerId = input.existingOwnerId
  }
}

function unavailableToolResult(name: string) {
  return `Tool "${name}" is not available now.`
}

/** The reviewed-skill hash projection the skills store provides. */
export interface ReviewedSkillApproval {
  toolId: string
  contentHash: string
}

/**
 * Whether a game-domain tool result carries the game-host receipt check
 * (mc-0c): checked results grade `game_checked`, raw reports stay `game`.
 */
function isCheckedGameResult(result: unknown): boolean {
  if (result === null || result === undefined)
    return false
  let record: unknown = result
  if (typeof result === 'string') {
    try {
      record = JSON.parse(result)
    }
    catch {
      return false
    }
  }
  return typeof record === 'object' && record !== null && !Array.isArray(record)
    && (record as { checked?: unknown }).checked === true
}

function hasValidSkillApproval(
  toolId: string,
  approvedContentHash: string | undefined,
  reviewedSkills: readonly ReviewedSkillApproval[],
): boolean {
  // The record names the hash the execution chain was approved against; a
  // skill that was re-submitted or quarantined afterwards no longer matches.
  if (!approvedContentHash)
    return false
  return reviewedSkills.some(skill => skill.toolId === toolId && skill.contentHash === approvedContentHash)
}

/**
 * Resolves the evidence bucket for one registered tool.
 *
 * The wrapper never adds trust: a tool without a record is untrusted, and a
 * plugin earns the reviewed bucket only when its execution chain points at a
 * skill whose approved hash is still current (EP-0 D1/D5). The authority is
 * read from the deepest chain entry, never from the registration surface.
 */
export function resolveEvidenceAuthor(
  registration: ToolRegistration | undefined,
  reviewedSkills: readonly ReviewedSkillApproval[],
  result?: unknown,
): ToolEvidenceAuthor {
  if (!registration)
    return 'untrusted_plugin'

  switch (registration.ownerKind) {
    case 'builtin':
      return 'builtin'
    case 'mcp':
      return 'remote_agent'
    case 'game_adapter':
      // The adapter grades its own receipts: `checked` means the game host
      // verified source, authorization, binding, and a fresh postcondition.
      return isCheckedGameResult(result) ? 'game_checked' : 'game'
    case 'reviewed_skill':
      return hasValidSkillApproval(registration.ownerId, registration.approvedContentHash, reviewedSkills)
        ? 'reviewed_self_authored'
        : 'untrusted_plugin'
    case 'plugin': {
      for (let index = registration.execution.chain.length - 1; index >= 0; index--) {
        const match = /^skill:([^@]+)(?:@(.+))?$/.exec(registration.execution.chain[index] ?? '')
        if (!match?.[1])
          continue
        // EP-2a package chains embed the reviewed skill hash
        // (`skill:<toolId>@<hash>`); the skill adapter names only the skill id
        // and relies on the registration hash. Either way the deepest entry
        // decides trust (EP-0 D1).
        const contentHash = match[2] ?? registration.approvedContentHash
        if (contentHash && hasValidSkillApproval(match[1], contentHash, reviewedSkills))
          return 'reviewed_self_authored'
      }
      return 'untrusted_plugin'
    }
  }
}

/**
 * Result returned when a registration was revoked while its call was in
 * flight. The core runtime maps `status: 'revoked'` to a revoked receipt, so
 * the late result stays visible without entering any completion gate.
 */
function revokedToolResult(name: string) {
  return JSON.stringify({
    status: 'revoked',
    toolName: name,
    message: `Tool "${name}" was revoked before its result arrived; the result is discarded.`,
  })
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
  const registrations = ref<ToolRegistration[]>([])
  const executors = new Map<string, Tool['execute']>()
  // Registration-scoped cancellation handles. They never enter synchronized
  // state: a controller belongs to the window that registered the executor,
  // and only that window can abort its in-flight calls.
  const registrationAbortControllers = new Map<string, AbortController>()

  function registrationAbortController(toolId: string): AbortController {
    let controller = registrationAbortControllers.get(toolId)
    if (!controller) {
      controller = new AbortController()
      registrationAbortControllers.set(toolId, controller)
    }
    return controller
  }

  function executableToolFrom(definition: ToolDefinition): Tool {
    const executor = executors.get(definition.id)
    if (!executor) {
      return {
        type: definition.type,
        function: definition.function,
        execute: () => unavailableToolResult(definition.function.name),
      }
    }

    return {
      type: definition.type,
      function: definition.function,
      execute: async (input, options) => {
        // Either the turn or the registration can end the call. The
        // registration signal wins in the result check: a late receipt from a
        // revoked registration is discarded, not returned as a normal result.
        const controller = registrationAbortController(definition.id)
        const signal = options?.abortSignal
          ? AbortSignal.any([options.abortSignal, controller.signal])
          : controller.signal

        try {
          const result = await executor(input, { ...options, abortSignal: signal })
          if (controller.signal.aborted)
            return revokedToolResult(definition.function.name)
          return result
        }
        catch (error) {
          if (controller.signal.aborted && !options?.abortSignal?.aborted)
            return revokedToolResult(definition.function.name)
          throw error
        }
      },
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

  /**
   * Registers or refreshes tool records in the elected leader.
   *
   * Uniqueness rules (EP-0 D2): the same `toolId` with the same owner is a
   * refresh that keeps its list position; a different owner for the same
   * `toolId` or a different `toolId` carrying the same model-facing name is
   * rejected. Callers must remove a registration before they replace its
   * owner, so the store never holds two live owners for one tool.
   */
  async function commitRegistrations(nextRegistrations: ToolRegistration[]) {
    if (nextRegistrations.length === 0)
      return

    const merged = [...registrations.value]
    for (const registration of nextRegistrations) {
      const sameId = merged.find(item => item.toolId === registration.toolId)
      if (sameId && sameId.ownerId !== registration.ownerId)
        throw new DuplicateToolRegistrationError({ toolId: registration.toolId, conflicting: 'toolId', existingOwnerId: sameId.ownerId })
      const sameName = merged.find(item => item.toolName === registration.toolName && item.toolId !== registration.toolId)
      if (sameName)
        throw new DuplicateToolRegistrationError({ toolId: registration.toolId, conflicting: 'toolName', existingOwnerId: sameName.ownerId })

      const existingIndex = merged.findIndex(item => item.toolId === registration.toolId)
      if (existingIndex >= 0)
        merged[existingIndex] = registration
      else
        merged.push(registration)
    }

    registrations.value = merged
  }

  /** Removes serializable tool definitions and registrations in the elected leader. */
  async function commitToolRemovals(ids: string[]) {
    if (ids.length === 0)
      return

    const idSet = new Set(ids)
    tools.value = tools.value.filter(tool => !idSet.has(tool.id))
    registrations.value = registrations.value.filter(registration => !idSet.has(registration.toolId))
  }

  /** Adds tools or replaces existing tools that have the same application id. */
  async function addTools(...nextTools: ExecutableTool[]) {
    const definitions = nextTools.map((tool) => {
      executors.set(tool.id, tool.execute)
      return toToolDefinition(tool)
    })

    await commitToolDefinitions(definitions)
  }

  /**
   * Registers tools together with their ownership records.
   *
   * The record commits before the executors and definitions, so a rejected
   * registration never leaves a callable tool behind. Tools registered
   * through plain `addTools` carry no record and resolve to the least trusted
   * evidence bucket (EP-0 D5).
   */
  async function addRegisteredTools(...entries: Array<{ tool: ExecutableTool, registration: ToolRegistrationInput }>) {
    if (entries.length === 0)
      return

    await commitRegistrations(entries.map(entry => ({
      ...entry.registration,
      registeredAt: Date.now(),
    })))

    const definitions = entries.map((entry) => {
      executors.set(entry.tool.id, entry.tool.execute)
      return toToolDefinition(entry.tool)
    })

    await commitToolDefinitions(definitions)
  }

  /** Removes one tool definition and its local executor. */
  async function removeToolById(id: string) {
    await removeToolsByIds(id)
  }

  /** Removes tool definitions, registrations, and their local executors. */
  async function removeToolsByIds(...ids: string[]) {
    if (ids.length === 0)
      return

    const idSet = new Set(ids)
    for (const id of idSet) {
      executors.delete(id)
      // Revocation step two: abort every in-flight call of this registration.
      // The executor wrapper turns their late results into revoked receipts.
      registrationAbortControllers.get(id)?.abort(new Error(`Tool registration revoked: ${id}`))
      registrationAbortControllers.delete(id)
    }

    await commitToolRemovals(ids)
  }

  return {
    activeTools,
    addRegisteredTools,
    addTools,
    commitRegistrations,
    commitToolDefinitions,
    commitToolRemovals,
    getToolsByNames,
    registrations,
    removeToolById,
    removeToolsByIds,
    tools,
  }
}, {
  synced: {
    state: true,
    // Synchronized action arguments must be structured-cloneable. Executors
    // are functions, so callers register them locally and route only these
    // serializable definition/registration/removal actions through the
    // elected leader.
    actions: ['commitRegistrations', 'commitToolDefinitions', 'commitToolRemovals'],
  },
})
