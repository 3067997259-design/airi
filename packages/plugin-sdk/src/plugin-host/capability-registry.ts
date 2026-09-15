/**
 * Capability registry: the authoritative readiness snapshot plus incremental
 * change notifications, implemented to the CP-1 fork contract.
 *
 * The registry owns capability state and nothing else. It has no host side
 * effects: it never starts or stops modules and it never drives scheduling.
 * The host and any consumer read readiness from {@link CapabilityRegistry.snapshot}
 * or {@link CapabilityRegistry.resolve}; change notifications are incremental
 * signals that a late consumer may always fall back to snapshotting again.
 *
 * Use when:
 * - The host needs one place to announce, ready, degrade, and withdraw capabilities
 * - A module declares runtime capability requirements via `allOf` / `anyOf` / `predicate`
 * - Consumers need a replay-safe readiness answer without missing a race
 *
 * Expects:
 * - Records are keyed by `hostId:instanceId|*:capabilityId`; the same key is
 *   overwritten by later announces
 * - `withdrawn` is a terminal record kept under its key until an explicit
 *   re-announce replaces it
 *
 * Returns:
 * - Revision-monotonic snapshots, typed resolutions, and idempotent subscriptions
 */

/**
 * Upstream baseline, implemented verbatim.
 *
 * Describes one capability record owned by the registry.
 */
export interface CapabilityRecord {
  /** Stable capability id, for example `game.minecraft.control`. */
  capabilityId: string
  /** Module that provides this capability. Doubles as the consumer id for observer tracking. */
  providerModuleId: string
  /** Host that owns the record, for example `extension-host`. */
  hostId: string
  /** Optional instance scope; omitted records live under the `*` wildcard scope. */
  instanceId?: string
  /** Runtime that provides the capability. */
  runtime: 'electron' | 'web' | 'pocket' | 'node'
  /** Current lifecycle state. */
  state: 'announced' | 'ready' | 'degraded' | 'withdrawn'
  /** Optional capability version published by the provider. */
  version?: string
  /** Optional provider-reported health. */
  health?: 'ok' | 'degraded' | 'unknown'
  /** Free-form provider metadata. */
  metadata?: Record<string, unknown>
}

/** One capability lifecycle state literal from {@link CapabilityRecord}. */
export type CapabilityState = CapabilityRecord['state']
/** One capability runtime literal from {@link CapabilityRecord}. */
export type CapabilityRuntime = CapabilityRecord['runtime']
/** One capability health literal from {@link CapabilityRecord}. */
export type CapabilityHealth = NonNullable<CapabilityRecord['health']>

/**
 * Upstream baseline, implemented verbatim.
 *
 * Describes what a module requires before it can become ready.
 */
export interface CapabilityRequirement {
  /** Every listed capability id must have a ready record. */
  allOf?: string[]
  /** At least one listed capability id must have a ready record. */
  anyOf?: string[]
  /** Evaluated against every ready record at resolve time; never cached. */
  predicate?: (record: CapabilityRecord) => boolean
  /** Wall-clock milliseconds before a wait is considered unsatisfied. @default 15000 */
  timeoutMs?: number
}

/**
 * Immutable point-in-time view of the whole registry.
 */
export interface CapabilitySnapshot {
  /** Snapshot sequence; increments on every accepted transition. */
  revision: number
  /** Wall-clock time the snapshot was assembled. */
  asOf: number
  /** Defensive copies of every record, in insertion order. */
  records: CapabilityRecord[]
}

/**
 * Result of resolving one {@link CapabilityRequirement} against a snapshot.
 */
export interface CapabilityResolution {
  /** Whether every declared dimension of the requirement is satisfied. */
  satisfied: boolean
  /** Records that satisfy the requirement, in snapshot order. */
  matched: CapabilityRecord[]
  /** Required ids that have no ready record. */
  missing: string[]
}

/**
 * One incremental change emitted to {@link CapabilityRegistry.subscribe} listeners.
 */
export interface CapabilityChange {
  /** Registry revision after the change. */
  revision: number
  /** Defensive copy of the changed record. */
  record: CapabilityRecord
  /** `upsert` for announce/ready/degrade, `withdrawn` for withdraw. */
  kind: 'upsert' | 'withdrawn'
}

/**
 * Identifies one registry record via the composite key.
 */
