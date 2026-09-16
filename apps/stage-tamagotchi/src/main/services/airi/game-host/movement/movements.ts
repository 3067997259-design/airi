/**
 * Movements generator ported from `mineflayer-pathfinder` (MIT).
 *
 * Upstream source: `mineflayer-pathfinder@2.4.5/lib/movements.js`. Method
 * names, cost formulas and neighbor semantics follow that file; the
 * adaptations are:
 * - blocks come from a snapshot (`BlockSource`) instead of a prismarine bot;
 * - entity intersections and exclusion areas are not modeled yet (increment 3
 *   can add them behind the same `getNumEntitiesAt` seam);
 * - dig labor approximates upstream's tool-based dig time by hardness.
 */
import type { BlockInfo, BlockSource, MoveAction, MovementConfig, MovementNode, Vec3 } from './types'

const CARDINAL_DIRECTIONS = [
  { x: -1, z: 0 },
  { x: 1, z: 0 },
  { x: 0, z: -1 },
  { x: 0, z: 1 },
]

const DIAGONAL_DIRECTIONS = [
  { x: -1, z: -1 },
  { x: -1, z: 1 },
  { x: 1, z: -1 },
  { x: 1, z: 1 },
]

/** Cost guard from upstream: reaching it means "does not move". */
const COST_BLOCK = 100

export class Movements {
  readonly missing: Vec3[] = []
  private readonly source: BlockSource
  private readonly config: MovementConfig

  constructor(source: BlockSource, config: MovementConfig) {
    this.source = source
    this.config = config
  }

  /** Upstream `getBlock`: derives one block view relative to a node. */
  getBlock(pos: Vec3 | undefined, dx: number, dy: number, dz: number): BlockInfo {
    const x = (pos?.x ?? 0) + dx
    const y = (pos?.y ?? 0) + dy
    const z = (pos?.z ?? 0) + dz
    const block = this.source.getBlock(x, y, z)
    if (!block) {
      if (this.missing.length < 64)
        this.missing.push({ x, y, z })
      return {
        id: 'unknown',
        x,
        y,
        z,
        physical: false,
        safe: false,
        replaceable: false,
        liquid: false,
        canFall: false,
        climbable: false,
        openable: false,
        open: false,
        height: y,
        hardness: 1.5,
      }
    }
    return block
  }

  /** Upstream `getNumEntitiesAt`; entities are modeled in a later increment. */
  private getNumEntitiesAt(): number {
    return 0
  }

  /** Upstream `safeToBreak`. `hardness < 0` marks unbreakable blocks. */
  private safeToBreak(block: BlockInfo): boolean {
    if (!this.config.canDig)
      return false
    if (block.hardness < 0 || block.replaceable || block.liquid)
      return false
    if (this.config.digGuard && !this.config.digGuard(block))
      return false

    if (this.config.dontCreateFlow) {
      if (this.getBlock(block, 0, 1, 0).liquid)
        return false
      if (this.getBlock(block, -1, 0, 0).liquid)
        return false
      if (this.getBlock(block, 1, 0, 0).liquid)
        return false
      if (this.getBlock(block, 0, 0, -1).liquid)
        return false
      if (this.getBlock(block, 0, 0, 1).liquid)
        return false
    }

    if (this.config.dontMineUnderFallingBlock) {
      if (this.getBlock(block, 0, 1, 0).canFall || this.getNumEntitiesAt() > 0)
        return false
    }

    return true
  }

  /**
   * Upstream `safeOrBreak`.
   *
   * Dig labor mirrors upstream's `(1 + 3 * digTime / 1000) * digCost` with a
   * hardness-based stand-in for the tool-aware dig time.
   */
  /**
   * Remaining scaffolding after this step's actions.
   *
   * Only `place` actions consume materials; a door or gate `use` action must
   * not decrement the budget (review R3: zero blocks became -1 and the `=== 0`
   * guards could not reject a negative budget).
   */
  private remainingAfter(node: MovementNode, actions: MoveAction[]): number {
    let placements = 0
    for (const action of actions) {
      if (action.kind === 'place')
        placements += 1
    }
    return node.remainingPlaceables - placements
  }

  private safeOrBreak(block: BlockInfo, toBreak: Vec3[]): number {
    let cost = this.getNumEntitiesAt() * this.config.entityCost
    if (block.safe)
      return cost
    if (!this.safeToBreak(block))
      return COST_BLOCK
    toBreak.push({ x: block.x, y: block.y, z: block.z })
    const base = (1 + 3 * block.hardness * 5) * this.config.digCost
    cost += this.config.digCostOf ? this.config.digCostOf(block, base) : base
    return cost
  }

