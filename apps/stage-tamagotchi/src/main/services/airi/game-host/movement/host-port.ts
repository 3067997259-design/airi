import type { ObservationEnvelope, TerrainReadRequest, TerrainReadResponse } from './observation'
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
import type { ElytraLaunchStatus, ElytraLaunchTask, FlightChannelRevokeReceipt, FlightChannelSample, FlightChannelStatus, FlightChannelSubmitReceipt, FlightChannelSubmitRequest, FlightLandingSiteReceipt, FlightLandingSiteRequest, JumpTask, JumpTaskStatus } from './port'
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
  /**
   * Starts a fresh input session after a release.
   *
   * The bridge revokes the session on `stop_movement`, so a command that
   * releases the keys mid-run (for example before breaking a block) must send
   * its next input under a new session id (CD-0 §3.1).
   */
  rotate: () => void
}

/** Maps one jump task status read; a missing state is `idle`, never landed. */
function jumpStatusOf(record: Record<string, unknown> | undefined): JumpTaskStatus {
  const state = typeof record?.state === 'string' ? record.state : 'idle'
  const position = record?.position && typeof record.position === 'object' && !Array.isArray(record.position)
    ? record.position as Record<string, unknown>
    : undefined
  const x = Number(position?.x)
  const y = Number(position?.y)
  const z = Number(position?.z)
  const distance = Number(record?.distance)
  const motion = record?.motion && typeof record.motion === 'object' && !Array.isArray(record.motion)
    ? record.motion as Record<string, unknown>
    : undefined
  const motionX = Number(motion?.x)
  const motionZ = Number(motion?.z)
  return {
    state: state as JumpTaskStatus['state'],
    endReason: typeof record?.endReason === 'string' ? record.endReason : 'unknown',
    ticks: Number(record?.ticks) || 0,
    ...(typeof record?.edgeId === 'string' ? { edgeId: record.edgeId } : {}),
    ...(typeof record?.phase === 'string' ? { phase: record.phase } : {}),
    ...(typeof record?.effectiveInput === 'string' ? { effectiveInput: record.effectiveInput } : {}),
    ...(typeof record?.landingIntent === 'string' ? { landingIntent: record.landingIntent } : {}),
    ...(typeof record?.nextEdgeId === 'string' ? { nextEdgeId: record.nextEdgeId } : {}),
    ...(Number.isFinite(Number(record?.completedCount)) ? { completedCount: Number(record?.completedCount) } : {}),
    ...(Number.isFinite(motionX) && Number.isFinite(motionZ) ? { motion: { x: motionX, z: motionZ } } : {}),
    ...(typeof record?.support === 'string' ? { support: record.support } : {}),
    ...(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? { position: { x, y, z } } : {}),
    ...(typeof record?.onGround === 'boolean' ? { onGround: record.onGround } : {}),
    ...(Number.isFinite(distance) ? { distance } : {}),
    ...(typeof record?.takeoffPassed === 'boolean' ? { takeoffPassed: record.takeoffPassed } : {}),
  }
}

/**
 * Inventory index the bridge uses for the offhand.
 *
 * `InventoryHandlers.toMenuSlot` documents the whole convention: 0-8 hotbar,
 * 9-35 main, 36-39 armor, 40 offhand, and it rejects anything else, so 40 is the
 * only number that names the offhand on the wire. The host uses it to report an
 * offhand stack in an inventory read and to swap it into the hotbar.
 */
const OFFHAND_SLOT = 40