export interface CapabilityRecordKey {
  /** Capability id from {@link CapabilityRecord.capabilityId}. */
  capabilityId: string
  /** Host id from {@link CapabilityRecord.hostId}. */
  hostId: string
  /** Optional instance scope; omitted matches the `*` wildcard scope. */
  instanceId?: string
}

/**
 * Field-level patch applied while transitioning a record to a new state.
 */
export interface CapabilityPatch {
  /** Replaces the record version. */
  version?: string
  /** Replaces the record health. */
  health?: CapabilityHealth
  /** Replaces the record metadata. */
  metadata?: Record<string, unknown>
}

/**
 * Options for one {@link CapabilityRegistry} instance.
 */
export interface CapabilityRegistryOptions {
  /**
   * Consumer ids that must each announce at least one capability before
   * observer mode ends. @default ['game-host', 'skill-adapter']
   */
  observerConsumers?: string[]
}

/**
 * Raised when a state transition is not in the allowed set or targets an
 * unknown record. Illegal transitions are never silently ignored.
 */
export class CapabilityTransitionError extends Error {
  constructor(
    readonly recordKey: CapabilityRecordKey,
    readonly from: CapabilityState | null,
    readonly to: CapabilityState,
  ) {
    super(
      `Illegal capability state transition for \`${capabilityRecordKey(recordKey)}\`: \`${from ?? 'missing'}\` -> \`${to}\`.`,
    )
    this.name = 'CapabilityTransitionError'
  }
}

/**
 * Builds the composite record key string used by the registry store.
 *
 * @example
 * capabilityRecordKey({ capabilityId: 'game.minecraft.control', hostId: 'extension-host' })
 * // => 'extension-host:*:game.minecraft.control'
 */
export function capabilityRecordKey(key: CapabilityRecordKey): string {
  return `${key.hostId}:${key.instanceId ?? '*'}:${key.capabilityId}`
}

const allowedCapabilityTransitions: Record<CapabilityState, readonly CapabilityState[]> = {
  announced: ['announced', 'ready', 'withdrawn'],
  ready: ['ready', 'degraded', 'withdrawn'],
  degraded: ['degraded', 'ready', 'withdrawn'],
  withdrawn: ['announced'],
}

function canTransition(from: CapabilityState, to: CapabilityState): boolean {
  return allowedCapabilityTransitions[from].includes(to)
}

/** Type guard for one capability health literal from {@link CapabilityRecord}. */
export function isCapabilityHealth(value: unknown): value is CapabilityHealth {
  return value === 'ok' || value === 'degraded' || value === 'unknown'
}

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => cloneValue(item))
  }

  if (value && typeof value === 'object') {
    const copy: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      copy[key] = cloneValue(item)
    }
    return copy
  }

  return value
}

function cloneRecord(record: CapabilityRecord): CapabilityRecord {
  return {
    ...record,
    metadata: cloneValue(record.metadata) as Record<string, unknown> | undefined,
  }
}

function valueEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true
  }

  if (typeof a !== typeof b) {
    return false
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return false
    }
    return a.every((item, index) => valueEqual(item, b[index]))
  }

  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keysA = Object.keys(a)
    const keysB = Object.keys(b)
    if (keysA.length !== keysB.length) {
      return false
    }
    return keysA.every(
      key => key in b && valueEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    )
  }

  return false
}

function recordsEqual(a: CapabilityRecord, b: CapabilityRecord): boolean {
  return a.capabilityId === b.capabilityId
    && a.providerModuleId === b.providerModuleId
    && a.hostId === b.hostId
    && a.instanceId === b.instanceId
    && a.runtime === b.runtime
    && a.state === b.state
    && a.version === b.version
    && a.health === b.health
    && valueEqual(a.metadata, b.metadata)
}

interface StoredCapability {
  record: CapabilityRecord
  updatedAt: number
}

/**
 * Stateful snapshot store for capability readiness.
 *
 * Use when:
 * - The host or a consumer needs the authoritative readiness state
 * - Modules wait on capability requirements and must not miss a ready signal
 *
 * Expects:
 * - Callers go through {@link announce} / {@link ready} / {@link degrade} / {@link withdraw}
 *   for every state change
 * - Illegal transitions raise {@link CapabilityTransitionError} instead of being ignored
 *
 * Returns:
 * - Defensive snapshots and resolutions plus change notifications
 */
export class CapabilityRegistry {
  private readonly store = new Map<string, StoredCapability>()
  private readonly listeners = new Set<(change: CapabilityChange) => void>()
  private readonly observedConsumers = new Set<string>()
  private readonly observerConsumers: string[]
  private revision = 0

