import type { ModulePermissionDeclaration, ModulePermissionGrant } from '@proj-airi/plugin-sdk/plugin-host'

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { PermissionService } from '@proj-airi/plugin-sdk/plugin-host'

import * as v from 'valibot'

/**
 * CP-2 permission grant store.
 *
 * Owns `<extensionsDir>/permissions.json`: the only persisted user approval a
 * desktop extension session may resolve permissions from. The store is
 * deny-by-default — a missing record or a manifest whose bytes changed since
 * approval resolves to an empty grant, never to `manifest.permissions`.
 */

/** Raised when the persisted `permissions.json` is corrupt; never silently reset. */
export class PermissionsFileInvalidError extends Error {
  constructor(detail: string) {
    super(`Invalid permissions.json: ${detail}`)
    this.name = 'PermissionsFileInvalidError'
  }
}

const permissionSpecSchema = v.looseObject({
  key: v.pipe(v.string(), v.minLength(1)),
  actions: v.array(v.string()),
})

const permissionDeclarationSchema = v.object({
  apis: v.optional(v.array(permissionSpecSchema)),
  resources: v.optional(v.array(permissionSpecSchema)),
  capabilities: v.optional(v.array(permissionSpecSchema)),
  processors: v.optional(v.array(permissionSpecSchema)),
  pipelines: v.optional(v.array(permissionSpecSchema)),
})

/** One user approval: the granted permission ceiling bound to manifest bytes. */
export interface ExtensionPermissionGrant {
  extensionId: string
  /** User-approved ceiling; every area is an array (normalized on write). */
  grant: ModulePermissionGrant
  approvedBy: 'user'
  approvedAt: number
  /** sha256 over the canonical manifest JSON; a changed manifest invalidates it. */
  manifestDigest: string
}

export interface PermissionsFileV1 {
  version: 1
  grants: ExtensionPermissionGrant[]
}

const permissionsFileV1Schema = v.object({
  version: v.literal(1),
  grants: v.array(v.object({
    extensionId: v.pipe(v.string(), v.minLength(1)),
    grant: permissionDeclarationSchema,
    approvedBy: v.literal('user'),
    approvedAt: v.number(),
    manifestDigest: v.pipe(v.string(), v.minLength(1)),
  })),
})

const EMPTY_GRANT: ModulePermissionGrant = Object.freeze({
  apis: [],
  resources: [],
  capabilities: [],
  processors: [],
  pipelines: [],
})

function emptyGrant(): ModulePermissionGrant {
  return structuredClone(EMPTY_GRANT)
}

function normalizeKeys(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map(normalizeKeys)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, entry]) => [key, normalizeKeys(entry)]),
    )
  }
  return value
}

/**
 * Canonical manifest hash used to bind an approval to the reviewed bytes.
 *
 * @example
 * manifestDigestOf({ id: 'demo', permissions: {} })
 * // => '4f...' (stable regardless of key order)
 */
export function manifestDigestOf(manifest: unknown): string {
  return createHash('sha256').update(JSON.stringify(normalizeKeys(manifest))).digest('hex')
}

export interface PermissionStoreOptions {
  /** `<userData>/extensions`; the grants file lives directly under it. */
  extensionsDir: string
  /** Injectable clock for deterministic tests. */
  now?: () => number
}

export class PermissionStore {
  private readonly file: string
  private readonly now: () => number
  // Serializes read-modify-write cycles on permissions.json (single writer).
  private queue: Promise<unknown> = Promise.resolve()

  constructor(options: PermissionStoreOptions) {
    this.file = join(options.extensionsDir, 'permissions.json')
    this.now = options.now ?? (() => Date.now())
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation)
    this.queue = next.then(() => undefined, () => undefined)
    return next
  }

  private async load(): Promise<PermissionsFileV1> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { version: 1, grants: [] }
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    }
    catch {
      throw new PermissionsFileInvalidError('file is not valid JSON')
    }
    const result = v.safeParse(permissionsFileV1Schema, parsed)
    if (!result.success)
      throw new PermissionsFileInvalidError(result.issues.map(issue => issue.message).join('; '))
    return result.output as PermissionsFileV1
  }

  private async save(file: PermissionsFileV1): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const temp = `${this.file}.tmp`
    await writeFile(temp, JSON.stringify(file, null, 2))
    // Replace instead of writing in place: a crash leaves the old grants intact.
    await rm(this.file, { force: true })
    await rename(temp, this.file)
  }

  /** All persisted approvals, newest first is not guaranteed; order is stable. */
  async list(): Promise<ExtensionPermissionGrant[]> {
    const { grants } = await this.load()
    return grants.map(record => ({ ...record, grant: structuredClone(record.grant) }))
  }

  /**
   * Records the user's approval for one extension manifest.
   *
   * The stored ceiling is always inside the manifest declaration: `grant`
   * narrows `manifest.permissions` and can never extend it.
   */
  async approve(input: { extensionId: string, manifest: { permissions: ModulePermissionDeclaration }, grant?: ModulePermissionDeclaration }): Promise<ExtensionPermissionGrant> {
    return this.enqueue(async () => {
      const service = new PermissionService()
      const requested = input.grant ?? input.manifest.permissions
      const ceiling = service.intersectGrant(input.manifest.permissions, requested)
      const record: ExtensionPermissionGrant = {
        extensionId: input.extensionId,
        grant: ceiling,
        approvedBy: 'user',
        approvedAt: this.now(),
        manifestDigest: manifestDigestOf(input.manifest),
      }
      const file = await this.load()
      const grants = file.grants.filter(existing => existing.extensionId !== input.extensionId)
      grants.push(record)
      await this.save({ version: 1, grants })
      return structuredClone(record)
    })
  }

  /** Removes one approval. Returns whether a record existed. */
  async revoke(extensionId: string): Promise<boolean> {
    return this.enqueue(async () => {
      const file = await this.load()
      const grants = file.grants.filter(existing => existing.extensionId !== extensionId)
      if (grants.length === file.grants.length)
        return false
      await this.save({ version: 1, grants })
      return true
    })
  }

  /**
   * Resolves the effective grant for one session (CP-2 deny-by-default).
   *
   * Missing approval or a manifest whose bytes changed since approval yields
   * an empty grant; an approved record is intersected with the requested
   * declaration, so an unapproved increment never takes effect.
   */
  async resolve(input: {
    extensionId: string
    manifest: unknown & { permissions: ModulePermissionDeclaration }
    requested: ModulePermissionDeclaration
  }): Promise<{ grant: ModulePermissionGrant, reason?: 'not_approved' | 'manifest_changed' }> {
    const file = await this.load()
    const record = file.grants.find(existing => existing.extensionId === input.extensionId)
    if (!record)
      return { grant: emptyGrant(), reason: 'not_approved' }
    if (record.manifestDigest !== manifestDigestOf(input.manifest))
      return { grant: emptyGrant(), reason: 'manifest_changed' }
    const service = new PermissionService()
    return { grant: service.intersectGrant(record.grant, input.requested) }
  }
}
