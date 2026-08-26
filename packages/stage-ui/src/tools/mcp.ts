import type { Tool } from '@xsai/shared-chat'

import { errorMessageFromValue } from '@proj-airi/stage-shared'
import { rawTool, tool } from '@xsai/tool'
import { z } from 'zod'

/**
 * Describes an MCP tool that can be exposed to the shared LLM runtime.
 *
 * Use when:
 * - A runtime needs to list available MCP tools before exposing them to models
 *
 * Expects:
 * - `name` is the fully-qualified tool name used for invocation
 *
 * Returns:
 * - The MCP tool descriptor metadata reported by the runtime
 */
export interface McpToolDescriptor {
  serverName: string
  name: string
  toolName: string
  description?: string
  inputSchema: Record<string, unknown>
}

/**
 * Payload for invoking an MCP tool through a runtime-specific transport.
 *
 * Use when:
 * - A runtime needs to forward a tool invocation into the MCP layer
 *
 * Expects:
 * - `name` matches a descriptor returned from `listTools`
 * - `arguments` is a JSON-compatible object when provided
 *
 * Returns:
 * - The MCP tool call input envelope
 */
export interface McpCallToolPayload {
  name: string
  arguments?: Record<string, unknown>
}

/**
 * Result returned from an MCP tool invocation.
 *
 * Use when:
 * - An MCP runtime returns tool output back to the shared LLM layer
 *
 * Expects:
 * - Error responses set `isError` when the tool execution failed
 *
 * Returns:
 * - Structured and unstructured MCP tool output
 */
export interface McpCallToolResult {
  content?: Array<Record<string, unknown>>
  structuredContent?: Record<string, unknown>
  toolResult?: unknown
  isError?: boolean
}

/**
 * Runtime contract for wiring MCP tool discovery and execution into `stage-ui`.
 *
 * Use when:
 * - A concrete runtime such as Electron needs to provide MCP access without a singleton bridge
 *
 * Expects:
 * - `listTools` and `callTool` are safe to call multiple times
 *
 * Returns:
 * - An object that can back `createMcpTools`
 */
export interface McpToolRuntime {
  listTools: () => Promise<McpToolDescriptor[]>
  callTool: (payload: McpCallToolPayload) => Promise<McpCallToolResult>
}

/**
 * Creates MCP proxy tools backed by a runtime-provided transport.
 *
 * Use when:
 * - A runtime wants to register MCP tools into the shared LLM tool store
 *
 * Expects:
 * - The runtime implements the `McpToolRuntime` contract
 *
 * Returns:
 * - xsai tool definition promises for MCP listing and invocation
 */
export function createMcpTools(runtime: McpToolRuntime): Array<Promise<Tool>> {
  return [
    tool({
      name: 'builtIn_mcpListTools',
      description: 'List all available MCP tools. Call this first to discover tool names before calling builtIn_mcpCallTool.',
      execute: async () => {
        try {
          return await runtime.listTools()
        }
        catch (error) {
          console.warn('[builtIn_mcpListTools] failed to list tools:', error)
          return ''
        }
      },
      parameters: z.object({}).strict(),
    }),
    tool({
      name: 'builtIn_mcpCallTool',
      description: 'Call an MCP tool by name. Use builtIn_mcpListTools first to get available tool names.',
      execute: async ({ name, arguments: argsJson }) => {
        try {
          const args = argsJson ? JSON.parse(argsJson) : {}
          return await runtime.callTool({ name, arguments: args })
        }
        catch (error) {
          return {
            isError: true,
            content: [{ type: 'text', text: errorMessageFromValue(error) }],
          }
        }
      },
      // NOTICE: `arguments` is z.string() (JSON) because z.unknown() produces `{}` (no `type` key)
      // and z.record() emits `propertyNames`, both rejected by OpenAI.
      parameters: z.object({
        name: z.string().describe('Tool name in "<serverName>::<toolName>" format'),
        arguments: z.string().describe('JSON object of tool arguments, e.g. {"query":"hello","limit":10}'),
      }).strict(),
    }),
  ]
}

function createUnavailableMcpToolRuntime(): McpToolRuntime {
  return {
    async listTools() {
      throw new Error('MCP tools are not available in this runtime.')
    },
    async callTool() {
      throw new Error('MCP tools are not available in this runtime.')
    },
  }
}

/** Model-facing tool names must satisfy ^[a-zA-Z0-9_-]{1,64}$ on OpenAI-compatible APIs. */
const MODEL_TOOL_NAME_MAX_LENGTH = 64

