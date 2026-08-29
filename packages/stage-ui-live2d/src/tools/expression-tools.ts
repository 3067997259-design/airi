import type { ExpressionToolResult } from '../stores/expression-store'

import { tool } from '@xsai/tool'
import { z } from 'zod'

import { useExpressionStore } from '../stores/expression-store'

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Gate shared by every expression tool.
 *
 * Two distinct refusals matter to the model: no model on stage (nothing exists
 * to drive) versus a model whose expressions the user kept private (they exist
 * but are off-limits). Collapsing them would make the LLM retry a request the
 * user deliberately disabled.
 */
function ensureExpressionsAvailable(): ExpressionToolResult | null {
  const store = useExpressionStore()
  if (!store.modelId || store.expressions.size === 0)
    return { success: false, error: 'No Live2D model is currently loaded.' }

  if (store.llmExposedGroups.length === 0) {
    return {
      success: false,
      error: 'No Live2D expressions are exposed for LLM control. The user can enable them in Settings > Character Model > Expressions.',
    }
  }

  return null
}

/**
 * Rejects names the user did not expose, listing what is allowed instead.
 *
 * Only group names are addressable: raw parameter ids bypass the per-group
 * exposure choice, so they are not offered here even though the store can
 * resolve them.
 */
function ensureExposed(name: string): ExpressionToolResult | null {
  const store = useExpressionStore()
  const exposed = store.llmExposedGroups.map(group => group.name)
  if (exposed.includes(name))
    return null

  return {
    success: false,
    error: `Expression "${name}" is not available for LLM control.`,
    available: exposed,
  }
}

function serialize(result: ExpressionToolResult): string {
  return JSON.stringify(result)
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const tools = [
  // ----- expression.set ----------------------------------------------------
  tool({
    name: 'expression_set',
    description: [
      'Set a Live2D expression or parameter value.',
      'Use a boolean (true/false) to toggle an expression, or a number (0.0-1.0) for fine control.',
      'Optionally provide a duration in seconds for auto-reset.',
      'Examples: expression_set("Cry", true), expression_set("Blush", 0.7, 3)',
    ].join(' '),
    execute: async ({ name, value, duration }) => {
      const err = ensureExpressionsAvailable() ?? ensureExposed(name)
      if (err)
        return serialize(err)

      const store = useExpressionStore()
      const numericValue = typeof value === 'boolean' ? (value ? 1 : 0) : value
      const result = store.set(name, numericValue, duration ?? undefined)
      return serialize(result)
    },
    parameters: z.object({
      name: z.string().describe('Expression name or Live2D parameter ID (e.g. "Cry", "ParamWatermarkOFF")'),
      value: z.union([z.boolean(), z.number()]).describe('true/false for toggle, or 0.0-1.0 for numeric control'),
      duration: z.number().optional().describe('Seconds until auto-reset to default. Omit for permanent change.'),
    }),
  }),

  // ----- expression.get ----------------------------------------------------
  tool({
    name: 'expression_get',
    description: [
      'Get the current state of a Live2D expression or parameter.',
      'Omit the name to list all available expressions with their current values.',
    ].join(' '),
    execute: async ({ name }) => {
      const err = ensureExpressionsAvailable() ?? (name ? ensureExposed(name) : null)
      if (err)
        return serialize(err)

      const store = useExpressionStore()
      // Listing must not leak groups the user kept private, so an omitted name
      // reports the exposed groups rather than the store's full catalog.
      if (!name) {
        const states = store.llmExposedGroups.flatMap((group) => {
          const result = store.get(group.name)
          const state = result.state
          if (state == null)
            return []
          return (Array.isArray(state) ? state : [state]).map(entry => ({ ...entry, name: group.name }))
        })
        return serialize({ success: true, state: states, available: store.llmExposedGroups.map(group => group.name) })
      }

      const result = store.get(name)
      return serialize(result)
    },
    parameters: z.object({
      name: z.string().optional().describe('Expression name or parameter ID. Omit to list all.'),
    }),
  }),

  // ----- expression.toggle -------------------------------------------------
  tool({
    name: 'expression_toggle',
    description: [
      'Toggle a Live2D expression (flip between default and active state).',
      'Optionally provide a duration in seconds for auto-reset.',
    ].join(' '),
    execute: async ({ name, duration }) => {
      const err = ensureExpressionsAvailable() ?? ensureExposed(name)
      if (err)
        return serialize(err)

      const store = useExpressionStore()
      const result = store.toggle(name, duration ?? undefined)
      return serialize(result)
    },
    parameters: z.object({
      name: z.string().describe('Expression name or parameter ID to toggle'),
      duration: z.number().optional().describe('Seconds until auto-reset. Omit for permanent toggle.'),
    }),
  }),

  // ----- expression.resetAll -----------------------------------------------
  // `saveDefaults` is deliberately not exposed: it rewrites the user's
  // persisted resting appearance for the model, which is a settings decision
  // rather than an in-conversation action.
  tool({
    name: 'expression_reset_all',
    description: 'Turn off every active expression and return the face to its resting state.',
    execute: async () => {
      const err = ensureExpressionsAvailable()
      if (err)
        return serialize(err)

      const store = useExpressionStore()
      const result = store.resetAll()
      return serialize(result)
    },
    parameters: z.object({}),
  }),
]

/**
 * Export all expression tools as a resolved promise array, matching the
 * pattern used by other tool modules in the AIRI codebase.
 */
export const expressionTools = async () => Promise.all(tools)
