/**
 * Static analysis for self-authored tools (SELF-AUTHORED-TOOLS-DESIGN §9.3).
 *
 * `classifyToolRisk` and `validateDeclaration` are the two gates of the
 * review pipeline: risk is decided by rules, never by the model; a
 * declaration that contradicts the static findings is rejected before the
 * tool even reaches the review queue.
 */
import type { ToolRiskLevel } from './types'

export interface StaticFindings {
  networkEgress: boolean
  workspaceWrites: boolean
  subprocess: boolean
  /** True only when every subprocess call is on the allowed read-only list. */
  readOnlySubprocess: boolean
  credentialedAccess: boolean
  destructiveOps: boolean
}

export interface ToolDeclaration {
  networkEgress?: boolean
  workspaceWrites?: boolean
  subprocess?: boolean
  credentialedAccess?: boolean
  destructiveOps?: boolean
}

/**
 * Risk tiers from §9.3:
 *
 * | tier | static findings |
 * |---|---|
 * | high | network egress / any non-read-only subprocess / credentials / destructive ops |
 * | medium | workspace writes / read-only subprocess |
 * | low | everything else (pure computation, read-only resource access) |
 */
export function classifyToolRisk(findings: StaticFindings): ToolRiskLevel {
  if (findings.networkEgress || findings.credentialedAccess || findings.destructiveOps)
    return 'high'
  if (findings.subprocess && !findings.readOnlySubprocess)
    return 'high'
  if (findings.workspaceWrites || findings.readOnlySubprocess)
    return 'medium'
  return 'low'
}

export interface DeclarationCheckResult {
  consistent: boolean
  mismatches: string[]
}

/**
 * Compares the declared access scope against the static findings. Any
 * contradiction — a declared capability the analysis found, or a found
 * capability the tool failed to declare — is a mismatch; the caller should
 * reject the tool before it enters the review queue (§3.2).
 */
export function validateDeclaration(findings: StaticFindings, declared: ToolDeclaration): DeclarationCheckResult {
  const mismatches: string[] = []
  const checked: (keyof ToolDeclaration)[] = [
    'networkEgress',
    'workspaceWrites',
    'subprocess',
    'credentialedAccess',
    'destructiveOps',
  ]

  for (const key of checked) {
    const found = findings[key]!
    // An omitted permission is denied. Treating omission as "not checked"
    // would let a tool hide a discovered capability with an empty manifest.
    const declaredValue = declared[key] ?? false
    if (found !== declaredValue) {
      const direction = found ? 'found by static analysis but not declared' : 'declared but not found'
      mismatches.push(`${key}: ${direction}`)
    }
  }

  return { consistent: mismatches.length === 0, mismatches }
}

// Analysis patterns, matched against the collapsed source. The lists are a
// first-pass triage: a model that writes around them still lands in probation
// under a real human review, so precision beats recall here — a missed flag
// costs a reviewer a look, a false flag blocks a legitimate submission.

const NETWORK_EGRESS_PATTERNS: readonly RegExp[] = Object.freeze([
  /\bfetch\s*\(/,
  /\baxios\s*\.\s*(get|post|put|patch|delete|request)\s*\(/,
  /new\s+(WebSocket|EventSource|XMLHttpRequest)\s*\(/,
  // `http` already covers the `https` scheme prefix.
  /\b(http|net|tls|dns)\s*:\s*(request|get|connect|lookup)\s*\(/,
  /node\s*:\s*(http|net|tls|dns)/,
])

const WORKSPACE_WRITES_PATTERNS: readonly RegExp[] = Object.freeze([
  /\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|unlink|unlinkSync|rmdir|rmdirSync|mkdir|mkdirSync|rename|copyFile|rm|rmSync)\s*\(/,
  /\bfs\s*\.\s*(write|append|unlink|rm|mkdir|rename|copyFile|readFile)\b/,
  /node\s*:\s*fs/,
])

const SUBPROCESS_PATTERNS: readonly RegExp[] = Object.freeze([
  /(exec|execSync|spawn|spawnSync|fork)\s*\(/,
  /(child_process|node\s*:\s*child_process)/,
])

/** Subprocess command literals that count as read-only probes. */
const READ_ONLY_SUBPROCESS_COMMANDS: readonly RegExp[] = Object.freeze([
  /^git\s+(status|diff|log|show)\b/,
  /^ls(\s|$)/,
  /^cat\b/,
  /^echo\b/,
  /^pwd\b/,
  /^whoami\b/,
  /^node\s+--version$/,
  /^git\s+--version$/,
])

const CREDENTIAL_PATTERNS: readonly RegExp[] = Object.freeze([
  /\b(auth|api)[_-]?key(s)?\s*[:=]/i,
  /\b(access|secret|refresh)[_-]?token\b/i,
  /\btoken\s*[:=]/i,
  /\bpassword\s*[:=]/i,
  /\bprocess\.env\.[A-Z0-9_]+/,
  /\bbearer\s+/i,
])

const DESTRUCTIVE_PATTERNS: readonly RegExp[] = Object.freeze([
  /\brm\s+-r?f?\b/,
  /\b(rmdir|unlink)\s*\(/,
  /\b(drop|truncate|delete from)\b/i,
  /\bgit\s+push\s+--force\b/,
  /\b--force\b/,
])

function matchesAny(patterns: readonly RegExp[], source: string): boolean {
  return patterns.some(pattern => pattern.test(source))
}

/**
 * First-pass static analysis of a self-authored tool's source.
 *
 * Runs deterministic patterns against the source text and returns the
 * {@link StaticFindings} triage. Findings feed {@link classifyToolRisk} for
 * the risk tier and {@link validateDeclaration} for the declaration gate, so
 * risk is decided by rules, never by the model's self-report.
 *
 * NOTICE:
 * The patterns are heuristic. Deliberately-crafted evasion (dynamic strings,
 * indirect calls) can slip through; the review queue is the real safety
 * boundary, and a human reviewer always sees the source.
 *
 * @example
 * analyzeSkillSource('export async function run() { await fetch("https://api.example.com") }')
 * // => { networkEgress: true, workspaceWrites: false, subprocess: false, readOnlySubprocess: false, credentialedAccess: false, destructiveOps: false }
 */
export function analyzeSkillSource(source: string): StaticFindings {
  const collapsed = source.replace(/\s+/g, ' ').trim()
  const subprocess = matchesAny(SUBPROCESS_PATTERNS, collapsed)

  // readOnlySubprocess: every literal subprocess command is on the read-only
  // probe list. Non-literal or non-matching commands default the flag to false.
  let readOnlySubprocess = false
  if (subprocess) {
    const commandLiterals = [...collapsed.matchAll(/(?:exec|spawn|fork)\s*\(\s*['"`]([^'"`]+)['"`]/g)]
      .map(match => match[1].trim())
    readOnlySubprocess = commandLiterals.length > 0
      && commandLiterals.every(command => READ_ONLY_SUBPROCESS_COMMANDS.some(pattern => pattern.test(command)))
  }

  return {
    networkEgress: matchesAny(NETWORK_EGRESS_PATTERNS, collapsed),
    workspaceWrites: matchesAny(WORKSPACE_WRITES_PATTERNS, collapsed),
    subprocess,
    readOnlySubprocess,
    credentialedAccess: matchesAny(CREDENTIAL_PATTERNS, collapsed),
    destructiveOps: matchesAny(DESTRUCTIVE_PATTERNS, collapsed),
  }
}
