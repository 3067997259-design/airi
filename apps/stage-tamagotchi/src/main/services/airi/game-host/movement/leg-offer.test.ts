import { describe, expect, it } from 'vitest'

import { shouldOfferNextLeg } from './leg-offer'

/**
 * Leg-offer regressions (ab-23 repair plan, A1/A5).
 *
 * ROOT CAUSE the fixture had: the offer condition accepted `state !==
 * 'running'`, so a terminated route with an unfinished leg was handed over to
 * again. The rule is now terminal-first: the frozen route failure and the
 * terminal states refuse the offer, and only a holding client accepts the
 * default next leg.
 */
describe('shouldOfferNextLeg', () => {
  const base = {
    routeFailed: false,
    state: 'running',
    hasNextLeg: true,
    segmentMode: 'default',
  }

  it('refuses the next leg once the route failure is frozen', () => {
    const decision = shouldOfferNextLeg({ ...base, routeFailed: true, state: 'terminated', holding: false })
    expect(decision.offer).toBe(false)
    expect(decision.reason).toBe('route_ended')
  })

  it('refuses a terminated state even without a frozen failure', () => {
    const decision = shouldOfferNextLeg({ ...base, state: 'terminated' })
    expect(decision.offer).toBe(false)
    expect(decision.reason).toBe('terminal_state')
  })

  it('refuses a revoked state', () => {
    const decision = shouldOfferNextLeg({ ...base, state: 'revoked' })
    expect(decision.offer).toBe(false)
    expect(decision.reason).toBe('terminal_state')
  })

  it('offers the next leg only while the client holds in the default mode', () => {
    expect(shouldOfferNextLeg({ ...base, holding: true }).offer).toBe(true)
    expect(shouldOfferNextLeg({ ...base, holding: false }).offer).toBe(false)
    expect(shouldOfferNextLeg({ ...base }).offer).toBe(false)
  })

  it('keeps the timing perturbations for a live route', () => {
    expect(shouldOfferNextLeg({ ...base, segmentMode: 'early', sinceSubmitMs: 900 }).offer).toBe(true)
    expect(shouldOfferNextLeg({ ...base, segmentMode: 'early', sinceSubmitMs: 100 }).offer).toBe(false)
    expect(shouldOfferNextLeg({ ...base, segmentMode: 'late', heldForMs: 4_000, lateMs: 3_000 }).offer).toBe(true)
    expect(shouldOfferNextLeg({ ...base, segmentMode: 'late', heldForMs: 1_000, lateMs: 3_000 }).offer).toBe(false)
    expect(shouldOfferNextLeg({ ...base, segmentMode: 'timeout' }).offer).toBe(false)
  })

  it('refuses when there is no leg left', () => {
    const decision = shouldOfferNextLeg({ ...base, hasNextLeg: false })
    expect(decision.offer).toBe(false)
    expect(decision.reason).toBe('no_next_leg')
  })
})
