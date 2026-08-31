import type { ExecutableTool } from '@proj-airi/stage-ui/stores/ai/chat-llm/tools'
import type { ChatToolReference } from '@proj-airi/stage-ui/types/chat'
import type { Tool } from '@xsai/shared-chat'

import { useLive2DCustomParameters } from '@proj-airi/stage-ui-live2d/stores/custom-parameters'
import { useExpressionStore } from '@proj-airi/stage-ui-live2d/stores/expression-store'
import { expressionTools } from '@proj-airi/stage-ui-live2d/tools/expression-tools'
import { mirrorTools } from '@proj-airi/stage-ui-live2d/tools/mirror-tools'
import { live2dParameterTools } from '@proj-airi/stage-ui-live2d/tools/parameter-tools'
import { useLlmToolsStore } from '@proj-airi/stage-ui/stores/ai/chat-llm/tools'
import { useLlmToolsetPromptsStore } from '@proj-airi/stage-ui/stores/ai/chat-llm/toolset-prompts'
import { captureMirrorSnapshot } from '@proj-airi/stage-ui/stores/mirror-snapshot'
import { useLifeModeStore } from '@proj-airi/stage-ui/stores/modules/life-mode'
import { useMemoryStore } from '@proj-airi/stage-ui/stores/modules/memory'
import { useSkillsReviewStore } from '@proj-airi/stage-ui/stores/skills'
import { createSelfTools } from '@proj-airi/stage-ui/tools/life/self-tools'
import { defineStore, storeToRefs } from 'pinia'
import { watch } from 'vue'

import { createCodingHostClient } from '../../bridges/coding-host'
import { codingTools } from './builtin/coding'
import { githubTools } from './builtin/github'
import { imageJournalTools } from './builtin/image-journal'
import { planTools } from './builtin/plan'
import { skillSubmitTools } from './builtin/skill-submit'
import { userAskTools } from './builtin/user-ask'
import { weatherTools } from './builtin/weather'
import { widgetsTools } from './builtin/widgets'

export const planToolReferences = [
  { name: 'plan_update' },
] satisfies ChatToolReference[]

/**
 * Self-authored tool loop entry (CAPABILITY-PLAN §五): the submission key.
 * Always mounted on chat sends so SHE can hand in a tool at any time.
 */
