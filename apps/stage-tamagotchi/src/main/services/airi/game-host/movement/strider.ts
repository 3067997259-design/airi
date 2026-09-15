/**
 * Strider mover (MC-3c D3).
 *
 * The strider is steered like a horse (look + forward) but its speed comes
 * from the warped fungus on a stick, which is pulsed while riding. The mover
 * boards only striders, so a nearby boat or minecart cannot be taken by
 * mistake. Dismount is unconditional, including on cancellation.
 */
import type { Vec3 } from './types'
import type { VehicleMoveOptions, VehicleMoveResult } from './vehicle'

import { angleDelta, defaultSleep, horizontalDistance, yawTo } from './geometry'

const STEER_POLL_MS = 250
const STICK_PULSE_MS = 600
const STUCK_WINDOW_POLLS = 16
const STUCK_MIN_MOVE = 0.3
const MAX_STUCK_ATTEMPTS = 2
const MOVE_DEADLINE_MS = 90_000
const STRIDER_TYPE = 'minecraft:strider'
const STICK_ID = 'warped_fungus_on_a_stick'

export async function runStriderMove(options: VehicleMoveOptions): Promise<VehicleMoveResult> {
  const sleep = options.deps?.sleep ?? defaultSleep
  const now = options.deps?.now ?? (() => Date.now())
  const tolerance = options.tolerance ?? 2
  const shouldStop = options.shouldStop ?? (() => false)
  const port = options.port
  const debug = options.debug
  const goal: Vec3 = { x: options.goal.x, y: options.goal.y, z: options.goal.z }

  let riding = await port.getRiding()
  if (!riding || !riding.kind.includes('strider')) {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (shouldStop())
        return { status: 'cancelled' }
      await port.boardNearestVehicle(6, STRIDER_TYPE)
      await sleep(700)
      riding = await port.getRiding()
      if (riding && riding.kind.includes('strider'))
        break
    }
    if (!riding || !riding.kind.includes('strider'))
      return { status: 'unavailable', detail: 'no strider could be mounted' }
  }
  debug?.(`strider mounted (${riding.kind})`)

  // The stick drives the strider; select one before steering.
  const stickSlot = await selectStick(port)
  if (stickSlot === undefined) {
    await port.dismount()
    return { status: 'unavailable', detail: `no ${STICK_ID} in the inventory` }
  }
  await port.selectHotbar(stickSlot)

  let stuckAttempts = 0
  let lastPulseAt = 0
  const recent: Vec3[] = []
  const deadline = now() + MOVE_DEADLINE_MS
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
        return { status: 'stuck', detail: 'strider did not reach the goal in time' }
      }

      const yaw = yawTo(state.position, goal)
      if (Math.abs(angleDelta(state.yaw, yaw)) > 20)
        await port.look(yaw, 0)
      await port.setInput({ forward: true })
      if (now() - lastPulseAt > STICK_PULSE_MS) {
        await port.useItem()
        lastPulseAt = now()
      }
      await sleep(STEER_POLL_MS)

      recent.push({ ...state.position })
      if (recent.length > STUCK_WINDOW_POLLS) {
        recent.shift()
        const oldest = recent[0]!
        if (horizontalDistance(oldest, state.position) < STUCK_MIN_MOVE) {
          stuckAttempts++
          debug?.(`strider stuck attempt ${stuckAttempts}`)
          if (stuckAttempts > MAX_STUCK_ATTEMPTS) {
            await port.dismount()
            return { status: 'stuck', detail: 'strider did not move' }
          }
          // Back out of the shore and try again.
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

async function selectStick(port: VehicleMoveOptions['port']): Promise<number | undefined> {
  const slots = await port.getInventory()
  const hotbar = slots.find(slot => slot.hotbar && slot.id.includes(STICK_ID) && slot.count > 0)
  if (hotbar)
    return hotbar.slot
  const main = slots.find(slot => !slot.hotbar && slot.id.includes(STICK_ID) && slot.count > 0)
  if (!main)
    return undefined
  const empty = [0, 1, 2, 3, 4, 5, 6, 7, 8].find(index => !slots.some(slot => slot.hotbar && slot.slot === index))
  if (empty === undefined)
    return undefined
  await port.swapSlots(main.slot, empty)
  return empty
}
