import type { Live2DDiscoveredParameter } from '../stores/custom-parameters'

import { tool } from '@xsai/tool'
import { z } from 'zod'

import { useLive2DCustomParameters } from '../stores/custom-parameters'

/**
 * Result envelope for every parameter tool.
 *
 * `available` is only populated on failure, so a model that guessed a wrong id
 * can recover in one turn instead of probing repeatedly.
 */
interface ParameterToolResult {
  success: boolean
  error?: string
  applied?: Array<{ id: string, name: string, value: number }>
  parameters?: Array<{
    id: string
    name: string
    group: string | null
    min: number
    max: number
    default: number
    value: number
    active: boolean
  }>
  available?: string[]
}

function serialize(result: ParameterToolResult): string {
  return JSON.stringify(result)
}

/**
 * Resolves the model whose parameters the tools act on.
 *
 * The Live2D stores key everything by model id, but the tools run outside the
 * settings panel that tracks the selection, so the currently discovered model
 * is the only id available here. Exactly one Live2D model is on stage at a
 * time, so the most recent discovery is the right target.
 */
function activeModelId(store: ReturnType<typeof useLive2DCustomParameters>): string | undefined {
  return store.discoveredKeys.at(-1)
}

/** Clamps to the rig's own range so an out-of-range request deforms nothing. */
function clampToRange(parameter: Live2DDiscoveredParameter, value: number): number {
  return Math.min(parameter.max, Math.max(parameter.min, value))
}

const tools = [
  tool({
    name: 'live2d_parameter_list',
    description: [
      'List the Live2D model parameters you are allowed to control, with their ranges and current values.',
      'These are model-native controls such as hairstyle switches, pupil styles, ear shapes, and accessory toggles.',
      'Call this before setting a parameter so you use real ids and stay inside each range.',
    ].join(' '),
    execute: async () => {
      const store = useLive2DCustomParameters()
      const modelId = activeModelId(store)
      const exposed = store.llmExposedParameters(modelId)
      if (exposed.length === 0) {
        return serialize({
          success: false,
          error: 'No Live2D parameters are exposed for LLM control. The user can enable them in Settings > Character Model > Custom parameters.',
        })
      }

      const values = store.valuesFor(modelId)
      const groupNames = new Map(store.discoveryFor(modelId)?.groups.map(group => [group.id, group.name]))
      return serialize({
        success: true,
        parameters: exposed.map(parameter => ({
          id: parameter.id,
          name: parameter.name,
          group: groupNames.get(parameter.groupId ?? '') ?? parameter.groupId,
          min: parameter.min,
          max: parameter.max,
          default: parameter.default,
          value: values[parameter.id]?.value ?? parameter.default,
          active: values[parameter.id]?.enabled === true,
        })),
      })
    },
    parameters: z.object({}),
  }),

  tool({
    name: 'live2d_parameter_set',
    description: [
      'Set one or more Live2D model parameters to hold a value, building a custom look or pose.',
      'Values outside a parameter range are clamped. Use live2d_parameter_list first to learn valid ids and ranges.',
      'Each set value is held until you change or release it, so combine several parameters for a compound appearance.',
    ].join(' '),
    execute: async ({ parameters }) => {
      const store = useLive2DCustomParameters()
      const modelId = activeModelId(store)
      const exposed = store.llmExposedParameters(modelId)
      if (exposed.length === 0) {
        return serialize({
          success: false,
          error: 'No Live2D parameters are exposed for LLM control.',
        })
      }

      const exposedById = new Map(exposed.map(parameter => [parameter.id, parameter]))
      const unknown = parameters.filter(entry => !exposedById.has(entry.id)).map(entry => entry.id)
      if (unknown.length > 0) {
        return serialize({
          success: false,
          error: `Not exposed or unknown parameter(s): ${unknown.join(', ')}.`,
          available: [...exposedById.keys()],
        })
      }

      const applied = parameters.map((entry) => {
        const parameter = exposedById.get(entry.id)!
        const value = clampToRange(parameter, entry.value)
        store.setValue(modelId, entry.id, value)
        return { id: parameter.id, name: parameter.name, value }
      })

      return serialize({ success: true, applied })
    },
    parameters: z.object({
      parameters: z.array(z.object({
        id: z.string().describe('Live2D parameter id, exactly as returned by live2d_parameter_list (e.g. "HairBList")'),
        value: z.number().describe('Target value; clamped into the parameter min/max range'),
      })).describe('Parameters to set together, applied as one visual change'),
    }),
  }),

  tool({
    name: 'live2d_parameter_release',
    description: [
      'Stop holding Live2D parameters so the model returns to its motion-driven appearance.',
      'Omit ids to release every parameter you are allowed to control.',
    ].join(' '),
    execute: async ({ ids }) => {
      const store = useLive2DCustomParameters()
      const modelId = activeModelId(store)
      const exposed = store.llmExposedParameters(modelId)
      if (exposed.length === 0) {
        return serialize({
          success: false,
          error: 'No Live2D parameters are exposed for LLM control.',
        })
      }

      const exposedById = new Map(exposed.map(parameter => [parameter.id, parameter]))
      const targets = ids && ids.length > 0
        ? ids.filter(id => exposedById.has(id))
        : [...exposedById.keys()]
      const values = store.valuesFor(modelId)

      const applied: Array<{ id: string, name: string, value: number }> = []
      for (const id of targets) {
        // Only entries the panel already tracks can be disabled; an untouched
        // parameter is not being held, so releasing it is already a no-op.
        if (values[id] == null)
          continue
        store.setEnabled(modelId, id, false)
        const parameter = exposedById.get(id)!
        applied.push({ id, name: parameter.name, value: parameter.default })
      }

      return serialize({ success: true, applied })
    },
    parameters: z.object({
      ids: z.array(z.string()).optional().describe('Parameter ids to release. Omit to release all exposed parameters.'),
    }),
  }),
]

/**
 * Model-native Live2D parameter tools.
 *
 * Resolved eagerly like the other AIRI tool modules so callers can spread the
 * result straight into a tool list.
 */
export const live2dParameterTools = async () => Promise.all(tools)
