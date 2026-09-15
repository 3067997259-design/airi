/**
 * Versioned blueprint diffs (RS-4 §5).
 *
 * Repairs are never written into the original blueprint. Each accepted repair
 * becomes a diff that records the position, the before/after state, the reason,
 * the observation evidence, the version it applies to and the retest result.
 * A later structural goal is the original blueprint plus its accepted diffs;
 * the original file and record stay available.
 *
 * Diff positions are blueprint-relative, the same frame as
 * {@link BlueprintBlock}, so a diff re-applies to any placement or orientation.
 */
import type { BlueprintBlockState, BlueprintRecord } from './blueprint'
import type { Orientation, Vec3 } from './geometry'

import { createBlueprintRecord } from './blueprint'
import { addVec3, inverseOrientation, rotateVec3, subtractVec3, vecKey } from './geometry'

/**
 * Converts a world position into the blueprint-relative frame.
 *
 * Repairs are observed in the world but stored against the blueprint, so this
 * is the inverse of the placement transform: `world = anchor + rotate(local)`.
 *
 * @example
 * worldToBlueprintPosition({ x: 9, y: 1, z: 6 }, { x: 0, y: 0, z: 0 }, 0)
 * // => { x: 9, y: 1, z: 6 }
 */
export function worldToBlueprintPosition(world: Vec3, anchor: Vec3, orientation: Orientation): Vec3 {
  return rotateVec3(subtractVec3(world, anchor), inverseOrientation(orientation))
}

/** One block replaced by a repair. `to` air removes the block. */
export interface BlockChange {
  position: Vec3
  from: string
  to: string
  fromProperties?: Record<string, string>
  toProperties?: Record<string, string>
}

/** A repair stored as a diff against one blueprint version. */
export interface BlueprintDiff {
  /** Version this diff produces once accepted. */
  version: number
  /** Content digest of the blueprint the diff was authored against. */
  baseContentDigest: string
  changes: BlockChange[]
  reason: string
  /** Observation evidence that motivated the change. */
  evidence: string[]
  /** Exact blueprint version the change applies to. */
  appliesTo: { contentDigest: string, version: number }
  retestResult: 'passed' | 'failed' | 'not-run'
  acceptedAt?: number
}

export interface BlueprintDiffInput {
  version: number
  baseContentDigest: string
  changes: BlockChange[]
  reason: string
  evidence?: string[]
  appliesTo: { contentDigest: string, version: number }
  retestResult?: 'passed' | 'failed' | 'not-run'
  acceptedAt?: number
}

/** Builds a diff value; acceptance is a separate, explicit step. */
export function createBlueprintDiff(input: BlueprintDiffInput): BlueprintDiff {
  return {
    version: input.version,
    baseContentDigest: input.baseContentDigest,
    changes: input.changes,
    reason: input.reason,
    evidence: input.evidence ?? [],
    appliesTo: input.appliesTo,
    retestResult: input.retestResult ?? 'not-run',
    ...(input.acceptedAt !== undefined ? { acceptedAt: input.acceptedAt } : {}),
  }
}

const AIR_IDS = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air', ''])

/** True when a diff removes the block instead of replacing it. */
export function isRemoval(change: BlockChange): boolean {
  return AIR_IDS.has(change.to)
}

function localBlockState(srOrigin: Vec3, position: Vec3, blockId: string, properties?: Record<string, string>): BlueprintBlockState {
  return {
    x: position.x - srOrigin.x,
    y: position.y - srOrigin.y,
    z: position.z - srOrigin.z,
    blockId,
    ...(properties ? { properties } : {}),
  }
}

/**
 * Applies changes and returns a new record with a new digest and version.
 *
 * The input record is not mutated. A removal deletes the block; a replacement
 * overwrites it; a change whose position had no block is inserted into the
 * first subregion.
 */
export function applyChanges(record: BlueprintRecord, changes: readonly BlockChange[], version: number): BlueprintRecord {
  const subregions = record.subregions.map(subregion => ({ ...subregion, blocks: [...subregion.blocks] }))
  for (const change of changes) {
    let found = false
    for (const subregion of subregions) {
      for (let index = 0; index < subregion.blocks.length; index++) {
        const absolute = addVec3(subregion.origin, subregion.blocks[index])
        if (vecKey(absolute) !== vecKey(change.position))
          continue
        if (isRemoval(change)) {
          subregion.blocks.splice(index, 1)
        }
        else {
          subregion.blocks[index] = localBlockState(subregion.origin, change.position, change.to, change.toProperties)
        }
        found = true
        break
      }
      if (found)
        break
    }
    if (!found && !isRemoval(change)) {
      const target = subregions[0]
      target.blocks.push(localBlockState(target.origin, change.position, change.to, change.toProperties))
    }
  }
  return createBlueprintRecord({
    file: record.file,
    version,
    relativeOrigin: record.relativeOrigin,
    subregions,
    accessPoints: record.accessPoints,
    digDepth: record.digDepth,
    outerLayer: record.outerLayer,
  })
}

/**
 * Builds the structural goal: original blueprint plus accepted diffs.
 *
 * Only diffs whose retest passed are applied, ordered by version. The original
 * record is returned unchanged when no diff is accepted.
 */
export function buildLayeredBlueprint(original: BlueprintRecord, diffs: readonly BlueprintDiff[]): BlueprintRecord {
  const accepted = diffs.filter(diff => diff.retestResult === 'passed').sort((left, right) => left.version - right.version)
  if (accepted.length === 0)
    return original
  const changes = accepted.flatMap(diff => diff.changes)
  return applyChanges(original, changes, original.version + accepted.length)
}
