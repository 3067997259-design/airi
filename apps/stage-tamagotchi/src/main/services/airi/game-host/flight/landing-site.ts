/**
 * Verified landing sites for the elytra lifecycle (elytra-navigation design §7, CD-E0).
 *
 * A landing site is a claim that a glider can touch down on a support area. A
 * single non-air block, a flower, fire, a thin pillar or a partly-filled column
 * is not a support area. This module only ever makes that claim from a terrain
 * snapshot that covered the columns: a cell the snapshot lacks is unknown, and
 * unknown is never air or support.
 *
 * The module is pure. The elytra mover reads a region once, builds a snapshot
 * and asks this module to evaluate candidate patches, instead of probing one
 * column at a time.
 */
import type { SnapshotEntry } from '../movement/snapshot'
import type { Vec3 } from '../movement/types'

import { classifyBlock, normalizeBlockId } from '../movement/block-view'

/**
 * Default patch size in blocks per side.
 *
 * One column is a pillar top, not a landing area (design §7: a single non-air
 * block is not a site). Two by two keeps the read count low while rejecting the
 * single-block case.
 */
export const DEFAULT_PATCH_SIDE = 2

/** Air blocks a touch-down needs above the support so the pose box fits. */
export const LANDING_CLEARANCE = 2

/** Blocks the column scan may descend below the requested top before giving up. */
export const DEFAULT_COLUMN_SCAN_DEPTH = 24

/**
 * Block ids that never form a support, even when the classifier would call them
 * a full cube. They are recorded in the site's `hazards` so a caller can refuse
 * the site instead of silently treating a fire as ground.
 */
const HAZARD_IDS = new Set([
  'fire',
  'soul_fire',
  'magma_block',
  'campfire',
  'soul_campfire',
  'cactus',
  'sweet_berry_bush',
  'pointed_dripstone',
  'wither_rose',
  'powder_snow',
])

/** Suffixes that make a block a plant, not support. */
const PLANT_SUFFIXES = ['_flower', '_sapling', '_tulip', '_bush', '_roots', '_sprouts', '_crop', '_stem', '_fern', '_grass']

/** Flowers and crops whose ids do not carry a usable suffix. */
const PLANT_IDS = new Set([
  'dandelion',
  'poppy',
  'blue_orchid',
  'allium',
  'azure_bluet',
  'oxeye_daisy',
  'cornflower',
  'lily_of_the_valley',
  'sunflower',
  'lilac',
  'rose_bush',
  'peony',
  'torchflower',
  'pitcher_plant',
  'pink_petals',
  'spore_blossom',
  'brown_mushroom',
  'red_mushroom',
  'crimson_fungus',
  'warped_fungus',
  'wheat',
  'carrots',
  'potatoes',
  'beetroots',
  'melon_stem',
  'pumpkin_stem',
  'attached_melon_stem',
  'attached_pumpkin_stem',
  'kelp',
  'seagrass',
  'sugar_cane',
  'bamboo',
  'vine',
  'cave_vines',
  'cave_vines_plant',
  'twisting_vines',
  'weeping_vines',
  'hanging_roots',
  'glow_lichen',
  'big_dripleaf',
  'small_dripleaf',
  'azalea',
  'flowering_azalea',
  'dead_bush',
])

/** Ids the movement classifier treats as empty space. */
const AIR_IDS = new Set(['air', 'cave_air', 'void_air'])

/**
 * True when an id names empty space.
 *
 * `SnapshotEntry` carries no `air` boolean, so air is decided from the id. Any
 * other non-collidable block is treated as occupied, which keeps clearance
 * conservative.
 */
function isAirId(id: string): boolean {
  return AIR_IDS.has(normalizeBlockId(id))
}

/**
 * True when an id names a plant or a hazard that a support area must not use.
 *
 * @example
 * isHazardBlock('minecraft:fire')
 * // => true
 */
export function isHazardBlock(id: string): boolean {
  const normalized = normalizeBlockId(id)
  if (HAZARD_IDS.has(normalized) || PLANT_IDS.has(normalized))
    return true
  return PLANT_SUFFIXES.some(suffix => normalized.endsWith(suffix))
}

/** True when a classified block is a full cube a glider can stand on. */
function isFullSupport(id: string, y: number, collision: SnapshotEntry['collision']): boolean {
  const info = classifyBlock({ id, x: 0, y, z: 0, ...(collision ? { collision } : {}) })
  if (info.liquid || !info.physical)
    return false
  if (isHazardBlock(id))
    return false
  // A slab, stair or carpet classifies as non-physical, so `physical` already
  // excludes partial shapes. An explicit collision box proves the top surface
  // is a full cube only when it reaches the block top.
  if (collision && collision.length > 0)
    return collision.some(box => box.maxY >= 0.99 && box.maxX - box.minX >= 0.99 && box.maxZ - box.minZ >= 0.99)
  return info.height >= y + 0.99
}

/** Highest support and the hazards found while scanning one column. */
interface ColumnScan {
  supportY?: number
  hazards: string[]
  /** True when the column cannot be used (unknown, hazard or blocked clearance). */
  blocked?: boolean
}

/**
 * Scans one column top-down for its highest full support with clearance above.
 *
 * A cell the snapshot does not cover sets `blocked`: unknown space is not air,
 * so the column cannot be claimed. A hazard id above the support also blocks
 * the column so a fire or a flower can never be a landing site.
 */
