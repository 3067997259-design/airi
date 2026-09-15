/**
 * Elytra mover (MC-3c D2/D3).
 *
 * The client keeps the flight physics; this loop owns the intent: it wears
 * the elytra, runs off the launch edge, deploys on the way down, holds a
 * cruise band with firework thrust, and lands near the goal. Low firework
 * supply, low durability, or low health turn the loop into a bounded early
 * landing instead of a hard failure.
 *
 * Cancellation never abandons the flight mid-air: stop turns into a landing,
 * and the final status tells the caller what actually happened.
 */
import type { MovementControlPort, MovementState } from './port'
import type { Vec3 } from './types'
import type { VehicleMoveOptions, VehicleMoveResult } from './vehicle'

import { clamp, defaultSleep, horizontalDistance, yawTo } from './geometry'

const FLIGHT_POLL_MS = 200
/** Preferred altitude above the goal while cruising (MC-3c D2). */
const CRUISE_BAND_ABOVE = 30
const MIN_CRUISE_SPEED = 0.45
const FIREWORK_INTERVAL_MS = 1_200
const FIREWORK_LOW_SUPPLY = 3
const APPROACH_DISTANCE = 80
/** Flare floor: below this height the nose eases up to bleed descent speed. */
const FLARE_HEIGHT = 6
/** Height band over which the dive angle eases into the flare. */
const FLARE_WINDOW = 14
/** Nose-up angle in the flare; stops the sink right before touch-down. */
const FLARE_PITCH = -6
/** A late landing assist fires when the sink exceeds this (blocks/tick). */
const LANDING_ASSIST_FALL_SPEED = -0.6
/** Nose-up angle for climbing over terrain ahead. */
const CLIMB_PITCH = -30
/** Terrain this close ahead forces a climb, never a level glide. */
const TERRAIN_GUARD_DISTANCE = 12
/** The final flare starts only this close to the goal. */
const FLARE_DISTANCE = 16
/** Terrain scan window along the heading, in blocks. */
const SCAN_FROM = 8
const SCAN_TO = 48
/** Blocks farther than this to either side of the heading do not block flight. */
const CORRIDOR_HALF_WIDTH = 1.5
const LOW_HEALTH = 8
const TAKEOFF_TIMEOUT_MS = 10_000
const DEPLOY_TIMEOUT_MS = 4_000
const CRUISE_TIMEOUT_MS = 180_000
/** The goal approach gets its own deadline so it cannot circle before touch-down. */
const APPROACH_TIMEOUT_MS = 40_000
const STUCK_WINDOW_POLLS = 15
const STUCK_MIN_MOVE = 0.5
/** Touch-down drift the mover may close on foot before declaring a miss. */
const LANDING_WALK_LIMIT = 24
const LANDING_WALK_TIMEOUT_MS = 15_000
/**
 * Chest armor index inside the player inventory. The bridge's `swapSlots`
 * takes inventory indices and maps them to menu slots internally
 * (`InventoryHandlers.toMenuSlot`: 36-39 armor, helmet..boots).
 */
const CHEST_ARMOR_SLOT = 37
/** Bound on the forward landing scan; the mover never aims farther ahead. */
const LANDING_SCAN_MAX = 24
/** Refresh the equipped elytra durability every 100 flight ticks (50 ms each). */
const DURABILITY_REFRESH_TICKS = 100
const MS_PER_TICK = 50
const DURABILITY_REFRESH_MS = DURABILITY_REFRESH_TICKS * MS_PER_TICK
/** An approach whose gap reopens by this much counts as an overshoot. */
const GO_AROUND_GAP_MARGIN = 6
/** Below this height over the goal, a glider cannot bank around for another pass. */
const GO_AROUND_MIN_HEIGHT = 8
/** At most one go-around; after that the mover lands nearby instead of looping. */
const MAX_GO_AROUNDS = 1
/** Worn this far, the suit still flies but only to the nearest landing. */
const WORN_ELYTRA_RATIO = 0.75
/** Worn this far without a backup, the mover refuses to take off at all. */
const BROKEN_ELYTRA_RATIO = 0.9

type LandingReason = 'goal' | 'cancelled' | 'low_supply' | 'safety' | 'timeout'

