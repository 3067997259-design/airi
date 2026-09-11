import type { AiriCard } from '../types/airiCard'
import type { ChatHistoryItem } from '../types/chat'
import type { ChatSessionsExport } from '../types/chat-session'
import type { InspectedDataBackup } from './data-backup'

import { contentHashOf } from '@proj-airi/skill-forge'

import * as v from 'valibot'

import { skillReviewSchema } from '../types/skill-review'
import { builtInSkillArtifact } from './skill-artifacts'

/** Only these persisted preferences enter a portable business backup. */
export const backupSettingsKeys = [
  'settings/consciousness/reasoning',
  'settings/consciousness/reasoning-effort',
  ...[
    'enabled',
    'capture-enabled',
    'compaction-enabled',
    'active-provider',
    'active-model',
    'compaction-threshold',
    'context-length-override',
    'compaction-recent-turn-limit',
    'short-term-half-life-hours',
    'long-term-half-life-hours',
    'promotion-access-count',
    'promotion-session-count',
    'weight-similarity',
    'weight-time-relevance',
    'weight-arousal',
    'weight-access-count',
    'weight-mood-congruence',
    'intrusion-enabled',
    'intrusion-base-rate',
    'intrusion-cooldown-ms',
    'dreaming-enabled',
    'automatic-dreaming-enabled',
    'dreaming-interval-hours',
    'dreaming-daily-budget',
    'dreaming-min-new-memory-count',
    'last-dream-at',
    'dreaming-budget-used',
    'dreaming-budget-date-key',
    'embedding-source',
    'embedding-model',
    'embedding-fingerprint',
    'embedding-migration',
  ].map(key => `settings/memory/${key}`),
] as const

const idSchema = v.pipe(v.string(), v.minLength(1), v.check(value => !['__proto__', 'prototype', 'constructor'].includes(value)))
const metaSchema = v.looseObject({
  sessionId: idSchema,
  userId: idSchema,
  characterId: idSchema,
  createdAt: v.number(),
  updatedAt: v.number(),
  title: v.optional(v.string()),
  cloudChatId: v.optional(v.string()),
  cloudMaxSeq: v.optional(v.number()),
})
const messageSchema = v.looseObject({ role: v.picklist(['system', 'user', 'assistant', 'tool', 'error']), content: v.union([v.string(), v.array(v.unknown())]) })
const chatsSchema = v.object({
  format: v.literal('chat-sessions-index:v1'),
  index: v.object({ userId: idSchema, characters: v.record(idSchema, v.object({ activeSessionId: v.string(), sessions: v.record(idSchema, metaSchema) })) }),
  sessions: v.record(idSchema, v.object({ meta: metaSchema, messages: v.array(v.custom<ChatHistoryItem>(value => v.safeParse(messageSchema, value).success)) })),
})
const cardSchema = v.looseObject({
  name: v.string(),
  version: v.string(),
  extensions: v.looseObject({ airi: v.looseObject({ modules: v.object({
    consciousness: v.object({ provider: v.string(), model: v.string() }),
    vision: v.object({ provider: v.string(), model: v.string() }),
    speech: v.looseObject({ provider: v.string(), model: v.string(), voice_id: v.string() }),
  }), agents: v.record(v.string(), v.object({ prompt: v.string(), enabled: v.optional(v.boolean()) })) }) }),
})
const identitySchema = v.object({
  userId: idSchema,
  activeCardId: idSchema,
  cards: v.array(v.tuple([idSchema, v.custom<AiriCard>(value => v.safeParse(cardSchema, value).success)])),
})

