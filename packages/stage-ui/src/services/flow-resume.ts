import type { FlowResumeConfig } from '@proj-airi/core-agent'

/** Host capabilities that are owned by coding-host rather than the renderer. */
const CODING_HOST_TOOL_NAMES: ReadonlySet<string> = new Set([
  'list',
  'read',
  'grep',
  'readRaw',
  'write',
  'edit',
  'bash',
  'job_output',
  'job_kill',
  'setWorkspaceRoot',
  'code_mode',
])

export interface FlowResumeToolStatus {
  name: string
  available: boolean
}

export interface FlowResumeRuntimeEnvironment {
  activeProviderId?: string
  activeModel?: string
  providerConfigured: boolean
  workspaceRoot?: string
  tools?: readonly FlowResumeToolStatus[]
}

/**
 * Checks whether a persisted flow can continue on the current runtime.
 *
 * Provider configuration, model selection, workspace root, and coding-host
 * capabilities are part of the execution identity. A mismatch returns a
 * visible reason so recovery waits for an explicit user fix instead of
 * silently running a journaled task on a different surface.
 */
export function verifyFlowResumeEnvironment(
  expected: Pick<FlowResumeConfig, 'providerId' | 'model' | 'workspaceRoot' | 'toolNames'>,
  current: FlowResumeRuntimeEnvironment,
): { ok: true } | { ok: false, reason: string } {
  if (!current.providerConfigured)
    return { ok: false, reason: `provider "${expected.providerId}" is no longer configured` }

  if (current.activeProviderId !== undefined && current.activeProviderId !== expected.providerId)
    return { ok: false, reason: `active provider changed from "${expected.providerId}" to "${current.activeProviderId}"` }

  if (current.activeModel !== undefined && current.activeModel !== expected.model)
    return { ok: false, reason: `active model changed from "${expected.model}" to "${current.activeModel}"` }

  if (expected.workspaceRoot !== undefined) {
    if (current.workspaceRoot === undefined)
      return { ok: false, reason: 'coding workspace status is unavailable' }
    if (current.workspaceRoot !== expected.workspaceRoot)
      return { ok: false, reason: `workspace changed from "${expected.workspaceRoot}" to "${current.workspaceRoot}"` }
  }

  const expectedHostTools = expected.toolNames.filter(toolName => CODING_HOST_TOOL_NAMES.has(toolName))
  if (expectedHostTools.length > 0) {
    if (current.tools === undefined)
      return { ok: false, reason: 'coding tool status is unavailable' }
    const unavailable = expectedHostTools.filter(toolName => !current.tools?.some(tool => tool.name === toolName && tool.available))
    if (unavailable.length > 0)
      return { ok: false, reason: `coding tools unavailable: ${unavailable.join(', ')}` }
  }

  return { ok: true }
}
