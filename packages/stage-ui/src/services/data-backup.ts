import JSZip from 'jszip'

import * as v from 'valibot'

const domainSchema = v.picklist(['memory', 'plans', 'journal', 'skills', 'chats', 'identity', 'outbox', 'packages'])
const pathSchema = v.pipe(v.string(), v.regex(/^(?:memory|plans|journal|skills|chats|identity|outbox|packages)\/[\w./-]+$/), v.check(path => !path.split('/').some(part => !part || part === '.' || part === '..')))
const entrySchema = v.object({
  path: pathSchema,
  domain: domainSchema,
  bytes: v.pipe(v.number(), v.integer(), v.minValue(0)),
  sha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
})
const manifestSchema = v.strictObject({
  format: v.literal('airi-data-backup'),
  version: v.literal(1),
  snapshotId: v.string(),
  createdAt: v.pipe(v.number(), v.finite()),
  buildId: v.pipe(v.string(), v.minLength(1)),
  credentials: v.literal('excluded'),
  outbox: v.literal('held'),
  coverage: v.array(domainSchema),
  missing: v.array(v.string()),
  prerequisites: v.array(v.string()),
  entries: v.array(entrySchema),
})

/** A portable snapshot describes both its contents and its known omissions. */
export type DataBackupManifest = v.InferOutput<typeof manifestSchema>
export type DataBackupDomain = v.InferOutput<typeof domainSchema>

/** Bytes produced by a domain owner after that owner reaches a stable snapshot. */
export interface DataBackupEntry {
  path: string
  domain: DataBackupDomain
  data: Uint8Array
}

/** Per-file semantic counts for JSON and JSONL owner records. */
export interface DataBackupSemanticPathComparison {
  path: string
  domain: DataBackupDomain
  beforeRecords: number
  afterRecords: number
  unchangedRecords: number
  addedRecords: number
  removedRecords: number
  changedRecords: number
  parseErrors: number
}

/** Inspection never writes a profile or restores credentials and delivery work. */
export interface InspectedDataBackup {
  manifest: DataBackupManifest
  entries: DataBackupEntry[]
}

export type DataBackupPathChangeKind = 'added' | 'removed' | 'changed'

export interface DataBackupPathChange {
  path: string
  domain: DataBackupDomain
  kind: DataBackupPathChangeKind
}

/**
 * Compares two inspected manifests without touching live profile state.
 *
 * The result is a byte-level owner comparison. It does not claim that a
 * changed parquet or JSON file has the same semantic relationships inside it;
 * callers must use the owning domain's parser for that deeper check.
 */
export function compareDataBackups(before: InspectedDataBackup, after: InspectedDataBackup): {
  beforeSnapshotId: string
  afterSnapshotId: string
  changes: DataBackupPathChange[]
  unchangedPaths: string[]
  byDomain: Record<DataBackupDomain, { added: number, removed: number, changed: number, unchanged: number }>
} {
  const beforeEntries = new Map(before.manifest.entries.map(entry => [entry.path, entry]))
  const afterEntries = new Map(after.manifest.entries.map(entry => [entry.path, entry]))
  const changes: DataBackupPathChange[] = []
  const unchangedPaths: string[] = []
  const domains: DataBackupDomain[] = ['memory', 'plans', 'journal', 'skills', 'chats', 'identity', 'outbox', 'packages']
  const byDomain = Object.fromEntries(domains.map(domain => [domain, { added: 0, removed: 0, changed: 0, unchanged: 0 }])) as Record<DataBackupDomain, { added: number, removed: number, changed: number, unchanged: number }>

  for (const [path, entry] of beforeEntries) {
    const current = afterEntries.get(path)
    if (!current) {
      changes.push({ path, domain: entry.domain, kind: 'removed' })
      byDomain[entry.domain].removed += 1
      continue
    }
    if (current.sha256 !== entry.sha256 || current.bytes !== entry.bytes || current.domain !== entry.domain) {
      changes.push({ path, domain: current.domain, kind: 'changed' })
      byDomain[current.domain].changed += 1
      continue
    }
    unchangedPaths.push(path)
    byDomain[current.domain].unchanged += 1
  }

  for (const [path, entry] of afterEntries) {
    if (beforeEntries.has(path))
      continue
    changes.push({ path, domain: entry.domain, kind: 'added' })
    byDomain[entry.domain].added += 1
  }

  changes.sort((left, right) => left.path.localeCompare(right.path))
  unchangedPaths.sort((left, right) => left.localeCompare(right))
  return {
    beforeSnapshotId: before.manifest.snapshotId,
    afterSnapshotId: after.manifest.snapshotId,
    changes,
    unchangedPaths,
    byDomain,
  }
}

