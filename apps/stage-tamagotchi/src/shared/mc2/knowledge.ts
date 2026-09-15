/**
 * MC-2a knowledge cards and modset validity (pure helpers).
 *
 * Facts share the memory schema; the tier (`candidate`/`verified`) and the
 * modset hash live in tags, so a query can degrade stale knowledge without a
 * schema change.
 */
import type { Mc2RecipeCandidate } from './recipe'

export interface ModRef {
  id: string
  version: string
}

/** Knowledge trust tier: parsed candidate, game-verified fact, or web lead. */
export type MemoryTier = 'candidate' | 'verified' | 'lead'

/** FNV-1a 32-bit over the sorted `id@version` list; stable across processes. */
export function modsetHash(mods: ModRef[]): string {
  const canonical = [...mods]
    .sort((left, right) => left.id === right.id ? left.version.localeCompare(right.version) : left.id.localeCompare(right.id))
    .map(mod => `${mod.id}@${mod.version}`)
    .join(';')
  let hash = 0x811C9DC5
  for (let index = 0; index < canonical.length; index++) {
    hash ^= canonical.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export function knowledgeOriginId(recipeId: string): string {
  return `mc2:${recipeId}`
}

export interface KnowledgeCardContext {
  modId: string
  modVersion: string
  modsetHash: string
  /** Card family; drives the `kind:` tag. Defaults to `recipe` (MC-2a). */
  kind?: 'recipe' | 'guide' | 'web'
  /** Pre-verification tier for sources that start below candidate. */
  tier?: Exclude<MemoryTier, 'verified'>
  verified?: { at: number, how: string }
}

export function knowledgeTags(context: KnowledgeCardContext): string[] {
  return [
    'mc2',
    `mod:${context.modId}`,
    `modset:${context.modsetHash}`,
    `tier:${context.verified ? 'verified' : context.tier ?? 'candidate'}`,
    `kind:${context.kind ?? 'recipe'}`,
  ]
}

export interface ParsedKnowledgeTags {
  tier?: string
  modset?: string
  mod?: string
}

export function parseKnowledgeTags(tags: string[]): ParsedKnowledgeTags {
  const parsed: ParsedKnowledgeTags = {}
  for (const tag of tags) {
    if (tag.startsWith('tier:'))
      parsed.tier = tag.slice('tier:'.length)
    else if (tag.startsWith('modset:'))
      parsed.modset = tag.slice('modset:'.length)
    else if (tag.startsWith('mod:'))
      parsed.mod = tag.slice('mod:'.length)
  }
  return parsed
}

/** Human-readable ingredient summary for the card. */
export function describeRecipe(candidate: Mc2RecipeCandidate): string {
  if (candidate.type === 'minecraft:crafting_shaped' && candidate.pattern) {
    const keys = candidate.keys ?? {}
    const entries = Object.entries(keys).map(([symbol, value]) => {
      const record = value as { item?: string, tag?: string }
      return `${symbol}=${record.item ?? record.tag ?? '?'}`
    })
    return `${candidate.pattern.length}×${Math.max(...candidate.pattern.map(line => line.length))} 图案 ${JSON.stringify(candidate.pattern)}，材料 ${entries.join('、')}`
  }
  if (candidate.type === 'minecraft:crafting_shapeless' && candidate.ingredients) {
    const entries = candidate.ingredients.map((value) => {
      const record = value as { item?: string, tag?: string }
      return record.item ?? record.tag ?? '?'
    })
    return `无序材料 ${entries.join('、')}`
  }
  return `类型 ${candidate.type}（原始数据见来源）`
}

/**
 * Machine-readable marker embedded in the card content.
 *
 * v1 reads tier/modset back from the card because the memory store returns
 * fragments without their tag rows. The real tags are still written to
 * `memory_tags` on insert, so a later tag join can replace this marker
 * without re-ingesting.
 */
/** Machine-readable marker; `extras` carries source keys such as the web URL. */
export function knowledgeMarker(tier: MemoryTier, modset: string, extras: Record<string, string> = {}): string {
  const suffix = Object.entries(extras).map(([key, value]) => ` ${key}=${value}`).join('')
  return `[mc2 tier=${tier} modset=${modset}${suffix}]`
}

export function parseKnowledgeMarker(content: string): { tier?: string, modset?: string } {
  const match = /\[mc2 ([^\]]*)\]/.exec(content)
  if (!match?.[1])
    return {}
  const fields = new Map<string, string>()
  for (const token of match[1].split(/\s+/)) {
    const separator = token.indexOf('=')
    if (separator > 0)
      fields.set(token.slice(0, separator), token.slice(separator + 1))
  }
  const tier = fields.get('tier')
  const modset = fields.get('modset')
  return {
    ...(tier ? { tier } : {}),
    ...(modset ? { modset } : {}),
  }
}

/**
 * Formats the knowledge card stored in memory.
 *
 * @example
 * formatRecipeKnowledgeCard(candidate, { modId: 'farmersdelight', modVersion: '1.3.4', modsetHash: 'abc123' })
 * // => 'farmersdelight:flint_knife：2×1 图案 ["m","s"]，材料 m=minecraft:flint、s=minecraft:stick；产出 farmersdelight:flint_knife×1；来源 data/...；模组 farmersdelight 1.3.4；状态：候选（未实测）。[mc2 tier=candidate modset=abc123]'
 */
export function formatRecipeKnowledgeCard(candidate: Mc2RecipeCandidate, context: KnowledgeCardContext): string {
  const parts = [
    `${candidate.recipeId}：${describeRecipe(candidate)}`,
    `来源 ${candidate.sourcePath}`,
    `模组 ${context.modId} ${context.modVersion}`,
  ]
  if (candidate.result)
    parts.splice(1, 0, `产出 ${candidate.result.id}×${candidate.result.count}`)
  const tier = context.verified ? 'verified' : 'candidate'
  const verified = context.verified
    ? `核实：${context.verified.how}（${new Date(context.verified.at).toISOString().slice(0, 10)}）。`
    : '状态：候选（未实测）。'
  parts.push(verified)
  return `${parts.join('；')}${knowledgeMarker(tier, context.modsetHash)}`
}
