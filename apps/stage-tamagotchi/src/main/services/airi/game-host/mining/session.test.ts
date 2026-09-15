import type { MiningPort } from './session'
import type { HarvestEvaluation, MiningVec3 } from './types'

import { describe, expect, it } from 'vitest'

import { MiningSession } from './session'

interface FakeState {
  blockId: string
  inventory: Record<string, number>
  equipped?: string
  time: number
  stopped: boolean
  breakCalls: number
  aimCalls: number
  evaluateAvailable: boolean
  generated?: Array<{ itemId: string, count: number }>
  generatedGranted?: boolean
  /** Replaces the block id after the break starts. */
  breakTo?: string
}

function evaluation(overrides: Partial<HarvestEvaluation> = {}): HarvestEvaluation {
  return {
    blockStateId: 'minecraft:stone',
    x: 1,
    y: 64,
    z: 0,
    dimension: 'minecraft:overworld',
    playerUuid: 'player-1',
    candidates: [{
      slot: 0,
      hotbar: false,
      itemId: 'minecraft:iron_pickaxe',
      count: 1,
      damage: 0,
      maxDamage: 250,
      enchantments: {},
      harvestEligible: true,
      destroySpeed: 6,
      estimatedTicks: 4,
      expectedDropMode: 'normal',
    }],
    harvestEligible: true,
    expectedDropMode: 'normal',
    estimatedTicks: 4,
    estimateQuality: 'exact',
    hazards: [],
    unmet: [],
    requiresTool: true,
    ...overrides,
  }
}

function makePort(state: FakeState, evaluationOverride?: HarvestEvaluation): MiningPort {
  return {
    evaluate: async () => (state.evaluateAvailable ? evaluationOverride ?? evaluation() : undefined),
    equip: async (itemId) => {
      state.equipped = itemId
      return itemId
    },
    hand: async () => {
      state.equipped = 'hand'
    },
    aim: async () => {
      state.aimCalls += 1
    },
    startBreak: async (_pos, mode) => {
      state.breakCalls += 1
      if (mode === 'instant')
        state.blockId = 'minecraft:air'
      else if (state.breakTo)
        state.blockId = state.breakTo
    },
    readBlock: async () => state.blockId,
    countItem: async itemId => state.inventory[itemId] ?? 0,
    readSlots: async () => [],
    readDropEvidence: async () => state.generated,
    playerPosition: async () => ({ x: 0, y: 64, z: 0 }),
    now: () => state.time,
    sleep: async (ms) => {
      state.time += ms
      if (state.breakTo)
        state.blockId = state.breakTo
      if (state.generated && !state.generatedGranted) {
        state.generatedGranted = true
        state.inventory[state.generated[0]!.itemId] = (state.inventory[state.generated[0]!.itemId] ?? 0) + state.generated[0]!.count
      }
    },
    shouldStop: () => state.stopped,
  }
}

function state(overrides: Partial<FakeState> = {}): FakeState {
  return {
    blockId: 'minecraft:stone',
    inventory: {},
    time: 0,
    stopped: false,
    breakCalls: 0,
    aimCalls: 0,
    evaluateAvailable: true,
    breakTo: 'minecraft:air',
    ...overrides,
  }
}

const pos: MiningVec3 = { x: 1, y: 64, z: 0 }

