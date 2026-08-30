import type { Tool } from '@xsai/shared-chat'

import { useExpressionStore } from '@proj-airi/stage-ui-live2d/stores/expression-store'
import { useLlmToolsStore } from '@proj-airi/stage-ui/stores/ai/chat-llm/tools'
import { useLlmToolsetPromptsStore } from '@proj-airi/stage-ui/stores/ai/chat-llm/toolset-prompts'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { listCodingTools } = vi.hoisted(() => ({
  listCodingTools: vi.fn(),
}))

vi.mock('../../bridges/coding-host', () => ({
  createCodingHostClient: () => ({ listTools: listCodingTools }),
}))

function executableTool(name: string): Tool {
  return {
    type: 'function',
    function: {
      name,
      parameters: { type: 'object', properties: {} },
    },
    execute: vi.fn(),
  }
}

vi.mock('./builtin/image-journal', () => ({
  imageJournalTools: vi.fn(async () => [executableTool('image_journal')]),
}))
vi.mock('./builtin/weather', () => ({
  weatherTools: vi.fn(async () => [executableTool('get_weather')]),
}))
vi.mock('./builtin/widgets', () => ({
  widgetsTools: vi.fn(async () => [executableTool('stage_widgets')]),
}))
vi.mock('@proj-airi/stage-ui-live2d/tools/expression-tools', () => ({
  expressionTools: vi.fn(async () => [executableTool('expression_set')]),
}))
vi.mock('@proj-airi/stage-ui-live2d/tools/parameter-tools', () => ({
  live2dParameterTools: vi.fn(async () => [executableTool('live2d_parameter_set')]),
}))

describe('useTamagotchiBuiltinToolsStore', async () => {
  const { useTamagotchiBuiltinToolsStore } = await import('./built-in')

  beforeEach(() => {
    setActivePinia(createPinia())
    listCodingTools.mockRejectedValue(new Error('coding host is not ready'))
  })

  it('registers built-in executors as request-selected tools', async () => {
    const toolsStore = useLlmToolsStore()

    await useTamagotchiBuiltinToolsStore().refresh()

    expect(toolsStore.activeTools).toEqual([])
    expect(toolsStore.tools.map(tool => ({
      id: tool.id,
      defaultActive: tool.defaultActive,
    }))).toEqual([
      { id: 'tamagotchi:image_journal', defaultActive: false },
      { id: 'tamagotchi:stage_widgets', defaultActive: false },
      { id: 'tamagotchi:get_weather', defaultActive: false },
      { id: 'tamagotchi:expression_set', defaultActive: false },
      { id: 'tamagotchi:live2d_parameter_set', defaultActive: false },
      { id: 'tamagotchi:mirror', defaultActive: false },
      { id: 'tamagotchi:plan_update', defaultActive: false },
      { id: 'tamagotchi:skill_submit', defaultActive: false },
    ])
    expect(toolsStore.getToolsByNames('get_weather')[0]?.function.name).toBe('get_weather')
  })

  it('omits the Live2D toolset prompt until the user exposes expressions', async () => {
    const promptsStore = useLlmToolsetPromptsStore()

    await useTamagotchiBuiltinToolsStore().refresh()
    expect(promptsStore.activeToolsetPrompt).not.toContain('Live2D Appearance')

    const expressionStore = useExpressionStore()
    expressionStore.registerExpressions('model-a', [
      { name: 'Sleep', parameters: [{ parameterId: 'SleepButton', blend: 'Add', value: 1 }] },
    ], [
      {
        name: 'SleepButton',
        parameterId: 'SleepButton',
        blend: 'Add',
        currentValue: 0,
        defaultValue: 0,
        modelDefault: 0,
        targetValue: 1,
      },
    ])
    expressionStore.setLlmMode('all')

    await useTamagotchiBuiltinToolsStore().refresh()
    expect(promptsStore.activeToolsetPrompt).toContain('Live2D Appearance')
    expect(promptsStore.activeToolsetPrompt).toContain('Sleep')
  })

  it('registers coding tools when the coding host reports them as available', async () => {
    listCodingTools.mockResolvedValue({
      workspaceRoot: 'C:/AIRI-workspace',
      tools: [...['read', 'write', 'edit', 'bash'], 'code_mode'].map(name => ({
        name,
        description: `${name} tool`,
        available: true,
      })),
    })

    const toolsStore = useLlmToolsStore()
    await useTamagotchiBuiltinToolsStore().refresh()

    expect(toolsStore.activeTools.map(tool => tool.function.name)).toEqual(['read', 'write', 'edit', 'bash', 'code_mode'])
    expect(toolsStore.getToolsByNames('read', 'write', 'edit', 'bash', 'code_mode').map(tool => tool.function.name)).toEqual(['read', 'write', 'edit', 'bash', 'code_mode'])
  })
})
