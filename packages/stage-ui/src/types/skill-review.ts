import type { SelfAuthoredSkill, StaticFindings, ToolRiskLevel } from '@proj-airi/skill-forge'

import * as v from 'valibot'

/** Durable review evidence and the workspace that owns its source. */
export interface ReviewQueueEntry extends SelfAuthoredSkill {
  toolId: string
  name: string
  description: string
  riskLevel: ToolRiskLevel
  staticAnalysis: StaticFindings
  reason: 'self_tested' | 'compatibility_mismatch'
  /** Exact artifact hash approved by the user. */
  reviewedHash?: string
  /** Failed verification prevents registration and execution. */
  artifactError?: string
  workspaceRoot?: string
  muscleMemoryId?: string
  /** Hash of the persisted selftest.mjs bytes that produced this evidence. */
  selftest?: { contentHash: string, logs: string[], traceCount: number }
}

/** Shared persistence boundary for startup and portable restore. */
export const skillReviewSchema = v.object({
  toolId: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]{0,63}$/)),
  name: v.string(),
  description: v.string(),
  tool: v.object({ ownerExtensionId: v.string(), name: v.string(), description: v.string(), parameters: v.record(v.string(), v.unknown()) }),
  activation: v.object({ keywords: v.array(v.string()), patterns: v.array(v.string()) }),
  prompt: v.object({ id: v.string(), title: v.optional(v.string()), content: v.string() }),
  trust: v.picklist(['draft', 'probation', 'reviewed']),
  contentHash: v.string(),
  reviewedHash: v.optional(v.string()),
  artifactError: v.optional(v.string()),
  workspaceRoot: v.optional(v.string()),
  muscleMemoryId: v.optional(v.string()),
  selftest: v.optional(v.object({ contentHash: v.string(), logs: v.array(v.string()), traceCount: v.number() })),
  review: v.optional(v.object({ reviewer: v.string(), rationale: v.string(), reviewedAt: v.number() })),
  quarantine: v.optional(v.object({ reason: v.literal('compatibility_mismatch'), detectedAt: v.number() })),
  revision: v.optional(v.object({ sourceEventSeq: v.number(), reason: v.string(), proposedAt: v.number() })),
  compatibility: v.optional(v.object({ probe: v.object({ command: v.string(), expectedPattern: v.string() }), onMismatch: v.literal('quarantine') })),
  externalSources: v.array(v.string()),
  riskLevel: v.picklist(['low', 'medium', 'high']),
  staticAnalysis: v.object({ networkEgress: v.boolean(), workspaceWrites: v.boolean(), subprocess: v.boolean(), readOnlySubprocess: v.boolean(), credentialedAccess: v.boolean(), destructiveOps: v.boolean() }),
  reason: v.picklist(['self_tested', 'compatibility_mismatch']),
})
