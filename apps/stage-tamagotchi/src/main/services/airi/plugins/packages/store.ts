import type { AiriPackageDescriptorV1 } from './descriptor'
import type { PackageTrialRunner } from './trial-worker/client'
import type {
  PackageActivation,
  PackageApprovalRecord,
  PackageListEntry,
  PackagesFileV1,
  PackageSkillCheck,
  PackageTrialResult,
  PackageVersionStatus,
  ReviewedSkillHash,
} from './types'

import { randomUUID } from 'node:crypto'
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'

import JSZip from 'jszip'

import { extensionManifestV1Schema } from '@proj-airi/plugin-sdk/plugin-host'
import { contentHashOf } from '@proj-airi/skill-forge'
import { safeParse } from 'valibot'

import {
  assertDeclarativeManifest,
  digestFromFileDigests,
  PackageDescriptorInvalidError,
  parsePackageDescriptor,
  verifyPackageDigest,
} from './descriptor'
import { PackageTrialWorkerClient } from './trial-worker/client'
import { packagesFileV1Schema } from './types'

/**
 * EP-2a package lifecycle store.
 *
 * Owns the on-disk layout under `<extensionsDir>/packages`, the approval
 * records in `<extensionsDir>/packages.json`, and the trial/approve/activate/
 * rollback/uninstall state machine. Package loading bypasses the plugin host
 * loader: this store only verifies declarative content, it never executes it.
 *
 * State model:
 * - staging (`packages/.staging/<id>/<version>`) holds imported, unapproved bytes
 * - installed (`packages/<id>/<version>`) holds approved or previously active bytes
 * - `active[packageId]` is the single writer-selected version; `enabled:false`
 *   withdraws runtime effects without forgetting the user's version choice
 */

/** Raised when an import archive is unsafe or unreadable. */
export class PackageArchiveInvalidError extends Error {
  constructor(detail: string) {
    super(`Invalid package archive: ${detail}`)
    this.name = 'PackageArchiveInvalidError'
  }
}

/** Raised when a package skill cannot prove it matches reviewed bytes. */
export class PackageDependencyMismatchError extends Error {
  readonly toolId: string
  readonly reason: Exclude<PackageSkillCheck['reason'], 'ok'>

  constructor(toolId: string, reason: Exclude<PackageSkillCheck['reason'], 'ok'>) {
    super(`Package skill "${toolId}" failed trial: ${reason}.`)
    this.name = 'PackageDependencyMismatchError'
    this.toolId = toolId
    this.reason = reason
  }
}

/** Raised when `extension.airi.json` is missing or violates the v1 schema. */
export class PackageManifestInvalidError extends Error {
  constructor(detail: string) {
    super(`Invalid extension.airi.json: ${detail}`)
    this.name = 'PackageManifestInvalidError'
  }
}

/** Raised when activation targets a version without an approval record. */
export class PackageNotApprovedError extends Error {
  constructor(packageId: string, version: string) {
    super(`Package "${packageId}@${version}" has no approval record; review and approve it first.`)
    this.name = 'PackageNotApprovedError'
  }
}

/** Raised when rollback has no earlier approved and present version to land on. */
export class PackageRollbackUnavailableError extends Error {
  readonly packageId: string

  constructor(packageId: string, detail: string) {
    super(`Cannot roll back package "${packageId}": ${detail}. The active version is unchanged.`)
    this.name = 'PackageRollbackUnavailableError'
    this.packageId = packageId
  }
}

/** Raised when a package version directory is absent from staging and installed. */
export class PackageVersionMissingError extends Error {
  constructor(packageId: string, version: string) {
    super(`Package version "${packageId}@${version}" is not imported.`)
    this.name = 'PackageVersionMissingError'
  }
}

/** Raised when the persisted `packages.json` is corrupt; never silently reset. */
export class PackagesFileInvalidError extends Error {
  constructor(detail: string) {
    super(`Invalid packages.json: ${detail}`)
    this.name = 'PackagesFileInvalidError'
  }
}

/**
 * Lock format version. Bump when the digest input or the lock file shape
 * changes; older locks then fail verification instead of passing silently.
 */
