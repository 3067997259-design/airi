import type { BlockFace, BlockView, ElytraLaunchStatus, ElytraLaunchTask, EquipmentView, FlightChannelRevokeReceipt, FlightChannelStatus, FlightChannelSubmitReceipt, FlightChannelSubmitRequest, InventorySlot, MovementControlPort, MovementInput, MovementState, RidingInfo } from './port'
import type { SnapshotEntry } from './snapshot'
import type { Vec3 } from './types'

import { describe, expect, it } from 'vitest'

import { FLIGHT_PROFILE_1_21_1 } from '../flight/profile'
import { evaluateApproachEntry, runElytraMove } from './elytra'
import { runVehicleMove } from './vehicle'

const FAST = { sleep: async () => {}, now: () => Date.now() }
/**
 * Chest armor index in the player inventory.
 *
 * 38, not 37: `Inventory` stores armor as boots, leggings, chestplate, helmet at
 * 36..39, and the compiled 1.21.1 `EquipmentSlot` constants confirm the list
 * order (FEET 0, LEGS 1, CHEST 2, HEAD 3).
 */
const CHEST_SLOT = 38

interface FakeOptions {
  inventory?: InventorySlot[]
  chest?: EquipmentView
  goal: Vec3
  landAt?: Vec3
  /** Land right after deploy at `landAt` (for landing-miss cases). */
  landImmediately?: boolean
  /** Horizontal speed reported to the mover; low values force firework thrust. */
  speed?: number
  /** A solid wall the scan can see, at the player's altitude. */
  wall?: { x: number, top: number }
  /** Extra blocks the region read returns, clipped to the requested bounds. */
  blocks?: SnapshotEntry[]
  /** Flight positions, one per poll; overrides goal steering and lands at the end. */
  path?: Vec3[]
  /** Elytra wear added to the chest slot on each poll, so the refresh can fire. */
  durabilityPerPoll?: number
  /**
   * Makes a jump a no-op while a movement key is held.
   *
   * Mirrors the live rule that cost a real run: the takeoff sprint held
   * `forward + sprint` through the whole fall, so every deploy press did
   * nothing and the bot died on the ground below.
   */
  deployRequiresReleasedInput?: boolean
  /**
   * Adds the bridge's per-tick launch macro to this fake (OV-5).
   *
   * Absent means the bridge has no launch tools, which is the edge-run fallback
   * every other test in this file exercises. `launched` opens the glider from
   * where the bot stands, with no run and no forward input at all.
   */
  launchScript?: 'launched' | 'not_deployed'
}

class ElytraFakePort implements MovementControlPort {
  position: Vec3 = { x: 0, y: 100, z: 0 }
  yaw = 0
  onGround = true
  fallFlying = false
  jumps = 0
  chest: EquipmentView | undefined
  swaps: Array<[number, number]> = []
  selectedSlots: number[] = []
  currentHotbar = -1
  fireworkUses = 0
  lookPitches: number[] = []
  inputs: MovementInput = {}
  inventory: InventorySlot[]
  polls = 0
  /** Per-tick launch macro, present only when the fake bridge has one (OV-5). */
  startLaunch?: (task: ElytraLaunchTask) => Promise<ElytraLaunchStatus>
  launchStatus?: () => Promise<ElytraLaunchStatus>
  cancelLaunch?: () => Promise<ElytraLaunchStatus>
  launchCalls = 0
  launchStatusCalls = 0
  cancelLaunchCalls = 0
  /** True once the mover held forward, which is the edge run and nothing else. */
  sawForwardRun = false
  private launchPolls = 0
  private pathIndex = 0
  private landPending = false
  private hasTakenOff = false
  private readonly options: FakeOptions

  constructor(options: FakeOptions) {
    this.options = options
    this.inventory = options.inventory ?? [
      { slot: 4, id: 'minecraft:firework_rocket', count: 8, hotbar: true },
      { slot: 12, id: 'minecraft:elytra', count: 1, hotbar: false },
    ]
    this.chest = options.chest
    if (options.launchScript) {
      const script = options.launchScript
      this.startLaunch = async () => {
        this.launchCalls++
        return { state: 'running', endReason: 'running', ticks: 0, phase: 'prepare' }
      }
      this.launchStatus = async () => {
        this.launchStatusCalls++
        this.launchPolls++
        if (script === 'not_deployed')
          return { state: 'failed', endReason: 'not_deployed', ticks: 20, phase: 'deploy', deployed: false }
        // The macro jumps, releases and deploys on its own ticks; the host only
        // reads the result, so the glider is already open here.
        this.onGround = false
        this.fallFlying = true
        return { state: 'done', endReason: 'launched', ticks: 12, phase: 'handoff', deployed: true, airborne: true, climb: 4, fireworksUsed: 1 }
      }
      this.cancelLaunch = async () => {
        this.cancelLaunchCalls++
        return { state: 'cancelled', endReason: 'cancelled', ticks: this.launchPolls, deployed: this.fallFlying }
      }
    }
  }

  async getState(): Promise<MovementState> {
    this.polls++
    if (this.onGround && this.inputs.forward && !this.hasTakenOff) {
      // The takeoff run carries the player off the launch edge.
      this.hasTakenOff = true
      this.onGround = false
    }
    else if (this.onGround && this.inputs.forward) {
      // Post-landing walk: close the remaining gap on foot.
      const dx = this.options.goal.x - this.position.x
      const dz = this.options.goal.z - this.position.z
      const distance = Math.hypot(dx, dz)
      if (distance > 0.01) {
        const step = Math.min(1.5, distance)
        this.position = {
          x: this.position.x + dx / distance * step,
          y: this.position.y,
          z: this.position.z + dz / distance * step,
        }
      }
    }
    else if (!this.onGround && !this.fallFlying && this.jumps > 0) {
      // Real rule (live, 2026-09-18): a jump opens the glider only when no
      // movement key is held. Holding a key is not a new press, so a deploy
      // attempted while the takeoff sprint still holds `forward` is a no-op.
      const holdingMovement = this.inputs.forward === true || this.inputs.sprint === true
      if (!this.options.deployRequiresReleasedInput || !holdingMovement)
        this.fallFlying = true
    }
    if (this.fallFlying && this.options.path) {
      const next = this.options.path[this.pathIndex++]
      if (next) {
        this.position = { ...next }
      }
      else {
        this.fallFlying = false
        this.onGround = true
      }
    }
    else if (this.fallFlying && this.options.landImmediately) {
      // Land on the poll after deploy so the mover observes a real flight first.
      if (this.landPending) {
        this.position = { ...(this.options.landAt ?? this.options.goal) }
        this.fallFlying = false
        this.onGround = true
      }
      else {
        this.landPending = true
      }
    }
    else if (this.fallFlying) {
      const target = this.options.landAt ?? this.options.goal
      const dx = target.x - this.position.x
      const dz = target.z - this.position.z
      const distance = Math.hypot(dx, dz)
      if (distance <= 1) {
        const nextY = this.position.y - 8
        if (nextY <= target.y) {
          this.position = { ...target }
          this.fallFlying = false
          this.onGround = true
        }
        else {
          this.position = { ...this.position, y: nextY }
        }
      }
      else {
        const step = Math.min(3, distance)
        this.position = {
          x: this.position.x + dx / distance * step,
          y: this.position.y,
          z: this.position.z + dz / distance * step,
        }
      }
    }
    if (this.options.durabilityPerPoll && this.chest?.maxDamage !== undefined) {
      this.chest = {
        ...this.chest,
        damage: Math.min(this.chest.maxDamage, (this.chest.damage ?? 0) + this.options.durabilityPerPoll),
      }
    }
    const speed = this.options.speed ?? 1
    return {
      position: { ...this.position },
      yaw: this.yaw,
      inWater: false,
      onGround: this.onGround,
      // A settled player reports no residual motion; while gliding the fake
      // reports the configured speed so the cruise thrust logic still works.
      motion: this.onGround ? { x: 0, y: 0, z: 0 } : { x: speed, y: 0, z: 0 },
      fallFlying: this.fallFlying,
      health: 20,
    }
  }

