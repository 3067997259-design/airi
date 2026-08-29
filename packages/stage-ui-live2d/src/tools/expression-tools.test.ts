// @vitest-environment jsdom

import type { ExpressionEntry, ExpressionGroupDefinition } from '../stores/expression-store'

import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { useExpressionStore } from '../stores/expression-store'
import { expressionTools } from './expression-tools'

interface ToolLike {
  function: { name: string }
  execute: (args: Record<string, unknown>) => Promise<unknown>
}

async function toolNamed(name: string): Promise<ToolLike> {
  const tools = await expressionTools() as unknown as ToolLike[]
  const found = tools.find(tool => tool.function.name === name)
  if (!found)
    throw new Error(`tool ${name} not registered`)
  return found
}

function loadModel() {
  const store = useExpressionStore()
  const groups: ExpressionGroupDefinition[] = [
    { name: 'Sleep', parameters: [{ parameterId: 'SleepButton', blend: 'Add', value: 1 }] },
    { name: 'Cry', parameters: [{ parameterId: 'CryButton', blend: 'Add', value: 1 }] },
  ]
  const entries: ExpressionEntry[] = ['SleepButton', 'CryButton'].map(id => ({
    name: id,
    parameterId: id,
    blend: 'Add' as const,
    currentValue: 0,
    defaultValue: 0,
    modelDefault: 0,
    targetValue: 1,
  }))
  store.registerExpressions('model-a', groups, entries)
  return store
}

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
})

afterEach(() => {
  localStorage.clear()
})

describe('expression tool exposure gating', () => {
  // ROOT CAUSE:
  //
  // The tools only checked that a model was loaded. `isExposedToLlm` existed but
  // no tool consulted it, so the settings "Expose to LLM" choice changed
  // nothing: with the default mode of 'none' the model could still drive every
  // expression.
  //
  // We fixed this by gating every tool on the exposed group list.
  it('refuses every expression while the mode is none', async () => {
    loadModel()

    const set = await toolNamed('expression_set')
    const result = JSON.parse(await set.execute({ name: 'Sleep', value: true }) as string)

    expect(result.success).toBe(false)
    expect(result.error).toContain('exposed for LLM control')
  })

  it('allows only the groups selected in custom mode', async () => {
    const store = loadModel()
    store.setLlmMode('custom')
    store.setLlmExposed('Sleep', true)

    const set = await toolNamed('expression_set')

    const allowed = JSON.parse(await set.execute({ name: 'Sleep', value: true }) as string)
    expect(allowed.success).toBe(true)
    expect(store.expressions.get('SleepButton')!.currentValue).toBe(1)

    const refused = JSON.parse(await set.execute({ name: 'Cry', value: true }) as string)
    expect(refused.success).toBe(false)
    expect(refused.available).toEqual(['Sleep'])
    expect(store.expressions.get('CryButton')!.currentValue).toBe(0)
  })

  it('lists only exposed groups when no name is given', async () => {
    const store = loadModel()
    store.setLlmMode('custom')
    store.setLlmExposed('Cry', true)

    const get = await toolNamed('expression_get')
    const result = JSON.parse(await get.execute({}) as string)

    expect(result.success).toBe(true)
    expect(result.available).toEqual(['Cry'])
    expect(result.state.map((entry: { name: string }) => entry.name)).toEqual(['Cry'])
  })

  it('drives expressions in all mode and resets them', async () => {
    const store = loadModel()
    store.setLlmMode('all')

    const toggle = await toolNamed('expression_toggle')
    expect(JSON.parse(await toggle.execute({ name: 'Cry' }) as string).success).toBe(true)
    expect(store.expressions.get('CryButton')!.currentValue).toBe(1)

    const reset = await toolNamed('expression_reset_all')
    expect(JSON.parse(await reset.execute({}) as string).success).toBe(true)
    expect(store.expressions.get('CryButton')!.currentValue).toBe(0)
  })

  // The LLM must not rewrite the user's persisted resting appearance.
  it('does not register a save-defaults tool', async () => {
    const tools = await expressionTools() as unknown as ToolLike[]
    expect(tools.map(tool => tool.function.name)).not.toContain('expression_save_defaults')
  })
})
