/**
 * Self-authored tool / skill contract (SELF-AUTHORED-TOOLS-DESIGN §5).
 *
 * A skill is one self-authored tool plus its activation condition and model
 * guidance. Trust moves draft → probation → reviewed; any content diff
 * invalidates the review; external sources and the target-compatibility
 * probe are part of the contract so the review queue can stay purely static.
 */

// NOTICE:
// These three shapes mirror `packages/plugin-sdk-tamagotchi/src/tools/registry.ts`
// (SerializedXsaiToolDefinition / RegisteredPluginToolDescriptor /
// ToolsetPromptManifest) as structural copies. skill-forge must stay a pure,
// dependency-free package (SELF-AUTHORED-TOOLS-DESIGN §7), so it cannot
// import the desktop SDK; the wiring layer maps between the two
// structurally-identical shapes.
export interface SkillToolDefinition {
  ownerExtensionId: string
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface SkillActivation {
  keywords: string[]
  patterns: string[]
}

export interface SkillPromptManifest {
  id: string
  title?: string
  content: string
}

export type SkillTrustState = 'draft' | 'probation' | 'reviewed'

export interface SkillReview {
  reviewer: string
  rationale: string
  reviewedAt: number
}

export interface CompatibilitySelfCheck {
  probe: {
    command: string
    expectedPattern: string
  }
  onMismatch: 'quarantine'
}

export interface SkillQuarantine {
  reason: 'compatibility_mismatch'
  detectedAt: number
}

/** A bounded failure review that removes a tool from runtime activation. */
export interface SkillRevisionProposal {
  sourceEventSeq: number
  reason: string
  proposedAt: number
}

export interface SelfAuthoredSkill {
  tool: SkillToolDefinition
  activation: SkillActivation
  prompt: SkillPromptManifest
  trust: SkillTrustState
  /** Review binding: any diff to any reviewed part invalidates the review. */
  contentHash: string
  review?: SkillReview
  /** External sources the tool reads; filled by static analysis at draft time. */
  externalSources: string[]
  /** Version probe so an upgraded target never silently serves stale behavior. */
  compatibility?: CompatibilitySelfCheck
  quarantine?: SkillQuarantine
  revision?: SkillRevisionProposal
}

/**
 * Structural cap on concurrent probation tools (SELF-AUTHORED-TOOLS-DESIGN
 * §9.2): the cap manufactures a queue, the queue sets review pace, the pace
 * stops rubber-stamping.
 */
export const MAX_PROBATION_TOOLS = 5

export type ToolRiskLevel = 'low' | 'medium' | 'high'

export interface ReviewQueueEntry {
  toolId: string
  contentHash: string
  diff?: string
  staticAnalysis: Record<string, boolean>
  riskLevel: ToolRiskLevel
  externalSources: string[]
  reason: 'self_tested' | 'compatibility_mismatch'
}
