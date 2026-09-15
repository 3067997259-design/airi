import type { AiriPackageDescriptorV1, PackageFileDigest } from './descriptor'

import {
  array,
  boolean,
  literal,
  number,
  object,
  record,
  string,
} from 'valibot'

/** One reviewed skill hash the renderer reports for a package trial. */
export interface ReviewedSkillHash {
  toolId: string
  contentHash: string
}

/**
 * Whole-package approval: valid only for the exact `(version, digest)` pair.
 *
 * Replacing any approved-surface file changes the digest, so the record can no
 * longer authorize activation until the user reviews the new bytes.
 */
export interface PackageApprovalRecord {
  packageId: string
  version: string
  digest: string
  approvedBy: 'user'
  approvedAt: number
  fileDigests: PackageFileDigest[]
}

/**
 * The selected version of one package.
 *
 * `enabled: false` keeps the user's version choice while withdrawing runtime
 * effects (restore default, uninstall). The pointer and the tools' registered
 * state are separate: activation registers tools only after this record is
 * committed.
 */
export interface PackageActivation {
  version: string
  digest: string
  enabled: boolean
  activatedAt: number
}

/** Persisted `<extensionsDir>/packages.json` (EP-2a). */
export interface PackagesFileV1 {
  packageVersion: 1
  approvals: PackageApprovalRecord[]
  active: Record<string, PackageActivation>
}

const fileDigestSchema = object({
  path: string(),
  sha256: string(),
})

export const packagesFileV1Schema = object({
  packageVersion: literal(1),
  approvals: array(object({
    packageId: string(),
    version: string(),
    digest: string(),
    approvedBy: literal('user'),
    approvedAt: number(),
    fileDigests: array(fileDigestSchema),
  })),
  active: record(string(), object({
    version: string(),
    digest: string(),
    enabled: boolean(),
    activatedAt: number(),
  })),
})

/** Why one descriptor skill binding failed its trial. */
export type PackageSkillCheckReason
  = | 'ok'
    | 'source_missing'
    | 'hash_mismatch'
    | 'review_hash_mismatch'
    | 'lock_mismatch'

export interface PackageSkillCheck {
  toolId: string
  contentHash: string
  reason: PackageSkillCheckReason
}

/** Trial is read-only except for the derived lock file; nothing is registered. */
export interface PackageTrialResult {
  packageId: string
  version: string
  digest: string
  descriptor: AiriPackageDescriptorV1
  fileDigests: PackageFileDigest[]
  skillChecks: PackageSkillCheck[]
}

export interface PackageVersionStatus {
  version: string
  digest?: string
  staged: boolean
  installed: boolean
  approved: boolean
  active: boolean
  enabled: boolean
}

export interface PackageListEntry {
  packageId: string
  versions: PackageVersionStatus[]
}
