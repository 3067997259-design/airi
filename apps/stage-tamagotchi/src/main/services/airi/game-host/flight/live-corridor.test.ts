import type { MovementControlPort, MovementState } from '../movement/port'
import type { SnapshotEntry } from '../movement/snapshot'
import type { Vec3 } from '../movement/types'

import { describe, expect, it } from 'vitest'

import { corridorReachesGoal, createLiveCorridorPort, LIVE_CORRIDOR_DOWN, LIVE_CORRIDOR_RADIUS, LIVE_CORRIDOR_REPLAN_MS, LIVE_CORRIDOR_UP, planLiveCorridor } from './live-corridor'
import { FLIGHT_PROFILE_1_21_1 } from './profile'

const planner = { enabled: true, profile: FLIGHT_PROFILE_1_21_1, calibrated: false, rolloutOn: true }

/** Floor level of the scripted world; everything above it is air. */
const FLOOR_Y = 80

interface ScriptedWorld {
  /** Solid columns, keyed `x,z`, spanning {@link FLOOR_Y} down to bedrock. */
  walls?: (x: number, z: number) => boolean
  /** Cells the read refuses to report, keyed `x,y,z`. */
  omit?: (x: number, y: number, z: number) => boolean
  /** Hard read failure instead of a partial answer. */
  fail?: boolean
}

/**
 * One scripted region read.
 *
 * The world is a floor at {@link FLOOR_Y} with open air above it, so every cell
 * in the corridor band is free unless a wall or an omission says otherwise.
 */
function scriptedPort(world: ScriptedWorld = {}) {
  const reads: Array<{ min: Vec3, max: Vec3 }> = []
  const port: MovementControlPort = {
    async getState(): Promise<MovementState> {
      throw new Error('unexpected in this test')
    },
    async getBlocksRegion(from: Vec3, to: Vec3): Promise<SnapshotEntry[]> {
      reads.push({ min: { ...from }, max: { ...to } })
      if (world.fail)
        throw new Error('bridge unavailable')
      const entries: SnapshotEntry[] = []
      for (let x = from.x; x <= to.x; x++) {
        for (let y = from.y; y <= to.y; y++) {
          for (let z = from.z; z <= to.z; z++) {
            if (world.omit?.(x, y, z))
              continue
            const solid = y <= FLOOR_Y || world.walls?.(x, z) === true
            entries.push({ x, y, z, id: solid ? 'minecraft:stone' : 'minecraft:air' })
          }
        }
      }
      return entries
    },
  } as MovementControlPort
  return { port, reads, lastBounds: () => reads.at(-1) }
}

const options = {
  planner,
  dimension: 'minecraft:overworld',
  worldId: 'world',
  mapVersion: 'live',
}

describe('planLiveCorridor', () => {
  it('reads a window aligned to the coarse lattice', async () => {
    const { port, lastBounds } = scriptedPort()
    // A position inside a cell must not shift the lattice: an off-lattice window
    // would leave the planner's edge cells unscanned while looking covered.
    await planLiveCorridor({ port, ...options }, { x: 1.5, y: 82.3, z: -0.5 }, { x: 20, y: 82, z: 0 })
    expect(lastBounds()?.min).toEqual({ x: -32, y: 76, z: -36 })
    expect(lastBounds()?.max).toEqual({ x: 32, y: 84, z: 28 })
  })

  it('keeps the read inside the bridge cell cap', () => {
    // ROOT CAUSE (live, 2026-09-18): the window was 65 x 33 x 65 = 139425 cells,
    // the bridge silently truncates at 32768, and the corridor refused every poll
    // with `start_unknown` — the layer was dead and nobody noticed because the
    // refusal is a typed status, not an error. A bigger window is not a better
    // window until the read is chunked.
    const volume = (2 * LIVE_CORRIDOR_RADIUS + 1) * (LIVE_CORRIDOR_UP + LIVE_CORRIDOR_DOWN + 1) * (2 * LIVE_CORRIDOR_RADIUS + 1)
    expect(volume).toBeLessThanOrEqual(32768)
  })

  it('routes to a reachable goal', async () => {
    const { port } = scriptedPort()
    const plan = await planLiveCorridor({ port, ...options }, { x: 0, y: 82, z: 0 }, { x: 28, y: 82, z: 0 })
    expect(plan.status).toBe('planned')
    expect(plan.aim).toBeDefined()
    expect(plan.corridor && corridorReachesGoal(plan.corridor, { x: 28, y: 82, z: 0 })).toBe(true)
  })

  it('routes around a wall through the gap it leaves open', async () => {
    // A wall over x 8..12 with a gap at z > 20. The straight line is blocked, so
    // the only planned route has to detour and the aim must leave the straight
    // line toward the gap.
    const { port } = scriptedPort({ walls: (x, z) => x >= 8 && x <= 12 && z <= 20 })
    const plan = await planLiveCorridor({ port, ...options }, { x: 0, y: 82, z: 0 }, { x: 28, y: 82, z: 0 })
    expect(plan.status).toBe('planned')
    expect(plan.corridor && corridorReachesGoal(plan.corridor, { x: 28, y: 82, z: 0 })).toBe(true)
    expect(plan.aim?.z).toBeGreaterThan(4)
  })

  it('refuses when a wall seals the window instead of aiming through it', async () => {
    // A wall across the whole read, from bedrock past the top of the band: no
    // horizontal or vertical route exists inside the window.
    const { port } = scriptedPort({ walls: x => x >= 8 && x <= 12 })
    const plan = await planLiveCorridor({ port, ...options }, { x: 0, y: 82, z: 0 }, { x: 28, y: 82, z: 0 })
    expect(plan.status).toBe('no_route')
    expect(plan.refusal).toBe('no_corridor')
    expect(plan.aim).toBeUndefined()
  })

  it('routes toward a goal outside the window instead of refusing it', async () => {
    // CONTRACT CHANGE (live, 2026-09-18): this used to refuse with
    // `goal_unknown`, on the rule that a route which cannot reach the caller's
    // goal is not a route. A 380-block fixture trip showed what that meant in
    // practice: every poll refused, the corridor layer was dead for any goal
    // farther than the read radius, and the mover silently fell back to the
    // pre-B0 heuristics. The corridor is a *near-field* hint, so it now plans to
    // the goal clamped inside the window and the caller re-plans as it flies.
    const { port } = scriptedPort()
    const plan = await planLiveCorridor({ port, ...options }, { x: 0, y: 82, z: 0 }, { x: 200, y: 82, z: 0 })
    expect(plan.status).toBe('planned')
    expect(plan.aim).toBeDefined()
    expect(plan.aim!.x).toBeGreaterThan(0)
  })

  it('treats unread cells as unknown, not as free air', async () => {
    // The window is read, but the corridor around the start is missing.
    const { port } = scriptedPort({ omit: (_x, _y, z) => z > -4 && z < 4 })
    const plan = await planLiveCorridor({ port, ...options }, { x: 0, y: 82, z: 0 }, { x: 28, y: 82, z: 0 })
    expect(plan).toEqual({ status: 'no_route', refusal: 'start_unknown' })
  })

  it('reports a failed read as a missing fact', async () => {
    const { port } = scriptedPort({ fail: true })
    const plan = await planLiveCorridor({ port, ...options }, { x: 0, y: 82, z: 0 }, { x: 28, y: 82, z: 0 })
    expect(plan).toEqual({ status: 'read_failed' })
  })
})

