import type { StreamOptions } from '@proj-airi/core-agent'
import type { Tool } from '@xsai/shared-chat'

import { uniqBy } from 'es-toolkit'

import { createFetchTools, createWebSearchTools, debug } from '../../../tools'
import { useWebSearchStore } from '../../modules/web-search'
import { useLlmToolsStore } from './tools'

type ToolSource = Tool[] | (() => Promise<Tool[]>)

/**
 * Overrides for resolving the complete LLM-visible tool list.
 *
 * Production callers normally pass only {@link customTools}; tests can inject
 * every source to exercise merge and precedence policy without real stores.
 */
export interface ResolveLlmToolsOptions {
  /**
   * MCP-backed built-in tools.
   *
   * @default mcp()
   */
  builtInTools?: ToolSource
  /**
   * Debug tools exposed to the LLM.
   *
   * @default debug()
   */
  debugTools?: ToolSource
  /**
   * Web search tools. Supplying this also avoids reading the web-search module
   * store; by default the tool is included only when a Tavily API key is
   * configured (a keyless search can only error).
   *
   * @default gated on useWebSearchStore().configured
   */
  webSearchTools?: ToolSource
  /**
   * Page-fetch tools. Supplying this avoids creating the default port; by
   * default the browser heuristic guard is used (the Electron shell installs
   * the DNS-resolving main-process port through `installFetchTextPort`).
   *
   * @default createFetchTools()
   */
  fetchTools?: ToolSource
  /**
   * Request-scoped tools from {@link StreamOptions.tools}. These are ordered
   * before active runtime tools so runtime registrations can intentionally
   * override a request tool with the same name.
   */
  customTools?: StreamOptions['tools']
  /**
   * Runtime-registered tools currently active in the LLM tool store. Supplying
   * this also avoids creating the LLM tool store.
   *
   * @default useLlmToolsStore().activeTools
   */
  activeTools?: Tool[]
}

/**
 * Reads the provider-visible name from an xsai tool.
 */
export function toolNameFrom(tool: Tool): string | undefined {
  const candidate = tool as Tool & {
    name?: string
    function?: {
      name?: string
    }
  }

  return candidate.function?.name ?? candidate.name
}

async function resolveToolSource(source: ToolSource): Promise<Tool[]> {
  return typeof source === 'function' ? await source() : source
}

async function resolveCustomTools(customTools: StreamOptions['tools']): Promise<Tool[]> {
  if (typeof customTools === 'function')
    return await customTools() ?? []

  return customTools ?? []
}

async function resolveActiveTools(activeTools?: Tool[]): Promise<Tool[]> {
  if (activeTools != null)
    return activeTools

  return useLlmToolsStore().activeTools
}

async function resolveWebSearchTools(webSearchTools?: ToolSource): Promise<Tool[]> {
  if (webSearchTools != null)
    return resolveToolSource(webSearchTools)

  const webSearchStore = useWebSearchStore()
  // A keyless search can only ever error, so omit the tool until configured.
  if (!webSearchStore.configured)
    return []

  // Trim the key: `configured` is computed on the trimmed value, so a key pasted
  // with trailing whitespace/newline reads as ready but would 401 if sent raw.
  return createWebSearchTools({ apiKey: webSearchStore.apiKey.trim() })
}

/**
 * Resolves every tool visible to an LLM request.
 *
 * Runtime tools are placed last before de-duplication. The reverse/uniq/reverse
 * pass preserves the existing stable order while letting later runtime
 * registrations win when names collide with built-in or custom tools.
 */
export async function resolveLlmTools(options: ResolveLlmToolsOptions = {}): Promise<Tool[]> {
  const activeTools = await resolveActiveTools(options.activeTools)
  // The legacy two-hop `builtIn_mcp*` proxies are never injected by default.
  // The runtime MCP store is their only producer: it registers native tools,
  // or its own runtime-backed proxies while configured servers are still
  // booting. A default copy exposed a dead "find a tool" entry to models with
  // no MCP servers, and they used it to search for self-authored skills
  // (ACC-20260910 R05). An explicit builtInTools override still wins.
  const [
    builtInTools,
    debugTools,
    webSearchTools,
    fetchTools,
    customTools,
  ] = await Promise.all([
    resolveToolSource(options.builtInTools ?? []),
    resolveToolSource(options.debugTools ?? debug),
    resolveWebSearchTools(options.webSearchTools),
    resolveToolSource(options.fetchTools ?? createFetchTools),
    resolveCustomTools(options.customTools),
  ])

  return uniqBy(
    [
      ...builtInTools,
      ...debugTools,
      ...webSearchTools,
      ...fetchTools,
      ...customTools,
      ...activeTools,
    ].toReversed(),
    tool => toolNameFrom(tool) ?? tool,
  ).toReversed()
}
