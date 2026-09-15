import { describe, expect, it } from 'vitest'

import { describeRecipe, formatRecipeKnowledgeCard, knowledgeOriginId, knowledgeTags, modsetHash, parseKnowledgeMarker, parseKnowledgeTags } from './knowledge'
import { parseRecipeCandidate } from './recipe'

const FLINT_KNIFE = JSON.stringify({
  type: 'minecraft:crafting_shaped',
  key: { m: { item: 'minecraft:flint' }, s: { item: 'minecraft:stick' } },
  pattern: ['m', 's'],
  result: { count: 1, id: 'farmersdelight:flint_knife' },
})

const DOUGH = JSON.stringify({
  type: 'minecraft:crafting_shapeless',
  ingredients: [{ item: 'minecraft:wheat' }, { item: 'minecraft:water_bucket' }],
  result: { count: 1, id: 'farmersdelight:wheat_dough' },
})

describe('modsetHash', () => {
  it('is order independent and changes with any version', () => {
    const a = modsetHash([{ id: 'create', version: '6.0.10' }, { id: 'farmersdelight', version: '1.3.4' }])
    const b = modsetHash([{ id: 'farmersdelight', version: '1.3.4' }, { id: 'create', version: '6.0.10' }])
    const c = modsetHash([{ id: 'create', version: '6.0.10' }, { id: 'farmersdelight', version: '1.3.5' }])
    expect(a).toBe(b)
    expect(a).toHaveLength(8)
    expect(c).not.toBe(a)
  })
})

describe('knowledge tags', () => {
  it('round-trips tier, mod and modset', () => {
    const tags = knowledgeTags({ modId: 'farmersdelight', modVersion: '1.3.4', modsetHash: 'abcd1234' })
    expect(tags).toEqual(['mc2', 'mod:farmersdelight', 'modset:abcd1234', 'tier:candidate', 'kind:recipe'])
    expect(parseKnowledgeTags(tags)).toEqual({ mod: 'farmersdelight', modset: 'abcd1234', tier: 'candidate' })

    const verified = knowledgeTags({
      modId: 'farmersdelight',
      modVersion: '1.3.4',
      modsetHash: 'abcd1234',
      verified: { at: Date.now(), how: 'crafted once' },
    })
    expect(parseKnowledgeTags(verified).tier).toBe('verified')
  })

  it('derives the fact origin id', () => {
    expect(knowledgeOriginId('farmersdelight:flint_knife')).toBe('mc2:farmersdelight:flint_knife')
  })
})

describe('knowledge card', () => {
  it('describes shaped and shapeless recipes', () => {
    const knife = parseRecipeCandidate(FLINT_KNIFE, 'data/farmersdelight/recipe/flint_knife.json')!
    expect(describeRecipe(knife)).toContain('"m"')
    expect(describeRecipe(knife)).toContain('m=minecraft:flint')

    const dough = parseRecipeCandidate(DOUGH, 'data/farmersdelight/recipe/wheat_dough.json')!
    expect(describeRecipe(dough)).toContain('无序材料')
    expect(describeRecipe(dough)).toContain('minecraft:wheat')
  })

  it('ignores extra marker keys such as the web source', () => {
    expect(parseKnowledgeMarker('卡片。[mc2 tier=lead modset=abcd1234 web=https%3A%2F%2Fexample.com%2Fx]'))
      .toEqual({ tier: 'lead', modset: 'abcd1234' })
  })

  it('marks candidates and verified facts differently', () => {
    const knife = parseRecipeCandidate(FLINT_KNIFE, 'data/farmersdelight/recipe/flint_knife.json')!
    const candidateCard = formatRecipeKnowledgeCard(knife, { modId: 'farmersdelight', modVersion: '1.3.4', modsetHash: 'abcd1234' })
    expect(candidateCard).toContain('状态：候选（未实测）')
    expect(candidateCard).toContain('产出 farmersdelight:flint_knife×1')
    expect(candidateCard).toContain('来源 data/farmersdelight/recipe/flint_knife.json')
    expect(parseKnowledgeMarker(candidateCard)).toEqual({ tier: 'candidate', modset: 'abcd1234' })

    const verifiedCard = formatRecipeKnowledgeCard(knife, {
      modId: 'farmersdelight',
      modVersion: '1.3.4',
      modsetHash: 'abcd1234',
      verified: { at: Date.UTC(2026, 8, 13), how: '随身合成 1 次，库存 +1' },
    })
    expect(verifiedCard).toContain('核实：随身合成 1 次，库存 +1（2026-09-13）')
    expect(parseKnowledgeMarker(verifiedCard)?.tier).toBe('verified')
  })
})
