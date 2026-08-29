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
