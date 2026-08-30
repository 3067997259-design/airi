import { describe, expect, it } from 'vitest'

import { buildMirrorSnapshot, mirrorTools } from './mirror-tools'

const PARAMETERS = [
  { id: 'HairFront', name: 'Hair (front loose)', group: null, min: 0, max: 1, default: 0, value: 1, active: true },
  { id: 'EarType', name: 'Ear shape', group: 'ears', min: 0, max: 2, default: 0, value: 2, active: true },
  { id: 'CoatPinned', name: 'Coat (pinned back)', group: 'coat', min: 0, max: 1, default: 0, value: 0, active: false },
]

describe('buildMirrorSnapshot', () => {
  it('describes held parameters with readable on/off and range labels', () => {
    const snapshot = buildMirrorSnapshot({
      modelId: 'kumo',
      activeExpressions: [{ name: 'Smile', value: 0.8 }],
      groups: [
        { id: 'ears', name: 'Ears', parameterCount: 1 },
        { id: 'coat', name: 'Coat', parameterCount: 1 },
      ],
      parameters: PARAMETERS,
    })

    expect(snapshot).toContain('Model on stage: kumo')
    expect(snapshot).toContain('Named expressions in use: Smile (0.80)')
    expect(snapshot).toContain('Hair (front loose): on')
    expect(snapshot).toContain('Ear shape [Ears]: value 2.00 (range 0-2)')
    expect(snapshot).toContain('Exact values:')
  })

  it('reports the defaulted look when nothing is held', () => {
    const snapshot = buildMirrorSnapshot({
      activeExpressions: [],
      groups: [],
      parameters: [{ id: 'A', name: 'A', group: null, min: 0, max: 1, default: 0, value: 0, active: false }],
    })
    expect(snapshot).toContain('Appearance: all exposed parameters at their default')
  })

  it('renders the mood phrase from valence and arousal', () => {
    const snapshot = buildMirrorSnapshot({
      activeExpressions: [],
      groups: [],
      parameters: [],
      mood: { valence: 0.6, arousal: 0.1 },
    })
    expect(snapshot).toContain('Mood: warm and positive, calm')
    expect(snapshot).toContain('valence 0.60, arousal 0.10')
  })

  it('omits the mood section when no mood port is wired', () => {
    const snapshot = buildMirrorSnapshot({
      activeExpressions: [],
      groups: [],
      parameters: [],
    })
    expect(snapshot).not.toContain('Mood:')
  })
})

describe('mirrorTools', () => {
  it('exposes a zero-parameter mirror tool', async () => {
    const [mirror] = await mirrorTools()
    expect(mirror.function.name).toBe('mirror')
    const parameters = mirror.function.parameters as { properties: Record<string, unknown> }
    expect(Object.keys(parameters.properties)).toHaveLength(0)
  })
})