function stableSemanticValue(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map(item => stableSemanticValue(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableSemanticValue(nested)]))
  }
  return value
}

function semanticRecords(entry: DataBackupEntry | undefined): { records: string[], parseErrors: number } {
  if (!entry || (!entry.path.endsWith('.json') && !entry.path.endsWith('.jsonl')))
    return { records: [], parseErrors: 0 }

  const text = new TextDecoder('utf-8', { fatal: false }).decode(entry.data)
  if (entry.path.endsWith('.jsonl')) {
    const records: string[] = []
    let parseErrors = 0
    for (const line of text.split('\n')) {
      if (!line.trim())
        continue
      try {
        records.push(JSON.stringify(stableSemanticValue(JSON.parse(line))))
      }
      catch {
        parseErrors += 1
      }
    }
    return { records, parseErrors }
  }

  try {
    const parsed = stableSemanticValue(JSON.parse(text))
    const values = Array.isArray(parsed) ? parsed : [parsed]
    return { records: values.map(value => JSON.stringify(value)), parseErrors: 0 }
  }
  catch {
    return { records: [], parseErrors: 1 }
  }
}

/**
 * Compares JSON and JSONL owner records after key-order normalization.
 *
 * Parquet entries are intentionally omitted from this result: their semantic
 * comparison belongs to the DuckDB owner, while this function makes journal,
 * plans, chats, identity, skills, and outbox relationships inspectable without
 * opening a live profile.
 */
export function compareDataBackupSemantics(before: InspectedDataBackup, after: InspectedDataBackup): DataBackupSemanticPathComparison[] {
  const beforeEntries = new Map(before.entries.map(entry => [entry.path, entry]))
  const afterEntries = new Map(after.entries.map(entry => [entry.path, entry]))
  const paths = [...new Set([...beforeEntries.keys(), ...afterEntries.keys()])]
    .filter(path => path.endsWith('.json') || path.endsWith('.jsonl'))
    .sort((left, right) => left.localeCompare(right))

  return paths.map((path) => {
    const beforeEntry = beforeEntries.get(path)
    const afterEntry = afterEntries.get(path)
    const beforeSemantic = semanticRecords(beforeEntry)
    const afterSemantic = semanticRecords(afterEntry)
    const paired = Math.min(beforeSemantic.records.length, afterSemantic.records.length)
    let unchangedRecords = 0
    for (let index = 0; index < paired; index++) {
      if (beforeSemantic.records[index] === afterSemantic.records[index])
        unchangedRecords += 1
    }
    const domain = afterEntry?.domain ?? beforeEntry!.domain
    return {
      path,
      domain,
      beforeRecords: beforeSemantic.records.length,
      afterRecords: afterSemantic.records.length,
      unchangedRecords,
      addedRecords: Math.max(0, afterSemantic.records.length - paired),
      removedRecords: Math.max(0, beforeSemantic.records.length - paired),
      changedRecords: paired - unchangedRecords,
      parseErrors: beforeSemantic.parseErrors + afterSemantic.parseErrors,
    }
  })
}

// JSZip holds archive data in memory. Keep the initial restore format bounded
// until MD-3 measurements justify a streaming format for larger profiles.
const MAX_BACKUP_BYTES = 64 * 1024 * 1024
const MAX_BACKUP_ENTRIES = 10_000

async function hash(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(data))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

function checkEntries(entries: DataBackupManifest['entries']) {
  if (entries.length > MAX_BACKUP_ENTRIES)
    throw new Error('Backup contains too many files.')
  const seen = new Set<string>()
  let bytes = 0
  for (const entry of entries) {
    const key = entry.path.toLowerCase()
    if (seen.has(key) || !entry.path.startsWith(`${entry.domain}/`))
      throw new Error('Backup contains a duplicate path or a mismatched data owner.')
    seen.add(key)
    bytes += entry.bytes
    if (bytes > MAX_BACKUP_BYTES)
      throw new Error('Backup exceeds the 64 MiB limit.')
  }
}

/**
 * Packages owner-produced snapshots without reading live database files.
 * Callers must hold their maintenance barrier until all entries are captured.
 * This function does not strip secrets: each owner must provide business data
 * only. The manifest makes exclusions and incomplete source coverage explicit.
 */
