/**
 * Vehicle acquisition (CD-V1 boat/horse/minecart; CD-V2 placement; CD-V3 recovery).
 *
 * Acquisition is the `Prepare -> Acquire -> VerifyControl` part of the travel
 * lifecycle. It never claims a nearby object implicitly: it selects an explicit
 * UUID or a clearly identified free object of the concrete type, verifies the
 * type/distance/occupation/ownership/permission, and confirms the controller
 * through a fresh observation when the bridge exposes one.
 *
 * A failed placement queries the just-spawned UUID before any further placement,
 * so a boat or cart is never duplicated (design §4, §6).
 */
import type { InventorySlot, MovementControlPort } from './port'
import type { TriState } from './target-observation'
import type { Vec3 } from './types'
import type { VehicleControlPort, VehicleMoveOptions } from './vehicle-port'
import type {
  VehicleAcquireStrategy,
  VehicleAssetReceipt,
  VehicleEntityKind,
  VehicleFailureReason,
  VehicleObservation,
} from './vehicle-types'

import { isHorseFamily, selectVehicleCandidate, vehicleKindOf } from './vehicle-observation'

/** Radius the acquire query searches around the player. */
export const VEHICLE_QUERY_RADIUS = 8
/** Hotbar slot a main-inventory vehicle item is swapped into when none is free. */
const VEHICLE_HOTBAR_FALLBACK_SLOT = 4
/** Default time budget for one acquisition attempt, in ms. */
const DEFAULT_ACQUIRE_BUDGET_MS = 15_000
/** Horse mounting/taming attempt interval, in ms. */
const HORSE_ATTEMPT_INTERVAL_MS = 700
/**
 * Board confirmation retry window.
 *
 * A live probe (2026-09-17) showed `board_vehicle` returning boarded=true while
 * `get_vehicle` still reported not riding for about 150 ms: the mount registers
 * on the next client tick. One immediate read called a fine mount
 * uncontrollable, so the confirm retries inside this bounded attempt count.
 */
const CONTROL_CONFIRM_ATTEMPTS = 8
const CONTROL_CONFIRM_POLL_MS = 100
/** Downward pitch for the boat placement use when no water read is available. */
const BOAT_PLACEMENT_PITCH_DEG = 40
/** Settle after the placement look, so the client crosshair hit refreshes. */
const BOAT_PLACEMENT_SETTLE_MS = 200
/** Radius the boat placement searches for a read water surface. */
const BOAT_PLACEMENT_RADIUS = 4
/** A water cell closer than this would spawn the hull inside the player. */
const BOAT_PLACEMENT_MIN_DISTANCE = 1.5
/** Eye height used only to aim at the water; a small offset still hits. */
const BOAT_PLACEMENT_EYE_HEIGHT = 1.6
/**
 * Board retry window.
 *
 * A client receives entities a moment after the player arrives or after an item
 * spawns one, so a single interaction can miss a vehicle that is already there
 * (live deck run, 2026-09-17: the existing boat at 238.5,200.5,-61 was
 * invisible to the client right after the teleport and the single board call
 * returned boarded=false). The retry stays inside the acquire budget.
 */
const BOARD_ATTEMPTS = 6
const BOARD_RETRY_INTERVAL_MS = 500

export interface VehicleAcquireContext {
  kind: VehicleEntityKind
  port: VehicleControlPort
  goal: Vec3
  options: VehicleMoveOptions
  shouldStop: () => boolean
  sleep: (ms: number) => Promise<void>
  now: () => number
  debug?: (message: string) => void
}

/**
 * Result of one acquisition.
 *
 * `controlVerified` is `'unobserved'` when the bridge cannot read the vehicle
 * state; the caller then proceeds without claiming verification (CD-0 §3.3).
 */
export interface VehicleAcquireOutcome {
  ok: boolean
  method: VehicleAcquireStrategy
  uuid?: string
  observation?: VehicleObservation
  asset?: VehicleAssetReceipt
  failure?: VehicleFailureReason
  detail?: string
  controlVerified: TriState
}

/** Finds the concrete vehicle spawn item id the kind needs. */
export function findVehicleItem(slots: InventorySlot[], kind: VehicleEntityKind): InventorySlot | undefined {
  const predicate = (id: string): boolean => {
    if (kind === 'boat')
      return id.includes('boat') || id.endsWith('_raft')
    if (kind === 'minecart')
      return id.includes('minecart')
    return false
  }
  return slots.find(slot => slot.count > 0 && predicate(slot.id))
}

