import type { GameCommandEnvelope, GameCommandParams, GameExecutionToken, GameExecutorOutcome } from './command-registry'

import { describe, expect, it, vi } from 'vitest'

import {
  commandParamsDigest,
  createGameCommandRegistry,
  GameCommandConflictError,
  GameStaleUpdateError,
  GameWriteBusyError,
  nextStopScope,
  StaleGameBindingError,
  stopScopeFor,
} from './command-registry'

const snapshot = {
  position: { x: 0, y: 64, z: 0 },
  health: 20,
  food: 20,
  heldItem: null,
}

function makeEnvelope(
  action: GameCommandEnvelope['action'],
  params: GameCommandParams,
  overrides: Partial<GameCommandEnvelope> = {},
): GameCommandEnvelope {
  return {
    sessionId: 'session-1',
    taskId: null,
    runId: 'run-1',
    planVersion: null,
    worldId: 'world-1',
    dimension: 'minecraft:overworld',
    playerUuid: 'player-1',
    connectionGeneration: 1,
    connectionId: 'connection-1',
    commandId: 'command-1',
    action,
    paramsDigest: commandParamsDigest(action, params),
    deadlineMs: 500,
    issuedAt: 1_000,
    ...overrides,
  }
}

function createTestExecutor() {
  let behavior: (input: { envelope: GameCommandEnvelope, params: GameCommandParams, token: GameExecutionToken }) => Promise<GameExecutorOutcome>
    = async () => ({ endReason: 'done', finalSnapshot: snapshot })
  let stopConfirmed = true

  return {
    execute: vi.fn((input: { envelope: GameCommandEnvelope, params: GameCommandParams, token: GameExecutionToken }) => behavior(input)),
    stop: vi.fn(async (_input: { envelope: GameCommandEnvelope, token: GameExecutionToken }) => stopConfirmed),
    setBehavior(next: (input: { envelope: GameCommandEnvelope, params: GameCommandParams, token: GameExecutionToken }) => Promise<GameExecutorOutcome>) {
      behavior = next
    },
    setStopConfirmed(next: boolean) {
      stopConfirmed = next
    },
  }
}

function createTestRegistry(executor = createTestExecutor()) {
  const registry = createGameCommandRegistry({
    executor,
    getBinding: () => ({ connectionGeneration: 1, worldId: 'world-1' }),
    stopGraceMs: 30,
    fallbackSnapshot: snapshot,
  })
  return { executor, registry }
}

describe('command params digest', () => {
  it('hashes action and params only, with sorted keys and rounded floats', () => {
    expect(commandParamsDigest('move_to', { moveTo: { x: 1, y: 2, z: 3, tolerance: 0.5 } }))
      .toBe(commandParamsDigest('move_to', { moveTo: { tolerance: 0.5, z: 3, y: 2, x: 1 } }))
    expect(commandParamsDigest('move_to', { moveTo: { x: 0.1 + 0.2, y: 0, z: 0, tolerance: 1 } }))
      .toBe(commandParamsDigest('move_to', { moveTo: { x: 0.3, y: -0, z: 0, tolerance: 1 } }))
    expect(commandParamsDigest('say', { say: { text: 'hi' } }))
      .not
      .toBe(commandParamsDigest('say', { say: { text: 'hey' } }))
    // The envelope is not an input of the digest; a retry with a later
    // deadline computes the same digest.
    expect(commandParamsDigest('observe', { observe: { radius: 8 } }))
      .toBe(commandParamsDigest('observe', { observe: { radius: 8 } }))
  })

  it('rejects an envelope digest that does not match action and params', () => {
    const { registry } = createTestRegistry()
    const params = { say: { text: 'hi' } }
    const envelope = makeEnvelope('say', params, { paramsDigest: 'deadbeef' })

    expect(() => registry.submit({ envelope, params })).toThrow('paramsDigest does not match')
  })
})

