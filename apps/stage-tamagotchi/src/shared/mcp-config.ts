import type {
  ElectronMcpConfigFile,
  ElectronMcpServerCommon,
  ElectronMcpServerConfig,
} from './eventa'

import { errorMessageFrom } from '@moeru/std'
import { z } from 'zod'

/** Keeps MCP request timers within the range supported by Node.js timers. */
const mcpTimeoutMsSchema = z.number().int().positive().safe().max(2_147_483_647)

function stringifyError(error: unknown) {
  return errorMessageFrom(error) ?? String(error)
}

/** Optional fields shared by every transport in the persisted config. */
const electronMcpServerCommonSchema = {
  enabled: z.boolean().optional(),
  requestTimeoutMs: mcpTimeoutMsSchema.optional(),
  maxTotalTimeoutMs: mcpTimeoutMsSchema.optional(),
} as const

/**
 * Shared runtime-safe schema for one MCP server definition, discriminated by
 * transport `kind`.
 *
 * Use when:
 * - Validating `mcp.json` in the main process
 * - Validating JSON drafts before the renderer loads them into the form
 *
 * Expects:
 * - `stdio` entries carry `command`; `streamable-http` and `sse` entries carry `url`
 * - Existing stdio entries written without `kind` are normalized to `kind: 'stdio'`
 * - Optional fields must already conform to the persisted wire format
 *
 * Returns:
 * - A strict Zod schema matching the persisted MCP server shape
 */
export const electronMcpServerConfigSchema = z.preprocess(
  (value) => {
    // NOTICE:
    // Config files written before the discriminated union had no `kind`.
    // Treat an object that carries a stdio `command` but no `kind` as a stdio
    // entry so existing configurations stay parseable after the upgrade.
    // Root cause: the stdio-only schema did not record the transport kind.
    // Removal condition: drop the legacy branch once all persisted files are
    // rewritten with an explicit `kind`.
    if (typeof value === 'object' && value !== null && !('kind' in value) && 'command' in value) {
      return { ...value, kind: 'stdio' }
    }
    return value
  },
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('stdio'),
      command: z.string().min(1),
      args: z.array(z.string()).optional(),
      env: z.record(z.string(), z.string()).optional(),
      cwd: z.string().optional(),
      ...electronMcpServerCommonSchema,
    }).strict(),
    z.object({
      kind: z.literal('streamable-http'),
      url: z.string().min(1),
      headers: z.record(z.string(), z.string()).optional(),
      ...electronMcpServerCommonSchema,
    }).strict(),
    z.object({
      kind: z.literal('sse'),
      url: z.string().min(1),
      headers: z.record(z.string(), z.string()).optional(),
      ...electronMcpServerCommonSchema,
    }).strict(),
  ]),
) satisfies z.ZodType<ElectronMcpServerConfig & ElectronMcpServerCommon, unknown>

/**
 * Shared runtime-safe schema for the persisted MCP config file.
 *
 * Use when:
 * - Parsing `mcp.json` from disk
 * - Parsing JSON drafts in the settings page
 *
 * Expects:
 * - The root object contains only `mcpServers`
 * - Each server entry matches {@link electronMcpServerConfigSchema}
 *
 * Returns:
 * - A strict Zod schema for the full MCP config file
 */
export const electronMcpConfigSchema = z.object({
  mcpServers: z.record(z.string(), electronMcpServerConfigSchema),
}).strict() satisfies z.ZodType<ElectronMcpConfigFile>

/**
 * Formats schema validation issues into one user-facing error string.
 *
 * Before:
 * - `[{ path: ['mcpServers', 'fs', 'command'], message: 'Too small...' }]`
 *
 * After:
 * - `"mcpServers.fs.command: Too small..."`
 *
 * Use when:
 * - Returning validation failures to the main process or renderer UI
 *
 * Expects:
 * - Issues come from Zod validation of the MCP config schema
 *
 * Returns:
 * - A semicolon-delimited message preserving issue paths
 */
export function formatElectronMcpConfigIssues(issues: z.ZodIssue[]) {
  return issues.map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ')
}

/**
 * Parses a plain object into a validated MCP config file.
 *
 * Use when:
 * - JSON text has already been parsed
 * - Main and renderer need one shared validation entrypoint
 *
 * Expects:
 * - `value` is the result of `JSON.parse` or another plain object source
 *
 * Returns:
 * - A validated `ElectronMcpConfigFile`
 */
export function parseElectronMcpConfig(value: unknown): ElectronMcpConfigFile {
  const validated = electronMcpConfigSchema.safeParse(value)
  if (!validated.success) {
    throw new Error(formatElectronMcpConfigIssues(validated.error.issues))
  }

  return validated.data
}

/**
 * Parses JSON text into a validated MCP config file.
 *
 * Use when:
 * - Reading `mcp.json` from disk
 * - Applying raw JSON drafts in the renderer
 *
 * Expects:
 * - `text` contains JSON text for an MCP config file
 *
 * Returns:
 * - A validated `ElectronMcpConfigFile`
 */
export function parseElectronMcpConfigText(text: string): ElectronMcpConfigFile {
  let parsed: unknown

  try {
    parsed = JSON.parse(text)
  }
  catch (error) {
    throw new Error(`invalid JSON: ${stringifyError(error)}`)
  }

  return parseElectronMcpConfig(parsed)
}