  constructor(options: CapabilityRegistryOptions = {}) {
    this.observerConsumers = [...(options.observerConsumers ?? ['game-host', 'skill-adapter'])]
  }

  /**
   * Declares a capability under the composite key and records its provider as
   * an observed consumer. Re-announcing an `announced` or `withdrawn` record
   * overwrites it; re-announcing a `ready`/`degraded` record is rejected.
   *
   * @returns A defensive copy of the stored `announced` record.
   */
  announce(input: Omit<CapabilityRecord, 'state'>): CapabilityRecord {
    const key = capabilityRecordKey(input)
    const existing = this.store.get(key)?.record
    const from: CapabilityState | null = existing?.state ?? null
    if (from !== null && !canTransition(from, 'announced')) {
      throw new CapabilityTransitionError(recordKeyOf(input), from, 'announced')
    }

    this.observedConsumers.add(input.providerModuleId)
    return this.write(key, {
      capabilityId: input.capabilityId,
      providerModuleId: input.providerModuleId,
      hostId: input.hostId,
      instanceId: input.instanceId,
      runtime: input.runtime,
      state: 'announced',
      version: input.version,
      health: input.health,
      metadata: input.metadata,
    }, 'upsert')
  }

  /**
   * Transitions an `announced` or `degraded` record to `ready`.
   *
   * @throws {@link CapabilityTransitionError} when the record is missing or the transition is illegal.
   * @returns A defensive copy of the stored `ready` record.
   */
  ready(key: CapabilityRecordKey, patch?: CapabilityPatch): CapabilityRecord {
    const existing = this.requireRecord(key, 'ready')
    this.assertTransition(key, existing.record.state, 'ready')
    return this.applyTransition(key, existing, 'ready', patch)
  }

  /**
   * Transitions a `ready` record to `degraded`.
   *
   * @throws {@link CapabilityTransitionError} when the record is missing or the transition is illegal.
   * @returns A defensive copy of the stored `degraded` record.
   */
  degrade(key: CapabilityRecordKey, patch?: CapabilityPatch): CapabilityRecord {
    const existing = this.requireRecord(key, 'degraded')
    this.assertTransition(key, existing.record.state, 'degraded')
    return this.applyTransition(key, existing, 'degraded', patch)
  }

  /**
   * Transitions an `announced`, `ready`, or `degraded` record to `withdrawn`.
   * The withdrawn record stays in the store until an explicit re-announce.
   *
   * @throws {@link CapabilityTransitionError} when the record is missing or the transition is illegal.
   * @returns A defensive copy of the stored `withdrawn` record.
   */
  withdraw(key: CapabilityRecordKey, patch?: CapabilityPatch): CapabilityRecord {
    const existing = this.requireRecord(key, 'withdrawn')
    this.assertTransition(key, existing.record.state, 'withdrawn')
    return this.applyTransition(key, existing, 'withdrawn', patch)
  }

  /**
   * Returns a defensive, revision-monotonic snapshot of every record.
   */
  snapshot(): CapabilitySnapshot {
    return {
      revision: this.revision,
      asOf: Date.now(),
      records: [...this.store.values()].map(({ record }) => cloneRecord(record)),
    }
  }

  /**
   * Whether a record exists under the key.
   */
  has(key: CapabilityRecordKey): boolean {
    return this.store.has(capabilityRecordKey(key))
  }

  /**
   * Returns a defensive copy of one record, or `undefined` when missing.
   */
  get(key: CapabilityRecordKey): CapabilityRecord | undefined {
    const stored = this.store.get(capabilityRecordKey(key))
    return stored ? cloneRecord(stored.record) : undefined
  }

  /**
   * Returns the wall-clock timestamp of the last accepted write for a key.
   */
  getUpdatedAt(key: CapabilityRecordKey): number | undefined {
    return this.store.get(capabilityRecordKey(key))?.updatedAt
  }