describe('command registry dedup and binding', () => {
  it('returns the existing receipt for the same key and digest without re-executing', async () => {
    const { registry, executor } = createTestRegistry()
    const params = { observe: { radius: 8 } }
    const first = makeEnvelope('observe', params)
    const retry = makeEnvelope('observe', params, { deadlineMs: 5_000, issuedAt: 2_000 })

    const firstReceipt = await registry.submit({ envelope: first, params })
    const retryReceipt = await registry.submit({ envelope: retry, params })

    expect(executor.execute).toHaveBeenCalledTimes(1)
    expect(retryReceipt).toBe(firstReceipt)
    expect(firstReceipt.state).toBe('succeeded')
  })

  it('rejects the same command id with different params', async () => {
    const { registry } = createTestRegistry()
    const params = { say: { text: 'hello' } }
    await registry.submit({ envelope: makeEnvelope('say', params), params })

    const conflictingParams = { say: { text: 'goodbye' } }
    expect(() => registry.submit({
      envelope: makeEnvelope('say', conflictingParams),
      params: conflictingParams,
    })).toThrow(GameCommandConflictError)
  })

  it('rejects commands from an older generation or another world', () => {
    const { registry } = createTestRegistry()

    expect(() => registry.submit({
      envelope: makeEnvelope('say', {}, { connectionGeneration: 0 }),
    })).toThrow(StaleGameBindingError)

    expect(() => registry.submit({
      envelope: makeEnvelope('say', {}, { worldId: 'world-2' }),
      params: {},
    })).toThrow(StaleGameBindingError)
  })

  // MC-4e D3: a dimension change keeps the connection and generation but is a
  // binding change, so a command minted for the old dimension is stale.
  it('rejects a command issued for another dimension', () => {
    const registry = createGameCommandRegistry({
      executor: createTestExecutor(),
      getBinding: () => ({ connectionGeneration: 1, worldId: 'world-1', dimension: 'minecraft:the_nether' }),
      stopGraceMs: 30,
      fallbackSnapshot: snapshot,
    })

    expect(() => registry.submit({
      envelope: makeEnvelope('say', {}, { dimension: 'minecraft:overworld' }),
      params: {},
    })).toThrow(StaleGameBindingError)

    // A binding that reports no dimension cannot be compared, so the command
    // still submits (the check is only applied when the adapter knows one).
    const withoutDimension = createGameCommandRegistry({
      executor: createTestExecutor(),
      getBinding: () => ({ connectionGeneration: 1, worldId: 'world-1' }),
      stopGraceMs: 30,
      fallbackSnapshot: snapshot,
    })
    expect(() => withoutDimension.submit({
      envelope: makeEnvelope('say', {}, { dimension: 'minecraft:overworld' }),
      params: {},
    })).not.toThrow()
  })

  it('stops the active write command with a typed reason', async () => {
    const { registry, executor } = createTestRegistry()
    executor.setBehavior(() => new Promise(() => {}))

    const params = { moveTo: { x: 0, y: 64, z: 0, tolerance: 1 } }
    const pending = registry.submit({ envelope: makeEnvelope('move_to', params, { commandId: 'dim-move' }), params })

    await registry.stopActive('dimension_changed')

    await expect(pending).resolves.toMatchObject({
      commandId: 'dim-move',
      state: 'cancelled',
      endReason: 'dimension_changed',
      postCondition: { met: false },
    })
    expect(executor.stop).toHaveBeenCalledTimes(1)
    // The old command is terminal; a later outcome cannot revive it.
    expect(registry.listActive()).toEqual([])
  })

  it('keeps the typed stop reason when the executor returns on its own', async () => {
    const { registry, executor } = createTestRegistry()
    let release: (() => void) | undefined
    executor.setBehavior(async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { endReason: 'target_lost', finalSnapshot: snapshot }
    })

    const params = { follow: { target: 'Alice', keepDistance: 3 } }
    const pending = registry.submit({ envelope: makeEnvelope('follow', params, { commandId: 'dim-follow' }), params })
    // Let the executor start before the stop is requested.
    await new Promise(resolve => setTimeout(resolve, 10))

    // ROOT CAUSE: the stop path used to settle a fast-returning executor as a
    // plain `cancelled`, so live MC-4c/4e could not show `dimension_changed`.
    // The typed reason is now recorded on the record and survives whoever
    // settles first.
    const stopping = registry.stopActive('dimension_changed')
    release!()
    await stopping

    await expect(pending).resolves.toMatchObject({
      commandId: 'dim-follow',
      state: 'cancelled',
      endReason: 'dimension_changed',
      postCondition: { met: false },
    })
  })
})