  async getBlocksRegion(from: Vec3, to: Vec3): Promise<SnapshotEntry[]> {
    // Mirrors the bridge's `includeAir: true` read: every covered cell is
    // returned, so a missing cell means the read did not cover it (unknown).
    const x0 = Math.floor(from.x)
    const x1 = Math.floor(to.x)
    const y0 = Math.floor(from.y)
    const y1 = Math.floor(to.y)
    const z0 = Math.floor(from.z)
    const z1 = Math.floor(to.z)
    const key = (x: number, y: number, z: number) => `${x},${y},${z}`
    const byKey = new Map<string, SnapshotEntry>()
    const wall = this.options.wall
    if (wall) {
      for (let x = x0; x <= x1; x++) {
        for (let z = z0; z <= z1; z++) {
          if (x >= wall.x && x <= wall.x + 2 && y0 <= wall.top)
            byKey.set(key(x, y0, z), { x, y: y0, z, id: 'minecraft:stone' })
        }
      }
    }
    for (const block of this.options.blocks ?? []) {
      const bx = Math.floor(block.x)
      const by = Math.floor(block.y)
      const bz = Math.floor(block.z)
      if (bx >= x0 && bx <= x1 && by >= y0 && by <= y1 && bz >= z0 && bz <= z1)
        byKey.set(key(bx, by, bz), block)
    }
    const entries: SnapshotEntry[] = []
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++)
          entries.push(byKey.get(key(x, y, z)) ?? { x, y, z, id: 'minecraft:air' })
      }
    }
    return entries
  }

  async getBlock(pos: Vec3): Promise<BlockView | undefined> {
    const wall = this.options.wall
    if (wall && pos.x >= wall.x && pos.x <= wall.x + 2 && pos.y <= wall.top)
      return { id: 'minecraft:stone', air: false }
    const block = this.options.blocks?.find(entry =>
      entry.x === Math.floor(pos.x) && entry.y === Math.floor(pos.y) && entry.z === Math.floor(pos.z))
    if (block?.id && !block.id.endsWith('air'))
      return { id: block.id, air: false }
    return { id: 'minecraft:air', air: true }
  }

  async getInventory(): Promise<InventorySlot[]> {
    return this.inventory
  }

  async look(yaw: number, pitch = 0): Promise<void> {
    this.yaw = yaw
    this.lookPitches.push(pitch)
  }

  async setInput(input: MovementInput): Promise<void> {
    if (input.forward === true)
      this.sawForwardRun = true
    this.inputs = { ...this.inputs, ...input }
  }

  async stopMovement(): Promise<void> {
    this.inputs = {}
  }

  async jumpOnce(): Promise<void> {
    this.jumps++
  }

  async breakBlock(): Promise<void> {}

  async placeBlock(_support: Vec3, _face: BlockFace): Promise<void> {}

  async useBlock(): Promise<void> {}

  async useItem(): Promise<void> {
    // Vanilla: using an elytra while not gliding wears it, swapping whatever was
    // on the body back into the hand. This is the path the mover uses instead of
    // writing the armor slot (live 2026-09-18).
    const held = this.inventory.find(slot => slot.slot === this.currentHotbar)
    if (held?.id.includes('elytra')) {
      const previous = this.chest
      this.chest = {
        id: held.id,
        ...(held.damage !== undefined ? { damage: held.damage } : {}),
        ...(held.maxDamage !== undefined ? { maxDamage: held.maxDamage } : {}),
      }
      if (previous) {
        held.id = previous.id
        held.damage = previous.damage
        held.maxDamage = previous.maxDamage
      }
      else {
        held.id = ''
        held.count = 0
      }
      return
    }
    this.fireworkUses++
    const selected = this.inventory.find(slot => slot.slot === this.currentHotbar)
    if (selected && selected.count > 0)
      selected.count -= 1
  }

  async selectHotbar(slot: number): Promise<void> {
    this.selectedSlots.push(slot)
    this.currentHotbar = slot
  }

  async swapSlots(slotA: number, slotB: number): Promise<void> {
    this.swaps.push([slotA, slotB])
    // ROOT CAUSE the fake models (live, 2026-09-18): the bridge's
    // `InventoryHandlers.toMenuSlot` maps inventory indices 36..39 onto menu
    // slots 5..8 documented as "helmet..boots", while `Inventory` stores armor as
    // feet, legs, chest, head. Every armor write therefore lands on another slot:
    // 36/37/38/39 all left the chest untouched while the call answered `swapped`.
    // A host that depends on that write fails here too, which is the point.
    if (slotB >= 36 && slotB <= 39)
      return
    const from = this.inventory.find(slot => slot.slot === slotA)
    const to = this.inventory.find(slot => slot.slot === slotB)
    if (!from)
      return
    const moved = { ...from }
    if (to) {
      from.id = to.id
      from.count = to.count
      from.damage = to.damage
      from.maxDamage = to.maxDamage
      to.id = moved.id
      to.count = moved.count
      to.damage = moved.damage
      to.maxDamage = moved.maxDamage
    }
    else {
      this.inventory.push({ ...moved, slot: slotB, hotbar: slotB <= 8 })
      from.id = ''
      from.count = 0
    }
  }

  async dismount(): Promise<void> {}

  async getRiding(): Promise<RidingInfo | undefined> {
    return undefined
  }

  async boardNearestVehicle(): Promise<{ boarded: boolean, info?: RidingInfo }> {
    return { boarded: false }
  }

  async useEntity(): Promise<void> {}

  async getEquipment(): Promise<{ chest?: EquipmentView } | undefined> {
    return (this.chest ? { chest: this.chest } : {})
  }
}

