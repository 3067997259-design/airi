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

/** Segment-start anchor shared by every list that must match a command position, not an argument. */
const INTERPRETER_SEGMENT_START = String.raw`(?:^|[;|&(])\s*`

const MEDIUM_COMMAND_PATTERNS: readonly RegExp[] = Object.freeze([
  // dependency installation
  /\b(npm|pnpm|yarn|bun)\s+(install|add|remove|ci|update|upgrade|link)\b/,
  // workspace mutations through git
  /\bgit\s+(commit|add|reset|rebase|merge|checkout|switch|restore|stash|fetch|pull|clone)\b/,
  // file creation / movement / redirect writes
  /\b(mkdir|touch|mv|cp|tee|head\s+-c)\b/,
  // file metadata and link changes mutate the filesystem without touching content
  /\b(chmod|chown|chgrp|ln|truncate)\b/,
  // in-place text edits: `sed -i` / `sed --in-place` rewrite the input files;
  // a bare `sed 's/a/b/'` only writes stdout and stays read-only
  new RegExp(`${INTERPRETER_SEGMENT_START}sed\\b(?=[^;|&]*(?:\\s-i\\b|--in-place\\b))`),
  // gawk's in-place extension: `awk -i inplace` (or `in-place`) rewrites input files
  new RegExp(`${INTERPRETER_SEGMENT_START}awk\\b(?=[^;|&]*\\s-i\\s+(?:inplace|in-place)\\b)`),
  // redirect writes. The leading class keeps `->` (pointer/arrow text) from
  // matching; the trailing lookahead admits both `> file` and `>file`, and
  // fd forms like `1>log`. `2>&1` duplicates a descriptor, it writes no file.
  /(?:^|[\s&0-9])>{1,2}(?![>&])(?=\s*\S)/,
  // builds (write artifacts)
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?build\b/,
  // PowerShell file creation, movement and writes (cmdlets and aliases)
  new RegExp(`${POWERSHELL_COMMAND_START}(set-content|add-content|out-file|new-item|ni|copy-item|cpi|move-item|mi|rename-item|rni|md)\\b`, 'i'),
])

/**
 * Interpreters and script runners count as mutating regardless of what the
 * script does. A `python -m pkg import-candidates` can write a database and
 * a `node script.js` anything; the read-only default could not see that (the
 * 2026-09-03 run performed real imports classified read-only, which starved
 * the mutation evidence counters). Medium keeps the default no-approval UX —
 * this tier only corrects the evidence accounting — while genuinely
 * destructive operations inside the script are the sandbox's problem, not
 * this list's. Shell-launcher wrappers (`powershell -Command "…"`,
 * `cmd.exe /c "…"`) join the list for the same reason: the payload after
 * the flag is opaque to static matching, and the cmdlet-word patterns only
 * fire when the cmdlet itself sits at a command position (2026-09-04 run:
 * `powershell -Command "Remove-Item …"` fell through to read-only).
 */
const INTERPRETER_COMMAND_PATTERN = new RegExp(`${INTERPRETER_SEGMENT_START}(?:python[0-9.]*|py|node|deno|bun|ruby|perl|php|bash|sh|zsh|powershell[0-9.]*(?:\\.exe)?|pwsh(?:\\.exe)?|cmd(?:\\.exe)?|\\./[^;|&\\s]+)\\b`)
/** `node --version` and `python --help` probe the toolchain; they execute no project code. */
const INTERPRETER_VERSION_PROBE = /\s(?:--version|--help|-V|-h)\s*$/

/**
 * Classifies a `bash` command into the static risk tier.
 *
 * Test / typecheck / lint / query commands fall through to the read-only
 * default; anything not explicitly matched stays read-only by rule
 * (`docs/fork/CODING-HARNESS-DESIGN.md` §11.5), with the sandbox as the real
 * fence. An interpreter or script invocation upgrades the command to medium:
 * its effect is opaque to static matching — except a bare version or help
 * probe, which runs no project code. In-place text mutators (`sed -i`,
 * `awk -i inplace`), file metadata changes, and redirect writes are medium
 * for the same reason: the files on disk change while the command shape
 * looks like text processing.
 */
export function classifyBashCommand(command: string): BashRiskTier {
  const normalized = command.replace(/\s+/g, ' ').trim()
  if (HIGH_COMMAND_PATTERNS.some(pattern => pattern.test(normalized)))
    return 'high'
  if (MEDIUM_COMMAND_PATTERNS.some(pattern => pattern.test(normalized)))
    return 'medium'
  if (INTERPRETER_COMMAND_PATTERN.test(normalized) && !INTERPRETER_VERSION_PROBE.test(normalized))
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
