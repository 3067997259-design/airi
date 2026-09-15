/**
 * Mining cycle: evaluate, select, equip and verify, aim, break, confirm, then
 * attribute the pickup (CD-M1/M2).
 *
 * One session owns the hotbar selection and break polling for `game_break`,
 * `game_collect` and the terrain dig path, so none of them re-implements them.
 * IO is injected through {@link MiningPort}; an unavailable evaluation falls
 * back to the caller's explicit manual break instead of lowering a requirement.
 */
import type { BreakFact, GeneratedDrop, HarvestDecision, HarvestEvaluation, HarvestHazard, HarvestRejection, MiningVec3, PickupAttribution, ToolSelection } from './types'

import { BreakEvidenceLedger } from './evidence'
import { parseHarvestEvaluation, selectTool } from './harvest'

/** One inventory slot the mining port can report. */
export interface MiningSlot {
  slot: number
  hotbar: boolean
  itemId: string
  count: number
  damage?: number
  maxDamage?: number
}

/** IO boundary for one mining cycle. Everything here is per-call. */
export interface MiningPort {
  /** No-side-effect harvest evaluation; undefined when the bridge lacks it. */
  evaluate: (pos: MiningVec3) => Promise<HarvestEvaluation | undefined>
  /** Equips an item and returns the verified held item id, or undefined. */
  equip: (itemId: string) => Promise<string | undefined>
  /** Selects an empty hotbar slot so the break uses a bare hand. */
  hand: () => Promise<void>
  /** Aims at the block center before the break starts. */
  aim: (pos: MiningVec3) => Promise<void>
  /** Starts a break; survival mining continues per tick until the block is gone. */
  startBreak: (pos: MiningVec3, mode: 'survival' | 'instant') => Promise<void>
  /** Reads one block id; undefined when the read failed. */
  readBlock: (pos: MiningVec3) => Promise<string | undefined>
  /** Counts one item across the inventory; undefined when the read failed. */
  countItem: (itemId: string) => Promise<number | undefined>
  /** Inventory slots, used to confirm the equipped tool and read durability. */
  readSlots: () => Promise<MiningSlot[] | undefined>
  /** Server break/drop evidence for one break, when the bridge reports it. */
  readDropEvidence?: (fact: BreakFact) => Promise<GeneratedDrop[] | undefined>
  /** Fresh player position for reach checks. */
  playerPosition: () => Promise<MiningVec3 | undefined>
  now: () => number
  sleep: (ms: number) => Promise<void>
  shouldStop: () => boolean
}

export type PrepareOutcome
  = | { status: 'unavailable' }
    | { status: 'rejected', evaluation: HarvestEvaluation, rejection: HarvestRejection }
    | {
      status: 'ready'
      evaluation: HarvestEvaluation
      decision: HarvestDecision
      selection?: ToolSelection
      /** Verified held item id after the equip, or `hand` for a bare hand. */
      equipped?: string
      hazards: HarvestHazard[]
      /** True when the chosen tool may run out before the planned blocks. */
      durabilityRisk: boolean
    }

export type BreakStatus = 'broken' | 'not_confirmed' | 'cancelled' | 'refused'

export interface BreakOutcome {
  status: BreakStatus
  breakId: string
  blockIdBefore?: string
  blockIdAfter?: string
  detail?: string
}

export interface PrepareOptions {
  mode?: 'survival' | 'instant'
}

/** Minimum time before the break poll gives up, scaled by the estimate. */
const BREAK_POLL_FLOOR_MS = 4_000
const BREAK_POLL_CEILING_MS = 20_000
const TICKS_TO_MS = 50

/** Generates a command-scoped break id without an external uuid dependency. */
let breakCounter = 0
export function nextBreakId(commandId?: string): string {
  breakCounter += 1
  return `${commandId ?? 'break'}-${breakCounter}`
}

export class MiningSession {
  readonly ledger = new BreakEvidenceLedger()

  constructor(private readonly port: MiningPort) {}

