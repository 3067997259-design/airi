import type { BlockFace, BlockView, EquipmentView, InventorySlot, MovementControlPort, MovementInput, MovementState, RidingInfo } from './port'
import type { SnapshotEntry } from './snapshot'
import type { Vec3 } from './types'

import { describe, expect, it } from 'vitest'

import { runElytraMove } from './elytra'
import { runVehicleMove } from './vehicle'

const FAST = { sleep: async () => {}, now: () => Date.now() }
const CHEST_SLOT = 37

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
      motion: { x: speed, y: 0, z: 0 },
      fallFlying: this.fallFlying,
      health: 20,
    }
  }

  async getBlocksRegion(from: Vec3, to: Vec3): Promise<SnapshotEntry[]> {
    const entries: SnapshotEntry[] = []
    const inBounds = (block: SnapshotEntry) =>
      block.x >= Math.floor(from.x) && block.x <= Math.floor(to.x)
      && block.y >= Math.floor(from.y) && block.y <= Math.floor(to.y)
      && block.z >= Math.floor(from.z) && block.z <= Math.floor(to.z)
    const wall = this.options.wall
    if (wall) {
      for (let x = Math.floor(from.x); x <= Math.floor(to.x); x++) {
        for (let z = Math.floor(from.z); z <= Math.floor(to.z); z++) {
          if (x >= wall.x && x <= wall.x + 2 && from.y <= wall.top)
            entries.push({ x, y: from.y, z, id: 'minecraft:stone' })
        }
      }
    }
    for (const block of this.options.blocks ?? []) {
      if (inBounds(block) && !entries.some(entry => entry.x === block.x && entry.y === block.y && entry.z === block.z))
        entries.push(block)
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
    if (slotB === CHEST_SLOT) {
      const item = this.inventory.find(slot => slot.slot === slotA)
      if (item) {
        this.chest = {
          id: item.id,
          ...(item.damage !== undefined ? { damage: item.damage } : {}),
          ...(item.maxDamage !== undefined ? { maxDamage: item.maxDamage } : {}),
        }
      }
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
    expect(port.swaps).toContainEqual([12, CHEST_SLOT])
    expect(port.selectedSlots).toContain(4)
    expect(port.fireworkUses).toBeGreaterThanOrEqual(1)
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
    expect(port.fallFlying).toBe(false)
    expect(messages.some(message => message.includes(':timeout'))).toBe(true)
    expect(result.status).toBe('reached')
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

  it('picks a nearby landing target instead of the goal when rockets run low', async () => {
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
    expect(target).toContain('(unverified)')
    expect(target).not.toContain('200.0')
  })

  it('scans ahead for a grounded landing spot when landing early', async () => {
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
    expect(messages.some(message => message.includes('elytra landing target 10.5,99,0.5'))).toBe(true)
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

  it('allows one go-around, then lands nearby instead of looping', async () => {
    const goal = { x: 40, y: 96, z: 0 }
    const port = new ElytraFakePort({
      goal,
      path: [
        { x: 5, y: 100, z: 0 },
        { x: 15, y: 100, z: 0 },
        { x: 25, y: 100, z: 0 },
        { x: 38, y: 100, z: 0 },
        { x: 45, y: 100, z: 0 },
        { x: 55, y: 100, z: 0 },
        { x: 60, y: 100, z: 0 },
        { x: 45, y: 100, z: 0 },
        { x: 35, y: 100, z: 0 },
        { x: 25, y: 100, z: 0 },
        { x: 15, y: 100, z: 0 },
        { x: 10, y: 100, z: 0 },
      ],
    })
    const messages: string[] = []
    const result = await runElytraMove({ port, goal, deps: FAST, debug: message => messages.push(message) })
    expect(messages.filter(message => message.includes('go-around'))).toHaveLength(1)
    expect(result.status).toBe('stuck')
  })
})
