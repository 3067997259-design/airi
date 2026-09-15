import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import JSZip from 'jszip'

import { afterEach, describe, expect, it } from 'vitest'

import { entryPathForRecipe, fitsPlayerGrid, parseRecipeCandidate, recipeIdFromEntryPath } from '../../../../shared/mc2/recipe'
import { readJarEntries } from './mod-data'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(directory)
  return directory
}

const FLINT_KNIFE = JSON.stringify({
  type: 'minecraft:crafting_shaped',
  key: { m: { item: 'minecraft:flint' }, s: { item: 'minecraft:stick' } },
  pattern: ['m', 's'],
  result: { count: 1, id: 'farmersdelight:flint_knife' },
})

const CUTTING_BOARD = JSON.stringify({
  type: 'minecraft:crafting_shaped',
  pattern: ['/##', '/##'],
  result: { count: 1, id: 'farmersdelight:cutting_board' },
})

async function buildJar(directory: string): Promise<string> {
  const zip = new JSZip()
  zip.file('data/farmersdelight/recipe/flint_knife.json', FLINT_KNIFE)
  zip.file('data/farmersdelight/recipe/cutting_board.json', CUTTING_BOARD)
  zip.file('assets/farmersdelight/lang/en_us.json', JSON.stringify({ 'item.farmersdelight.flint_knife': 'Flint Knife' }))
  zip.file('evil.mjs', 'export const x = 1')
  const path = join(directory, 'fixture.jar')
  await writeFile(path, await zip.generateAsync({ type: 'nodebuffer' }))
  return path
}

describe('readJarEntries', () => {
  it('reads only whitelisted entries and parses recipe candidates', async () => {
    const directory = await temporaryDirectory('airi-mc2-jar-')
    const jarPath = await buildJar(directory)
    const result = await readJarEntries(jarPath, { roots: [directory] })

    expect(result.entries.map(entry => entry.path).sort()).toEqual([
      'assets/farmersdelight/lang/en_us.json',
      'data/farmersdelight/recipe/cutting_board.json',
      'data/farmersdelight/recipe/flint_knife.json',
    ])
    expect(result.entries.some(entry => entry.path === 'evil.mjs')).toBe(false)
    expect(result.candidates.map(candidate => candidate.recipeId).sort()).toEqual([
      'farmersdelight:cutting_board',
      'farmersdelight:flint_knife',
    ])
    expect(result.truncated).toBe(false)
  })

  it('filters by exact entry path', async () => {
    const directory = await temporaryDirectory('airi-mc2-jar-path-')
    const jarPath = await buildJar(directory)
    const result = await readJarEntries(jarPath, {
      roots: [directory],
      entryPaths: ['data/farmersdelight/recipe/flint_knife.json'],
    })
    expect(result.entries).toHaveLength(1)
    expect(result.candidates[0]?.recipeId).toBe('farmersdelight:flint_knife')
  })

  it('rejects a jar outside the configured roots', async () => {
    const directory = await temporaryDirectory('airi-mc2-jar-out-')
    const other = await temporaryDirectory('airi-mc2-jar-other-')
    const jarPath = await buildJar(directory)
    await expect(readJarEntries(jarPath, { roots: [other] })).rejects.toMatchObject({ code: 'jar_not_allowed' })
  })

  it('rejects a missing jar', async () => {
    const directory = await temporaryDirectory('airi-mc2-jar-missing-')
    await expect(readJarEntries(join(directory, 'nope.jar'), { roots: [directory] })).rejects.toMatchObject({ code: 'jar_missing' })
  })
})

describe('recipe helpers', () => {
  it('derives recipe ids from both folder spellings', () => {
    expect(recipeIdFromEntryPath('data/farmersdelight/recipe/flint_knife.json')).toBe('farmersdelight:flint_knife')
    expect(recipeIdFromEntryPath('data/create/recipes/cogwheel.json')).toBe('create:cogwheel')
    expect(recipeIdFromEntryPath('assets/farmersdelight/lang/en_us.json')).toBeUndefined()
  })

  it('builds the conventional entry path', () => {
    expect(entryPathForRecipe('farmersdelight:flint_knife')).toBe('data/farmersdelight/recipe/flint_knife.json')
    expect(entryPathForRecipe('broken')).toBeUndefined()
  })

  it('parses shaped recipes and checks the player grid', () => {
    const knife = parseRecipeCandidate(FLINT_KNIFE, 'data/farmersdelight/recipe/flint_knife.json')
    expect(knife).toMatchObject({
      recipeId: 'farmersdelight:flint_knife',
      type: 'minecraft:crafting_shaped',
      result: { id: 'farmersdelight:flint_knife', count: 1 },
      pattern: ['m', 's'],
    })
    expect(knife && fitsPlayerGrid(knife)).toBe(true)

    const board = parseRecipeCandidate(CUTTING_BOARD, 'data/farmersdelight/recipe/cutting_board.json')
    expect(board && fitsPlayerGrid(board)).toBe(false)
  })

  it('keeps unknown recipe types as raw candidates and rejects non-json', () => {
    const unknown = parseRecipeCandidate('{"type":"farmersdelight:cutting","ingredients":[]}', 'data/farmersdelight/recipe/apple.json')
    expect(unknown?.type).toBe('farmersdelight:cutting')
    expect(parseRecipeCandidate('not json', 'data/farmersdelight/recipe/x.json')).toBeUndefined()
  })
})