/** Counts the items matching a vehicle item id across the inventory. */
export function countItem(slots: InventorySlot[], itemId: string): number {
  return slots.filter(slot => slot.id === itemId).reduce((total, slot) => total + slot.count, 0)
}

/** Moves a vehicle item into the hotbar and selects it; returns the slot or undefined. */
async function selectVehicleItem(port: MovementControlPort, slot: InventorySlot, debug?: (message: string) => void): Promise<number | undefined> {
  if (slot.hotbar) {
    await port.selectHotbar(slot.slot)
    return slot.slot
  }
  const slots = await port.getInventory()
  const empty = [0, 1, 2, 3, 4, 5, 6, 7, 8].find(index => !slots.some(entry => entry.hotbar && entry.slot === index))
  const target = empty ?? VEHICLE_HOTBAR_FALLBACK_SLOT
  await port.swapSlots(slot.slot, target)
  debug?.(`swapped ${slot.id} into hotbar slot ${target}`)
  await port.selectHotbar(target)
  return target
}

/**
 * Picks the aim for the boat placement: the nearest water surface with room.
 *
 * The placement is an item use whose success depends on the crosshair hit; the
 * hull needs a clear 1.375-wide footprint, so aiming at the ground under the
 * player's feet made the server reject the placement with FAIL and keep the
 * item (live F-14). The read covers a small box around the player; water cells
 * with an open surface and open neighbours become candidates, and the nearest
 * one wins. Undefined means no water was read, and the caller keeps its
 * fallback aim.
 */
async function pickBoatPlacement(ctx: VehicleAcquireContext, position: Vec3): Promise<{ yaw: number, pitch: number } | undefined> {
  const from = {
    x: Math.floor(position.x) - BOAT_PLACEMENT_RADIUS,
    y: Math.floor(position.y) - 1,
    z: Math.floor(position.z) - BOAT_PLACEMENT_RADIUS,
  }
  const to = {
    x: Math.floor(position.x) + BOAT_PLACEMENT_RADIUS,
    y: Math.floor(position.y) + 2,
    z: Math.floor(position.z) + BOAT_PLACEMENT_RADIUS,
  }
  let entries
  try {
    entries = await ctx.port.getBlocksRegion(from, to)
  }
  catch {
    return undefined
  }
  const cells = new Map<string, string>()
  for (const entry of entries)
    cells.set(`${entry.x},${entry.y},${entry.z}`, entry.id)
  const isWater = (id: string | undefined) => id !== undefined && id.endsWith('water')
  // The hull spans about two cells; a full block next to the water surface
  // stops the spawn, so the cell above and the four neighbours must be open.
  const openAround = (x: number, y: number, z: number) => {
    for (const [dx, dy, dz] of [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]] as const) {
      const id = cells.get(`${x + dx},${y + dy},${z + dz}`)
      if (id === undefined || isWater(id) || id.endsWith('air'))
        continue
      return false
    }
    return true
  }
  let best: { yaw: number, pitch: number, distance: number } | undefined
  for (const entry of entries) {
    if (!isWater(entry.id))
      continue
    if (!openAround(entry.x, entry.y, entry.z))
      continue
    const dx = entry.x + 0.5 - position.x
    const dz = entry.z + 0.5 - position.z
    const distance = Math.hypot(dx, dz)
    if (distance < BOAT_PLACEMENT_MIN_DISTANCE || distance > BOAT_PLACEMENT_RADIUS)
      continue
    if (best && distance >= best.distance)
      continue
    const eyeY = position.y + BOAT_PLACEMENT_EYE_HEIGHT
    const yaw = Math.atan2(-dx, dz) * 180 / Math.PI
    const pitch = Math.atan2(eyeY - (entry.y + 0.9), distance) * 180 / Math.PI
    best = { yaw, pitch, distance }
  }
  return best
}

/** Reads one vehicle observation, or undefined when the bridge cannot read it. */
async function observe(ctx: VehicleAcquireContext, uuid: string): Promise<VehicleObservation | undefined> {
  if (!ctx.port.observeVehicle)
    return undefined
  const state = await ctx.port.getState()
  return await ctx.port.observeVehicle({
    uuid,
    dimension: state.observation?.dimension ?? '',
    worldId: state.observation?.worldId ?? '',
    connectionGeneration: state.observation?.connectionGeneration ?? 0,
    startedAt: ctx.now(),
  })
}

