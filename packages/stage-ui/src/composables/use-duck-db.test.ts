import { drizzle } from '@proj-airi/drizzle-duckdb-wasm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

import { useDuckDb } from './use-duck-db'

vi.mock('@proj-airi/drizzle-duckdb-wasm', () => ({
  DBStorageType: { ORIGIN_PRIVATE_FS: 'origin-private-fs' },
  DuckDBAccessMode: { READ_WRITE: 3 },
  drizzle: vi.fn().mockImplementation(() => ({
    execute: vi.fn().mockResolvedValue([]),
    $client: {
      close: vi.fn().mockResolvedValue(undefined),
    },
  })),
}))

// Mock the helper function
vi.mock('@proj-airi/drizzle-duckdb-wasm/bundles/import-url-browser', () => ({
  getImportUrlBundles: vi.fn().mockReturnValue([]),
}))

describe('useDuckDB (Singleton)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(drizzle).mockClear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('should return the same instance on multiple calls', async () => {
    const { getDb, closeDb } = useDuckDb()

    const instance1 = await getDb()
    expect(instance1).toBeDefined()
    expect(vi.mocked(drizzle).mock.calls.length).toBe(1)
    expect(vi.mocked(drizzle).mock.calls[0]?.[0]).toMatchObject({
      connection: {
        storage: {
          type: 'origin-private-fs',
          path: 'airi-memory.duckdb',
          accessMode: 3,
        },
      },
    })

    const { getDb: getDb2 } = useDuckDb()
    const instance2 = await getDb2()

    expect(instance1).toBe(instance2)
    expect(vi.mocked(drizzle).mock.calls.length).toBe(1)

    await closeDb() // manual reset of the singleton
  })

  it('should handle concurrent getDb calls without duplicate initialization', async () => {
    const { getDb, closeDb } = useDuckDb()

    const promise1 = getDb()
    const promise2 = getDb()

    const [instance1, instance2] = await Promise.all([promise1, promise2])

    expect(instance1).toBe(instance2)
    expect(vi.mocked(drizzle).mock.calls.length).toBe(1)

    await closeDb()
  })

  it('migrates legacy memory columns without unsupported add-column constraints', async () => {
    const { getDb, closeDb } = useDuckDb()

    const instance = await getDb()
    const execute = vi.mocked(instance.value!.execute)
    const statements = execute.mock.calls.map(([statement]) => String(statement)).join('\n')

    expect(statements).toContain('review_status VARCHAR NOT NULL DEFAULT \'pending\'')
    expect(statements).toContain('ADD COLUMN IF NOT EXISTS source_context_json VARCHAR')
    expect(statements).toContain('ADD COLUMN IF NOT EXISTS review_status VARCHAR')
    expect(statements).toContain('ADD COLUMN IF NOT EXISTS spec_json VARCHAR')
    expect(statements).toContain('ADD COLUMN IF NOT EXISTS state_json VARCHAR')
    expect(statements).toContain('ADD COLUMN IF NOT EXISTS horizon VARCHAR')
    expect(statements).not.toMatch(/ADD COLUMN IF NOT EXISTS [^\n]+ NOT NULL/)
    expect(statements).toContain('SET review_status = \'approved\'')

    await closeDb()
  })

  it('should allow re-initialization after closeDb is called', async () => {
    const { getDb, closeDb, db } = useDuckDb()

    await getDb()
    const instance1 = db.value
    expect(vi.mocked(drizzle).mock.calls.length).toBe(1)

    await nextTick()
    const spy = vi.spyOn(await (instance1!.$client), 'close')
    await closeDb()
    expect(spy).toHaveBeenCalled()

    const { getDb: getDb2 } = useDuckDb()
    const instance2 = await getDb2()

    expect(instance1).not.toBe(instance2)
    expect(vi.mocked(drizzle).mock.calls.length).toBe(2)

    await closeDb()
  })

  // Single-writer contract: a follower renderer must never open the OPFS
  // database, or it strips the leader's exclusive access handle.
  it('refuses to open the database in a follower renderer window', async () => {
    vi.stubGlobal('location', new URL('http://localhost/?synced-leader=false'))
    const { getDb } = useDuckDb()

    await expect(getDb()).rejects.toThrow('read-write only in the leader window')
    expect(vi.mocked(drizzle)).not.toHaveBeenCalled()

    vi.unstubAllGlobals()
  })
})
