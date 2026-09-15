import { defineEventa, defineInvokeEventa } from '@moeru/eventa'

/**
 * EP-2a package lifecycle contracts.
 *
 * The desktop app is the only package host: importing, trialing, approving,
 * activating, rolling back, and uninstalling all run in the main process,
 * which owns `extensions/packages` and `extensions/packages.json`. Payloads
 * are JSON-safe summaries; the renderer never sees absolute paths it did not
 * pick through a dialog.
 */

/** One reviewed skill hash the renderer reports for trial/approve. */
export interface PackageSkillHash {
  toolId: string
  contentHash: string
}

export interface PackageToolSummary {
  name: string
  description: string
  parameters: Record<string, unknown>
  skill: PackageSkillHash
}

/** Why one skill binding failed; `ok` means the binding is provable. */
export type PackageSkillCheckReason
  = | 'ok'
    | 'source_missing'
    | 'hash_mismatch'
    | 'review_hash_mismatch'
    | 'lock_mismatch'

export interface PackageSkillCheckSummary {
  toolId: string
  contentHash: string
  reason: PackageSkillCheckReason
}

export interface PackageFileSummary {
  path: string
  sha256: string
}

/** Trial result shown on the review surface before approval. */
export interface PackageTrialSummary {
  packageId: string
  version: string
  digest: string
  tools: PackageToolSummary[]
  skillChecks: PackageSkillCheckSummary[]
  files: PackageFileSummary[]
}

export interface PackageApprovalSummary {
  packageId: string
  version: string
  digest: string
  approvedAt: number
  fileCount: number
}

export interface PackageActivationSummary {
  packageId: string
  version: string
  digest: string
  enabled: boolean
  activatedAt: number
}

export interface PackageVersionSummary {
  version: string
  digest?: string
  staged: boolean
  installed: boolean
  approved: boolean
  active: boolean
  enabled: boolean
}

export interface PackageListEntrySummary {
  packageId: string
  versions: PackageVersionSummary[]
}

/** One enabled, active package with the tools its descriptor exposes. */
export interface ActivePackageSummary {
  packageId: string
  version: string
  digest: string
  tools: PackageToolSummary[]
}

export const extensionPackagesList = defineInvokeEventa<PackageListEntrySummary[]>('airi:packages:list')
export const extensionPackagesActive = defineInvokeEventa<ActivePackageSummary[]>('airi:packages:active')
/**
 * Broadcast after every lifecycle mutation. Package state is not a
 * synchronized store: every window refreshes from the main process instead,
 * so the leader window learns that a follower settings window imported,
 * activated, rolled back, or uninstalled a package.
 */
export const extensionPackagesChanged = defineEventa<void>('airi:packages:changed')
export const extensionPackagesPickArchive = defineInvokeEventa<{ path?: string }>('airi:packages:pick-archive')
export const extensionPackagesPickDirectory = defineInvokeEventa<{ path?: string }>('airi:packages:pick-directory')
export const extensionPackagesImport = defineInvokeEventa<
  { packageId: string, version: string, entries: PackageListEntrySummary[] },
  { archivePath?: string, directory?: string }
>('airi:packages:import')
export const extensionPackagesTrial = defineInvokeEventa<
  PackageTrialSummary,
  { packageId: string, version: string, expectedSkills: PackageSkillHash[] }
>('airi:packages:trial')
export const extensionPackagesApprove = defineInvokeEventa<
  PackageApprovalSummary,
  { packageId: string, version: string, expectedSkills: PackageSkillHash[] }
>('airi:packages:approve')
export const extensionPackagesActivate = defineInvokeEventa<PackageActivationSummary, { packageId: string, version: string }>('airi:packages:activate')
export const extensionPackagesDeactivate = defineInvokeEventa<PackageListEntrySummary[], { packageId: string }>('airi:packages:deactivate')
export const extensionPackagesRollback = defineInvokeEventa<PackageActivationSummary, { packageId: string, toVersion?: string }>('airi:packages:rollback')
export const extensionPackagesUninstall = defineInvokeEventa<PackageListEntrySummary[], { packageId: string, version: string, purgeData?: boolean }>('airi:packages:uninstall')

/**
 * Reads the `packages` backup domain: approved versions plus the approval
 * registry. Paths already use the domain layout (`packages/registry.json`,
 * `packages/versions/<id>/<version>/...`) so the backup service can store
 * them unchanged.
 */
export const extensionPackagesExport = defineInvokeEventa<{ files: Array<{ path: string, data: Uint8Array }> }>('airi:packages:export')
