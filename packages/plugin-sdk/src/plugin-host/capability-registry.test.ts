import type { CapabilityRecord } from './capability-registry'

import { describe, expect, it, vi } from 'vitest'

import { CapabilityRegistry, CapabilityTransitionError } from './capability-registry'

function announceInput(
  overrides: Partial<Omit<CapabilityRecord, 'state'>> = {},
): Omit<CapabilityRecord, 'state'> {
  return {
    capabilityId: 'cap.a',
    providerModuleId: 'provider-a',
    hostId: 'test-host',
    runtime: 'electron',
    ...overrides,
  }
}

function key(capabilityId: string, hostId = 'test-host') {
  return { capabilityId, hostId }
}

describe('capabilityRegistry', () => {
  it('replays announced, ready, degraded, and withdrawn states with monotonic revisions', () => {
    const registry = new CapabilityRegistry()

    registry.announce(announceInput({ capabilityId: 'cap.a', metadata: { source: 'announce' } }))
    expect(registry.snapshot()).toMatchObject({
      revision: 1,
      records: [
        expect.objectContaining({
          capabilityId: 'cap.a',
          state: 'announced',
          metadata: { source: 'announce' },
        }),
      ],
    })

    registry.ready(key('cap.a'), { metadata: { source: 'ready' } })
    expect(registry.snapshot()).toMatchObject({
      revision: 2,
      records: [
        expect.objectContaining({
          capabilityId: 'cap.a',
          state: 'ready',
          metadata: { source: 'ready' },
        }),
      ],
    })
    expect(registry.resolve({ allOf: ['cap.a'] }).satisfied).toBe(true)

    registry.degrade(key('cap.a'), { metadata: { reason: 'executor lost' } })
    expect(registry.snapshot()).toMatchObject({
      revision: 3,
      records: [
        expect.objectContaining({
          capabilityId: 'cap.a',
          state: 'degraded',
          metadata: { reason: 'executor lost' },
        }),
      ],
    })
    expect(registry.resolve({ allOf: ['cap.a'] }).satisfied).toBe(false)

    registry.withdraw(key('cap.a'), { metadata: { reason: 'disconnected' } })
    expect(registry.snapshot()).toMatchObject({
      revision: 4,
      records: [
        expect.objectContaining({
          capabilityId: 'cap.a',
          state: 'withdrawn',
          metadata: { reason: 'disconnected' },
        }),
      ],
    })
  })

  it('keeps a withdrawn record until an explicit re-announce overwrites it', () => {
    const registry = new CapabilityRegistry()
    registry.announce(announceInput({ capabilityId: 'cap.a' }))
    registry.ready(key('cap.a'))
    registry.withdraw(key('cap.a'))

    expect(registry.snapshot().records).toHaveLength(1)
    expect(registry.snapshot().records[0]).toMatchObject({ state: 'withdrawn' })

    registry.announce(announceInput({ capabilityId: 'cap.a', metadata: { restarted: true } }))
    expect(registry.snapshot().records[0]).toMatchObject({
      state: 'announced',
      metadata: { restarted: true },
    })
  })

  it('returns defensive copies that cannot mutate registry internals', () => {
    const registry = new CapabilityRegistry()
    registry.announce(announceInput({
      capabilityId: 'cap.a',
      metadata: { nested: { list: [1, 2] } },
    }))

    const firstSnapshot = registry.snapshot()
    firstSnapshot.records[0].state = 'withdrawn'
    firstSnapshot.records[0].metadata = { hacked: true }
    const hackedMetadata = firstSnapshot.records[0].metadata as Record<string, unknown>
    hackedMetadata.nested = null

    const returned = registry.ready(key('cap.a'), { metadata: { returned: true } })
    returned.metadata = { mutated: true }

    const after = registry.snapshot()
    expect(after.records[0]).toMatchObject({
      state: 'ready',
      metadata: { returned: true },
    })
  })

  it('does not retain caller-owned metadata references inside registry state', () => {
    const registry = new CapabilityRegistry()
    const announceMetadata = { nested: { list: [1] } }
    registry.announce(announceInput({ capabilityId: 'cap.a', metadata: announceMetadata }))

    announceMetadata.nested.list.push(2)
    const patchMetadata = { reason: 'updated' }
    registry.ready(key('cap.a'), { metadata: patchMetadata })
    patchMetadata.reason = 'mutated-after-call'

    expect(registry.snapshot().records[0]).toMatchObject({
      state: 'ready',
      metadata: { reason: 'updated' },
    })
  })

  it('throws typed errors on illegal transitions instead of ignoring them', () => {
    const registry = new CapabilityRegistry()

    expect(() => registry.ready(key('cap.never-announced'))).toThrow(CapabilityTransitionError)

    registry.announce(announceInput({ capabilityId: 'cap.a' }))
    expect(() => registry.degrade(key('cap.a'))).toThrow(CapabilityTransitionError)

    registry.ready(key('cap.a'))
    expect(() => registry.announce(announceInput({ capabilityId: 'cap.a' }))).toThrow(CapabilityTransitionError)

    registry.withdraw(key('cap.a'))
    expect(() => registry.ready(key('cap.a'))).toThrow(CapabilityTransitionError)
    expect(() => registry.degrade(key('cap.a'))).toThrow(CapabilityTransitionError)
    expect(() => registry.withdraw(key('cap.a'))).toThrow(CapabilityTransitionError)
  })

  it('resolves allOf, anyOf, and predicate requirements from the snapshot', () => {
    const registry = new CapabilityRegistry()
    registry.announce(announceInput({ capabilityId: 'cap.a', providerModuleId: 'provider-a', version: '1.0.0' }))
    registry.ready(key('cap.a'))
    registry.announce(announceInput({ capabilityId: 'cap.b', providerModuleId: 'provider-b', version: '2.0.0' }))
    registry.ready(key('cap.b'))

    const allOf = registry.resolve({ allOf: ['cap.a', 'cap.b'] })
    expect(allOf.satisfied).toBe(true)
    expect(allOf.missing).toEqual([])
    expect(allOf.matched.map(record => record.capabilityId)).toEqual(['cap.a', 'cap.b'])

    const anyOfSatisfied = registry.resolve({ anyOf: ['cap.a', 'cap.zz'] })
    expect(anyOfSatisfied.satisfied).toBe(true)
    expect(anyOfSatisfied.missing).toEqual([])
    expect(anyOfSatisfied.matched.map(record => record.capabilityId)).toEqual(['cap.a'])

    const anyOfMissing = registry.resolve({ anyOf: ['cap.zz', 'cap.yy'] })
    expect(anyOfMissing.satisfied).toBe(false)
    expect(anyOfMissing.missing).toEqual(['cap.zz', 'cap.yy'])
    expect(anyOfMissing.matched).toEqual([])

    const allOfMissing = registry.resolve({ allOf: ['cap.a', 'cap.missing'] })
    expect(allOfMissing.satisfied).toBe(false)
    expect(allOfMissing.missing).toEqual(['cap.missing'])
    expect(allOfMissing.matched.map(record => record.capabilityId)).toEqual(['cap.a'])

    const predicate = registry.resolve({ predicate: record => record.version === '2.0.0' })
    expect(predicate.satisfied).toBe(true)
    expect(predicate.matched.map(record => record.capabilityId)).toEqual(['cap.b'])

    const empty = registry.resolve({})
    expect(empty.satisfied).toBe(true)
    expect(empty.missing).toEqual([])
  })

  it('subscribes listeners only on real change with revision, record, and kind', () => {
    const registry = new CapabilityRegistry()
    const changes: Array<{ revision: number, kind: 'upsert' | 'withdrawn', state: string }> = []
    const unsubscribe = registry.subscribe((change) => {
      changes.push({ revision: change.revision, kind: change.kind, state: change.record.state })
    })

    registry.announce(announceInput({ capabilityId: 'cap.a' }))
    registry.ready(key('cap.a'))
    registry.ready(key('cap.a'))
    registry.ready(key('cap.a'), { metadata: { same: true } })
    registry.degrade(key('cap.a'), { metadata: { reason: 'unstable' } })
    registry.withdraw(key('cap.a'))

    expect(changes).toEqual([
      { revision: 1, kind: 'upsert', state: 'announced' },
      { revision: 2, kind: 'upsert', state: 'ready' },
      { revision: 3, kind: 'upsert', state: 'ready' },
      { revision: 4, kind: 'upsert', state: 'degraded' },
      { revision: 5, kind: 'withdrawn', state: 'withdrawn' },
    ])

    unsubscribe()
    registry.announce(announceInput({ capabilityId: 'cap.a' }))
    registry.ready(key('cap.a'))
    expect(changes).toHaveLength(5)
  })

  it('keeps unsubscribe idempotent', () => {
    const registry = new CapabilityRegistry()
    const listener = vi.fn()
    const unsubscribe = registry.subscribe(listener)

    unsubscribe()
    unsubscribe()

    registry.announce(announceInput({ capabilityId: 'cap.a' }))
    expect(listener).not.toHaveBeenCalled()
  })

  it('flips observer mode only after both consumer ids have announced', () => {
    const registry = new CapabilityRegistry()

    expect(registry.getConsumerState()).toEqual({ observed: [], observerMode: true })

    registry.announce(announceInput({ capabilityId: 'game.minecraft.control', providerModuleId: 'game-host' }))
    expect(registry.getConsumerState()).toEqual({ observed: ['game-host'], observerMode: true })

    registry.announce(announceInput({ capabilityId: 'skill.adapter.self-authored', providerModuleId: 'skill-adapter' }))
    expect(registry.getConsumerState()).toEqual({
      observed: ['game-host', 'skill-adapter'],
      observerMode: false,
    })
  })
})