const PACKAGE_LOCK_VERSION = 1
const DIGEST_ALGORITHM = 'sha256-of-sorted-file-digests-v1'

// Archives carry declarative content and assets; keep the same bound as the
// data-backup importer until MD-3 measurements justify streaming.
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
const MAX_ARCHIVE_ENTRIES = 10_000

const SAFE_SEGMENT = /^\w[\w.-]*$/

function formatIssues(issues: readonly { message: string }[]): string {
  return issues.map(issue => issue.message).join('; ')
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  }
  catch {
    return false
  }
}

async function readJson(rootDir: string, name: string): Promise<unknown> {
  let raw: string
  try {
    raw = await readFile(join(rootDir, name), 'utf8')
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new PackageDescriptorInvalidError(`${name} is missing`)
    throw error
  }
  try {
    return JSON.parse(raw)
  }
  catch {
    throw new PackageDescriptorInvalidError(`${name} is not valid JSON`)
  }
}

interface PackageIdentity {
  packageId: string
  version: string
  descriptor: AiriPackageDescriptorV1
  manifest: unknown
}

function identityFromJsons(manifestValue: unknown, descriptorValue: unknown): PackageIdentity {
  const manifest = safeParse(extensionManifestV1Schema, manifestValue)
  if (!manifest.success)
    throw new PackageManifestInvalidError(formatIssues(manifest.issues))
  const descriptor = parsePackageDescriptor(descriptorValue)
  if (manifest.output.id !== descriptor.id)
    throw new PackageManifestInvalidError(`manifest id "${manifest.output.id}" does not match airi-package.json id "${descriptor.id}"`)
  if (!SAFE_SEGMENT.test(descriptor.id) || !SAFE_SEGMENT.test(descriptor.version))
    throw new PackageDescriptorInvalidError('id and version must be single path-safe segments')
  return { packageId: descriptor.id, version: descriptor.version, descriptor, manifest: manifest.output }
}

async function readPackageIdentity(rootDir: string): Promise<PackageIdentity> {
  return identityFromJsons(
    await readJson(rootDir, 'extension.airi.json'),
    await readJson(rootDir, 'airi-package.json'),
  )
}

/**
 * Verifies descriptor skill bindings against worker-observed source texts.
 *
 * EP-2b: the trial worker only returns text; the reviewed-skill hash
 * (`contentHashOf`) and every trust decision happen here.
 */
function verifySkillBindingsFromSources(
  descriptor: AiriPackageDescriptorV1,
  skillSources: readonly { toolId: string, source: string }[],
  expectedSkills: readonly ReviewedSkillHash[],
): PackageSkillCheck[] {
  const expected = new Map(expectedSkills.map(skill => [skill.toolId, skill.contentHash]))
  const sources = new Map(skillSources.map(entry => [entry.toolId, entry.source]))
  const checks: PackageSkillCheck[] = []

  for (const tool of descriptor.tools) {
    const toolId = tool.skill.toolId
    const contentHash = tool.skill.contentHash
    const check = (reason: PackageSkillCheck['reason']): PackageSkillCheck => ({ toolId, contentHash, reason })
    let result: PackageSkillCheck
    if (!SAFE_SEGMENT.test(toolId)) {
      result = check('source_missing')
    }
    else {
      const source = sources.get(toolId)
      if (source === undefined)
        result = check('source_missing')
      else if (contentHashOf(source) !== contentHash)
        result = check('hash_mismatch')
      // A package tool is only provable when the bytes equal a reviewed skill
      // hash the renderer still lists; the package never carries its own trust.
      else if (expected.get(toolId) !== contentHash)
        result = check('review_hash_mismatch')
      else
        result = check('ok')
    }
    checks.push(result)
    if (result.reason !== 'ok')
      throw new PackageDependencyMismatchError(result.toolId, result.reason)
  }

  const locked = descriptor.dependencies?.skills
  if (locked) {
    const bindings = descriptor.tools.map(tool => `${tool.skill.toolId}:${tool.skill.contentHash}`).sort()
    const locks = locked.map(skill => `${skill.toolId}:${skill.contentHash}`).sort()
    if (bindings.join('|') !== locks.join('|'))
      throw new PackageDependencyMismatchError(descriptor.tools[0]?.skill.toolId ?? '', 'lock_mismatch')
  }
  return checks
}

