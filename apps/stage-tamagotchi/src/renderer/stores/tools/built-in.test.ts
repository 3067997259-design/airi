import type { Tool } from '@xsai/shared-chat'

import { useExpressionStore } from '@proj-airi/stage-ui-live2d/stores/expression-store'
import { useLlmToolsStore } from '@proj-airi/stage-ui/stores/ai/chat-llm/tools'
import { useLlmToolsetPromptsStore } from '@proj-airi/stage-ui/stores/ai/chat-llm/toolset-prompts'
import { useLifeModeStore } from '@proj-airi/stage-ui/stores/modules/life-mode'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

import { imageJournalTools } from './builtin/image-journal'

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
      { id: 'tamagotchi:github_list_task_issues', defaultActive: false },
      { id: 'tamagotchi:github_list_open_prs', defaultActive: false },
      { id: 'tamagotchi:github_get_pr', defaultActive: false },
      { id: 'tamagotchi:github_get_pr_checks', defaultActive: false },
      { id: 'tamagotchi:github_post_pr_comment', defaultActive: false },
      { id: 'tamagotchi:plan_update', defaultActive: false },
      { id: 'tamagotchi:todo_write', defaultActive: false },
      { id: 'tamagotchi:task', defaultActive: false },
      { id: 'tamagotchi:flow_update', defaultActive: false },
      { id: 'tamagotchi:btw_ask', defaultActive: false },
      { id: 'tamagotchi:skill_submit', defaultActive: false },
      { id: 'tamagotchi:user_ask', defaultActive: false },
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
    expect(promptsStore.renderFor('social')).toContain('Live2D Appearance')
    expect(promptsStore.renderFor('work')).not.toContain('Live2D Appearance')
  })

  it('registers coding tools when the coding host reports them as available', async () => {
    listCodingTools.mockResolvedValue({
      workspaceRoot: 'C:/AIRI-workspace',
      shell: { kind: 'powershell', label: 'Windows PowerShell', syntax: 'powershell' },
      tools: ['list', 'grep', 'read', 'write', 'edit', 'bash', 'job_output', 'job_kill', 'setWorkspaceRoot', 'code_mode'].map(name => ({
        name,
        description: `${name} tool`,
        available: true,
      })),
    })

    const toolsStore = useLlmToolsStore()
    const promptsStore = useLlmToolsetPromptsStore()
    await useTamagotchiBuiltinToolsStore().refresh()

    expect(toolsStore.activeTools.map(tool => tool.function.name)).toEqual(['list', 'grep', 'read', 'write', 'edit', 'bash', 'job_output', 'job_kill', 'setWorkspaceRoot', 'code_mode'])
    // The declaration must name the interpreter the host resolved; a model told
    // "bash" on a PowerShell machine retries the same POSIX line forever.
    expect(toolsStore.getToolsByNames('bash')[0]?.function.description).toContain('Windows PowerShell')
    expect(promptsStore.activeToolsetPrompt).toContain('bash runs through Windows PowerShell')
    expect(toolsStore.getToolsByNames('list', 'grep', 'read', 'write', 'edit', 'bash', 'job_output', 'job_kill', 'setWorkspaceRoot', 'code_mode').map(tool => tool.function.name)).toEqual(['list', 'grep', 'read', 'write', 'edit', 'bash', 'job_output', 'job_kill', 'setWorkspaceRoot', 'code_mode'])
  })

  // 2026-09-12 multi-window reproduction: the settings (follower) window boots
  // the full Stage runtime; the life-mode watcher called `refresh` through its
  // closure, registered builtin definitions locally, and the synchronized
  // llm-tools store published that incomplete state over the leader's
  // discovered tool face (MCP and game tools disappeared within ~1 second).
  it('does not run local discovery when life mode changes in a follower window', async () => {
    vi.stubGlobal('location', new URL('http://localhost/?synced-leader=false'))
    try {
      vi.mocked(imageJournalTools).mockClear()
      const toolsStore = useLlmToolsStore()
      useTamagotchiBuiltinToolsStore()
      const lifeModeStore = useLifeModeStore()
      lifeModeStore.applySnapshot({
        ...lifeModeStore.snapshot,
        config: { ...lifeModeStore.snapshot.config, mode: 'autonomous' },
      })

      await nextTick()
      // Long enough for a full discovery pass with every factory mocked; the
      // leader control below completes well inside the same window.
      await new Promise(resolve => setTimeout(resolve, 100))

      expect(vi.mocked(imageJournalTools)).not.toHaveBeenCalled()
      expect(toolsStore.tools).toHaveLength(0)
      expect(toolsStore.registrations).toHaveLength(0)
    }
    finally {
      vi.unstubAllGlobals()
    }
  })

  it('re-registers builtin tools when life mode changes in the leader window', async () => {
    vi.stubGlobal('location', new URL('http://localhost/?synced-leader=true'))
    try {
      const toolsStore = useLlmToolsStore()
      useTamagotchiBuiltinToolsStore()
      const lifeModeStore = useLifeModeStore()
      lifeModeStore.applySnapshot({
        ...lifeModeStore.snapshot,
        config: { ...lifeModeStore.snapshot.config, mode: 'autonomous' },
      })

      await vi.waitFor(() => expect(toolsStore.tools.length).toBeGreaterThan(0))
      expect(toolsStore.registrations.length).toBe(toolsStore.tools.length)
    }
    finally {
      vi.unstubAllGlobals()
    }
  })
})
