import { describe, expect, it } from 'vitest'

import {
  negotiateForkProtocol,
  ProtocolVersionIncompatibleError,
} from './fork-protocol'

const localV1: Parameters<typeof negotiateForkProtocol>[0]['local'] = {
  version: 1,
  extensions: [],
}

describe('negotiateForkProtocol', () => {
  it('returns mode absent when the peer omits the fork protocol', () => {
    const result = negotiateForkProtocol({
      local: localV1,
      localSupported: [1],
    })

    expect(result).toEqual({
      agreedVersion: null,
      agreedExtensions: [],
      mode: 'absent',
    })
  })

  it('agrees exactly when both sides run version 1', () => {
    const result = negotiateForkProtocol({
      local: localV1,
      localSupported: [1],
      remote: { version: 1, extensions: [] },
    })

    expect(result).toEqual({
      agreedVersion: 1,
      agreedExtensions: [],
      mode: 'exact',
    })
  })

  it('downgrades to the highest common version below the local newest', () => {
    const result = negotiateForkProtocol({
      local: { version: 2, extensions: [] },
      localSupported: [1, 2],
      remote: { version: 1, extensions: [] },
    })

    expect(result).toEqual({
      agreedVersion: 1,
      agreedExtensions: [],
      mode: 'downgraded',
    })
  })

  it('throws a typed error when the version intersection is empty', () => {
    expect(() => negotiateForkProtocol({
      local: { version: 1, extensions: [] },
      localSupported: [1],
      remote: { version: 2, extensions: [] },
    })).toThrowError(ProtocolVersionIncompatibleError)
  })

  it('carries both versions and both supported sets on the incompatibility error', () => {
    let caught: ProtocolVersionIncompatibleError | undefined
    try {
      negotiateForkProtocol({
        local: { version: 1, extensions: [] },
        localSupported: [1],
        remote: { version: 3, extensions: [] },
      })
    }
    catch (error) {
      caught = error as ProtocolVersionIncompatibleError
    }

    expect(caught).toBeInstanceOf(ProtocolVersionIncompatibleError)
    expect(caught?.localVersion).toBe(1)
    expect(caught?.remoteVersion).toBe(3)
    expect(caught?.localSupported).toEqual([1])
    expect(caught?.remoteSupported).toEqual([3])
  })

  it('keeps only the extension intersection and ignores unknown entries', () => {
    const result = negotiateForkProtocol({
      local: {
        version: 1,
        extensions: ['capability-registry', 'node-worker'],
      },
      localSupported: [1],
      remote: {
        version: 1,
        extensions: ['capability-registry', 'future-thing'],
      },
    })

    expect(result).toEqual({
      agreedVersion: 1,
      agreedExtensions: ['capability-registry'],
      mode: 'exact',
    })
  })
})
