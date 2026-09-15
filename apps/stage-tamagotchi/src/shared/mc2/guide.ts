/**
 * MC-2b guide ingestion (pure helpers).
 *
 * Guides come from two conventions inside a jar: AE2-style Markdown under
 * `assets/<ns>/ae2guide/**` and Patchouli books whose entry JSON stores
 * translation keys. Parsing is read-only text extraction; nothing is executed
 * and unresolved translation keys stay visible instead of disappearing.
 */
import type { KnowledgeCardContext } from './knowledge'

import { knowledgeMarker } from './knowledge'

/** Card excerpt budget; the full text stays in the jar and is re-readable by entry id. */
const GUIDE_EXCERPT_MAX_CHARS = 1200

export interface Mc2GuideEntry {
  entryId: string
  kind: 'guide'
  modId: string
  bookId?: string
  title: string
  text: string
  sourcePath: string
  truncated: boolean
}

/**
 * Derives the guide identity from its asset path.
 *
 * @example
 * guideIdFromEntryPath('assets/ae2/ae2guide/ae2-mechanics/channels.md')
 * // => { modId: 'ae2', entryId: 'ae2-mechanics/channels' }
 *
 * @example
 * guideIdFromEntryPath('assets/touhou_little_maid/patchouli_books/memorizable_gensokyo/en_us/entries/other/broom.json')
 * // => { modId: 'touhou_little_maid', bookId: 'memorizable_gensokyo', entryId: 'memorizable_gensokyo/other/broom' }
 */
export function guideIdFromEntryPath(path: string): { modId: string, bookId?: string, entryId: string } | undefined {
  const ae2 = /^assets\/([^/]+)\/ae2guide\/(.+)\.md$/i.exec(path)
  if (ae2?.[1] && ae2[2])
    return { modId: ae2[1], entryId: ae2[2] }

  const patchouli = /^(?:assets|data)\/([^/]+)\/patchouli_books\/([^/]+)\/[^/]+\/entries\/(.+)\.json$/i.exec(path)
  if (patchouli?.[1] && patchouli[2] && patchouli[3])
    return { modId: patchouli[1], bookId: patchouli[2], entryId: `${patchouli[2]}/${patchouli[3]}` }

  return undefined
}

function parseFrontmatter(markdown: string): { fields: Record<string, string>, body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown)
  if (!match?.[1])
    return { fields: {}, body: markdown }
  const fields: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^\s*([\w-]+):\s*(\S.*)$/.exec(line)
    if (field?.[1] && field[2])
      fields[field[1]] = field[2].trim().replace(/^["']|["']$/g, '')
  }
  return { fields, body: markdown.slice(match[0].length) }
}