/** Queries nearby candidates, or an empty list when the bridge cannot read them. */
async function query(ctx: VehicleAcquireContext, kind: VehicleEntityKind): Promise<VehicleObservation[]> {
  if (!ctx.port.queryVehicles)
    return []
  const state = await ctx.port.getState()
  return await ctx.port.queryVehicles({
    dimension: state.observation?.dimension ?? '',
    worldId: state.observation?.worldId ?? '',
    connectionGeneration: state.observation?.connectionGeneration ?? 0,
    kind,
    origin: state.position,
    radius: VEHICLE_QUERY_RADIUS,
    startedAt: ctx.now(),
  })
}

/** Boards with bounded retries; the client sees spawned entities a moment late. */
async function boardWithRetry(ctx: VehicleAcquireContext, uuid: string | undefined, typeId: string): Promise<boolean> {
  for (let attempt = 0; attempt < BOARD_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      if (ctx.shouldStop())
        return false
      await ctx.sleep(BOARD_RETRY_INTERVAL_MS)
    }
    if (await board(ctx, uuid, typeId))
      return true
  }
  return false
}

/** Boards one exact uuid when the port supports it, else the typed nearest query. */
async function board(ctx: VehicleAcquireContext, uuid: string | undefined, typeId: string): Promise<boolean> {
  if (uuid && ctx.port.boardVehicle) {
    const result = await ctx.port.boardVehicle(uuid)
    return result.boarded
  }
  const result = await ctx.port.boardNearestVehicle(6, typeId)
  return result.boarded
}

/** Confirms the ridden vehicle via `getRiding`, retrying briefly. */
async function confirmControl(ctx: VehicleAcquireContext, expectedUuid: string | undefined, kind: VehicleEntityKind): Promise<{ ok: boolean, observation?: VehicleObservation, failure?: VehicleFailureReason }> {
  let riding = await ctx.port.getRiding()
  for (let attempt = 1; attempt < CONTROL_CONFIRM_ATTEMPTS; attempt++) {
    if (riding && vehicleKindOf(riding.kind) === kind)
      break
    if (ctx.shouldStop())
      break
    await ctx.sleep(CONTROL_CONFIRM_POLL_MS)
    riding = await ctx.port.getRiding()
  }
  if (!riding || vehicleKindOf(riding.kind) !== kind)
    return { ok: false, failure: 'not_controllable' }
  // When the board call named a uuid, a different ridden uuid is a wrong mount.
  if (expectedUuid && riding.uuid && riding.uuid !== expectedUuid)
    return { ok: false, failure: 'not_controllable' }
  if (!riding.uuid || !ctx.port.observeVehicle)
    return { ok: true }
  const observation = await observe(ctx, riding.uuid)
  return { ok: true, ...(observation ? { observation } : {}) }
}

/**
 * Verifies that a freshly acquired horse is controllable.
 *
 * Being ridden is not proof: a wild horse can be sat on and then throw the
 * rider, and an untamed horse cannot be steered (design §1, §5). Only an
 * explicit `controlledByPassenger === false` or `tamed === false` fails; an
 * unobservable state is left unverified.
 */
function verifyHorseControl(observation: VehicleObservation | undefined): { failure?: VehicleFailureReason, verified: TriState } {
  if (!observation || !isHorseFamily(observation.kind))
    return { verified: 'unobserved' }
  const state = observation.state
  if (state.kind !== 'horse' && state.kind !== 'donkey' && state.kind !== 'mule')
    return { verified: 'unobserved' }
  if (state.tamed === false)
    return { failure: 'not_tamed', verified: false }
  if (state.controlledByPassenger === false)
    return { failure: 'not_controllable', verified: false }
  // `controlledByPassenger === false` already returned above.
  if (state.tamed === true && state.saddled === true)
    return { verified: true }
  return { verified: 'unobserved' }
}

/** Reads the tamed fact for a horse-family observation, else `'unobserved'`. */
function tamedState(observation: VehicleObservation | undefined): TriState {
  const state = observation?.state
  if (state && (state.kind === 'horse' || state.kind === 'donkey' || state.kind === 'mule'))
    return state.tamed
  return 'unobserved'
}

/** Verifies the player's ownership/permission before acquiring a candidate. */
function verifyPermission(observation: VehicleObservation, options: VehicleMoveOptions): VehicleFailureReason | undefined {
  if (observation.owned === false && options.strategy === 'existing')
    return 'not_owned'
  return undefined
}

// --- Boat acquisition (design §4) ---------------------------------------------------------