  /**
   * Evaluates the block and prepares a tool, or returns a typed rejection.
   *
   * On `unavailable` the caller must keep its existing manual path. A `ready`
   * outcome guarantees the equipped item matched its request (or the hand was
   * cleared for a bare-hand break).
   */
  async prepare(pos: MiningVec3, request: Omit<Parameters<typeof selectTool>[1], 'pos'>): Promise<PrepareOutcome> {
    const evaluation = await this.port.evaluate(pos)
    if (!evaluation)
      return { status: 'unavailable' }
    if (evaluation.blockStateId && !isSamePosition(evaluation, pos))
      return { status: 'rejected', evaluation, rejection: { reason: 'data_unavailable', detail: 'evaluation position mismatch' } }

    const decision = selectTool(evaluation, { pos, ...request })
    if (!decision.ok)
      return { status: 'rejected', evaluation, rejection: decision.rejection }

    if (decision.bareHand) {
      await this.port.hand()
      return {
        status: 'ready',
        evaluation,
        decision,
        equipped: 'hand',
        hazards: evaluation.hazards,
        durabilityRisk: false,
      }
    }

    const selection = decision.selection!
    const verified = await this.port.equip(selection.candidate.itemId)
    if (verified !== selection.candidate.itemId) {
      return {
        status: 'rejected',
        evaluation,
        rejection: { reason: 'data_unavailable', detail: `equip did not verify ${selection.candidate.itemId} (read ${verified ?? 'none'})` },
      }
    }
    return {
      status: 'ready',
      evaluation,
      decision,
      selection,
      equipped: verified,
      hazards: evaluation.hazards,
      durabilityRisk: selection.durability.riskOfBreak,
    }
  }

  /**
   * Breaks one block after a successful prepare.
   *
   * The bounded poll uses the estimate: a slow but progressing block is not
   * abandoned at a blanket ten seconds. A block that changed after the
   * evaluation is refused, never broken blind.
   */
  async runBreak(prepared: Extract<PrepareOutcome, { status: 'ready' }>, options: {
    breakId: string
    commandId?: string
    mode?: 'survival' | 'instant'
    pollMs?: number
  }): Promise<BreakOutcome> {
    const pos: MiningVec3 = { x: prepared.evaluation.x, y: prepared.evaluation.y, z: prepared.evaluation.z }
    const mode = options.mode ?? 'survival'
    const before = await this.port.readBlock(pos)
    if (before === undefined)
      return { status: 'refused', breakId: options.breakId, detail: 'block read failed before the break' }
    if (before !== prepared.evaluation.blockStateId) {
      return { status: 'refused', breakId: options.breakId, blockIdBefore: before, detail: 'block state changed after evaluation' }
    }

    await this.port.aim(pos)
    if (this.port.shouldStop())
      return { status: 'cancelled', breakId: options.breakId, blockIdBefore: before }

    const estimateMs = prepared.evaluation.estimatedTicks === undefined
      ? BREAK_POLL_FLOOR_MS
      : prepared.evaluation.estimatedTicks * TICKS_TO_MS * 3
    const pollMs = Math.min(BREAK_POLL_CEILING_MS, Math.max(BREAK_POLL_FLOOR_MS, options.pollMs ?? estimateMs))
    const startTick = Math.round(this.port.now() / TICKS_TO_MS)
    this.ledger.recordBreakFact({
      breakId: options.breakId,
      ...(options.commandId ? { commandId: options.commandId } : {}),
      ...(prepared.evaluation.playerUuid ? { playerUuid: prepared.evaluation.playerUuid } : {}),
      dimension: prepared.evaluation.dimension,
      x: pos.x,
      y: pos.y,
      z: pos.z,
      blockStateId: prepared.evaluation.blockStateId,
      startTick,
    })

    await this.port.startBreak(pos, mode)

    const outcome = await this.pollBreak(options.breakId, pos, prepared.evaluation.blockStateId, pollMs)
    if (outcome.status === 'broken')
      await this.captureDrops(options.breakId)
    return outcome
  }