describe('runElytraMove', () => {
  it('wears the elytra, deploys off the edge, thrusts, and lands at the goal', async () => {
    const goal = { x: 200, y: 64, z: 0 }
    const port = new ElytraFakePort({ goal, speed: 0.1 })
    const result = await runElytraMove({ port, goal, deps: FAST })
    expect(result.status).toBe('reached')
    // The suit is worn by hand now, not by an armor write the bridge cannot do.
    expect(port.chest?.id).toBe('minecraft:elytra')
    expect(port.swaps.some(([, to]) => to === CHEST_SLOT)).toBe(false)
    expect(port.selectedSlots).toContain(4)
    expect(port.fireworkUses).toBeGreaterThanOrEqual(1)
  })

  it('wears a spare suit by hand when the armor write cannot reach the chest', async () => {
    // ROOT CAUSE (live, 2026-09-18): the chest held a 431/432 elytra, which is
    // not fly-enabled, and the fresh spare could not be moved onto the body by
    // `swap_slots`. The flight then failed with `not_deployed` after the mover
    // reported the suit as replaced.
    const goal = { x: 200, y: 64, z: 0 }
    const port = new ElytraFakePort({
      goal,
      speed: 0.1,
      launchScript: 'launched',
      chest: { id: 'minecraft:elytra', damage: 400, maxDamage: 432 },
      inventory: [
        { slot: 4, id: 'minecraft:firework_rocket', count: 8, hotbar: true },
        { slot: 12, id: 'minecraft:elytra', count: 1, hotbar: false },
      ],
    })
    const result = await runElytraMove({ port, goal, deps: FAST })
    expect(port.chest?.damage).toBeUndefined()
    expect(port.swaps.some(([, to]) => to === CHEST_SLOT)).toBe(false)
    expect(result.status).not.toBe('unavailable')
  })

  it('releases the takeoff keys before pressing jump to deploy', async () => {
    // ROOT CAUSE (live, 2026-09-18):
    //
    // The takeoff sprint held `forward + sprint` through the fall, and a held
    // key is not a new press, so `jumpOnce()` never opened the glider. A real
    // run off the ridge at (-384, 161, 19) fell 24 blocks with
    // `fallFlying: false` and died (`airitest fell from a high place`).
    //
    // The mover now releases the run keys before the first deploy press. This
    // fake enforces the same rule, so it fails if the release is removed.
    const goal = { x: 200, y: 64, z: 0 }
    const port = new ElytraFakePort({ goal, speed: 0.1, deployRequiresReleasedInput: true })
    const result = await runElytraMove({ port, goal, deps: FAST })
    expect(result.status).toBe('reached')
    expect(port.jumps).toBeGreaterThanOrEqual(1)
  })

  it('fails with unavailable when no elytra exists', async () => {
    const goal = { x: 200, y: 64, z: 0 }
    const port = new ElytraFakePort({
      goal,
      inventory: [{ slot: 4, id: 'minecraft:firework_rocket', count: 8, hotbar: true }],
    })
    const result = await runElytraMove({ port, goal, deps: FAST })
    expect(result.status).toBe('unavailable')
    expect(result.detail).toContain('elytra')
  })

  it('lands early and reports low_supply when rockets run low', async () => {
    const goal = { x: 200, y: 64, z: 0 }
    const port = new ElytraFakePort({
      goal,
      inventory: [
        { slot: 4, id: 'minecraft:firework_rocket', count: 2, hotbar: true },
        { slot: 12, id: 'minecraft:elytra', count: 1, hotbar: false },
      ],
    })
    const result = await runElytraMove({ port, goal, deps: FAST })
    expect(result.status).toBe('low_supply')
  })

  it('takes off with the bridge launch macro and never runs off an edge', async () => {
    const goal = { x: 200, y: 64, z: 0 }
    const port = new ElytraFakePort({ goal, speed: 0.1, launchScript: 'launched' })
    const result = await runElytraMove({ port, goal, deps: FAST })
    expect(result.status).toBe('reached')
    // OV-D16: the flat-ground path is the macro, submitted once. The edge run is
    // what holds forward; a macro takeoff must never reach it.
    expect(port.launchCalls).toBe(1)
    expect(port.sawForwardRun).toBe(false)
    expect(port.jumps).toBe(0)
  })

  it('falls back to the edge run when the macro cannot open the glider', async () => {
    const goal = { x: 200, y: 64, z: 0 }
    const port = new ElytraFakePort({ goal, speed: 0.1, launchScript: 'not_deployed' })
    const result = await runElytraMove({ port, goal, deps: FAST })
    expect(result.status).toBe('reached')
    expect(port.launchCalls).toBe(1)
    expect(port.sawForwardRun).toBe(true)
    expect(port.jumps).toBeGreaterThanOrEqual(1)
  })

  it('still launches when the only rocket sits in the offhand', async () => {
    // ROOT CAUSE (live, 2026-09-18): the launch macro parks its rocket in the
    // offhand, and the takeoff used to refuse when no *hotbar* stack could be
    // selected. The macro can fire either hand, so an offhand stack is ammo; only
    // the cruise thrust needs a hotbar slot, and it reports low_supply instead.
    const goal = { x: 200, y: 64, z: 0 }
    const port = new ElytraFakePort({
      goal,
      speed: 0.1,
      launchScript: 'launched',
      inventory: [
        { slot: 45, id: 'minecraft:firework_rocket', count: 8, hotbar: false },
        { slot: 12, id: 'minecraft:elytra', count: 1, hotbar: false },
      ],
    })
    const result = await runElytraMove({ port, goal, deps: FAST })
    expect(port.launchCalls).toBe(1)
    expect(result.status).not.toBe('unavailable')
  })

  it('lands instead of dropping control when cancelled in flight', async () => {
    const goal = { x: 200, y: 64, z: 0 }
    const port = new ElytraFakePort({ goal })
    const result = await runElytraMove({ port, goal, deps: FAST, shouldStop: () => port.fallFlying })
    expect(result.status).toBe('cancelled')
    expect(port.onGround).toBe(true)
  })

  it('climbs and thrusts when terrain blocks the cruise altitude', async () => {
    const goal = { x: 200, y: 64, z: 0 }
    const port = new ElytraFakePort({ goal, wall: { x: 100, top: 130 } })
    const result = await runElytraMove({ port, goal, deps: FAST })
    expect(result.status).toBe('reached')
    expect(Math.min(...port.lookPitches)).toBeLessThan(-10)
    expect(port.fireworkUses).toBeGreaterThanOrEqual(1)
  })

  it('ignores terrain far to the side of the flight corridor', async () => {
    const goal = { x: 200, y: 64, z: 200 }
    // (6,100,32) sits inside the axis-aligned scan box but ~18 blocks off the
    // diagonal heading; review R6 saw it force a pointless climb.
    const port = new ElytraFakePort({
      goal,
      blocks: [{ x: 6, y: 100, z: 32, id: 'minecraft:stone' }],
    })
    const result = await runElytraMove({ port, goal, deps: FAST })
    expect(result.status).toBe('reached')
    expect(Math.min(...port.lookPitches)).toBeGreaterThan(-20)
  })

  it('climbs over terrain one block to the side of the heading', async () => {
    const goal = { x: 200, y: 64, z: 0 }
    const port = new ElytraFakePort({
      goal,
      blocks: [{ x: 17, y: 100, z: 1, id: 'minecraft:stone' }],
    })
    const result = await runElytraMove({ port, goal, deps: FAST })
    expect(result.status).toBe('reached')
    expect(Math.min(...port.lookPitches)).toBeLessThan(-20)
  })

  it('climbs over terrain one layer above the player feet', async () => {
    const goal = { x: 200, y: 64, z: 0 }
    const port = new ElytraFakePort({
      goal,
      blocks: [{ x: 17, y: 101, z: 0, id: 'minecraft:stone' }],
    })
    const result = await runElytraMove({ port, goal, deps: FAST })
    expect(result.status).toBe('reached')
    expect(Math.min(...port.lookPitches)).toBeLessThan(-20)
  })

  it('treats an unreadable block in the corridor as an obstacle', async () => {
    const goal = { x: 200, y: 64, z: 0 }
    const port = new ElytraFakePort({
      goal,
      blocks: [{ x: 17, y: 100, z: 0, id: '' }],
    })
    const result = await runElytraMove({ port, goal, deps: FAST })
    expect(result.status).toBe('reached')
    expect(Math.min(...port.lookPitches)).toBeLessThan(-20)
  })

  it('ends an approach that overstays its own deadline', async () => {
    const goal = { x: 40, y: 64, z: 0 }
    const port = new ElytraFakePort({ goal })
    const messages: string[] = []
    let clock = 0
    const result = await runElytraMove({
      port,
      goal,
      deps: { now: () => clock, sleep: async () => { clock += 15_000 } },
      debug: message => messages.push(message),
    })
    // The approach deadline is enforced at the top of the loop instead of only
    // when the gap stops improving; the safety landing is bounded, so the
    // receipt reports an unverified stop rather than a fabricated reach.
    expect(messages.some(message => message.includes(':timeout'))).toBe(true)
    expect(result.status).toBe('unknown')
    expect(result.failure).toBe('touchdown_unverified')
  })

  it('switches to the next firework stack when the selected one runs out', async () => {
    const goal = { x: 200, y: 64, z: 0 }
    const port = new ElytraFakePort({
      goal,
      speed: 0.1,
      inventory: [
        { slot: 4, id: 'minecraft:firework_rocket', count: 2, hotbar: true },
        { slot: 5, id: 'minecraft:firework_rocket', count: 100, hotbar: true },
        { slot: 12, id: 'minecraft:elytra', count: 1, hotbar: false },
      ],
    })
    let clock = 0
    const result = await runElytraMove({
      port,
      goal,
      deps: { now: () => clock, sleep: async () => { clock += 2_000 } },
    })
    expect(result.status).toBe('reached')
    expect(port.selectedSlots).toContain(4)
    expect(port.selectedSlots).toContain(5)
  })

  it('walks the last meters when the glide lands short', async () => {
    const goal = { x: 200, y: 64, z: 0 }
    const port = new ElytraFakePort({ goal, landAt: { x: 190, y: 64, z: 0 } })
    const result = await runElytraMove({ port, goal, deps: FAST })
    expect(result.status).toBe('reached')
    expect(port.position.x).toBeGreaterThan(195)
  })

  it('reports a landing miss as stuck', async () => {
    const goal = { x: 30, y: 64, z: 0 }
    const port = new ElytraFakePort({ goal, landAt: { x: 200, y: 64, z: 0 }, landImmediately: true })
    const result = await runElytraMove({ port, goal, deps: FAST })
    expect(result.status).toBe('stuck')
    expect(result.detail).toContain('landing miss')
  })

  it('is reachable through the vehicle dispatcher', async () => {
    const goal = { x: 30, y: 64, z: 0 }
    const port = new ElytraFakePort({
      goal,
      inventory: [{ slot: 4, id: 'minecraft:firework_rocket', count: 8, hotbar: true }],
    })
    const result = await runVehicleMove('elytra', { port, goal, deps: FAST })
    expect(result.status).toBe('unavailable')
  })

  it('descends in place instead of flying to the goal when rockets run low', async () => {
    const goal = { x: 200, y: 64, z: 0 }
    const port = new ElytraFakePort({
      goal,
      inventory: [
        { slot: 4, id: 'minecraft:firework_rocket', count: 2, hotbar: true },
        { slot: 12, id: 'minecraft:elytra', count: 1, hotbar: false },
      ],
    })
    const messages: string[] = []
    const result = await runElytraMove({ port, goal, deps: FAST, debug: message => messages.push(message) })
    expect(result.status).toBe('low_supply')
    const target = messages.find(message => message.startsWith('elytra landing target'))!
    expect(target).toBeDefined()
    // No verified site: the bounded ending descends where she is; flying to an
    // unverified point ahead is what killed runs (R4 cave-diag-05).
    expect(target).toContain('descending in place')
    expect(target).not.toContain('200.0')
  })

  it('scans ahead for a verified support area when landing early', async () => {
    const goal = { x: 200, y: 64, z: 0 }
    const port = new ElytraFakePort({
      goal,
      inventory: [
        { slot: 4, id: 'minecraft:firework_rocket', count: 2, hotbar: true },
        { slot: 12, id: 'minecraft:elytra', count: 1, hotbar: false },
      ],
      // A single block is not a landing site (design §7); a 2x2 patch is.
      blocks: [
        { x: 10, y: 98, z: 0, id: 'minecraft:stone' },
        { x: 11, y: 98, z: 0, id: 'minecraft:stone' },
        { x: 10, y: 98, z: 1, id: 'minecraft:stone' },
        { x: 11, y: 98, z: 1, id: 'minecraft:stone' },
      ],
    })
    const messages: string[] = []
    await runElytraMove({ port, goal, deps: FAST, debug: message => messages.push(message) })
    expect(messages.some(message => message.includes('elytra landing target 11.0,99,1.0'))).toBe(true)
  })

  it('never records a single block as a landing site', async () => {
    const goal = { x: 200, y: 64, z: 0 }
    const port = new ElytraFakePort({
      goal,
      inventory: [
        { slot: 4, id: 'minecraft:firework_rocket', count: 2, hotbar: true },
        { slot: 12, id: 'minecraft:elytra', count: 1, hotbar: false },
      ],
      blocks: [{ x: 10, y: 98, z: 0, id: 'minecraft:stone' }],
    })
    const messages: string[] = []
    await runElytraMove({ port, goal, deps: FAST, debug: message => messages.push(message) })
    expect(messages.some(message => message.includes('descending in place'))).toBe(true)
    expect(messages.some(message => message.includes('10.0,99'))).toBe(false)
  })

  it('cancels during the approach instead of waiting for the landing branch', async () => {
    // The goal is inside the approach radius on the first poll, so a cancel
    // here exercises the exact case the old `!landing` guard blocked (CD-E0).
    const goal = { x: 40, y: 64, z: 0 }
    const port = new ElytraFakePort({ goal })
    let flyingPolls = 0
    const stopAfterApproach = () => {
      if (port.fallFlying)
        flyingPolls++
      return flyingPolls > 2
    }
    const result = await runElytraMove({ port, goal, deps: FAST, shouldStop: stopAfterApproach })
    expect(result.status).toBe('cancelled')
    expect(port.onGround).toBe(true)
  })

  it('stays unknown when the glide state is never observed', async () => {
    const goal = { x: 40, y: 64, z: 0 }
    const port = new ElytraFakePort({ goal })
    // After deploy, `fallFlying` is not reported at all; the loop must end and
    // the touch-down classifier must return unknown, never a landing.
    const readState = port.getState.bind(port)
    let reads = 0
    port.getState = async () => {
      reads++
      const state = await readState()
      if (reads > 4)
        return { ...state, fallFlying: undefined, onGround: false }
      return state
    }
    const result = await runElytraMove({ port, goal, deps: FAST })
    expect(result.status).toBe('unknown')
    expect(result.failure).toBe('touchdown_unverified')
  })

  it('reports water as its own outcome instead of a normal landing', async () => {
    const goal = { x: 0, y: 64, z: 0 }
    const port = new ElytraFakePort({ goal })
    // Land the fake on water: the mover re-reads the final state.
    const readState = port.getState.bind(port)
    port.getState = async () => {
      const state = await readState()
      if (!state.fallFlying && state.onGround)
        return { ...state, inWater: true }
      return state
    }
    const result = await runElytraMove({ port, goal, deps: FAST })
    expect(result.failure).toBe('landing_in_water')
  })

  it('picks a nearby landing target instead of the goal when cancelled', async () => {
    const goal = { x: 200, y: 64, z: 0 }
    const port = new ElytraFakePort({ goal })
    const messages: string[] = []
    const result = await runElytraMove({
      port,
      goal,
      deps: FAST,
      shouldStop: () => port.fallFlying,
      debug: message => messages.push(message),
    })
    expect(result.status).toBe('cancelled')
    const target = messages.find(message => message.startsWith('elytra landing target'))!
    expect(target).toBeDefined()
    expect(target).not.toContain('200.0')
  })

  it('releases the input when a state read fails in flight', async () => {
    const goal = { x: 200, y: 64, z: 0 }
    const port = new ElytraFakePort({ goal })
    const readState = port.getState.bind(port)
    let reads = 0
    port.getState = async () => {
      reads++
      if (reads > 4)
        throw new Error('bridge lost')
      return readState()
    }
    let stops = 0
    const release = port.stopMovement.bind(port)
    port.stopMovement = async () => {
      stops++
      await release()
    }
    await expect(runElytraMove({ port, goal, deps: FAST })).rejects.toThrow('bridge lost')
    expect(stops).toBeGreaterThanOrEqual(1)
    expect(port.inputs).toEqual({})
  })

  it('lands early when the elytra wears down in flight', async () => {
    const goal = { x: 1000, y: 64, z: 0 }
    const port = new ElytraFakePort({
      goal,
      inventory: [
        { slot: 4, id: 'minecraft:firework_rocket', count: 64, hotbar: true },
        { slot: 12, id: 'minecraft:elytra', count: 1, hotbar: false, damage: 10, maxDamage: 100 },
      ],
      durabilityPerPoll: 1,
    })
    const messages: string[] = []
    let clock = 0
    const result = await runElytraMove({
      port,
      goal,
      deps: { now: () => clock, sleep: async () => { clock += 50 } },
      debug: message => messages.push(message),
    })
    expect(messages.some(message => message.includes('worn in flight'))).toBe(true)
    expect(messages.some(message => message.includes(':safety'))).toBe(true)
    expect(result.status).toBe('reached')
  })

  it('does not go around when no verified site exists', async () => {
    // R4 approach-diag-03: an unverified aim plus a go-around ended in a death.
    // Without a site the mover descends with the bounded safety landing. A
    // deterministic clock lets the safety deadline pass without real waiting.
    const goal = { x: 40, y: 96, z: 0 }
    const clock = { value: 1_000_000 }
    const port = new ElytraFakePort({
      goal,
      path: [
        { x: 5, y: 100, z: 0 },
        { x: 20, y: 100, z: 0 },
        { x: 35, y: 100, z: 0 },
        { x: 45, y: 100, z: 0 },
        { x: 55, y: 100, z: 0 },
      ],
    })
    const messages: string[] = []
    const result = await runElytraMove({
      port,
      goal,
      deps: {
        sleep: async () => {
          clock.value += 50
        },
        now: () => clock.value,
      },
      debug: message => messages.push(message),
    })
    expect(messages.filter(message => message.includes('go-around'))).toHaveLength(0)
    expect(result.status).toBeTruthy()
  })

  it('does not count a landing on the roof over the goal as arrival', async () => {
    // ROOT CAUSE (E-02 canyon, 2026-09-18): the goal platform sits in a roofed
    // cave at y=65; the mover reported `reached` three times while standing on
    // the glass at y=87 because arrival only measured the horizontal gap.
    const goal = { x: 100, y: 65, z: 0 }
    const port = new ElytraFakePort({
      goal,
      speed: 0.1,
      landImmediately: true,
      landAt: { x: 100, y: 87, z: 0 },
      blocks: [
        { x: 100, y: 86, z: 0, id: 'minecraft:glass' },
        { x: 100, y: 64, z: 0, id: 'minecraft:sea_lantern' },
      ],
    })
    const result = await runElytraMove({ port, goal, deps: FAST })
    expect(result.status).toBe('stuck')
    expect(result.failure).toBe('goal_under_roof')
    expect(result.detail).toContain('roof')
  })

  // This receipt test runs real terrain searches, as the channel tests below do.
  it('types the long-route participation into the flight result', { timeout: 60_000 }, async () => {
    // E-02 venue gap 2: refusals used to exist only in debug logs; the receipt
    // now carries whether the layer ever planned, how often, and why not.
    const goal = { x: 200, y: 64, z: 0 }
    const ground: SnapshotEntry[] = []
    for (let x = 0; x <= 210; x++) {
      for (let z = -4; z <= 4; z++)
        ground.push({ x, y: 60, z, id: 'minecraft:stone' })
    }
    const port = new ElytraFakePort({ goal, speed: 0.1, blocks: ground })
    const result = await runElytraMove({
      port,
      goal,
      flightPlanner: { enabled: true, profile: FLIGHT_PROFILE_1_21_1, calibrated: false, rolloutOn: true },
      deps: FAST,
    })
    expect(result.lowRoute).toBeDefined()
    if (result.lowRoute) {
      expect(result.lowRoute.replans).toBeGreaterThanOrEqual(0)
      expect(result.lowRoute.refusals).toBeGreaterThanOrEqual(0)
      // Either the layer planned at least once over open ground, or it refused
      // with a typed reason that the receipt names.
      if (result.lowRoute.refusals > 0)
        expect(result.lowRoute.lastRefusal).toBeDefined()
      else
        expect(result.lowRoute.used).toBe(true)
    }
  })

  it('omits the long-route field when the flight planner switch is off', async () => {
    const goal = { x: 200, y: 64, z: 0 }
    const port = new ElytraFakePort({ goal, speed: 0.1 })
    const result = await runElytraMove({ port, goal, deps: FAST })
    expect(result.status).toBe('reached')
    expect(result.lowRoute).toBeUndefined()
  })
})