export async function runElytraMove(options: VehicleMoveOptions): Promise<VehicleMoveResult> {
  const sleep = options.deps?.sleep ?? defaultSleep
  const now = options.deps?.now ?? (() => Date.now())
  const tolerance = options.tolerance ?? 4
  const shouldStop = options.shouldStop ?? (() => false)
  const port = options.port
  const debug = options.debug
  const goal: Vec3 = { x: options.goal.x, y: options.goal.y, z: options.goal.z }

  // 1. Wear the elytra; a backup replaces a worn suit before takeoff.
  const equip = await equipElytra(port, debug)
  if (!equip.ok)
    return { status: 'unavailable', detail: equip.detail }

  // 2. Rockets: the mover needs one selected stack to thrust with.
  let fireworkSlot = await selectBySuffix(port, 'firework_rocket')
  if (fireworkSlot === undefined)
    return { status: 'unavailable', detail: 'no firework rockets in the inventory' }
  let fireworks = await countBySuffix(port, 'firework_rocket')

  // 3. Takeoff: run off the edge, then deploy the glider while falling.
  let state = await port.getState()
  await port.look(yawTo(state.position, goal), 0)
  let deployed = false
  await port.setInput({ forward: true, sprint: true })
  try {
    const takeoffDeadline = now() + TAKEOFF_TIMEOUT_MS
    while (state.onGround) {
      if (shouldStop()) {
        await port.stopMovement()
        return { status: 'cancelled' }
      }
      if (now() > takeoffDeadline) {
        await port.stopMovement()
        return { status: 'stuck', detail: 'no takeoff edge reached' }
      }
      await sleep(FLIGHT_POLL_MS)
      state = await port.getState()
    }

    deployed = state.fallFlying === true
    for (let attempt = 0; attempt < 3 && !deployed && !state.onGround; attempt++) {
      await port.jumpOnce()
      const deployDeadline = now() + DEPLOY_TIMEOUT_MS
      while (!deployed && now() < deployDeadline && !state.onGround) {
        await sleep(FLIGHT_POLL_MS)
        state = await port.getState()
        deployed = state.fallFlying === true
      }
    }
  }
  finally {
    // The takeoff inputs must be released on every path: a state read error
    // used to leave forward+sprint held (review R7).
    await port.stopMovement().catch(() => {})
  }
  if (!deployed) {
    return { status: 'unavailable', detail: 'elytra did not deploy' }
  }
  debug?.('elytra deployed')

  // 4. Cruise and land. A worn suit turns the flight into an early landing;
  // the mover never cruises on an elytra that may break mid-air.
  let landing = equip.lowDurability
  let reason: LandingReason = equip.lowDurability ? 'safety' : 'goal'
  let cruiseY = Math.max(goal.y + CRUISE_BAND_ABOVE, state.position.y)
  let lastFireworkAt = 0
  let lastDurabilityAt = now()
  let approachDeadline = 0
  let minApproachGap = Infinity
  let goArounds = 0
  const recent: Vec3[] = []
  const cruiseDeadline = now() + CRUISE_TIMEOUT_MS
  // Every early landing aims at a verified spot ahead; the goal landing keeps
  // the goal. The target resolves once, from the heading held when it starts.
  let landingTarget: Vec3 = goal
  let landingTargetResolved = false
  const resolveLandingTarget = async (): Promise<void> => {
    if (landingTargetResolved)
      return
    landingTarget = await chooseLandingTarget(port, state, debug)
    landingTargetResolved = true
  }
  if (reason !== 'goal')
    await resolveLandingTarget()

  try {
    while (state.fallFlying === true) {
      if (shouldStop() && !landing) {
        landing = true
        reason = 'cancelled'
        await resolveLandingTarget()
      }
      if (!landing && now() > cruiseDeadline) {
        landing = true
        reason = 'timeout'
        await resolveLandingTarget()
      }
      if (!landing && horizontalDistance(state.position, goal) <= APPROACH_DISTANCE) {
        landing = true
        reason = 'goal'
        approachDeadline = now() + APPROACH_TIMEOUT_MS
        minApproachGap = horizontalDistance(state.position, goal)
      }
      if (landing && reason === 'goal') {
        const gapToGoal = horizontalDistance(state.position, goal)
        if (gapToGoal < minApproachGap) {
          minApproachGap = gapToGoal
        }
        else if (now() > approachDeadline) {
          reason = 'timeout'
          await resolveLandingTarget()
        }
        else if (
          gapToGoal > minApproachGap + GO_AROUND_GAP_MARGIN
          && state.position.y - goal.y < GO_AROUND_MIN_HEIGHT
        ) {
          // The glide carried past the goal with no height left to bank around.
          // Spend the one go-around, then land nearby instead of turning back
          // to the same point forever.
          if (goArounds < MAX_GO_AROUNDS) {
            goArounds++
            landing = false
            reason = 'goal'
            minApproachGap = Infinity
            debug?.('elytra overshot the goal; one go-around')
          }
          else {
            reason = 'timeout'
            await resolveLandingTarget()
          }
        }
      }
      if (!landing && fireworks <= FIREWORK_LOW_SUPPLY) {
        landing = true
        reason = 'low_supply'
        await resolveLandingTarget()
      }
      if (!landing && (state.health ?? 20) <= LOW_HEALTH) {
        landing = true
        reason = 'safety'
        await resolveLandingTarget()
      }
      // A suit that wears down in flight lands at the nearest spot instead of
      // breaking mid-air; the read is skipped when the bridge cannot report it.
      if (reason !== 'safety' && now() - lastDurabilityAt >= DURABILITY_REFRESH_MS) {
        lastDurabilityAt = now()
        const ratio = await equippedDurabilityRatio(port)
        if (ratio !== undefined && ratio >= WORN_ELYTRA_RATIO) {
          landing = true
          reason = 'safety'
          await resolveLandingTarget()
          debug?.(`elytra worn in flight (${Math.round(ratio * 100)}% used); early landing`)
        }
      }
      const target = landing ? landingTarget : goal
      const yaw = yawTo(state.position, target)
      const gap = horizontalDistance(state.position, target)
      // Landings still scan: flying into a hillside is worse than an early
      // touch-down. Inside the landing zone the scan stops — terrain there is
      // the ground she is about to touch, not an obstacle to climb.
      const scan = (landing && gap <= FLARE_DISTANCE)
        ? { cruiseY, obstacleDistance: undefined }
        : await scanTerrainAhead(port, state, target, cruiseY, debug)
      cruiseY = scan.cruiseY
      const obstacleDistance = scan.obstacleDistance
      const emergency = obstacleDistance !== undefined && obstacleDistance <= TERRAIN_GUARD_DISTANCE

      let pitch: number
      let wantThrust = false
      if (!landing) {
        // Climb over anything close ahead; the scan may only see terrain at
        // the last safe distance, so the nose-up must be decisive.
        const climbing = state.position.y < cruiseY - 4 || emergency
        pitch = climbing ? CLIMB_PITCH : clamp(-(cruiseY - state.position.y) * 1.2, -30, 35)
        wantThrust = climbing || horizontalSpeed(state) < MIN_CRUISE_SPEED
      }
      else if (gap <= FLARE_DISTANCE) {
        // Landing zone: ease the nose up and touch down. A rocket may arrest
        // a hard sink; it fires with the nose up, never nose-down.
        const height = state.position.y - target.y
        const required = Math.atan2(Math.max(0, height), Math.max(1, gap)) * 180 / Math.PI
        const blend = clamp((height - FLARE_HEIGHT) / FLARE_WINDOW, 0, 1)
        pitch = clamp(blend * required + (1 - blend) * FLARE_PITCH, FLARE_PITCH, 35)
        wantThrust = height <= FLARE_HEIGHT && (state.motion?.y ?? 0) < LANDING_ASSIST_FALL_SPEED
      }
      else if (obstacleDistance !== undefined && state.position.y < cruiseY - 4) {
        // A wall in the landing path: spend a rocket to clear it.
        pitch = CLIMB_PITCH
        wantThrust = true
      }
      else {
        // Steer by the descent angle the remaining distance needs; a negative
        // value is clamped to level because she can only glide, not climb.
        const height = Math.max(0, state.position.y - target.y)
        const required = Math.atan2(height, Math.max(1, gap)) * 180 / Math.PI
        pitch = clamp(required, 0, 35)
      }
      await port.look(yaw, pitch)
      debug?.(`elytra fly y=${state.position.y.toFixed(1)} h=${(state.position.y - goal.y).toFixed(1)} d=${gap.toFixed(1)} vy=${(state.motion?.y ?? 0).toFixed(2)} pitch=${pitch.toFixed(1)} fw=${fireworks}${landing ? `:${reason}` : ''}`)

      if (fireworks > 0 && wantThrust && now() - lastFireworkAt > FIREWORK_INTERVAL_MS) {
        await port.selectHotbar(fireworkSlot)
        await port.useItem()
        lastFireworkAt = now()
        fireworks = await countBySuffix(port, 'firework_rocket')
        // A used-up stack would keep thrusting into an empty slot; move to the
        // next stack while rockets remain, otherwise `low_supply` ends the flight.
        if (fireworks > 0 && await countInSlot(port, fireworkSlot) === 0) {
          const next = await selectBySuffix(port, 'firework_rocket')
          if (next !== undefined)
            fireworkSlot = next
        }
        debug?.('elytra thrust fired')
      }

      recent.push({ ...state.position })
      if (recent.length > STUCK_WINDOW_POLLS) {
        recent.shift()
        const oldest = recent[0]!
        if (!landing && horizontalDistance(oldest, state.position) < STUCK_MIN_MOVE && fireworks === 0) {
          // No thrust and no progress: land instead of hovering forever.
          landing = true
          reason = 'timeout'
          await resolveLandingTarget()
        }
      }

      await sleep(FLIGHT_POLL_MS)
      state = await port.getState()
    }

    let distance = horizontalDistance(state.position, goal)
    // Touch-down can stop a few blocks short of the aimed point; close the gap
    // on foot (bounded) so the final distance is measured after the walk.
    const targetGap = horizontalDistance(state.position, landingTarget)
    if (reason !== 'cancelled' && targetGap > tolerance && targetGap <= LANDING_WALK_LIMIT) {
      await walkCloser(port, landingTarget, tolerance, shouldStop, sleep, now)
      const walked = await port.getState()
      distance = horizontalDistance(walked.position, goal)
      debug?.(`elytra landed short; walked to ${distance.toFixed(1)} blocks`)
    }

    if (reason === 'cancelled')
      return { status: 'cancelled', detail: `landed ${distance.toFixed(1)} blocks from the goal` }
    if (reason === 'low_supply')
      return { status: 'low_supply', detail: `landed early with ${fireworks} rockets` }
    if (distance <= tolerance)
      return { status: 'reached' }
    return { status: 'stuck', detail: `landing miss: ${distance.toFixed(1)} blocks` }
  }
  finally {
    await port.stopMovement().catch(() => {})
  }
}