  /**
   * Breaks one block without a harvest evaluation.
   *
   * This is the explicit manual path for a bridge that cannot evaluate. It
   * keeps the same aim, poll and drop-evidence behavior as {@link runBreak}, so
   * the two paths do not duplicate the break cycle.
   */
  async runManualBreak(input: {
    breakId: string
    commandId?: string
    pos: MiningVec3
    blockIdBefore: string
    mode?: 'survival' | 'instant'
    pollMs?: number
  }): Promise<BreakOutcome> {
    const mode = input.mode ?? 'survival'
    const startTick = Math.round(this.port.now() / TICKS_TO_MS)
    this.ledger.recordBreakFact({
      breakId: input.breakId,
      ...(input.commandId ? { commandId: input.commandId } : {}),
      dimension: '',
      x: input.pos.x,
      y: input.pos.y,
      z: input.pos.z,
      blockStateId: input.blockIdBefore,
      startTick,
    })
    await this.port.aim(input.pos)
    if (this.port.shouldStop())
      return { status: 'cancelled', breakId: input.breakId, blockIdBefore: input.blockIdBefore }
    await this.port.startBreak(input.pos, mode)
    const outcome = await this.pollBreak(input.breakId, input.pos, input.blockIdBefore, input.pollMs ?? BREAK_POLL_FLOOR_MS)
    if (outcome.status === 'broken')
      await this.captureDrops(input.breakId)
    return outcome
  }

  /** Shared bounded break confirmation poll. */
  private async pollBreak(breakId: string, pos: MiningVec3, blockIdBefore: string, pollMs: number): Promise<BreakOutcome> {
    const deadline = this.port.now() + pollMs
    let last: string | undefined = blockIdBefore
    while (this.port.now() < deadline) {
      if (this.port.shouldStop()) {
        this.closeFact(breakId)
        return { status: 'cancelled', breakId, blockIdBefore, ...(last !== undefined ? { blockIdAfter: last } : {}) }
      }
      await this.port.sleep(250)
      const current = await this.port.readBlock(pos)
      if (current === undefined)
        continue
      last = current
      if (current !== blockIdBefore) {
        this.closeFact(breakId)
        return { status: 'broken', breakId, blockIdBefore, blockIdAfter: current }
      }
      await this.port.aim(pos)
    }
    return { status: 'not_confirmed', breakId, blockIdBefore, ...(last !== undefined ? { blockIdAfter: last } : {}) }
  }

  /** Stamps the end tick on a break fact when it exists. */
  private closeFact(breakId: string): void {
    const fact = this.ledger.factOf(breakId)
    if (fact)
      this.ledger.recordBreakFact({ ...fact, endTick: Math.round(this.port.now() / TICKS_TO_MS) })
  }

  /** Best-effort server drop association for one break. */
  private async captureDrops(breakId: string): Promise<void> {
    if (!this.port.readDropEvidence)
      return
    const fact = this.ledger.factOf(breakId)
    if (!fact)
      return
    try {
      const drops = await this.port.readDropEvidence(fact)
      if (drops && drops.length > 0)
        this.ledger.recordGeneratedDrops(breakId, drops)
    }
    catch {
      // Drop evidence is optional; an unavailable read leaves the result
      // graded as inventory-delta instead of failing the break.
    }
  }

  /**
   * Counts items that appeared inside the break's bounded pickup window.
   *
   * Returns the observed increase; the ledger turns it into a graded
   * attribution so an unproven delta is never reported as precise.
   */
  async waitForPickup(breakId: string, itemId: string, before: number, windowMs: number): Promise<number> {
    if (this.ledger.factOf(breakId) === undefined)
      return 0
    const deadline = this.port.now() + windowMs
    while (this.port.now() < deadline) {
      await this.port.sleep(300)
      if (this.port.shouldStop())
        return 0
      const current = await this.port.countItem(itemId)
      if (current !== undefined && current > before) {
        this.ledger.recordPickup(breakId, itemId, current - before)
        return current - before
      }
    }
    return 0
  }

  /** The graded attribution for one break and item. */
  attribution(breakId: string, itemId: string): PickupAttribution {
    return this.ledger.resolve(breakId, itemId)
  }
}

function isSamePosition(evaluation: HarvestEvaluation, pos: MiningVec3): boolean {
  return evaluation.x === pos.x && evaluation.y === pos.y && evaluation.z === pos.z
}

/**
 * Parses one raw bridge evaluation record.
 *
 * Re-exported so the host adapter and tests share a single parser.
 */
export { parseHarvestEvaluation }
