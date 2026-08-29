import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { readPersistedConnectionString, writePersistedConnectionString } from './index'

let tempDir: string

afterEach(async () => {
  if (tempDir)
    await rm(tempDir, { recursive: true, force: true })
})

describe('memory host persisted connection string', () => {
  it('round-trips a connection string and clears on undefined', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'memory-host-'))
    const path = join(tempDir, 'memory-host.json')

    expect(await readPersistedConnectionString(path)).toBeUndefined()

    await writePersistedConnectionString(path, 'postgresql://user:pass@127.0.0.1:5435/db')
    expect(await readPersistedConnectionString(path)).toBe('postgresql://user:pass@127.0.0.1:5435/db')

    // The persisted file is plain JSON so it stays inspectable by the user.
    const raw = JSON.parse(await readFile(path, 'utf8'))
    expect(raw.connectionString).toContain('5435')

    await writePersistedConnectionString(path, undefined)
    expect(await readPersistedConnectionString(path)).toBeUndefined()
  })
})