/** Strips Markdown syntax down to readable text; link targets and images are dropped. */
function markdownToText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, segment => segment.replace(/```[^\n]*\n?/g, ''))
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '- ')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Resolves Patchouli translation keys against one lang file; unknown keys stay as-is. */
function resolveLangText(value: unknown, lang: Record<string, string>): string | undefined {
  if (typeof value !== 'string' || value.length === 0)
    return undefined
  return lang[value] ?? value
}

/** Patchouli format codes: line breaks keep structure, other codes drop the token only. */
function cleanPatchouliText(text: string): string {
  return text
    .replace(/\$\(br2?\)/gi, '\n')
    .replace(/\$\(li\)/gi, '- ')
    .replace(/\$\([^)]*\)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export interface PatchouliPageStats {
  textPages: number
  skippedPages: number
}

function parsePatchouliGuide(
  jsonText: string,
  identity: { modId: string, bookId?: string, entryId: string },
  sourcePath: string,
  lang: Record<string, string>,
): (Mc2GuideEntry & { stats: PatchouliPageStats }) | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(jsonText)
  }
  catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return undefined
  const record = raw as Record<string, unknown>

  const title = resolveLangText(record.name, lang) ?? identity.entryId
  const sections: string[] = []
  let textPages = 0
  let skippedPages = 0
  if (Array.isArray(record.pages)) {
    for (const page of record.pages) {
      if (page && typeof page === 'object' && !Array.isArray(page)) {
        const pageText = resolveLangText((page as Record<string, unknown>).text, lang)
        if (pageText) {
          sections.push(cleanPatchouliText(pageText))
          textPages += 1
          continue
        }
      }
      skippedPages += 1
    }
  }

  const text = sections.join('\n\n')
  return {
    entryId: identity.entryId,
    kind: 'guide',
    modId: identity.modId,
    ...(identity.bookId ? { bookId: identity.bookId } : {}),
    title,
    text,
    sourcePath,
    truncated: false,
    stats: { textPages, skippedPages },
  }
}

/**
 * Parses one guide asset into an entry.
 *
 * `lang` is required for Patchouli books and ignored by AE2-style Markdown.
 * Returns `undefined` for unknown paths or unparsable JSON, so callers can
 * keep scanning the jar.
 */
export function parseGuideEntry(
  path: string,
  text: string,
  lang: Record<string, string> = {},
): (Mc2GuideEntry & { stats?: PatchouliPageStats }) | undefined {
  const identity = guideIdFromEntryPath(path)
  if (!identity)
    return undefined

  if (path.includes('/ae2guide/')) {
    const { fields, body } = parseFrontmatter(text)
    const heading = /^\s{0,3}#{1,6}[ \t]+(\S.*)$/m.exec(body)
    const title = fields.title ?? heading?.[1]?.trim() ?? identity.entryId
    return {
      entryId: identity.entryId,
      kind: 'guide',
      modId: identity.modId,
      title,
      text: markdownToText(body),
      sourcePath: path,
      truncated: false,
    }
  }

  return parsePatchouliGuide(text, identity, path, lang)
}

/** Clips a guide body to the card excerpt budget. */
export function clipGuideExcerpt(text: string, maxChars = GUIDE_EXCERPT_MAX_CHARS): { text: string, truncated: boolean } {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxChars)
    return { text: normalized, truncated: false }
  return { text: `${normalized.slice(0, maxChars)}…`, truncated: true }
}

/**
 * Candidate asset paths for one entry id. An entry id cannot tell the AE2 and
 * Patchouli conventions apart, so the caller reads the list and keeps the
 * first path that exists.
 *
 * @example
 * guideEntryPathCandidates('ae2', 'ae2-mechanics/channels')
 * // => ['assets/ae2/ae2guide/ae2-mechanics/channels.md', 'data/ae2/patchouli_books/ae2-mechanics/channels.json', 'assets/ae2/patchouli_books/ae2-mechanics/en_us/entries/channels.json']
 */
export function guideEntryPathCandidates(modId: string, entryId: string): string[] {
  const segments = entryId.split('/')
  if (segments.length < 2)
    return []
  const [bookId, ...rest] = segments
  const paths = [`assets/${modId}/ae2guide/${entryId}.md`, `data/${modId}/patchouli_books/${entryId}.json`]
  if (bookId && rest.length > 0)
    paths.push(`assets/${modId}/patchouli_books/${bookId}/en_us/entries/${rest.join('/')}.json`)
  return paths
}

export function guideOriginId(modId: string, entryId: string): string {
  return `mc2:${modId}:guide:${entryId}`
}

/**
 * Formats the knowledge card stored in memory for a guide entry.
 *
 * @example
 * formatGuideKnowledgeCard(entry, { modId: 'ae2', modVersion: '19.2.17', modsetHash: 'abc123' })
 * // => 'AE2 指南 ae2-mechanics/channels（Channels）：…摘要…；来源 assets/ae2/ae2guide/ae2-mechanics/channels.md；模组 ae2 19.2.17；状态：候选（未实测）。[mc2 tier=candidate modset=abc123]'
 */
export function formatGuideKnowledgeCard(entry: Mc2GuideEntry, context: KnowledgeCardContext): string {
  const excerpt = clipGuideExcerpt(entry.text)
  const tier = context.verified ? 'verified' : 'candidate'
  const parts = [
    `${entry.modId} 指南 ${entry.entryId}（${entry.title}）：${excerpt.text}`,
    `来源 ${entry.sourcePath}`,
    `模组 ${context.modId} ${context.modVersion}`,
    context.verified
      ? `核实：${context.verified.how}（${new Date(context.verified.at).toISOString().slice(0, 10)}）。`
      : '状态：候选（未实测）。',
  ]
  return `${parts.join('；')}${knowledgeMarker(tier, context.modsetHash)}`
}
