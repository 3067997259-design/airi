/**
 * Harvest eligibility, tool selection and durability (CD-M1).
 *
 * Pure functions only. The mod-side evaluation supplies the game rules; this
 * module applies the domain economy: which candidate is worth spending, when a
 * tool is too worn for the plan, and when a request must be rejected instead of
 * mining with the wrong tool.
 */
import type {
  DurabilityEstimate,
  ExpectedDropMode,
  HarvestDecision,
  HarvestEvaluation,
  HarvestHazard,
  HarvestRejection,
  HarvestUnmet,
  MiningRequest,
  ToolCandidate,
  ToolSelection,
  ToolStrategy,
} from './types'

/** Rough material order used only to rank how replaceable a tool is. */
const TOOL_MATERIAL_RANK: Record<string, number> = {
  'minecraft:wooden': 0,
  'minecraft:stone': 1,
  'minecraft:golden': 2,
  'minecraft:iron': 3,
  'minecraft:diamond': 4,
  'minecraft:netherite': 5,
}

const UNBREAKING_ID = 'minecraft:unbreaking'

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function finiteNumber(value: unknown): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

/**
 * Reads an enchantment map from the bridge's item record.
 *
 * The bridge reports either `enchantments: {id: level}` or a list of
 * `{id, level}` entries; both shapes are normalized so a candidate's unbreaking
 * level can be read without guessing.
 */
function parseEnchantments(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const record = asRecord(entry)
      const id = typeof record?.id === 'string' ? record.id : undefined
      const level = finiteNumber(record?.level)
      if (id && level !== undefined)
        out[id] = level
    }
    return out
  }
  const record = asRecord(raw)
  if (record) {
    for (const [id, value] of Object.entries(record)) {
      const level = finiteNumber(value)
      if (level !== undefined)
        out[id] = level
    }
  }
  return out
}

/** Normalizes a namespace-less or namespaced id so component maps match. */
function canonicalId(id: string): string {
  return id.includes(':') ? id : `minecraft:${id}`
}

function expectedDropModeOf(enchantments: Record<string, number>, gem: boolean): ExpectedDropMode {
  const hasSilk = (enchantments['minecraft:silk_touch'] ?? 0) > 0
  const hasFortune = (enchantments['minecraft:fortune'] ?? 0) > 0
  if (hasSilk && hasFortune)
    return 'unknown'
  if (hasSilk)
    return 'silk-touch'
  if (hasFortune)
    return 'fortune'
  // A block whose own drop needs silk touch is reported by the mod through
  // `expectedDropMode`; a candidate without it must not silently claim normal.
  return gem ? 'unknown' : 'normal'
}

function parseCandidate(raw: unknown): ToolCandidate | undefined {
  const record = asRecord(raw)
  if (!record)
    return undefined
  const slot = finiteNumber(record.slot)
  const itemId = typeof record.itemId === 'string' && record.itemId
    ? record.itemId
    : typeof record.id === 'string' && record.id ? record.id : undefined
  if (slot === undefined || !itemId)
    return undefined
  const enchantments = parseEnchantments(record.enchantments)
  const harvestEligible = record.harvestEligible === true
  const destroySpeed = finiteNumber(record.destroySpeed) ?? 0
  return {
    slot,
    hotbar: record.hotbar === true,
    itemId: canonicalId(itemId),
    count: finiteNumber(record.count) ?? 1,
    ...(finiteNumber(record.damage) !== undefined ? { damage: finiteNumber(record.damage) } : {}),
    ...(finiteNumber(record.maxDamage) !== undefined ? { maxDamage: finiteNumber(record.maxDamage) } : {}),
    enchantments,
    harvestEligible,
    destroySpeed,
    ...(finiteNumber(record.estimatedTicks) !== undefined ? { estimatedTicks: finiteNumber(record.estimatedTicks) } : {}),
    expectedDropMode: expectedDropModeOf(enchantments, false),
  }
}

