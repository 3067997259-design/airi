/**
 * MCP-backed movement port for the game host (MC-3 increment 2)。
 *
 * The tool names here are the MCP server surface (`set_movement`, `look`,
 * `jump`, `stop_movement`, `get_self`, `get_blocks_region`), not the bridge
 * method names. Extracted from the host so a mapping typo is a unit test
 * failure instead of a silently stuck walk.
 *
 * CD-0 §3.2/§3.3: reads carry the current world binding with them, a mismatched
 * dimension is rejected, and an unreadable read fails loudly instead of
 * becoming zero coordinates, `onGround: true`, or an empty world.
 */
import type { ObservationEnvelope, TerrainReadRequest, TerrainReadResponse } from './observation'
import type { SnapshotEntry } from './snapshot'
import type { CollisionBox } from './types'
import type { VehicleReadResponse } from './vehicle-observation'
import type { VehicleControlPort } from './vehicle-port'
import type { VehicleObservation, VehicleObservationRequest, VehicleQueryRequest } from './vehicle-types'

import { DimensionMismatchError, TerrainReadError } from './observation'
import { UnreadablePlayerStateError } from './port'
import { buildVehicleObservation } from './vehicle-observation'

/** Calls one MCP tool and returns its structured record, if any. */
export type ToolCaller = (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>

/**
 * World binding the port verifies its reads against (CD-0 §3.2).
 *
 * Getters, not values: the binding changes when the player crosses a
 * dimension. A read whose response names another dimension is rejected.
 */
export interface MovementPortContext {
  worldId?: () => string | undefined
  dimension?: () => string | undefined
  connectionGeneration?: () => number
  /** Wall-clock source used to stamp observation freshness; tests inject it. */
  now?: () => number
  /**
   * Whether the bridge exposed a named tool (CD-0 §3.3).
   *
   * Vehicle observation is only attached when its backing tool exists, so a
   * bridge without it reports the capability as absent instead of answering
   * every query with an empty list.
   */
  hasTool?: (name: string) => boolean
  /** Input-ownership identity for control writes (CD-0 unlock). */
  control?: MovementPortControl
}

/**
 * Control-write identity handed to one command (CD-0 §3.1 unlock).
 *
 * `setInput` stamps every write with the session id and a strictly increasing
 * sequence, so the bridge rejects a revoked session or a stale write instead of
 * letting an old command move the player. The counter belongs to the command
 * that minted it.
 */
export interface MovementPortControl {
  controlSessionId: string
  nextSequence: () => number
}

/** Parses cell-local collision boxes a shape-aware source may attach. */
function parseCollision(raw: unknown): CollisionBox[] | undefined {
  if (!Array.isArray(raw))
    return undefined
  const boxes: CollisionBox[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      continue
    const value = entry as Record<string, unknown>
    const minX = Number(value.minX)
    const minY = Number(value.minY)
    const minZ = Number(value.minZ)
    const maxX = Number(value.maxX)
    const maxY = Number(value.maxY)
    const maxZ = Number(value.maxZ)
    if ([minX, minY, minZ, maxX, maxY, maxZ].every(Number.isFinite))
      boxes.push({ minX, minY, minZ, maxX, maxY, maxZ })
  }
  // An empty array is a fact: the source sent the shape and the block does not
  // collide. Only a missing field means "unknown" (CD-G2 unlock).
  return boxes
}

/** Maps one region read's raw block list into snapshot entries. */
function parseRegionEntries(raw: unknown[]): SnapshotEntry[] {
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      return []
    const block = entry as Record<string, unknown>
    const x = Number(block.x)
    const y = Number(block.y)
    const z = Number(block.z)
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z))
      return []
    const id = typeof block.id === 'string' ? block.id : 'minecraft:air'
    const properties = block.properties && typeof block.properties === 'object'
      ? block.properties as Record<string, string>
      : undefined
    const collision = parseCollision(block.collision)
    return [{ x, y, z, id, ...(properties ? { properties } : {}), ...(collision ? { collision } : {}) }]
  })
}

function parseUnloaded(raw: unknown): Array<{ x: number, y: number, z: number }> {
  if (!Array.isArray(raw))
    return []
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      return []
    const value = entry as Record<string, unknown>
    const x = Number(value.x)
    const y = Number(value.y)
    const z = Number(value.z)
    return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? [{ x, y, z }] : []
  })
}

