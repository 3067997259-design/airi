import type { ElectronMainContextExtensions, ElectronMainEmitOptions } from '@moeru/eventa/adapters/electron/main'

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createContext, defineInvoke } from '@moeru/eventa'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  journalHostAppend,
  journalHostClear,
  journalHostRead,
} from '../../../../shared/eventa'
import { setupJournalHost } from './index'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function createService(options: Parameters<typeof setupJournalHost>[1] = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'airi-journal-host-test-'))
  temporaryDirectories.push(directory)
  const context = createContext<ElectronMainContextExtensions, ElectronMainEmitOptions>()
  await setupJournalHost(context, options, directory)
  return {
    append: defineInvoke(context, journalHostAppend),
    read: defineInvoke(context, journalHostRead),
    clear: defineInvoke(context, journalHostClear),
  }
}

describe('journal host', () => {
  it('deduplicates concurrent receipt-loss retries', async () => {
    // ROOT CAUSE:
    // Two handlers could read the same watermark before either append finished.
    // Both then wrote the same event. Serialize the file and watermark together.
    const service = await createService()
    const batch = { sessionId: 'concurrent-retry', lines: [JSON.stringify({ seq: 1, type: 'user/message' })] }
    await Promise.all([service.append(batch), service.append(batch)])
    expect((await service.read({ sessionId: batch.sessionId })).lines).toHaveLength(1)
  })

  it('does not cache sequence ids when a disk write fails', async () => {
    const appendJournalFile = vi.fn<typeof import('node:fs/promises').appendFile>()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockImplementation(async (...args) => {
        const { appendFile: realAppendFile } = await import('node:fs/promises')
        await realAppendFile(...args)
      })
    const service = await createService({ appendFile: appendJournalFile })
    const batch = { sessionId: 'write-retry', lines: [JSON.stringify({ seq: 1, type: 'user/message' })] }

    await expect(service.append(batch)).rejects.toThrow('disk full')
    expect((await service.read({ sessionId: batch.sessionId })).lines).toEqual([])

    expect(await service.append(batch)).toEqual({ appended: 1, skipped: 0 })
    expect((await service.read({ sessionId: batch.sessionId })).lines).toHaveLength(1)
    expect(appendJournalFile).toHaveBeenCalledTimes(2)
  })

  it('re-scans after a write succeeds but its receipt is lost', async () => {
    const appendJournalFile = vi.fn<typeof import('node:fs/promises').appendFile>()
      .mockImplementationOnce(async (...args) => {
        const { appendFile: realAppendFile } = await import('node:fs/promises')
        await realAppendFile(...args)
        throw new Error('receipt lost after fsync')
      })
    const service = await createService({ appendFile: appendJournalFile })
    const batch = { sessionId: 'receipt-loss-after-write', lines: [JSON.stringify({ seq: 1, type: 'user/message' })] }

    await expect(service.append(batch)).rejects.toThrow('receipt lost after fsync')
    expect(await service.append(batch)).toEqual({ appended: 0, skipped: 1 })
    expect((await service.read({ sessionId: batch.sessionId })).lines).toHaveLength(1)
  })

  it('isolates watermarks between profile owners', async () => {
    // ROOT CAUSE:
    // A module-global session watermark made a new profile inherit another
    // profile's sequence and silently skip its first restored events.
    const first = await createService()
    const second = await createService()
    const batch = { sessionId: 'shared-session-id', lines: [JSON.stringify({ seq: 1, type: 'user/message' })] }
    await first.append(batch)
    await second.append(batch)
    expect((await second.read({ sessionId: batch.sessionId })).lines).toHaveLength(1)
  })

  it('appends batches and reads them back', async () => {
    const service = await createService()

    const result = await service.append({
      sessionId: 'session-a',
      lines: [
        JSON.stringify({ type: 'session/header', seq: 0, sessionId: 'session-a' }),
        JSON.stringify({ type: 'user/message', seq: 1, text: 'hello' }),
      ],
    })
    expect(result).toEqual({ appended: 2, skipped: 0 })

    const read = await service.read({ sessionId: 'session-a' })
    expect(read.lines).toHaveLength(2)
    expect(read.truncated).toBe(false)
    expect(read.lastSeq).toBe(1)
    expect(read.gaps).toEqual([])
    expect(read.corruptLines).toBe(0)
  })

  // ROOT CAUSE:
  //
  // The renderer re-sends its whole queue after a lost IPC receipt, so the
  // host must drop lines whose seq it already persisted; otherwise a retry
  // duplicates events on disk.
  it('deduplicates redelivered lines by seq', async () => {
    const service = await createService()
    const line1 = JSON.stringify({ type: 'user/message', seq: 1, text: 'one' })
    const line2 = JSON.stringify({ type: 'user/message', seq: 2, text: 'two' })

    await service.append({ sessionId: 'session-dedupe', lines: [line1] })
    const retry = await service.append({ sessionId: 'session-dedupe', lines: [line1, line2] })

    expect(retry).toEqual({ appended: 1, skipped: 1 })
    const read = await service.read({ sessionId: 'session-dedupe' })
    expect(read.lines).toHaveLength(2)
    expect(read.duplicateLines).toBe(0)
  })

  it('rejects a reused seq whose content differs instead of silently dropping it', async () => {
    // ROOT CAUSE:
    //
    // A renderer that never replayed a restored session started again at
    // seq 0. The host treated every already-persisted seq as a retry and
    // skipped the batch, so an entire adopted-profile run was lost with no
    // error (R04-adoption, 2026-09-10). Same seq with different content is a
    // conflict, not a duplicate.
    const service = await createService()
    const sessionId = 'session-conflict'
    await service.append({
      sessionId,
      lines: [JSON.stringify({ type: 'user/message', seq: 1, text: 'persisted' })],
    })

    await expect(service.append({
      sessionId,
      lines: [JSON.stringify({ type: 'user/message', seq: 1, text: 'unreplayed' })],
    })).rejects.toThrow('sequence conflict at seq 1')

    const read = await service.read({ sessionId })
    expect(read.lines).toHaveLength(1)
    expect(read.lines[0]).toContain('persisted')

    // The identical retry after the conflict still converges instead of
    // wedging the queue.
    expect(await service.append({
      sessionId,
      lines: [JSON.stringify({ type: 'user/message', seq: 1, text: 'persisted' })],
    })).toEqual({ appended: 0, skipped: 1 })
  })

  it('reports gaps and corrupt lines without rewriting the file', async () => {
    const service = await createService()

    await service.append({
      sessionId: 'session-gap',
      lines: [
        JSON.stringify({ type: 'user/message', seq: 1, text: 'kept' }),
        'not json at all',
        JSON.stringify({ type: 'user/message', seq: 3, text: 'after the hole' }),
      ],
    })

    const read = await service.read({ sessionId: 'session-gap' })
    // Files written before the header was persisted begin at seq 1, so the
    // contiguous run is seq 1 only: the hole at seq 2 does not swallow the
    // renderer's new events, which resume at the hole.
    expect(read.lastSeq).toBe(1)
    expect(read.gaps).toEqual([2])
    expect(read.corruptLines).toBe(1)
    expect(read.lines).toHaveLength(3)
  })

  it('fills a journal gap without treating a higher seq as a watermark', async () => {
    const service = await createService()
    const sessionId = 'session-fill-gap'
    await service.append({
      sessionId,
      lines: [
        JSON.stringify({ type: 'user/message', seq: 1, text: 'first' }),
        JSON.stringify({ type: 'user/message', seq: 3, text: 'third' }),
      ],
    })

    expect(await service.append({
      sessionId,
      lines: [JSON.stringify({ type: 'user/message', seq: 2, text: 'second' })],
    })).toEqual({ appended: 1, skipped: 0 })
    expect(await service.append({
      sessionId,
      lines: [
        JSON.stringify({ type: 'user/message', seq: 1, text: 'first' }),
        JSON.stringify({ type: 'user/message', seq: 2, text: 'second' }),
        JSON.stringify({ type: 'user/message', seq: 3, text: 'third' }),
      ],
    })).toEqual({ appended: 0, skipped: 3 })
    expect((await service.read({ sessionId })).gaps).toEqual([])
  })

  it('honors the read limit and reports truncation', async () => {
    const service = await createService()
    const lines = Array.from({ length: 30 }, (_, index) =>
      JSON.stringify({ type: 'user/message', seq: index, text: `m${index}` }))

    await service.append({ sessionId: 'session-truncated', lines })
    const read = await service.read({ sessionId: 'session-truncated', limit: 10 })

    expect(read.truncated).toBe(true)
    expect(read.lines).toHaveLength(10)
    expect(JSON.parse(read.lines[0]!).seq).toBe(20)
  })

  it('resets the dedup watermark when a session is cleared', async () => {
    const service = await createService()
    const line = JSON.stringify({ type: 'user/message', seq: 1, text: 'one' })

    await service.append({ sessionId: 'session-clear', lines: [line] })
    await service.clear({ sessionId: 'session-clear' })
    const result = await service.append({ sessionId: 'session-clear', lines: [line] })

    expect(result).toEqual({ appended: 1, skipped: 0 })
  })

  it('treats a missing file as empty history', async () => {
    const service = await createService()
    const read = await service.read({ sessionId: 'session-missing' })

    expect(read.lines).toEqual([])
    expect(read.truncated).toBe(false)
    expect(read.lastSeq).toBe(-1)
  })
})