/** Walks the remaining gap after a short landing; stops at tolerance or the timeout. */
async function walkCloser(
  port: MovementControlPort,
  goal: Vec3,
  tolerance: number,
  shouldStop: () => boolean,
  sleep: (ms: number) => Promise<void>,
  now: () => number,
): Promise<void> {
  const deadline = now() + LANDING_WALK_TIMEOUT_MS
  try {
    for (;;) {
      const state = await port.getState()
      if (horizontalDistance(state.position, goal) <= tolerance)
        return
      if (shouldStop() || now() > deadline)
        return
      await port.look(yawTo(state.position, goal), 0)
      await port.setInput({ forward: true })
      await sleep(FLIGHT_POLL_MS)
    }
  }
  finally {
    await port.stopMovement().catch(() => {})
  }
}

function horizontalSpeed(state: MovementState): number {
  return state.motion ? Math.hypot(state.motion.x, state.motion.z) : 0
}

function durabilityRatio(item: { damage?: number, maxDamage?: number }): number {
  return item.damage !== undefined && item.maxDamage ? item.damage / item.maxDamage : 0
}

function isLiquidId(id: string): boolean {
  return id.includes('water') || id.includes('lava')
}

/** Reads the worn elytra wear; undefined skips the refresh when unreadable. */
async function equippedDurabilityRatio(port: MovementControlPort): Promise<number | undefined> {
  const readEquipment = port.getEquipment
  if (!readEquipment)
    return undefined
  const equipment = await readEquipment.call(port).catch(() => undefined)
  const worn = equipment?.chest
  if (!worn || worn.damage === undefined || !worn.maxDamage)
    return undefined
  return worn.damage / worn.maxDamage
}