/**
 * Parses the mod's harvest evaluation record.
 *
 * Returns `undefined` when the record is unusable (no block id or no
 * candidate list), so an unavailable evaluation is never mistaken for a
 * harvestable block. That keeps the caller on its explicit manual path.
 *
 * @example
 * parseHarvestEvaluation({ blockStateId: 'minecraft:stone', x: 1, y: 64, z: 0, candidates: [] })
 * // => HarvestEvaluation with an empty candidate list
 */
export function parseHarvestEvaluation(raw: unknown): HarvestEvaluation | undefined {
  const record = asRecord(raw)
  if (!record)
    return undefined
  const blockStateId = typeof record.blockStateId === 'string' ? record.blockStateId : undefined
  const candidatesRaw = Array.isArray(record.candidates) ? record.candidates : undefined
  if (!blockStateId || !candidatesRaw)
    return undefined
  const x = finiteNumber(record.x)
  const y = finiteNumber(record.y)
  const z = finiteNumber(record.z)
  if (x === undefined || y === undefined || z === undefined)
    return undefined
  const candidates = candidatesRaw
    .map(parseCandidate)
    .filter((candidate): candidate is ToolCandidate => candidate !== undefined)
  const dropMode = typeof record.expectedDropMode === 'string'
    && ['normal', 'silk-touch', 'fortune', 'unknown'].includes(record.expectedDropMode)
    ? record.expectedDropMode as ExpectedDropMode
    : 'unknown'
  return {
    blockStateId,
    x,
    y,
    z,
    dimension: typeof record.dimension === 'string' ? record.dimension : '',
    ...(typeof record.worldId === 'string' ? { worldId: record.worldId } : {}),
    ...(typeof record.playerUuid === 'string' ? { playerUuid: record.playerUuid } : {}),
    candidates,
    harvestEligible: record.harvestEligible === true,
    expectedDropMode: dropMode,
    ...(finiteNumber(record.estimatedTicks) !== undefined ? { estimatedTicks: finiteNumber(record.estimatedTicks) } : {}),
    estimateQuality: record.estimateQuality === 'exact' || record.estimateQuality === 'approximate'
      ? record.estimateQuality
      : 'unknown',
    hazards: stringArray(record.hazards).filter((hazard): hazard is HarvestHazard =>
      ['falling-sand', 'fluids', 'self-support', 'ceiling-collapse', 'nearby-danger'].includes(hazard)),
    unmet: stringArray(record.unmet).filter((unmet): unmet is HarvestUnmet =>
      ['no_tool', 'tool_level_too_low', 'unbreakable', 'inventory_full', 'data_unavailable'].includes(unmet)),
    requiresTool: record.requiresTool === true,
  }
}

/** True when the candidate can produce the block's drop with a correct tool. */
export function isCandidateUsable(candidate: ToolCandidate, evaluation: HarvestEvaluation): boolean {
  if (!candidate.harvestEligible)
    return false
  // A block that drops without a tool needs no candidate at all; a block that
  // requires one only accepts a candidate the rules call correct.
  return !evaluation.requiresTool || candidate.harvestEligible
}

function unbreakingLevel(candidate: ToolCandidate): number {
  const direct = candidate.enchantments[UNBREAKING_ID]
  if (direct !== undefined)
    return Math.max(0, Math.floor(direct))
  for (const [id, level] of Object.entries(candidate.enchantments)) {
    if (canonicalId(id) === UNBREAKING_ID)
      return Math.max(0, Math.floor(level))
  }
  return 0
}

/** Counts enchantments that make a tool expensive to replace. */
function enchantmentCount(candidate: ToolCandidate): number {
  return Object.keys(candidate.enchantments).length
}

function materialRank(candidate: ToolCandidate): number {
  const [namespace, material] = canonicalId(candidate.itemId).split(':')
  if (namespace && TOOL_MATERIAL_RANK[`${namespace}:${material?.split('_')[0]}`] !== undefined)
    return TOOL_MATERIAL_RANK[`${namespace}:${material?.split('_')[0]}`]!
  return 0
}

