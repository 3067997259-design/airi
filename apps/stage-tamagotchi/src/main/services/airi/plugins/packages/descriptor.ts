import type { InferOutput } from 'valibot'

import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  array,
  literal,
  minLength,
  object,
  optional,
  pipe,
  record,
  safeParse,
  string,
  unknown,
} from 'valibot'

/**
 * EP-2a package descriptor + whole-package digest.
 *
 * The descriptor lives in a standalone `airi-package.json` because the
 * upstream manifest schema strips unknown fields; `extension.airi.json` keeps
 * only identity and must not declare runtime entrypoints (EP-2a D3: no
 * arbitrary Node entry, execution stays in the reviewed-skill sandbox).
 */

/** Raised when a package manifest declares a runtime entrypoint. */
export class PackageEntrypointForbiddenError extends Error {
  constructor() {
    super('Package manifests must not declare runtime entrypoints; packages are declarative (EP-2a).')
    this.name = 'PackageEntrypointForbiddenError'
  }
}

/** Raised when `airi-package.json` fails schema validation. */
export class PackageDescriptorInvalidError extends Error {
  constructor(detail: string) {
    super(`Invalid airi-package.json: ${detail}`)
    this.name = 'PackageDescriptorInvalidError'
  }
}

/** Raised when the recomputed digest does not match the approved digest. */
export class PackageDigestMismatchError extends Error {
  readonly expected: string
  readonly actual: string

  constructor(expected: string, actual: string) {
    super(`Package digest mismatch: approved ${expected}, actual ${actual}.`)
    this.name = 'PackageDigestMismatchError'
    this.expected = expected
    this.actual = actual
  }
}

export const airiPackageDescriptorV1Schema = object({
  packageVersion: literal(1),
  id: pipe(string(), minLength(1)),
  version: pipe(string(), minLength(1)),
  tools: array(object({
    name: pipe(string(), minLength(1)),
    description: string(),
    parameters: record(string(), unknown()),
    skill: object({
      toolId: pipe(string(), minLength(1)),
      contentHash: pipe(string(), minLength(1)),
    }),
  })),
  ui: optional(object({
    gamelets: optional(array(object({
      moduleId: pipe(string(), minLength(1)),
      kitId: pipe(string(), minLength(1)),
      entryAsset: pipe(string(), minLength(1)),
    }))),
    widgets: optional(array(object({
      moduleId: pipe(string(), minLength(1)),
      kitId: pipe(string(), minLength(1)),
      entryAsset: pipe(string(), minLength(1)),
    }))),
  })),
  dependencies: optional(object({
    skills: optional(array(object({
      toolId: pipe(string(), minLength(1)),
      contentHash: pipe(string(), minLength(1)),
    }))),
  })),
})

export type AiriPackageDescriptorV1 = InferOutput<typeof airiPackageDescriptorV1Schema>

export interface PackageFileDigest {
  /** Path relative to the package root, always `/`-separated. */
  path: string
  sha256: string
}

/**
 * Files covered by the whole-package digest.
 *
 * `data/**` is plugin-private state and logs are diagnostics: neither may
 * change an approval. The lock file itself is derived and excluded too.
 */
const DIGEST_ROOT_FILES = ['extension.airi.json', 'airi-package.json']
const DIGEST_ROOT_DIRS = ['skills', 'assets']

/** Lists covered files in stable path order. */
export async function listPackageFiles(rootDir: string): Promise<string[]> {
  const files: string[] = []

  const walk = async (relativeDir: string): Promise<void> => {
    const entries = await readdir(join(rootDir, relativeDir), { withFileTypes: true })
    for (const entry of entries) {
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!relativeDir && (entry.name === 'data' || entry.name === 'logs'))
          continue
        await walk(relativePath)
        continue
      }
      if (!entry.isFile())
        continue
      const covered = DIGEST_ROOT_FILES.includes(relativePath)
        || DIGEST_ROOT_DIRS.some(dir => relativePath.startsWith(`${dir}/`))
      if (covered)
        files.push(relativePath)
    }
  }

  await walk('')
  return files.sort()
}

/**
 * Computes the whole-package digest from an already-observed file list.
 *
 * EP-2b: the trial worker observes `{ path, sha256 }` entries; the main
 * process assembles the digest with this shared function so worker and
 * in-process digests cannot drift.
 */
export function digestFromFileDigests(files: readonly PackageFileDigest[]): string {
  const sorted = [...files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex')
}

/**
 * Computes the whole-package digest: sha256 over the sorted `{ path, sha256 }`
 * list, so file order and mtimes never change the result.
 */
export async function computePackageDigest(rootDir: string): Promise<{ digest: string, files: PackageFileDigest[] }> {
  const files = await listPackageFiles(rootDir)
  const fileDigests: PackageFileDigest[] = []

  for (const file of files) {
    const data = await readFile(join(rootDir, file))
    fileDigests.push({ path: file, sha256: createHash('sha256').update(data).digest('hex') })
  }

  return { digest: digestFromFileDigests(fileDigests), files: fileDigests }
}

/** Recomputes the digest and compares it with the approved value. */
export async function verifyPackageDigest(rootDir: string, expected: string): Promise<void> {
  const { digest } = await computePackageDigest(rootDir)
  if (digest !== expected)
    throw new PackageDigestMismatchError(expected, digest)
}

/** Validates `airi-package.json` and returns the parsed descriptor. */
export function parsePackageDescriptor(value: unknown): AiriPackageDescriptorV1 {
  const result = safeParse(airiPackageDescriptorV1Schema, value)
  if (!result.success) {
    const detail = result.issues.map(issue => issue.message).join('; ')
    throw new PackageDescriptorInvalidError(detail)
  }
  return result.output
}

/**
 * Rejects manifests that declare runtime entrypoints.
 *
 * EP-2a packages are declarative; the executable body is the reviewed skill
 * source copied under `skills/`, executed through the coding-host sandbox.
 */
export function assertDeclarativeManifest(manifest: unknown): void {
  if (!manifest || typeof manifest !== 'object')
    throw new PackageDescriptorInvalidError('manifest is not an object')
  const entrypoints = (manifest as { entrypoints?: unknown }).entrypoints
  if (!entrypoints || typeof entrypoints !== 'object')
    return
  const declared = Object.values(entrypoints as Record<string, unknown>)
    .filter(value => typeof value === 'string' && value.trim().length > 0)
  if (declared.length > 0)
    throw new PackageEntrypointForbiddenError()
}