  /**
   * Resolves a requirement immediately against the current snapshot. Late
   * consumers always query this method before waiting so they never miss a
   * readiness signal.
   *
   * Semantics: `allOf` must all be ready, `anyOf` must have at least one ready
   * id, and `predicate` must match at least one ready record. `missing` lists
   * the unsatisfied ids; a predicate contributes no ids to `missing`.
   */
  resolve(requirement: CapabilityRequirement): CapabilityResolution {
    const readyRecords = [...this.store.values()]
      .map(({ record }) => record)
      .filter(record => record.state === 'ready')
    const isReady = (id: string) => readyRecords.some(record => record.capabilityId === id)

    const allOf = requirement.allOf ?? []
    const allOfMissing = allOf.filter(id => !isReady(id))

    const anyOf = requirement.anyOf ?? []
    const anyOfSatisfied = anyOf.length === 0 || anyOf.some(isReady)
    const anyOfMissing = anyOf.length > 0 && !anyOfSatisfied ? [...anyOf] : []

    const matchedByPredicate = requirement.predicate
      ? readyRecords.filter(record => requirement.predicate?.(record) ?? false)
      : []

    const matched: CapabilityRecord[] = []
    const seen = new Set<string>()
    for (const record of readyRecords) {
      const contributesToAllOf = allOf.includes(record.capabilityId) && !allOfMissing.includes(record.capabilityId)
      const contributesToAnyOf = anyOf.includes(record.capabilityId) && anyOfSatisfied
      const contributesToPredicate = matchedByPredicate.includes(record)
      if (!contributesToAllOf && !contributesToAnyOf && !contributesToPredicate) {
        continue
      }

      const recordKey = capabilityRecordKey(record)
      if (!seen.has(recordKey)) {
        seen.add(recordKey)
        matched.push(cloneRecord(record))
      }
    }

    const satisfied = allOfMissing.length === 0
      && anyOfSatisfied
      && (!requirement.predicate || matchedByPredicate.length > 0)

    return {
      satisfied,
      matched,
      missing: [...allOfMissing, ...anyOfMissing],
    }
  }

  /**
   * Registers a listener that receives changes only when a record actually
   * changes. Returns an idempotent unsubscribe function.
   */
  subscribe(listener: (change: CapabilityChange) => void): () => void {
    this.listeners.add(listener)
    let disposed = false
    return () => {
      if (disposed) {
        return
      }
      disposed = true
      this.listeners.delete(listener)
    }
  }

  /**
   * Returns the observed consumers and whether the registry still runs in
   * observer mode. Observer mode is true until every configured consumer id
   * has announced at least one capability.
   */
  getConsumerState(): { observed: string[], observerMode: boolean } {
    const observed = [...this.observedConsumers].sort()
    const observerMode = !this.observerConsumers.every(id => this.observedConsumers.has(id))
    return { observed, observerMode }
  }

  private requireRecord(key: CapabilityRecordKey, to: CapabilityState): StoredCapability {
    const existing = this.store.get(capabilityRecordKey(key))
    if (!existing) {
      throw new CapabilityTransitionError(key, null, to)
    }
    return existing
  }

  private assertTransition(key: CapabilityRecordKey, from: CapabilityState, to: CapabilityState): void {
    if (!canTransition(from, to)) {
      throw new CapabilityTransitionError(key, from, to)
    }
  }

  private applyTransition(
    key: CapabilityRecordKey,
    existing: StoredCapability,
    to: Exclude<CapabilityState, 'announced'>,
    patch?: CapabilityPatch,
  ): CapabilityRecord {
    const record: CapabilityRecord = {
      ...existing.record,
      state: to,
      version: patch?.version ?? existing.record.version,
      health: patch?.health ?? existing.record.health,
      metadata: patch?.metadata !== undefined ? patch.metadata : existing.record.metadata,
    }
    return this.write(capabilityRecordKey(key), record, to === 'withdrawn' ? 'withdrawn' : 'upsert')
  }

  private write(key: string, record: CapabilityRecord, kind: CapabilityChange['kind']): CapabilityRecord {
    const previous = this.store.get(key)
    if (previous && recordsEqual(previous.record, record)) {
      return cloneRecord(previous.record)
    }

    this.revision += 1
    this.store.set(key, { record: cloneRecord(record), updatedAt: Date.now() })
    const change: CapabilityChange = {
      revision: this.revision,
      record: cloneRecord(record),
      kind,
    }
    for (const listener of [...this.listeners]) {
      listener(change)
    }
    return cloneRecord(record)
  }
}

function recordKeyOf(input: { capabilityId: string, hostId: string, instanceId?: string }): CapabilityRecordKey {
  return {
    capabilityId: input.capabilityId,
    hostId: input.hostId,
    instanceId: input.instanceId,
  }
}
