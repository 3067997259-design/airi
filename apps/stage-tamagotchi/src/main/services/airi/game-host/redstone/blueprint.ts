/**
 * Blueprint record and material requirements (RS-1 §3).
 *
 * A blueprint keeps the original file identity and a content digest of its
 * parsed structure. Repairs are never written back into this record; they live
 * as separate diffs (see `repair.ts` and `diff.ts`). The record is a pure value:
 * no IO, no Litematica classes, so siting, projection and verification share one
 * definition offline.
 *
 * Subregion blocks are stored relative to the subregion's own origin. The
 * absolute blueprint-relative position is `subregion.origin + block`, and the
 * relative origin of the whole blueprint is the frame those positions use. The
 * origin is not necessarily the lower-left corner, so callers must derive the
 * bounding box from {@link blueprintBlocks} instead of assuming `0,0,0`.
 */
import type { Bounds, Face, Orientation, Vec3 } from './geometry'

import { addVec3, boundsOfPoints, rotateAxis, rotateFace, rotateVec3, vecKey } from './geometry'

/** Block state stored in a subregion, relative to that subregion's origin. */
export interface BlueprintBlockState {
  x: number
  y: number
  z: number
  /** Full block id, e.g. `minecraft:repeater`. */
  blockId: string
  /** Static block properties; runtime properties stay in the world. */
  properties?: Record<string, string>
}

/**
 * A named region of a blueprint.
 *
 * `origin` is the offset of the subregion from the blueprint's relative origin.
 * A blueprint with one subregion at a non-zero origin is how an origin that is
 * not the structure corner appears; the bounding box must include this offset.
 */
export interface BlueprintSubregion {
  name: string
  origin: Vec3
  blocks: BlueprintBlockState[]
}

/** One named access point the placement must keep usable. */
export interface BlueprintAccessPoint {
  name: string
  /** What the point is used for; the siting check is the same for all kinds. */
  kind: 'entrance' | 'chest' | 'maintenance'
  /** Position relative to the blueprint origin. */
  x: number
  y: number
  z: number
  /** Face that must stay reachable from outside the structure. */
  outward: Face
}

/** Identity of the original blueprint file, before parsing. */
export interface BlueprintFileIdentity {
  fileName: string
  sizeBytes?: number
  /** Digest of the raw file bytes or source text as it was read. */
  digest: string
}

/** Immutable blueprint record. */
export interface BlueprintRecord {
  file: BlueprintFileIdentity
  /** Digest of the parsed structure (subregions, origin, access points). */
  contentDigest: string
  /** Version label. Starts at 1; a repair-derived blueprint gets a new one. */
  version: number
  /** Relative origin of the blueprint frame; the origin can be anywhere. */
  relativeOrigin: Vec3
  subregions: BlueprintSubregion[]
  accessPoints: BlueprintAccessPoint[]
  /**
   * Layers that must be dug below the placement floor to seat the structure
   * (for example a sunken water channel). Zero means the structure sits on the
   * floor.
   */
  digDepth: number
  /**
   * Blocks that form the outer enclosure. Construction places them last so the
   * inside stays reachable while components are installed.
   */
  outerLayer: Vec3[]
}

/** Absolute blueprint-relative block, with the subregion offset already applied. */
export interface BlueprintBlock extends BlueprintBlockState {
  /** Index of the owning subregion. */
  subregionIndex: number
}

/** One required material, aggregated across subregions. */
export interface BlueprintMaterialRequirement {
  itemId: string
  count: number
  /**
   * True when the item is recovered rather than consumed (a water/lava bucket).
   * The requirement still needs the item present, but it is not spent.
   */
  reusable: boolean
}

/** Raised when a blueprint is malformed (duplicate cells, empty structure). */
export class BlueprintValidationError extends Error {
  readonly detail: string

  constructor(detail: string) {
    super(`Blueprint is invalid: ${detail}`)
    this.name = 'BlueprintValidationError'
    this.detail = detail
  }
}

