/**
 * Litematica blueprint adapter boundary (RS-1 §2).
 *
 * The user chose Litematica/MaLiLib as the integration, but no Litematica
 * artifact is resolvable in this environment (nothing in the Gradle cache or
 * mavenLocal). Rather than fake the Litematica API or add a network dependency,
 * this module records the exact bridge contract a Litematica-enabled build must
 * implement. Every method can answer with a typed `blueprint_unavailable` or
 * `adapter_unavailable` result, so the host code never has to guess whether a
 * missing blueprint is a failure or an absent integration.
 *
 * Real projection/placement integration is BLOCKED on that artifact. The
 * host-side domain modules (blueprint, siting, projection, construction,
 * verification, diagnosis, repair, diffs, experiments) stay pure and offline.
 */
import type { BlueprintRecord } from './blueprint'
import type { ProjectionPlan } from './projection'

/** Capability of the blueprint subsystem at connect time. */
export type BlueprintCapability
  = | { status: 'ok' }
    | { status: 'blueprint_unavailable', reason: string }
    | { status: 'adapter_unavailable', reason: string }

/** Typed refusal shared by every adapter call. */
export interface BlueprintUnavailableResult {
  status: 'blueprint_unavailable' | 'adapter_unavailable'
  reason: string
}

export type BlueprintLoadResult
  = | { status: 'ok', blueprint: BlueprintRecord }
    | BlueprintUnavailableResult

/** Structured projection status read back from the mod. */
export interface ProjectionStatusResult {
  status: 'ok'
  projectionId: string
  /** Blocks already matching the projection. */
  placed: number
  /** Blocks still missing, by block id. */
  missing: Record<string, number>
}

export type ProjectionStatus = ProjectionStatusResult | BlueprintUnavailableResult

/** One MCP tool a Litematica-enabled build would expose. */
export interface BlueprintAdapterToolDescriptor {
  name: string
  description: string
  parameters: Record<string, unknown>
  /**
   * Shape of the successful `structuredContent` result. The unavailable shape is
   * always `{ status, reason }`.
   */
  result: Record<string, unknown>
}

/**
 * Exact bridge tools the mod side must implement.
 *
 * These are documented, not yet implemented: the adapter factory below returns
 * `adapter_unavailable` until a Litematica/MaLiLib build provides them. The
 * schema is kept concrete so a future implementation is a fill-in, not a guess.
 */
export const LITEMATICA_ADAPTER_TOOLS: readonly BlueprintAdapterToolDescriptor[] = [
  {
    name: 'blueprint_load',
    description: 'Parse one Litematica blueprint file into the shared blueprint record shape.',
    parameters: {
      type: 'object',
      properties: {
        fileName: { type: 'string', description: 'Blueprint file name in the Litematica schematics directory.' },
      },
      required: ['fileName'],
      additionalProperties: false,
    },
    result: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['ok'] },
        blueprint: { type: 'object', description: 'A BlueprintRecord: file identity, contentDigest, version, relativeOrigin, subregions, accessPoints, digDepth, outerLayer.' },
      },
    },
  },
  {
    name: 'projection_create',
    description: 'Create or move the projection this task owns. Returns the projection id and the resolved origin/rotation the mod applied.',
    parameters: {
      type: 'object',
      properties: {
        projectionId: { type: 'string' },
        taskId: { type: 'string' },
        orientation: { type: 'number', enum: [0, 90, 180, 270] },
        x: { type: 'number' },
        y: { type: 'number' },
        z: { type: 'number' },
        materialList: { type: 'boolean', description: 'Also return the material list for the placement.' },
      },
      required: ['projectionId', 'taskId', 'orientation', 'x', 'y', 'z'],
      additionalProperties: false,
    },
    result: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['ok'] },
        projectionId: { type: 'string' },
        origin: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
        rotation: { type: 'number' },
      },
    },
  },
  {
    name: 'projection_status',
    description: 'Read the placement state of the projection this task owns.',
    parameters: {
      type: 'object',
      properties: { projectionId: { type: 'string' } },
      required: ['projectionId'],
      additionalProperties: false,
    },
    result: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['ok'] },
        projectionId: { type: 'string' },
        placed: { type: 'number' },
        missing: { type: 'object' },
      },
    },
  },
  {
    name: 'projection_remove',
    description: 'Remove only the projection this task created; never another player\'s projection.',
    parameters: {
      type: 'object',
      properties: { projectionId: { type: 'string' } },
      required: ['projectionId'],
      additionalProperties: false,
    },
    result: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['ok'] },
        removed: { type: 'boolean' },
      },
    },
  },
] as const

/** Bridge contract the host calls for blueprint and projection work. */
export interface BlueprintAdapter {
  capability: () => Promise<BlueprintCapability>
  loadBlueprint: (request: { fileName: string }) => Promise<BlueprintLoadResult>
  createProjection: (request: { projection: ProjectionPlan }) => Promise<ProjectionStatus>
  readProjection: (request: { projectionId: string }) => Promise<ProjectionStatus>
  removeProjection: (request: { projectionId: string }) => Promise<BlueprintUnavailableResult | { status: 'ok', removed: boolean }>
}

/**
 * Adapter used when no Litematica-enabled build is installed.
 *
 * Every call returns the typed `adapter_unavailable` result instead of throwing,
 * so a caller can report the missing prerequisite in the same shape as any other
 * capability limit.
 */
export function createUnavailableBlueprintAdapter(reason: string): BlueprintAdapter {
  const unavailable = (): BlueprintUnavailableResult => ({ status: 'adapter_unavailable', reason })
  return {
    capability: async () => ({ status: 'adapter_unavailable', reason }),
    loadBlueprint: async () => unavailable(),
    createProjection: async () => unavailable(),
    readProjection: async () => unavailable(),
    removeProjection: async () => unavailable(),
  }
}
