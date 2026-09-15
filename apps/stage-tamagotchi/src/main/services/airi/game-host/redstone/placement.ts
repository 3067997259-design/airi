import type { Face, Vec3 } from './geometry'
/**
 * Precise placement intents (RS-2 §3).
 *
 * A placement is described the way a player performs it: the item to hold, the
 * support block, the clicked face, the view angle and whether to sneak. The
 * plan is derived from the design block state and the known neighbours, so a
 * directional block (observer, repeater, piston, hopper) is placed with the
 * right facing instead of an arbitrary one.
 *
 * Placement semantics differ per block family in vanilla. The facing basis
 * below is a first convention, marked with `NOTICE`: it is calibrated against a
 * real game before the survival build is trusted (that run is BLOCKED here).
 * Verification, by contrast, is exact: it compares the real observed block
 * state and the inventory after the placement.
 */
import type { ProjectionBlock } from './projection'
import type { BlockStateView, PropertyMismatch } from './state'

import { itemIdForBlock } from './blueprint'
import { FACE_STEPS, oppositeFace } from './geometry'
import { compareStaticConfiguration } from './state'

/** Neighbour block states around the target, keyed by the face they sit on. */
export type PlacementNeighbors = Partial<Record<Face, BlockStateView>>

/**
 * Blocks whose right-click opens a menu or changes them, so the placement must
 * sneak to avoid using the block instead of placing.
 */
export const SNEAK_BLOCKS: ReadonlySet<string> = new Set([
  'minecraft:chest',
  'minecraft:trapped_chest',
  'minecraft:barrel',
  'minecraft:furnace',
  'minecraft:blast_furnace',
  'minecraft:smoker',
  'minecraft:crafting_table',
  'minecraft:shulker_box',
  'minecraft:comparator',
  'minecraft:lever',
])

/**
 * Blocks whose `facing` points back at the player when placed.
 *
 * All other directional blocks are treated as facing the player's view.
 * See the module `NOTICE`.
 */
const OPPOSITE_VIEW_BLOCKS: ReadonlySet<string> = new Set([
  'minecraft:furnace',
  'minecraft:chest',
  'minecraft:trapped_chest',
  'minecraft:barrel',
])

/** Air and fluids are not a support to click. */
const NON_SUPPORT_IDS = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air', 'minecraft:water', 'minecraft:lava'])

export interface PlacementIntent {
  target: Vec3
  itemId: string
  /** Support block the use clicks; its face is {@link clickFace}. */
  support: Vec3
  /** Face of the support that touches the target cell. */
  clickFace: Face
  /** Player yaw in degrees; 0 south, 90 west, 180 north, 270 east. */
  yaw: number
  /** Player pitch in degrees; 90 looks down at a floor, -90 up at a ceiling. */
  pitch: number
  sneak: boolean
  expected: BlockStateView
}

export interface PlacementUnavailable {
  unavailable: true
  reason: 'no_support' | 'unknown_block'
}

/** True when a neighbour can be clicked as support. */
function isSupport(state: BlockStateView | undefined): boolean {
  if (!state)
    return false
  return !NON_SUPPORT_IDS.has(state.blockId)
}

/**
 * Minecraft yaw for a horizontal facing direction.
 *
 * @example
 * yawForFacing('south') // 0
 * yawForFacing('west') // 90
 */
export function yawForFacing(face: Face): number {
  switch (face) {
    case 'south':
      return 0
    case 'west':
      return 90
    case 'north':
      return 180
    case 'east':
      return 270
    default:
      return 0
  }
}

/** Inverse of {@link yawForFacing}; normalizes any angle into a cardinal face. */
export function facingFromYaw(yaw: number): Face {
  const normalized = ((yaw % 360) + 360) % 360
  if (normalized < 45 || normalized >= 315)
    return 'south'
  if (normalized < 135)
    return 'west'
  if (normalized < 225)
    return 'north'
  return 'east'
}

function supportPreference(facing: string | undefined): Face[] {
  if (facing === 'down')
    return ['up', 'north', 'south', 'east', 'west', 'down']
  return ['down', 'north', 'south', 'east', 'west', 'up']
}

/**
 * Plans one precise placement.
 *
 * Chooses the support/click face from the design's vertical facing (a piston
 * that must point down is clicked from above), then a yaw from the design's
 * horizontal facing. Returns a typed `unavailable` when no known support
 * neighbour exists, instead of guessing a click that the server would reject.
 */
export function planPlacement(input: {
  target: ProjectionBlock
  neighbors?: PlacementNeighbors
}): PlacementIntent | PlacementUnavailable {
  const { target } = input
  const facing = target.properties?.facing
  for (const face of supportPreference(facing)) {
    const state = input.neighbors?.[face]
    if (!isSupport(state))
      continue
    const step = FACE_STEPS[face]
    const support = { x: target.x + step.x, y: target.y + step.y, z: target.z + step.z }
    const clickFace = oppositeFace(face)
    const expected: BlockStateView = { blockId: target.blockId, ...(target.properties ? { properties: target.properties } : {}) }
    const { itemId } = itemIdForBlock(target.blockId)
    const pitch = clickFace === 'up' ? 90 : clickFace === 'down' ? -90 : 0
    let yaw = 0
    if (facing === 'north' || facing === 'south' || facing === 'east' || facing === 'west') {
      const basis = OPPOSITE_VIEW_BLOCKS.has(target.blockId) ? oppositeFace(facing) : facing
      yaw = yawForFacing(basis)
    }
    return {
      target: { x: target.x, y: target.y, z: target.z },
      itemId,
      support,
      clickFace,
      yaw,
      pitch,
      sneak: SNEAK_BLOCKS.has(target.blockId),
      expected,
    }
  }
  return { unavailable: true, reason: 'no_support' }
}

/** Inventory count of the placed item before and after the use. */
export interface PlacementInventoryDelta {
  itemId: string
  before: number
  after: number
}

/** Result of verifying one placement against a fresh world read. */
export interface PlacementVerification {
  placed: boolean
  stateMismatches: PropertyMismatch[]
  inventoryDelta: number
  reasons: string[]
}

/**
 * Verifies one placement: the target block state and the inventory decrease.
 *
 * The state check uses static configuration only, so a placed repeater that is
 * already powered still verifies. An inventory that did not decrease is a
 * failure when a delta was supplied.
 */
export function verifyPlacement(
  expected: BlockStateView,
  observed: BlockStateView | undefined,
  inventory?: PlacementInventoryDelta,
): PlacementVerification {
  const reasons: string[] = []
  if (!observed) {
    return { placed: false, stateMismatches: [], inventoryDelta: 0, reasons: ['not_observed'] }
  }
  const comparison = compareStaticConfiguration(expected, observed)
  const inventoryDelta = inventory ? inventory.after - inventory.before : 0
  if (inventory && inventoryDelta >= 0) {
    reasons.push('inventory_did_not_decrease')
  }
  if (!comparison.matches)
    reasons.push('state_mismatch')
  return {
    placed: comparison.matches && (!inventory || inventoryDelta < 0),
    stateMismatches: comparison.mismatches,
    inventoryDelta,
    reasons,
  }
}