describe('createLiveCorridorPort', () => {
  it('re-plans on the interval and caches the route in between', async () => {
    const { port, reads } = scriptedPort()
    let clock = 0
    const corridor = createLiveCorridorPort({ port, ...options, now: () => clock })
    const self = { x: 0, y: 82, z: 0 }
    const goal = { x: 28, y: 82, z: 0 }

    const first = await corridor.step(self, goal)
    expect(first).toBeDefined()
    expect(corridor.status()).toBe('planned')

    // Same interval, same goal: the cached route answers without a second read.
    clock = LIVE_CORRIDOR_REPLAN_MS - 1
    expect(await corridor.step(self, goal)).toEqual(first)
    expect(reads.length).toBe(1)

    clock = LIVE_CORRIDOR_REPLAN_MS
    await corridor.step(self, goal)
    expect(reads.length).toBe(2)
  })

  it('re-plans early when the goal moved past the move threshold', async () => {
    const { port, reads } = scriptedPort()
    const clock = 0
    const corridor = createLiveCorridorPort({ port, ...options, now: () => clock })
    const self = { x: 0, y: 82, z: 0 }
    await corridor.step(self, { x: 28, y: 82, z: 0 })
    expect(reads.length).toBe(1)

    // The clock has not advanced, so only the goal movement can trigger this.
    await corridor.step(self, { x: 28, y: 82, z: 24 })
    expect(reads.length).toBe(2)
  })

  it('keeps aiming along a far goal instead of dropping the route', async () => {
    const { port } = scriptedPort()
    const corridor = createLiveCorridorPort({ port, ...options, now: () => 0 })
    const self = { x: 0, y: 82, z: 0 }
    const aim = await corridor.step(self, { x: 28, y: 82, z: 0 })
    expect(aim).toBeDefined()

    // A goal outside the window is clamped into it (CONTRACT CHANGE, live
    // 2026-09-18 — see the plan-level test): the caller keeps following the
    // near-field hint toward the far goal and re-plans as it moves.
    const farAim = await corridor.step(self, { x: 200, y: 82, z: 0 })
    expect(farAim).toBeDefined()
    expect(farAim!.x).toBeGreaterThan(0)
    expect(corridor.status()).toBe('planned')
    expect(corridor.refusal()).toBeUndefined()
  })

  it('counts a route as reaching the goal only when a region contains it', () => {
    const corridor = {
      mapVersion: 'test',
      dimension: 'minecraft:overworld',
      regions: [{ id: 'region-0', bounds: { min: { x: 0, y: 80, z: 0 }, max: { x: 32, y: 83, z: 3 } }, clearance: 16, resolution: 4, hasUnknown: false }],
      entrances: [],
      unknownBoundary: [],
      speedRange: { min: 0, max: 1.5 },
    }
    expect(corridorReachesGoal(corridor, { x: 28, y: 82, z: 0 })).toBe(true)
    expect(corridorReachesGoal(corridor, { x: 60, y: 82, z: 0 })).toBe(false)
  })
})
