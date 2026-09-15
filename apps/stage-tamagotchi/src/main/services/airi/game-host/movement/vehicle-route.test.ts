import { describe, expect, it } from 'vitest'

import {
  buildHorseRoadGraph,
  buildRailGraph,
  buildWaterwayRegions,
  DEFAULT_BOAT_PASSAGE,
  findRailStopArea,
  horseMotion,
  planRailRoute,
  railBranchDirections,
  railConnections,
  waterwayChokes,
  waterwayLandSeparated,
} from './vehicle-route'

function water(x: number, z: number, overrides: Partial<{ y: number, waterTop: number, depth: number, clearance: number }> = {}) {
  return { x, y: overrides.y ?? 62, z, waterTop: overrides.waterTop ?? 63, depth: overrides.depth ?? 3, clearance: overrides.clearance ?? 3 }
}

describe('waterway graph', () => {
  it('joins a wide, deep channel into one region', () => {
    const cells = [
      water(0, 0),
      water(1, 0),
      water(2, 0),
      water(0, 1),
      water(1, 1),
      water(2, 1),
    ]
    const regions = buildWaterwayRegions(cells, DEFAULT_BOAT_PASSAGE)
    expect(regions).toHaveLength(1)
    expect(waterwayLandSeparated(regions, { x: 0, y: 62, z: 0 }, { x: 2, y: 62, z: 1 })).toBe(false)
  })

  it('rejects a shallow, low or one-block canal a boat cannot pass', () => {
    const shallow = waterwayChokes([water(0, 0, { depth: 0 })])
    expect(shallow[0]?.reason).toBe('too_shallow')
    const low = waterwayChokes([water(0, 0, { clearance: 0 })])
    expect(low[0]?.reason).toBe('too_low')

    const narrow = waterwayChokes([water(0, 0), water(1, 0)], DEFAULT_BOAT_PASSAGE)
    expect(narrow.some(choke => choke.reason === 'too_narrow')).toBe(true)
  })

  it('keeps land-separated waters as different regions with no waterway edge', () => {
    const cells = [
      water(0, 0),
      water(1, 0),
      water(0, 1),
      water(1, 1),
      water(10, 0),
      water(11, 0),
      water(10, 1),
      water(11, 1),
    ]
    const regions = buildWaterwayRegions(cells, DEFAULT_BOAT_PASSAGE)
    expect(regions).toHaveLength(2)
    expect(waterwayLandSeparated(regions, { x: 0, y: 62, z: 0 }, { x: 10, y: 62, z: 0 })).toBe(true)
  })

  it('routes through an S-shaped reachable channel as one region', () => {
    const cells: ReturnType<typeof water>[] = []
    for (let x = 0; x <= 3; x++) {
      for (let z = 0; z <= 1; z++)
        cells.push(water(x, z))
    }
    for (let z = 1; z <= 3; z++) {
      for (let x = 3; x <= 4; x++)
        cells.push(water(x, z))
    }
    const regions = buildWaterwayRegions(cells, DEFAULT_BOAT_PASSAGE)
    expect(regions).toHaveLength(1)
    expect(waterwayLandSeparated(regions, { x: 0, y: 62, z: 0 }, { x: 4, y: 62, z: 3 })).toBe(false)
  })

  it('separates surfaces above the boat step limit', () => {
    const cells = [
      water(0, 0, { y: 62, waterTop: 63 }),
      water(1, 0, { y: 62, waterTop: 63 }),
      water(0, 1, { y: 62, waterTop: 63 }),
      water(1, 1, { y: 62, waterTop: 63 }),
      water(2, 0, { y: 70, waterTop: 71 }),
      water(3, 0, { y: 70, waterTop: 71 }),
      water(2, 1, { y: 70, waterTop: 71 }),
      water(3, 1, { y: 70, waterTop: 71 }),
    ]
    const regions = buildWaterwayRegions(cells, DEFAULT_BOAT_PASSAGE)
    expect(regions).toHaveLength(2)
  })
})

