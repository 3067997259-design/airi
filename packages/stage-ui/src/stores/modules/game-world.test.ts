import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { labelGameFact, useGameWorldStore } from './game-world'

describe('useGameWorldStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('keeps the latest observation and clears it on disconnect', () => {
    const store = useGameWorldStore()

    store.recordObservation({
      worldId: 'world-1',
      connectionGeneration: 1,
      connectionId: 'connection-1',
      dimension: 'minecraft:overworld',
      observedAt: 1_000,
      position: { x: 1, y: 64, z: 3 },
    })
    expect(store.latest).toMatchObject({
      worldId: 'world-1',
      connectionGeneration: 1,
      connectionId: 'connection-1',
      dimension: 'minecraft:overworld',
      observedAt: 1_000,
      position: { x: 1, y: 64, z: 3 },
    })

    store.recordObservation({ worldId: 'world-2', connectionGeneration: 2, connectionId: 'connection-2', dimension: 'minecraft:the_nether', observedAt: 2_000 })
    expect(store.latest).toMatchObject({ worldId: 'world-2', dimension: 'minecraft:the_nether' })
    expect(store.latest?.position).toBeUndefined()

    store.clear()
    expect(store.latest).toBeUndefined()
    expect(store.worldId).toBeUndefined()
  })

  it('labels other-connection facts as historical and stale same-connection ones (mc-1b)', () => {
    const now = 10_000_000
    const fact = {
      worldId: 'connection-scoped',
      connectionId: 'connection-a',
      connectionGeneration: 1,
      dimension: 'minecraft:overworld',
      observedAt: now - 60_000,
    }

    expect(labelGameFact('chest at 100 64 100', fact, { worldId: 'connection-scoped', connectionId: 'connection-b', connectionGeneration: 2 }, now))
      .toContain('Historical (world connection-scoped#connection-a, minecraft:overworld)')
    expect(labelGameFact('chest at 100 64 100', { ...fact, connectionId: 'connection-b' }, { worldId: 'connection-scoped', connectionId: 'connection-b', connectionGeneration: 2 }, now - 60_000))
      .toBe('chest at 100 64 100')
    expect(labelGameFact('chest', { ...fact, connectionId: 'connection-b', observedAt: now - 31 * 60_000 }, { worldId: 'connection-scoped', connectionId: 'connection-b', connectionGeneration: 2 }, now))
      .toContain('Needs re-observation')
    expect(labelGameFact('plain', undefined, undefined, now)).toBe('plain')
  })
})
