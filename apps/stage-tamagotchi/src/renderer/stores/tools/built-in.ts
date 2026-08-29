import type { ExecutableTool } from '@proj-airi/stage-ui/stores/ai/chat-llm/tools'
import type { ChatToolReference } from '@proj-airi/stage-ui/types/chat'
import type { Tool } from '@xsai/shared-chat'

import { useExpressionStore } from '@proj-airi/stage-ui-live2d/stores/expression-store'
import { expressionTools } from '@proj-airi/stage-ui-live2d/tools/expression-tools'
import { live2dParameterTools } from '@proj-airi/stage-ui-live2d/tools/parameter-tools'
import { useLlmToolsStore } from '@proj-airi/stage-ui/stores/ai/chat-llm/tools'
import { useLlmToolsetPromptsStore } from '@proj-airi/stage-ui/stores/ai/chat-llm/toolset-prompts'
import { useSkillsReviewStore } from '@proj-airi/stage-ui/stores/skills'
import { defineStore } from 'pinia'

import { createCodingHostClient } from '../../bridges/coding-host'
import { codingTools } from './builtin/coding'
import { imageJournalTools } from './builtin/image-journal'
import { planTools } from './builtin/plan'
import { weatherTools } from './builtin/weather'
import { widgetsTools } from './builtin/widgets'

export const planToolReferences = [
  { name: 'plan_update' },
] satisfies ChatToolReference[]

export const widgetToolReferences = [
  { name: 'stage_widgets' },
  { name: 'get_weather' },
] satisfies ChatToolReference[]

/**
 * Hashline file tools (CODING-HARNESS-DESIGN §2). Registered as long as the
 * main-process coding host is reachable; the bridge degrades gracefully (see
 * `refresh`).
 */
export const codingToolReferences = [
  { name: 'read' },
  { name: 'write' },
  { name: 'edit' },
  { name: 'bash' },
] satisfies ChatToolReference[]

export const codingReferences = [...codingToolReferences] satisfies ChatToolReference[]

/**
 * Live2D appearance controls, referenced when a turn should be able to change
 * how the character looks. Both stores gate these on the user's exposure
 * setting, so registering them is safe even when the user opted out.
 */
export const live2dAppearanceToolReferences = [
  { name: 'expression_set' },
  { name: 'expression_get' },
  { name: 'expression_toggle' },
  { name: 'expression_reset_all' },
  { name: 'live2d_parameter_list' },
  { name: 'live2d_parameter_set' },
  { name: 'live2d_parameter_release' },
] satisfies ChatToolReference[]

export const artistryToolReferences = [
  { name: 'image_journal' },
  ...widgetToolReferences,
  ...live2dAppearanceToolReferences,
] satisfies ChatToolReference[]