describe('single writer and lease', () => {
  it('lets read commands run while a write command holds the player', async () => {
    const { registry, executor } = createTestRegistry()
    let release: (() => void) | undefined
    executor.setBehavior(async ({ envelope }) => {
      // Only the write command holds the player; read commands answer now.
      if (envelope.action === 'move_to') {
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
      return { endReason: 'reached', finalSnapshot: snapshot, finalPosition: { x: 0, y: 64, z: 0 } }
    })

    const moveParams = { moveTo: { x: 0, y: 64, z: 0, tolerance: 1 } }
    const moving = registry.submit({ envelope: makeEnvelope('move_to', moveParams, { commandId: 'move-1' }), params: moveParams })

    const collectParams = { collect: { blockId: 'minecraft:oak_log', itemId: 'minecraft:oak_log', maxCount: 1, radius: 8 } }
    expect(() => registry.submit({
      envelope: makeEnvelope('collect', collectParams, { commandId: 'collect-1' }),
      params: collectParams,
    })).toThrow(GameWriteBusyError)

    const observeParams = { observe: { radius: 4 } }
    await expect(registry.submit({
      envelope: makeEnvelope('observe', observeParams, { commandId: 'observe-1' }),
      params: observeParams,
    })).resolves.toMatchObject({ state: 'succeeded' })

    release!()
    await expect(moving).resolves.toMatchObject({ state: 'succeeded' })
  })

  it('expires a command with no terminal receipt and marks it unverified', async () => {
    const { registry, executor } = createTestRegistry()
    executor.setBehavior(() => new Promise(() => {}))
    executor.setStopConfirmed(false)

    const params = { moveTo: { x: 0, y: 64, z: 0, tolerance: 1 } }
    const receipt = await registry.submit({
      envelope: makeEnvelope('move_to', params, { commandId: 'stuck-1', deadlineMs: 25 }),
      params,
    })

    expect(receipt.state).toBe('expired')
    expect(receipt.endReason).toBe('deadline')
    expect(registry.listUnverified().map(item => item.commandId)).toEqual(['stuck-1'])
    expect(registry.listActive()).toEqual([])
  })

  it('reports a lease expiry as cancelled when the executor confirms the stop', async () => {
    const { registry, executor } = createTestRegistry()
    executor.setBehavior(() => new Promise(() => {}))
    executor.setStopConfirmed(true)

    const params = { observe: { radius: 4 } }
    const receipt = await registry.submit({
      envelope: makeEnvelope('observe', params, { commandId: 'slow-1', deadlineMs: 25 }),
      params,
    })

    expect(receipt.state).toBe('cancelled')
    expect(receipt.endReason).toBe('cancelled')
    expect(executor.stop).toHaveBeenCalledTimes(1)
    expect(registry.listUnverified()).toEqual([])
  })

  it('cancels an in-flight command and stays idempotent', async () => {
    const { registry, executor } = createTestRegistry()
    let release: (() => void) | undefined
    executor.setBehavior(async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { endReason: 'done', finalSnapshot: snapshot }
    })

    const params = { moveTo: { x: 0, y: 64, z: 0, tolerance: 1 } }
    const pending = registry.submit({ envelope: makeEnvelope('move_to', params, { commandId: 'cancel-me' }), params })

    const receipt = await registry.cancel('cancel-me')
    expect(receipt?.state).toBe('cancelled')
    expect(executor.stop).toHaveBeenCalledTimes(1)

    // The executor resolving late never changes a terminal state.
    release!()
    await expect(pending).resolves.toMatchObject({ state: 'cancelled' })
    await expect(registry.cancel('cancel-me')).resolves.toBe(receipt)
    expect(await registry.cancel('missing')).toBeUndefined()
  })
})