/** Input accepted by {@link createBlueprintRecord}; the digest is computed. */
export interface BlueprintInput {
  file: BlueprintFileIdentity
  version?: number
  relativeOrigin?: Vec3
  subregions: BlueprintSubregion[]
  accessPoints?: BlueprintAccessPoint[]
  digDepth?: number
  outerLayer?: Vec3[]
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object')
    return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value))
    return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}

function fnv1a(text: string): string {
  let hash = 0x811C9DC5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * Stable, sorted-key digest of a value.
 *
 * @example
 * stableDigest({ b: 1, a: 2 }) === stableDigest({ a: 2, b: 1 })
 * // => true
 */
export function stableDigest(value: unknown): string {
  return fnv1a(stableStringify(value))
}

/**
 * Maps one placed block id to the item a player must hold to build it.
 *
 * Redstone dust differs from the redstone block, and a water source needs a
 * bucket rather than a placeable block. Unknown blocks fall back to their own
 * id so a modded block is reported honestly instead of being guessed.
 *
 * @example
 * itemIdForBlock('minecraft:redstone_wire')
 * // => { itemId: 'minecraft:redstone', reusable: false }
 * itemIdForBlock('minecraft:water')
 * // => { itemId: 'minecraft:water_bucket', reusable: true }
 */
export function itemIdForBlock(blockId: string): { itemId: string, reusable: boolean } {
  const normalized = blockId.includes(':') ? blockId.slice(blockId.indexOf(':') + 1) : blockId
  switch (normalized) {
    case 'redstone_wire':
    case 'tripwire':
      return { itemId: 'minecraft:redstone', reusable: false }
    case 'water':
    case 'flowing_water':
      return { itemId: 'minecraft:water_bucket', reusable: true }
    case 'lava':
    case 'flowing_lava':
      return { itemId: 'minecraft:lava_bucket', reusable: true }
    case 'wall_torch':
      return { itemId: 'minecraft:torch', reusable: false }
    case 'redstone_wall_torch':
      return { itemId: 'minecraft:redstone_torch', reusable: false }
    case 'soul_wall_torch':
      return { itemId: 'minecraft:soul_torch', reusable: false }
    default:
      return { itemId: blockId, reusable: false }
  }
}

/** Validates subregion origins and uniqueness of absolute block positions. */
function assertSubregionsValid(subregions: readonly BlueprintSubregion[]): void {
  const seen = new Set<string>()
  for (const subregion of subregions) {
    for (const block of subregion.blocks) {
      if (!Number.isInteger(block.x) || !Number.isInteger(block.y) || !Number.isInteger(block.z))
        throw new BlueprintValidationError(`subregion "${subregion.name}" has a non-integer block position`)
      if (!block.blockId)
        throw new BlueprintValidationError(`subregion "${subregion.name}" has a block with an empty id`)
      const key = vecKey(addVec3(subregion.origin, block))
      if (seen.has(key))
        throw new BlueprintValidationError(`two subregions place a block at ${key}`)
      seen.add(key)
    }
  }
}

/** Absolute blueprint-relative blocks of a record, subregion offsets applied. */
export function blueprintBlocks(record: BlueprintRecord): BlueprintBlock[] {
  const blocks: BlueprintBlock[] = []
  record.subregions.forEach((subregion, subregionIndex) => {
    for (const block of subregion.blocks) {
      const absolute = addVec3(subregion.origin, block)
      blocks.push({
        subregionIndex,
        x: absolute.x,
        y: absolute.y,
        z: absolute.z,
        blockId: block.blockId,
        ...(block.properties ? { properties: block.properties } : {}),
      })
    }
  })
  return blocks
}

/**
 * Absolute blocks rotated for one placement orientation.
 *
 * Coordinates are rotated around the blueprint origin and directional static
 * properties (`facing`, `axis`) follow the same transform. Runtime properties
 * such as `powered` are untouched: they are world facts, not blueprint design.
 *
 * @example
 * transformBlueprintBlocks(record, 90)[0].facing // north became west
 */
export function transformBlueprintBlocks(record: BlueprintRecord, orientation: Orientation): BlueprintBlock[] {
  return blueprintBlocks(record).map((block) => {
    const rotated = rotateVec3({ x: block.x, y: block.y, z: block.z }, orientation)
    const properties = block.properties
      ? Object.fromEntries(Object.entries(block.properties).map(([key, value]) => {
          if (key === 'facing')
            return [key, rotateFace(value as Face, orientation)]
          if (key === 'axis')
            return [key, rotateAxis(value, orientation)]
          return [key, value]
        }))
      : undefined
    return {
      subregionIndex: block.subregionIndex,
      x: rotated.x,
      y: rotated.y,
      z: rotated.z,
      blockId: block.blockId,
      ...(properties ? { properties } : {}),
    }
  })
}

/**
 * Inclusive bounding box of the whole structure.
 *
 * Includes subregion offsets, so an origin that is not the lower-left corner
 * yields a box whose min is not `0,0,0`. Returns undefined for an empty
 * structure; {@link createBlueprintRecord} rejects that case instead.
 */
export function blueprintBounds(record: BlueprintRecord): Bounds | undefined {
  return boundsOfPoints(blueprintBlocks(record).map(block => ({ x: block.x, y: block.y, z: block.z })))
}

/** Aggregates the material list a survival build must supply. */
export function materialRequirementsOf(record: BlueprintRecord): BlueprintMaterialRequirement[] {
  const totals = new Map<string, { count: number, reusable: boolean }>()
  for (const block of blueprintBlocks(record)) {
    const { itemId, reusable } = itemIdForBlock(block.blockId)
    const current = totals.get(itemId)
    totals.set(itemId, { count: (current?.count ?? 0) + 1, reusable: reusable || (current?.reusable ?? false) })
  }
  return [...totals.entries()]
    .map(([itemId, value]) => ({ itemId, count: value.count, reusable: value.reusable }))
    .sort((left, right) => left.itemId < right.itemId ? -1 : left.itemId > right.itemId ? 1 : 0)
}

/** Content digest input: structure only, not the version label. */
function contentOf(input: BlueprintInput): unknown {
  return {
    relativeOrigin: input.relativeOrigin ?? { x: 0, y: 0, z: 0 },
    accessPoints: input.accessPoints ?? [],
    digDepth: input.digDepth ?? 0,
    outerLayer: input.outerLayer ?? [],
    subregions: input.subregions.map(subregion => ({
      name: subregion.name,
      origin: subregion.origin,
      blocks: [...subregion.blocks].sort((left, right) => vecKey(left) < vecKey(right) ? -1 : vecKey(left) > vecKey(right) ? 1 : 0),
    })),
  }
}

/**
 * Builds an immutable blueprint record and computes its content digest.
 *
 * Throws {@link BlueprintValidationError} for duplicate cells, non-integer
 * positions and empty structures, so a malformed file is reported before any
 * siting work starts.
 */
export function createBlueprintRecord(input: BlueprintInput): BlueprintRecord {
  if (input.subregions.length === 0)
    throw new BlueprintValidationError('the blueprint has no subregions')
  const blockCount = input.subregions.reduce((total, subregion) => total + subregion.blocks.length, 0)
  if (blockCount === 0)
    throw new BlueprintValidationError('the blueprint has no blocks')
  assertSubregionsValid(input.subregions)
  const relativeOrigin = input.relativeOrigin ?? { x: 0, y: 0, z: 0 }
  return {
    file: input.file,
    contentDigest: stableDigest(contentOf(input)),
    version: input.version ?? 1,
    relativeOrigin,
    subregions: input.subregions,
    accessPoints: input.accessPoints ?? [],
    digDepth: input.digDepth ?? 0,
    outerLayer: input.outerLayer ?? [],
  }
}