async function acquireBoat(ctx: VehicleAcquireContext): Promise<VehicleAcquireOutcome> {
  const { port, options, debug } = ctx
  const riding = await port.getRiding()
  if (riding && vehicleKindOf(riding.kind) === 'boat') {
    const observation = riding.uuid ? await observe(ctx, riding.uuid) : undefined
    return { ok: true, method: 'existing', ...(riding.uuid ? { uuid: riding.uuid } : {}), ...(observation ? { observation } : {}), controlVerified: observation ? true : 'unobserved' }
  }

  // `existing`: an explicit uuid or a free boat already in the world. A bridge
  // without the candidate query cannot prove an existing boat, so it degrades
  // to the placement flow instead of pretending a nearby object is available.
  const canQuery = !!port.queryVehicles
  const candidates = canQuery ? await query(ctx, 'boat') : []
  if (canQuery) {
    if (options.vehicleUuid || candidates.length > 0) {
      const selection = selectVehicleCandidate(candidates, {
        kind: 'boat',
        requireFree: true,
        explicitUuid: options.vehicleUuid,
        origin: (await port.getState()).position,
        maxDistance: VEHICLE_QUERY_RADIUS,
      })
      if (selection.observation) {
        const permission = verifyPermission(selection.observation, options)
        if (permission)
          return { ok: false, method: 'existing', failure: permission, controlVerified: 'unobserved' }
        const boarded = await boardWithRetry(ctx, selection.observation.uuid, selection.observation.type)
        if (boarded) {
          const confirmed = await confirmControl(ctx, selection.observation.uuid, 'boat')
          return {
            ok: confirmed.ok,
            method: 'existing',
            uuid: selection.observation.uuid,
            observation: confirmed.observation,
            controlVerified: confirmed.observation ? true : 'unobserved',
            ...(confirmed.failure ? { failure: confirmed.failure } : {}),
          }
        }
        return { ok: false, method: 'existing', failure: 'not_controllable', uuid: selection.observation.uuid, controlVerified: false }
      }
      // An explicit uuid that did not resolve, or a candidate list with only
      // rejected entries, is a specific failure when the caller asked for an
      // existing vehicle. For `prepare_owned`, placement below is still valid.
      if (options.vehicleUuid || options.strategy === 'existing')
        return { ok: false, method: 'existing', failure: selection.reason ?? 'vehicle_not_found', controlVerified: 'unobserved' }
    }
    else if (options.strategy === 'existing') {
      return { ok: false, method: 'existing', failure: 'vehicle_not_found', controlVerified: 'unobserved' }
    }
  }

  // `prepare_owned`: identify the concrete boat item and place exactly one.
  const slots = await port.getInventory()
  const item = findVehicleItem(slots, 'boat')
  if (!item)
    return { ok: false, method: 'prepare_owned', failure: 'no_materials', detail: 'no boat item in the inventory', controlVerified: 'unobserved' }
  const before = countItem(slots, item.id)
  const slot = await selectVehicleItem(port, item, debug)
  if (slot === undefined)
    return { ok: false, method: 'prepare_owned', failure: 'no_materials', detail: 'no hotbar slot for the boat', controlVerified: 'unobserved' }

  const seenBefore = new Set(candidates.map(candidate => candidate.uuid))
  const state = await port.getState()
  // Placing a boat is a normal item use, so the crosshair must hit a spot where
  // the hull (1.375 wide) has clear space. A level look at the far goal hit
  // nothing, and a downward look at the shore hit the ground beside the player,
  // where the hull overlapped a block and the server rejected the placement
  // with FAIL while keeping the item (live F-14). The placement therefore aims
  // at the nearest read water surface inside the interaction reach.
  const yawToGoal = Math.atan2(-(ctx.goal.x - state.position.x), ctx.goal.z - state.position.z) * 180 / Math.PI
  const placement = await pickBoatPlacement(ctx, state.position)
  if (placement) {
    await port.look(placement.yaw, placement.pitch)
    debug?.(`boat placement aim yaw=${placement.yaw.toFixed(1)} pitch=${placement.pitch.toFixed(1)}`)
  }
  else {
    await port.look(yawToGoal, BOAT_PLACEMENT_PITCH_DEG)
  }
  // The use path reads the client's crosshair hit, which is computed from the
  // previous frame's rotation. Without a settle the use still sees the old aim
  // and places nothing (live F-14 follow-up).
  await ctx.sleep(BOAT_PLACEMENT_SETTLE_MS)

  // Prefer the port's placement primitive; it can report the spawned uuid and
  // the measured inventory delta directly.
  let spawnedUuid: string | undefined
  let delta: number | undefined
  if (port.placeVehicleItem) {
    const placed = await port.placeVehicleItem({ itemId: item.id })
    if (!placed.placed)
      return { ok: false, method: 'prepare_owned', failure: 'placement_failed', detail: 'boat placement reported no spawn', controlVerified: 'unobserved' }
    spawnedUuid = placed.spawnedUuid
    delta = placed.inventoryDelta
  }
  else {
    await port.useItem()
  }
  await ctx.sleep(600)

  // Verify the inventory delta; a zero delta means no boat left the inventory.
  const afterSlots = await port.getInventory()
  const after = countItem(afterSlots, item.id)
  const consumed = Math.max(0, before - after)
  if (delta === undefined)
    delta = consumed
  const asset: VehicleAssetReceipt = { itemId: item.id, consumed: Math.max(0, delta), recovered: 0, location: 'vehicle' }

  // Find the just-spawned boat: query the new uuid before any further action,
  // so a second boat is never placed (design §4).
  const afterCandidates = await query(ctx, 'boat')
  const spawned = afterCandidates.find(candidate => !seenBefore.has(candidate.uuid))
  if (spawned)
    spawnedUuid = spawned.uuid

  const targetUuid = spawnedUuid ?? spawned?.uuid
  // Placing a boat often mounts the player directly; use that mount before
  // issuing a separate board call.
  const afterRiding = await port.getRiding()
  if (afterRiding && vehicleKindOf(afterRiding.kind) === 'boat') {
    const confirmed = await confirmControl(ctx, afterRiding.uuid ?? targetUuid, 'boat')
    return {
      ok: confirmed.ok,
      method: 'prepare_owned',
      ...(afterRiding.uuid ?? targetUuid ? { uuid: afterRiding.uuid ?? targetUuid } : {}),
      observation: confirmed.observation,
      asset,
      controlVerified: confirmed.observation ? true : 'unobserved',
      ...(confirmed.failure ? { failure: confirmed.failure } : {}),
    }
  }
  const boarded = await boardWithRetry(ctx, targetUuid, item.id)
  if (!boarded) {
    // Name the spawned entity before any further placement: it may be occupied
    // or gone, but a second boat is never placed (design §4).
    const retry = targetUuid ? await observe(ctx, targetUuid) : undefined
    const failure: VehicleFailureReason = retry?.free === false ? 'occupied' : 'not_controllable'
    return { ok: false, method: 'prepare_owned', failure, detail: 'boat placed but not boarded', asset, controlVerified: 'unobserved' }
  }
  const confirmed = await confirmControl(ctx, targetUuid, 'boat')
  return {
    ok: confirmed.ok,
    method: 'prepare_owned',
    ...(targetUuid ? { uuid: targetUuid } : {}),
    observation: confirmed.observation,
    asset,
    controlVerified: confirmed.observation ? true : 'unobserved',
    ...(confirmed.failure ? { failure: confirmed.failure } : {}),
  }
}

