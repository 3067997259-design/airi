/**
 * Whether the host may offer the next leg of a segmented arm (ab-23 repair
 * plan, A1/A5).
 *
 * The rule used to be "holding, or the state is not running", which treated a
 * terminated route with an unfinished leg as handover-ready. Terminal states
 * come first now: once the route failed or ended, no ordinary next leg is
 * submitted — the ending phase observes the client's recovery instead.
 */
export interface LegOfferInput {
  /** The first route failure is frozen for the whole arm. */
  routeFailed: boolean
  /** Client session state, lowercase as the port normalizes it. */
  state: string
  /** The client is in its post-path hold. */
  holding?: boolean
  /** There is another leg left to offer. */
  hasNextLeg: boolean
  /** Segmented-arm perturbation mode. */
  segmentMode: string
  /** Milliseconds since the previous submit (early mode). */
  sinceSubmitMs?: number
  /** Milliseconds the client has been holding (late mode). */
  heldForMs?: number
  /** The late mode's delay. */
  lateMs?: number
}

export interface LegOfferDecision {
  offer: boolean
  reason: 'no_next_leg' | 'route_ended' | 'terminal_state' | 'early' | 'late' | 'timeout' | 'holding' | 'not_holding'
}

const TERMINAL_STATES = new Set(['terminated', 'revoked'])

/** The single decision point for offering the next leg. */
export function shouldOfferNextLeg(input: LegOfferInput): LegOfferDecision {
  if (!input.hasNextLeg)
    return { offer: false, reason: 'no_next_leg' }
  if (input.routeFailed)
    return { offer: false, reason: 'route_ended' }
  if (TERMINAL_STATES.has(input.state))
    return { offer: false, reason: 'terminal_state' }
  switch (input.segmentMode) {
    case 'early':
      return { offer: (input.sinceSubmitMs ?? 0) > 800, reason: 'early' }
    case 'late':
      return { offer: (input.heldForMs ?? 0) >= (input.lateMs ?? 3_000), reason: 'late' }
    case 'timeout':
      return { offer: false, reason: 'timeout' }
    default:
      return { offer: input.holding === true, reason: input.holding === true ? 'holding' : 'not_holding' }
  }
}