  /**
   * True when the block blocks the current level and its top is a floor at a
   * step height or more.
   *
   * A fence, a wall, an iron bar and a full cube all qualify, so a move into
   * their cell becomes a jump onto their top. A slab, a bed, a carpet and a
   * plate do not: those are walked over at the current level.
   */
  private raisedFloor(block: BlockInfo): boolean {
    return block.physical || (block.safe && block.height - block.y > 0.6)
  }

  /**
   * True when the block can carry a player standing on its top.
   *
   * Solid cubes qualify, and so do partial tops the shape read classified as
   * safe: a fence tops out 0.5 above a full block, so the step from a fence
   * onto the next cell needs this floor to count (live combo fixture: the turn
   * pads are fence and iron-bar tops). Water is excluded: it carries nobody.
   */
  private standable(block: BlockInfo): boolean {
    return block.physical || (block.safe && !block.liquid && !block.replaceable)
  }

  private getMoveForward(node: MovementNode, dir: { x: number, z: number }, neighbors: MovementNode[]): void {
    const blockB = this.getBlock(node, dir.x, 1, dir.z)
    const blockC = this.getBlock(node, dir.x, 0, dir.z)
    const blockD = this.getBlock(node, dir.x, -1, dir.z)

    let cost = 1
    const toBreak: Vec3[] = []
    const toPlace: MoveAction[] = []

    if (!this.standable(blockD) && !blockC.liquid) {
      if (node.remainingPlaceables === 0)
        return
      if (!blockD.replaceable) {
        if (!this.safeToBreak(blockD))
          return
        toBreak.push({ x: blockD.x, y: blockD.y, z: blockD.z })
      }
      toPlace.push({ kind: 'place', x: blockD.x, y: blockD.y, z: blockD.z })
      cost += this.config.placeCost
    }

    // A door's upper half sits at head level; when the feet block is an
    // openable door its upper half is not an obstacle either.
    if (!this.config.canOpenDoors || !blockB.openable) {
      cost += this.safeOrBreak(blockB, toBreak)
      if (cost > COST_BLOCK)
        return
    }

    if (this.config.canOpenDoors && blockC.openable && !blockC.open) {
      // Fence gates and doors: use instead of breaking; the executor opens it
      // in a later step and the next replan walks through.
      toPlace.push({ kind: 'use', x: blockC.x, y: blockC.y, z: blockC.z })
    }
    else {
      cost += this.safeOrBreak(blockC, toBreak)
      if (cost > COST_BLOCK)
        return
    }

    if (this.getBlock(node, 0, 0, 0).liquid)
      cost += this.config.liquidCost

    neighbors.push({
      x: blockC.x,
      y: blockC.y,
      z: blockC.z,
      remainingPlaceables: this.remainingAfter(node, toPlace),
      cost,
      toBreak,
      toPlace,
      parkour: false,
    })
  }

  private getMoveJumpUp(node: MovementNode, dir: { x: number, z: number }, neighbors: MovementNode[]): void {
    const blockA = this.getBlock(node, 0, 2, 0)
    const blockH = this.getBlock(node, dir.x, 2, dir.z)
    const blockB = this.getBlock(node, dir.x, 1, dir.z)
    const blockC = this.getBlock(node, dir.x, 0, dir.z)

    let cost = 2
    const toBreak: Vec3[] = []
    const toPlace: MoveAction[] = []

    if (blockA.physical)
      return
    if (blockH.physical)
      return
    if (blockB.physical && !blockH.physical && !blockC.physical)
      return

    if (!this.raisedFloor(blockC)) {
      if (node.remainingPlaceables === 0)
        return
      const blockD = this.getBlock(node, dir.x, -1, dir.z)
      if (!this.standable(blockD)) {
        if (node.remainingPlaceables === 1)
          return
        if (!blockD.replaceable) {
          if (!this.safeToBreak(blockD))
            return
          toBreak.push({ x: blockD.x, y: blockD.y, z: blockD.z })
        }
        toPlace.push({ kind: 'place', x: blockD.x, y: blockD.y, z: blockD.z })
        cost += this.config.placeCost
      }

      if (!blockC.replaceable) {
        if (!this.safeToBreak(blockC))
          return
        toBreak.push({ x: blockC.x, y: blockC.y, z: blockC.z })
      }
      toPlace.push({ kind: 'place', x: blockC.x, y: blockC.y, z: blockC.z })
      cost += this.config.placeCost
    }

    // The placed block's top is a local assumption; the shared snapshot object
    // must stay unchanged (review R2), so it is never written back.
    const blockCHeight = this.raisedFloor(blockC) ? blockC.height : blockC.height + 1

    const block0 = this.getBlock(node, 0, -1, 0)
    if (blockCHeight - block0.height > 1.2)
      return

    cost += this.safeOrBreak(blockA, toBreak)
    if (cost > COST_BLOCK)
      return
    cost += this.safeOrBreak(blockH, toBreak)
    if (cost > COST_BLOCK)
      return
    cost += this.safeOrBreak(blockB, toBreak)
    if (cost > COST_BLOCK)
      return

    neighbors.push({
      x: blockB.x,
      y: blockB.y,
      z: blockB.z,
      remainingPlaceables: this.remainingAfter(node, toPlace),
      cost,
      toBreak,
      toPlace,
      parkour: false,
    })
  }