describe('horse road graph', () => {
  const profile = { width: 1.4, height: 1.6, stepHeight: 0.6, maxJumpHeight: 1.25, maxJumpGap: 4 }

  it('classifies walk, step-up, jump and fall from real heights', () => {
    const base = { x: 0, y: 64, z: 0, supportTop: 64, headroom: 3 }
    expect(horseMotion(base, { x: 1, y: 64, z: 0, supportTop: 64, headroom: 3 }, profile)).toBe('walk')
    expect(horseMotion(base, { x: 1, y: 64, z: 0, supportTop: 64.5, headroom: 3 }, profile)).toBe('step-up')
    expect(horseMotion(base, { x: 2, y: 64, z: 0, supportTop: 65, headroom: 3 }, profile)).toBe('jump')
    expect(horseMotion(base, { x: 1, y: 63, z: 0, supportTop: 63, headroom: 3 }, profile)).toBe('fall')
  })

  it('blocks a cell without enough headroom for the horse box', () => {
    const base = { x: 0, y: 64, z: 0, supportTop: 64, headroom: 3 }
    expect(horseMotion(base, { x: 1, y: 64, z: 0, supportTop: 64, headroom: 1 }, profile)).toBe('blocked')
  })

  it('builds jump edges only within the horse bounds', () => {
    const cells = [
      { x: 0, y: 64, z: 0, supportTop: 64, headroom: 3 },
      { x: 2, y: 64, z: 0, supportTop: 65, headroom: 3 },
      { x: 0, y: 64, z: 8, supportTop: 65, headroom: 3 },
    ]
    const edges = buildHorseRoadGraph(cells, profile)
    expect(edges.some(edge => edge.to.x === 2 && edge.motion === 'jump')).toBe(true)
    expect(edges.some(edge => edge.to.z === 8)).toBe(false)
  })
})

describe('rail graph', () => {
  it('maps each rail shape to its real directions and interface offsets', () => {
    expect(railConnections('north_south')).toEqual([{ dir: 'north', offset: 0 }, { dir: 'south', offset: 0 }])
    expect(railConnections('ascending_east')).toEqual([{ dir: 'east', offset: 1 }, { dir: 'west', offset: 0 }])
    expect(railConnections('south_east')).toEqual([{ dir: 'south', offset: 0 }, { dir: 'east', offset: 0 }])
  })

  it('connects reciprocal flat rails and follows an ascending slope', () => {
    const graph = buildRailGraph([
      { x: 0, y: 64, z: 0, shape: 'east_west', powered: true },
      { x: 1, y: 64, z: 0, shape: 'ascending_east', powered: false },
      { x: 2, y: 65, z: 0, shape: 'east_west', powered: false },
    ])
    expect(planRailRoute(graph, '0,64,0', '2,65,0')).toEqual(['0,64,0', '1,64,0', '2,65,0'])
  })

  it('does not connect a broken or mismatched rail', () => {
    const graph = buildRailGraph([
      { x: 0, y: 64, z: 0, shape: 'east_west', powered: false },
      // The neighbour is a north-south rail, so there is no reciprocal edge.
      { x: 1, y: 64, z: 0, shape: 'north_south', powered: false },
    ])
    expect(graph.edges).toHaveLength(0)
    expect(planRailRoute(graph, '0,64,0', '1,64,0')).toBeUndefined()
  })

  it('follows the real branch at an intersection, not the view direction', () => {
    const graph = buildRailGraph([
      { x: 0, y: 64, z: 0, shape: 'east_west', powered: false },
      { x: 1, y: 64, z: 0, shape: 'south_west', powered: true },
      { x: 1, y: 64, z: 1, shape: 'north_south', powered: false },
    ])
    const branches = railBranchDirections(graph, '1,64,0')
    expect(branches.map(edge => edge.dir).sort()).toEqual(['south', 'west'])
    // The corner cannot reach the east side: the shape only connects south/west.
    expect(planRailRoute(graph, '0,64,0', '1,64,0')).toEqual(['0,64,0', '1,64,0'])
  })

  it('routes around a curved corner using the real shapes', () => {
    const graph = buildRailGraph([
      { x: 0, y: 64, z: 0, shape: 'east_west', powered: false },
      { x: 1, y: 64, z: 0, shape: 'south_west', powered: false },
      { x: 1, y: 64, z: 1, shape: 'north_south', powered: false },
      { x: 1, y: 64, z: 2, shape: 'north_south', powered: false },
    ])
    expect(planRailRoute(graph, '0,64,0', '1,64,2')).toEqual(['0,64,0', '1,64,0', '1,64,1', '1,64,2'])
  })

  it('finds a flat stop area near the goal', () => {
    const graph = buildRailGraph([
      { x: 0, y: 64, z: 0, shape: 'east_west', powered: true },
      { x: 1, y: 64, z: 0, shape: 'east_west', powered: false },
    ])
    expect(findRailStopArea(graph, '1,64,0')).toContain('0,64,0')
  })
})