export async function createDataBackup(input: {
  snapshotId: string
  buildId: string
  createdAt: number
  coverage: DataBackupDomain[]
  missing: string[]
  prerequisites: string[]
  entries: DataBackupEntry[]
}): Promise<Uint8Array> {
  // Copy before hashing. A caller must not be able to mutate the payload after
  // its digest is computed and before JSZip serializes it.
  const entries = input.entries.map(entry => ({ ...entry, data: new Uint8Array(entry.data) }))
  const descriptions = entries.map(entry => ({ path: entry.path, domain: entry.domain, bytes: entry.data.byteLength, sha256: '0'.repeat(64) }))
  checkEntries(v.parse(v.array(entrySchema), descriptions))
  for (let index = 0; index < entries.length; index++)
    descriptions[index]!.sha256 = await hash(entries[index]!.data)
  const manifest = v.parse(manifestSchema, {
    format: 'airi-data-backup',
    version: 1,
    snapshotId: input.snapshotId,
    buildId: input.buildId,
    createdAt: input.createdAt,
    credentials: 'excluded',
    outbox: 'held',
    coverage: input.coverage,
    missing: input.missing,
    prerequisites: input.prerequisites,
    entries: descriptions,
  })
  const zip = new JSZip()
  zip.file('manifest.json', JSON.stringify(manifest))
  for (const entry of entries)
    zip.file(entry.path, entry.data, { createFolders: false })
  return zip.generateAsync({ type: 'uint8array', compression: 'STORE' })
}

function readBounded(file: JSZip.JSZipObject, limit: number): Promise<Uint8Array> {
  // JSZip's public types omit the bounded stream API, but the runtime object
  // exposes it for incremental extraction. Keep the cast at this boundary.
  const streamFile = file as JSZip.JSZipObject & { internalStream: (type: 'uint8array') => { on: (event: string, listener: (value: Uint8Array) => void) => unknown, pause: () => void, resume: () => void } }
  return new Promise((resolve, reject) => {
    const stream = streamFile.internalStream('uint8array')
    const chunks: Uint8Array[] = []
    let bytes = 0
    stream.on('data', (chunk: Uint8Array) => {
      bytes += chunk.byteLength
      if (bytes > limit) {
        stream.pause()
        chunks.length = 0
        reject(new Error(`Backup file exceeds its declared size: ${file.name}`))
        return
      }
      chunks.push(chunk)
    })
    stream.on('error', reject)
    stream.on('end', () => {
      const result = new Uint8Array(bytes)
      let offset = 0
      for (const chunk of chunks) {
        result.set(chunk, offset)
        offset += chunk.byteLength
      }
      resolve(result)
    })
    stream.resume()
  })
}

/**
 * Validates the entire archive before a restore target can receive any bytes.
 * Names are checked before JSZip's sanitized names are used. A checksum proves
 * package consistency, not authorship or permission to execute imported code.
 */
export async function inspectDataBackup(data: Uint8Array): Promise<InspectedDataBackup> {
  if (data.byteLength > MAX_BACKUP_BYTES + 1024 * 1024)
    throw new Error('Backup archive exceeds the size limit.')
  const zip = await JSZip.loadAsync(data)
  const files = Object.values(zip.files)
  if (files.length > MAX_BACKUP_ENTRIES + 1)
    throw new Error('Backup contains too many files.')
  for (const file of files) {
    if (file.dir || file.unsafeOriginalName !== file.name)
      throw new Error('Backup contains a non-canonical archive path.')
  }
  const manifestFile = zip.file('manifest.json')
  if (!manifestFile)
    throw new Error('Backup manifest is missing.')
  const manifest = v.parse(manifestSchema, JSON.parse(new TextDecoder().decode(await readBounded(manifestFile, 1024 * 1024))))
  checkEntries(manifest.entries)
  if (files.length !== manifest.entries.length + 1)
    throw new Error('Backup contains files that are not listed in its manifest.')
  const entries: DataBackupEntry[] = []
  for (const entry of manifest.entries) {
    const file = zip.file(entry.path)
    if (!file)
      throw new Error(`Backup file is missing: ${entry.path}`)
    const bytes = await readBounded(file, entry.bytes)
    if (bytes.byteLength !== entry.bytes || await hash(bytes) !== entry.sha256)
      throw new Error(`Backup checksum failed: ${entry.path}`)
    entries.push({ path: entry.path, domain: entry.domain, data: bytes })
  }
  return { manifest, entries }
}
