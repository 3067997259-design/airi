import { describe, expect, it } from 'vitest'

import { buildStimulusBrief } from './life-mode'

describe('buildStimulusBrief', () => {
  it('assembles mood, spotlight, and recent facts into a structured brief', () => {
    const brief = buildStimulusBrief({
      mood: { valence: 0.6, arousal: 0.2 },
      spotlight: 'plan step "step-1" completed',
      recentEvents: ['read ok: 12 lines', 'appearance changed: HairFront → 1'],
    })

    expect(brief).toContain('[Stimulus brief')
    expect(brief).toContain('Mood: warm')
    expect(brief).toContain('Spotlight: plan step "step-1" completed')
    expect(brief).toContain('Recent activity: read ok: 12 lines | appearance changed: HairFront → 1')
  })

  it('labels cool moods and omits optional sections', () => {
    const brief = buildStimulusBrief({
      mood: { valence: -0.7, arousal: 0.8 },
      recentEvents: [],
    })
    expect(brief).toContain('Mood: cool')
    expect(brief).not.toContain('Spotlight:')
    expect(brief).not.toContain('Recent activity:')
  })

  it('caps the fact list to five entries', () => {
    const brief = buildStimulusBrief({
      recentEvents: Array.from({ length: 8 }, (_, i) => `fact-${i}`),
    })
    expect(brief).toContain('fact-0 | fact-1 | fact-2 | fact-3 | fact-4')
    expect(brief).not.toContain('fact-5')
  })
})
