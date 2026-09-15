import { describe, expect, it } from 'vitest'

import { clipGuideExcerpt, formatGuideKnowledgeCard, guideEntryPathCandidates, guideIdFromEntryPath, guideOriginId, parseGuideEntry } from './guide'
import { parseKnowledgeMarker } from './knowledge'

const AE2_CHANNELS = `---
navigation:
  parent: ae2-mechanics/ae2-mechanics-index.md
  title: Channels
  icon: controller
---

# Channels

ME Networks require [Channels](channels.md) to support devices.
![diagram](../assets/diagram.png)

- Cables pass up to 8 channels.
- Dense cables pass 32.
`

const MAID_BROOM = JSON.stringify({
  sortnum: 15,
  name: 'patchouli.touhou_little_maid.book.entries.other.broom.name',
  icon: 'touhou_little_maid:broom',
  category: 'touhou_little_maid:other',
  pages: [
    { type: 'spotlight', item: 'touhou_little_maid:broom', text: 'patchouli.touhou_little_maid.book.entries.other.broom.pages.0.text' },
    { type: 'altar_recipe', recipe_id: 'touhou_little_maid:altar_recipe/broom' },
  ],
})

const MAID_LANG = {
  'patchouli.touhou_little_maid.book.entries.other.broom.name': 'Broom',
  'patchouli.touhou_little_maid.book.entries.other.broom.pages.0.text': 'The broom is a portable vehicle.$(br2)Use WASD to move.',
}

describe('guideIdFromEntryPath', () => {
  it('derives AE2 and Patchouli identities', () => {
    expect(guideIdFromEntryPath('assets/ae2/ae2guide/ae2-mechanics/channels.md'))
      .toEqual({ modId: 'ae2', entryId: 'ae2-mechanics/channels' })
    expect(guideIdFromEntryPath('assets/touhou_little_maid/patchouli_books/memorizable_gensokyo/en_us/entries/other/broom.json'))
      .toEqual({ modId: 'touhou_little_maid', bookId: 'memorizable_gensokyo', entryId: 'memorizable_gensokyo/other/broom' })
    expect(guideIdFromEntryPath('data/somemod/patchouli_books/book/en_us/entries/x.json'))
      .toEqual({ modId: 'somemod', bookId: 'book', entryId: 'book/x' })
    expect(guideIdFromEntryPath('data/ae2/recipe/foo.json')).toBeUndefined()
  })

  it('offers candidate paths for both conventions', () => {
    const paths = guideEntryPathCandidates('ae2', 'ae2-mechanics/channels')
    expect(paths).toContain('assets/ae2/ae2guide/ae2-mechanics/channels.md')
    expect(paths).toContain('assets/ae2/patchouli_books/ae2-mechanics/en_us/entries/channels.json')
    expect(guideEntryPathCandidates('ae2', 'channels')).toEqual([])
  })
})

describe('aE2 markdown guides', () => {
  it('reads frontmatter title and strips links, images and headings', () => {
    const entry = parseGuideEntry('assets/ae2/ae2guide/ae2-mechanics/channels.md', AE2_CHANNELS)!
    expect(entry.title).toBe('Channels')
    expect(entry.text).toContain('ME Networks require Channels to support devices.')
    expect(entry.text).not.toContain('](')
    expect(entry.text).not.toContain('![')
    expect(entry.text).toContain('- Cables pass up to 8 channels.')
  })

  it('falls back to the first heading when frontmatter has no title', () => {
    const entry = parseGuideEntry('assets/ae2/ae2guide/x/y.md', '# Fallback Title\n\nBody.')!
    expect(entry.title).toBe('Fallback Title')
  })
})

describe('patchouli guides', () => {
  it('resolves translation keys and cleans format codes', () => {
    const entry = parseGuideEntry('assets/touhou_little_maid/patchouli_books/memorizable_gensokyo/en_us/entries/other/broom.json', MAID_BROOM, MAID_LANG)!
    expect(entry.title).toBe('Broom')
    expect(entry.text).toBe('The broom is a portable vehicle.\nUse WASD to move.')
    expect(entry.stats).toEqual({ textPages: 1, skippedPages: 1 })
  })

  it('keeps unknown keys visible and survives bad JSON', () => {
    const entry = parseGuideEntry('assets/m/patchouli_books/b/en_us/entries/x.json', JSON.stringify({ name: 'm.book.unknown', pages: [{ type: 'text', text: 'plain text' }] }), {})!
    expect(entry.title).toBe('m.book.unknown')
    expect(entry.text).toBe('plain text')
    expect(parseGuideEntry('assets/m/patchouli_books/b/en_us/entries/x.json', '{not json', {})).toBeUndefined()
  })
})

describe('guide cards', () => {
  it('clips the excerpt and stamps tier plus modset in the marker', () => {
    expect(clipGuideExcerpt('a'.repeat(2000)).truncated).toBe(true)

    const entry = parseGuideEntry('assets/ae2/ae2guide/ae2-mechanics/channels.md', AE2_CHANNELS)!
    const card = formatGuideKnowledgeCard(entry, { modId: 'ae2', modVersion: '19.2.17', modsetHash: 'abcd1234', kind: 'guide' })
    expect(card).toContain('来源 assets/ae2/ae2guide/ae2-mechanics/channels.md')
    expect(card).toContain('状态：候选（未实测）')
    expect(parseKnowledgeMarker(card)).toEqual({ tier: 'candidate', modset: 'abcd1234' })
    expect(guideOriginId('ae2', entry.entryId)).toBe('mc2:ae2:guide:ae2-mechanics/channels')
  })
})
