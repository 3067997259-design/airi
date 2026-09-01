import { describe, expect, it } from 'vitest'

import { buildCommandSection, parseBtwCommand, parseChatCommand } from './chat-command'

describe('chat commands', () => {
  it('parses only a leading plan or goal command with a subject', () => {
    expect(parseChatCommand('/plan Ship the release')).toEqual({ name: 'plan', subject: 'Ship the release' })
    expect(parseChatCommand('/goal Build durable memory\nwith evidence')).toEqual({ name: 'goal', subject: 'Build durable memory\nwith evidence' })
    expect(parseChatCommand('please /plan later')).toBeUndefined()
    expect(parseChatCommand('/plan')).toBeUndefined()
  })

  it('parses a leading btw question and rejects non-leading or empty forms', () => {
    expect(parseBtwCommand('/btw what are you doing?')).toBe('what are you doing?')
    expect(parseBtwCommand('/btw\nmulti\nline')).toBe('multi\nline')
    expect(parseBtwCommand('please /btw later')).toBeUndefined()
    expect(parseBtwCommand('/btw')).toBeUndefined()
    expect(parseBtwCommand('/btw   ')).toBeUndefined()
  })

  it('builds distinct bounded instructions for session and long horizons', () => {
    expect(buildCommandSection({ name: 'plan', subject: 'Ship it' })).toContain('horizon `session`')
    const goal = buildCommandSection({ name: 'goal', subject: 'Maintain it' })
    expect(goal).toContain('horizon `long`')
    expect(goal).toContain('Keep the same plan id')
  })
})