/** Maps one elytra launch status read; a missing state is `idle`, never launched. */
function launchStatusOf(record: Record<string, unknown> | undefined): ElytraLaunchStatus {
  const state = typeof record?.state === 'string' ? record.state : 'idle'
  const position = record?.position && typeof record.position === 'object' && !Array.isArray(record.position)
    ? record.position as Record<string, unknown>
    : undefined
  const x = Number(position?.x)
  const y = Number(position?.y)
  const z = Number(position?.z)
  const verticalSpeed = Number(record?.verticalSpeed)
  const climb = Number(record?.climb)
  return {
    state: state as ElytraLaunchStatus['state'],
    endReason: typeof record?.endReason === 'string' ? record.endReason : 'unknown',
    ticks: Number(record?.ticks) || 0,
    ...(typeof record?.phase === 'string' ? { phase: record.phase } : {}),
    ...(typeof record?.airborne === 'boolean' ? { airborne: record.airborne } : {}),
    ...(typeof record?.deployed === 'boolean' ? { deployed: record.deployed } : {}),
    ...(typeof record?.onGround === 'boolean' ? { onGround: record.onGround } : {}),
    ...(Number.isFinite(verticalSpeed) ? { verticalSpeed } : {}),
    ...(Number.isFinite(climb) ? { climb } : {}),
    ...(Number.isFinite(Number(record?.fireworksUsed)) ? { fireworksUsed: Number(record?.fireworksUsed) } : {}),
    ...(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? { position: { x, y, z } } : {}),
  }
}

/** Reads `{ x, y, z }` from either a nested object or the record itself. */
function vec3Of(record: Record<string, unknown> | undefined, key?: string): { x: number, y: number, z: number } {
  const source = key
    ? (record?.[key] && typeof record[key] === 'object' && !Array.isArray(record[key])
        ? record[key] as Record<string, unknown>
        : undefined)
    : record
  return {
    x: Number(source?.x) || 0,
    y: Number(source?.y) || 0,
    z: Number(source?.z) || 0,
  }
}

/**
 * Maps one trajectory ring sample; a short record still carries its tick.
 *
 * The client sends `position` and `velocity` as nested objects, so both shapes
 * are read here. Flattening to the port's scalar fields is the transport's job.
 */