describe('receipts and postconditions', () => {
  it('succeeds a move that lands inside the tolerance', async () => {
    const { registry, executor } = createTestRegistry()
    executor.setBehavior(async () => ({
      endReason: 'reached',
      finalSnapshot: snapshot,
      finalPosition: { x: 4, y: 64, z: 0 },
    }))

    const params = { moveTo: { x: 0, y: 64, z: 0, tolerance: 5 } }
    const receipt = await registry.submit({ envelope: makeEnvelope('move_to', params), params })

    expect(receipt.state).toBe('succeeded')
    expect(receipt.postCondition).toEqual({ kind: 'distance', target: 5, actual: 4, met: true })
    expect(receipt.endReason).toBe('reached')
  })

  it('fails a move whose final position is outside the tolerance', async () => {
    const { registry, executor } = createTestRegistry()
    executor.setBehavior(async () => ({
      endReason: 'path_exhausted',
      finalSnapshot: snapshot,
      finalPosition: { x: 10, y: 64, z: 0 },
    }))

    const params = { moveTo: { x: 0, y: 64, z: 0, tolerance: 5 } }
    const receipt = await registry.submit({ envelope: makeEnvelope('move_to', params), params })

    expect(receipt.state).toBe('failed')
    expect(receipt.postCondition).toMatchObject({ kind: 'distance', target: 5, met: false })
    expect(receipt.endReason).toBe('path_exhausted')
  })

  it('checks the collect and observe postconditions from measured counts', async () => {
    const { registry, executor } = createTestRegistry()

    const collectParams = { collect: { blockId: 'minecraft:oak_log', itemId: 'minecraft:oak_log', maxCount: 3, radius: 8 } }
    executor.setBehavior(async () => ({ endReason: 'done', finalSnapshot: snapshot, collectedCount: 2 }))
    const short = await registry.submit({ envelope: makeEnvelope('collect', collectParams, { commandId: 'c1' }), params: collectParams })
    expect(short).toMatchObject({ state: 'failed', postCondition: { kind: 'collected', target: 3, actual: 2, met: false } })

    executor.setBehavior(async () => ({ endReason: 'done', finalSnapshot: snapshot, collectedCount: 3 }))
    const met = await registry.submit({ envelope: makeEnvelope('collect', collectParams, { commandId: 'c2' }), params: collectParams })
    expect(met).toMatchObject({ state: 'succeeded', postCondition: { kind: 'collected', target: 3, actual: 3, met: true } })

    const observeParams = { observe: { radius: 16 } }
    executor.setBehavior(async () => ({ endReason: 'done', finalSnapshot: snapshot, observedRadius: 16 }))
    const observed = await registry.submit({ envelope: makeEnvelope('observe', observeParams, { commandId: 'o1' }), params: observeParams })
    expect(observed).toMatchObject({ state: 'succeeded', postCondition: { kind: 'observed', target: 16, actual: 16, met: true } })
  })

  it('checks the craft postcondition from the claimed stack and the measured delta', async () => {
    const { registry, executor } = createTestRegistry()
    const craftParams = { craft: { recipeId: 'farmersdelight:flint_knife' } }

    executor.setBehavior(async () => ({ endReason: 'crafted', finalSnapshot: snapshot, craftedExpected: 1, craftedCount: 0 }))
    const short = await registry.submit({ envelope: makeEnvelope('craft', craftParams, { commandId: 'cr1' }), params: craftParams })
    expect(short).toMatchObject({ state: 'failed', postCondition: { kind: 'crafted', target: 1, actual: 0, met: false } })

    executor.setBehavior(async () => ({
      endReason: 'crafted',
      finalSnapshot: snapshot,
      craftedExpected: 1,
      craftedCount: 1,
      crafted: {
        recipeId: 'farmersdelight:flint_knife',
        output: { id: 'farmersdelight:flint_knife', count: 1 },
        attempts: 2,
        inventoryDelta: { 'farmersdelight:flint_knife': 1, 'minecraft:flint': -1, 'minecraft:stick': -1 },
      },
    }))
    const met = await registry.submit({ envelope: makeEnvelope('craft', craftParams, { commandId: 'cr2' }), params: craftParams })
    expect(met).toMatchObject({
      state: 'succeeded',
      postCondition: { kind: 'crafted', target: 1, actual: 1, met: true },
      crafted: { attempts: 2, inventoryDelta: { 'minecraft:flint': -1 } },
    })
  })

  it('holds the single-writer gate for craft like the other write actions', async () => {
    const { registry, executor } = createTestRegistry()
    executor.setBehavior(() => new Promise(() => {}))
    const craftParams = { craft: { recipeId: 'farmersdelight:flint_knife' } }
    void registry.submit({ envelope: makeEnvelope('craft', craftParams, { commandId: 'hold' }), params: craftParams })

    const sayParams = { say: { text: 'hi' } }
    expect(() => registry.submit({ envelope: makeEnvelope('say', sayParams, { commandId: 'blocked' }), params: sayParams }))
      .toThrow(GameWriteBusyError)
  })

  it('checks the drop postcondition from the measured inventory decrease', async () => {
    const { registry, executor } = createTestRegistry()
    const dropParams = { drop: { itemId: 'minecraft:oak_log', count: 2 } }

    executor.setBehavior(async () => ({ endReason: 'dropped', finalSnapshot: snapshot, droppedCount: 1 }))
    const short = await registry.submit({ envelope: makeEnvelope('drop', dropParams, { commandId: 'dr1' }), params: dropParams })
    expect(short).toMatchObject({ state: 'failed', postCondition: { kind: 'dropped', target: 2, actual: 1, met: false } })

    executor.setBehavior(async () => ({
      endReason: 'dropped',
      finalSnapshot: snapshot,
      droppedCount: 2,
      dropped: { itemId: 'minecraft:oak_log', count: 2, slot: 2 },
    }))
    const met = await registry.submit({ envelope: makeEnvelope('drop', dropParams, { commandId: 'dr2' }), params: dropParams })
    expect(met).toMatchObject({
      state: 'succeeded',
      postCondition: { kind: 'dropped', target: 2, actual: 2, met: true },
      dropped: { itemId: 'minecraft:oak_log', count: 2, slot: 2 },
    })
  })

  it('always marks say/status/cancel as met with a none postcondition', async () => {
    const { registry } = createTestRegistry()
    const params = { say: { text: 'hello' } }
    const receipt = await registry.submit({ envelope: makeEnvelope('say', params), params })

    expect(receipt).toMatchObject({ state: 'succeeded', postCondition: { kind: 'none', met: true } })
  })

  it('keeps the issued world on a receipt after the connection switches worlds', async () => {
    let binding = { connectionGeneration: 1, worldId: 'world-1' }
    const executor = createTestExecutor()
    const registry = createGameCommandRegistry({
      executor,
      getBinding: () => binding,
      stopGraceMs: 30,
      fallbackSnapshot: snapshot,
    })
    let release: () => void = () => {}
    executor.setBehavior(async () => {
      await new Promise<void>(resolve => release = resolve)
      return { endReason: 'done', finalSnapshot: snapshot, observedRadius: 4 }
    })

    const params = { observe: { radius: 4 } }
    const pending = registry.submit({ envelope: makeEnvelope('observe', params), params })
    // Another world becomes current while the command is still running; the
    // receipt must stay attributable to the world it was issued for (mc-1b D1).
    binding = { connectionGeneration: 2, worldId: 'world-2' }
    release()

    const receipt = await pending
    expect(receipt).toMatchObject({
      worldId: 'world-1',
      dimension: 'minecraft:overworld',
      connectionGeneration: 1,
      connectionId: 'connection-1',
    })
  })

  it('turns an executor error into a failed receipt with the fallback snapshot', async () => {
    const { registry, executor } = createTestRegistry()
    executor.setBehavior(async () => {
      throw new Error('executor exploded')
    })

    const params = { observe: { radius: 4 } }
    const receipt = await registry.submit({ envelope: makeEnvelope('observe', params), params })

    expect(receipt.state).toBe('failed')
    expect(receipt.endReason).toContain('executor_error: executor exploded')
    expect(receipt.finalSnapshot).toEqual(snapshot)
  })
})