function scanColumn(
  cells: Map<string, SnapshotEntry>,
  x: number,
  z: number,
  topY: number,
  bottomY: number,
): ColumnScan {
  const hazards: string[] = []
  for (let y = topY; y >= bottomY; y--) {
    const entry = cells.get(`${x},${y},${z}`)
    if (!entry)
      return { hazards, blocked: true }
    const id = entry.id
    // A plant at the surface is a hazard even when the column below is solid.
    if (isHazardBlock(id) && !isAirId(id)) {
      hazards.push(id)
      return { hazards, blocked: true }
    }
    if (!isFullSupport(id, y, entry.collision))
      continue
    // Verify the clearance above the support from the same snapshot.
    for (let above = y + 1; above <= y + LANDING_CLEARANCE; above++) {
      const cell = cells.get(`${x},${above},${z}`)
      if (!cell)
        return { hazards, blocked: true }
      if (!isAirId(cell.id)) {
        // A plant in the clearance makes the patch unusable; record it so the
        // caller can explain why the site was refused. Water likewise blocks a
        // normal landing (it is its own outcome, handled by the mover).
        if (isHazardBlock(cell.id))
          hazards.push(cell.id)
        return { hazards, blocked: true }
      }
    }
    return { supportY: y, hazards }
  }
  return { hazards, blocked: false }
}

/**
 * One verified landing site (elytra-navigation design §3 `LandingSite`).
 *
 * `contactY` is the block-top height the player touches down on. `entryYaw` is
 * the heading from the observer to the patch centre. `reachCost` is a coarse
 * estimate (length plus a climb penalty plus an unknown penalty) and is not a
 * proof of reachability.
 */
export interface LandingSite {
  /** Min corner of the support area, in block coordinates. */
  support: { x: number, y: number, z: number, width: number, depth: number }
  /** Touch-down block-top height; the player stands at `contactY`. */
  contactY: number
  entryYaw: number
  /** Air blocks verified above the support. */
  clearance: number
  /** `flat` when every column shares one support height. */
  roughness: 'flat' | 'uneven'
  /** Main-process ms when the read verified the site. */
  verifiedAt: number
  reachCost: number
  /** Surface block id of the min-corner column. */
  surface: string
  /** Hazards observed in or above the patch; a non-empty list should refuse it. */
  hazards: string[]
}

function yawTo(from: Vec3, to: Vec3): number {
  return Math.atan2(-(to.x - from.x), to.z - from.z) * 180 / Math.PI
}

export interface EvaluatePatchInput {
  /** Region read that covered the patch columns. */
  entries: SnapshotEntry[]
  /** Min corner of the candidate patch. */
  x: number
  z: number
  /** Observer position, used for the entry heading and the cost. */
  from: Vec3
  /** Highest block to consider (usually the player's feet). */
  topY: number
  /** How deep the column scan may go; defaults to {@link DEFAULT_COLUMN_SCAN_DEPTH}. */
  scanDepth?: number
  side?: number
  now?: number
}

/**
 * Evaluates one square patch as a landing site.
 *
 * Returns `undefined` when any column is unknown, blocked, hazardous or lacks
 * clearance, when the support heights differ by more than one block, or when the
 * patch is not within the read. Callers must not substitute a guessed
 * same-height coordinate (design §1: no unverified coordinate is a site).
 *
 * @example
 * evaluatePatch({ entries, x: 10, z: 0, from: { x: 0, y: 99, z: 0 }, topY: 99 })
 * // => LandingSite | undefined
 */
export function evaluatePatch(input: EvaluatePatchInput): LandingSite | undefined {
  const side = input.side ?? DEFAULT_PATCH_SIDE
  const scanDepth = input.scanDepth ?? DEFAULT_COLUMN_SCAN_DEPTH
  const bottomY = input.topY - scanDepth
  const cells = new Map<string, SnapshotEntry>()
  for (const entry of input.entries)
    cells.set(`${entry.x},${entry.y},${entry.z}`, entry)

  const hazards: string[] = []
  let supportY: number | undefined
  let surface = ''
  for (let dx = 0; dx < side; dx++) {
    for (let dz = 0; dz < side; dz++) {
      const column = scanColumn(cells, input.x + dx, input.z + dz, input.topY, bottomY)
      hazards.push(...column.hazards)
      if (column.blocked || column.supportY === undefined)
        return undefined
      if (supportY === undefined) {
        supportY = column.supportY
        surface = cells.get(`${input.x + dx},${column.supportY},${input.z + dz}`)?.id ?? ''
      }
      else if (Math.abs(column.supportY - supportY) > 1) {
        return undefined
      }
    }
  }
  if (supportY === undefined)
    return undefined

  const center = { x: input.x + side / 2, y: supportY + 1, z: input.z + side / 2 }
  const distance = Math.hypot(center.x - input.from.x, center.z - input.from.z)
  const climb = Math.max(0, supportY + 1 - input.from.y)
  const site: LandingSite = {
    support: { x: input.x, y: supportY, z: input.z, width: side, depth: side },
    contactY: supportY + 1,
    entryYaw: yawTo(input.from, center),
    clearance: LANDING_CLEARANCE,
    roughness: 'flat',
    verifiedAt: input.now ?? Date.now(),
    reachCost: distance + climb * 2,
    surface,
    hazards,
  }
  return site
}
