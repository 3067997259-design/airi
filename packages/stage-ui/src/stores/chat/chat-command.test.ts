import { describe, expect, it } from 'vitest'

import { buildCommandSection, parseChatCommand } from './chat-command'

describe('chat commands', () => {
  it('parses only a leading plan or goal command with a subject', () => {
    expect(parseChatCommand('/plan Ship the release')).toEqual({ name: 'plan', subject: 'Ship the release' })
    expect(parseChatCommand('/goal Build durable memory\nwith evidence')).toEqual({ name: 'goal', subject: 'Build durable memory\nwith evidence' })
    expect(parseChatCommand('please /plan later')).toBeUndefined()
    expect(parseChatCommand('/plan')).toBeUndefined()
  })

  it('builds distinct bounded instructions for session and long horizons', () => {
    expect(buildCommandSection({ name: 'plan', subject: 'Ship it' })).toContain('horizon `session`')
    const goal = buildCommandSection({ name: 'goal', subject: 'Maintain it' })
    expect(goal).toContain('horizon `long`')
    expect(goal).toContain('Keep the same plan id')
  })
})
