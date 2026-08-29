import type { DuckDBWasmDrizzleDatabase } from '@proj-airi/drizzle-duckdb-wasm'

import { DBStorageType, drizzle, DuckDBAccessMode } from '@proj-airi/drizzle-duckdb-wasm'
import { getImportUrlBundles } from '@proj-airi/drizzle-duckdb-wasm/bundles/import-url-browser'
import { Mutex } from 'async-mutex'
import { shallowRef } from 'vue'

const db = shallowRef<DuckDBWasmDrizzleDatabase | null>(null)
const mutex = new Mutex()
const MEMORY_DATABASE_PATH = 'airi-memory.duckdb'

export function useDuckDb() {
  const closeDb = () => mutex.runExclusive(async () => {
    if (!db.value)
      return // only close existing instance
    try {
      await (await db.value.$client).close()
    }
    catch (e) {
      console.error(`Error closing DuckDB: ${e}. Reference to the worker will be dropped regardless, but the cleanup may be incomplete.`)
    }
    db.value = null
  })

  const getDb = () =>
    mutex.runExclusive(async () => {
      if (db.value)
        return db
      let dbInstance
      try {
        // Omitting storage creates an in-memory database. OPFS keeps memory
        // fragments available after the renderer reloads or the app closes.
        dbInstance = drizzle({
          connection: {
            bundles: getImportUrlBundles(),
            storage: {
              type: DBStorageType.ORIGIN_PRIVATE_FS,
              path: MEMORY_DATABASE_PATH,
              accessMode: DuckDBAccessMode.READ_WRITE,
            },
          },
        })
        await dbInstance.execute(`
          CREATE TABLE IF NOT EXISTS memory_fragments (
            id VARCHAR PRIMARY KEY,
            content VARCHAR NOT NULL,
            memory_type VARCHAR NOT NULL,
            category VARCHAR NOT NULL,
            importance INTEGER NOT NULL DEFAULT 5,
            emotional_impact INTEGER NOT NULL DEFAULT 0,
            valence DOUBLE NOT NULL DEFAULT 0,
            arousal DOUBLE NOT NULL DEFAULT 0,
            half_life_hours DOUBLE NOT NULL DEFAULT 24,
            session_ids_json VARCHAR NOT NULL DEFAULT '[]',
            trigger_pattern VARCHAR,
            last_intruded_at BIGINT,
            created_at BIGINT NOT NULL,
            last_accessed BIGINT NOT NULL,
            access_count INTEGER NOT NULL DEFAULT 1,
            content_vector_768 FLOAT[768],
            source_context_json VARCHAR NOT NULL DEFAULT '{}',
            review_status VARCHAR NOT NULL DEFAULT 'pending',
            deleted_at BIGINT
          )
        `)
        await dbInstance.execute(`
          ALTER TABLE memory_fragments
          ADD COLUMN IF NOT EXISTS source_context_json VARCHAR
        `)
        await dbInstance.execute(`
          UPDATE memory_fragments
          SET source_context_json = '{}'
          WHERE source_context_json IS NULL
        `)
        await dbInstance.execute(`
          ALTER TABLE memory_fragments
          ADD COLUMN IF NOT EXISTS review_status VARCHAR
        `)
        // Existing rows predate the review gate and remain approved. New
        // repository inserts use pending when a caller omits status. DuckDB
        // cannot add a constrained column, so the migration backfills it.
        await dbInstance.execute(`
          UPDATE memory_fragments
          SET review_status = 'approved'
          WHERE review_status IS NULL
        `)
        await dbInstance.execute(`
          CREATE TABLE IF NOT EXISTS memory_tags (
            id VARCHAR PRIMARY KEY,
            memory_id VARCHAR NOT NULL,
            tag VARCHAR NOT NULL,
            created_at BIGINT NOT NULL,
            deleted_at BIGINT
          )
        `)
        await dbInstance.execute(`
          CREATE TABLE IF NOT EXISTS memory_episodic (
            id VARCHAR PRIMARY KEY,
            memory_id VARCHAR NOT NULL,
            event_type VARCHAR NOT NULL,
            participants VARCHAR NOT NULL DEFAULT '[]',
            location VARCHAR NOT NULL DEFAULT '',
            created_at BIGINT NOT NULL,
            deleted_at BIGINT
          )
        `)
        await dbInstance.execute(`
          CREATE TABLE IF NOT EXISTS memory_long_term_goals (
            id VARCHAR PRIMARY KEY,
            title VARCHAR NOT NULL,
            description VARCHAR NOT NULL,
            priority INTEGER NOT NULL DEFAULT 5,
            progress INTEGER NOT NULL DEFAULT 0,
            deadline BIGINT,
            status VARCHAR NOT NULL DEFAULT 'planned',
            parent_goal_id VARCHAR,
            category VARCHAR NOT NULL DEFAULT 'personal',
            created_at BIGINT NOT NULL,
            updated_at BIGINT NOT NULL,
            deleted_at BIGINT
          )
        `)
        await dbInstance.execute(`
          CREATE TABLE IF NOT EXISTS memory_short_term_ideas (
            id VARCHAR PRIMARY KEY,
            content VARCHAR NOT NULL,
            source_type VARCHAR NOT NULL DEFAULT 'dream',
            source_id VARCHAR,
            status VARCHAR NOT NULL DEFAULT 'new',
            excitement INTEGER NOT NULL DEFAULT 5,
            created_at BIGINT NOT NULL,
            updated_at BIGINT NOT NULL,
            content_vector_768 FLOAT[768],
            deleted_at BIGINT
          )
        `)
        db.value = dbInstance
        return db
      }
      catch (error) {
        console.error(`Failed to init DuckDB ${error}, attempting to close it.`)
        await (await (dbInstance?.$client))?.close()
        throw error
      }
    })

  return {
    db,
    getDb,
    closeDb,
  }
}