describe('nextStopScope', () => {
  // ROOT CAUSE:
  //
  // Every executor entry cleared the shared stop flag, including read
  // commands: a read that ran while a write was being stopped un-stopped it
  // (review R7). Only write commands open a fresh scope now.
  it('opens a fresh scope for a write command', () => {
    expect(nextStopScope('move_to', { stopped: true })).toEqual({ stopped: false })
  })

  it('keeps the running write scope for a read command', () => {
    const current = { stopped: true }
    expect(nextStopScope('observe', current)).toBe(current)
  })
})

describe('execution ownership (CD-0 D8)', () => {
  const baseToken: GameExecutionToken = {
    commandId: 'cmd-1',
    connectionGeneration: 1,
    controlSessionId: 'control-1-1',
    controlSessionGeneration: 1,
    sequence: 0,
    goalRevision: 0,
  }

  it('binds a fresh scope to the command token', () => {
    const scope = nextStopScope('move_to', { stopped: true }, baseToken)
    expect(scope).toMatchObject({
      stopped: false,
      controlSessionId: 'control-1-1',
      controlSessionGeneration: 1,
      commandId: 'cmd-1',
    })
  })

  // ROOT CAUSE (D8):
  //
  // The stop hook set a shared boolean, so a late stop or `finally` from an
  // old command could stop the session a newer command now owned. The scope
  // now carries identity, and only a matching token stops it.
  // ROOT CAUSE (CD-0 D8 follow-up):
  //
  // The running executor captures the scope object in its `shouldStop`
  // closure. A stop that returned a copy would leave that closure reading
  // `false` forever, so a cancel could not interrupt a walk. The mark must be
  // written on the captured object itself.
  it('marks the captured scope object, and only for its own token', () => {
    const newToken: GameExecutionToken = { ...baseToken, commandId: 'cmd-2', controlSessionId: 'control-1-2', controlSessionGeneration: 2 }
    const captured = nextStopScope('move_to', { stopped: false }, newToken)
    const shouldStop = () => captured.stopped

    expect(stopScopeFor(captured, baseToken)).toBe(captured)
    expect(shouldStop()).toBe(false)

    expect(stopScopeFor(captured, newToken)).toBe(captured)
    expect(shouldStop()).toBe(true)
  })

  it('gives the executor a different token per write session', async () => {
    const { registry, executor } = createTestRegistry()
    const tokens: GameExecutionToken[] = []
    executor.setBehavior(async ({ token }) => {
      tokens.push(token)
      return { endReason: 'reached', finalSnapshot: snapshot, finalPosition: { x: 0, y: 64, z: 0 } }
    })

    const params = { moveTo: { x: 0, y: 64, z: 0, tolerance: 1 } }
    await registry.submit({ envelope: makeEnvelope('move_to', params, { commandId: 'session-a' }), params })
    await registry.submit({ envelope: makeEnvelope('move_to', params, { commandId: 'session-b' }), params })

    expect(tokens).toHaveLength(2)
    expect(tokens[0]!.controlSessionId).not.toBe(tokens[1]!.controlSessionId)
    expect(tokens[1]!.controlSessionGeneration).toBeGreaterThan(tokens[0]!.controlSessionGeneration)
  })

  it('does not let an expired command settle or revive after a newer command runs', async () => {
    const { registry, executor } = createTestRegistry()
    // The first command never returns and never confirms a stop: it expires.
    executor.setBehavior(() => new Promise(() => {}))
    executor.setStopConfirmed(false)
    const params = { moveTo: { x: 0, y: 64, z: 0, tolerance: 1 } }
    const expired = await registry.submit({
      envelope: makeEnvelope('move_to', params, { commandId: 'old', deadlineMs: 25 }),
      params,
    })
    expect(expired.state).toBe('expired')
    expect(registry.listActive()).toEqual([])

    // A newer command runs cleanly; the old session stays terminated.
    executor.setBehavior(async () => ({ endReason: 'reached', finalSnapshot: snapshot, finalPosition: { x: 0, y: 64, z: 0 } }))
    executor.setStopConfirmed(true)
    const fresh = await registry.submit({
      envelope: makeEnvelope('move_to', params, { commandId: 'new', deadlineMs: 500 }),
      params,
    })
    expect(fresh.state).toBe('succeeded')
    expect(registry.getState('old')).toBe('expired')
  })

  it('reports an unverified revocation as stop_unverified and never as stopped', async () => {
    const { registry, executor } = createTestRegistry()
    executor.setBehavior(() => new Promise(() => {}))
    executor.setStopConfirmed(false)
    const params = { moveTo: { x: 0, y: 64, z: 0, tolerance: 1 } }
    void registry.submit({ envelope: makeEnvelope('move_to', params, { commandId: 'revoke-me' }), params })

    const result = await registry.revoke('revoke-me')
    expect(result).toMatchObject({ state: 'expired', phase: 'terminated', endReason: 'stop_unverified', verified: false })
    expect(await registry.revoke('missing')).toBeUndefined()
  })
})