async function collectVersions(rootDir: string, target: Map<string, Set<string>>, packageIds: Set<string>): Promise<void> {
  let packageEntries
  try {
    packageEntries = await readdir(rootDir, { withFileTypes: true })
  }
  catch {
    return
  }
  for (const packageEntry of packageEntries) {
    if (!packageEntry.isDirectory() || packageEntry.name === '.staging')
      continue
    packageIds.add(packageEntry.name)
    const versions = target.get(packageEntry.name) ?? new Set<string>()
    target.set(packageEntry.name, versions)
    const versionEntries = await readdir(join(rootDir, packageEntry.name), { withFileTypes: true }).catch(() => [])
    for (const versionEntry of versionEntries) {
      if (!versionEntry.isDirectory())
        continue
      // After uninstall a version directory can hold only private `data/`;
      // it is not a package version anymore and must not appear in listings.
      if (!await pathExists(join(rootDir, packageEntry.name, versionEntry.name, 'extension.airi.json')))
        continue
      versions.add(versionEntry.name)
    }
  }
}

/** Removes every entry of a version directory except the named one. */
async function removeExcept(dir: string, keep: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === keep)
      continue
    await rm(join(dir, entry.name), { recursive: true, force: true })
  }
}

/** All files under a version directory, `data/**` included, logs excluded. */
async function listVersionFiles(rootDir: string): Promise<string[]> {
  const files: string[] = []
  const walk = async (relativeDir: string): Promise<void> => {
    const entries = await readdir(join(rootDir, relativeDir), { withFileTypes: true })
    for (const entry of entries) {
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!relativeDir && entry.name === 'logs')
          continue
        await walk(relativePath)
        continue
      }
      if (entry.isFile())
        files.push(relativePath)
    }
  }
  await walk('')
  return files.sort()
}

export interface PackageStoreOptions {
  /** `<userData>/extensions`; packages live under its `packages/` subdirectory. */
  extensionsDir: string
  /** Injectable clock for deterministic tests. */
  now?: () => number
  /**
   * Trial execution strategy (EP-2b). Defaults to the isolated forked worker;
   * tests may inject a deterministic runner.
   */
  trialRunner?: PackageTrialRunner
}

export interface ImportedPackage {
  packageId: string
  version: string
  /** Staging directory that `trial` and later `activate` operate on. */
  directory: string
}

export class PackageStore {
  private readonly extensionsDir: string
  private readonly rootDir: string
  private readonly stagingDir: string
  private readonly approvalsFile: string
  private readonly now: () => number
  private readonly trialRunner: PackageTrialRunner
  // Serializes read-modify-write cycles on packages.json. Main is the single
  // writer, so an in-process queue is enough to make concurrent approvals safe.
  private queue: Promise<unknown> = Promise.resolve()

