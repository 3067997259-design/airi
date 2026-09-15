/**
 * Bridge capability discovery (capability-deepening CD-0 §3.3).
 *
 * At connect the host lists the bridge tools and records which capabilities
 * exist. A capability whose backing tool is absent is reported with a typed
 * limit, so a caller gets a reason instead of a fabricated zero, an empty
 * inventory, or a silent fallback.
 *
 * This module is pure: it maps a tool-name list onto the capability record and
 * is shared by the host and its tests.
 */
import type { GameCapabilities, GameCapabilityName, GameCapabilityStatus } from '../../../../shared/eventa'

/**
 * Tools that can back each capability, any one of which is enough.
 *
 * `ballistic-profiles` and `break-evidence` list the tools a later batch will
 * add; until the bridge exposes one, the capability is honestly unavailable.
 */
const CAPABILITY_TOOLS: Record<GameCapabilityName, string[]> = {
  // `get_entity` is the CD-L3 loaded-entity read with pose fields; a bridge
  // that lacks it still supports target observation through `query_entities`.
  'target-observation': ['get_entity', 'get_player', 'query_entities', 'get_entities'],
  'collision-snapshot': ['get_blocks_region'],
  'control-session': ['set_movement', 'stop_movement'],
  'ballistic-profiles': ['get_ballistics', 'ballistic_profile', 'get_projectile_profile'],
  'break-evidence': ['get_block', 'get_blocks_region'],
  // The concrete vehicle state read (tamed/saddled/powered/rail shape) plus the
  // candidate query. A bridge with only `get_vehicle` cannot prove these facts,
  // so the capability stays honestly unavailable.
  'vehicle-observation': ['get_vehicle_state', 'get_vehicles', 'observe_vehicle'],
}

const CAPABILITY_NAMES = Object.keys(CAPABILITY_TOOLS) as GameCapabilityName[]

function statusOf(name: GameCapabilityName, tools: Set<string>): GameCapabilityStatus {
  const matched = CAPABILITY_TOOLS[name].filter(tool => tools.has(tool))
  if (matched.length > 0)
    return { available: true, tools: matched }
  return { available: false, limit: `tool_unavailable: ${CAPABILITY_TOOLS[name].join('|')}`, tools: [] }
}

/**
 * Discovers bridge capabilities from the tools it exposes.
 *
 * @example
 * discoverGameCapabilities(['get_self', 'get_blocks_region']).collision-snapshot
 * // => { available: true, tools: ['get_blocks_region'] }
 */
export function discoverGameCapabilities(toolNames: Iterable<string>): GameCapabilities {
  const tools = new Set(toolNames)
  const capabilities = {} as GameCapabilities
  for (const name of CAPABILITY_NAMES)
    capabilities[name] = statusOf(name, tools)
  return capabilities
}