/**
 * Estimates how many blocks a candidate can still break.
 *
 * Unbreaking is applied as an expectation (`remaining * (level + 1)`); the
 * pessimistic bound ignores it. A tool without a readable durability is marked
 * `known: false` and is never called safe.
 *
 * @example
 * estimateDurability({ damage: 10, maxDamage: 131, enchantments: {}, ... }, 20)
 * // => { known: true, remaining: 121, worstCaseBlocks: 121, expectedBlocks: 121, riskOfBreak: false }
 */
export function estimateDurability(candidate: ToolCandidate, plannedBlocks: number): DurabilityEstimate {
  if (candidate.maxDamage === undefined || candidate.damage === undefined) {
    return {
      known: false,
      remaining: 0,
      expectedBlocks: Number.POSITIVE_INFINITY,
      worstCaseBlocks: Number.POSITIVE_INFINITY,
      riskOfBreak: false,
    }
  }
  const remaining = Math.max(0, candidate.maxDamage - candidate.damage)
  const unbreaking = unbreakingLevel(candidate)
  const expectedBlocks = remaining * (unbreaking + 1)
  return {
    known: true,
    remaining,
    expectedBlocks,
    worstCaseBlocks: remaining,
    // Unbreaking can always fail, so a plan longer than the raw remaining
    // durability is a risk even when the expectation covers it.
    riskOfBreak: plannedBlocks > remaining,
  }
}

function reject(reason: HarvestUnmet, detail?: string): HarvestDecision {
  const rejection: HarvestRejection = { reason, ...(detail ? { detail } : {}) }
  return { ok: false, rejection }
}

/**
 * Chooses a candidate for a request.
 *
 * Rejections are explicit: no correct tool, a pinned tool that is absent, or
 * only tools that cannot meet `maxTicks`. The caller must not mine with a tool
 * that failed the requirement.
 */
export function selectTool(evaluation: HarvestEvaluation, request: MiningRequest): HarvestDecision {
  const plannedBlocks = Math.max(1, request.plannedBlocks ?? 1)
  const keep = new Set((request.keep ?? []).map(canonicalId))

  if (evaluation.unmet.includes('unbreakable'))
    return reject('unbreakable', 'the block has no break progress')
  if (evaluation.unmet.includes('data_unavailable'))
    return reject('data_unavailable', 'the evaluation could not read the block')
  if (evaluation.unmet.includes('inventory_full'))
    return reject('inventory_full', 'no inventory slot is free for the drop')

  const eligible = evaluation.candidates.filter(candidate => isCandidateUsable(candidate, evaluation))
  const usable = eligible.filter(candidate => !keep.has(canonicalId(candidate.itemId)))

  if (request.strategy === 'specified') {
    const pinned = canonicalId(request.toolItemId ?? '')
    const match = usable.find(candidate => canonicalId(candidate.itemId) === pinned)
    if (match)
      return { ok: true, selection: toSelection(match, 'specified', plannedBlocks, 'pinned by the caller'), bareHand: false }
    // A pinned tool is a hard requirement: an explicit request must not fall
    // back to another tool or a bare hand.
    const present = evaluation.candidates.some(candidate => canonicalId(candidate.itemId) === pinned)
    return reject(present ? 'tool_level_too_low' : 'no_tool', `${pinned} is not a usable tool for this block`)
  }

  // A tool that cannot cover the plan is only used when no safer candidate
  // exists; the caller then switches to a spare or reports tool_durability_low.
  const safe = usable.filter(candidate => !estimateDurability(candidate, plannedBlocks).riskOfBreak)
  const pool = safe.length > 0 ? safe : usable
  const ranked = request.strategy === 'fastest'
    ? rankForSpeed(pool)
    : rankForConservation(pool)
  const best = ranked[0]
  if (!best) {
    // No usable candidate. A block that drops without a tool is still cleared
    // by hand; one that requires a tool is a rejection so the caller can plan
    // an upgrade instead of mining with the wrong item.
    if (!evaluation.requiresTool)
      return { ok: true, bareHand: true }
    if (eligible.length > 0)
      return reject('no_tool', 'every usable tool is reserved by the caller')
    if (evaluation.candidates.length > 0)
      return reject('tool_level_too_low', 'no candidate meets the block tool requirement')
    return reject('no_tool', 'the inventory holds no usable tool')
  }

  const selection = toSelection(best, request.strategy, plannedBlocks, request.strategy === 'fastest' ? 'lowest estimated time' : 'cheapest durable tool that qualifies')
  if (request.maxTicks !== undefined && selection.candidate.estimatedTicks !== undefined
    && selection.candidate.estimatedTicks > request.maxTicks) {
    return reject('tool_level_too_low', `estimated ${selection.candidate.estimatedTicks} ticks exceeds the ${request.maxTicks} tick budget`)
  }
  return { ok: true, selection, bareHand: false }
}