function flightSampleOf(record: Record<string, unknown> | undefined): FlightChannelSample {
  const position = vec3Of(record, 'position')
  const velocity = vec3Of(record, 'velocity')
  return {
    tick: Number(record?.tick) || 0,
    x: position.x,
    y: position.y,
    z: position.z,
    vx: velocity.x,
    vy: velocity.y,
    vz: velocity.z,
    yaw: Number(record?.yaw) || 0,
    pitch: Number(record?.pitch) || 0,
    gliding: record?.gliding === true,
    onGround: record?.onGround === true,
    boostAttached: record?.boostAttached === true,
    rocketFiredThisTick: record?.rocketFiredThisTick === true,
    inputOwner: typeof record?.inputOwner === 'string' ? record.inputOwner : 'none',
    ...(Number.isFinite(Number(record?.health)) ? { health: Number(record?.health) } : {}),
    ...(typeof record?.inWater === 'boolean' ? { inWater: record.inWater } : {}),
    ...(Number.isFinite(Number(record?.rocketsInHands)) ? { rocketsInHands: Number(record?.rocketsInHands) } : {}),
    ...(Number.isFinite(Number(record?.rocketsInInventory)) ? { rocketsInInventory: Number(record?.rocketsInInventory) } : {}),
    ...(typeof record?.sessionId === 'string' ? { sessionId: record.sessionId } : {}),
    ...(Number.isFinite(Number(record?.revision)) ? { revision: Number(record?.revision) } : {}),
    ...(typeof record?.holding === 'boolean' ? { holding: record.holding } : {}),
    ...(Number.isFinite(Number(record?.boostRemainingEstimate)) ? { boostRemainingEstimate: Number(record?.boostRemainingEstimate) } : {}),
    ...(typeof record?.boostEntityIds === 'string' ? { boostEntityIds: record.boostEntityIds } : {}),
    ...(Number.isFinite(Number(record?.boostCount)) ? { boostCount: Number(record?.boostCount) } : {}),
    ...(Number.isFinite(Number(record?.targetX)) ? { targetX: Number(record?.targetX) } : {}),
    ...(Number.isFinite(Number(record?.targetY)) ? { targetY: Number(record?.targetY) } : {}),
    ...(Number.isFinite(Number(record?.targetZ)) ? { targetZ: Number(record?.targetZ) } : {}),
    ...(Number.isFinite(Number(record?.cursor)) ? { cursor: Number(record?.cursor) } : {}),
    ...(Number.isFinite(Number(record?.predictedEndTicks)) ? { predictedEndTicks: Number(record?.predictedEndTicks) } : {}),
    ...(Number.isFinite(Number(record?.predictedEndCursor)) ? { predictedEndCursor: Number(record?.predictedEndCursor) } : {}),
    ...(Number.isFinite(Number(record?.predictedEndX)) ? { predictedEndX: Number(record?.predictedEndX) } : {}),
    ...(Number.isFinite(Number(record?.predictedEndY)) ? { predictedEndY: Number(record?.predictedEndY) } : {}),
    ...(Number.isFinite(Number(record?.predictedEndZ)) ? { predictedEndZ: Number(record?.predictedEndZ) } : {}),
    ...(typeof record?.predictedEndReason === 'string' ? { predictedEndReason: record.predictedEndReason } : {}),
    ...(typeof record?.preview === 'string' ? { preview: record.preview } : {}),
    ...(typeof record?.terminalAction === 'string' ? { terminalAction: record.terminalAction } : {}),
    ...(typeof record?.rejectKind === 'string' && record.rejectKind !== '' ? { rejectKind: record.rejectKind } : {}),
    ...(Number.isFinite(Number(record?.rejectTick)) ? { rejectTick: Number(record?.rejectTick) } : {}),
    ...(Number.isFinite(Number(record?.rejectX)) ? { rejectX: Number(record?.rejectX) } : {}),
    ...(Number.isFinite(Number(record?.rejectY)) ? { rejectY: Number(record?.rejectY) } : {}),
    ...(Number.isFinite(Number(record?.rejectZ)) ? { rejectZ: Number(record?.rejectZ) } : {}),
    ...(typeof record?.rejectBlock === 'string' && record.rejectBlock !== '' ? { rejectBlock: record.rejectBlock } : {}),
    ...(typeof record?.rejectShape === 'string' && record.rejectShape !== '' ? { rejectShape: record.rejectShape } : {}),
    ...(Number.isFinite(Number(record?.rejectCollisions)) ? { rejectCollisions: Number(record?.rejectCollisions) } : {}),
    ...(Number.isFinite(Number(record?.rejectFloor)) ? { rejectFloor: Number(record?.rejectFloor) } : {}),
    ...(Number.isFinite(Number(record?.rejectSpeed)) ? { rejectSpeed: Number(record?.rejectSpeed) } : {}),
    ...(Number.isFinite(Number(record?.rejectTerminal)) ? { rejectTerminal: Number(record?.rejectTerminal) } : {}),
    ...(typeof record?.pendingSessionId === 'string' && record.pendingSessionId !== '' ? { pendingSessionId: record.pendingSessionId } : {}),
    ...(Number.isFinite(Number(record?.wallMs)) ? { wallMs: Number(record?.wallMs) } : {}),
    ...(Number.isFinite(Number(record?.nanoMs)) ? { nanoMs: Number(record?.nanoMs) } : {}),
    ...(typeof record?.controlPhase === 'string' ? { controlPhase: record.controlPhase } : {}),
    ...(typeof record?.routeOutcome === 'string' ? { routeOutcome: record.routeOutcome } : {}),
    ...(typeof record?.build === 'string' && record.build !== '' ? { build: record.build } : {}),
    ...(record?.recoveryFrameVerified === true ? { recoveryFrameVerified: true } : {}),
    ...(Number.isFinite(Number(record?.progress)) ? { progress: Number(record?.progress) } : {}),
    ...(Number.isFinite(Number(record?.predictedEndProgress)) ? { predictedEndProgress: Number(record?.predictedEndProgress) } : {}),
    ...(typeof record?.chosenPolicy === 'string' && record.chosenPolicy !== '' ? { chosenPolicy: record.chosenPolicy } : {}),
    ...(Number.isFinite(Number(record?.evaluated)) ? { evaluated: Number(record?.evaluated) } : {}),
    ...(Number.isFinite(Number(record?.feasible)) ? { feasible: Number(record?.feasible) } : {}),
    ...(record?.budgetExhausted === true ? { budgetExhausted: true } : {}),
    ...(typeof record?.searchCompleted === 'boolean' ? { searchCompleted: record.searchCompleted } : {}),
    ...(Number.isFinite(Number(record?.physicsSteps)) ? { physicsSteps: Number(record?.physicsSteps) } : {}),
    ...(Number.isFinite(Number(record?.blockQueries)) ? { blockQueries: Number(record?.blockQueries) } : {}),
    ...(Number.isFinite(Number(record?.cacheHits)) ? { cacheHits: Number(record?.cacheHits) } : {}),
    ...(Number.isFinite(Number(record?.simMs)) ? { simMs: Number(record?.simMs) } : {}),
    ...(typeof record?.cooldownActive === 'boolean' ? { cooldownActive: record.cooldownActive } : {}),
    ...(typeof record?.transitionReason === 'string' && record.transitionReason !== '' ? { transitionReason: record.transitionReason } : {}),
    ...(Number.isFinite(Number(record?.safeCandidates)) ? { safeCandidates: Number(record?.safeCandidates) } : {}),
    ...(Number.isFinite(Number(record?.safeVerified)) ? { safeVerified: Number(record?.safeVerified) } : {}),
    ...(record?.safeEmergency === true ? { safeEmergency: true } : {}),
    ...(Number.isFinite(Number(record?.safeContactTicks)) ? { safeContactTicks: Number(record?.safeContactTicks) } : {}),
  }
}