export function createMcpMovementPort(callTool: ToolCaller, context: MovementPortContext = {}): VehicleControlPort {
  const dimensionOf = () => context.dimension?.()
  const worldIdOf = () => context.worldId?.()
  const generationOf = () => context.connectionGeneration?.() ?? 0
  const now = () => context.now?.() ?? Date.now()
  // A missing `hasTool` means "no optional vehicle tools"; the base port must
  // not pretend the capability exists (CD-0 §3.3).
  const hasTool = (name: string) => context.hasTool?.(name) === true
  const control = context.control

  /** Turns one raw vehicle entity record into a typed observation. */
  function vehicleObservationOf(request: VehicleObservationRequest, record: Record<string, unknown> | undefined): VehicleObservation | undefined {
    if (!record)
      return undefined
    const entity = record.entity && typeof record.entity === 'object' && !Array.isArray(record.entity)
      ? record.entity as Record<string, unknown>
      : record
    const response: VehicleReadResponse = {
      ...(typeof record.uuid === 'string' ? { uuid: record.uuid } : {}),
      ...(typeof record.type === 'string' ? { type: record.type } : {}),
      ...(typeof record.dimension === 'string' ? { dimension: record.dimension } : {}),
      worldId: worldIdOf() ?? '',
      connectionGeneration: generationOf(),
      source: 'client-loaded-entity',
      receivedAt: now(),
      entity,
      ...(typeof record.absence === 'string' ? { absence: record.absence as VehicleReadResponse['absence'] } : {}),
    }
    return buildVehicleObservation(request, response)
  }

  /** Rejects a response that names a different dimension than the binding. */
  function assertDimension(expected: string | undefined, received: string | undefined): void {
    if (expected && received && expected !== received)
      throw new DimensionMismatchError(expected, received)
  }

  /**
   * One raw region read with dimension verification.
   *
   * A missing `blocks` array is a read failure, never an empty region: the
   * caller must not scan a world that was never loaded.
   */
  async function readRegionRecord(from: { x: number, y: number, z: number }, to: { x: number, y: number, z: number }): Promise<{
    record: Record<string, unknown>
    dimension?: string
    startedAt: number
    receivedAt: number
  }> {
    const startedAt = now()
    const args: Record<string, unknown> = { from, to, includeAir: true }
    const expectedDimension = dimensionOf()
    if (expectedDimension)
      args.dimension = expectedDimension
    const record = await callTool('get_blocks_region', args)
    const receivedAt = now()
    if (!record)
      throw new TerrainReadError('region read returned no record')
    const receivedDimension = typeof record.dimension === 'string' ? record.dimension : undefined
    assertDimension(expectedDimension, receivedDimension)
    if (record.error !== undefined && record.error !== null)
      throw new TerrainReadError(String(record.error))
    if (!Array.isArray(record.blocks))
      throw new TerrainReadError('region read carried no block list')
    return { record, ...(receivedDimension ? { dimension: receivedDimension } : {}), startedAt, receivedAt }
  }

  function observationOf(input: {
    source: string
    dimension?: string
    requestStartedAt: number
    requestEndedAt: number
    sourceTick?: number
    completeness?: ObservationEnvelope['completeness']
    missingReason?: string
  }): ObservationEnvelope {
    return {
      source: input.source,
      worldId: worldIdOf() ?? '',
      dimension: input.dimension ?? dimensionOf() ?? '',
      connectionGeneration: generationOf(),
      ...(input.sourceTick !== undefined ? { sourceTick: input.sourceTick } : {}),
      receivedAt: input.requestEndedAt,
      requestStartedAt: input.requestStartedAt,
      requestEndedAt: input.requestEndedAt,
      completeness: input.completeness ?? 'complete',
      ...(input.missingReason ? { missingReason: input.missingReason } : {}),
    }
  }

  return {
    getState: async () => {
      const startedAt = now()
      const record = await callTool('get_self', {})
      const receivedAt = now()
      if (!record)
        throw new UnreadablePlayerStateError('get_self returned no record')
      const dimension = typeof record.dimension === 'string' ? record.dimension : undefined
      assertDimension(dimensionOf(), dimension)
      const x = Number(record.x)
      const y = Number(record.y)
      const z = Number(record.z)
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z))
        throw new UnreadablePlayerStateError('get_self returned no finite position')
      const motion = record.motion && typeof record.motion === 'object' && !Array.isArray(record.motion)
        ? record.motion as Record<string, unknown>
        : undefined
      const health = Number(record.health)
      return {
        position: { x, y, z },
        yaw: Number(record.yaw) || 0,
        inWater: record.inWater === true,
        // Unknown ground contact is not a landing: only an explicit true counts.
        onGround: record.onGround === true,
        ...(motion
          ? { motion: { x: Number(motion.x) || 0, y: Number(motion.y) || 0, z: Number(motion.z) || 0 } }
          : {}),
        // A missing `fallFlying` field is left absent; false is a fact, not a default.
        ...(typeof record.fallFlying === 'boolean' ? { fallFlying: record.fallFlying } : {}),
        ...(Number.isFinite(health) ? { health } : {}),
        observation: observationOf({ source: 'client-loaded-world', requestStartedAt: startedAt, requestEndedAt: receivedAt }),
      }
    },
    getBlocksRegion: async (from, to) => {
      const { record } = await readRegionRecord(from, to)
      return parseRegionEntries(record.blocks as unknown[])
    },
    getBlocksRegionDetailed: async (from, to) => {
      const { record } = await readRegionRecord(from, to)
      // Full-cube boxes are omitted by the source; `exactShapes` says the
      // partial and empty shapes are exact per state (CD-G2 unlock).
      return { entries: parseRegionEntries(record.blocks as unknown[]), exactShapes: record.exactShapes === true }
    },
    readTerrain: async (request: TerrainReadRequest): Promise<TerrainReadResponse> => {
      const { record, dimension, receivedAt } = await readRegionRecord(request.bounds.min, request.bounds.max)
      const sourceTick = Number(record.sourceTick)
      return {
        blocks: record.blocks as unknown[],
        unloaded: parseUnloaded(record.unloaded),
        truncated: record.truncated === true,
        source: typeof record.source === 'string' ? record.source : 'client-loaded-world',
        ...(dimension ? { dimension } : {}),
        ...(worldIdOf() ? { worldId: worldIdOf() } : {}),
        connectionGeneration: generationOf(),
        ...(Number.isFinite(sourceTick) ? { sourceTick } : {}),
        endedAt: receivedAt,
        receivedAt,
      }
    },
    getBlock: async (pos) => {
      const expectedDimension = dimensionOf()
      const record = await callTool('get_block', {
        x: pos.x,
        y: pos.y,
        z: pos.z,
        ...(expectedDimension ? { dimension: expectedDimension } : {}),
      })
      if (!record)
        return undefined
      assertDimension(expectedDimension, typeof record.dimension === 'string' ? record.dimension : undefined)
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
      // CD-0 §3.1: stamp the write with this command's session identity so the
      // bridge can reject a revoked session or a stale sequence.
      await callTool('set_movement', control
        ? { ...input, controlSessionId: control.controlSessionId, sequence: control.nextSequence() }
        : { ...input })
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
    // The optional vehicle surface is attached only when its tool exists, so a
    // bridge without it degrades to unverified driving rather than an empty
    // candidate list that looks like "no vehicle nearby".
    ...(hasTool('get_vehicle_state')
      ? {
          observeVehicle: async (request: VehicleObservationRequest) => {
            const record = await callTool('get_vehicle_state', { uuid: request.uuid })
            return vehicleObservationOf(request, record)
          },
        }
      : {}),
    ...(hasTool('get_vehicles')
      ? {
          queryVehicles: async (request: VehicleQueryRequest) => {
            const record = await callTool('get_vehicles', {
              radius: request.radius ?? 8,
              ...(request.kind ? { kind: request.kind } : {}),
            })
            const list = Array.isArray(record?.vehicles) ? record.vehicles : []
            const out: VehicleObservation[] = []
            for (const raw of list) {
              if (!raw || typeof raw !== 'object' || Array.isArray(raw))
                continue
              const entry = raw as Record<string, unknown>
              const uuid = typeof entry.uuid === 'string' ? entry.uuid : undefined
              if (!uuid)
                continue
              const observation = vehicleObservationOf({ ...request, uuid }, entry)
              if (observation)
                out.push(observation)
            }
            return out
          },
        }
      : {}),
    ...(hasTool('board_vehicle_uuid')
      ? {
          boardVehicle: async (uuid: string) => {
            const record = await callTool('board_vehicle_uuid', { uuid })
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
        }
      : {}),
  }
}
