import { tool } from '@xsai/tool'
import { z } from 'zod'

import { useLive2DCustomParameters } from '../stores/custom-parameters'
import { useExpressionStore } from '../stores/expression-store'

/**
 * Current mood of the character, in memory-store valence/arousal space.
 * Injected by the registering app because stage-ui-live2d does not depend on
 * stage-ui; absent moods simply omit the mood section.
 */
export type MirrorMoodPort = () => { valence: number, arousal?: number } | undefined

export interface MirrorParameterView {
  id: string
  name: string
  group: string | null
  min: number
  max: number
  default: number
  value: number
  active: boolean
}

export interface MirrorSnapshotInput {
  modelId?: string
  /** Named expressions currently holding a non-default value. */
  activeExpressions: Array<{ name: string, value: number }>
  /** Exposed parameter groups (display name + member count). */
  groups: Array<{ id: string, name: string, parameterCount: number }>
  parameters: MirrorParameterView[]
  mood?: { valence: number, arousal?: number }
}

function moodPhrase(mood: { valence: number, arousal?: number }): string {
  const { valence, arousal } = mood
  const valencePhrase = valence >= 0.4
    ? 'warm and positive'
    : valence <= -0.4
      ? 'cool and low'
      : 'neutral'
  const arousalPhrase = arousal == null
    ? ''
    : arousal >= 0.6
      ? ', alert'
      : arousal <= 0.25
        ? ', calm'
        : ''
  return `${valencePhrase}${arousalPhrase}`
}

/**
 * Renders one appearance snapshot as natural language plus an exact JSON
 * block. The NL part reads like a person describing themselves; the JSON
 * block gives the model exact ids and values to act on.
 *
 * @example
 * buildMirrorSnapshot({ activeExpressions: [], groups: [], parameters: [{ id: 'HairBList', name: 'Hair (back loose)', group: null, min: 0, max: 1, default: 0, value: 1, active: true }] })
 * // => 'Currently holding: ...'
 */
export function buildMirrorSnapshot(input: MirrorSnapshotInput): string {
  const sections: string[] = []

  if (input.modelId)
    sections.push(`Model on stage: ${input.modelId}.`)

  const expressionLine = input.activeExpressions
    .map(expression => `${expression.name} (${expression.value.toFixed(2)})`)
  if (expressionLine.length > 0)
    sections.push(`Named expressions in use: ${expressionLine.join(', ')}.`)

  if (input.parameters.length > 0) {
    const held = input.parameters.filter(parameter => parameter.active && parameter.value !== parameter.default)
    const groupNames = new Map(input.groups.map(group => [group.id, group.name]))
    const labels = held.map((parameter) => {
      const group = parameter.group ? ` [${groupNames.get(parameter.group) ?? parameter.group}]` : ''
      const isBinary = parameter.min === 0 && parameter.max === 1
      const valueLabel = isBinary
        ? parameter.value >= 0.5 ? 'on' : 'off'
        : `value ${parameter.value.toFixed(2)} (range ${parameter.min}-${parameter.max})`
      return `${parameter.name}${group}: ${valueLabel}`
    })
    if (labels.length > 0)
      sections.push(`Appearance now: ${labels.join('; ')}.`)
    else
      sections.push('Appearance: all exposed parameters at their default (motion-driven look).')
  }

  if (input.mood)
    sections.push(`Mood: ${moodPhrase(input.mood)} (valence ${input.mood.valence.toFixed(2)}, arousal ${input.mood.arousal?.toFixed(2) ?? 'n/a'}).`)

  const json = JSON.stringify({
    modelId: input.modelId,
    activeExpressions: input.activeExpressions,
    parameters: input.parameters,
    mood: input.mood,
  }, null, 2)
  return `${sections.join('\n')}\n\nExact values:\n${json}`
}

/**
 * Resolves the model whose parameters the mirror describes; exactly one
 * Live2D model is on stage at a time, so the last discovery is the target.
 */
function activeModelId(store: ReturnType<typeof useLive2DCustomParameters>): string | undefined {
  return store.discoveredKeys.at(-1)
}

/**
 * Builds the `mirror` LLM tool: a natural-language appearance snapshot so SHE
 * can see herself the way the user sees her — held parameters, active named
 * expressions, and the current mood. `options.getMood` is injected by the app
 * shell (the memory store lives in stage-ui).
 */
export async function mirrorTools(options: { getMood?: MirrorMoodPort } = {}) {
  return Promise.all([
    tool({
      name: 'mirror',
      description: [
        'Read your own current appearance: which named expressions are active, which model parameters you are holding (hairstyle, ears, accessories), and your current mood.',
        'Call this before changing your look or when the user asks how you appear.',
      ].join(' '),
      execute: () => {
        const parameterStore = useLive2DCustomParameters()
        const expressionStore = useExpressionStore()
        const modelId = activeModelId(parameterStore)
        const exposed = parameterStore.llmExposedParameters(modelId)
        const values = parameterStore.valuesFor(modelId)
        const catalog = parameterStore.discoveryFor(modelId)
        const groupNames = new Map(catalog?.groups.map(group => [group.id, group.name]))

        const parameters = exposed.map(parameter => ({
          id: parameter.id,
          name: parameter.name,
          group: groupNames.get(parameter.groupId ?? '') ?? parameter.groupId ?? null,
          min: parameter.min,
          max: parameter.max,
          default: parameter.default,
          value: values[parameter.id]?.value ?? parameter.default,
          active: values[parameter.id]?.enabled === true,
        } satisfies MirrorParameterView))

        const byGroup = new Map<string, number>()
        for (const parameter of parameters)
          byGroup.set(parameter.group ?? '', (byGroup.get(parameter.group ?? '') ?? 0) + 1)
        const groups = [...byGroup.entries()].map(([groupId, parameterCount]) => ({
          id: groupId,
          name: groupNames.get(groupId) ?? groupId,
          parameterCount,
        }))

        const activeExpressions = [...expressionStore.expressions.values()]
          .filter(expression => expression.currentValue !== expression.defaultValue && expression.currentValue > 0)
          .map(expression => ({ name: expression.name, value: expression.currentValue }))

        return buildMirrorSnapshot({
          modelId,
          activeExpressions,
          groups,
          parameters,
          ...(options.getMood
            ? (() => {
                const mood = options.getMood!()
                return mood ? { mood } : {}
              })()
            : {}),
        })
      },
      parameters: z.object({}),
    }),
  ])
}