/** Checks domain references before any filesystem or browser owner imports data. */
export function checkRestoreData(backup: InspectedDataBackup) {
  const required = new Set([
    'identity/cards.json',
    'identity/settings.json',
    'chats/sessions.json',
    'skills/registry.json',
    'outbox/held.json',
    'plans/plans.json',
    ...['memory_fragments', 'memory_tags', 'memory_episodic', 'memory_long_term_goals', 'memory_short_term_ideas'].map(table => `memory/${table}.parquet`),
  ])
  const byPath = new Map(backup.entries.map(entry => [entry.path, entry]))
  function json(path: string): unknown {
    const entry = byPath.get(path)
    if (!entry)
      throw new Error(`Required backup file is missing: ${path}`)
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(entry.data))
  }
  const identity = v.parse(identitySchema, json('identity/cards.json'))
  const cards = new Set(identity.cards.map(([id]) => id))
  if (cards.size !== identity.cards.length || !cards.has(identity.activeCardId))
    throw new Error('Backup contains duplicate cards or a missing active card.')
  const chats: ChatSessionsExport = v.parse(chatsSchema, json('chats/sessions.json'))
  const plans = v.parse(v.array(v.unknown()), json('plans/plans.json'))
  if (chats.index.userId !== identity.userId)
    throw new Error('Chat and identity owners do not match.')
  const sessions = new Set<string>()
  for (const [characterId, index] of Object.entries(chats.index.characters)) {
    if (!cards.has(characterId))
      throw new Error('A chat refers to a missing character.')
    if (index.activeSessionId && !Object.hasOwn(index.sessions, index.activeSessionId))
      throw new Error('The active chat session is missing.')
    for (const [sessionId, meta] of Object.entries(index.sessions)) {
      const record = chats.sessions[sessionId]
      if (sessions.has(sessionId) || !record || meta.sessionId !== sessionId || record.meta.sessionId !== sessionId
        || meta.characterId !== characterId || record.meta.characterId !== characterId
        || meta.userId !== identity.userId || record.meta.userId !== identity.userId) {
        throw new Error('Chat session references are inconsistent.')
      }
      sessions.add(sessionId)
    }
  }
  if (sessions.size !== Object.keys(chats.sessions).length)
    throw new Error('Backup contains an unindexed chat session.')
  const settings = v.parse(v.array(v.tuple([v.string(), v.string()])), json('identity/settings.json'))
  if (new Set(settings.map(([key]) => key)).size !== settings.length
    || settings.some(([key]) => !backupSettingsKeys.includes(key))) {
    throw new Error('Backup contains unsupported or duplicate settings.')
  }
  const skills = v.parse(v.array(skillReviewSchema), json('skills/registry.json'))
  if (new Set(skills.map(skill => skill.toolId)).size !== skills.length)
    throw new Error('Backup contains duplicate skills.')
  for (const skill of skills) {
    // Only the exact built-in revision has no filesystem artifact. A user
    // revision with the same identifier must pass ordinary source checks.
    if (skill.toolId === builtInSkillArtifact.toolId && skill.contentHash === builtInSkillArtifact.contentHash)
      continue
    const sourcePath = `skills/${skill.toolId}/source.mjs`
    const source = byPath.get(sourcePath)
    if (!source || contentHashOf(new TextDecoder().decode(source.data)) !== skill.contentHash)
      throw new Error(`Skill source does not match its recorded hash: ${skill.toolId}`)
    if (skill.reviewedHash && skill.reviewedHash !== skill.contentHash)
      throw new Error(`Skill review does not match its source: ${skill.toolId}`)
    if (skill.selftest) {
      const selftestPath = `skills/${skill.toolId}/selftest.mjs`
      const selftest = byPath.get(selftestPath)
      if (!selftest || contentHashOf(new TextDecoder().decode(selftest.data)) !== skill.selftest.contentHash)
        throw new Error(`Skill self-test does not match its recorded evidence: ${skill.toolId}`)
    }
    required.add(sourcePath)
    required.add(`skills/${skill.toolId}/meta.json`)
    if (skill.selftest)
      required.add(`skills/${skill.toolId}/selftest.mjs`)
  }
  const outbox = v.parse(v.object({ userId: idSchema, memory: v.array(v.unknown()), chat: v.array(v.unknown()), tombstones: v.array(v.string()) }), json('outbox/held.json'))
  if (outbox.userId !== identity.userId)
    throw new Error('The outbox belongs to a different identity.')
  for (const path of required) {
    if (!byPath.has(path))
      throw new Error(`Required backup file is missing: ${path}`)
  }
  for (const entry of backup.entries) {
    if (!required.has(entry.path) && !/^journal\/[a-f0-9]{32}\.jsonl$/.test(entry.path))
      throw new Error(`Backup contains an unsupported domain file: ${entry.path}`)
  }
  return { identity, chats, plans, settings, skills, outbox }
}