  constructor(options: PackageStoreOptions) {
    this.extensionsDir = options.extensionsDir
    this.rootDir = join(options.extensionsDir, 'packages')
    this.stagingDir = join(this.rootDir, '.staging')
    this.approvalsFile = join(options.extensionsDir, 'packages.json')
    this.now = options.now ?? (() => Date.now())
    this.trialRunner = options.trialRunner ?? new PackageTrialWorkerClient()
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation)
    this.queue = next.then(() => undefined, () => undefined)
    return next
  }

  private async loadApprovalsFile(): Promise<PackagesFileV1> {
    let raw: string
    try {
      raw = await readFile(this.approvalsFile, 'utf8')
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { packageVersion: 1, approvals: [], active: {} }
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    }
    catch {
      throw new PackagesFileInvalidError('file is not valid JSON')
    }
    const result = safeParse(packagesFileV1Schema, parsed)
    if (!result.success)
      throw new PackagesFileInvalidError(formatIssues(result.issues))
    return result.output
  }

  private async saveApprovalsFile(file: PackagesFileV1): Promise<void> {
    await mkdir(this.extensionsDir, { recursive: true })
    const temp = `${this.approvalsFile}.tmp`
    await writeFile(temp, JSON.stringify(file, null, 2))
    // Replace instead of writing in place: a crash leaves the old approvals
    // intact rather than a truncated file.
    await rm(this.approvalsFile, { force: true })
    await rename(temp, this.approvalsFile)
  }

  private async findVersionDir(packageId: string, version: string): Promise<{ directory: string, staged: boolean } | undefined> {
    const staged = join(this.stagingDir, packageId, version)
    if (await pathExists(staged))
      return { directory: staged, staged: true }
    const installed = join(this.rootDir, packageId, version)
    if (await pathExists(installed))
      return { directory: installed, staged: false }
    return undefined
  }

  private async requireVersionDir(packageId: string, version: string): Promise<{ directory: string, staged: boolean }> {
    const located = await this.findVersionDir(packageId, version)
    if (!located)
      throw new PackageVersionMissingError(packageId, version)
    return located
  }

  /** Copies a directory package into staging; no approval state is touched. */
  async importFromDirectory(input: { sourceDir: string, packageId?: string, version?: string }): Promise<ImportedPackage> {
    return this.enqueue(async () => this.importDirectoryInternal(input))
  }

  private async importDirectoryInternal(input: { sourceDir: string, packageId?: string, version?: string }): Promise<ImportedPackage> {
    const identity = await readPackageIdentity(input.sourceDir)
    if (input.packageId && input.packageId !== identity.packageId)
      throw new PackageDescriptorInvalidError(`requested package id "${input.packageId}" does not match "${identity.packageId}"`)
    if (input.version && input.version !== identity.version)
      throw new PackageDescriptorInvalidError(`requested version "${input.version}" does not match "${identity.version}"`)

    const target = join(this.stagingDir, identity.packageId, identity.version)
    await mkdir(dirname(target), { recursive: true })
    await rm(target, { recursive: true, force: true })
    await cp(input.sourceDir, target, { recursive: true })
    return { packageId: identity.packageId, version: identity.version, directory: target }
  }

  /**
   * Extracts a ZIP package into a staging scratch directory, then imports it.
   * Unsafe or oversized archives are rejected before any package path is used.
   */
  async importFromArchive(input: { archivePath: string }): Promise<ImportedPackage> {
    return this.enqueue(async () => {
      const info = await stat(input.archivePath).catch(() => undefined)
      if (!info?.isFile() || info.size > MAX_ARCHIVE_BYTES)
        throw new PackageArchiveInvalidError('archive is missing or exceeds the 64 MiB limit')

      const zip = await JSZip.loadAsync(await readFile(input.archivePath))
        .catch(() => {
          throw new PackageArchiveInvalidError('archive cannot be read')
        })
      const files = Object.values(zip.files)
      if (files.length > MAX_ARCHIVE_ENTRIES)
        throw new PackageArchiveInvalidError('archive contains too many entries')

      const extractRoot = join(this.stagingDir, `.extract-${randomUUID()}`)
      try {
        for (const file of files) {
          if (file.dir)
            continue
          if (file.unsafeOriginalName !== file.name)
            throw new PackageArchiveInvalidError(`non-canonical path: ${file.unsafeOriginalName}`)
          const target = join(extractRoot, file.name)
          const rel = relative(extractRoot, target)
          if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || rel.includes(':'))
            throw new PackageArchiveInvalidError(`path escapes the extraction root: ${file.name}`)
        }
        for (const file of files) {
          if (file.dir)
            continue
          const target = join(extractRoot, file.name)
          await mkdir(dirname(target), { recursive: true })
          await writeFile(target, await file.async('nodebuffer'))
        }
        return await this.importDirectoryInternal({ sourceDir: extractRoot })
      }
      finally {
        await rm(extractRoot, { recursive: true, force: true })
      }
    })
  }

  /**
   * Validates descriptor, skill bindings, and reviewed hashes, then computes
   * the whole-package digest and writes the derived lock file. Registers
   * nothing and mounts nothing; failures leave the current activation alone.
   */
  async trial(input: { packageId: string, version: string, expectedSkills?: readonly ReviewedSkillHash[] }): Promise<PackageTrialResult> {
    return this.enqueue(async () => this.trialInternal(input))
  }

  /**
   * Cancels the in-flight trial, if any (EP-2b).
   *
   * Bounded: the runner disposes the worker within its grace window; the
   * pending `trial()` promise rejects with a typed `cancelled` failure.
   * Not queued: cancellation must preempt the trial it targets.
   */
  async cancelTrial(): Promise<boolean> {
    return (await this.trialRunner.dispose?.()) ?? false
  }

  private async trialInternal(input: { packageId: string, version: string, expectedSkills?: readonly ReviewedSkillHash[] }): Promise<PackageTrialResult> {
    const located = await this.requireVersionDir(input.packageId, input.version)
    // EP-2b: the worker observes untrusted content (read/hash/parse) inside a
    // confined child process; every trust decision below runs in the host.
    const observation = await this.trialRunner.run({ directory: located.directory })
    const identity = identityFromJsons(observation.manifestJson, observation.descriptorJson)
    if (identity.packageId !== input.packageId || identity.version !== input.version)
      throw new PackageDescriptorInvalidError('package identity does not match its directory')
    assertDeclarativeManifest(identity.manifest)

    const skillChecks = verifySkillBindingsFromSources(
      identity.descriptor,
      observation.skillSources,
      input.expectedSkills ?? [],
    )
    // The digest is assembled here from the observed file list; the worker's
    // values are input, never the authority.
    const files = [...observation.files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    const digest = digestFromFileDigests(files)
    await writeFile(join(located.directory, 'airi-package.lock.json'), JSON.stringify({
      packageVersion: PACKAGE_LOCK_VERSION,
      algorithm: DIGEST_ALGORITHM,
      digest,
      files,
      writtenAt: this.now(),
    }, null, 2))

    return {
      packageId: identity.packageId,
      version: identity.version,
      digest,
      descriptor: identity.descriptor,
      fileDigests: files,
      skillChecks,
    }
  }

  /**
   * Records the user's approval of the exact bytes currently in the version
   * directory. Re-verifies skill bindings and the digest first, so an approval
   * can never bind content that no longer matches the review inputs.
   */
  async approve(input: { packageId: string, version: string, expectedSkills: readonly ReviewedSkillHash[] }): Promise<PackageApprovalRecord> {
    return this.enqueue(async () => {
      const trialResult = await this.trialInternal(input)
      const file = await this.loadApprovalsFile()
      const record: PackageApprovalRecord = {
        packageId: input.packageId,
        version: input.version,
        digest: trialResult.digest,
        approvedBy: 'user',
        approvedAt: this.now(),
        fileDigests: trialResult.fileDigests,
      }
      const approvals = file.approvals.filter(approval => approval.packageId !== input.packageId || approval.version !== input.version)
      approvals.push(record)
      await this.saveApprovalsFile({ ...file, approvals })
      return record
    })
  }

  /**
   * Selects a version after verifying it against its approval record, then
   * promotes staging bytes to the installed directory. The active pointer is
   * committed last, so a rejected activation cannot replace a working version.
   */
  async activate(input: { packageId: string, version: string }): Promise<PackageActivation> {
    return this.enqueue(async () => {
      const file = await this.loadApprovalsFile()
      const approval = file.approvals.find(record => record.packageId === input.packageId && record.version === input.version)
      if (!approval)
        throw new PackageNotApprovedError(input.packageId, input.version)

      const located = await this.requireVersionDir(input.packageId, input.version)
      await verifyPackageDigest(located.directory, approval.digest)
      if (located.staged) {
        const installed = join(this.rootDir, input.packageId, input.version)
        await mkdir(dirname(installed), { recursive: true })
        await rm(installed, { recursive: true, force: true })
        await rename(located.directory, installed)
      }

      const activation: PackageActivation = {
        version: input.version,
        digest: approval.digest,
        enabled: true,
        activatedAt: this.now(),
      }
      await this.saveApprovalsFile({ ...file, active: { ...file.active, [input.packageId]: activation } })
      return activation
    })
  }

  /** Keeps the selected version but withdraws runtime effects. */
  async deactivate(input: { packageId: string }): Promise<boolean> {
    return this.enqueue(async () => {
      const file = await this.loadApprovalsFile()
      const active = file.active[input.packageId]
      if (!active || !active.enabled)
        return false
      await this.saveApprovalsFile({
        ...file,
        active: { ...file.active, [input.packageId]: { ...active, enabled: false } },
      })
      return true
    })
  }

  /**
   * Switches back to an earlier approved version. Any missing directory or
   * digest mismatch aborts the whole operation and keeps the current version.
   */
  async rollback(input: { packageId: string, toVersion?: string }): Promise<PackageActivation> {
    return this.enqueue(async () => {
      const file = await this.loadApprovalsFile()
      const current = file.active[input.packageId]
      if (!current)
        throw new PackageRollbackUnavailableError(input.packageId, 'no version is active')

      const candidates = file.approvals
        .filter(record => record.packageId === input.packageId && record.version !== current.version)
        .sort((left, right) => right.approvedAt - left.approvedAt)
      const ordered = input.toVersion
        ? candidates.filter(record => record.version === input.toVersion)
        : candidates

      for (const candidate of ordered) {
        const installed = join(this.rootDir, input.packageId, candidate.version)
        if (!await pathExists(installed))
          continue
        try {
          await verifyPackageDigest(installed, candidate.digest)
        }
        catch {
          continue
        }
        const activation: PackageActivation = {
          version: candidate.version,
          digest: candidate.digest,
          enabled: true,
          activatedAt: this.now(),
        }
        await this.saveApprovalsFile({ ...file, active: { ...file.active, [input.packageId]: activation } })
        return activation
      }

      throw new PackageRollbackUnavailableError(
        input.packageId,
        input.toVersion ? `version "${input.toVersion}" is not approved and present` : 'no earlier approved version is present',
      )
    })
  }

  /**
   * Withdraws approvals and activation, then deletes version files. Private
   * `data/` survives by default; only `purgeData` removes it.
   */
  async uninstall(input: { packageId: string, version?: string, purgeData?: boolean }): Promise<void> {
    return this.enqueue(async () => {
      // EP-2b: a trial can still be running if it was started outside the
      // queue; terminate it (bounded) before the version files are touched.
      await this.cancelTrial()
      const file = await this.loadApprovalsFile()
      const targetVersion = input.version ?? file.active[input.packageId]?.version
      if (!targetVersion)
        throw new PackageVersionMissingError(input.packageId, '(no active version)')

      const installed = join(this.rootDir, input.packageId, targetVersion)
      if (await pathExists(installed)) {
        if (input.purgeData)
          await rm(installed, { recursive: true, force: true })
        else
          await removeExcept(installed, 'data')
      }
      await rm(join(this.stagingDir, input.packageId, targetVersion), { recursive: true, force: true })

      // Approvals are withdrawn only after the bytes are gone: a failed delete
      // leaves the package usable instead of approved-but-missing.
      const active = { ...file.active }
      if (active[input.packageId]?.version === targetVersion)
        delete active[input.packageId]
      await this.saveApprovalsFile({
        ...file,
        approvals: file.approvals.filter(record => record.packageId !== input.packageId || record.version !== targetVersion),
        active,
      })
    })
  }

  /**
   * Enabled active versions with their parsed descriptors.
   *
   * A version whose bytes no longer match its approval digest is skipped:
   * registration consumes this list, and registering a tampered package would
   * put unapproved tools on the model face.
   */
  async activePackages(): Promise<Array<{ packageId: string, version: string, digest: string, descriptor: AiriPackageDescriptorV1 }>> {
    const file = await this.loadApprovalsFile()
    const result: Array<{ packageId: string, version: string, digest: string, descriptor: AiriPackageDescriptorV1 }> = []
    for (const [packageId, activation] of Object.entries(file.active)) {
      if (!activation.enabled)
        continue
      const installed = join(this.rootDir, packageId, activation.version)
      if (!await pathExists(installed))
        continue
      try {
        await verifyPackageDigest(installed, activation.digest)
        const identity = await readPackageIdentity(installed)
        result.push({ packageId, version: activation.version, digest: activation.digest, descriptor: identity.descriptor })
      }
      catch {
        continue
      }
    }
    return result
  }

  /** Snapshot of installed, staged, approved, and active versions per package. */
  async list(): Promise<PackageListEntry[]> {
    const file = await this.loadApprovalsFile()
    const packageIds = new Set<string>(Object.keys(file.active))
    const installed = new Map<string, Set<string>>()
    const staged = new Map<string, Set<string>>()
    await collectVersions(this.rootDir, installed, packageIds)
    await collectVersions(this.stagingDir, staged, packageIds)

    return [...packageIds].sort().map((packageId) => {
      const versions = new Set<string>([
        ...(installed.get(packageId) ?? []),
        ...(staged.get(packageId) ?? []),
        ...file.approvals.filter(record => record.packageId === packageId).map(record => record.version),
      ])
      const active = file.active[packageId]
      const statuses = [...versions].sort().map((version): PackageVersionStatus => {
        const approval = file.approvals.find(record => record.packageId === packageId && record.version === version)
        return {
          version,
          ...(approval ? { digest: approval.digest } : {}),
          staged: staged.get(packageId)?.has(version) ?? false,
          installed: installed.get(packageId)?.has(version) ?? false,
          approved: Boolean(approval),
          active: active?.version === version,
          enabled: active?.version === version && active.enabled,
        }
      })
      return { packageId, versions: statuses }
    })
  }

  /**
   * Files a business backup needs for the `packages` domain (MD-2/EP-2a).
   *
   * Only approved versions whose bytes still verify are exported, together
   * with the approval registry (which carries the user's version choice).
   * Staged, unapproved, or tampered versions stay out: a backup never
   * propagates unapproved code.
   */
  async exportApprovedFiles(): Promise<Array<{ path: string, data: Uint8Array }>> {
    const file = await this.loadApprovalsFile()
    const files: Array<{ path: string, data: Uint8Array }> = []
    if (await pathExists(this.approvalsFile))
      files.push({ path: 'packages/registry.json', data: new Uint8Array(await readFile(this.approvalsFile)) })

    for (const approval of file.approvals) {
      const installed = join(this.rootDir, approval.packageId, approval.version)
      if (!await pathExists(installed))
        continue
      try {
        await verifyPackageDigest(installed, approval.digest)
      }
      catch {
        continue
      }
      for (const relativePath of await listVersionFiles(installed)) {
        files.push({
          path: `packages/versions/${approval.packageId}/${approval.version}/${relativePath}`,
          data: new Uint8Array(await readFile(join(installed, relativePath))),
        })
      }
    }
    return files
  }

  /**
   * Normalizes a profile after an archive restore (EP-2a restore semantics).
   *
   * Restored packages never activate by themselves: every activation pointer
   * keeps its version but is disabled. Approvals are kept only while the
   * restored bytes still match their digest; a missing directory or a digest
   * mismatch demotes the version to "needs review" (no approval record). A
   * corrupt registry is preserved for inspection and replaced by an empty one,
   * so one damaged package record cannot block the whole profile restore.
   */
  async prepareRestoredProfile(): Promise<{ approvals: number, demoted: number, corrupt: boolean }> {
    return this.enqueue(async () => {
      if (!await pathExists(this.approvalsFile))
        return { approvals: 0, demoted: 0, corrupt: false }

      let file: PackagesFileV1
      let corrupt = false
      try {
        file = await this.loadApprovalsFile()
      }
      catch (error) {
        if (!(error instanceof PackagesFileInvalidError))
          throw error
        await rename(this.approvalsFile, `${this.approvalsFile}.corrupt-${this.now()}`)
        file = { packageVersion: 1, approvals: [], active: {} }
        corrupt = true
      }

      const active: Record<string, PackageActivation> = {}
      for (const [packageId, activation] of Object.entries(file.active))
        active[packageId] = { ...activation, enabled: false }

      const approvals: PackageApprovalRecord[] = []
      let demoted = 0
      for (const record of file.approvals) {
        const installed = join(this.rootDir, record.packageId, record.version)
        if (!await pathExists(installed)) {
          demoted += 1
          continue
        }
        try {
          await verifyPackageDigest(installed, record.digest)
          approvals.push(record)
        }
        catch {
          demoted += 1
        }
      }

      await this.saveApprovalsFile({ packageVersion: 1, approvals, active })
      return { approvals: approvals.length, demoted, corrupt }
    })
  }
}
