import { describe, expect, it, vi } from 'vitest'

import { createMcpMovementPort } from './host-port'

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
    expect(state).toEqual({
      position: { x: 1.5, y: 64, z: 2.5 },
      yaw: -90,
      inWater: true,
      onGround: false,
      motion: { x: 0.1, y: 0, z: 0.2 },
      fallFlying: true,
      health: 17,
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
})
