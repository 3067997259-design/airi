/**
 * Block classification for movement costs (MC-3 Phase 1).
 *
 * `mineflayer-pathfinder` derives these flags from the prismarine registry
 * block shapes. The game host only has block ids (plus blockstate properties
 * for single reads), so this module keeps a deliberately small table: unknown
 * blocks default to a solid obstacle, which makes the planner conservative
 * and the classifier easy to extend as fixtures demand.
 */
import type { BlockInfo, CollisionBox } from './types'

/** Default hardness per block id; the world read overrides it when present. */
const HARDNESS: Record<string, number> = {
  bedrock: -1,
  cobblestone: 2,
  dirt: 0.5,
  grass_block: 0.6,
  gravel: 0.6,
  lava: 100,
  leaves: 0.2,
  oak_log: 2,
  oak_planks: 2,
  sand: 0.5,
  stone: 1.5,
  stone_bricks: 1.5,
  water: 100,
}

const LIQUIDS = new Set(['water', 'flowing_water', 'lava', 'flowing_lava'])
const REPLACEABLE = new Set(['air', 'cave_air', 'void_air', ...LIQUIDS])
const SKIPPED = new Set(['fire', 'soul_fire', 'cobweb', 'web'])
const CLIMBABLE = new Set(['ladder'])
const CARPET_SUFFIXES = ['_carpet', 'moss_carpet', 'snow', 'lily_pad']
const OPENABLE_SUFFIXES = ['_door', '_fence_gate', '_trapdoor']
const PARTIAL_SUFFIXES = ['_slab', '_stairs']
const GRAVITY = new Set(['sand', 'red_sand', 'gravel', 'suspicious_sand', 'suspicious_gravel'])

export function normalizeBlockId(id: string): string {
  const colon = id.indexOf(':')
  return (colon >= 0 ? id.slice(colon + 1) : id).toLowerCase()
}

function hasSuffix(id: string, suffixes: string[]): boolean {
  return suffixes.some(suffix => id === suffix || id.endsWith(suffix))
}

export interface ClassifyInput {
  id: string
  x: number
  y: number
  z: number
  /** Blockstate properties from `world.getBlock`, e.g. `{ open: 'true' }`. */
  properties?: Record<string, string>
  hardness?: number
  /** Exact collision boxes from the source, when it knows them (CD-G2). */
  collision?: CollisionBox[]
}

/**
 * Normalizes one world read into the movement view.
 *
 * Unknown blocks become full physical obstacles so a missing table entry can
 * never open an unintended route; extend the tables above when a fixture or a
 * live route needs the block to be walkable.
 */
export function classifyBlock(input: ClassifyInput): BlockInfo {
  const id = normalizeBlockId(input.id)
  const base = {
    id,
    x: input.x,
    y: input.y,
    z: input.z,
    physical: true,
    safe: false,
    replaceable: false,
    liquid: false,
    canFall: GRAVITY.has(id),
    climbable: false,
    openable: false,
    open: false,
    height: input.y + 1,
    hardness: input.hardness ?? HARDNESS[id] ?? 1.5,
    ...(input.collision ? { collision: input.collision } : {}),
  } satisfies BlockInfo

  if (REPLACEABLE.has(id)) {
    // Water is swimmable space; lava is avoided entirely (upstream blocksToAvoid).
    return { ...base, physical: false, safe: !id.includes('lava'), replaceable: true, liquid: LIQUIDS.has(id), height: input.y }
  }
  if (SKIPPED.has(id))
    return { ...base, physical: false, safe: false }
  if (CLIMBABLE.has(id))
    return { ...base, physical: false, safe: true, climbable: true, height: input.y + 1 }
  if (hasSuffix(id, CARPET_SUFFIXES))
    return { ...base, physical: false, safe: true, height: input.y + 0.1 }
  if (hasSuffix(id, OPENABLE_SUFFIXES)) {
    const open = input.properties?.open === 'true'
    return { ...base, physical: !open, safe: open, openable: true, open, height: open ? input.y : input.y + 1 }
  }
  if (hasSuffix(id, PARTIAL_SUFFIXES))
    return { ...base, physical: false, safe: true, height: input.y + 0.5 }

  return base
}
