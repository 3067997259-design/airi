/**
 * Pure helpers for MC-2a mod-data ingestion.
 *
 * Shared by the main reader and the renderer probe; no Node imports so both
 * sides can use the same parsing rules.
 */

/** Entry paths that are safe and useful to ingest (read-only whitelist). */
const ENTRY_ALLOWLIST: RegExp[] = [
  /^data\/[^/]+\/recipes?\/.*\.json$/,
  /^data\/[^/]+\/tags\/.*\.json$/,
  /^assets\/[^/]+\/lang\/[^/]+\.json$/,
  /^assets\/ae2\/ae2guide\/.*\.(md|json)$/,
  /^(?:data|assets)\/[^/]+\/patchouli_books\/.*\.(json|md)$/,
]

export function isAllowedEntryPath(path: string): boolean {
  return ENTRY_ALLOWLIST.some(pattern => pattern.test(path))
}

/**
 * Derives the recipe id from its data path.
 *
 * @example
 * recipeIdFromEntryPath('data/farmersdelight/recipe/flint_knife.json')
 * // => 'farmersdelight:flint_knife'
 */
export function recipeIdFromEntryPath(path: string): string | undefined {
  const match = /^data\/([^/]+)\/recipes?\/(.+)\.json$/.exec(path)
  if (!match?.[1] || !match[2])
    return undefined
  return `${match[1]}:${match[2]}`
}

/** The conventional data path for a recipe id (the `recipe` folder). */
export function entryPathForRecipe(recipeId: string): string | undefined {
  const [namespace, name] = recipeId.split(':')
  if (!namespace || !name)
    return undefined
  return `data/${namespace}/recipe/${name}.json`
}

export interface Mc2RecipeCandidate {
  recipeId: string
  type: string
  result?: { id: string, count: number }
  pattern?: string[]
  keys?: Record<string, unknown>
  ingredients?: unknown[]
  sourcePath: string
  raw: unknown
}

/**
 * Parses one recipe JSON into a reviewable candidate.
 *
 * Unknown recipe types are kept as raw candidates: MC-2a ingests first and
 * verifies later, so a type the probe cannot summarize must not disappear.
 */
export function parseRecipeCandidate(text: string, sourcePath: string): Mc2RecipeCandidate | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  }
  catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return undefined
  const record = raw as Record<string, unknown>
  const recipeId = recipeIdFromEntryPath(sourcePath)
  if (!recipeId)
    return undefined
  const type = typeof record.type === 'string' ? record.type : 'unknown'

  const candidate: Mc2RecipeCandidate = { recipeId, type, sourcePath, raw }

  const result = record.result
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const resultRecord = result as Record<string, unknown>
    if (typeof resultRecord.id === 'string')
      candidate.result = { id: resultRecord.id, count: Number(resultRecord.count) || 1 }
  }
  if (Array.isArray(record.pattern) && record.pattern.every(line => typeof line === 'string'))
    candidate.pattern = record.pattern as string[]
  if (record.key && typeof record.key === 'object' && !Array.isArray(record.key))
    candidate.keys = record.key as Record<string, unknown>
  if (Array.isArray(record.ingredients))
    candidate.ingredients = record.ingredients

  return candidate
}

/** True when a shaped recipe fits the player's own 2x2 grid. */
export function fitsPlayerGrid(candidate: Pick<Mc2RecipeCandidate, 'type' | 'pattern' | 'ingredients'>): boolean {
  if (candidate.type === 'minecraft:crafting_shaped') {
    const lines = candidate.pattern ?? []
    const width = lines.reduce((max, line) => Math.max(max, line.length), 0)
    return lines.length <= 2 && width <= 2
  }
  if (candidate.type === 'minecraft:crafting_shapeless')
    return (candidate.ingredients?.length ?? 0) <= 4
  return false
}