/** Orders candidates by estimated time, then by destroy speed. */
function rankForSpeed(candidates: ToolCandidate[]): ToolCandidate[] {
  return [...candidates].sort((a, b) => {
    const at = a.estimatedTicks ?? Number.POSITIVE_INFINITY
    const bt = b.estimatedTicks ?? Number.POSITIVE_INFINITY
    if (at !== bt)
      return at - bt
    return b.destroySpeed - a.destroySpeed
  })
}

/**
 * Orders candidates to avoid consuming valuable tools first.
 *
 * A plain low-tier tool is preferred over an enchanted or high-tier one; ties
 * break on the lower estimated time. This keeps rare enchanted tools for the
 * cases that actually need them.
 */
function rankForConservation(candidates: ToolCandidate[]): ToolCandidate[] {
  return [...candidates].sort((a, b) => {
    const aEnchanted = enchantmentCount(a) > 0 ? 1 : 0
    const bEnchanted = enchantmentCount(b) > 0 ? 1 : 0
    if (aEnchanted !== bEnchanted)
      return aEnchanted - bEnchanted
    const aRank = materialRank(a)
    const bRank = materialRank(b)
    if (aRank !== bRank)
      return aRank - bRank
    const at = a.estimatedTicks ?? Number.POSITIVE_INFINITY
    const bt = b.estimatedTicks ?? Number.POSITIVE_INFINITY
    if (at !== bt)
      return at - bt
    return (b.maxDamage ?? 0) - (a.maxDamage ?? 0)
  })
}

function toSelection(candidate: ToolCandidate, strategy: ToolStrategy, plannedBlocks: number, reason: string): ToolSelection {
  return {
    candidate,
    strategy,
    reason,
    durability: estimateDurability(candidate, plannedBlocks),
  }
}

/**
 * True when no candidate can produce the required drop.
 *
 * `game_collect` uses this to return structured prerequisites before mining,
 * rather than making the block disappear without the product.
 */
export function requiresUpgrade(evaluation: HarvestEvaluation, request: MiningRequest): boolean {
  const decision = selectTool(evaluation, request)
  if (decision.ok)
    return false
  return decision.rejection.reason === 'no_tool' || decision.rejection.reason === 'tool_level_too_low'
}

/**
 * Whether a movement planner may treat the cell as diggable.
 *
 * Unknown data is not diggable: only an evaluation that names a harvestable
 * block and a usable tool authorizes a break edge.
 */
export function isDigAuthorized(evaluation: HarvestEvaluation, request: Pick<MiningRequest, 'strategy' | 'toolItemId' | 'keep' | 'plannedBlocks'>): boolean {
  const decision = selectTool(evaluation, {
    pos: { x: evaluation.x, y: evaluation.y, z: evaluation.z },
    strategy: request.strategy,
    ...(request.toolItemId ? { toolItemId: request.toolItemId } : {}),
    ...(request.keep ? { keep: request.keep } : {}),
    ...(request.plannedBlocks !== undefined ? { plannedBlocks: request.plannedBlocks } : {}),
  })
  return decision.ok
}
