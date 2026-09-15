import type { ToolRegistrationInput } from './ai/chat-llm/tools'

/**
 * Fixed adapter contract for the EP-1 closed loop (wave-c §EP-1).
 *
 * The adapter exposes reviewed skills on the plugin surface. It adds no
 * execution trust of its own: the registration chain points at the reviewed
 * skill and the execution still runs through the coding sandbox.
 */

/** One adapter-exposed tool backed by a reviewed skill. */
export interface SkillAdapterTool {
  /** Model-facing name; unique against every other registered tool name. */
  toolName: string
  /** The reviewed skill this adapter delegates to. */
  skillToolId: string
  description: string
  /** Input schema derived from skill-forge validation. */
  inputSchema: Record<string, unknown>
}

/** Registration metadata the adapter supplies to the tool store. */
export interface SkillAdapterRegistration {
  ownerKind: 'plugin'
  /** Stable adapter id, distinct from the skill id. */
  ownerId: string
  execution: { kind: 'coding_sandbox', chain: string[] }
  /** Bound to the reviewed skill's content hash at registration time. */
  approvedContentHash: string
  tools: SkillAdapterTool[]
}

/** The reviewed-skill projection the adapter builds from. */
export interface ReviewedSkillSource {
  toolId: string
  toolName: string
  description: string
  parameters: Record<string, unknown>
  contentHash: string
}

/** Fixed adapter id used by the first closed loop. */
export const DEFAULT_SKILL_ADAPTER_ID = 'skill-adapter'

/** Registration id for one adapter-exposed skill. */
export function skillAdapterToolId(skillToolId: string, adapterId = DEFAULT_SKILL_ADAPTER_ID): string {
  return `plugin:${adapterId}:${skillToolId}`
}

/** Builds the adapter registration for one reviewed skill. */
export function skillAdapterRegistrationFor(
  skill: ReviewedSkillSource,
  adapterId = DEFAULT_SKILL_ADAPTER_ID,
): SkillAdapterRegistration {
  return {
    ownerKind: 'plugin',
    ownerId: adapterId,
    execution: { kind: 'coding_sandbox', chain: [`plugin:${adapterId}`, `skill:${skill.toolId}`] },
    approvedContentHash: skill.contentHash,
    tools: [{
      toolName: skill.toolName,
      skillToolId: skill.toolId,
      description: skill.description,
      inputSchema: skill.parameters,
    }],
  }
}

/** Projects one adapter tool into the tool-store registration record. */
export function skillAdapterToolRegistration(
  registration: SkillAdapterRegistration,
  tool: SkillAdapterTool,
): ToolRegistrationInput {
  return {
    toolId: skillAdapterToolId(tool.skillToolId, registration.ownerId),
    toolName: tool.toolName,
    ownerKind: registration.ownerKind,
    ownerId: registration.ownerId,
    execution: registration.execution,
    approvedContentHash: registration.approvedContentHash,
  }
}
