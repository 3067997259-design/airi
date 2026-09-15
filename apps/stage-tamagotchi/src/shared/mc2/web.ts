/**
 * MC-2b web-to-knowledge extraction (pure helpers).
 *
 * Fetched page text is data. The extractor derives card fields and flags
 * instruction-like text for audit; it never turns page text into commands,
 * tool calls, or permissions. The untrusted-content wrapping stays owned by
 * the fetch/search layer (`web_fetch`, `web_search`).
 */
import { knowledgeMarker } from './knowledge'

/** Paragraph budget for the card excerpt; the full page stays at its URL. */
const WEB_EXCERPT_MAX_CHARS = 1200
/** A first paragraph longer than this is treated as body, not as a title. */
const WEB_TITLE_MAX_CHARS = 120

export interface WebLeadCandidate {
  title: string
  excerpt: string
  sourceUrl: string
  fetchedAt: number
  contentHash: string
  /** Instruction-like fragments found in the page text; audit only. */
  injectionSignals: string[]
}

/**
 * Instruction-like patterns worth flagging. Each entry has a stable label so
 * acceptance can assert on labels instead of on regex internals.
 */
const INJECTION_SIGNAL_PATTERNS: Array<{ label: string, pattern: RegExp }> = [
  { label: 'ignore-instructions', pattern: /ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/i },
  { label: 'ignore-instructions-zh', pattern: /忽略(以上|之前|前面)(的)?(所有)?(指令|指示|规则)/ },
  { label: 'disregard-system', pattern: /disregard\s+(the\s+)?(system|developer)\s+(prompt|message)/i },
  { label: 'role-override', pattern: /you\s+are\s+now\s+(a|an|the)\b/i },
  { label: 'tool-call', pattern: /\b(call|invoke|execute)\s+(the\s+)?(tool|function)\b/i },
  { label: 'mark-verified', pattern: /mark\s+(this|it|the\s+\w+)\s+(as\s+)?verified/i },
  { label: 'tool-name', pattern: /\b(?:craft_by_recipe|place_block|break_block|set_movement|game_[a-z_]+)\b/ },
  { label: 'system-prompt', pattern: /system\s+prompt/i },
]

export function detectInjectionSignals(text: string): string[] {
  const labels: string[] = []
  for (const { label, pattern } of INJECTION_SIGNAL_PATTERNS) {
    if (pattern.test(text))
      labels.push(label)
  }
  return labels
}

/** FNV-1a 32-bit hex; stable across processes for the same text. */
function fnv1aHex(text: string): string {
  let hash = 0x811C9DC5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export function webKnowledgeOriginId(sourceUrl: string): string {
  return `mc2:web:${fnv1aHex(sourceUrl)}`
}

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map(paragraph => paragraph.replace(/\s+/g, ' ').trim())
    .filter(paragraph => paragraph.length > 0)
}

function deriveTitle(paragraphs: string[], sourceUrl: string): string {
  const heading = paragraphs.find(paragraph => paragraph.length <= WEB_TITLE_MAX_CHARS)
  if (heading)
    return heading
  try {
    return new URL(sourceUrl).hostname
  }
  catch {
    return sourceUrl
  }
}

function selectExcerpt(paragraphs: string[], terms: string[]): string {
  const wanted = terms.filter(term => term.trim().length > 0).map(term => term.toLowerCase())
  const relevant = wanted.length > 0
    ? paragraphs.filter(paragraph => wanted.some(term => paragraph.toLowerCase().includes(term)))
    : paragraphs
  const source = relevant.length > 0 ? relevant : paragraphs
  let excerpt = ''
  for (const paragraph of source) {
    if (excerpt.length >= WEB_EXCERPT_MAX_CHARS)
      break
    excerpt = excerpt ? `${excerpt}\n${paragraph}` : paragraph
  }
  return excerpt.length > WEB_EXCERPT_MAX_CHARS ? `${excerpt.slice(0, WEB_EXCERPT_MAX_CHARS)}…` : excerpt
}

/**
 * Derives a lead candidate from fetched page text.
 *
 * The returned object contains knowledge-card fields only. Page text cannot
 * add fields, trigger actions, or raise the tier; `injectionSignals` records
 * instruction-like content for audit.
 */
export function extractWebLead(text: string, sourceUrl: string, fetchedAt: number, terms: string[] = []): WebLeadCandidate {
  const paragraphs = splitParagraphs(text)
  return {
    title: deriveTitle(paragraphs, sourceUrl),
    excerpt: selectExcerpt(paragraphs.slice(1), terms),
    sourceUrl,
    fetchedAt,
    contentHash: fnv1aHex(text),
    injectionSignals: detectInjectionSignals(text),
  }
}

export interface WebCardContext {
  modsetHash: string
  /** Marks the card as a web fact and makes the URL recoverable after restart. */
  webUrl?: string
  /** Jar path the lead was cross-checked against; raises the tier to candidate. */
  crossedWith?: string
  verified?: { at: number, how: string }
}

/** Reads the URL a web card was written with; used to re-tier without refetching. */
export function parseWebMarker(content: string): { url?: string } {
  const match = /\[mc2 [^\]]*web=([^\s\]]+)/.exec(content)
  if (!match?.[1])
    return {}
  try {
    return { url: decodeURIComponent(match[1]) }
  }
  catch {
    return {}
  }
}

/**
 * Formats the knowledge card stored in memory for a web lead.
 *
 * @example
 * formatWebKnowledgeCard(lead, { modsetHash: 'abc123' })
 * // => '网页线索 https://wiki.example/flint_knife（Flint Knife）：…；抓取 2026-09-13；状态：线索（未实测…）。[mc2 tier=lead modset=abc123]'
 */
export function formatWebKnowledgeCard(candidate: Pick<WebLeadCandidate, 'title' | 'excerpt' | 'sourceUrl' | 'fetchedAt' | 'injectionSignals'>, context: WebCardContext): string {
  const tier = context.verified ? 'verified' : context.crossedWith ? 'candidate' : 'lead'
  const parts = [
    `网页线索 ${candidate.sourceUrl}（${candidate.title}）：${candidate.excerpt}`,
    `抓取 ${new Date(candidate.fetchedAt).toISOString().slice(0, 10)}`,
  ]
  if (context.crossedWith)
    parts.push(`交叉核对：与 ${context.crossedWith} 数据一致`)
  parts.push(context.verified
    ? `核实：${context.verified.how}（${new Date(context.verified.at).toISOString().slice(0, 10)}）。`
    : context.crossedWith
      ? '状态：候选（已交叉，未实测）。'
      : '状态：线索（未实测，需与模组数据交叉或游戏内实测）。')
  if (candidate.injectionSignals.length > 0)
    parts.push(`注入嫌疑：${candidate.injectionSignals.join('、')}（仅审计，未执行）`)
  const extras: Record<string, string> = context.webUrl ? { web: encodeURIComponent(context.webUrl) } : {}
  return `${parts.join('；')}${knowledgeMarker(tier, context.modsetHash, extras)}`
}