// --- Horse acquisition (design §5) --------------------------------------------------------

async function acquireHorse(ctx: VehicleAcquireContext): Promise<VehicleAcquireOutcome> {
  const { port, options } = ctx
  const riding = await port.getRiding()
  if (riding && isHorseFamily(vehicleKindOf(riding.kind))) {
    const observation = riding.uuid ? await observe(ctx, riding.uuid) : undefined
    const control = verifyHorseControl(observation)
    return {
      ok: !control.failure,
      method: 'existing',
      ...(riding.uuid ? { uuid: riding.uuid } : {}),
      ...(observation ? { observation } : {}),
      controlVerified: control.verified,
      ...(control.failure ? { failure: control.failure } : {}),
    }
  }

  // A bridge without the candidate query cannot verify taming or saddling, so
  // the legacy board loop mounts the concrete horse family type and control is
  // recorded as unverified instead of claimed.
  if (!port.queryVehicles) {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (ctx.shouldStop())
        return { ok: false, method: 'existing', failure: 'cancelled', controlVerified: 'unobserved' }
      await board(ctx, options.vehicleUuid, 'minecraft:horse')
      await ctx.sleep(HORSE_ATTEMPT_INTERVAL_MS)
      const after = await port.getRiding()
      if (after && isHorseFamily(vehicleKindOf(after.kind)))
        return { ok: true, method: 'existing', ...(after.uuid ? { uuid: after.uuid } : {}), controlVerified: 'unobserved' }
    }
    return { ok: false, method: 'existing', failure: 'vehicle_not_found', detail: 'no horse could be mounted', controlVerified: 'unobserved' }
  }

  const candidates = await query(ctx, 'horse')
  const origin = (await port.getState()).position

  // Prefer an already tamed and saddled horse; an untamed one needs permission.
  const selection = selectVehicleCandidate(candidates, {
    kind: ['horse', 'donkey', 'mule'],
    requireFree: true,
    requireTamed: true,
    explicitUuid: options.vehicleUuid,
    origin,
    maxDistance: VEHICLE_QUERY_RADIUS,
  })
  if (selection.observation) {
    const permission = verifyPermission(selection.observation, options)
    if (permission)
      return { ok: false, method: 'existing', failure: permission, controlVerified: 'unobserved' }
    const saddled = await ensureSaddled(ctx, selection.observation)
    const boarded = await boardWithRetry(ctx, selection.observation.uuid, selection.observation.type)
    if (!boarded)
      return { ok: false, method: 'existing', failure: 'not_controllable', uuid: selection.observation.uuid, controlVerified: false }
    const confirmed = await confirmControl(ctx, selection.observation.uuid, vehicleKindOf(selection.observation.type))
    const control = verifyHorseControl(confirmed.observation)
    const failure = control.failure ?? saddled.failure
    return {
      ok: !failure,
      method: 'existing',
      uuid: selection.observation.uuid,
      ...(confirmed.observation ? { observation: confirmed.observation } : {}),
      ...(saddled.asset ? { asset: saddled.asset } : {}),
      controlVerified: control.verified,
      ...(failure ? { failure } : {}),
    }
  }

  if (options.vehicleUuid)
    return { ok: false, method: 'existing', failure: selection.reason ?? 'vehicle_not_found', controlVerified: 'unobserved' }
  // Taming needs explicit permission: either `allowTame` or the `tame` strategy
  // (design §3). A plain `existing` request without permission never tames.
  if (options.strategy !== 'tame' && !options.allowTame)
    return { ok: false, method: 'existing', failure: selection.reason ?? 'vehicle_not_found', controlVerified: 'unobserved' }

  // Taming: explicit permission plus a time budget (design §3). The bucket of
  // attempts is bounded by time, not a fixed count, because random taming has
  // no promised attempt count.
  const budget = options.acquireBudgetMs ?? DEFAULT_ACQUIRE_BUDGET_MS
  const deadline = ctx.now() + budget
  const untamed = selectVehicleCandidate(candidates, {
    kind: ['horse', 'donkey', 'mule'],
    requireFree: true,
    origin,
    maxDistance: VEHICLE_QUERY_RADIUS,
  })
  if (!untamed.observation)
    return { ok: false, method: 'tame', failure: untamed.reason ?? 'vehicle_not_found', controlVerified: 'unobserved' }

  const target = untamed.observation
  let lastObservation: VehicleObservation | undefined = target
  while (ctx.now() < deadline) {
    if (ctx.shouldStop())
      return { ok: false, method: 'tame', uuid: target.uuid, failure: 'cancelled', controlVerified: 'unobserved' }
    if (port.interactVehicle)
      await port.interactVehicle({ uuid: target.uuid, action: 'tame' })
    else
      await port.useEntity(target.uuid)
    await ctx.sleep(HORSE_ATTEMPT_INTERVAL_MS)
    const observed = await observe(ctx, target.uuid)
    if (observed)
      lastObservation = observed
    // Taming is done when the observation reports `tamed: true`; saddling is a
    // separate step after the bond (design §5), so it must not gate this loop.
    if (tamedState(observed ?? lastObservation) === true)
      break
    // A wild horse throws the rider: re-mount and continue within the budget.
    await board(ctx, target.uuid, target.type)
    await ctx.sleep(HORSE_ATTEMPT_INTERVAL_MS)
  }
  const finalObservation = (await observe(ctx, target.uuid)) ?? lastObservation
  if (tamedState(finalObservation) !== true) {
    const control = verifyHorseControl(finalObservation)
    const failure: VehicleFailureReason = control.failure === 'not_controllable' ? 'not_controllable' : 'acquire_timeout'
    return {
      ok: false,
      method: 'tame',
      uuid: target.uuid,
      observation: finalObservation,
      failure,
      detail: failure === 'acquire_timeout' ? 'horse was not tamed within the budget' : undefined,
      controlVerified: control.verified,
    }
  }
  const control = verifyHorseControl(finalObservation)

  const saddled = await ensureSaddled(ctx, finalObservation!)
  if (saddled.failure)
    return { ok: false, method: 'tame', uuid: target.uuid, observation: finalObservation, failure: saddled.failure, controlVerified: control.verified }
  await board(ctx, target.uuid, target.type)
  const confirmed = await confirmControl(ctx, target.uuid, vehicleKindOf(target.type))
  const mounted = verifyHorseControl(confirmed.observation)
  return {
    ok: !mounted.failure,
    method: 'tame',
    uuid: target.uuid,
    observation: confirmed.observation,
    ...(saddled.asset ? { asset: saddled.asset } : {}),
    controlVerified: mounted.verified,
    ...(mounted.failure ? { failure: mounted.failure } : {}),
  }
}

