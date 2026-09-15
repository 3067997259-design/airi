import { describe, expect, it, vi } from 'vitest'

import { createMcpMovementPort } from './host-port'
import { buildTerrainSnapshot } from './observation'

function callerWith(records: Record<string, Record<string, unknown> | undefined>) {
  return vi.fn(async (name: string, _args: Record<string, unknown>) => records[name])
}

describe('createMcpMovementPort', () => {
  it('maps the port calls onto the MCP tool names', async () => {
    const callTool = callerWith({
      get_self: {
        x: 1.5,
        y: 64,
        z: 2.5,
        yaw: -90,
        inWater: true,
        onGround: false,
        motion: { x: 0.1, y: 0, z: 0.2 },
        fallFlying: true,
        health: 17,
      },
      get_blocks_region: { blocks: [{ x: 1, y: 63, z: 2, id: 'minecraft:stone' }] },
      get_block: { id: 'minecraft:oak_door', air: false, properties: { open: 'false' }, hardness: 3 },
      get_inventory: {
        hotbar: [{ slot: 5, id: 'minecraft:cobblestone', count: 64 }],
        main: [{ slot: 9, id: 'minecraft:dirt', count: 12 }],
      },
      get_vehicle: { riding: true, type: 'minecraft:oak_boat', uuid: 'boat-1' },
      board_vehicle: { boarded: true, type: 'minecraft:oak_boat', uuid: 'boat-2' },
      get_equipment: { chest: { id: 'minecraft:elytra', count: 1, damage: 430, maxDamage: 432 } },
    })
    const port = createMcpMovementPort(callTool)

    const state = await port.getState()
    expect(state).toMatchObject({
      position: { x: 1.5, y: 64, z: 2.5 },
      yaw: -90,
      inWater: true,
      onGround: false,
      motion: { x: 0.1, y: 0, z: 0.2 },
      fallFlying: true,
      health: 17,
    })
    expect(state.observation).toMatchObject({
      source: 'client-loaded-world',
      completeness: 'complete',
    })

    await port.setInput({ forward: true, sprint: true })
    await port.look(-90, 0)
    await port.stopMovement()
    await port.jumpOnce()
    await port.breakBlock({ x: 1, y: 64, z: 2 })
    await port.placeBlock({ x: 1, y: 63, z: 2 }, 'up')
    await port.useBlock({ x: 3, y: 64, z: 4 })
    await port.useItem()
    await port.selectHotbar(5)
    await port.swapSlots(12, 4)
    await port.useEntity('entity-1')
    const region = await port.getBlocksRegion({ x: 1, y: 63, z: 2 }, { x: 1, y: 63, z: 2 })
    const block = await port.getBlock({ x: 3, y: 64, z: 4 })
    const inventory = await port.getInventory()
    const riding = await port.getRiding()
    const boarded = await port.boardNearestVehicle(3)
    await port.boardNearestVehicle(6, 'minecraft:strider')
    const equipment = await port.getEquipment?.()

    expect(callTool).toHaveBeenCalledWith('set_movement', { forward: true, sprint: true })
    expect(callTool).toHaveBeenCalledWith('look', { yaw: -90, pitch: 0 })
    expect(callTool).toHaveBeenCalledWith('stop_movement', {})
    expect(callTool).toHaveBeenCalledWith('jump', {})
    expect(callTool).toHaveBeenCalledWith('break_block', { x: 1, y: 64, z: 2, mode: 'survival' })
    expect(callTool).toHaveBeenCalledWith('place_block', { x: 1, y: 63, z: 2, face: 'up' })
    // Block interaction (doors) uses the useItemOn path behind `place_block`.
    expect(callTool).toHaveBeenCalledWith('place_block', { x: 3, y: 64, z: 4, face: 'up' })
    expect(callTool).toHaveBeenCalledWith('use_item', {})
    expect(callTool).toHaveBeenCalledWith('select_hotbar_slot', { slot: 5 })
    expect(callTool).toHaveBeenCalledWith('swap_slots', { slotA: 12, slotB: 4 })
    expect(callTool).toHaveBeenCalledWith('use_entity', { uuid: 'entity-1' })
    expect(callTool).toHaveBeenCalledWith('get_blocks_region', {
      from: { x: 1, y: 63, z: 2 },
      to: { x: 1, y: 63, z: 2 },
      includeAir: true,
    })
    expect(region).toEqual([{ x: 1, y: 63, z: 2, id: 'minecraft:stone' }])
    expect(block).toEqual({
      id: 'minecraft:oak_door',
      air: false,
      properties: { open: 'false' },
      hardness: 3,
    })
    expect(inventory).toEqual([
      { slot: 5, id: 'minecraft:cobblestone', count: 64, hotbar: true },
      { slot: 9, id: 'minecraft:dirt', count: 12, hotbar: false },
    ])
    expect(riding).toEqual({ kind: 'minecraft:oak_boat', uuid: 'boat-1' })
    expect(boarded).toEqual({ boarded: true, info: { kind: 'minecraft:oak_boat', uuid: 'boat-2' } })
    expect(equipment).toEqual({ chest: { id: 'minecraft:elytra', damage: 430, maxDamage: 432 } })
    expect(callTool).toHaveBeenCalledWith('get_vehicle', {})
    expect(callTool).toHaveBeenCalledWith('board_vehicle', { radius: 3 })
    expect(callTool).toHaveBeenCalledWith('board_vehicle', { radius: 6, type: 'minecraft:strider' })
    expect(callTool).toHaveBeenCalledWith('get_equipment', {})
  })

  it('parses region entries defensively', async () => {
    const callTool = callerWith({
      get_blocks_region: {
        blocks: [
          { x: 0, y: 1, z: 2, id: 'minecraft:oak_door', properties: { open: 'true' } },
          { x: 'nope', y: 1, z: 2, id: 'minecraft:stone' },
          { x: 3, y: 4, z: 5 },
        ],
      },
    })
    const entries = await createMcpMovementPort(callTool).getBlocksRegion({ x: 0, y: 0, z: 0 }, { x: 4, y: 4, z: 5 })
    expect(entries).toEqual([
      { x: 0, y: 1, z: 2, id: 'minecraft:oak_door', properties: { open: 'true' } },
      { x: 3, y: 4, z: 5, id: 'minecraft:air' },
    ])
  })

  it('reports a missing block read as undefined and defaults air ids', async () => {
    const callTool = callerWith({ get_block: undefined })
    expect(await createMcpMovementPort(callTool).getBlock({ x: 1, y: 2, z: 3 })).toBeUndefined()

    const airCaller = callerWith({ get_block: {} })
    expect(await createMcpMovementPort(airCaller).getBlock({ x: 1, y: 2, z: 3 })).toEqual({ id: 'minecraft:air', air: true })
  })

  it('pulses sneak to dismount and releases it', async () => {
    const callTool = callerWith({})
    const port = createMcpMovementPort(callTool)
    await port.dismount()
    expect(callTool).toHaveBeenCalledWith('set_movement', { sneak: true })
    expect(callTool).toHaveBeenCalledWith('stop_movement', {})
  })

  it('stamps control writes with the command session and an increasing sequence, and rotates after a release', async () => {
    const callTool = callerWith({})
    let sequence = 4
    const control = {
      controlSessionId: 'ctrl-1',
      nextSequence: () => {
        sequence += 1
        return sequence
      },
      rotate: () => {
        control.controlSessionId = 'ctrl-1:2'
        sequence = 0
      },
    }
    const port = createMcpMovementPort(callTool, { control })
    await port.setInput({ forward: true })
    await port.setInput({ sprint: true })
    await port.stopMovement()
    await port.setInput({ jump: true })
    expect(callTool).toHaveBeenNthCalledWith(1, 'set_movement', { forward: true, controlSessionId: 'ctrl-1', sequence: 5 })
    expect(callTool).toHaveBeenNthCalledWith(2, 'set_movement', { sprint: true, controlSessionId: 'ctrl-1', sequence: 6 })
    expect(callTool).toHaveBeenNthCalledWith(3, 'stop_movement', {})
    // The bridge revokes the session on stop; the next input is a new session.
    expect(callTool).toHaveBeenNthCalledWith(4, 'set_movement', { jump: true, controlSessionId: 'ctrl-1:2', sequence: 1 })
  })

  it('keeps an explicit empty collision array and reports exact shapes', async () => {
    const callTool = callerWith({
      get_blocks_region: {
        blocks: [
          { x: 0, y: 0, z: 0, id: 'minecraft:torch', collision: [] },
          { x: 1, y: 0, z: 0, id: 'minecraft:oak_stairs', collision: [{ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 0.5, maxZ: 1 }] },
        ],
        exactShapes: true,
      },
    })
    const port = createMcpMovementPort(callTool)
    const detailed = await port.getBlocksRegionDetailed?.({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 })
    expect(detailed?.exactShapes).toBe(true)
    // An empty array is a fact ("does not collide"), not a missing shape.
    expect(detailed?.entries[0]?.collision).toEqual([])
    expect(detailed?.entries[1]?.collision).toEqual([{ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 0.5, maxZ: 1 }])
  })

  // ROOT CAUSE (D4):
  //
  // A missing `get_self` record became position zero, `onGround: true` and
  // `fallFlying: false`. A flight loop then read a failed scan as touchdown.
  // The port now rejects an unreadable state instead of inventing one.
  it('rejects an unreadable player state instead of inventing a landing', async () => {
    const port = createMcpMovementPort(async () => undefined)
    await expect(port.getState()).rejects.toThrow('Player state is unreadable')
  })

  it('rejects a player state without a finite position', async () => {
    const port = createMcpMovementPort(async () => ({ onGround: true, dimension: 'minecraft:overworld' }))
    await expect(port.getState()).rejects.toThrow('no finite position')
  })

  it('does not fabricate fallFlying when the read omits it', async () => {
    const port = createMcpMovementPort(async () => ({ x: 1, y: 2, z: 3, onGround: false }))
    const state = await port.getState()
    expect(state.fallFlying).toBeUndefined()
    expect(state.onGround).toBe(false)
  })

  // D12: a response for another dimension is rejected instead of being read
  // through `Levels.resolve`'s overworld default.
  it('rejects a player read from another dimension', async () => {
    const port = createMcpMovementPort(
      async () => ({ x: 1, y: 2, z: 3, dimension: 'minecraft:the_nether' }),
      { dimension: () => 'minecraft:overworld' },
    )
    await expect(port.getState()).rejects.toThrow('dimension mismatch')
  })

  it('rejects a region read from another dimension', async () => {
    const port = createMcpMovementPort(
      async () => ({ blocks: [], dimension: 'minecraft:the_nether' }),
      { dimension: () => 'minecraft:overworld' },
    )
    await expect(port.getBlocksRegion({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })).rejects.toThrow('dimension mismatch')
  })

  it('fails a region read that carried no block list instead of returning empty', async () => {
    const port = createMcpMovementPort(async () => ({ unloaded: [] }))
    await expect(port.getBlocksRegion({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })).rejects.toThrow('no block list')
  })

  it('never reports an uncovered terrain cell as air', async () => {
    const port = createMcpMovementPort(
      async () => ({ blocks: [{ x: 0, y: 0, z: 0, id: 'minecraft:air' }], unloaded: [{ x: 1, y: 0, z: 0 }] }),
      { dimension: () => 'minecraft:overworld', worldId: () => 'world-1', connectionGeneration: () => 7 },
    )
    const response = await port.readTerrain?.({
      bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 0, z: 0 } },
      dimension: 'minecraft:overworld',
      worldId: 'world-1',
      connectionGeneration: 7,
      startedAt: 1_000,
    })
    expect(response).toBeDefined()
    const snapshot = buildTerrainSnapshot(
      {
        bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 0, z: 0 } },
        dimension: 'minecraft:overworld',
        worldId: 'world-1',
        connectionGeneration: 7,
        startedAt: 1_000,
      },
      response!,
    )
    expect(snapshot.isKnownAir(0, 0, 0)).toBe(true)
    expect(snapshot.cellAt(1, 0, 0)?.kind).toBe('unloaded')
    expect(snapshot.cellAt(2, 0, 0)).toBeUndefined()
    expect(snapshot.isKnownAir(2, 0, 0)).toBe(false)
  })

  it('attaches the vehicle observation surface only when its tools exist', async () => {
    const callTool = callerWith({
      get_vehicle_state: {
        uuid: 'h-1',
        entity: { type: 'minecraft:horse', x: 1, y: 64, z: 2, passengers: [], tamed: true, saddled: false, controlledByPassenger: false },
      },
      get_vehicles: {
        vehicles: [
          { uuid: 'b-1', type: 'minecraft:oak_boat', entity: { type: 'minecraft:oak_boat', x: 0, y: 63, z: 0, passengers: [] } },
        ],
      },
      board_vehicle_uuid: { boarded: true, type: 'minecraft:horse', uuid: 'h-1' },
    })
    const enabled = createMcpMovementPort(callTool, {
      worldId: () => 'world',
      dimension: () => 'minecraft:overworld',
      connectionGeneration: () => 2,
      hasTool: name => ['get_vehicle_state', 'get_vehicles', 'board_vehicle_uuid'].includes(name),
    })

    const observation = await enabled.observeVehicle?.({
      uuid: 'h-1',
      dimension: 'minecraft:overworld',
      worldId: 'world',
      connectionGeneration: 2,
      startedAt: 0,
    })
    expect(observation).toMatchObject({ uuid: 'h-1', kind: 'horse', free: true, state: { kind: 'horse', tamed: true, saddled: false } })

    const candidates = await enabled.queryVehicles?.({
      dimension: 'minecraft:overworld',
      worldId: 'world',
      connectionGeneration: 2,
      kind: 'boat',
      startedAt: 0,
    })
    expect(candidates).toHaveLength(1)
    expect(candidates?.[0]?.uuid).toBe('b-1')

    expect(await enabled.boardVehicle?.('h-1')).toEqual({ boarded: true, info: { kind: 'minecraft:horse', uuid: 'h-1' } })
    expect(callTool).toHaveBeenCalledWith('get_vehicle_state', { uuid: 'h-1' })
    expect(callTool).toHaveBeenCalledWith('get_vehicles', { radius: 8, kind: 'boat' })
    expect(callTool).toHaveBeenCalledWith('board_vehicle_uuid', { uuid: 'h-1' })

    // A bridge without the tools must not expose the surface at all.
    const disabled = createMcpMovementPort(callTool)
    expect(disabled.observeVehicle).toBeUndefined()
    expect(disabled.queryVehicles).toBeUndefined()
    expect(disabled.boardVehicle).toBeUndefined()
  })
})
