import { describe, expect, it } from 'vitest'

import { createJournalStore, journalFromJSONL, journalToJSONL } from './store'

describe('journal store', () => {
  it('enforces header-first', () => {
    const store = createJournalStore('s1')
    expect(() => store.append({ type: 'user/message', text: 'hi', timestamp: 1 })).toThrow(/first event must be session\/header/)
  })

  it('enforces exactly one header at seq 0', () => {
    const store = createJournalStore('s1')
    store.append({ type: 'session/header', sessionId: 's1', createdAt: 1, delegationDepth: 0 })
    expect(() => store.append({ type: 'session/header', sessionId: 's1', createdAt: 2, delegationDepth: 0 })).toThrow(/first event/)
  })

  it('rejects a header for another session', () => {
    const store = createJournalStore('s1')
    expect(() => store.append({ type: 'session/header', sessionId: 's2', createdAt: 1, delegationDepth: 0 }))
      .toThrow(/does not match store s1/)
  })

  it('assigns contiguous seq starting at 0', () => {
    const store = createJournalStore('s1')
    store.append({ type: 'session/header', sessionId: 's1', createdAt: 1, delegationDepth: 0 })
    const second = store.append({ type: 'user/message', text: 'hi', timestamp: 1 })
    const third = store.append({ type: 'user/message', text: 'again', timestamp: 2 })
    expect(second.seq).toBe(1)
    expect(third.seq).toBe(2)
    expect(store.nextSeq).toBe(3)
    expect(store.readAll().map(event => event.seq)).toEqual([0, 1, 2])
  })

  it('reads since a seq without leaking earlier events', () => {
    const store = createJournalStore('s1')
    store.append({ type: 'session/header', sessionId: 's1', createdAt: 1, delegationDepth: 0 })
    store.append({ type: 'user/message', text: 'a', timestamp: 1 })
    store.append({ type: 'tool/call', toolName: 'read', args: { path: 'x' } })
    const since = store.readSince(1)
    expect(since.map(event => event.seq)).toEqual([2])
  })

  // ROOT CAUSE:
  //
  // Shallow copies left nested tool arguments shared with the append caller
  // and journal readers. Either side could rewrite an earlier journal event.
  it('keeps nested event data immutable across append and reads', () => {
    const store = createJournalStore('s1')
    store.append({ type: 'session/header', sessionId: 's1', createdAt: 1, delegationDepth: 0 })
    const args = { request: { path: 'original' } }
    const appended = store.append({ type: 'tool/call', toolName: 'read', args })

    args.request.path = 'changed-by-caller'
    if (appended.type === 'tool/call')
      (appended.args as typeof args).request.path = 'changed-return-value'

    const firstRead = store.readAll()
    const toolCall = firstRead[1]
    expect(toolCall?.type).toBe('tool/call')
    if (toolCall?.type !== 'tool/call')
      throw new Error('Expected a tool/call journal event.')
    expect((toolCall.args as typeof args).request.path).toBe('original')

    ;(toolCall.args as typeof args).request.path = 'changed-by-reader'
    const secondRead = store.readAll()[1]
    expect(secondRead?.type).toBe('tool/call')
    if (secondRead?.type === 'tool/call')
      expect((secondRead.args as typeof args).request.path).toBe('original')
  })

  it('round-trips JSONL and rejects broken seq continuity', () => {
    const store = createJournalStore('s1')
    store.append({ type: 'session/header', sessionId: 's1', createdAt: 1, delegationDepth: 0 })
    store.append({ type: 'assistant/chunk', text: 'hello' })
    store.append({ type: 'assistant/done' })

    const text = journalToJSONL(store.readAll())
    const parsed = journalFromJSONL(text)
    expect(parsed).toEqual(store.readAll())

    const tampered = text.replace('"seq":2', '"seq":3')
    expect(() => journalFromJSONL(tampered)).toThrow(/breaks continuity/)
  })

  it('rejects a JSONL stream that starts without a header', () => {
    expect(() => journalFromJSONL(JSON.stringify({ type: 'user/message', seq: 0, text: 'x', timestamp: 1 }))).toThrow(/first event must be session\/header/)
  })
})