describe('evaluateApproachEntry', () => {
  const goal = { x: 0, y: 64, z: 60 }

  it('names each missing approach condition', () => {
    expect(evaluateApproachEntry({
      position: { x: 0, y: 70, z: 0 },
      yaw: 0,
      horizontalSpeed: 0.8,
      goal: { x: 0, y: 64, z: 200 },
      aim: { x: 0, y: 64, z: 200 },
    })).toEqual({ enter: false, reason: 'too-far' })
    expect(evaluateApproachEntry({
      position: { x: 0, y: 90, z: 0 },
      yaw: 0,
      horizontalSpeed: 0.8,
      goal,
      aim: goal,
      roofY: 80,
    })).toEqual({ enter: false, reason: 'above-roof' })
    expect(evaluateApproachEntry({
      position: { x: 0, y: 70, z: 0 },
      yaw: 180,
      horizontalSpeed: 0.8,
      goal,
      aim: goal,
    })).toEqual({ enter: false, reason: 'not-aligned' })
    expect(evaluateApproachEntry({
      position: { x: 0, y: 70, z: 0 },
      yaw: 0,
      horizontalSpeed: 1.4,
      goal,
      aim: goal,
    })).toEqual({ enter: false, reason: 'too-fast' })
    expect(evaluateApproachEntry({
      position: { x: 0, y: 66, z: 0 },
      yaw: 0,
      horizontalSpeed: 0.8,
      goal,
      aim: goal,
    })).toEqual({ enter: false, reason: 'cannot-reach' })
  })

  it('enters when aligned, under the roof and able to glide', () => {
    expect(evaluateApproachEntry({
      position: { x: 0, y: 70, z: 0 },
      yaw: 0,
      horizontalSpeed: 0.8,
      goal,
      aim: goal,
      roofY: 75,
    })).toEqual({ enter: true })
  })

  it('lets the short final bypass alignment and speed', () => {
    expect(evaluateApproachEntry({
      position: { x: 0, y: 66, z: 40 },
      yaw: 180,
      horizontalSpeed: 1.5,
      goal,
      aim: goal,
    })).toEqual({ enter: true })
  })
})

