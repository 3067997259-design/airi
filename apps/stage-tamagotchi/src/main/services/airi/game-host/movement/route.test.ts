import { describe, expect, it } from 'vitest'

import { splitRoute } from './route'

describe('splitRoute', () => {
  it('returns no waypoints when the goal is one hop away', () => {
    expect(splitRoute({ x: 0, y: 64, z: 0 }, { x: 16, y: 64, z: 0 }, 16)).toEqual([])
  })

  it('splits a straight line into hops of at most maxHop', () => {
    expect(splitRoute({ x: 0, y: 64, z: 0 }, { x: 48, y: 64, z: 0 }, 16)).toEqual([
      { x: 16, y: 64, z: 0 },
      { x: 32, y: 64, z: 0 },
    ])
  })

  it('splits a diagonal along the straight line', () => {
    expect(splitRoute({ x: 0, y: 64, z: 0 }, { x: 24, y: 64, z: 24 }, 16)).toEqual([
      { x: 11, y: 64, z: 11 },
      { x: 23, y: 64, z: 23 },
    ])
  })

  it('follows the vertical change with horizontal progress', () => {
    expect(splitRoute({ x: 0, y: 64, z: 0 }, { x: 30, y: 70, z: 0 }, 16)).toEqual([
      { x: 16, y: 67, z: 0 },
    ])
  })
})
