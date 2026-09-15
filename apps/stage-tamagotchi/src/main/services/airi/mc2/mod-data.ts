/**
 * MC-2a read-only mod-jar access (main process).
 *
 * Reads whitelisted data files from a jar (a zip) without executing anything.
 * The caller must configure the allowed jar roots; a path outside them is
 * rejected before the file is opened.
 */
import type { Mc2RecipeCandidate } from '../../../../shared/mc2/recipe'

import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

import JSZip from 'jszip'

import { isAllowedEntryPath, parseRecipeCandidate } from '../../../../shared/mc2/recipe'

export type Mc2DataErrorCode = 'jar_not_allowed' | 'jar_missing' | 'jar_too_large' | 'too_many_entries'

export class Mc2DataError extends Error {
  readonly code: Mc2DataErrorCode

  constructor(code: Mc2DataErrorCode, message: string) {
    super(message)
    this.name = 'Mc2DataError'
    this.code = code
  }
}

export interface Mc2JarReadOptions {
  /** Absolute roots a jar path must stay under. */
  roots: string[]
  /** Exact entry paths to read; empty/omitted means every allowed entry. */
  entryPaths?: string[]
  /** Substring filters applied after the whitelist. */
  patterns?: string[]
}

export interface Mc2JarEntry {
  path: string
  text: string
}

export interface Mc2JarReadResult {
  entries: Mc2JarEntry[]
  candidates: Mc2RecipeCandidate[]
  truncated: boolean
}

const MAX_JAR_BYTES = 64 * 1024 * 1024
const MAX_ENTRIES = 20_000
const MAX_TOTAL_TEXT_BYTES = 2 * 1024 * 1024

function assertUnderRoots(jarPath: string, roots: string[]): void {
  const target = resolve(jarPath)
  const allowed = roots.some((root) => {
    const rel = relative(resolve(root), target)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  })
  if (!allowed)
    throw new Mc2DataError('jar_not_allowed', `jar path is outside the configured roots: ${jarPath}`)
}

/** Reads whitelisted entries from one jar; no code inside it is executed. */
export async function readJarEntries(jarPath: string, options: Mc2JarReadOptions): Promise<Mc2JarReadResult> {
  assertUnderRoots(jarPath, options.roots)

  const info = await stat(jarPath).catch(() => undefined)
  if (!info?.isFile())
    throw new Mc2DataError('jar_missing', `jar not found: ${jarPath}`)
  if (info.size > MAX_JAR_BYTES)
    throw new Mc2DataError('jar_too_large', `jar exceeds ${MAX_JAR_BYTES} bytes`)

  const zip = await JSZip.loadAsync(await readFile(jarPath))
  const names = Object.keys(zip.files).filter(name => !zip.files[name]!.dir)
  if (names.length > MAX_ENTRIES)
    throw new Mc2DataError('too_many_entries', `jar has more than ${MAX_ENTRIES} entries`)

  const wanted = names.filter((name) => {
    if (!isAllowedEntryPath(name))
      return false
    if (options.entryPaths?.length && !options.entryPaths.includes(name))
      return false
    if (options.patterns?.length && !options.patterns.some(pattern => name.includes(pattern)))
      return false
    return true
  })

  const entries: Mc2JarEntry[] = []
  let totalBytes = 0
  let truncated = false
  for (const name of wanted) {
    const text = await zip.files[name]!.async('string')
    if (totalBytes + text.length > MAX_TOTAL_TEXT_BYTES) {
      truncated = true
      break
    }
    totalBytes += text.length
    entries.push({ path: name, text })
  }

  const candidates: Mc2RecipeCandidate[] = []
  for (const entry of entries) {
    const candidate = parseRecipeCandidate(entry.text, entry.path)
    if (candidate)
      candidates.push(candidate)
  }

  return { entries, candidates, truncated }
}
