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
//
// Both syntaxes are classified unconditionally, whichever shell the workspace
// host resolved (HARNESS-PLAN §3.5.3 C5): a Windows machine without Git for
// Windows runs PowerShell, and a cmdlet missing from these lists would be a
// destructive command silently downgraded to the read-only tier. Over-matching
// only raises an approval card, so the lists err that way.
//
// PowerShell entries anchor at a command position and match case-insensitively
// because the shell itself is case-insensitive, and its one- and two-letter
// aliases (ri, sc, ni, mi) would otherwise match ordinary words anywhere in a
// command line. Each alias needs its own entry: it shares no text with the
// cmdlet name that the readable pattern matches.
const POWERSHELL_COMMAND_START = String.raw`(?:^|[;|&(]\s*)`
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
  // PowerShell deletion (cmdlet and aliases)
  new RegExp(`${POWERSHELL_COMMAND_START}(remove-item|ri|rd|del|erase)\\b`, 'i'),
  // PowerShell network egress
  new RegExp(`${POWERSHELL_COMMAND_START}(invoke-webrequest|iwr|invoke-restmethod|irm|start-bitstransfer)\\b`, 'i'),
  // PowerShell service and remote-session control
  new RegExp(`${POWERSHELL_COMMAND_START}(stop-service|start-service|restart-service|set-service|sc)\\b`, 'i'),
  new RegExp(`${POWERSHELL_COMMAND_START}(enter-pssession|new-pssession|invoke-command)\\b`, 'i'),
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
  // PowerShell file creation, movement and writes (cmdlets and aliases)
  new RegExp(`${POWERSHELL_COMMAND_START}(set-content|add-content|out-file|new-item|ni|copy-item|cpi|move-item|mi|rename-item|rni|md)\\b`, 'i'),
])

/**
 * Classifies a `bash` command into the static risk tier.
 *
 * Test / typecheck / lint / query commands fall through to the read-only
 * default; anything not explicitly matched stays read-only by rule
 * (`docs/fork/CODING-HARNESS-DESIGN.md` §11.5), with the sandbox as the real fence.
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