interface ChannelStep {
  phase: 'accepted' | 'applying' | 'ended'
  endReason?: string
  sample?: Vec3
  /** Land the client at the goal before the reply (a finished client flight). */
  land?: boolean
  /** Land at a specific position instead of the goal. */
  landAt?: Vec3
  /** Generate a moving sample on a circle (loitering) instead of a fixed one. */
  circle?: { cx: number, y: number, cz: number, radius: number }
  /** The client finished its path and holds, waiting for the next leg. */
  holding?: boolean
  /** Adopt the pending handover route on this step (session id switches). */
  adopt?: boolean
}

/**
 * Channel-capable fake (R3): hosts the client side of the exchange. The host
 * plans the route, submits it, and reads the scripted steps below.
 */
class ChannelFakePort extends ElytraFakePort {
  submitted: FlightChannelSubmitRequest[] = []
  revoked: string[] = []
  /** Advertise the handover protocol (R4 review item 3). */
  handoverCapable = false
  private readonly channelSteps: ChannelStep[]
  private channelStep = 0
  private readonly channelGoal: Vec3
  private sessionId = 'fake-1'
  private pendingSessionId: string | undefined
  private handoverCount = 0

  constructor(options: FakeOptions & { channelSteps: ChannelStep[] }) {
    super(options)
    this.channelSteps = options.channelSteps
    this.channelGoal = options.goal
  }

