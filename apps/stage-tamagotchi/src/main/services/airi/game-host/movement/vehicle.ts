/**
 * Vehicle movers (MC-3b): boat, horse, minecart.
 *
 * Each mover owns the player's input while it runs (`steerTo`), acquires the
 * rideable itself, and always dismounts before returning. Reflexes and
 * cancellation keep priority: `shouldStop` is checked on every poll.
 */
import type { MovementControlPort } from './port'
import type { Vec3 } from './types'

import { runElytraMove } from './elytra'
import { angleDelta, defaultSleep, horizontalDistance, yawTo } from './geometry'
import { runStriderMove } from './strider'

export type VehicleKind = 'boat' | 'horse' | 'minecart' | 'elytra' | 'strider'

export interface VehicleContext {
  port: MovementControlPort
  shouldStop: () => boolean
  sleep: (ms: number) => Promise<void>
  now: () => number
  debug?: (message: string) => void
}

/** `low_supply` is an elytra landing that ends early (fireworks or safety). */
export type VehicleMoveStatus = 'reached' | 'stuck' | 'cancelled' | 'unavailable' | 'low_supply'

export interface VehicleMoveResult {
  status: VehicleMoveStatus
  detail?: string
}

export interface VehicleMoveOptions {
  port: MovementControlPort
  goal: Vec3
  tolerance?: number
  shouldStop?: () => boolean
  deps?: {
    sleep?: (ms: number) => Promise<void>
    now?: () => number
  }
  debug?: (message: string) => void
}

const STEER_POLL_MS = 250
const STUCK_WINDOW_POLLS = 12
const STUCK_MIN_MOVE = 0.4
const MAX_STUCK_ATTEMPTS = 2

function findBoatSlot(slots: Array<{ slot: number, id: string, count: number, hotbar: boolean }>): { slot: number, hotbar: boolean } | undefined {
  const entry = slots.find(candidate => candidate.id.includes('boat') && candidate.count > 0)
  return entry ? { slot: entry.slot, hotbar: entry.hotbar } : undefined
}

/**
 * Boat mover: place a boat on water, mount it, steer short segments to the
 * goal, then dismount.
 */
async function runBoatMove(options: VehicleMoveOptions): Promise<VehicleMoveResult> {
  const sleep = options.deps?.sleep ?? defaultSleep
  const tolerance = options.tolerance ?? 1.5
  const shouldStop = options.shouldStop ?? (() => false)
  const port = options.port
  const debug = options.debug

  // Acquire: place the boat and mount it if the player is not already riding.
  let riding = await port.getRiding()
  if (!riding || !riding.kind.includes('boat')) {
    const slot = findBoatSlot(await port.getInventory())
    if (!slot)
      return { status: 'unavailable', detail: 'no boat item in the inventory' }
    // The boat is often delivered into the main inventory while the hotbar is
    // full; swap it into a hotbar slot before selecting it.
    const targetSlot = slot.hotbar ? slot.slot : 4
    if (!slot.hotbar)
      await port.swapSlots(slot.slot, targetSlot)
    await port.selectHotbar(targetSlot)
    for (let attempt = 0; attempt < 2; attempt++) {
      if (shouldStop())
        return { status: 'cancelled' }
      // Aim down the canal toward the goal; a fixed yaw can hit the bank.
      const lookState = await port.getState()
      await port.look(yawTo(lookState.position, options.goal), 30)
      await port.useItem()
      await sleep(600)
      riding = await port.getRiding()
      if (riding && riding.kind.includes('boat'))
        break
    }
    if (!riding || !riding.kind.includes('boat')) {
      // The boat may be placed but not mounted; right-click the nearest one.
      const boarded = await port.boardNearestVehicle(4)
      if (boarded.boarded) {
        await sleep(500)
        riding = await port.getRiding()
      }
    }
    if (!riding || !riding.kind.includes('boat'))
      return { status: 'unavailable', detail: 'boat placement did not mount the player' }
  }
  debug?.(`boat mounted (${riding.kind})`)

  const goal: Vec3 = { x: options.goal.x, y: options.goal.y, z: options.goal.z }
  let stuckAttempts = 0
  const recent: Vec3[] = []

  try {
    for (;;) {
      if (shouldStop()) {
        await port.dismount()
        return { status: 'cancelled' }
      }
      const state = await port.getState()
      if (horizontalDistance(state.position, goal) <= tolerance) {
        await port.dismount()
        return { status: 'reached' }
      }

      const yaw = yawTo(state.position, goal)
      if (Math.abs(angleDelta(state.yaw, yaw)) > 20)
        await port.look(yaw, 0)
      await port.setInput({ forward: true, sprint: false })
      await sleep(STEER_POLL_MS)

      recent.push({ ...state.position })
      if (recent.length > STUCK_WINDOW_POLLS) {
        recent.shift()
        const oldest = recent[0]!
        if (horizontalDistance(oldest, state.position) < STUCK_MIN_MOVE) {
          stuckAttempts++
          debug?.(`boat stuck attempt ${stuckAttempts} at ${state.position.x.toFixed(1)},${state.position.z.toFixed(1)}`)
          if (stuckAttempts > MAX_STUCK_ATTEMPTS) {
            await port.dismount()
            return { status: 'stuck', detail: 'boat did not move' }
          }
          // Back out of the shallow spot and try again.
          await port.setInput({ forward: false, back: true })
          await sleep(450)
          await port.stopMovement()
          recent.length = 0
        }
      }
    }
  }
  finally {
    await port.stopMovement().catch(() => {})
  }
}