/**
 * Picks a landing spot on the current heading. It walks forward up to
 * `LANDING_SCAN_MAX` blocks and descends one block per step, returning the
 * first column with solid ground and open space above it. When the scan finds
 * nothing verified, it returns a point straight ahead at the current altitude
 * and does not claim that point is safe.
 */
async function chooseLandingTarget(
  port: MovementControlPort,
  state: MovementState,
  debug?: (message: string) => void,
): Promise<Vec3> {
  const radians = state.yaw * Math.PI / 180
  const dirX = -Math.sin(radians)
  const dirZ = Math.cos(radians)
  const topY = Math.floor(state.position.y)
  for (let step = 1; step <= LANDING_SCAN_MAX; step++) {
    const x = Math.floor(state.position.x + dirX * step)
    const z = Math.floor(state.position.z + dirZ * step)
    const ground = await safeGroundBelow(port, x, z, topY, topY - step)
    if (ground === undefined)
      continue
    const target = { x: x + 0.5, y: ground + 1, z: z + 0.5 }
    debug?.(`elytra landing target ${target.x.toFixed(1)},${target.y},${target.z.toFixed(1)}`)
    return target
  }
  const target = {
    x: state.position.x + dirX * LANDING_SCAN_MAX,
    y: state.position.y,
    z: state.position.z + dirZ * LANDING_SCAN_MAX,
  }
  debug?.(`elytra landing target ${target.x.toFixed(1)},${target.y},${target.z.toFixed(1)} (unverified)`)
  return target
}