  flightSubmit = async (request: FlightChannelSubmitRequest): Promise<FlightChannelSubmitReceipt> => {
    this.submitted.push(request)
    // A capable client accepts a route while one is active as a pending
    // handover instead of refusing with `session_active`.
    if (this.handoverCapable)
      this.pendingSessionId = request.sessionId
    return {
      accepted: true,
      pathPoints: request.channel.path.length,
      ...(request.channel.entryReach !== undefined ? { entryReach: request.channel.entryReach } : {}),
    }
  }

  flightStatus = async (_sinceTick?: number): Promise<FlightChannelStatus> => {
    const step = this.channelSteps[Math.min(this.channelStep, this.channelSteps.length - 1)]!
    this.channelStep += 1
    // The fake client flies while the channel runs; only a `land`/`landAt`
    // step puts it on the ground, matching the host's own state observer.
    if (step.land || step.landAt) {
      this.position = step.landAt ? { ...step.landAt } : { ...this.channelGoal }
      this.fallFlying = false
      this.onGround = true
    }
    else {
      this.fallFlying = true
      this.onGround = false
    }
    if (step.adopt && this.pendingSessionId) {
      this.sessionId = this.pendingSessionId
      this.pendingSessionId = undefined
      this.handoverCount += 1
    }
    const sample = step.circle
      ? {
          x: step.circle.cx + Math.cos(this.channelStep * 0.5) * step.circle.radius,
          y: step.circle.y,
          z: step.circle.cz + Math.sin(this.channelStep * 0.5) * step.circle.radius,
        }
      : step.sample ?? { ...this.position }
    return {
      state: step.phase === 'ended' ? 'terminated' : step.phase === 'applying' ? 'running' : 'accepted',
      ...(step.endReason ? { endReason: step.endReason } : {}),
      applyingStarted: step.phase !== 'accepted',
      sessionId: this.sessionId,
      ...(this.handoverCapable ? { handoverCapable: true } : {}),
      ...(this.pendingSessionId ? { pendingSessionId: this.pendingSessionId } : {}),
      ...(this.handoverCount > 0 ? { handoverCount: this.handoverCount } : {}),
      ...(step.holding ? { holding: true } : {}),
      trajectory: [{
        tick: this.channelStep,
        x: sample.x,
        y: sample.y,
        z: sample.z,
        vx: 0,
        vy: 0,
        vz: 0,
        yaw: 0,
        pitch: 0,
        gliding: true,
        onGround: false,
        boostAttached: false,
        rocketFiredThisTick: false,
        inputOwner: 'flight-session',
      }],
    }
  }

  flightRevoke = async (sessionId: string): Promise<FlightChannelRevokeReceipt> => {
    this.revoked.push(sessionId)
    return { revoked: true, wasActive: true }
  }

  /**
   * A `circle` step keeps the fake airborne on the circle: the base fake would
   * otherwise fly itself to the goal and land, which is not a loiter.
   */
  async getState(): Promise<MovementState> {
    const step = this.channelSteps[Math.min(this.channelStep, this.channelSteps.length - 1)]
    if (step?.circle) {
      return {
        position: {
          x: step.circle.cx + Math.cos(this.channelStep * 0.5) * step.circle.radius,
          y: step.circle.y,
          z: step.circle.cz + Math.sin(this.channelStep * 0.5) * step.circle.radius,
        },
        yaw: 0,
        inWater: false,
        onGround: false,
        motion: { x: 0.5, y: 0, z: 0.5 },
        fallFlying: true,
        health: 20,
      }
    }
    return await super.getState()
  }
}