describe('miningSession.prepare', () => {
  it('reports unavailable when no evaluation exists', async () => {
    const session = new MiningSession(makePort(state({ evaluateAvailable: false })))
    expect(await session.prepare(pos, { strategy: 'conserve' })).toEqual({ status: 'unavailable' })
  })

  it('rejects a block that needs a tool none of the candidates provides', async () => {
    const session = new MiningSession(makePort(state(), evaluation({
      candidates: [],
      harvestEligible: false,
    })))
    const outcome = await session.prepare(pos, { strategy: 'conserve' })
    expect(outcome).toMatchObject({ status: 'rejected', rejection: { reason: 'no_tool' } })
  })

  it('equips and verifies the selected tool', async () => {
    const fake = state()
    const session = new MiningSession(makePort(fake))
    const outcome = await session.prepare(pos, { strategy: 'conserve' })
    expect(outcome.status).toBe('ready')
    expect(fake.equipped).toBe('minecraft:iron_pickaxe')
    if (outcome.status === 'ready')
      expect(outcome.equipped).toBe('minecraft:iron_pickaxe')
  })

  it('clears the hand for a block that drops without a tool', async () => {
    const fake = state()
    const session = new MiningSession(makePort(fake, evaluation({ requiresTool: false, candidates: [] })))
    const outcome = await session.prepare(pos, { strategy: 'conserve' })
    expect(outcome).toMatchObject({ status: 'ready', equipped: 'hand', durabilityRisk: false })
    expect(fake.equipped).toBe('hand')
  })

  it('surfaces a durability risk when the only tool may not cover the plan', async () => {
    const session = new MiningSession(makePort(state(), evaluation({
      candidates: [{
        slot: 0,
        hotbar: false,
        itemId: 'minecraft:iron_pickaxe',
        count: 1,
        damage: 249,
        maxDamage: 250,
        enchantments: {},
        harvestEligible: true,
        destroySpeed: 6,
        estimatedTicks: 4,
        expectedDropMode: 'normal',
      }],
    })))
    const outcome = await session.prepare(pos, { strategy: 'conserve', plannedBlocks: 5 })
    expect(outcome).toMatchObject({ status: 'ready', durabilityRisk: true })
  })
})

describe('miningSession.runBreak', () => {
  it('breaks, confirms, records the fact and attributes the pickup', async () => {
    const fake = state({ generated: [{ itemId: 'minecraft:cobblestone', count: 1 }] })
    const session = new MiningSession(makePort(fake))
    const prepared = await session.prepare(pos, { strategy: 'conserve' })
    if (prepared.status !== 'ready')
      throw new Error('prepare failed')

    const outcome = await session.runBreak(prepared, { breakId: 'b1', commandId: 'c1' })
    expect(outcome).toMatchObject({ status: 'broken', blockIdBefore: 'minecraft:stone', blockIdAfter: 'minecraft:air' })
    expect(fake.breakCalls).toBe(1)
    expect(session.ledger.factOf('b1')).toMatchObject({ breakId: 'b1', commandId: 'c1', blockStateId: 'minecraft:stone' })

    const picked = await session.waitForPickup('b1', 'minecraft:cobblestone', 0, 5_000)
    expect(picked).toBe(1)
    expect(session.attribution('b1', 'minecraft:cobblestone')).toMatchObject({
      lowerBound: 1,
      fuzzy: 0,
      generated: 1,
      evidence: 'server-attributed',
    })
  })

  it('refuses a block that changed after the evaluation', async () => {
    const fake = state({ blockId: 'minecraft:dirt' })
    const session = new MiningSession(makePort(fake))
    const prepared = await session.prepare(pos, { strategy: 'conserve' })
    if (prepared.status !== 'ready')
      throw new Error('prepare failed')
    const outcome = await session.runBreak(prepared, { breakId: 'b2' })
    expect(outcome).toMatchObject({ status: 'refused', blockIdBefore: 'minecraft:dirt' })
    expect(fake.breakCalls).toBe(0)
  })

  it('reports not_confirmed when the block never changes', async () => {
    const fake = state({ breakTo: undefined, generated: undefined })
    const session = new MiningSession(makePort(fake))
    const prepared = await session.prepare(pos, { strategy: 'conserve' })
    if (prepared.status !== 'ready')
      throw new Error('prepare failed')
    const outcome = await session.runBreak(prepared, { breakId: 'b3', pollMs: 1_000 })
    expect(outcome.status).toBe('not_confirmed')
  })

  it('cancels without continuing to break after a stop request', async () => {
    const fake = state({ breakTo: undefined, generated: undefined })
    let stopped = false
    const port = makePort(fake)
    const originalShouldStop = port.shouldStop
    port.shouldStop = () => stopped
    const session = new MiningSession(port)
    const prepared = await session.prepare(pos, { strategy: 'conserve' })
    if (prepared.status !== 'ready')
      throw new Error('prepare failed')
    stopped = true
    // Let the first poll observe the stop.
    port.sleep = async (ms) => {
      fake.time += ms
    }
    const outcome = await session.runBreak(prepared, { breakId: 'b4', pollMs: 2_000 })
    expect(outcome.status).toBe('cancelled')
    expect(originalShouldStop()).toBe(false)
  })
})
