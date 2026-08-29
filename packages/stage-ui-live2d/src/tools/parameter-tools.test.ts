// @vitest-environment jsdom

import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { useLive2DCustomParameters } from '../stores/custom-parameters'
import { live2dParameterTools } from './parameter-tools'

interface ToolLike {
  function: { name: string }
  execute: (args: Record<string, unknown>) => Promise<unknown>
}

async function toolNamed(name: string): Promise<ToolLike> {
  const tools = await live2dParameterTools() as unknown as ToolLike[]
  const found = tools.find(tool => tool.function.name === name)
  if (!found)
    throw new Error(`tool ${name} not registered`)
  return found
}

function loadModel() {
  const store = useLive2DCustomParameters()
  store.registerDiscovered('model-a', {
    parameters: [
      { id: 'HairBList', name: '后发发型切换', groupId: 'Group1', min: 0, max: 3, default: 0 },
      { id: 'pupilList1', name: '瞳孔表情切换', groupId: 'Group1', min: 0, max: 5, default: 0 },
    ],
    groups: [{ id: 'Group1', name: '发型' }],
  })
  return store
}

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
})

afterEach(() => {
  localStorage.clear()
})

describe('live2d parameter tools', () => {
  it('refuses to list or set while the mode is none', async () => {
    loadModel()

    const list = await toolNamed('live2d_parameter_list')
    expect(JSON.parse(await list.execute({}) as string).success).toBe(false)

    const set = await toolNamed('live2d_parameter_set')
    const result = JSON.parse(await set.execute({ parameters: [{ id: 'HairBList', value: 2 }] }) as string)
    expect(result.success).toBe(false)
  })

  it('lists exposed parameters with ranges and current values', async () => {
    const store = loadModel()
    store.setLlmMode('all')
    store.setValue('model-a', 'HairBList', 2)

    const list = await toolNamed('live2d_parameter_list')
    const result = JSON.parse(await list.execute({}) as string)

    expect(result.success).toBe(true)
    const hair = result.parameters.find((entry: { id: string }) => entry.id === 'HairBList')
    expect(hair).toMatchObject({ name: '后发发型切换', min: 0, max: 3, value: 2, active: true })
  })

  it('clamps values into the parameter range', async () => {
    const store = loadModel()
    store.setLlmMode('all')

    const set = await toolNamed('live2d_parameter_set')
    const result = JSON.parse(await set.execute({ parameters: [{ id: 'HairBList', value: 99 }] }) as string)

    expect(result.applied).toEqual([{ id: 'HairBList', name: '后发发型切换', value: 3 }])
    expect(store.valuesFor('model-a').HairBList).toEqual({ value: 3, enabled: true })
  })

  it('applies several parameters as one change', async () => {
    const store = loadModel()
    store.setLlmMode('all')

    const set = await toolNamed('live2d_parameter_set')
    await set.execute({ parameters: [{ id: 'HairBList', value: 1 }, { id: 'pupilList1', value: 4 }] })

    expect(store.valuesFor('model-a').HairBList.value).toBe(1)
    expect(store.valuesFor('model-a').pupilList1.value).toBe(4)
  })

  it('rejects parameters the user did not expose in custom mode', async () => {
    const store = loadModel()
    store.setLlmMode('custom')
    store.setLlmExposed('model-a', 'HairBList', true)

    const set = await toolNamed('live2d_parameter_set')
    const result = JSON.parse(await set.execute({ parameters: [{ id: 'pupilList1', value: 1 }] }) as string)

    expect(result.success).toBe(false)
    expect(result.available).toEqual(['HairBList'])
    expect(store.valuesFor('model-a').pupilList1).toBeUndefined()
  })

  it('releases held parameters without discarding their value', async () => {
    const store = loadModel()
    store.setLlmMode('all')
    await (await toolNamed('live2d_parameter_set')).execute({ parameters: [{ id: 'HairBList', value: 2 }] })

    const release = await toolNamed('live2d_parameter_release')
    expect(JSON.parse(await release.execute({}) as string).success).toBe(true)

    expect(store.valuesFor('model-a').HairBList).toEqual({ value: 2, enabled: false })
  })
})
