import { describe, expect, it } from 'vitest'

import { cellOf, standPointOf } from './coordinates'

describe('coordinates', () => {
  it('floors a world position to its integer cell, including negative values', () => {
    expect(cellOf({ x: 4.7, y: 64, z: -2.2 })).toEqual({ x: 4, y: 64, z: -3 })
    expect(cellOf({ x: -0.1, y: 1.9, z: 0 })).toEqual({ x: -1, y: 1, z: 0 })
  })

  it('returns the block center and the support collision top', () => {
    expect(standPointOf({ x: 1, y: 64, z: -3 })).toEqual({ x: 1.5, y: 64, z: -2.5 })
    // A slab's collision top is 0.5 above its cell; walkers must aim at it.
    expect(standPointOf({ x: 1, y: 64, z: -3 }, 64.5)).toEqual({ x: 1.5, y: 64.5, z: -2.5 })
  })
})
