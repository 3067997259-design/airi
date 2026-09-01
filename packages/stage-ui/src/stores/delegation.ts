import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { Tool } from '@xsai/shared-chat'

import { errorMessageFrom } from '@moeru/std'
import { streamFrom } from '@proj-airi/core-agent'
import { defineStore } from 'pinia'
import { shallowRef } from 'vue'

import { useLlmToolsStore } from './ai/chat-llm/tools'
import { useConsciousnessStore } from './modules/consciousness'

/**
 * Delegation to a bounded sub-run (HARNESS-PLAN §9.1).
 *
 * Searching a repository costs context: twenty grep hits and three long files
 * push the real work out of the window. A delegated run reads in its own
 * context and returns a short report, so the parent turn pays for the answer
 * instead of the search.
 *
 * Two rules make it safe rather than another way to lose track of what is
 * true. The child gets read-only tools, so nothing it decides can change the
 * workspace. And its report is a claim, not evidence: the authority order puts
 * tool output above model text, and a report is model text no matter how many
 * tools produced it (DESIGN-PRINCIPLES §三).
 */

/** Tools a delegated run may call. Read-only by construction. */
export const DELEGATION_TOOL_NAMES: readonly string[] = Object.freeze(['grep', 'read', 'list'])

/** Step budget for one delegated run; a search that needs more should be split. */
const DELEGATION_MAX_STEPS = 12

/** Characters kept from the report; a long answer defeats the purpose. */
const MAX_REPORT_LENGTH = 4_000

export interface DelegationState {
  running: number
  lastObjective?: string
  lastReport?: string
  error?: string
}

export interface DelegationInput {
  objective: string
  model: string
  chatProvider: ChatProvider
  /** Read-only tools for the child; the caller resolves them. */
  tools: Tool[]
}

const IDLE_STATE: DelegationState = Object.freeze({ running: 0 })

export const useDelegationStore = defineStore('runtime-delegation', () => {
  const state = shallowRef<DelegationState>(IDLE_STATE)

  /** Runs one delegated search and returns its report text. */
  async function delegate(input: DelegationInput): Promise<string> {
    const objective = input.objective.trim()
    if (!objective)
      return 'No objective was given.'

    state.value = { ...state.value, running: state.value.running + 1, lastObjective: objective }
    let report = ''
    try {
      await streamFrom({
        model: input.model,
        chatProvider: input.chatProvider,
        messages: [
          {
            role: 'system',
            content: [
              'You are a delegated worker inside AIRI. You answer one question about a workspace and nothing else.',
              'You have read-only tools. You cannot write, edit, or run commands, and you must not claim that you did.',
              'Search first, then answer in at most ten lines: what you found, with path and line references.',
              'If you cannot find it, say so plainly and name where you looked. A guess is worse than a gap.',
            ].join('\n'),
          },
          { role: 'user', content: objective },
        ],
        options: {
          maxSteps: DELEGATION_MAX_STEPS,
          tools: input.tools,
          onStreamEvent: (event) => {
            if (event.type === 'text-delta')
              report += event.text
          },
        },
      })

      const trimmed = report.trim().slice(0, MAX_REPORT_LENGTH)
      state.value = { ...state.value, running: state.value.running - 1, lastReport: trimmed }
      return trimmed
    }
    catch (error) {
      const message = errorMessageFrom(error) ?? 'unknown error'
      state.value = { ...state.value, running: state.value.running - 1, error: message }
      return `delegation failed: ${message}`
    }
  }

  /**
   * Delegates with the active provider and the read-only tool set.
   *
   * The tool surface stays fixed here rather than at the call site: a caller
   * that could widen it would turn a read-only helper into a second writer.
   */
  async function delegateActive(objective: string): Promise<string> {
    const consciousness = useConsciousnessStore()
    const model = consciousness.activeModel
    const providerId = consciousness.activeProvider
    if (!model || !providerId)
      return 'delegation failed: no active chat provider or model configured'

    const chatProvider = await consciousness.getChatProviderInstance(providerId)
    if (!chatProvider)
      return `delegation failed: could not resolve chat provider "${providerId}"`

    const tools = useLlmToolsStore().getToolsByNames(...DELEGATION_TOOL_NAMES)
    return delegate({ objective, model, chatProvider, tools })
  }

  return {
    state,
    delegate,
    delegateActive,
  }
})
