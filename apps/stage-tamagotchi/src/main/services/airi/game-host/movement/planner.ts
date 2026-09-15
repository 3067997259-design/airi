/**
 * A* planner over the ported Movements generator (MC-3 Phase 1)。
 *
 * The search is intentionally pure: it reads a `BlockSource` snapshot and
 * returns the successor chain with the break/place/use actions the executor
 * must perform. `mineflayer-pathfinder`'s async scheduling, dynamic replan and
 * execution live outside this module.
 */
import type { BlockSource, MovementConfig, MovementNode, PathStep, PlanFailure, PlanSuccess, Vec3 } from './types'

import { Movements } from './movements'

export interface PlanOptions {
  source: BlockSource
  start: Vec3
  goal: Vec3
  /**
   * Alternate goal cells. When non-empty the search accepts any of them and
   * ignores the single `goal`.
   */
  goalCells?: Vec3[]
  /** Destination cells with a recorded failure; skipped as impassable. */
  disabled?: ReadonlySet<string>
  config: MovementConfig
  /** Scaffolding blocks available for pillar/bridge moves. */
  remainingPlaceables?: number
  /** Hard bounds so a malformed region cannot hang the command. */
  maxNodes?: number
  maxCost?: number
  timeoutMs?: number
  /** Missing blocks fail with `no_chunk` unless the caller stubs them. */
  onMissingBlock?: 'fail' | 'stub'
}

interface SearchRecord {
  node: MovementNode
  g: number
  cameFrom?: string
}

const DEFAULT_MAX_NODES = 20_000
const DEFAULT_MAX_COST = 10_000
const DEFAULT_TIMEOUT_MS = 5_000

function keyOf(x: number, y: number, z: number): string {
  return `${x},${y},${z}`
}

/** Binary min-heap keyed by f-score; stale entries are skipped on pop. */
class MinHeap {
  private readonly items: Array<{ key: string, f: number }> = []

  get size(): number {
    return this.items.length
  }

  push(key: string, f: number): void {
    this.items.push({ key, f })
    let index = this.items.length - 1
    while (index > 0) {
      const parent = (index - 1) >> 1
      if (this.items[parent]!.f <= this.items[index]!.f)
        break
      const swap = this.items[parent]!
      this.items[parent] = this.items[index]!
      this.items[index] = swap
      index = parent
    }
  }

  pop(): { key: string, f: number } | undefined {
    const top = this.items[0]
    const last = this.items.pop()
    if (!top || !last)
      return top
    if (this.items.length > 0) {
      this.items[0] = last
      let index = 0
      for (;;) {
        const left = index * 2 + 1
        const right = left + 1
        let smallest = index
        if (left < this.items.length && this.items[left]!.f < this.items[smallest]!.f)
          smallest = left
        if (right < this.items.length && this.items[right]!.f < this.items[smallest]!.f)
          smallest = right
        if (smallest === index)
          break
        const swap = this.items[smallest]!
        this.items[smallest] = this.items[index]!
        this.items[index] = swap
        index = smallest
      }
    }
    return top
  }
}

function octileDistance(node: MovementNode, goal: Vec3): number {
  // Octile distance: the cost of walking there unobstructed.
  const dx = Math.abs(node.x - goal.x)
  const dy = Math.abs(node.y - goal.y)
  const dz = Math.abs(node.z - goal.z)
  const horizontal = Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz)
  return horizontal + dy
}

/** Distance to the nearest goal cell; admissible for a region goal. */
function heuristic(node: MovementNode, goals: Vec3[]): number {
  let best = Number.POSITIVE_INFINITY
  for (const goal of goals)
    best = Math.min(best, octileDistance(node, goal))
  return best
}

function reconstruct(records: Map<string, SearchRecord>, goalKey: string): PathStep[] {
  const chain: SearchRecord[] = []
  let key: string | undefined = goalKey
  while (key) {
    const record = records.get(key)
    if (!record)
      break
    chain.push(record)
    key = record.cameFrom
  }
  chain.reverse()
  const steps: PathStep[] = []
  for (let index = 1; index < chain.length; index++) {
    const previous = chain[index - 1]!
    const current = chain[index]!
    steps.push({ ...current.node, from: { x: previous.node.x, y: previous.node.y, z: previous.node.z } })
  }
  return steps
}

export function planPath(options: PlanOptions): PlanSuccess | PlanFailure {
  const {
    source,
    start,
    goal,
    goalCells,
    disabled,
    config,
    remainingPlaceables = 0,
    maxNodes = DEFAULT_MAX_NODES,
    maxCost = DEFAULT_MAX_COST,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onMissingBlock = 'fail',
  } = options

  const movements = new Movements(source, config)
  const startNode: MovementNode = {
    x: start.x,
    y: start.y,
    z: start.z,
    remainingPlaceables,
    cost: 0,
    toBreak: [],
    toPlace: [],
    parkour: false,
  }

  const startKey = keyOf(start.x, start.y, start.z)
  const goals = goalCells && goalCells.length > 0 ? goalCells : [goal]
  const goalKeys = new Set(goals.map(cell => keyOf(cell.x, cell.y, cell.z)))
  const records = new Map<string, SearchRecord>([[startKey, { node: startNode, g: 0 }]])
  const open = new MinHeap()
  open.push(startKey, heuristic(startNode, goals))

  let nodes = 0
  const deadline = Date.now() + timeoutMs

  while (open.size > 0) {
    if (++nodes > maxNodes)
      return { ok: false, reason: 'cost_limit', nodes }
    if (Date.now() > deadline)
      return { ok: false, reason: 'timeout', nodes }

    const top = open.pop()
    if (!top)
      break
    const current = records.get(top.key)
    if (!current)
      continue

    if (goalKeys.has(top.key)) {
      const steps = reconstruct(records, top.key)
      const finalG = current.g
      return { ok: true, steps, cost: finalG, nodes, ...(movements.missing.length > 0 ? { missing: [...movements.missing] } : {}) }
    }

    if (movements.missing.length > 0 && onMissingBlock === 'fail')
      return { ok: false, reason: 'no_chunk', nodes, missing: movements.missing[0] }

    for (const neighbor of movements.getNeighbors(current.node)) {
      if (movements.missing.length > 0 && onMissingBlock === 'fail')
        return { ok: false, reason: 'no_chunk', nodes, missing: movements.missing[0] }
      const neighborKey = keyOf(neighbor.x, neighbor.y, neighbor.z)
      if (disabled?.has(neighborKey))
        continue
      const g = current.g + neighbor.cost
      if (g > maxCost)
        continue
      const existing = records.get(neighborKey)
      if (existing) {
        // Dominance: a state that is both cheaper and no poorer in materials
        // cannot be improved by this candidate. A material-poor state must not
        // shadow a richer route to the same cell (review R3).
        const cheaper = existing.g <= g
        const notPoorer = existing.node.remainingPlaceables >= neighbor.remainingPlaceables
        if (cheaper && notPoorer)
          continue
      }
      records.set(neighborKey, { node: neighbor, g, cameFrom: top.key })
      open.push(neighborKey, g + heuristic(neighbor, goals))
    }
  }

  if (movements.missing.length > 0 && onMissingBlock === 'fail')
    return { ok: false, reason: 'no_chunk', nodes, missing: movements.missing[0] }
  return { ok: false, reason: 'no_path', nodes, ...(movements.missing.length > 0 ? { missing: movements.missing[0] } : {}) }
}
