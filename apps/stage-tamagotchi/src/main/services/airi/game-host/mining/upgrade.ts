/**
 * Bounded tool-upgrade planning (CD-M3).
 *
 * The first version covers the wood to stone to iron pickaxe chain. A plan
 * states its budget and resolves at most one missing prerequisite per level;
 * it never recurses into an unbounded "craft a better tool first" search. The
 * actual recipe and station are still verified on the server before crafting.
 */
import type { CraftStation, ToolRecipe, UpgradeBudget, UpgradePlan, UpgradeStep } from './types'

/**
 * Traceable recipe candidates for the first upgrade chain.
 *
 * These are candidate inputs only: the server validates the recipe and station
 * before the executor crafts. Unknown recipes are never guessed from strings.
 */
export const PICKAXE_UPGRADE_RECIPES: ToolRecipe[] = [
  { itemId: 'minecraft:oak_planks', outputCount: 4, station: 'inventory', ingredients: [{ itemId: 'minecraft:oak_log', count: 1 }] },
  { itemId: 'minecraft:stick', outputCount: 4, station: 'inventory', ingredients: [{ itemId: 'minecraft:oak_planks', count: 2 }] },
  { itemId: 'minecraft:iron_ingot', outputCount: 1, station: 'furnace', ingredients: [{ itemId: 'minecraft:raw_iron', count: 1 }], fuel: ['minecraft:coal', 'minecraft:charcoal'] },
  { itemId: 'minecraft:wooden_pickaxe', outputCount: 1, station: 'crafting_table', ingredients: [{ itemId: 'minecraft:oak_planks', count: 3 }, { itemId: 'minecraft:stick', count: 2 }] },
  { itemId: 'minecraft:stone_pickaxe', outputCount: 1, station: 'crafting_table', ingredients: [{ itemId: 'minecraft:cobblestone', count: 3 }, { itemId: 'minecraft:stick', count: 2 }] },
  { itemId: 'minecraft:iron_pickaxe', outputCount: 1, station: 'crafting_table', ingredients: [{ itemId: 'minecraft:iron_ingot', count: 3 }, { itemId: 'minecraft:stick', count: 2 }] },
]

/**
 * The lowest pickaxe tier that can produce a block's drop.
 *
 * This is a candidate index, not a rule: the server's harvest evaluation is
 * still the authority. Blocks that need no pickaxe return `undefined`.
 */
export function requiredPickaxeFor(blockId: string): string | undefined {
  const id = blockId.includes(':') ? blockId : `minecraft:${blockId}`
  const name = id.slice(id.indexOf(':') + 1)
  if (name === 'obsidian' || name === 'ancient_debris' || name.endsWith('_ancient_debris'))
    return 'minecraft:diamond_pickaxe'
  if (/(?:^|_)ore$/.test(name)) {
    if (/^(?:diamond|emerald|gold|redstone)/.test(name) || name.startsWith('deepslate_'))
      return 'minecraft:iron_pickaxe'
    return 'minecraft:stone_pickaxe'
  }
  if (['stone', 'cobblestone', 'deepslate', 'andesite', 'diorite', 'granite', 'netherrack', 'blackstone', 'basalt', 'tuff', 'calcite', 'dripstone_block', 'sandstone', 'stone_bricks'].some(material => name === material || name.endsWith(`_${material}`)))
    return 'minecraft:wooden_pickaxe'
  return undefined
}

interface ResolveContext {
  inventory: Map<string, number>
  recipes: Map<string, ToolRecipe>
  stationOk: (station: CraftStation) => boolean
  budget: UpgradeBudget
  missing: Map<string, number>
  steps: UpgradeStep[]
  depth: number
  failed: boolean
}

function take(inventory: Map<string, number>, itemId: string, count: number): number {
  const have = inventory.get(itemId) ?? 0
  const used = Math.min(have, count)
  if (used > 0)
    inventory.set(itemId, have - used)
  return used
}

function addMissing(ctx: ResolveContext, itemId: string, count: number): void {
  if (count <= 0)
    return
  ctx.missing.set(itemId, (ctx.missing.get(itemId) ?? 0) + count)
}

/**
 * Ensures `count` of `itemId` are available, crafting only the missing part.
 *
 * `depth` is the prerequisite nesting level; a recipe deeper than the budget
 * stops with a missing-material record. The plan therefore resolves one missing
 * prerequisite per level instead of expanding an unbounded chain.
 */