describe('stale sequence and goal revision (CD-0 §3.1)', () => {
  it('drops a submit whose sequence is older than the session high-water mark', async () => {
    const { registry } = createTestRegistry()
    const params = { observe: { radius: 4 } }
    await registry.submit({
      envelope: makeEnvelope('observe', params, { commandId: 's1', controlSessionId: 'ctrl', sequence: 5, goalRevision: 2 }),
      params,
    })
    expect(() => registry.submit({
      envelope: makeEnvelope('observe', params, { commandId: 's2', controlSessionId: 'ctrl', sequence: 4, goalRevision: 2 }),
      params,
    })).toThrow(GameStaleUpdateError)
  })

  it('drops a submit whose goal revision is older than the session high-water mark', async () => {
    const { registry } = createTestRegistry()
    const params = { observe: { radius: 4 } }
    await registry.submit({
      envelope: makeEnvelope('observe', params, { commandId: 'g1', controlSessionId: 'ctrl', sequence: 5, goalRevision: 2 }),
      params,
    })
    expect(() => registry.submit({
      envelope: makeEnvelope('observe', params, { commandId: 'g2', controlSessionId: 'ctrl', sequence: 6, goalRevision: 1 }),
      params,
    })).toThrow(GameStaleUpdateError)
  })

  it('applies a fresh goal update and drops a stale one', async () => {
    const { registry, executor } = createTestRegistry()
    executor.setBehavior(() => new Promise(() => {}))
    const params = { moveTo: { x: 0, y: 64, z: 0, tolerance: 1 } }
    void registry.submit({
      envelope: makeEnvelope('move_to', params, { commandId: 'goal', controlSessionId: 'ctrl', sequence: 1, goalRevision: 1 }),
      params,
    })

    const next = { moveTo: { x: 5, y: 64, z: 0, tolerance: 1 } }
    expect(registry.applyGoalUpdate({ commandId: 'goal', sequence: 2, goalRevision: 2, params: next })).toBe('applied')
    expect(registry.applyGoalUpdate({ commandId: 'goal', sequence: 2, goalRevision: 1 })).toBe('dropped')
    expect(registry.applyGoalUpdate({ commandId: 'goal', sequence: 1, goalRevision: 3 })).toBe('dropped')
  })
})