/** Maps one flight status read; an absent state is `none`, never applying. */
function flightStatusOf(record: Record<string, unknown> | undefined): FlightChannelStatus {
  const samples = Array.isArray(record?.trajectory) ? record.trajectory as Array<Record<string, unknown>> : []
  const entryReach = Number(record?.entryReach)
  const terminalReach = Number(record?.terminalReach)
  const trajectoryLost = Number(record?.trajectoryLost)
  return {
    // The client enum ships uppercase (ACCEPTED / RUNNING / TERMINATED); the
    // port contract is lowercase, so normalize at the boundary. ROOT CAUSE
    // (R3 live 2026-09-20): the raw passthrough never matched the runner's
    // `terminated` check, so no client end reason (channel_complete,
    // no_viable_trajectory, touchdown) ever reached the host.
    state: typeof record?.state === 'string' ? record.state.toLowerCase() : 'none',
    ...(typeof record?.endReason === 'string' ? { endReason: record.endReason } : {}),
    ...(typeof record?.endDetail === 'string' ? { endDetail: record.endDetail } : {}),
    ...(typeof record?.applyingStarted === 'boolean' ? { applyingStarted: record.applyingStarted } : {}),
    ...(record?.handoverCapable === true ? { handoverCapable: true } : {}),
    ...(typeof record?.pendingSessionId === 'string' ? { pendingSessionId: record.pendingSessionId } : {}),
    ...(Number.isFinite(Number(record?.handoverCount)) ? { handoverCount: Number(record?.handoverCount) } : {}),
    ...(record?.holding === true ? { holding: true } : {}),
    ...(typeof record?.build === 'string' && record.build !== '' ? { build: record.build } : {}),
    ...(record?.recoveryFrameVerified === true ? { recoveryFrameVerified: true } : {}),
    ...(typeof record?.sessionId === 'string' ? { sessionId: record.sessionId } : {}),
    ...(typeof record?.phase === 'string' ? { phase: record.phase } : {}),
    ...(typeof record?.routeOutcome === 'string' ? { routeOutcome: record.routeOutcome } : {}),
    ...(typeof record?.build === 'string' && record.build !== '' ? { build: record.build } : {}),
    ...(record?.recoveryFrameVerified === true ? { recoveryFrameVerified: true } : {}),
    ...(typeof record?.recoveryReason === 'string' && record.recoveryReason !== '' ? { recoveryReason: record.recoveryReason } : {}),
    ...(record?.recovering === true ? { recovering: true } : {}),
    ...(Number.isFinite(entryReach) ? { entryReach } : {}),
    ...(Number.isFinite(terminalReach) ? { terminalReach } : {}),
    trajectory: samples.map(flightSampleOf),
    ...(Number.isFinite(trajectoryLost) ? { trajectoryLost } : {}),
  }
}

