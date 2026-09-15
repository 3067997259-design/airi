/**
 * MCP-backed movement port for the game host (MC-3 increment 2)。
 *
 * The tool names here are the MCP server surface (`set_movement`, `look`,
 * `jump`, `stop_movement`, `get_self`, `get_blocks_region`), not the bridge
 * method names. Extracted from the host so a mapping typo is a unit test
 * failure instead of a silently stuck walk.
 */
import type { MovementControlPort } from './port'

/** Calls one MCP tool and returns its structured record, if any. */
export type ToolCaller = (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>

export function createMcpMovementPort(callTool: ToolCaller): MovementControlPort {
  return {
    getState: async () => {
      const record = await callTool('get_self', {})
      const motion = record?.motion && typeof record.motion === 'object' && !Array.isArray(record.motion)
        ? record.motion as Record<string, unknown>
        : undefined
      const health = Number(record?.health)
      return {
        position: { x: Number(record?.x) || 0, y: Number(record?.y) || 0, z: Number(record?.z) || 0 },
        yaw: Number(record?.yaw) || 0,
        inWater: record?.inWater === true,
        onGround: record?.onGround !== false,
        ...(motion
          ? { motion: { x: Number(motion.x) || 0, y: Number(motion.y) || 0, z: Number(motion.z) || 0 } }
          : {}),
        ...(record?.fallFlying === true ? { fallFlying: true } : { fallFlying: false }),
        ...(Number.isFinite(health) ? { health } : {}),
      }
    },
    getBlocksRegion: async (from, to) => {
      const record = await callTool('get_blocks_region', { from, to, includeAir: true })
      const blocks = Array.isArray(record?.blocks) ? record.blocks as Array<Record<string, unknown>> : []
      return blocks.flatMap((block) => {
        const x = Number(block.x)
        const y = Number(block.y)
        const z = Number(block.z)
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z))
          return []
        const id = typeof block.id === 'string' ? block.id : 'minecraft:air'
        const properties = block.properties && typeof block.properties === 'object'
          ? block.properties as Record<string, string>
          : undefined
        return [{ x, y, z, id, ...(properties ? { properties } : {}) }]
      })
    },
    getBlock: async (pos) => {
      const record = await callTool('get_block', { x: pos.x, y: pos.y, z: pos.z })
      if (!record)
        return undefined
      const id = typeof record.id === 'string' ? record.id : 'minecraft:air'
      const properties = record.properties && typeof record.properties === 'object'
        ? record.properties as Record<string, string>
        : undefined
      return {
        id,
        air: record.air === true || id === 'minecraft:air',
        ...(properties ? { properties } : {}),
        ...(Number.isFinite(Number(record.hardness)) ? { hardness: Number(record.hardness) } : {}),
      }
    },
    getInventory: async () => {
      const record = await callTool('get_inventory', {})
      const slots: Array<{ slot: number, id: string, count: number, hotbar: boolean }> = []
      for (const key of ['hotbar', 'main'] as const) {
        const list = Array.isArray(record?.[key]) ? record[key] as Array<Record<string, unknown>> : []
        for (const item of list) {
          if (typeof item.id !== 'string' || item.id.length === 0)
            continue
          const damage = Number(item.damage)
          const maxDamage = Number(item.maxDamage)
          slots.push({
            slot: Number(item.slot) || 0,
            id: item.id,
            count: Number(item.count) || 0,
            hotbar: key === 'hotbar',
            ...(Number.isFinite(damage) ? { damage } : {}),
            ...(Number.isFinite(maxDamage) ? { maxDamage } : {}),
          })
        }
      }
      return slots
    },
    look: async (yaw, pitch) => {
      await callTool('look', { yaw, pitch })
    },
    setInput: async (input) => {
      await callTool('set_movement', { ...input })
    },
    stopMovement: async () => {
      await callTool('stop_movement', {})
    },
    jumpOnce: async () => {
      await callTool('jump', {})
    },
    breakBlock: async (pos) => {
      await callTool('break_block', { x: pos.x, y: pos.y, z: pos.z, mode: 'survival' })
    },
    placeBlock: async (support, face) => {
      await callTool('place_block', { x: support.x, y: support.y, z: support.z, face })
    },
    useBlock: async (pos) => {
      // NOTICE:
      // The bridge's `interact.useItem` is the air/item right-click
      // (`gameMode.useItem`); it cannot open doors. Only `interact.placeBlock`
      // performs `gameMode.useItemOn`, so block interaction goes through it.
      // Source/context: D:\mcpfabric\src\client\...\InteractHandlers.java:62,73.
      // Removal condition: when the bridge exposes a dedicated useBlock RPC.
      await callTool('place_block', { x: pos.x, y: pos.y, z: pos.z, face: 'up' })
    },
    useItem: async () => {
      // Air/item right-click: boats, buckets, fireworks, food (mc-3b D2).
      await callTool('use_item', {})
    },
    selectHotbar: async (slot) => {
      await callTool('select_hotbar_slot', { slot })
    },
    swapSlots: async (slotA, slotB) => {
      await callTool('swap_slots', { slotA, slotB })
    },
    dismount: async () => {
      // Sneak is the universal dismount input; release it after the pulse so
      // the player does not keep sneaking during the following walk.
      await callTool('set_movement', { sneak: true })
      await new Promise(resolve => setTimeout(resolve, 400))
      await callTool('stop_movement', {})
    },
    getRiding: async () => {
      const record = await callTool('get_vehicle', {})
      if (!record || record.riding !== true || typeof record.type !== 'string')
        return undefined
      return { kind: record.type, ...(typeof record.uuid === 'string' ? { uuid: record.uuid } : {}) }
    },
    boardNearestVehicle: async (radius, type) => {
      const record = await callTool('board_vehicle', { radius: radius ?? 4, ...(type ? { type } : {}) })
      if (!record || record.boarded !== true)
        return { boarded: false }
      return {
        boarded: true,
        info: {
          kind: typeof record.type === 'string' ? record.type : 'unknown',
          ...(typeof record.uuid === 'string' ? { uuid: record.uuid } : {}),
        },
      }
    },
    useEntity: async (uuid) => {
      await callTool('use_entity', { uuid })
    },
    getEquipment: async () => {
      const record = await callTool('get_equipment', {})
      const chest = record?.chest && typeof record.chest === 'object' && !Array.isArray(record.chest)
        ? record.chest as Record<string, unknown>
        : undefined
      if (!chest || chest.empty === true || typeof chest.id !== 'string')
        return {}
      const damage = Number(chest.damage)
      const maxDamage = Number(chest.maxDamage)
      return {
        chest: {
          id: chest.id,
          ...(Number.isFinite(damage) ? { damage } : {}),
          ...(Number.isFinite(maxDamage) ? { maxDamage } : {}),
        },
      }
    },
  }
}