/**
 * Finds the solid ground in one column between `topY` and `bottomY`. The two
 * blocks above the ground must be open and dry. An unreadable block fails the
 * column, because an unknown space is not proof of landing room.
 */
async function safeGroundBelow(
  port: MovementControlPort,
  x: number,
  z: number,
  topY: number,
  bottomY: number,
): Promise<number | undefined> {
  for (let y = topY; y >= bottomY; y--) {
    const ground = await port.getBlock({ x, y, z })
    if (!ground || ground.air)
      continue
    if (isLiquidId(ground.id))
      return undefined
    const head = await port.getBlock({ x, y: y + 1, z })
    const above = await port.getBlock({ x, y: y + 2, z })
    if (!head || !above || !head.air || !above.air)
      return undefined
    if (isLiquidId(head.id) || isLiquidId(above.id))
      return undefined
    return y
  }
  return undefined
}

async function equipElytra(
  port: MovementControlPort,
  debug?: (message: string) => void,
): Promise<{ ok: true, lowDurability: boolean } | { ok: false, detail: string }> {
  const readEquipment = port.getEquipment
  if (!readEquipment)
    return { ok: false, detail: 'equipment read unavailable' }
  const equipment = await readEquipment.call(port).catch(() => undefined)
  const worn = equipment?.chest
  const ratio = worn ? durabilityRatio(worn) : 0

  const slots = await port.getInventory()
  const candidates = slots.filter(slot => slot.id.includes('elytra'))
  const backup = candidates.find(slot => durabilityRatio(slot) < WORN_ELYTRA_RATIO)

  if (worn?.id.includes('elytra') && ratio < WORN_ELYTRA_RATIO)
    return { ok: true, lowDurability: false }

  if (backup) {
    await port.swapSlots(backup.slot, CHEST_ARMOR_SLOT)
    return { ok: true, lowDurability: false }
  }

  if (worn?.id.includes('elytra')) {
    // No backup: a suit that may break mid-air is grounded; a worn one flies
    // but only to an early landing.
    if (ratio >= BROKEN_ELYTRA_RATIO) {
      debug?.('elytra is nearly broken and no backup exists')
      return { ok: false, detail: 'elytra is nearly broken and no backup exists' }
    }
    debug?.(`flying a worn elytra (${Math.round(ratio * 100)}% used); early landing only`)
    return { ok: true, lowDurability: true }
  }

  return { ok: false, detail: 'no elytra in the inventory' }
}

/**
 * Selects a hotbar stack whose id contains `suffix`, moving one from the main
 * inventory when needed. Returns the hotbar slot or undefined when none exists.
 */
async function selectBySuffix(port: MovementControlPort, suffix: string): Promise<number | undefined> {
  const slots = await port.getInventory()
  const hotbar = slots.find(slot => slot.hotbar && slot.id.includes(suffix) && slot.count > 0)
  if (hotbar)
    return hotbar.slot
  const main = slots.find(slot => !slot.hotbar && slot.id.includes(suffix) && slot.count > 0)
  if (!main)
    return undefined
  const empty = [0, 1, 2, 3, 4, 5, 6, 7, 8].find(index => !slots.some(slot => slot.hotbar && slot.slot === index))
  if (empty === undefined)
    return undefined
  await port.swapSlots(main.slot, empty)
  return empty
}

