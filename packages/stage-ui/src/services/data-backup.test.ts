import JSZip from 'jszip'

import { describe, expect, it } from 'vitest'

import { compareDataBackups, compareDataBackupSemantics, createDataBackup, inspectDataBackup } from './data-backup'

async function snapshot() {
  return createDataBackup({
    snapshotId: 'fixture-snapshot',
    buildId: 'fixture-build',
    createdAt: 1,
    coverage: ['journal'],
    missing: ['memory'],
    prerequisites: ['Configure providers separately.'],
    entries: [{ path: 'journal/session.jsonl', domain: 'journal', data: new TextEncoder().encode('{"seq":17,"sessionId":"session"}\n') }],
  })
}

async function snapshotWithJournal(content: string, snapshotId: string) {
  return inspectDataBackup(await createDataBackup({
    snapshotId,
    buildId: 'fixture-build',
    createdAt: 1,
    coverage: ['journal'],
    missing: ['memory'],
    prerequisites: [],
    entries: [{ path: 'journal/session.jsonl', domain: 'journal', data: new TextEncoder().encode(content) }],
  }))
}

describe('portable data backup', () => {
  it('preserves source bytes, exclusions and incomplete coverage through ZIP', async () => {
    const result = await inspectDataBackup(await snapshot())
    expect(result.manifest.version).toBe(1)
    expect(result.manifest.credentials).toBe('excluded')
    expect(result.manifest.outbox).toBe('held')
    expect(result.manifest.missing).toEqual(['memory'])
    expect(new TextDecoder().decode(result.entries[0]!.data)).toBe('{"seq":17,"sessionId":"session"}\n')
  })

  it('compares restore manifests by owner without reading live profile state', async () => {
    const before = await snapshotWithJournal('{"seq":1}\n', 'before')
    const after = await snapshotWithJournal('{"seq":2}\n', 'after')
    const result = compareDataBackups(before, after)

    expect(result.beforeSnapshotId).toBe('before')
    expect(result.afterSnapshotId).toBe('after')
    expect(result.changes).toEqual([{ path: 'journal/session.jsonl', domain: 'journal', kind: 'changed' }])
    expect(result.byDomain.journal).toEqual({ added: 0, removed: 0, changed: 1, unchanged: 0 })
    expect(result.byDomain.memory).toEqual({ added: 0, removed: 0, changed: 0, unchanged: 0 })
  })

  it('compares JSON and JSONL owner records after key-order normalization', async () => {
    const bytes = (value: string) => new TextEncoder().encode(value)
    const before = await inspectDataBackup(await createDataBackup({
      snapshotId: 'semantic-before',
      buildId: 'fixture-build',
      createdAt: 1,
      coverage: ['journal', 'skills'],
      missing: [],
      prerequisites: [],
      entries: [
        { path: 'journal/session.jsonl', domain: 'journal', data: bytes('{"seq":1,"text":"same"}\n{"seq":2,"text":"old"}\n') },
        { path: 'skills/registry.json', domain: 'skills', data: bytes('[{"toolId":"a","trust":"reviewed"}]') },
      ],
    }))
    const after = await inspectDataBackup(await createDataBackup({
      snapshotId: 'semantic-after',
      buildId: 'fixture-build',
      createdAt: 2,
      coverage: ['journal', 'skills'],
      missing: [],
      prerequisites: [],
      entries: [
        { path: 'journal/session.jsonl', domain: 'journal', data: bytes('{"text":"same","seq":1}\n{"seq":2,"text":"new"}\n{"seq":3,"text":"added"}\n') },
        { path: 'skills/registry.json', domain: 'skills', data: bytes('[{"trust":"reviewed","toolId":"a"}]') },
      ],
    }))

    expect(compareDataBackupSemantics(before, after)).toEqual([
      {
        path: 'journal/session.jsonl',
        domain: 'journal',
        beforeRecords: 2,
        afterRecords: 3,
        unchangedRecords: 1,
        addedRecords: 1,
        removedRecords: 0,
        changedRecords: 1,
        parseErrors: 0,
      },
      {
        path: 'skills/registry.json',
        domain: 'skills',
        beforeRecords: 1,
        afterRecords: 1,
        unchangedRecords: 1,
        addedRecords: 0,
        removedRecords: 0,
        changedRecords: 0,
        parseErrors: 0,
      },
    ])
  })

  it('rejects altered content before returning any restore payload', async () => {
    const zip = await JSZip.loadAsync(await snapshot())
    zip.file('journal/session.jsonl', 'different', { createFolders: false })
    await expect(inspectDataBackup(await zip.generateAsync({ type: 'uint8array' }))).rejects.toThrow('checksum')
  })

  it('rejects missing files and unsupported manifest versions', async () => {
    const zip = await JSZip.loadAsync(await snapshot())
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'))
    manifest.version = 2
    zip.file('manifest.json', JSON.stringify(manifest))
    await expect(inspectDataBackup(await zip.generateAsync({ type: 'uint8array' }))).rejects.toThrow()
    manifest.version = 1
    zip.file('manifest.json', JSON.stringify(manifest))
    zip.remove('journal/session.jsonl')
    await expect(inspectDataBackup(await zip.generateAsync({ type: 'uint8array' }))).rejects.toThrow()
  })

  it('rejects traversal names before trusting sanitized ZIP paths', async () => {
    // ROOT CAUSE:
    // JSZip sanitizes ../ paths. Checking only the resulting name would hide
    // the original path and make an unsafe package look canonical.
    const zip = await JSZip.loadAsync(await snapshot())
    zip.file('../journal/unlisted.jsonl', 'unsafe', { createFolders: false })
    await expect(inspectDataBackup(await zip.generateAsync({ type: 'uint8array' }))).rejects.toThrow('non-canonical')
  })

  it('rejects extra files and Windows case collisions', async () => {
    const zip = await JSZip.loadAsync(await snapshot())
    zip.file('journal/extra.jsonl', 'extra', { createFolders: false })
    await expect(inspectDataBackup(await zip.generateAsync({ type: 'uint8array' }))).rejects.toThrow('not listed')
    await expect(createDataBackup({
      snapshotId: 'collision',
      buildId: 'fixture',
      createdAt: 1,
      coverage: ['journal'],
      missing: [],
      prerequisites: [],
      entries: [
        { path: 'journal/A.jsonl', domain: 'journal', data: new Uint8Array() },
        { path: 'journal/a.jsonl', domain: 'journal', data: new Uint8Array() },
      ],
    })).rejects.toThrow('duplicate')
  })

  it('stops extraction when expanded data exceeds the declared size', async () => {
    const zip = await JSZip.loadAsync(await snapshot())
    zip.file('journal/session.jsonl', 'x'.repeat(128 * 1024), { createFolders: false })
    await expect(inspectDataBackup(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }))).rejects.toThrow('declared size')
  })
})