/**
 * Ensures a tamed horse is saddled using the version-native interaction.
 *
 * The saddle slot is verified through the vehicle observation and the inventory
 * delta, never a hard-coded chest slot number (design §5).
 */
async function ensureSaddled(ctx: VehicleAcquireContext, observation: VehicleObservation): Promise<{ failure?: VehicleFailureReason, asset?: VehicleAssetReceipt }> {
  const state = observation.state
  if (state.kind !== 'horse' && state.kind !== 'donkey' && state.kind !== 'mule')
    return {}
  if (state.saddled === true)
    return {}
  const slots = await ctx.port.getInventory()
  const saddle = slots.find(slot => slot.id === 'minecraft:saddle' && slot.count > 0)
  if (!saddle)
    return { failure: 'saddle_missing' }
  const before = countItem(slots, 'minecraft:saddle')
  if (ctx.port.interactVehicle)
    await ctx.port.interactVehicle({ uuid: observation.uuid, action: 'saddle' })
  else
    await ctx.port.useEntity(observation.uuid)
  await ctx.sleep(400)
  const after = countItem(await ctx.port.getInventory(), 'minecraft:saddle')
  const consumed = Math.max(0, before - after)
  const updated = await observe(ctx, observation.uuid)
  const added = updated?.state.kind === 'horse' || updated?.state.kind === 'donkey' || updated?.state.kind === 'mule'
    ? updated.state.saddled
    : 'unobserved'
  const asset: VehicleAssetReceipt = { itemId: 'minecraft:saddle', consumed, recovered: 0, location: 'vehicle' }
  if (added === true || consumed > 0)
    return { asset }
  return { failure: 'saddle_missing' }
}