function sanitizeNamePart(part: string): string {
  const sanitized = part
    .replace(/\W/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '')
  return sanitized || 'x'
}

/**
 * Builds a provider-safe tool name for one MCP tool.
 *
 * Use when:
 * - Generating native per-tool definitions from `listTools` descriptors
 *
 * Expects:
 * - `serverName` and `toolName` come from an `McpToolDescriptor`
 *
 * Returns:
 * - `mcp_<server>_<tool>` restricted to `[A-Za-z0-9_]`, capped at 64 chars with
 *   a stable short hash suffix when truncated so distinct tools stay distinct
 */
export function sanitizeMcpToolName(serverName: string, toolName: string): string {
  const base = `mcp_${sanitizeNamePart(serverName)}_${sanitizeNamePart(toolName)}`
  if (base.length <= MODEL_TOOL_NAME_MAX_LENGTH)
    return base
  let hash = 5381
  for (let i = 0; i < base.length; i++)
    hash = ((hash << 5) + hash + base.charCodeAt(i)) >>> 0
  const suffix = `_${hash.toString(36)}`.slice(0, 8)
  return `${base.slice(0, MODEL_TOOL_NAME_MAX_LENGTH - suffix.length)}${suffix}`
}

/**
 * Coerces an MCP `inputSchema` into a JSON Schema object providers accept.
 *
 * Use when:
 * - Passing `McpToolDescriptor.inputSchema` to `rawTool` parameters
 *
 * Expects:
 * - MCP servers SHOULD send `{ type: 'object' }` schemas, but misbehaving ones
 *   send arrays, strings, or objects without a type
 *
 * Returns:
 * - A plain object with `type: 'object'` and an object `properties` map;
 *   `required` is preserved only when it is an array
 */
export function normalizeMcpInputSchema(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  const source = schema !== null && typeof schema === 'object' && !Array.isArray(schema)
    ? schema
    : {}
  const properties = source.properties !== null && typeof source.properties === 'object' && !Array.isArray(source.properties)
    ? source.properties as Record<string, unknown>
    : {}
  const normalized: Record<string, unknown> = {
    ...source,
    type: 'object',
    properties,
  }
  if (!Array.isArray(normalized.required))
    delete normalized.required
  return normalized
}

/**
 * Creates one native model tool per MCP tool descriptor.
 *
 * Use when:
 * - A runtime wants the model to call MCP tools directly instead of going
 *   through the two-hop `builtIn_mcpListTools` / `builtIn_mcpCallTool` proxies
 *
 * Expects:
 * - Descriptors come from `McpToolRuntime.listTools()`
 *
 * Returns:
 * - xsai raw tools; execution maps back to the fully-qualified
 *   `<serverName>::<toolName>` name and forwards object arguments as-is
 */
export function createMcpNativeTools(descriptors: McpToolDescriptor[], runtime: McpToolRuntime): Tool[] {
  const usedNames = new Set<string>()
  return descriptors.map((descriptor) => {
    let name = sanitizeMcpToolName(descriptor.serverName, descriptor.toolName)
    for (let counter = 2; usedNames.has(name); counter++) {
      const tail = `_${counter}`
      name = `${name.slice(0, MODEL_TOOL_NAME_MAX_LENGTH - tail.length)}${tail}`
    }
    usedNames.add(name)
    const description = `[MCP:${descriptor.serverName}] ${descriptor.description?.trim() || descriptor.toolName}`
    return rawTool({
      name,
      description: description.length > 1024 ? description.slice(0, 1024) : description,
      parameters: normalizeMcpInputSchema(descriptor.inputSchema),
      execute: async (rawInput) => {
        const args = rawInput !== null && typeof rawInput === 'object' && !Array.isArray(rawInput)
          ? rawInput as Record<string, unknown>
          : {}
        return await runtime.callTool({ name: descriptor.name, arguments: args })
      },
    })
  })
}

/**
 * Builds the default stage-ui MCP tool set without depending on runtime singletons.
 *
 * Use when:
 * - Shared code needs the MCP tool schema before a concrete runtime registers live implementations
 *
 * Expects:
 * - Runtime-specific callers override these tools through `useLlmToolsStore`
 *
 * Returns:
 * - MCP tool definitions with an unavailable-runtime fallback
 */
export async function mcp(): Promise<Tool[]> {
  return await Promise.all(createMcpTools(createUnavailableMcpToolRuntime()))
}