  private getMoveDiagonal(node: MovementNode, dir: { x: number, z: number }, neighbors: MovementNode[]): void {
    let cost = Math.SQRT2
    const toBreak: Vec3[] = []

    const blockC = this.getBlock(node, dir.x, 0, dir.z)
    const y = this.raisedFloor(blockC) ? 1 : 0

    const block0 = this.getBlock(node, 0, -1, 0)

    let cost1 = 0
    const toBreak1: Vec3[] = []
    const blockB1 = this.getBlock(node, 0, y + 1, dir.z)
    const blockC1 = this.getBlock(node, 0, y, dir.z)
    const blockD1 = this.getBlock(node, 0, y - 1, dir.z)
    cost1 += this.safeOrBreak(blockB1, toBreak1)
    cost1 += this.safeOrBreak(blockC1, toBreak1)
    if (blockD1.height - block0.height > 1.2)
      cost1 += this.safeOrBreak(blockD1, toBreak1)

    let cost2 = 0
    const toBreak2: Vec3[] = []
    const blockB2 = this.getBlock(node, dir.x, y + 1, 0)
    const blockC2 = this.getBlock(node, dir.x, y, 0)
    const blockD2 = this.getBlock(node, dir.x, y - 1, 0)
    cost2 += this.safeOrBreak(blockB2, toBreak2)
    cost2 += this.safeOrBreak(blockC2, toBreak2)
    if (blockD2.height - block0.height > 1.2)
      cost2 += this.safeOrBreak(blockD2, toBreak2)

    if (cost1 < cost2) {
      cost += cost1
      toBreak.push(...toBreak1)
    }
    else {
      cost += cost2
      toBreak.push(...toBreak2)
    }
    if (cost > COST_BLOCK)
      return

    cost += this.safeOrBreak(this.getBlock(node, dir.x, y, dir.z), toBreak)
    if (cost > COST_BLOCK)
      return
    cost += this.safeOrBreak(this.getBlock(node, dir.x, y + 1, dir.z), toBreak)
    if (cost > COST_BLOCK)
      return

    if (this.getBlock(node, 0, 0, 0).liquid)
      cost += this.config.liquidCost

    const blockD = this.getBlock(node, dir.x, -1, dir.z)
    if (y === 1) {
      if (blockC.height - block0.height > 1.2)
        return
      cost += this.safeOrBreak(this.getBlock(node, 0, 2, 0), toBreak)
      if (cost > COST_BLOCK)
        return
      cost += 1
      neighbors.push({
        x: blockC.x,
        y: blockC.y + 1,
        z: blockC.z,
        remainingPlaceables: node.remainingPlaceables,
        cost,
        toBreak,
        toPlace: [],
        parkour: false,
      })
      return
    }

    if (blockD.physical || blockC.liquid) {
      neighbors.push({
        x: blockC.x,
        y: blockC.y,
        z: blockC.z,
        remainingPlaceables: node.remainingPlaceables,
        cost,
        toBreak,
        toPlace: [],
        parkour: false,
      })
      return
    }

    if (this.getBlock(node, dir.x, -2, dir.z).physical || blockD.liquid) {
      if (!blockD.safe)
        return
      cost += this.getNumEntitiesAt() * this.config.entityCost
      neighbors.push({
        x: blockC.x,
        y: blockC.y - 1,
        z: blockC.z,
        remainingPlaceables: node.remainingPlaceables,
        cost,
        toBreak,
        toPlace: [],
        parkour: false,
      })
    }
  }