export const skillAuthoringToolReferences = [
  { name: 'skill_submit' },
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
  { name: 'list' },
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
  { name: 'mirror' },
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
  const lifeModeStore = useLifeModeStore()
  const toolIdPrefix = 'tamagotchi:'

  // Consideration-turn tools appear when life mode is anything but `off`
  // (LIFE-PLAN §二.2); re-registering on a mode switch keeps the toolset in
  // sync with the user's choice without a restart.
  watch(() => lifeModeStore.config.mode, () => {
    void refresh()
  })

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
    const customParameters = useLive2DCustomParameters()
    const parameterModelId = customParameters.discoveredKeys.at(-1)
    const exposedParameters = customParameters.llmExposedParameters(parameterModelId)

    if (exposedExpressions.length === 0 && exposedParameters.length === 0) {
      llmToolsetPromptsStore.clearToolsetPrompts('live2d-appearance')
      return
    }

    const sections: string[] = []

    if (exposedExpressions.length > 0) {
      sections.push([
        `Named expressions available now: ${exposedExpressions.join(', ')}.`,
        'Prefer expression_toggle or expression_set for these named looks; they are the rigger\'s intended combinations.',
      ].join('\n'))
    }

    if (exposedParameters.length > 0) {
      // Group-level overview only: listing all parameter ids here would drown
      // the prompt — live2d_parameter_list is the per-id discovery channel.
      const catalog = customParameters.discoveryFor(parameterModelId)
      const groupNames = new Map(catalog?.groups.map(group => [group.id, group.name]))
      const byGroup = new Map<string, number>()
      for (const parameter of exposedParameters)
        byGroup.set(parameter.groupId ?? '', (byGroup.get(parameter.groupId ?? '') ?? 0) + 1)
      const groupSummary = [...byGroup.entries()]
        .map(([groupId, count]) => `${groupNames.get(groupId) ?? groupId} (${count})`)
        .join(', ')

      sections.push([
        `You can also restyle your appearance with model-native parameters. Exposed groups: ${groupSummary}.`,
        'Call live2d_parameter_list for the exact ids, ranges, and current values; binary parameters (range 0 to 1) are off/on switches, stepped ranges are style slots.',
        'Combine several live2d_parameter_set entries in one call so a mood-driven change (hairstyle, ears, accessories) lands as one visual beat. Do not narrate the change; let it speak for itself.',
      ].join('\n'))
    }

    if (sections.length > 0) {
      sections.push('mirror returns your current appearance snapshot (expressions, held parameters, mood) — call it before changing how you look.')
    }

    llmToolsetPromptsStore.registerToolsetPrompts('live2d-appearance', [{
      id: 'live2d-appearance-overview',
      title: 'Live2D Appearance',
      content: sections.join('\n\n'),
    }])
  }

  async function refresh() {
    registerLive2dToolsetPrompt()
    registerCodingToolsetPrompt()
    registerPlanningToolsetPrompt()
    registerGithubWatchToolsetPrompt()
    registerSkillSubmitToolsetPrompt()
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

    const selfTools = lifeModeStore.config.mode === 'off'
      ? []
      : await createSelfTools()

    const tools = (await Promise.all([
      imageJournalTools(),
      widgetsTools(),
      weatherTools(),
      expressionTools(),
      live2dParameterTools(),
      // LIFE-PLAN M1: the mirror reads the memory store's mood through the
      // port (stage-ui-live2d does not depend on stage-ui). Pinia unwraps
      // setup-store refs on store access, so the ref is reached via storeToRefs.
      mirrorTools({
        getMood: () => {
          const { currentMood } = storeToRefs(useMemoryStore())
          return currentMood.value
        },
        getSnapshot: () => captureMirrorSnapshot(),
      }),
      githubTools(),
      planTools(),
      skillSubmitTools(),
      userAskTools(),
      Promise.resolve(selfTools),
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
        'Workspace tools: list, read, write, edit, bash, plus code_mode. Paths are relative to the workspace root.',
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
        'Call plan_update (action "focus") whenever you begin a new step, so tool results attach to that step as evidence. Focusing an approval-required step raises an approval card and waits for the decision.',
        'Keep executing within the turn: after a step completes, immediately focus and run the next one. Only end the turn when you are waiting for an approval card, waiting for a user answer, or every step is resolved.',
        'Never create confirmation-only steps ("wait for the user to agree"). If you need information or a decision mid-plan, ask directly in your reply — conversational confirmation is not plan evidence.',
        'A step with hard evidence completes automatically. Steps finished without their evidence must be marked with plan_update (action "complete") and show as unverified on the plan card; human_approval steps can only complete through a decided approval card. Saying "done" does not complete a step.',
      ].join('\n\n'),
    }])
  }

  /**
   * Tells the model how the GitHub watch loop works: the doorbell issue is
   * the inbox, reviews quote concrete changes, and one comment per review.
   */
  function registerGithubWatchToolsetPrompt() {
    llmToolsetPromptsStore.registerToolsetPrompts('github-watch', [{
      id: 'github-watch-overview',
      title: 'GitHub Watch',
      content: [
        'The github_* tools read and answer events in the watched repository. Start from github_list_task_issues: its airi-task issue is the doorbell inbox.',
        'For each PR event: read the diff with github_get_pr and CI with github_get_pr_checks before judging; then post ONE review comment with github_post_pr_comment quoting concrete files and lines.',
        'Be specific and kind: say what is good, what blocks merge, and what would unblock it. Never post more than one comment per review pass.',
      ].join('\n\n'),
    }])
  }

  /**
   * Tells the model how the self-authored tool loop works and that submitted
   * skills stay inert until the user reviews them.
   */
  function registerSkillSubmitToolsetPrompt() {
    llmToolsetPromptsStore.registerToolsetPrompts('skill-authoring', [{
      id: 'skill-authoring-overview',
      title: 'Authoring your own tools',
      content: [
        'skill_submit hands a self-contained JavaScript capability to the review queue: it is statically analyzed, persisted under workspace skills/<toolId>/, optionally self-tested in the sandbox, and only becomes callable after the user reviews it.',
        'Declare what the tool touches honestly — the analysis checks your declaration against the source, and any contradiction rejects the submission.',
        'While a skill is in probation or review, never call it. Call it only after the user approved it.',
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
