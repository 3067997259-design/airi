import { describe, expect, it, vi } from 'vitest'

import { InFlightCallRegistry } from './inflight'

describe('inFlightCallRegistry', () => {
  it('tracks calls by request and owner, and settles them independently', () => {
    const registry = new InFlightCallRegistry()
    const first = registry.register('req-1', 'ext-a')
    const second = registry.register('req-2', 'ext-a')
    const third = registry.register('req-3', 'ext-b')
    expect(registry.size).toBe(3)

    registry.settle('req-2')
    expect(registry.size).toBe(2)
    expect(second.signal.aborted).toBe(false)

    // Unknown ids are a no-op (a late settle after an owner abort).
    registry.settle('req-2')
    expect(registry.size).toBe(2)
    expect(first.signal.aborted).toBe(false)
    expect(third.signal.aborted).toBe(false)
  })

  it('aborts every call of one extension in bounded time and leaves others alone', () => {
    const registry = new InFlightCallRegistry()
    const owned = registry.register('req-owned', 'ext-a')
    const other = registry.register('req-other', 'ext-b')
    const onAbort = vi.fn()
    owned.signal.addEventListener('abort', onAbort, { once: true })

    expect(registry.abortByOwner('ext-a', 'extension unloaded')).toBe(1)

    expect(onAbort).toHaveBeenCalledTimes(1)
    expect(owned.signal.aborted).toBe(true)
    expect(other.signal.aborted).toBe(false)
    // A second abort for the same owner is a no-op.
    expect(registry.abortByOwner('ext-a', 'extension unloaded')).toBe(1)
  })

  it('aborts everything on shutdown', () => {
    const registry = new InFlightCallRegistry()
    const first = registry.register('req-1', 'ext-a')
    const second = registry.register('req-2', 'ext-b')

    expect(registry.abortAll('plugin host disposed')).toBe(2)

    expect(first.signal.aborted).toBe(true)
    expect(second.signal.aborted).toBe(true)
  })
})
