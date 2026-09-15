import { describe, expect, it } from 'vitest'

import {
  buildEntranceGraph,
  buildRegions,
  createMaterialBudget,
  hintCells,
  layerOf,
  localEntrance,
  planRegionSequence,
  reachableUnknownFrontier,
  regionOfCell,
  splitRoute,
} from './route'

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

  // D6: a waypoint is a horizontal hint, not a linearly interpolated Y target.
  it('keeps the start height instead of interpolating Y', () => {
    expect(splitRoute({ x: 0, y: 64, z: 0 }, { x: 30, y: 70, z: 0 }, 16)).toEqual([
      { x: 16, y: 64, z: 0 },
    ])
  })
})

describe('hintCells', () => {
  it('accepts the hint and its horizontal neighbors', () => {
    const cells = hintCells({ x: 5, y: 64, z: 5 }, 1)
    expect(cells).toHaveLength(9)
    expect(cells).toContainEqual({ x: 5, y: 64, z: 5 })
    expect(cells).toContainEqual({ x: 6, y: 64, z: 5 })
  })
})

describe('entrance graph', () => {
  it('keeps same-XZ cells on different height layers apart', () => {
    const regions = buildRegions([
      { x: 0, y: 64, z: 0 },
      { x: 1, y: 64, z: 0 },
      { x: 0, y: 72, z: 0 },
    ])
    const surface = regionOfCell({ regions: new Map(regions.map(r => [r.id, r])), entrances: [] }, { x: 0, y: 64, z: 0 })!
    const above = regions.find(region => region.cells.some(cell => cell.y === 72))!
    expect(surface.id).not.toBe(above.id)
    expect(layerOf(64)).toBe(8)
    expect(layerOf(72)).toBe(9)
  })

  it('treats underground and surface as different regions', () => {
    const regions = buildRegions([
      { x: 0, y: -8, z: 0 },
      { x: 0, y: 8, z: 0 },
    ])
    expect(regions).toHaveLength(2)
    expect(regions[0]!.layer).not.toBe(regions[1]!.layer)
  })

  it('connects adjacent regions with a boundary passage and routes between them', () => {
    // A wall between x=1 and x=2 splits one layer into two regions; the
    // boundary cell is an entrance, not a merge.
    const regions = buildRegions(
      [
        { x: 0, y: 64, z: 0 },
        { x: 1, y: 64, z: 0 },
        { x: 2, y: 64, z: 0 },
        { x: 3, y: 64, z: 0 },
      ],
      8,
      (a, b) => Math.min(a.x, b.x) !== 1 || Math.max(a.x, b.x) !== 2,
    )
    const graph = buildEntranceGraph(regions)
    const start = regionOfCell(graph, { x: 0, y: 64, z: 0 })!
    const goal = regionOfCell(graph, { x: 3, y: 64, z: 0 })!
    expect(start.id).not.toBe(goal.id)
    expect(localEntrance(graph, start.id, goal.id)).toBeDefined()
    expect(planRegionSequence(graph, start.id, goal.id)).toHaveLength(2)
  })

  it('classifies a one-block step as a slope entrance between two regions', () => {
    const regions = buildRegions([
      { x: 0, y: 64, z: 0 },
      { x: 1, y: 65, z: 0 },
    ], 8)
    expect(regions).toHaveLength(2)
    const graph = buildEntranceGraph(regions)
    expect(graph.entrances[0]!.kind).toBe('slope')
  })
})

describe('unknown frontier', () => {
  it('returns reachable cells that touch an unknown neighbor', () => {
    const reachable = [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }]
    const known = new Set(['0,0,0'])
    const frontier = reachableUnknownFrontier(reachable, cell => known.has(`${cell.x},${cell.y},${cell.z}`))
    expect(frontier.some(entry => entry.cell.x === 0 && entry.unknownNeighbor.x === 1 && entry.unknownNeighbor.z === 0)).toBe(true)
    expect(frontier.every(entry => !known.has(`${entry.unknownNeighbor.x},${entry.unknownNeighbor.y},${entry.unknownNeighbor.z}`))).toBe(true)
  })
})

describe('material budget', () => {
  it('decrements per placement and recalibrates from fresh inventory', () => {
    const budget = createMaterialBudget(4)
    budget.notePlaced()
    expect(budget.remaining).toBe(3)
    budget.notePlaced(2)
    expect(budget.remaining).toBe(1)
    budget.recalibrate(5)
    expect(budget.remaining).toBe(5)
  })

  it('does not reuse the command-start count after recalibration', () => {
    const budget = createMaterialBudget(10)
    budget.recalibrate(1)
    expect(budget.remaining).toBe(1)
    budget.notePlaced()
    expect(budget.remaining).toBe(0)
  })
})