/**
 * Horse mover: board the nearest horse (mount, tame, saddle attempts), steer
 * short segments, charge a jump when the horse stops making progress, and
 * dismount.
 */
async function runHorseMove(options: VehicleMoveOptions): Promise<VehicleMoveResult> {
  const sleep = options.deps?.sleep ?? defaultSleep
  const now = options.deps?.now ?? (() => Date.now())
  const tolerance = options.tolerance ?? 2
  const shouldStop = options.shouldStop ?? (() => false)
  const port = options.port
  const debug = options.debug
  const goal: Vec3 = { x: options.goal.x, y: options.goal.y, z: options.goal.z }

  // Acquire: mount attempts cover wild horses (mounting also tames) and the
  // saddle right-click when a saddle is held.
  let riding = await port.getRiding()
  if (!riding || !isHorse(riding.kind)) {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (shouldStop())
        return { status: 'cancelled' }
      await port.boardNearestVehicle(6)
      await sleep(700)
      riding = await port.getRiding()
      if (riding && isHorse(riding.kind))
        break
    }
    if (!riding || !isHorse(riding.kind))
      return { status: 'unavailable', detail: 'no horse could be mounted' }
  }
  debug?.(`horse mounted (${riding.kind})`)

  let stuckAttempts = 0
  const recent: Vec3[] = []
  const deadline = now() + 45_000
  try {
    for (;;) {
      if (shouldStop()) {
        await port.dismount()
        return { status: 'cancelled' }
      }
      const state = await port.getState()
      if (horizontalDistance(state.position, goal) <= tolerance) {
        await port.dismount()
        return { status: 'reached' }
      }
      if (now() > deadline) {
        await port.dismount()
        return { status: 'stuck', detail: 'horse did not reach the goal in time' }
      }

      const yaw = yawTo(state.position, goal)
      if (Math.abs(angleDelta(state.yaw, yaw)) > 20)
        await port.look(yaw, 0)
      await port.setInput({ forward: true })
      await sleep(STEER_POLL_MS)

      recent.push({ ...state.position })
      if (recent.length > STUCK_WINDOW_POLLS) {
        recent.shift()
        const oldest = recent[0]!
        if (horizontalDistance(oldest, state.position) < 0.3) {
          stuckAttempts++
          debug?.(`horse stuck attempt ${stuckAttempts}`)
          if (stuckAttempts > MAX_STUCK_ATTEMPTS) {
            await port.dismount()
            return { status: 'stuck', detail: 'horse did not move' }
          }
          // Charge a jump (holds jump ~0.5s) to clear a taller obstacle.
          await port.setInput({ jump: true })
          await sleep(500)
          await port.setInput({ jump: false })
          await sleep(300)
          recent.length = 0
        }
      }
    }
  }
  finally {
    await port.stopMovement().catch(() => {})
  }
}

/**
 * Minecart mover (v1): the cart is expected on a prepared line (rails are
 * fixture work). The mover boards it and waits until it rolls within
 * tolerance of the goal; it has no steering input.
 */
async function runMinecartMove(options: VehicleMoveOptions): Promise<VehicleMoveResult> {
  const sleep = options.deps?.sleep ?? defaultSleep
  const now = options.deps?.now ?? (() => Date.now())
  const tolerance = options.tolerance ?? 2
  const shouldStop = options.shouldStop ?? (() => false)
  const port = options.port
  const debug = options.debug
  const goal: Vec3 = { x: options.goal.x, y: options.goal.y, z: options.goal.z }

  let riding = await port.getRiding()
  if (!riding || !riding.kind.includes('minecart')) {
    const boarded = await port.boardNearestVehicle(4)
    if (boarded.boarded) {
      await sleep(600)
      riding = await port.getRiding()
    }
    if (!riding || !riding.kind.includes('minecart'))
      return { status: 'unavailable', detail: 'no minecart could be boarded' }
  }
  debug?.(`minecart boarded (${riding.kind})`)

  const deadline = now() + 30_000
  try {
    for (;;) {
      if (shouldStop()) {
        await port.dismount()
        return { status: 'cancelled' }
      }
      const state = await port.getState()
      if (horizontalDistance(state.position, goal) <= tolerance) {
        await port.dismount()
        return { status: 'reached' }
      }
      if (now() > deadline) {
        await port.dismount()
        return { status: 'stuck', detail: 'minecart did not arrive' }
      }
      // Keep the rider synced; a stopped cart stays stopped.
      await port.setInput({ forward: false })
      await sleep(400)
    }
  }
  finally {
    await port.stopMovement().catch(() => {})
  }
}

function isHorse(type: string): boolean {
  return type.includes('horse') || type.includes('donkey') || type.includes('mule') || type.includes('camel')
}

/** Dispatches to the mover for one vehicle kind. */
export async function runVehicleMove(kind: VehicleKind, options: VehicleMoveOptions): Promise<VehicleMoveResult> {
  switch (kind) {
    case 'boat':
      return await runBoatMove(options)
    case 'horse':
      return await runHorseMove(options)
    case 'minecart':
      return await runMinecartMove(options)
    case 'elytra':
      return await runElytraMove(options)
    case 'strider':
      return await runStriderMove(options)
  }
}
