import { describe, expect, it } from 'vitest'

import {
  CHAT_CONTEXT_LINE_MAX_CHARS,
  chatCommandEventsOf,
  chatContextOf,
  chatEventOf,
  classifyChatEvent,
  isContextEligible,
  nextChatCursor,
  parseChatCommandsConfig,
} from './chat-commands'

const CONFIG = {
  enabled: true,
  admins: ['Steve'],
  blocked: ['Griefer'],
  mentionlessSampleRate: 0.2,
  contextLines: 5,
}

describe('parseChatCommandsConfig', () => {
  it('returns undefined for a missing config and safe defaults for an empty one', () => {
    expect(parseChatCommandsConfig(undefined)).toBeUndefined()
    expect(parseChatCommandsConfig({})).toEqual({
      enabled: false,
      admins: [],
      blocked: [],
      mentionlessSampleRate: 0.2,
      contextLines: 5,
    })
  })

  it('trims names, drops blanks, and deduplicates case-insensitively', () => {
    expect(parseChatCommandsConfig({ enabled: true, admins: [' Steve ', 'steve', '', 7], blocked: ['Griefer', 'griefer'] }))
      .toEqual({ enabled: true, admins: ['Steve'], blocked: ['Griefer'], mentionlessSampleRate: 0.2, contextLines: 5 })
  })

  it('clamps the sample rate and the context line count', () => {
    expect(parseChatCommandsConfig({ mentionlessSampleRate: 9, contextLines: 99 }))
      .toMatchObject({ mentionlessSampleRate: 1, contextLines: 20 })
    expect(parseChatCommandsConfig({ mentionlessSampleRate: -1, contextLines: -3 }))
      .toMatchObject({ mentionlessSampleRate: 0, contextLines: 0 })
    expect(parseChatCommandsConfig({ mentionlessSampleRate: 'x', contextLines: 'y' }))
      .toMatchObject({ mentionlessSampleRate: 0.2, contextLines: 5 })
  })
})

describe('nextChatCursor', () => {
  it('advances with a growing ring and keeps the cursor without an id', () => {
    expect(nextChatCursor(3, 8)).toBe(8)
    expect(nextChatCursor(8, undefined)).toBe(8)
  })

  // ROOT CAUSE:
  //
  // Live 2026-09-14 the game client restarted and its event ring ids reset
  // (max 8) while the app cursor stayed at 32 from the previous session; every
  // new chat message sat below the cursor and was skipped, so the chat link
  // went permanently deaf. A backwards lastId now reseeds the cursor.
  it('reseeds when the ring restarts below the cursor', () => {
    expect(nextChatCursor(32, 8)).toBe(0)
  })
})

describe('chatEventOf', () => {
  it('normalizes the client shape and strips the sender prefix', () => {
    expect(chatEventOf({ id: 7, type: 'chat', data: { sender: 'Steve', uuid: 'u1', text: '<Steve> AIRI 过来' } }))
      .toEqual({ id: 7, sender: 'Steve', senderUuid: 'u1', text: 'AIRI 过来' })
  })

  it('normalizes the dedicated-server shape', () => {
    expect(chatEventOf({ id: 8, type: 'chat', data: { player: 'Alex', uuid: 'u2', text: 'hello' } }))
      .toEqual({ id: 8, sender: 'Alex', senderUuid: 'u2', text: 'hello' })
  })

  it('rejects non-chat, malformed, and senderless events', () => {
    expect(chatEventOf({ id: 9, type: 'player_join', data: { player: 'Alex', text: 'x' } })).toBeUndefined()
    expect(chatEventOf({ id: 10, type: 'chat', data: { text: 'no sender' } })).toBeUndefined()
    expect(chatEventOf({ id: 11, type: 'chat', data: null })).toBeUndefined()
    expect(chatEventOf({ type: 'chat', data: { sender: 'Steve', text: 'no id' } })).toBeUndefined()
  })
})

describe('chatCommandEventsOf', () => {
  it('keeps well-formed chat events and carries the cursor', () => {
    const record = {
      lastId: 42,
      events: [
        { id: 7, type: 'chat', data: { sender: 'Steve', text: '<Steve> AIRI 过来' } },
        { id: 8, type: 'player_join', data: { sender: 'Steve', text: 'x' } },
        { id: 9, type: 'chat', data: { text: 'no sender' } },
      ],
    }
    expect(chatCommandEventsOf(record)).toEqual({
      lastId: 42,
      events: [{ id: 7, sender: 'Steve', senderUuid: '', text: 'AIRI 过来' }],
    })
    expect(chatCommandEventsOf(undefined)).toEqual({ events: [] })
  })
})

