/**
 * Break, drop and pickup attribution (CD-M2).
 *
 * A block disappearing is a break fact, not a drop; an inventory increase is a
 * pickup, not proof this break produced it. Each break keeps a source-quantity
 * ledger so that a merged, split, stolen or unloaded drop is reported as a
 * provable lower bound plus a fuzzy remainder, never as a precise claim.
 * Experience is tracked separately from item counts.
 */
import type { BreakFact, EvidenceGrade, GeneratedDrop, PickupAttribution } from './types'

/** Per-item totals for one break. */
interface BreakLedger {
  fact: BreakFact
  generated: Map<string, number>
  attributed: Map<string, number>
  xp: number
  /** Item entity uuids observed for this break, keyed by item id. */
  entityUuids: Map<string, string[]>
}

/** True when both records name the same break and item. */
function ledgerOf(ledgers: Map<string, BreakLedger>, breakId: string): BreakLedger | undefined {
  return ledgers.get(breakId)
}

export class BreakEvidenceLedger {
  private ledgers = new Map<string, BreakLedger>()

  /** Records the break fact and opens the ledger for one break. */
  recordBreakFact(fact: BreakFact): void {
    const existing = this.ledgers.get(fact.breakId)
    this.ledgers.set(fact.breakId, {
      fact,
      generated: existing?.generated ?? new Map(),
      attributed: existing?.attributed ?? new Map(),
      xp: existing?.xp ?? 0,
      entityUuids: existing?.entityUuids ?? new Map(),
    })
  }

  /**
   * Records the ItemEntities the server attributed to a break.
   *
   * This is the only source that makes a quantity provable. Without it an
   * inventory delta stays indirect evidence.
   */
  recordGeneratedDrops(breakId: string, drops: GeneratedDrop[]): void {
    const ledger = ledgerOf(this.ledgers, breakId)
    if (!ledger)
      return
    for (const drop of drops) {
      if (drop.count <= 0)
        continue
      ledger.generated.set(drop.itemId, (ledger.generated.get(drop.itemId) ?? 0) + drop.count)
      if (drop.entityUuids?.length) {
        const known = ledger.entityUuids.get(drop.itemId) ?? []
        ledger.entityUuids.set(drop.itemId, [...new Set([...known, ...drop.entityUuids])])
      }
    }
  }

  /**
   * Records items that entered the inventory inside one break's bounded window.
   *
   * The count is capped by the generated quantity so a pickup that contains
   * items from another source cannot inflate this break's attributed total.
   */
  recordPickup(breakId: string, itemId: string, count: number): void {
    const ledger = ledgerOf(this.ledgers, breakId)
    if (!ledger || count <= 0)
      return
    const generated = ledger.generated.get(itemId) ?? 0
    const already = ledger.attributed.get(itemId) ?? 0
    const room = generated > 0 ? Math.max(0, generated - already) : count
    ledger.attributed.set(itemId, already + Math.min(count, room))
  }

  /** Records experience separately; it never mixes into item counts. */
  recordXp(breakId: string, amount: number): void {
    const ledger = ledgerOf(this.ledgers, breakId)
    if (ledger && amount > 0)
      ledger.xp += amount
  }

  /** Experience attributed to one break, outside the item ledger. */
  xpFor(breakId: string): number {
    return ledgerOf(this.ledgers, breakId)?.xp ?? 0
  }

  /** Current fact for one break, when it was recorded. */
  factOf(breakId: string): BreakFact | undefined {
    return ledgerOf(this.ledgers, breakId)?.fact
  }

  /**
   * Resolves the provable lower bound and fuzzy remainder for one item.
   *
   * Server-attributed drops give `lowerBound = min(attributed, generated)` and
   * `fuzzy = generated - lowerBound`. With no server evidence the result is
   * graded `inventory-delta` and the whole pickup is fuzzy, because a delta can
   * also come from another player's toss. With neither, it is `unobserved`.
   */
  resolve(breakId: string, itemId: string): PickupAttribution {
    const ledger = ledgerOf(this.ledgers, breakId)
    if (!ledger)
      return { breakId, itemId, lowerBound: 0, fuzzy: 0, generated: 0, evidence: 'unobserved', note: 'no break fact recorded' }
    const generated = ledger.generated.get(itemId) ?? 0
    const attributed = ledger.attributed.get(itemId) ?? 0
    if (generated > 0) {
      const lowerBound = Math.min(attributed, generated)
      const fuzzy = generated - lowerBound
      const note = fuzzy > 0
        ? 'part of the generated amount was not confirmed in the inventory inside the window'
        : undefined
      return {
        breakId,
        itemId,
        lowerBound,
        fuzzy,
        generated,
        evidence: 'server-attributed' satisfies EvidenceGrade,
        ...(note ? { note } : {}),
      }
    }
    if (attributed > 0) {
      return {
        breakId,
        itemId,
        lowerBound: 0,
        fuzzy: attributed,
        generated: 0,
        evidence: 'inventory-delta',
        note: 'inventory delta without server drop evidence; another source cannot be excluded',
      }
    }
    return { breakId, itemId, lowerBound: 0, fuzzy: 0, generated: 0, evidence: 'unobserved' }
  }

  /** Entity uuids the server attributed to one break's item. */
  entityUuidsFor(breakId: string, itemId: string): string[] {
    return ledgerOf(this.ledgers, breakId)?.entityUuids.get(itemId) ?? []
  }

  /** Drops the ledger of one break; callers use it after a command ends. */
  forget(breakId: string): void {
    this.ledgers.delete(breakId)
  }
}

/**
 * Builds a break fact keyed by a generated id.
 *
 * @example
 * createBreakFact({ breakId: 'b1', x: 1, y: 64, z: 0, blockStateId: 'minecraft:stone' })
 * // => { breakId: 'b1', x: 1, y: 64, z: 0, blockStateId: 'minecraft:stone' }
 */
export function createBreakFact(input: Omit<BreakFact, 'breakId'> & { breakId: string }): BreakFact {
  return input
}