  private getLandingBlock(node: MovementNode, dir: { x: number, z: number }): BlockInfo | null {
    let blockLand = this.getBlock(node, dir.x, -2, dir.z)
    while (blockLand.y > this.config.minY) {
      // A landing deeper than maxDropDown can never be used, so the scan stops
      // before it walks out of the movement read region. The unbounded scan
      // reported missing blocks below the platform and failed whole legs
      // (live MC-4c follow: no_path at (81,69,-20)).
      if (node.y - blockLand.y > this.config.maxDropDown)
        return null
      if (blockLand.liquid && blockLand.safe)
        return blockLand
      if (blockLand.physical) {
        if (node.y - blockLand.y <= this.config.maxDropDown)
          return this.getBlock(blockLand, 0, 1, 0)
        return null
      }
      if (!blockLand.safe)
        return null
      blockLand = this.getBlock(blockLand, 0, -1, 0)
    }
    return null
  }

  private getMoveDropDown(node: MovementNode, dir: { x: number, z: number }, neighbors: MovementNode[]): void {
    const blockB = this.getBlock(node, dir.x, 1, dir.z)
    const blockC = this.getBlock(node, dir.x, 0, dir.z)
    const blockD = this.getBlock(node, dir.x, -1, dir.z)

    let cost = 1
    const toBreak: Vec3[] = []

    const blockLand = this.getLandingBlock(node, dir)
    if (!blockLand)
      return
    if (!this.config.infiniteLiquidDropdownDistance && (node.y - blockLand.y) > this.config.maxDropDown)
      return

    cost += this.safeOrBreak(blockB, toBreak)
    if (cost > COST_BLOCK)
      return
    cost += this.safeOrBreak(blockC, toBreak)
    if (cost > COST_BLOCK)
      return
    cost += this.safeOrBreak(blockD, toBreak)
    if (cost > COST_BLOCK)
      return

    if (blockC.liquid)
      return

    cost += this.getNumEntitiesAt() * this.config.entityCost

    neighbors.push({
      x: blockLand.x,
      y: blockLand.y,
      z: blockLand.z,
      remainingPlaceables: node.remainingPlaceables,
      cost,
      toBreak,
      toPlace: [],
      parkour: false,
    })
  }

  private getMoveDown(node: MovementNode, neighbors: MovementNode[]): void {
    const block0 = this.getBlock(node, 0, -1, 0)

    let cost = 1
    const toBreak: Vec3[] = []

    const blockLand = this.getLandingBlock(node, { x: 0, z: 0 })
    if (!blockLand)
      return

    cost += this.safeOrBreak(block0, toBreak)
    if (cost > COST_BLOCK)
      return

    if (this.getBlock(node, 0, 0, 0).liquid)
      return

    cost += this.getNumEntitiesAt() * this.config.entityCost

    neighbors.push({
      x: blockLand.x,
      y: blockLand.y,
      z: blockLand.z,
      remainingPlaceables: node.remainingPlaceables,
      cost,
      toBreak,
      toPlace: [],
      parkour: false,
    })
  }

  private getMoveUp(node: MovementNode, neighbors: MovementNode[]): void {
    const block1 = this.getBlock(node, 0, 0, 0)
    if (block1.liquid)
      return
    if (this.getNumEntitiesAt() > 0)
      return

    const block2 = this.getBlock(node, 0, 2, 0)

    let cost = 1
    const toBreak: Vec3[] = []
    const toPlace: MoveAction[] = []
    cost += this.safeOrBreak(block2, toBreak)
    if (cost > COST_BLOCK)
      return

    if (!block1.climbable) {
      if (!this.config.allow1by1towers || node.remainingPlaceables === 0)
        return
      if (!block1.replaceable) {
        if (!this.safeToBreak(block1))
          return
        toBreak.push({ x: block1.x, y: block1.y, z: block1.z })
      }

      const block0 = this.getBlock(node, 0, -1, 0)
      if (block0.physical && block0.height - node.y < -0.2)
        return

      toPlace.push({ kind: 'place', x: block1.x, y: block1.y, z: block1.z, jump: true })
      cost += this.config.placeCost
    }

    neighbors.push({
      x: node.x,
      y: node.y + 1,
      z: node.z,
      remainingPlaceables: this.remainingAfter(node, toPlace),
      cost,
      toBreak,
      toPlace,
      parkour: false,
    })
  }

