/**
 * A* planner over the ported Movements generator (MC-3 Phase 1; label search
 * CD-G3 D5).
 *
 * The search is intentionally pure: it reads a `BlockSource` snapshot and
 * returns the successor chain with the break/place/use actions the executor
 * must perform. `mineflayer-pathfinder`'s async scheduling, dynamic replan and
 * execution live outside this module.
 *
 * Each cell keeps a list of non-dominated labels instead of one record. A label
 * has an immutable id and an immutable parent id, so evicting a label never
 * rewrites a descendant's parent chain. A label is dominated when another label
 * to the same cell is both cheaper and no poorer in scaffolding (review R3).
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
  /** Maximum live labels across all cells; exceeding it fails honestly. */
  maxLabels?: number
  maxCost?: number
  timeoutMs?: number
  /** Missing blocks fail with `no_chunk` unless the caller stubs them. */
  onMissingBlock?: 'fail' | 'stub'
}

/**
 * One search label: an immutable identity with an immutable parent pointer.
 *
 * Labels are never mutated after creation except for the `evicted` and
 * `expanded` markers. Because the parent is referenced by id and the label
 * stays in {@link SearchState.labels}, eviction from a cell list cannot corrupt
 * a descendant's path.
 */
export interface SearchLabel {
  id: number
  parentId?: number
  cell: Vec3
  node: MovementNode
  g: number
  remainingPlaceables: number
  evicted: boolean
  expanded: boolean
}

const DEFAULT_MAX_NODES = 20_000
const DEFAULT_MAX_LABELS = 5_000
const DEFAULT_MAX_COST = 10_000
const DEFAULT_TIMEOUT_MS = 5_000

function keyOf(x: number, y: number, z: number): string {
  return `${x},${y},${z}`
}

/**
 * True when `candidate` is at least as good as `existing` on both axes.
 *
 * Cheaper alone is not enough: a material-poor label must not shadow a richer
 * route to the same cell (review R3).
 *
 * @example
 * labelDominates({ g: 2, remainingPlaceables: 3 }, { g: 2, remainingPlaceables: 3 })
 * // => true
 */
export function labelDominates(
  candidate: { g: number, remainingPlaceables: number },
  existing: { g: number, remainingPlaceables: number },
): boolean {
  return candidate.g <= existing.g && candidate.remainingPlaceables >= existing.remainingPlaceables
}

/** Binary min-heap keyed by f-score; stale entries are skipped on pop. */
class MinHeap {
  private readonly items: Array<{ id: number, f: number }> = []

  get size(): number {
    return this.items.length
  }

  push(id: number, f: number): void {
    this.items.push({ id, f })
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

  pop(): { id: number, f: number } | undefined {
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
  // Octile distance: the cost of walking there unobstructed. It is admissible
  // while the cheapest movement primitive is one cardinal step (dig/place add
  // cost, parkour must be disabled for the guarantee to hold).
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

function reconstruct(labels: Map<number, SearchLabel>, goalId: number): PathStep[] {
  const chain: SearchLabel[] = []
  let id: number | undefined = goalId
  while (id !== undefined) {
    const label = labels.get(id)
    if (!label)
      break
    chain.push(label)
    id = label.parentId
  }
  chain.reverse()
  const steps: PathStep[] = []
  for (let index = 1; index < chain.length; index++) {
    const previous = chain[index - 1]!
    const current = chain[index]!
    steps.push({ ...current.node, from: { x: previous.cell.x, y: previous.cell.y, z: previous.cell.z } })
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
    maxLabels = DEFAULT_MAX_LABELS,
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

  const goals = goalCells && goalCells.length > 0 ? goalCells : [goal]
  const goalKeys = new Set(goals.map(cell => keyOf(cell.x, cell.y, cell.z)))

  const labels = new Map<number, SearchLabel>()
  const cells = new Map<string, SearchLabel[]>()
  const open = new MinHeap()
  let nextId = 0

  const addLabel = (label: Omit<SearchLabel, 'evicted' | 'expanded'>): boolean => {
    const cellKey = keyOf(label.cell.x, label.cell.y, label.cell.z)
    const list = cells.get(cellKey) ?? []
    for (const existing of list) {
      if (existing.evicted)
        continue
      if (labelDominates(existing, label))
        return false
    }
    for (const existing of list) {
      if (!existing.evicted && labelDominates(label, existing))
        existing.evicted = true
    }
    const stored: SearchLabel = { ...label, evicted: false, expanded: false }
    labels.set(stored.id, stored)
    list.push(stored)
    cells.set(cellKey, list)
    return true
  }

  const startLabel: Omit<SearchLabel, 'evicted' | 'expanded'> = {
    id: nextId++,
    cell: { x: start.x, y: start.y, z: start.z },
    node: startNode,
    g: 0,
    remainingPlaceables,
  }
  addLabel(startLabel)
  open.push(startLabel.id, heuristic(startNode, goals))

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
    const current = labels.get(top.id)
    if (!current || current.evicted || current.expanded)
      continue
    current.expanded = true

    const currentKey = keyOf(current.cell.x, current.cell.y, current.cell.z)
    if (goalKeys.has(currentKey)) {
      const steps = reconstruct(labels, current.id)
      return { ok: true, steps, cost: current.g, nodes, ...(movements.missing.length > 0 ? { missing: [...movements.missing] } : {}) }
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
      if (labels.size >= maxLabels)
        return { ok: false, reason: 'search_budget', nodes }
      const label = {
        id: nextId++,
        parentId: current.id,
        cell: { x: neighbor.x, y: neighbor.y, z: neighbor.z },
        node: neighbor,
        g,
        remainingPlaceables: neighbor.remainingPlaceables,
      }
      if (!addLabel(label))
        continue
      open.push(label.id, g + heuristic(neighbor, goals))
    }
  }

  if (movements.missing.length > 0 && onMissingBlock === 'fail')
    return { ok: false, reason: 'no_chunk', nodes, missing: movements.missing[0] }
  return { ok: false, reason: 'no_path', nodes, ...(movements.missing.length > 0 ? { missing: movements.missing[0] } : {}) }
}