function flightSubmitReceiptOf(record: Record<string, unknown> | undefined): FlightChannelSubmitReceipt {
  const expectedGeneration = Number(record?.expectedGeneration)
  const pathPoints = Number(record?.pathPoints)
  const entryReach = Number(record?.entryReach)
  const terminalReach = Number(record?.terminalReach)
  return {
    accepted: record?.accepted === true,
    ...(typeof record?.reason === 'string' ? { reason: record.reason } : {}),
    ...(Number.isFinite(expectedGeneration) ? { expectedGeneration } : {}),
    ...(typeof record?.activeSessionId === 'string' ? { activeSessionId: record.activeSessionId } : {}),
    ...(typeof record?.startedApplying === 'boolean' ? { startedApplying: record.startedApplying } : {}),
    ...(Number.isFinite(pathPoints) ? { pathPoints } : {}),
    ...(Number.isFinite(entryReach) ? { entryReach } : {}),
    ...(Number.isFinite(terminalReach) ? { terminalReach } : {}),
  }
}

function flightRevokeReceiptOf(record: Record<string, unknown> | undefined): FlightChannelRevokeReceipt {
  return {
    revoked: record?.revoked === true,
    ...(typeof record?.wasActive === 'boolean' ? { wasActive: record.wasActive } : {}),
    ...(typeof record?.endReason === 'string' ? { endReason: record.endReason } : {}),
    ...(typeof record?.reason === 'string' ? { reason: record.reason } : {}),
  }
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
        ...(Number.isFinite(Number(record.pitch)) ? { pitch: Number(record.pitch) } : {}),
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
      const push = (key: 'hotbar' | 'main' | 'offhand', item: Record<string, unknown>, slot: number) => {
        if (typeof item.id !== 'string' || item.id.length === 0)
          return
        const damage = Number(item.damage)
        const maxDamage = Number(item.maxDamage)
        slots.push({
          slot,
          id: item.id,
          count: Number(item.count) || 0,
          hotbar: key === 'hotbar',
          ...(Number.isFinite(damage) ? { damage } : {}),
          ...(Number.isFinite(maxDamage) ? { maxDamage } : {}),
        })
      }
      for (const key of ['hotbar', 'main'] as const) {
        const list = Array.isArray(record?.[key]) ? record[key] as Array<Record<string, unknown>> : []
        for (const item of list)
          push(key, item, Number(item.slot) || 0)
      }
      // The offhand is a real slot the movers use: the elytra launch macro puts
      // one rocket there, and the vanilla gliding boost only accepts that hand.
      // Leaving it out of this read made a bot that carried 52 rockets report
      // `no firework rockets in the inventory` (live, 2026-09-18).
      const offhand = record?.offhand
      if (offhand && typeof offhand === 'object' && !Array.isArray(offhand))
        push('offhand', offhand as Record<string, unknown>, OFFHAND_SLOT)
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
      // The bridge revokes the input session on stop, so continuing after a
      // release needs a fresh session id (CD-0 §3.1). A stop at the end of a
      // command rotates harmlessly.
      control?.rotate()
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
    // Step 3: the per-tick jump surface is attached only when the bridge
    // exposes the jump tools. Without them the run keeps the host-side latch,
    // which cannot time a takeoff or correct a landing.
    ...(hasTool('jump_plan') && hasTool('jump_plan_status') && hasTool('jump_plan_cancel')
      ? {
          startJump: async (task: JumpTask): Promise<JumpTaskStatus> => jumpStatusOf(
            await callTool('jump_plan', {
              edgesJson: JSON.stringify(task.edges.map(edge => ({
                edgeId: edge.edgeId,
                fromX: edge.from.x,
                fromY: edge.from.y,
                fromZ: edge.from.z,
                targetX: edge.target.x,
                targetY: edge.target.y,
                targetZ: edge.target.z,
                takeoffX: edge.takeoff.x,
                takeoffZ: edge.takeoff.z,
                dirX: edge.direction.x,
                dirZ: edge.direction.z,
                sprint: edge.sprint,
                brake: edge.brake,
              }))),
              landingIntent: task.landingIntent,
              deadlineMs: task.deadlineMs,
            }),
          ),
          jumpStatus: async (): Promise<JumpTaskStatus> => jumpStatusOf(await callTool('jump_plan_status', {})),
          cancelJump: async (): Promise<JumpTaskStatus> => jumpStatusOf(await callTool('jump_plan_cancel', {})),
        }
      : {}),
    // OV-5: the launch macro is attached only when the bridge exposes all three
    // of its tools. A bridge with the start tool alone could launch but never
    // report or abort it, and a run that cannot observe its own takeoff would
    // have to guess whether the glider opened.
    ...(hasTool('elytra_launch') && hasTool('elytra_launch_status') && hasTool('elytra_launch_cancel')
      ? {
          startLaunch: async (task: ElytraLaunchTask): Promise<ElytraLaunchStatus> => launchStatusOf(
            await callTool('elytra_launch', {
              ...(task.goal ? { goalX: task.goal.x, goalY: task.goal.y, goalZ: task.goal.z } : {}),
              deadlineMs: task.deadlineMs,
              withFireworks: task.withFireworks,
            }),
          ),
          launchStatus: async (): Promise<ElytraLaunchStatus> => launchStatusOf(await callTool('elytra_launch_status', {})),
          cancelLaunch: async (): Promise<ElytraLaunchStatus> => launchStatusOf(await callTool('elytra_launch_cancel', {})),
        }
      : {}),
    // R3: the client flight channel is attached only when all three of its
    // tools exist. A bridge with submit alone could start a channel it could
    // never observe or abort, and the mover would have to guess the outcome.
    ...(hasTool('flight_submit') && hasTool('flight_status') && hasTool('flight_revoke')
      ? {
          flightSubmit: async (request: FlightChannelSubmitRequest): Promise<FlightChannelSubmitReceipt> => flightSubmitReceiptOf(await callTool('flight_submit', {
            sessionId: request.sessionId,
            ...(request.generation !== undefined ? { generation: request.generation } : {}),
            ...(request.revision !== undefined ? { revision: request.revision } : {}),
            ...(request.deadlineMs !== undefined ? { deadlineMs: request.deadlineMs } : {}),
            ...(request.dimension ? { dimension: request.dimension } : {}),
            ...(request.controlSessionId ? { controlSessionId: request.controlSessionId } : {}),
            channel: {
              path: request.channel.path.map(point => ({ x: point.x, y: point.y, z: point.z })),
              ...(request.channel.entryReach !== undefined ? { entryReach: request.channel.entryReach } : {}),
              ...(request.channel.kind !== undefined ? { kind: request.channel.kind } : {}),
              ...(request.channel.terminalReach !== undefined ? { terminalReach: request.channel.terminalReach } : {}),
              ...(request.channel.terminalPlanning !== undefined ? { terminalPlanning: request.channel.terminalPlanning } : {}),
            },
          })),
          flightStatus: async (sinceTick?: number): Promise<FlightChannelStatus> =>
            flightStatusOf(await callTool('flight_status', sinceTick !== undefined ? { sinceTick } : {})),
          flightRevoke: async (sessionId: string): Promise<FlightChannelRevokeReceipt> =>
            flightRevokeReceiptOf(await callTool('flight_revoke', { sessionId })),
          ...(hasTool('flight_landing_site')
            ? {
                flightLandingSite: async (request: FlightLandingSiteRequest): Promise<FlightLandingSiteReceipt> => {
                  const record = await callTool('flight_landing_site', {
                    sessionId: request.sessionId,
                    ...(request.controlSessionId ? { controlSessionId: request.controlSessionId } : {}),
                    x: request.x,
                    y: request.y,
                    z: request.z,
                    contactY: request.contactY,
                    ...(request.dimension ? { dimension: request.dimension } : {}),
                  })
                  return {
                    accepted: record?.accepted === true,
                    ...(typeof record?.reason === 'string' ? { reason: record.reason } : {}),
                    ...(typeof record?.phase === 'string' ? { phase: record.phase } : {}),
                    ...(Number.isFinite(Number(record?.siteX)) ? { siteX: Number(record?.siteX) } : {}),
                    ...(Number.isFinite(Number(record?.siteY)) ? { siteY: Number(record?.siteY) } : {}),
                    ...(Number.isFinite(Number(record?.siteZ)) ? { siteZ: Number(record?.siteZ) } : {}),
                    ...(Number.isFinite(Number(record?.contactY)) ? { contactY: Number(record?.contactY) } : {}),
                  }
                },
              }
            : {}),
        }
      : {}),
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