export const useTamagotchiBuiltinToolsStore = defineStore('tamagotchi-builtin-tools', () => {
  const llmToolsStore = useLlmToolsStore()
  const llmToolsetPromptsStore = useLlmToolsetPromptsStore()
  const expressionStore = useExpressionStore()
  const skillsStore = useSkillsReviewStore()
  const toolIdPrefix = 'tamagotchi:'

  function registeredToolIds() {
    return llmToolsStore.tools
      .filter(tool => tool.id.startsWith(toolIdPrefix))
      .map(tool => tool.id)
  }

  /**
   * Tells the model that the Live2D appearance tools exist and which of the two
   * layers to reach for. Without this it sees seven tool names and no reason to
   * prefer the named expressions over raw parameter ids, or vice versa.
   *
   * Omitted entirely when the user exposed nothing, so an opted-out setup costs
   * no prompt tokens.
   */
  function registerLive2dToolsetPrompt() {
    const exposedExpressions = expressionStore.llmExposedGroups.map(group => group.name)
    if (exposedExpressions.length === 0) {
      llmToolsetPromptsStore.clearToolsetPrompts('live2d-appearance')
      return
    }

    llmToolsetPromptsStore.registerToolsetPrompts('live2d-appearance', [{
      id: 'live2d-appearance-overview',
      title: 'Live2D Appearance',
      content: [
        `You can change your own Live2D appearance. Named expressions available now: ${exposedExpressions.join(', ')}.`,
        'Prefer expression_toggle or expression_set for these named looks; they are the rigger\'s intended combinations.',
        'Use live2d_parameter_list and live2d_parameter_set only for finer changes an expression cannot make (hairstyle, pupil style, ears, accessories). Set several parameters in one call so the change lands as one visual beat.',
        'Give expression_set a duration when a reaction should fade on its own, and call expression_reset_all to return to a neutral face. Do not narrate these calls; let the change speak for itself.',
      ].join('\n\n'),
    }])
  }

  async function refresh() {
    registerLive2dToolsetPrompt()
    registerCodingToolsetPrompt()
    registerPlanningToolsetPrompt()
    skillsStore.syncRuntimeTools()

    // The coding host bridge can be transiently unavailable (main process
    // not ready, provisioning failed); register the four tools only when it
    // answers, mirroring the M2 degraded-toolset behavior.
    let coding = [] as Tool[]
    try {
      const tools = await codingTools()
      const availability = await createCodingHostClient().listTools()
      const availableNames = new Set(availability.tools.filter(tool => tool.available).map(tool => tool.name))
      coding = tools.filter(tool => availableNames.has(tool.function.name))
    }
    catch {
      coding = []
    }

    const tools = (await Promise.all([
      imageJournalTools(),
      widgetsTools(),
      weatherTools(),
      expressionTools(),
      live2dParameterTools(),
      planTools(),
    ])).flat()

    llmToolsStore.removeToolsByIds(...registeredToolIds())
    llmToolsStore.addTools(...tools.map(tool => ({
      ...tool,
      defaultActive: false,
      id: `${toolIdPrefix}${tool.function.name}`,
    } satisfies ExecutableTool)), ...coding.map(tool => ({
      ...tool,
      defaultActive: true,
      id: `${toolIdPrefix}${tool.function.name}`,
    } satisfies ExecutableTool)))
  }

  /**
   * Tells the model how to use the Hashline edit protocol. Without this it
   * would copy whole lines; with signatures, edits are structurally safe.
   */
  function registerCodingToolsetPrompt() {
    llmToolsetPromptsStore.registerToolsetPrompts('coding-hashline', [{
      id: 'coding-hashline-overview',
      title: 'File editing (Hashline)',
      content: [
        'Workspace tools: read, write, edit, bash, plus code_mode. Paths are relative to the workspace root.',
        'edit works by content signature: after read, reference the short signature shown before each line, plus the first 16-32 characters of that line as expectedPrefix.',
        'If edit returns STATE_CHANGED or prefix_mismatch, the file changed — re-read it and retry with a fresh signature. Rejections are not failures.',
        'For tasks needing several tool operations, prefer code_mode: write one program that bridges the tools and runs them in a sandbox; you get one result with a per-call trace.',
        'bash commands are tiered; high-risk commands (push, delete, network, production, publish) require user approval. Use read-only commands (tests, git status/diff, logs) freely.',
      ].join('\n\n'),
    }])
  }

  /**
   * Tells the model when and how to plan. Without it the model would either
   * ignore the plan tool or, worse, treat its own completion claims as the
   * finish line instead of collecting evidence.
   */
  function registerPlanningToolsetPrompt() {
    llmToolsetPromptsStore.registerToolsetPrompts('planning', [{
      id: 'planning-overview',
      title: 'Planning',
      content: [
        'For multi-step tasks, create a plan first with plan_update (action "start"): a goal plus small ordered steps, each declaring its allowed tools and expected evidence.',
        'Call plan_update (action "focus") whenever you begin a new step, so tool results attach to that step as evidence.',
        'A step is completed only when its evidence exists — an allowed tool result, a verification, or a user approval. Saying "done" does not complete a step; the plan card tracks real evidence.',
      ].join('\n\n'),
    }])
  }

  return { refresh }
}, {
  synced: {
    actions: ['refresh'],
    state: false,
  },
})
