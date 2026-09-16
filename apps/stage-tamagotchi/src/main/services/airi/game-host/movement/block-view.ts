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
/**
 * Walkable partial blocks the player steps onto without an action.
 *
 * A bed's collision box is 0.5625 high, below the 0.6 vanilla step height, so
 * a planned walk may cross it like a slab. Without this class the planner
 * treats every bed as a full obstacle and detours around open ground.
 */
const WALKABLE_PARTIAL_SUFFIXES = ['_bed']
/**
 * Non-colliding plants, for reads without shape data.
 *
 * Vanilla plants have no collision box, so the player walks through them. The
 * live region read sends exact shapes and the shape branch above handles them;
 * this list keeps a shape-less bridge from turning a grass tuft into a wall.
 */
const PLANT_SUFFIXES = ['_grass', '_fern', '_sapling', '_tulip', '_bush', '_flower']
const PLANT_IDS = new Set([
  'allium',
  'azure_bluet',
  'beetroots',
  'blue_orchid',
  'carrots',
  'cornflower',
  'dandelion',
  'dead_bush',
  'lily_of_the_valley',
  'lilac',
  'melon_stem',
  'oxeye_daisy',
  'peony',
  'pitcher_plant',
  'poppy',
  'potatoes',
  'pumpkin_stem',
  'rose_bush',
  'sugar_cane',
  'sunflower',
  'sweet_berry_bush',
  'torchflower',
  'wheat',
])
const GRAVITY = new Set(['sand', 'red_sand', 'gravel', 'suspicious_sand', 'suspicious_gravel'])

/**
 * Tallest shape top a planned walk steps over without a jump, in block heights.
 *
 * This is the vanilla step height. A shape above it needs a jump, so it keeps
 * the conservative obstacle class instead of becoming a walkable partial.
 */
const MAX_WALKABLE_TOP = 0.6

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
  if (hasSuffix(id, WALKABLE_PARTIAL_SUFFIXES))
    return { ...base, physical: false, safe: true, height: input.y + 0.5625 }
  if (hasSuffix(id, PARTIAL_SUFFIXES))
    return { ...base, physical: false, safe: true, height: input.y + 0.5 }
  if (PLANT_IDS.has(id) || hasSuffix(id, PLANT_SUFFIXES))
    return { ...base, physical: false, safe: true, replaceable: true, height: input.y }

  // A thin top from the source's own shapes is walkable: pressure plates
  // (1/16), exact snow-layer heights, and any modded thin block. The player
  // steps over anything at or below the 0.6 vanilla step height, so the route
  // graph must use the real top instead of the full-block default. Placed after
  // the id classes so tuned approximations stay: a stair's shape union tops out
  // at 1.0, which is exactly why `_stairs` is 0.5 above. A source that sends no
  // shapes keeps the conservative default below.
  if (input.collision && input.collision.length > 0) {
    const top = Math.max(...input.collision.map(box => box.maxY))
    if (top > 1e-6 && top <= MAX_WALKABLE_TOP)
      return { ...base, physical: false, safe: true, height: input.y + top }
  }

  // An empty shape list from the source is trusted over the id tables: the
  // block does not collide, so the cell is walkable space and the surface stays
  // at the cell floor. Without this the id fallback made every unlisted plant a
  // full obstacle, which raised the walk surface by a block and made the
  // planner order an impossible 2-block jump over plain walkable ground (live
  // hill run: hopping under a grass tuft at (53,98,-66)). Any non-empty shape
  // keeps the conservative rules above or the obstacle default: an unknown
  // partial block must not open a route.
  if (input.collision && input.collision.length === 0)
    return { ...base, physical: false, safe: true, replaceable: true, height: input.y }

  return base
}
