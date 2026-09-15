import { describe, expect, it } from 'vitest'

import { BreakEvidenceLedger, createBreakFact } from './evidence'

describe('breakEvidenceLedger', () => {
  it('claims a precise lower bound only from server-attributed drops', () => {
    const ledger = new BreakEvidenceLedger()
    ledger.recordBreakFact(createBreakFact({ breakId: 'b1', x: 1, y: 64, z: 0, blockStateId: 'minecraft:iron_ore' }))
    ledger.recordGeneratedDrops('b1', [{ itemId: 'minecraft:raw_iron', count: 2, entityUuids: ['e1', 'e2'] }])
    ledger.recordPickup('b1', 'minecraft:raw_iron', 2)

    const attribution = ledger.resolve('b1', 'minecraft:raw_iron')
    expect(attribution).toMatchObject({ lowerBound: 2, fuzzy: 0, generated: 2, evidence: 'server-attributed' })
    expect(ledger.entityUuidsFor('b1', 'minecraft:raw_iron')).toEqual(['e1', 'e2'])
  })

  it('reports stolen, merged or unloaded drops as a fuzzy remainder', () => {
    const ledger = new BreakEvidenceLedger()
    ledger.recordBreakFact(createBreakFact({ breakId: 'b2', x: 2, y: 64, z: 0, blockStateId: 'minecraft:gold_ore' }))
    ledger.recordGeneratedDrops('b2', [{ itemId: 'minecraft:raw_gold', count: 3 }])
    // Another player grabbed one before the pickup window closed.
    ledger.recordPickup('b2', 'minecraft:raw_gold', 2)

    const attribution = ledger.resolve('b2', 'minecraft:raw_gold')
    expect(attribution.lowerBound).toBe(2)
    expect(attribution.fuzzy).toBe(1)
    expect(attribution.evidence).toBe('server-attributed')
    expect(attribution.note).toContain('not confirmed')
  })

  it('never inflates attribution beyond what the server generated', () => {
    const ledger = new BreakEvidenceLedger()
    ledger.recordBreakFact(createBreakFact({ breakId: 'b3', x: 3, y: 64, z: 0, blockStateId: 'minecraft:stone' }))
    ledger.recordGeneratedDrops('b3', [{ itemId: 'minecraft:cobblestone', count: 1 }])
    // An inventory read that saw a merged stack from an earlier break.
    ledger.recordPickup('b3', 'minecraft:cobblestone', 4)

    expect(ledger.resolve('b3', 'minecraft:cobblestone').lowerBound).toBe(1)
  })

  it('grades an inventory delta without server evidence as indirect', () => {
    const ledger = new BreakEvidenceLedger()
    ledger.recordBreakFact(createBreakFact({ breakId: 'b4', x: 4, y: 64, z: 0, blockStateId: 'minecraft:oak_log' }))
    ledger.recordPickup('b4', 'minecraft:oak_log', 2)

    const attribution = ledger.resolve('b4', 'minecraft:oak_log')
    expect(attribution).toMatchObject({ lowerBound: 0, fuzzy: 2, generated: 0, evidence: 'inventory-delta' })
    expect(attribution.note).toContain('another source cannot be excluded')
  })

  it('reports an unobserved result when nothing was recorded', () => {
    const ledger = new BreakEvidenceLedger()
    expect(ledger.resolve('missing', 'minecraft:diamond')).toMatchObject({ evidence: 'unobserved' })
  })

  it('keeps experience separate from item counts', () => {
    const ledger = new BreakEvidenceLedger()
    ledger.recordBreakFact(createBreakFact({ breakId: 'b5', x: 5, y: 64, z: 0, blockStateId: 'minecraft:coal_ore' }))
    ledger.recordGeneratedDrops('b5', [{ itemId: 'minecraft:coal', count: 1 }])
    ledger.recordPickup('b5', 'minecraft:coal', 1)
    ledger.recordXp('b5', 2)

    expect(ledger.xpFor('b5')).toBe(2)
    expect(ledger.resolve('b5', 'minecraft:coal')).toMatchObject({ lowerBound: 1, generated: 1 })
  })

  it('ignores drops and pickups that arrive before a break fact', () => {
    const ledger = new BreakEvidenceLedger()
    ledger.recordGeneratedDrops('none', [{ itemId: 'minecraft:stone', count: 1 }])
    ledger.recordPickup('none', 'minecraft:stone', 1)
    expect(ledger.resolve('none', 'minecraft:stone').evidence).toBe('unobserved')
  })

  it('forgets one break without touching the others', () => {
    const ledger = new BreakEvidenceLedger()
    ledger.recordBreakFact(createBreakFact({ breakId: 'a', x: 0, y: 0, z: 0, blockStateId: 'minecraft:stone' }))
    ledger.recordBreakFact(createBreakFact({ breakId: 'b', x: 0, y: 0, z: 0, blockStateId: 'minecraft:stone' }))
    ledger.forget('a')
    expect(ledger.factOf('a')).toBeUndefined()
    expect(ledger.factOf('b')).toBeDefined()
  })
})