// --- Minecart acquisition (design §6) -----------------------------------------------------

async function acquireMinecart(ctx: VehicleAcquireContext): Promise<VehicleAcquireOutcome> {
  const { port, options, debug } = ctx
  const riding = await port.getRiding()
  if (riding && vehicleKindOf(riding.kind) === 'minecart') {
    const observation = riding.uuid ? await observe(ctx, riding.uuid) : undefined
    return { ok: true, method: 'existing', ...(riding.uuid ? { uuid: riding.uuid } : {}), ...(observation ? { observation } : {}), controlVerified: observation ? true : 'unobserved' }
  }

  // A bridge without the candidate query cannot prove a free cart; the legacy
  // board loop is used, and a placement only happens for `prepare_owned`.
  if (!port.queryVehicles) {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (ctx.shouldStop())
        return { ok: false, method: 'existing', failure: 'cancelled', controlVerified: 'unobserved' }
      await board(ctx, options.vehicleUuid, 'minecraft:minecart')
      await ctx.sleep(600)
      const after = await port.getRiding()
      if (after && vehicleKindOf(after.kind) === 'minecart')
        return { ok: true, method: 'existing', ...(after.uuid ? { uuid: after.uuid } : {}), controlVerified: 'unobserved' }
    }
    if (options.strategy !== 'prepare_owned')
      return { ok: false, method: 'existing', failure: 'vehicle_not_found', detail: 'no minecart could be boarded', controlVerified: 'unobserved' }
  }

  const candidates = port.queryVehicles ? await query(ctx, 'minecart') : []
  const origin = (await port.getState()).position
  const selection = selectVehicleCandidate(candidates, {
    kind: 'minecart',
    requireFree: true,
    explicitUuid: options.vehicleUuid,
    origin,
    maxDistance: VEHICLE_QUERY_RADIUS,
  })
  if (selection.observation) {
    const boarded = await boardWithRetry(ctx, selection.observation.uuid, selection.observation.type)
    if (boarded) {
      const confirmed = await confirmControl(ctx, selection.observation.uuid, 'minecart')
      return {
        ok: confirmed.ok,
        method: 'existing',
        uuid: selection.observation.uuid,
        observation: confirmed.observation,
        controlVerified: confirmed.observation ? true : 'unobserved',
        ...(confirmed.failure ? { failure: confirmed.failure } : {}),
      }
    }
    return { ok: false, method: 'existing', failure: 'not_controllable', uuid: selection.observation.uuid, controlVerified: false }
  }
  if (options.vehicleUuid || options.strategy === 'existing')
    return { ok: false, method: 'existing', failure: selection.reason ?? 'vehicle_not_found', controlVerified: 'unobserved' }

  // `prepare_owned`: verify a cart item and free space, then spawn exactly one.
  const slots = await port.getInventory()
  const item = findVehicleItem(slots, 'minecart')
  if (!item)
    return { ok: false, method: 'prepare_owned', failure: 'no_materials', detail: 'no minecart item in the inventory', controlVerified: 'unobserved' }
  const before = countItem(slots, item.id)
  const slot = await selectVehicleItem(port, item, debug)
  if (slot === undefined)
    return { ok: false, method: 'prepare_owned', failure: 'no_materials', detail: 'no hotbar slot for the minecart', controlVerified: 'unobserved' }

  const seenBefore = new Set(candidates.map(candidate => candidate.uuid))
  let spawnedUuid: string | undefined
  let delta: number | undefined
  if (port.placeVehicleItem) {
    const placed = await port.placeVehicleItem({ itemId: item.id })
    if (!placed.placed)
      return { ok: false, method: 'prepare_owned', failure: 'placement_failed', detail: 'no rail or free space for the minecart', controlVerified: 'unobserved' }
    spawnedUuid = placed.spawnedUuid
    delta = placed.inventoryDelta
  }
  else {
    await port.useItem()
  }
  await ctx.sleep(600)
  const after = countItem(await port.getInventory(), item.id)
  if (delta === undefined)
    delta = Math.max(0, before - after)
  const asset: VehicleAssetReceipt = { itemId: item.id, consumed: Math.max(0, delta), recovered: 0, location: 'vehicle' }

  const afterCandidates = await query(ctx, 'minecart')
  const spawned = afterCandidates.find(candidate => !seenBefore.has(candidate.uuid))
  spawnedUuid = spawned?.uuid ?? spawnedUuid

  // Placing the cart may seat the player directly; use that mount first.
  const afterRiding = await port.getRiding()
  if (afterRiding && vehicleKindOf(afterRiding.kind) === 'minecart') {
    const confirmed = await confirmControl(ctx, afterRiding.uuid ?? spawnedUuid, 'minecart')
    return {
      ok: confirmed.ok,
      method: 'prepare_owned',
      ...(afterRiding.uuid ?? spawnedUuid ? { uuid: afterRiding.uuid ?? spawnedUuid } : {}),
      observation: confirmed.observation,
      asset,
      controlVerified: confirmed.observation ? true : 'unobserved',
      ...(confirmed.failure ? { failure: confirmed.failure } : {}),
    }
  }

  const boarded = await boardWithRetry(ctx, spawnedUuid, item.id)
  if (!boarded)
    return { ok: false, method: 'prepare_owned', failure: 'not_controllable', detail: 'minecart spawned but not boarded', asset, controlVerified: 'unobserved' }
  const confirmed = await confirmControl(ctx, spawnedUuid, 'minecart')
  return {
    ok: confirmed.ok,
    method: 'prepare_owned',
    ...(spawnedUuid ? { uuid: spawnedUuid } : {}),
    observation: confirmed.observation,
    asset,
    controlVerified: confirmed.observation ? true : 'unobserved',
    ...(confirmed.failure ? { failure: confirmed.failure } : {}),
  }
}

/**
 * Acquires the rideable for one travel.
 *
 * `existing` uses a world vehicle; `prepare_owned` places one from the
 * player's materials; `tame` bonds a wild horse and needs explicit permission.
 */
export async function acquireVehicle(ctx: VehicleAcquireContext): Promise<VehicleAcquireOutcome> {
  switch (ctx.kind) {
    case 'boat':
      return await acquireBoat(ctx)
    case 'horse':
    case 'donkey':
    case 'mule':
      return await acquireHorse(ctx)
    case 'minecart':
      return await acquireMinecart(ctx)
    default:
      return { ok: false, method: ctx.options.strategy ?? 'existing', failure: 'vehicle_not_found', detail: `unsupported vehicle kind ${ctx.kind}`, controlVerified: 'unobserved' }
  }
}
