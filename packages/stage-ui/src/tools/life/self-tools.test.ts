import { describe, expect, it } from 'vitest'

import { createSelfDecisionTool, parseSelfDecision } from './self-tools'

describe('self_decide', () => {
  it('exposes one bounded object schema for all three decisions', () => {
    const decisionTool = createSelfDecisionTool()
    const parameters = decisionTool.function.parameters as {
      properties: Record<string, { enum?: string[], maxLength?: number }>
      required: string[]
      additionalProperties: boolean
    }

    expect(decisionTool.function.name).toBe('self_decide')
    expect(parameters.required).toEqual(['action', 'reason'])
    expect(parameters.properties.action?.enum).toEqual(['speak', 'note', 'silence'])
    expect(parameters.properties.text?.maxLength).toBe(2000)
    expect(parameters.additionalProperties).toBe(false)
  })

  it('accepts one explicit speak, note, or silence decision', () => {
    expect(parseSelfDecision({ action: 'speak', text: 'Hello.', reason: 'A new event is worth sharing.' })).toEqual({
      action: 'speak',
      text: 'Hello.',
      reason: 'A new event is worth sharing.',
    })
    expect(parseSelfDecision({ action: 'note', text: 'Keep this.', reason: 'This is private.' })).toEqual({
      action: 'note',
      text: 'Keep this.',
      reason: 'This is private.',
    })
    expect(parseSelfDecision({ action: 'silence', reason: 'There is nothing new.' })).toEqual({
      action: 'silence',
      reason: 'There is nothing new.',
    })
  })

  it('rejects missing text and text attached to silence', () => {
    expect(() => parseSelfDecision({ action: 'speak', reason: 'Missing text.' })).toThrow('Invalid self decision')
    expect(() => parseSelfDecision({ action: 'silence', text: 'Do not say this.', reason: 'Unexpected text.' })).toThrow('Invalid self decision')
  })
})