describe('classifyChatEvent', () => {
  const event = { id: 1, sender: 'Steve', senderUuid: 'u1', text: 'AIRI 到这里来' }
  const noRandom = () => 0.9

  it('rejects everything while disabled, malformed, or from herself', () => {
    expect(classifyChatEvent(event, { ...CONFIG, enabled: false }, {}, noRandom)).toEqual({ eligible: false, reason: 'disabled' })
    expect(classifyChatEvent({ ...event, text: '  ' }, CONFIG, {}, noRandom)).toEqual({ eligible: false, reason: 'malformed' })
    expect(classifyChatEvent(event, CONFIG, { uuid: 'u1' }, noRandom)).toEqual({ eligible: false, reason: 'self' })
  })

  it('blocks the blocklist even when the name is also an admin', () => {
    expect(classifyChatEvent({ ...event, sender: 'Griefer' }, CONFIG, {}, noRandom)).toEqual({ eligible: false, reason: 'blocked' })
    expect(classifyChatEvent({ ...event, sender: 'Griefer' }, { ...CONFIG, admins: ['Griefer'] }, {}, noRandom))
      .toEqual({ eligible: false, reason: 'blocked' })
  })

  it('delivers admin messages without a mention, unless escaped', () => {
    expect(classifyChatEvent({ ...event, text: '去砍树' }, CONFIG, {}, noRandom))
      .toEqual({ eligible: true, trigger: 'admin', text: '去砍树' })
    expect(classifyChatEvent({ ...event, text: '\\别理我' }, CONFIG, {}, noRandom))
      .toEqual({ eligible: false, reason: 'escaped' })
  })

  it('delivers mention messages from everyone else', () => {
    expect(classifyChatEvent(event, { ...CONFIG, admins: [] }, {}, noRandom))
      .toEqual({ eligible: true, trigger: 'mention', text: 'AIRI 到这里来' })
  })

  it('samples unmentioned messages from everyone else', () => {
    const config = { ...CONFIG, admins: [] }
    expect(classifyChatEvent({ ...event, sender: 'Alex', text: '大家来挖矿' }, config, {}, () => 0.1))
      .toEqual({ eligible: true, trigger: 'mentionless-sample', text: '大家来挖矿' })
    expect(classifyChatEvent({ ...event, sender: 'Alex', text: '大家来挖矿' }, config, {}, () => 0.5))
      .toEqual({ eligible: false, reason: 'no-trigger' })
  })

  it('treats a backslash prefix as normal text for non-admins', () => {
    expect(classifyChatEvent({ ...event, sender: 'Alex', text: '\\hello' }, { ...CONFIG, admins: [] }, {}, () => 0.9))
      .toEqual({ eligible: false, reason: 'no-trigger' })
  })
})

describe('context helpers', () => {
  const line = { id: 1, sender: 'Steve', senderUuid: '', text: 'hello' }

  it('keeps non-blocked lines out of context only when they are blocked or her own', () => {
    expect(isContextEligible(line, CONFIG, {})).toBe(true)
    expect(isContextEligible({ ...line, sender: 'Griefer' }, CONFIG, {})).toBe(false)
    expect(isContextEligible({ ...line, senderUuid: 'u1' }, CONFIG, { uuid: 'u1' })).toBe(false)
    expect(isContextEligible({ ...line, text: '  ' }, CONFIG, {})).toBe(false)
  })

  it('takes the last lines and truncates long ones', () => {
    const buffer = Array.from({ length: 8 }, (_, index) => ({ sender: 'S', text: `line-${index}` }))
    expect(chatContextOf(buffer, 3).map(entry => entry.text)).toEqual(['line-5', 'line-6', 'line-7'])
    expect(chatContextOf(buffer, 0)).toEqual([])
    expect(chatContextOf([{ sender: 'S', text: 'x'.repeat(CHAT_CONTEXT_LINE_MAX_CHARS + 50) }], 1)[0].text)
      .toHaveLength(CHAT_CONTEXT_LINE_MAX_CHARS)
  })
})