// Each case plans one or more real routes through `planLowRoute`, whose space
// search is CPU-bound; the default 5 s test budget is too small when the live
// test stack shares the machine.
describe('runElytraMove channel mode (R3)', { timeout: 60_000 }, () => {
  const goal = { x: 200, y: 64, z: 0 }
  const ground: SnapshotEntry[] = []
  for (let x = 0; x <= 210; x++) {
    for (let z = -20; z <= 20; z++)
      ground.push({ x, y: 60, z, id: 'minecraft:stone' })
  }
  const chest: EquipmentView = { id: 'minecraft:elytra', damage: 0, maxDamage: 432 }
  // A deterministic clock that only advances on `sleep`: real planning time
  // must not advance the stall window or the deadlines inside a test, while
  // the bounded landing walk still has a deadline to hit.
  const clock = { value: 1_000_000 }
  const channelClock = {
    sleep: async (ms: number) => {
      // Advance by the requested delay so stall and landing deadlines represent
      // the same number of polls as production, without waiting in real time.
      clock.value += ms
    },
    now: () => clock.value,
  }
  const channelOptions = {
    flightPlanner: { enabled: true, profile: FLIGHT_PROFILE_1_21_1, calibrated: false, rolloutOn: true },
    world: { worldId: 'world-1', dimension: 'minecraft:overworld', mapVersion: 'map-1' },
    deps: channelClock,
  }

  it('submits the planned route and completes without host control writes', async () => {
    const port = new ChannelFakePort({
      goal,
      speed: 0.1,
      blocks: ground,
      chest,
      channelSteps: [
        { phase: 'accepted', sample: { x: 0, y: 100, z: 0 } },
        { phase: 'applying', sample: { x: 8, y: 90, z: 0 } },
        { phase: 'applying', sample: { x: 16, y: 85, z: 0 } },
        { phase: 'ended', endReason: 'channel_complete', land: true },
      ],
    })
    const result = await runElytraMove({ port, goal, ...channelOptions })

    expect(port.submitted).toHaveLength(1)
    expect(port.submitted[0]?.channel.path.length).toBeGreaterThanOrEqual(2)
    expect(port.submitted[0]?.channel.entryReach).toBe(8)
    expect(result.channel?.submissions).toBe(1)
    expect(result.channel?.endReason).toBe('channel_complete')
    expect(result.status).toBe('reached')
    // Single writer (design §7): the host wrote no look or useItem in channel mode.
    expect(port.lookPitches).toEqual([])
    expect(port.fireworkUses).toBe(0)
    expect(port.revoked).toEqual([])
  })

  it('refuses the flight when no verified route can be planned', async () => {
    const port = new ChannelFakePort({
      goal,
      speed: 0.1,
      blocks: ground,
      chest,
      channelSteps: [{ phase: 'applying' }],
    })
    // An unreadable world is `read_failed`, not an empty one: the mover must
    // refuse instead of flying the direct line (R3 design §3.3).
    port.getBlocksRegion = async () => {
      throw new Error('bridge read failed')
    }
    const result = await runElytraMove({ port, goal, ...channelOptions })

    expect(result.status).toBe('unavailable')
    expect(result.failure).toBe('route_unavailable')
    expect(port.submitted).toEqual([])
    expect(port.lookPitches).toEqual([])
  })

  it('revokes, excludes the failure point and resubmits after a client rejection', async () => {
    const port = new ChannelFakePort({
      goal,
      speed: 0.1,
      blocks: ground,
      chest,
      channelSteps: [
        { phase: 'applying', sample: { x: 20, y: 85, z: 0 } },
        { phase: 'ended', endReason: 'no_viable_trajectory', sample: { x: 20, y: 85, z: 0 } },
        { phase: 'applying', sample: { x: 40, y: 80, z: 0 } },
        { phase: 'ended', endReason: 'channel_complete', land: true },
      ],
    })
    const trail: string[] = []
    const result = await runElytraMove({ port, goal, ...channelOptions, debug: message => trail.push(message) })

    expect(port.submitted).toHaveLength(2)
    expect(port.submitted[1]?.revision).toBe(2)
    expect(port.submitted[1]?.sessionId).not.toBe(port.submitted[0]?.sessionId)
    const replannedFrom = port.submitted[1]?.channel.path[0]
    expect(replannedFrom).toBeDefined()
    if (replannedFrom)
      expect(Math.hypot(replannedFrom.x - 20, replannedFrom.z - 0)).toBeLessThan(40)
    // The rejection itself forces one re-plan; the synthetic completion may add
    // a local-frontier attempt, so the receipt counts attempts, not successes.
    expect(result.channel?.replans, trail.join(' | ')).toBeGreaterThanOrEqual(1)
    expect(result.status).toBe('reached')
  })

  it('continues a local frontier route instead of landing at the frontier', async () => {
    // The goal chunk is never read, so R1 returns a local route to the covered
    // frontier. A frontier completion is not arrival: the host must re-plan
    // from the reached position and resubmit while the budget allows (R3 live
    // 2026-09-20: the client completed 85 blocks out and the host landed there).
    const port = new ChannelFakePort({
      goal,
      speed: 0.1,
      blocks: ground,
      chest,
      channelSteps: [
        { phase: 'ended', endReason: 'channel_complete', sample: { x: 36, y: 70, z: 0 } },
        { phase: 'ended', endReason: 'channel_complete', sample: { x: 36, y: 70, z: 0 } },
        { phase: 'ended', endReason: 'channel_complete', sample: { x: 36, y: 70, z: 0 } },
        { phase: 'ended', endReason: 'channel_complete', land: true },
      ],
    })
    const base = port.getBlocksRegion.bind(port)
    port.getBlocksRegion = async (from, to) => (await base(from, to)).filter(entry => entry.x <= 40)

    const result = await runElytraMove({ port, goal, ...channelOptions })

    expect(port.submitted).toHaveLength(4)
    // Frontier continuations are normal progress and have their own counter;
    // they must not consume the failure replan budget (R4 review item 2).
    expect(result.channel?.continuations).toBe(3)
    expect(result.channel?.replans).toBe(0)
    const firstTerminal = port.submitted[0]?.channel.path.at(-1)
    expect(firstTerminal?.x).toBeLessThan(100)
  })

  it('hands the next leg over early to a capable client', async () => {
    // R4 review items 2-3: the next leg is planned while the current one flies
    // and submitted as a pending handover; the client adopts it at a tick
    // boundary, so no unowned glide exists between legs.
    const port = new ChannelFakePort({
      goal,
      speed: 0.1,
      blocks: ground,
      chest,
      channelSteps: [
        { phase: 'applying', sample: { x: 10, y: 70, z: 0 } },
        { phase: 'applying', sample: { x: 20, y: 70, z: 0 } },
        { phase: 'applying', sample: { x: 30, y: 70, z: 0 }, adopt: true },
        { phase: 'applying', sample: { x: 40, y: 70, z: 0 } },
        { phase: 'ended', endReason: 'channel_complete', land: true },
      ],
    })
    port.handoverCapable = true
    const base = port.getBlocksRegion.bind(port)
    port.getBlocksRegion = async (from, to) => (await base(from, to)).filter(entry => entry.x <= 40)

    const trail: string[] = []
    const result = await runElytraMove({ port, goal, ...channelOptions, debug: message => trail.push(message) })

    expect(result.status).toBe('reached')
    const legs = result.channel?.legs ?? []
    expect(legs.length).toBeGreaterThanOrEqual(2)
    // The first leg was superseded by the adopted handover, not completed.
    expect(legs[0]?.endedReason).toBe('handover')
    expect(legs[1]?.kind).toBe('frontier')
    expect(result.channel?.continuations).toBeGreaterThanOrEqual(1)
    expect(trail.some(message => message.includes('submitting early'))).toBe(true)
    expect(trail.some(message => message.includes('handover adopted by the client'))).toBe(true)
  })

  it('continues the flight when the client holds after its path', async () => {
    // R4 review item 4: a capable client does not release input at the path
    // end; it holds and the host submits the next leg into that hold.
    const port = new ChannelFakePort({
      goal,
      speed: 0.1,
      blocks: ground,
      chest,
      channelSteps: [
        { phase: 'applying', sample: { x: 0, y: 70, z: 0 }, holding: true },
        { phase: 'applying', sample: { x: 2, y: 70, z: 0 }, adopt: true },
        { phase: 'applying', sample: { x: 30, y: 70, z: 0 } },
        { phase: 'ended', endReason: 'channel_complete', land: true },
      ],
    })
    port.handoverCapable = true
    const base = port.getBlocksRegion.bind(port)
    port.getBlocksRegion = async (from, to) => (await base(from, to)).filter(entry => entry.x <= 40)

    const trail: string[] = []
    const result = await runElytraMove({ port, goal, ...channelOptions, debug: message => trail.push(message) })

    expect(result.status).toBe('reached')
    expect(trail.some(message => message.includes('client holds after the path'))).toBe(true)
    expect(result.channel?.continuations).toBeGreaterThanOrEqual(1)
  })

  it('lands through the safety ending when a held handover never arrives', async () => {
    // The client holds; the host cannot plan the next leg; the client's
    // bounded hold ends with `handover_timeout` and the host must land instead
    // of returning route_unavailable while airborne (R4 review item 5).
    const port = new ChannelFakePort({
      goal,
      speed: 0.1,
      blocks: ground,
      chest,
      channelSteps: [
        { phase: 'applying', sample: { x: 20, y: 85, z: 0 }, holding: true },
        { phase: 'ended', endReason: 'handover_timeout', sample: { x: 20, y: 84, z: 0 } },
        { phase: 'ended', endReason: 'handover_timeout', landAt: { x: 22, y: 70, z: 0 } },
      ],
    })
    port.handoverCapable = true
    // The next leg cannot be planned: the read fails once the flight is live
    // (the initial plan and the roof probe need the readable world).
    const base = port.getBlocksRegion.bind(port)
    port.getBlocksRegion = async (from, to) => {
      if (port.submitted.length > 0)
        throw new Error('bridge read failed during the hold')
      return await base(from, to)
    }

    const trail: string[] = []
    const result = await runElytraMove({ port, goal, ...channelOptions, debug: message => trail.push(message) })

    expect(result.channel?.failure, trail.join(' | ')).toBe('handover_timeout')
    expect(result.status).not.toBe('unavailable')
    expect(result.failure).not.toBe('route_unavailable')
  })

  it('flies the final approach through the client channel when a site is near the goal', async () => {
    const port = new ChannelFakePort({
      goal,
      speed: 0.1,
      blocks: ground,
      chest,
      channelSteps: [
        { phase: 'applying', sample: { x: 180, y: 70, z: 0 } },
        // The completion that triggers the final approach lands far from the
        // goal: landing at the goal itself would make the profile a single
        // hop and the test would no longer exercise the descent builder.
        { phase: 'ended', endReason: 'channel_complete', landAt: { x: 200, y: 70, z: -40 } },
        { phase: 'ended', endReason: 'channel_complete', landAt: { x: 200, y: 70, z: -40 } },
        { phase: 'ended', endReason: 'channel_complete', land: true },
      ],
    })
    const result = await runElytraMove({ port, goal, ...channelOptions })

    expect(port.submitted.length).toBeGreaterThanOrEqual(2)
    // The last leg is a descending profile of several waypoints, not a direct
    // two-point hop the client cannot descend inside one entry reach.
    const approach = port.submitted.find(entry => entry.channel.entryReach === 4)
    expect(approach?.channel.path.length, JSON.stringify(port.submitted.map(entry => ({ reach: entry.channel.entryReach, path: entry.channel.path })))).toBeGreaterThanOrEqual(3)
    expect(result.channel?.submissions).toBeGreaterThanOrEqual(2)
    expect(result.status).toBe('reached')
  })

  it('falls back to the host landing when the client refuses the final approach', async () => {
    const port = new ChannelFakePort({
      goal,
      speed: 0.1,
      blocks: ground,
      chest,
      channelSteps: [
        { phase: 'applying', sample: { x: 180, y: 70, z: 0 } },
        // The approach-triggering completion lands far from the goal, so the
        // refusal happens against the real descent profile.
        { phase: 'ended', endReason: 'channel_complete', landAt: { x: 200, y: 70, z: -40 } },
        { phase: 'ended', endReason: 'channel_complete', landAt: { x: 200, y: 70, z: -40 } },
        { phase: 'ended', endReason: 'no_viable_trajectory', sample: { x: 196, y: 66, z: -20 } },
        { phase: 'ended', endReason: 'no_viable_trajectory', sample: { x: 196, y: 66, z: -20 } },
        { phase: 'ended', endReason: 'channel_complete', land: true },
      ],
    })
    const result = await runElytraMove({ port, goal, ...channelOptions })

    expect(port.submitted.length).toBeGreaterThanOrEqual(3)
    const approaches = port.submitted.filter(entry => entry.channel.entryReach === 4)
    expect(approaches).toHaveLength(2)
    // The retry is the direct two-point leg.
    expect(approaches[1]!.channel.path).toHaveLength(2)
    expect(result.channel?.endReason).toBe('no_viable_trajectory')
    expect(result.status).toBeTruthy()
  })

  it('stops replanning after the same spot is rejected twice', async () => {
    // R4 cave-diag-03: the same waypoint was rejected three times and the
    // host burned the whole budget plus two minutes. The second rejection at
    // the same spot ends with the bounded host landing.
    const port = new ChannelFakePort({
      goal,
      speed: 0.1,
      blocks: ground,
      chest,
      channelSteps: [
        { phase: 'applying', sample: { x: 20, y: 85, z: 0 } },
        { phase: 'ended', endReason: 'no_viable_trajectory', sample: { x: 20, y: 85, z: 0 } },
        { phase: 'applying', sample: { x: 20, y: 85, z: 0 } },
        { phase: 'ended', endReason: 'no_viable_trajectory', sample: { x: 20, y: 85, z: 0 } },
      ],
    })
    const result = await runElytraMove({ port, goal, ...channelOptions })

    expect(port.submitted).toHaveLength(2)
    expect(result.channel?.endReason).toBe('no_viable_trajectory')
    expect(result.status).toBeTruthy()
  })

  it('detects loitering and replans when movement never reduces the goal distance', async () => {
    // R4 cave-diag-04: the client circled a two-block radius for 165 s and the
    // movement stall never fired because every sample "moved". Progress is the
    // goal distance decreasing, not raw movement.
    const port = new ChannelFakePort({
      goal,
      speed: 0.1,
      blocks: ground,
      chest,
      channelSteps: [
        { phase: 'applying', circle: { cx: 20, y: 85, cz: 0, radius: 2 } },
      ],
    })
    const trail: string[] = []
    const result = await runElytraMove({ port, goal, ...channelOptions, debug: message => trail.push(message) })

    expect(port.submitted.length, trail.join(' | ')).toBeGreaterThanOrEqual(2)
    expect(trail.some(message => message.includes('loitering'))).toBe(true)
    expect(result.status).toBeTruthy()
  })

  it('revokes on cancellation and lands as a cancelled flight', async () => {
    const port = new ChannelFakePort({
      goal,
      speed: 0.1,
      blocks: ground,
      chest,
      channelSteps: [
        { phase: 'applying', sample: { x: 30, y: 90, z: 0 } },
        { phase: 'applying', sample: { x: 60, y: 85, z: 0 } },
      ],
    })
    const result = await runElytraMove({ port, goal, ...channelOptions, shouldStop: () => true })

    expect(port.revoked).toHaveLength(1)
    expect(result.status).toBe('cancelled')
    expect(result.channel?.endReason).toBe('host_cancelled')
  })

  it('ends as an unverified stop when input ownership moves away', async () => {
    const port = new ChannelFakePort({
      goal,
      speed: 0.1,
      blocks: ground,
      chest,
      channelSteps: [
        { phase: 'applying', sample: { x: 30, y: 90, z: 0 } },
        { phase: 'applying', sample: { x: 60, y: 85, z: 0 } },
      ],
    })
    const result = await runElytraMove({ port, goal, ...channelOptions, stillOwnsControl: () => false })

    expect(port.revoked).toHaveLength(1)
    expect(result.status).toBe('unknown')
    expect(result.failure).toBe('unverified_stop')
  })
})
