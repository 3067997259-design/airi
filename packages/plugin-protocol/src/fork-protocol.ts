/**
 * Fork protocol declaration carried on a module announce. Both sides absent
 * means the connection behaves exactly like upstream. The field is additive:
 * it never changes the meaning of existing announce fields.
 */
export interface ForkProtocolDescriptor {
  /** Fork protocol version. Starts at 1. Higher means newer. */
  version: number
  /**
   * Identifiers of upstream Next Steps items this side implements, for example
   * 'capability-registry' | 'node-worker' | 'remote-plugins'. Unknown entries
   * are ignored so a newer peer can talk to an older one.
   */
  extensions: string[]
}

/**
 * Versions this fork implements. CP-0 ships version 1.
 */
export const forkProtocolSupportedVersions = [1] as const

/**
 * Result of one announce-time negotiation, stored per module.
 */
export interface ForkNegotiationResult {
  /** Highest version both sides support, or null when incompatible. */
  agreedVersion: number | null
  /** Extensions present in both sides' lists. */
  agreedExtensions: string[]
  /** Adopted only when agreedVersion is not null. */
  mode: 'exact' | 'downgraded' | 'absent'
}

/**
 * Per-module negotiation record kept on the receiving side. The record lives
 * as long as the module identity. `mode: 'absent'` records are written too, so
 * later batches can tell "never checked" from "checked and peer is upstream".
 */
export interface ModuleForkState {
  /** Module identity used as the negotiation record key. */
  moduleId: string
  /** Present only after a successful negotiation. */
  negotiation?: ForkNegotiationResult
}

/**
 * Raised at the announce boundary when no common fork protocol version exists.
 */
export class ProtocolVersionIncompatibleError extends Error {
  /** Fork protocol version declared by the receiving side. */
  readonly localVersion: number
  /** Fork protocol version declared by the sending side. */
  readonly remoteVersion: number
  /** Versions the receiving side supports. */
  readonly localSupported: number[]
  /** Versions the sending side supports. */
  readonly remoteSupported: number[]

  constructor(input: {
    localVersion: number
    remoteVersion: number
    localSupported: number[]
    remoteSupported: number[]
  }) {
    const localVersions = input.localSupported.join(', ') || 'none'
    const remoteVersions = input.remoteSupported.join(', ') || 'none'
    super(
      `Fork protocol versions incompatible: local declares ${input.localVersion} (supports ${localVersions}), remote declares ${input.remoteVersion} (supports ${remoteVersions})`,
    )
    this.name = 'ProtocolVersionIncompatibleError'
    this.localVersion = input.localVersion
    this.remoteVersion = input.remoteVersion
    this.localSupported = input.localSupported
    this.remoteSupported = input.remoteSupported
  }
}

/**
 * Inputs for one fork protocol negotiation run on the receiving side.
 */
export interface ForkNegotiationInput {
  /** The receiving side's own declaration, used as the negotiation baseline. */
  local: ForkProtocolDescriptor
  /** Versions the receiving side can run, for example {@link forkProtocolSupportedVersions}. */
  localSupported: readonly number[]
  /** The peer's declaration. Omitted when the peer is upstream. */
  remote?: ForkProtocolDescriptor
}

/**
 * Negotiates the fork protocol version and extensions at the announce boundary.
 *
 * The receiving side runs this function when an announce arrives. The sending
 * side only declares its own capabilities and never runs negotiation. The
 * function is side-effect free: it returns a result or throws; callers decide
 * what to store and whether to tear down the connection.
 *
 * Rules:
 * - A missing peer declaration yields `mode: 'absent'` and never throws.
 * - The agreed version is the peer's declared version when the receiving side
 *   supports it. Mode is `'exact'` when it equals the receiving side's newest
 *   supported version, otherwise `'downgraded'`.
 * - An empty version intersection throws {@link ProtocolVersionIncompatibleError}.
 * - `agreedExtensions` is the intersection of both lists. Unknown entries in
 *   either list are ignored.
 *
 * @returns The negotiation result. Throws when no common version exists.
 *
 * @example
 * negotiateForkProtocol({ local: { version: 1, extensions: [] }, localSupported: [1], remote: { version: 1, extensions: ['capability-registry'] } })
 * // => { agreedVersion: 1, agreedExtensions: [], mode: 'exact' }
 */
export function negotiateForkProtocol(input: ForkNegotiationInput): ForkNegotiationResult {
  const { local, localSupported, remote } = input
  if (!remote) {
    return {
      agreedVersion: null,
      agreedExtensions: [],
      mode: 'absent',
    }
  }

  if (!localSupported.includes(remote.version)) {
    throw new ProtocolVersionIncompatibleError({
      localVersion: local.version,
      remoteVersion: remote.version,
      localSupported: [...localSupported],
      remoteSupported: [remote.version],
    })
  }

  const highestLocal = Math.max(...localSupported)
  return {
    agreedVersion: remote.version,
    agreedExtensions: local.extensions.filter(extension => remote.extensions.includes(extension)),
    mode: remote.version === highestLocal ? 'exact' : 'downgraded',
  }
}
