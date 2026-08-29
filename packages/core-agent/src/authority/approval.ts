/**
 * Tiered approval policy (WORKSPACE-DESIGN §2.3) and the static `bash`
 * command classification (CODING-HARNESS-DESIGN §11.5).
 *
 * Classification is mechanical: the model can propose a command, never a
 * risk level. Unknown commands default to the read-only tier; the execution
 * layer still enforces a read-only sandbox by default, and any capability
 * escalation goes through approval — this tier list only decides how the
 * approval UX presents the command.
 */
import type { PlanRiskLevel, PlanSpecStep } from './contract'

export const DEFAULT_APPROVAL_REQUIRED_BY_RISK: Readonly<Record<PlanRiskLevel, boolean>> = Object.freeze({
  low: false,
  medium: false,
  high: true,
})

export interface ApprovalConfig {
  /** Upgrades medium-risk steps from default no-approval to required. */
  mediumApprovalRequired?: boolean
}

/** Whether a plan step requires human approval before execution. */
export function resolveApprovalRequired(
  step: Pick<PlanSpecStep, 'riskLevel' | 'approvalRequired'>,
  config: ApprovalConfig = {},
): boolean {
  if (step.approvalRequired)
    return true
  if (step.riskLevel === 'high')
    return true
  if (step.riskLevel === 'medium' && config.mediumApprovalRequired)
    return true
  return false
}

export type BashRiskTier = 'read-only' | 'medium' | 'high'

// Patterns below are matched against the normalized (collapsed-whitespace)
// command string. Keep the lists small and explicit; the execution sandbox,
// not these lists, is the actual safety boundary.
const HIGH_COMMAND_PATTERNS: readonly RegExp[] = Object.freeze([
  // remote push / publish
  /\bgit\s+push\b/,
  /\b(npm|pnpm|yarn|bun)\s+(publish|unpublish)\b/,
  // deletion
  /\brm\b/,
  /\b(unlink|rmdir)\b/,
  // arbitrary network egress
  /\b(curl|wget|nc|netcat|telnet|ssh|scp|rsync)\b/,
  // production / daemon management
  /\b(systemctl|service|pm2|kubectl|helm)\b/,
  // destructive git operations
  /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--)\b/,
])

const MEDIUM_COMMAND_PATTERNS: readonly RegExp[] = Object.freeze([
  // dependency installation
  /\b(npm|pnpm|yarn|bun)\s+(install|add|remove|ci|update|upgrade|link)\b/,
  // workspace mutations through git
  /\bgit\s+(commit|add|reset|rebase|merge|checkout|switch|restore|stash|fetch|pull|clone)\b/,
  // file creation / movement / redirect writes
  /\b(mkdir|touch|mv|cp|tee|head\s+-c)\b/,
  /(>>|>\s+)/,
  // builds (write artifacts)
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?build\b/,
])

/**
 * Classifies a `bash` command into the static risk tier.
 *
 * Test / typecheck / lint / query commands fall through to the read-only
 * default; anything not explicitly matched stays read-only by rule
 * (`CODING-HARNESS-DESIGN.md` §11.5), with the sandbox as the real fence.
 */
export function classifyBashCommand(command: string): BashRiskTier {
  const normalized = command.replace(/\s+/g, ' ').trim()
  if (HIGH_COMMAND_PATTERNS.some(pattern => pattern.test(normalized)))
    return 'high'
  if (MEDIUM_COMMAND_PATTERNS.some(pattern => pattern.test(normalized)))
    return 'medium'
  return 'read-only'
}

export function bashApprovalRequired(tier: BashRiskTier, config: ApprovalConfig = {}): boolean {
  if (tier === 'high')
    return true
  if (tier === 'medium' && config.mediumApprovalRequired)
    return true
  return false
}