  private getMoveParkourForward(node: MovementNode, dir: { x: number, z: number }, neighbors: MovementNode[]): void {
    const block0 = this.getBlock(node, 0, -1, 0)
    const block1 = this.getBlock(node, dir.x, -1, dir.z)
    if ((block1.physical && block1.height >= block0.height)
      || !this.getBlock(node, dir.x, 0, dir.z).safe
      || !this.getBlock(node, dir.x, 1, dir.z).safe) {
      return
    }
    if (this.getBlock(node, 0, 0, 0).liquid)
      return

    let cost = 1
    cost += this.getNumEntitiesAt() * this.config.entityCost

    let ceilingClear = this.getBlock(node, 0, 2, 0).safe && this.getBlock(node, dir.x, 2, dir.z).safe
    let floorCleared = !this.getBlock(node, dir.x, -2, dir.z).physical

    const maxD = this.config.allowSprinting ? 4 : 2

    for (let d = 2; d <= maxD; d++) {
      const dx = dir.x * d
      const dz = dir.z * d
      const blockA = this.getBlock(node, dx, 2, dz)
      const blockB = this.getBlock(node, dx, 1, dz)
      const blockC = this.getBlock(node, dx, 0, dz)
      const blockD = this.getBlock(node, dx, -1, dz)

      if (blockC.safe)
        cost += this.getNumEntitiesAt() * this.config.entityCost

      if (ceilingClear && blockB.safe && blockC.safe && this.standable(blockD)) {
        neighbors.push({
          x: blockC.x,
          y: blockC.y,
          z: blockC.z,
          remainingPlaceables: node.remainingPlaceables,
          cost,
          toBreak: [],
          toPlace: [],
          parkour: true,
        })
        break
      }
      else if (ceilingClear && blockB.safe && blockC.physical) {
        if (blockA.safe && d !== 4) {
          if (blockC.height - block0.height > 1.2)
            break
          neighbors.push({
            x: blockB.x,
            y: blockB.y,
            z: blockB.z,
            remainingPlaceables: node.remainingPlaceables,
            cost,
            toBreak: [],
            toPlace: [],
            parkour: true,
          })
          break
        }
      }
      else if ((ceilingClear || d === 2) && blockB.safe && blockC.safe && blockD.safe && floorCleared) {
        const blockE = this.getBlock(node, dx, -2, dz)
        if (blockE.physical) {
          neighbors.push({
            x: blockD.x,
            y: blockD.y,
            z: blockD.z,
            remainingPlaceables: node.remainingPlaceables,
            cost,
            toBreak: [],
            toPlace: [],
            parkour: true,
          })
        }
        floorCleared = floorCleared && !blockE.physical
      }
      else if (!blockB.safe || !blockC.safe) {
        break
      }

      ceilingClear = ceilingClear && blockA.safe
    }
  }

  /**
   * MC-3 extension beyond upstream: swim out onto a flush shore.
   *
   * Upstream models water exit as a jump-up that needs scaffolding; Baritone
   * swims out when the bank is at the water surface. This move lets a node
   * whose feet block is liquid reach an adjacent safe node up to two blocks
   * up whose block below is solid (the bank lip).
   */
  private getMoveSwimShore(node: MovementNode, dir: { x: number, z: number }, neighbors: MovementNode[]): void {
    const feet = this.getBlock(node, 0, 0, 0)
    if (!feet.liquid)
      return
    for (const dy of [1, 2]) {
      const target = this.getBlock(node, dir.x, dy, dir.z)
      if (!target.safe || target.liquid)
        continue
      const below = this.getBlock(node, dir.x, dy - 1, dir.z)
      if (!below.physical)
        continue
      neighbors.push({
        x: target.x,
        y: target.y,
        z: target.z,
        remainingPlaceables: node.remainingPlaceables,
        cost: 1 + this.config.liquidCost + (dy - 1) * 0.5,
        toBreak: [],
        toPlace: [],
        parkour: false,
      })
    }
  }

  /** Upstream `getNeighbors`: all successors for one node. */
  getNeighbors(node: MovementNode): MovementNode[] {
    const neighbors: MovementNode[] = []

    for (const dir of CARDINAL_DIRECTIONS) {
      this.getMoveForward(node, dir, neighbors)
      this.getMoveJumpUp(node, dir, neighbors)
      this.getMoveDropDown(node, dir, neighbors)
      this.getMoveSwimShore(node, dir, neighbors)
      if (this.config.allowParkour)
        this.getMoveParkourForward(node, dir, neighbors)
    }

    for (const dir of DIAGONAL_DIRECTIONS)
      this.getMoveDiagonal(node, dir, neighbors)

    this.getMoveDown(node, neighbors)
    this.getMoveUp(node, neighbors)

    return neighbors
  }
}