async function countBySuffix(port: MovementControlPort, suffix: string): Promise<number> {
  const slots = await port.getInventory()
  return slots
    .filter(slot => slot.id.includes(suffix))
    .reduce((total, slot) => total + slot.count, 0)
}

async function countInSlot(port: MovementControlPort, slot: number): Promise<number> {
  const slots = await port.getInventory()
  return slots.find(entry => entry.slot === slot)?.count ?? 0
}

/** The flight-corridor geometry one scan resolves before filtering blocks. */
export interface CorridorScan {
  originX: number
  originZ: number
  dirX: number
  dirZ: number
  baseY: number
}

/**
 * True when `block` blocks the corridor. Only terrain within
 * `CORRIDOR_HALF_WIDTH` of the heading and at the player's feet or one block
 * above counts; a block the snapshot could not resolve (empty id) counts as
 * an obstacle because absence of a readable id is not proof of air.
 */
export function isObstacleInCorridor(
  block: { x: number, y: number, z: number, id: string },
  corridor: CorridorScan,
): boolean {
  if (block.y !== corridor.baseY && block.y !== corridor.baseY + 1)
    return false
  const dx = block.x + 0.5 - corridor.originX
  const dz = block.z + 0.5 - corridor.originZ
  const ahead = dx * corridor.dirX + dz * corridor.dirZ
  if (ahead < SCAN_FROM / 2 || ahead > SCAN_TO)
    return false
  const lateral = dx * corridor.dirZ - dz * corridor.dirX
  if (Math.abs(lateral) > CORRIDOR_HALF_WIDTH)
    return false
  if (!block.id)
    return true
  return !block.id.endsWith('air') && block.id !== 'minecraft:water'
}

/**
 * Scans ahead at the player's altitude in one region read. The region is a
 * slab from `SCAN_FROM` to `SCAN_TO` along the heading, two blocks tall (the
 * feet layer and the one above). Terrain in that corridor raises the cruise
 * band; the nearest block gives the caller the distance it has left to react.
 */
async function scanTerrainAhead(
  port: MovementControlPort,
  state: MovementState,
  goal: Vec3,
  cruiseY: number,
  debug?: (message: string) => void,
): Promise<{ cruiseY: number, obstacleDistance?: number }> {
  const yaw = yawTo(state.position, goal)
  const radians = yaw * Math.PI / 180
  const dirX = -Math.sin(radians)
  const dirZ = Math.cos(radians)
  const y = Math.floor(state.position.y)
  const startX = Math.floor(state.position.x + dirX * SCAN_FROM)
  const startZ = Math.floor(state.position.z + dirZ * SCAN_FROM)
  const endX = Math.floor(state.position.x + dirX * SCAN_TO)
  const endZ = Math.floor(state.position.z + dirZ * SCAN_TO)
  // One block of slack on each axis so the corridor width is covered even when
  // the heading is nearly cardinal (cos/sin never land on an exact zero).
  const across = 1

  let obstacleDistance: number | undefined
  try {
    const blocks = await port.getBlocksRegion(
      { x: Math.min(startX, endX) - across, y, z: Math.min(startZ, endZ) - across },
      { x: Math.max(startX, endX) + across, y: y + 1, z: Math.max(startZ, endZ) + across },
    )
    const corridor: CorridorScan = {
      originX: state.position.x,
      originZ: state.position.z,
      dirX,
      dirZ,
      baseY: y,
    }
    for (const block of blocks) {
      if (!isObstacleInCorridor(block, corridor))
        continue
      const dx = block.x + 0.5 - state.position.x
      const dz = block.z + 0.5 - state.position.z
      const ahead = dx * dirX + dz * dirZ
      obstacleDistance = obstacleDistance === undefined ? ahead : Math.min(obstacleDistance, ahead)
    }
  }
  catch {
    // A missing chunk or a busy bridge skips this scan; the next poll retries.
  }

  const raised = obstacleDistance === undefined ? cruiseY : Math.max(cruiseY, y + 35)
  if (obstacleDistance !== undefined)
    debug?.(`elytra terrain ahead at ${obstacleDistance.toFixed(0)}; cruise band raised to ${raised}`)
  return { cruiseY: raised, obstacleDistance }
}