function ensure(ctx: ResolveContext, itemId: string, count: number, depth: number): boolean {
  ctx.depth = Math.max(ctx.depth, depth)
  const taken = take(ctx.inventory, itemId, count)
  let remaining = count - taken
  if (remaining <= 0)
    return true
  if (depth > ctx.budget.maxMissingPrerequisites) {
    addMissing(ctx, itemId, remaining)
    ctx.failed = true
    return false
  }
  const recipe = ctx.recipes.get(itemId)
  if (!recipe || !ctx.stationOk(recipe.station)) {
    addMissing(ctx, itemId, remaining)
    ctx.failed = true
    return false
  }
  if (ctx.steps.length >= ctx.budget.maxCrafts) {
    addMissing(ctx, itemId, remaining)
    ctx.failed = true
    return false
  }

  const operations = Math.ceil(remaining / Math.max(1, recipe.outputCount))
  const consumedFuel = fuelFor(ctx, recipe, operations)
  if (recipe.station === 'furnace' && !consumedFuel) {
    addMissing(ctx, itemId, remaining)
    ctx.failed = true
    return false
  }

  for (let operation = 0; operation < operations; operation++) {
    for (const ingredient of recipe.ingredients) {
      if (!ensure(ctx, ingredient.itemId, ingredient.count, depth + 1))
        return false
    }
    ctx.steps.push({
      kind: recipe.station === 'furnace' ? 'smelt' : 'craft',
      itemId,
      station: recipe.station,
      outputCount: recipe.outputCount,
      ingredients: recipe.ingredients.map(ingredient => ({ ...ingredient })),
      ...(consumedFuel ? { fuel: consumedFuel } : {}),
    })
    ctx.inventory.set(itemId, (ctx.inventory.get(itemId) ?? 0) + recipe.outputCount)
    const produced = take(ctx.inventory, itemId, remaining)
    remaining -= produced
    if (remaining <= 0)
      return true
  }
  return remaining <= 0
}

/** Reserves the fuel for one furnace recipe, or undefined when it is missing. */
function fuelFor(ctx: ResolveContext, recipe: ToolRecipe, operations: number): { itemId: string, count: number } | undefined {
  if (recipe.station !== 'furnace')
    return undefined
  const available = ctx.budget.fuel ?? {}
  for (const fuelId of recipe.fuel ?? []) {
    const have = ctx.inventory.get(fuelId) ?? 0
    const stock = available[fuelId] ?? 0
    const usable = Math.min(have, stock)
    if (usable >= operations) {
      ctx.inventory.set(fuelId, have - operations)
      return { itemId: fuelId, count: operations }
    }
  }
  return undefined
}

/**
 * Plans a bounded upgrade to `target`.
 *
 * The inventory is never mutated; `keep` amounts are reserved first so a
 * tool or material the caller wants to retain is not consumed by the plan.
 *
 * @example
 * planToolUpgrade({ 'minecraft:oak_log': 1 }, 'minecraft:wooden_pickaxe', { maxCrafts: 4, maxMissingPrerequisites: 2 })
 * // => a plan whose steps craft planks, sticks and finally the pickaxe
 */
export function planToolUpgrade(
  inventoryCounts: Record<string, number>,
  target: string,
  budget: UpgradeBudget,
  recipes: ToolRecipe[] = PICKAXE_UPGRADE_RECIPES,
): UpgradePlan {
  const inventory = new Map<string, number>(Object.entries(inventoryCounts).filter(([, count]) => count > 0))
  for (const reserve of budget.keep ?? []) {
    if (reserve.count <= 0)
      continue
    const have = inventory.get(reserve.itemId) ?? 0
    inventory.set(reserve.itemId, Math.max(0, have - reserve.count))
  }

  const recipeMap = new Map(recipes.map(recipe => [recipe.itemId, recipe]))
  const allowed = budget.allowedStations ? new Set(budget.allowedStations) : undefined
  const ctx: ResolveContext = {
    inventory,
    recipes: recipeMap,
    stationOk: station => allowed === undefined || allowed.has(station),
    budget,
    missing: new Map(),
    steps: [],
    depth: 0,
    failed: false,
  }

  if ((inventory.get(target) ?? 0) > 0) {
    return { target, craftable: true, steps: [], missing: [], reason: 'already-held' }
  }

  const ok = ensure(ctx, target, 1, 0)
  const missing = [...ctx.missing.entries()].map(([itemId, count]) => ({ itemId, count }))
  if (ok && !ctx.failed)
    return { target, craftable: true, steps: ctx.steps, missing, reason: 'planned' }
  if (ctx.steps.length >= budget.maxCrafts)
    return { target, craftable: false, steps: ctx.steps, missing, reason: 'craft-budget-exhausted' }
  if (ctx.depth > budget.maxMissingPrerequisites)
    return { target, craftable: false, steps: ctx.steps, missing, reason: 'missing-prerequisite-depth' }
  return { target, craftable: false, steps: ctx.steps, missing, reason: 'missing-materials-or-station' }
}
