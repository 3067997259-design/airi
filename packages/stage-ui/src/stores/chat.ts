import type { ChatOrchestratorCompactionSnapshot, ChatOrchestratorCompactionSummaryInput, ChatOrchestratorRuntimeState, ChatOrchestratorSendOptions, StreamEvent, StreamOptions } from '@proj-airi/core-agent'
import type { MemoryExtraction, MemoryMood, MemorySourceContext } from '@proj-airi/memory-core'
import type { WebSocketEventInputs } from '@proj-airi/server-sdk'
import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { Message } from '@xsai/shared-chat'
import type {} from 'pinia-plugin-synced'

import type { ChatHistoryItem, ChatToolReference, StreamingAssistantMessage } from '../types/chat'
import type { ToolCallRerunPayload } from './tool-call-rerun'

import { errorMessageFrom } from '@moeru/std'
import { buildAttentionModeSection, createChatOrchestratorRuntime, modelKey, resolveAttentionMode } from '@proj-airi/core-agent'
import { IOAttributes, IOEvents, IOSpanNames, IOSubsystems } from '@proj-airi/stage-shared'
import { nanoid } from 'nanoid'
import { defineStore, storeToRefs } from 'pinia'
import { shallowRef, toRaw } from 'vue'
import { useI18n } from 'vue-i18n'

import { getConversationAnalyticsSurface } from '../composables'
import { activeTurnSpan, startSpan } from '../composables/use-io-tracer'
import {
  buildStageProtocolSection,
  containsStageProtocol,
  OUTPUT_FORMATTING_SECTION,
  TOOLS_UNAVAILABLE_SECTION,
} from '../constants/prompts/system-sections'
import {
  AIRI_CHAT_APP_SURFACE_HEADER,
  AIRI_CHAT_ROUND_ID_HEADER,
  AIRI_CHAT_SESSION_ID_HEADER,
} from '../libs/analytics-headers'
import { createChatAnalyticsHooks, getProviderMode } from '../libs/analytics/events/chat'
import { extractMessageText, isCloudSyncableMessage } from '../libs/chat-sync'
import { useLLM } from './ai/chat-llm/llm'
import { resolveLlmTools } from './ai/chat-llm/tool-resolver'
import { useLlmToolsStore } from './ai/chat-llm/tools'
import { useLlmToolsetPromptsStore } from './ai/chat-llm/toolset-prompts'
import { useAttentionStore } from './attention'
import { createMinecraftContext } from './chat/context-providers'
import { useChatContextStore } from './chat/context-store'
import { useChatSessionStore } from './chat/session-store'
import { useChatStreamStore } from './chat/stream-store'
import { useContextObservabilityStore } from './devtools/context-observability'
import { useJournalStore } from './journal'
import { useAiriCardStore } from './modules/airi-card'
import { useAutonomousArtistryStore } from './modules/artistry-autonomous'
import { useConsciousnessStore } from './modules/consciousness'
import { useMemoryStore } from './modules/memory'
import { useWebSearchStore } from './modules/web-search'
import { usePlanStore } from './plans'
import { useProviderStore } from './providers/provider'
import { useSkillsReviewStore } from './skills'
import { useTaskStore } from './tasks'
import { executeToolCallRerun } from './tool-call-rerun'

interface ForkOptions {
  fromSessionId?: string
  atIndex?: number
  reason?: string
  hidden?: boolean
}

/** A serializable chat request that any application context can send to the leader. */
export interface ChatSendPayload {
  /** Image attachments for the new user message. */
  attachments?: { type: 'image', data: string, mimeType: string }[]
  /** Original input metadata for chat hooks and telemetry. */
  input?: WebSocketEventInputs
  /** Session that owns the new turn. */
  sessionId: string
  /** User text for the new turn. */
  text: string
  /** Request-specific tools selected by their model-facing names. */
  tools?: ChatToolReference[]
}

/** The durable messages appended while one chat request executes. */
export interface ChatSendResult {
  messages: ChatHistoryItem[]
  sessionId: string
}

/** Identifies one stored message whose user turn must run again. */
export interface ChatRetryPayload {
  index: number
  sessionId: string
  tools?: ChatToolReference[]
}

/** Identifies one stored tool call that must run again in the leader. */
export interface ChatToolCallRerunPayload extends Omit<ToolCallRerunPayload, 'sessionId' | 'toolset'> {
  sessionId: string
}

type ProviderHistoryMessage = Exclude<ChatHistoryItem, { role: 'error' }>

function toProviderHistory(messages: ChatHistoryItem[]): Message[] {
  return messages.filter((message): message is ProviderHistoryMessage => message.role !== 'error')
}

function isTextDelta(event: StreamEvent): event is Extract<StreamEvent, { type: 'text-delta' }> {
  return event.type === 'text-delta'
}

function retryTextFrom(message: ChatHistoryItem | undefined): string | null {
  if (!message || message.role !== 'user')
    return null

  if (typeof message.content === 'string') {
    const text = message.content.trim()
    return text || null
  }

  if (!Array.isArray(message.content))
    return null

  const text = message.content.reduce<string[]>((texts, part) => {
    if (part.type !== 'text')
      return texts

    const value = part.text?.trim()
    if (value)
      texts.push(value)

    return texts
  }, []).join('\n\n')

  return text || null
}

function retrySourceIndexFrom(messages: ChatHistoryItem[], index: number): number {
  const targetMessage = messages[index]
  if (!targetMessage)
    return -1

  if (targetMessage.role === 'user')
    return index

  if (targetMessage.role !== 'assistant' && targetMessage.role !== 'error')
    return -1

  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (messages[cursor]?.role === 'user')
      return cursor
  }

  return -1
}

const MEMORY_NEIGHBOR_MESSAGE_LIMIT = 4
const MEMORY_NEIGHBOR_CHARACTER_LIMIT = 600

function createMemorySourceContext(sessionId: string, userMessageId: string, messages: ChatHistoryItem[]): MemorySourceContext {
  const sourceIndex = messages.findIndex(message => message.id === userMessageId)
  if (sourceIndex < 0) {
    return {
      sessionId,
      messageId: userMessageId,
      neighbors: [],
    }
  }

  const messagesBefore = messages.slice(Math.max(0, sourceIndex - Math.floor(MEMORY_NEIGHBOR_MESSAGE_LIMIT / 2)), sourceIndex)
  const messagesAfter = messages.slice(sourceIndex + 1, sourceIndex + 1 + Math.ceil(MEMORY_NEIGHBOR_MESSAGE_LIMIT / 2))
  const neighbors = [...messagesBefore, ...messagesAfter]
    .filter(message => message.role === 'user' || message.role === 'assistant')
    .map((message) => {
      const content = extractMessageText(message).trim()
      if (!content)
        return undefined

      const label = message.role === 'user' ? 'User' : 'Assistant'
      return `${label}: ${content.slice(0, MEMORY_NEIGHBOR_CHARACTER_LIMIT)}`
    })
    .filter((message): message is string => !!message)
    .slice(0, MEMORY_NEIGHBOR_MESSAGE_LIMIT)

  return {
    sessionId,
    messageId: userMessageId,
    neighbors,
  }
}

export type { QueuedSendSnapshot } from '@proj-airi/core-agent'

export const useChatStore = defineStore('chat', () => {
  const { t } = useI18n()
  const llmStore = useLLM()
  const llmToolsStore = useLlmToolsStore()
  const llmToolsetPromptsStore = useLlmToolsetPromptsStore()
  // Instantiate the web-search store eagerly so its `configured` watcher registers
  // WEB_SEARCH_TOOLSET_PROMPT before getSystemPromptSupplement is read below. The
  // tool resolver that would otherwise be the first to create this store runs after
  // the system prompt is composed, which would expose web_search on the first turn
  // without its paired prompt-injection defense.
  useWebSearchStore()
  const consciousnessStore = useConsciousnessStore()
  const memoryStore = useMemoryStore()
  const taskStore = useTaskStore()
  const attentionStore = useAttentionStore()
  const skillsStore = useSkillsReviewStore()
  const planStore = usePlanStore()
  const artistryAutonomousStore = useAutonomousArtistryStore()
  const { activeModel, activeProvider } = storeToRefs(consciousnessStore)
  const chatSession = useChatSessionStore()
  const chatStream = useChatStreamStore()
  const chatContext = useChatContextStore()
  const cardStore = useAiriCardStore()
  const contextObservability = useContextObservabilityStore()
  const journalStore = useJournalStore()
  const { activeSessionId } = storeToRefs(chatSession)
  const { streamingMessage } = storeToRefs(chatStream)

  function extractTextFromContent(content: unknown): string {
    if (typeof content === 'string')
      return content

    if (!Array.isArray(content))
      return ''

    return content
      .filter((part): part is { text: string } => typeof part === 'object' && part !== null && 'text' in part && typeof part.text === 'string')
      .map(part => part.text)
      .join('\n')
  }

  function isMemoryExtraction(value: unknown): value is Omit<MemoryExtraction, 'sessionId'> {
    if (typeof value !== 'object' || value === null)
      return false

    const record = value as Record<string, unknown>
    return typeof record.content === 'string'
      && record.content.trim().length > 0
      && typeof record.category === 'string'
      && (record.memoryType === 'short_term' || record.memoryType === 'muscle')
      && typeof record.importance === 'number'
      && typeof record.valence === 'number'
      && typeof record.arousal === 'number'
      && Array.isArray(record.tags)
      && record.tags.every(tag => typeof tag === 'string')
  }

  async function extractMemoryTurn(input: { sessionId: string, userText: string, assistantText: string, mood?: MemoryMood }): Promise<MemoryExtraction[]> {
    const providerId = memoryStore.activeProvider || activeProvider.value
    const model = memoryStore.activeModel || activeModel.value
    if (!providerId || !model)
      return []

    const chatProvider = await consciousnessStore.getChatProviderInstance(providerId)
    if (!chatProvider)
      return []

    let response = ''
    try {
      await llmStore.stream(model, chatProvider, [
        {
          role: 'system',
          content: 'Extract durable facts from one chat turn. Return only a JSON array. Use memoryType short_term or muscle. Return an empty array when no fact is durable.',
        },
        {
          role: 'user',
          content: JSON.stringify({ user: input.userText, assistant: input.assistantText }),
        },
      ], {
        onStreamEvent: (event) => {
          if (event.type === 'text-delta')
            response += event.text
        },
      })
    }
    catch (error) {
      console.warn('[Memory] Extraction failed.', errorMessageFrom(error) ?? error)
      return []
    }

    try {
      const json = response.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
      const parsed = JSON.parse(json) as unknown
      if (!Array.isArray(parsed))
        return []

      return parsed.filter(isMemoryExtraction).map(extraction => ({
        ...extraction,
        sessionId: input.sessionId,
      }))
    }
    catch (error) {
      console.warn('[Memory] Extraction returned invalid JSON.', errorMessageFrom(error) ?? error)
      return []
    }
  }

  async function summarizeCompactedHistory(input: ChatOrchestratorCompactionSummaryInput): Promise<string> {
    const providerId = memoryStore.activeProvider || activeProvider.value
    const model = memoryStore.activeModel || activeModel.value
    if (!providerId || !model)
      return ''

    const chatProvider = await consciousnessStore.getChatProviderInstance(providerId)
    if (!chatProvider)
      return ''

    let response = ''
    try {
      await llmStore.stream(model, chatProvider, [
        {
          role: 'system',
          content: 'Summarize the earlier chat history in concise factual prose. Preserve people, decisions, unresolved questions, and emotional context. Return only the summary.',
        },
        {
          role: 'user',
          content: JSON.stringify({ removedTurnCount: input.removedTurnCount, history: input.originalItems }),
        },
      ], {
        onStreamEvent: (event) => {
          if (event.type === 'text-delta')
            response += event.text
        },
      })
    }
    catch (error) {
      console.warn('[Memory] Summary generation failed.', errorMessageFrom(error) ?? error)
    }

    return response.trim()
  }

  const sending = shallowRef(false)
  const activeSendSessionId = shallowRef<string>()
  const activeStreamingMessage = shallowRef<StreamingAssistantMessage>()
  const pendingQueuedSendCount = shallowRef(0)
  const compactions = shallowRef<Record<string, ChatOrchestratorCompactionSnapshot>>({})
  let ownedActiveTurnSpan: typeof activeTurnSpan.value
  const analyticsHooks = createChatAnalyticsHooks({
    getSessionMessages: sessionId => chatSession.getSessionMessages(sessionId),
  })

  async function streamWithStageAdapters(
    model: string,
    chatProvider: ChatProvider,
    messages: Message[],
    options?: StreamOptions,
  ) {
    let llmTextLength = 0
    let llmOutputChunkCount = 0
    const llmOutputChunkLengths: number[] = []
    const headers = { ...options?.headers }
    if (getProviderMode(activeProvider.value) === 'official' && options?.requestCorrelation) {
      headers[AIRI_CHAT_SESSION_ID_HEADER] = options.requestCorrelation.conversationId
      headers[AIRI_CHAT_ROUND_ID_HEADER] = options.requestCorrelation.roundId
      headers[AIRI_CHAT_APP_SURFACE_HEADER] = getConversationAnalyticsSurface()
    }

    const hadExistingTurn = !!activeTurnSpan.value
    if (!hadExistingTurn) {
      const turnSpan = startSpan(IOSpanNames.InteractionTurn)
      activeTurnSpan.value = turnSpan
      ownedActiveTurnSpan = turnSpan
    }

    const llmSpan = startSpan(IOSpanNames.LLMInference, activeTurnSpan.value, {
      [IOAttributes.Subsystem]: IOSubsystems.LLM,
      [IOAttributes.GenAIRequestModel]: model,
      [IOAttributes.LLMInputMessageCount]: messages.length,
      [IOAttributes.LLMInputUserMessageCount]: messages.filter(message => message.role === 'user').length,
      [IOAttributes.TurnId]: options?.requestCorrelation?.roundId ?? '',
    })
    llmSpan.setAttribute(IOAttributes.LLMInputMessageRoles, messages.map(message => message.role))
    const llmRequestTs = performance.now()
    let llmFirstTokenEmitted = false

    try {
      await llmStore.stream(model, chatProvider, messages, {
        ...options,
        headers,
        onStreamEvent: async (event: StreamEvent) => {
          if (isTextDelta(event)) {
            llmOutputChunkCount += 1
            llmOutputChunkLengths.push(event.text.length)
            if (!llmFirstTokenEmitted) {
              llmFirstTokenEmitted = true
              llmSpan.addEvent(IOEvents.LLMFirstToken, {
                [IOAttributes.LLM_TTFT]: performance.now() - llmRequestTs,
              })
            }
            llmTextLength += event.text.length
          }

          await options?.onStreamEvent?.(event)
        },
      })
    }
    finally {
      llmSpan.setAttribute(IOAttributes.LLMOutputChunkCount, llmOutputChunkCount)
      llmSpan.setAttribute(IOAttributes.LLMOutputChunkLengths, llmOutputChunkLengths)
      llmSpan.setAttribute(IOAttributes.LLMTextLength, llmTextLength)
      llmSpan.end()
    }
  }

  function syncRuntimeState(state: ChatOrchestratorRuntimeState) {
    sending.value = state.sending
    activeSendSessionId.value = state.activeSendSessionId
    activeStreamingMessage.value = state.activeStreamingMessage
    pendingQueuedSendCount.value = state.pendingQueuedSendCount
    compactions.value = state.compactions
  }

  function settleOwnedActiveTurnSpan() {
    if (!ownedActiveTurnSpan)
      return

    ownedActiveTurnSpan.end()
    if (activeTurnSpan.value === ownedActiveTurnSpan)
      activeTurnSpan.value = undefined
    ownedActiveTurnSpan = undefined
  }

  const runtime = createChatOrchestratorRuntime({
    session: {
      ensureSession: sessionId => chatSession.ensureSession(sessionId),
      getSessionMessages: sessionId => chatSession.getSessionMessages(sessionId).map(message => toRaw(message)),
      appendSessionMessage: (sessionId, message) => chatSession.appendSessionMessage(sessionId, message),
      getSessionGeneration: sessionId => chatSession.getSessionGeneration(sessionId),
    },
    context: {
      ingest: envelope => chatContext.ingestContextMessage(envelope),
      snapshot: () => chatContext.getContextsSnapshot(),
    },
    memory: {
      retrieve: async ({ query, sessionId }) => (await memoryStore.retrieve(query, sessionId)).map(fragment => ({
        id: fragment.id,
        content: fragment.content,
        score: fragment.score,
        context: fragment.sourceContext?.neighbors,
      })),
    },
    compaction: {
      enabled: () => memoryStore.compactionEnabled,
      contextLength: (model) => {
        if (memoryStore.contextLengthOverride > 0)
          return memoryStore.contextLengthOverride

        // Non-browser adapters have no provider catalog injection. Returning
        // zero delegates to the runtime's stable fallback context length.
        if (typeof document === 'undefined')
          return 0

        // Resolve the provider catalog only when compaction actually needs a
        // model-reported limit. Provider queries use browser injection, so
        // ordinary chat-store consumers must not initialize them eagerly.
        const providerStore = useProviderStore()
        if (typeof providerStore.getModelsForProvider !== 'function')
          return 0

        return providerStore.getModelsForProvider(activeProvider.value)
          .find(candidate => candidate.id === model)
          ?.contextLength ?? 0
      },
      threshold: () => memoryStore.compactionThreshold,
      recentTurnLimit: () => memoryStore.compactionRecentTurnLimit,
      fallbackContextLength: () => 32_000,
      summarize: summarizeCompactedHistory,
    },
    journal: {
      startSession: sessionId => journalStore.ensureSession(sessionId),
      append: (sessionId, event) => journalStore.append(sessionId, event),
    },
    getActivePlanStep: () => {
      const plan = planStore.activePlan
      const stepId = plan?.state.currentStepId
      if (!plan || !stepId)
        return undefined
      const step = plan.spec.steps.find(candidate => candidate.id === stepId)
      if (!step)
        return undefined
      return { planId: plan.id, stepId, allowedTools: step.allowedTools }
    },
    foregroundStream: {
      patch: (message) => {
        streamingMessage.value = message
      },
      reset: () => {
        streamingMessage.value = { role: 'assistant', content: '', slices: [], tool_results: [] }
      },
    },
    llm: {
      stream: streamWithStageAdapters,
    },
    getActiveSessionId: () => activeSessionId.value,
    getActiveProvider: () => activeProvider.value,
    getSystemPromptSupplement: (model, chatProvider) => {
      // App-owned sections ride on the send-time supplement so the persisted
      // session system message stays pure character identity. Legacy cards
      // already embed the stage protocol in their description; skip re-injecting
      // it for them to avoid duplicating hundreds of tokens.
      const sections: string[] = []
      if (!containsStageProtocol(cardStore.systemPrompt))
        sections.push(buildStageProtocolSection(t))
      sections.push(buildAttentionModeSection(resolveAttentionMode(taskStore.tasks, attentionStore.focusedModeEnabled)))
      const planProjection = planStore.promptProjection()
      if (planProjection)
        sections.push(planProjection)
      sections.push(OUTPUT_FORMATTING_SECTION)
      if (model && chatProvider && llmStore.degradedToolKeys.includes(modelKey(model, chatProvider)))
        sections.push(TOOLS_UNAVAILABLE_SECTION)
      else if (llmToolsetPromptsStore.activeToolsetPrompt)
        sections.push(llmToolsetPromptsStore.activeToolsetPrompt)
      return sections.filter(section => section.trim().length > 0).join('\n\n')
    },
    getPostHistoryInstruction: () => cardStore.activeCard?.postHistoryInstructions,
    runtimeContextProviders: [
      createMinecraftContext,
    ],
    createId: nanoid,
    unwrapMessage: message => toRaw(message),
    onStateChange: syncRuntimeState,
    onSendSettled: settleOwnedActiveTurnSpan,
    ...analyticsHooks,
    onLifecycle: record => contextObservability.recordLifecycle(record),
    onPromptProjection: payload => contextObservability.capturePromptProjection(payload),
    onUserMessageAppended: ({ sessionId, message, messageText, source, model, provider, roundId, turnIndex }) => {
      analyticsHooks.onUserMessageAppended?.({
        sessionId,
        message,
        messageText,
        source,
        model,
        provider,
        roundId,
        turnIndex,
      })
      if (isCloudSyncableMessage(message)) {
        void chatSession.pushMessageToCloud(sessionId, {
          id: message.id,
          role: 'user',
          content: messageText,
        })
      }
    },
    onAssistantMessageAppended: ({ sessionId, message }) => {
      if (isCloudSyncableMessage(message) && message.id) {
        void chatSession.pushMessageToCloud(sessionId, {
          id: message.id,
          role: 'assistant',
          content: extractMessageText(message),
        })
      }
    },
    onUserTurnReady: ({ messageText, sessionMessages }) => {
      const autonomousTarget = cardStore.activeCard?.extensions?.airi?.modules?.artistry?.autonomousTarget || 'user'
      if (autonomousTarget === 'user')
        void artistryAutonomousStore.runArtistTask(messageText, toProviderHistory(sessionMessages))
    },
    onChatTurnComplete: ({ sessionId, chat, context, userMessageId, sessionMessages }) => {
      const userText = extractTextFromContent(context.message.content).trim()
      if (!userText)
        return

      void memoryStore.captureTurn({
        sessionId,
        userText,
        assistantText: chat.outputText,
        sourceContext: createMemorySourceContext(sessionId, userMessageId, sessionMessages),
      }, (input: { sessionId: string, userText: string, assistantText: string, mood: MemoryMood }) => extractMemoryTurn(input))
    },
    onAssistantTurnReady: ({ messageText, sessionMessages }) => {
      const artistry = cardStore.activeCard?.extensions?.airi?.modules?.artistry
      if (artistry?.autonomousEnabled && artistry?.autonomousTarget === 'assistant')
        void artistryAutonomousStore.runArtistTask(messageText, toProviderHistory(sessionMessages))
    },
  })

  async function ingest(
    sendingMessage: string,
    options: ChatOrchestratorSendOptions,
    targetSessionId?: string,
  ) {
    return runtime.ingest(sendingMessage, options, targetSessionId)
  }

  /** Runs the provider-only history compaction for the active session. */
  async function compactActiveSession() {
    const providerId = activeProvider.value
    const model = activeModel.value
    if (!providerId || !model)
      return false

    const chatProvider = await consciousnessStore.getChatProviderInstance(providerId)
    if (!chatProvider)
      return false

    await runtime.compactNow(activeSessionId.value, model, chatProvider)
    return true
  }

  function collectToolReferences(sessionId: string, selectedTools: ChatToolReference[] = [], activatedSkillNames: string[] = []): ChatToolReference[] {
    const names = new Set<string>()

    for (const message of chatSession.getSessionMessages(sessionId)) {
      for (const tool of message.tools ?? [])
        names.add(tool.name)
    }

    for (const tool of selectedTools)
      names.add(tool.name)

    for (const toolName of activatedSkillNames)
      names.add(toolName)

    return [...names].map(name => ({ name }))
  }

  function appendSendError(sessionId: string, error: unknown) {
    if (!chatSession.getSessionMessagesIfLoaded(sessionId))
      return

    chatSession.appendSessionMessage(sessionId, {
      // id + createdAt anchor the item in the sorted, virtualized timeline:
      // without a timestamp the sort would demote it to the top of a long
      // history, outside the virtualized viewport at the message tail.
      id: nanoid(),
      role: 'error',
      content: errorMessageFrom(error) ?? 'Unknown chat operation failure',
      createdAt: Date.now(),
    })
  }

  async function executeSend(payload: ChatSendPayload): Promise<ChatSendResult> {
    const providerId = activeProvider.value
    const modelId = activeModel.value
    if (!providerId || !modelId)
      throw new Error('No active chat provider or model configured')

    if (!await chatSession.loadSession(payload.sessionId))
      throw new Error('Failed to load the target chat session')

    const messageCount = chatSession.getSessionMessages(payload.sessionId).length
    const chatProvider = await consciousnessStore.getChatProviderInstance(providerId)
    if (!chatProvider)
      throw new Error(`Failed to resolve chat provider "${providerId}"`)

    const activatedSkillNames = skillsStore.prepareForPrompt(payload.text)
    await runtime.ingest(payload.text, {
      model: modelId,
      chatProvider,
      attachments: payload.attachments,
      input: payload.input,
      toolReferences: payload.tools,
      // Resolve this function after the request reaches the per-session queue.
      // The history then contains tool names from every earlier queued turn.
      tools: async () => {
        const references = collectToolReferences(payload.sessionId, payload.tools, activatedSkillNames)
        return llmToolsStore.getToolsByNames(...references.map(tool => tool.name))
      },
    }, payload.sessionId)

    const completedMessages = chatSession.getSessionMessagesIfLoaded(payload.sessionId)
    if (!completedMessages)
      throw new Error('Chat session was removed before send completed')

    return {
      messages: completedMessages
        .slice(messageCount)
        .map(message => structuredClone(toRaw(message))),
      sessionId: payload.sessionId,
    }
  }

  /** Sends one serializable chat request through the elected leader. */
  async function send(payload: ChatSendPayload): Promise<ChatSendResult> {
    try {
      return await executeSend(payload)
    }
    catch (error) {
      appendSendError(payload.sessionId, error)
      throw error
    }
  }

  /** Replaces one stored turn with a new execution of its user message. */
  async function retry(payload: ChatRetryPayload): Promise<ChatSendResult> {
    if (!await chatSession.loadSession(payload.sessionId))
      throw new Error('Failed to load the target chat session')

    const currentMessages = chatSession.getSessionMessages(payload.sessionId)
    const sourceIndex = retrySourceIndexFrom(currentMessages, payload.index)
    if (sourceIndex < 0)
      throw new Error('Retry target has no retriable source message')

    const sourceMessage = currentMessages[sourceIndex]
    const text = retryTextFrom(sourceMessage)
    if (!text)
      throw new Error('Retry target has no retriable user message')

    runtime.clearCompaction(payload.sessionId)
    chatSession.setSessionMessages(payload.sessionId, currentMessages.slice(0, sourceIndex))

    try {
      return await executeSend({
        sessionId: payload.sessionId,
        text,
        tools: payload.tools ?? sourceMessage?.tools,
      })
    }
    catch (error) {
      appendSendError(payload.sessionId, error)
      throw error
    }
  }

  /** Runs one stored tool call again and replaces its stored result. */
  async function rerunToolCall(payload: ChatToolCallRerunPayload): Promise<void> {
    if (!await chatSession.loadSession(payload.sessionId))
      throw new Error('Failed to load the target chat session')

    const nextMessages = await executeToolCallRerun({
      messages: chatSession.getSessionMessages(payload.sessionId),
      payload,
      resolveTools: () => resolveLlmTools({
        customTools: llmToolsStore.getToolsByNames(payload.toolName),
      }),
    })
    chatSession.setSessionMessages(payload.sessionId, nextMessages)
  }

  /** Clears one session and stops runtime work that still belongs to it. */
  function cleanup(sessionId: string) {
    chatSession.cleanupMessages(sessionId)
    chatContext.resetContexts()
    runtime.clearCompaction(sessionId)
    runtime.cancelPendingSends(sessionId)
    chatStream.resetStream()
  }

  /** Cancels queued work before permanently removing its owning session. */
  function deleteSession(sessionId: string): Promise<void> {
    runtime.cancelPendingSends(sessionId)
    runtime.clearCompaction(sessionId)
    return chatSession.deleteSession(sessionId)
  }

  async function ingestOnFork(
    sendingMessage: string,
    options: ChatOrchestratorSendOptions,
    forkOptions?: ForkOptions,
  ) {
    const baseSessionId = forkOptions?.fromSessionId ?? activeSessionId.value
    if (!forkOptions)
      return ingest(sendingMessage, options, baseSessionId)

    const forkSessionId = await chatSession.forkSession({
      fromSessionId: baseSessionId,
      atIndex: forkOptions.atIndex,
      reason: forkOptions.reason,
      hidden: forkOptions.hidden,
    })
    return ingest(sendingMessage, options, forkSessionId || baseSessionId)
  }

  function cancelPendingSends(sessionId?: string) {
    runtime.cancelPendingSends(sessionId)
  }

  function getPendingQueuedSendSnapshot() {
    return runtime.getPendingQueuedSendSnapshot()
  }

  return {
    sending,
    activeSendSessionId,
    activeStreamingMessage,
    pendingQueuedSendCount,
    compactions,

    cleanup,
    deleteSession,
    ingest,
    compactActiveSession,
    ingestOnFork,
    rerunToolCall,
    retry,
    send,
    cancelPendingSends,
    getPendingQueuedSendSnapshot,

    clearHooks: runtime.hooks.clearHooks,

    emitBeforeMessageComposedHooks: runtime.hooks.emitBeforeMessageComposedHooks,
    emitAfterMessageComposedHooks: runtime.hooks.emitAfterMessageComposedHooks,
    emitBeforeSendHooks: runtime.hooks.emitBeforeSendHooks,
    emitAfterSendHooks: runtime.hooks.emitAfterSendHooks,
    emitTokenLiteralHooks: runtime.hooks.emitTokenLiteralHooks,
    emitTokenSpecialHooks: runtime.hooks.emitTokenSpecialHooks,
    emitStreamEndHooks: runtime.hooks.emitStreamEndHooks,
    emitAssistantResponseEndHooks: runtime.hooks.emitAssistantResponseEndHooks,
    emitAssistantMessageHooks: runtime.hooks.emitAssistantMessageHooks,
    emitChatTurnCompleteHooks: runtime.hooks.emitChatTurnCompleteHooks,

    onBeforeMessageComposed: runtime.hooks.onBeforeMessageComposed,
    onAfterMessageComposed: runtime.hooks.onAfterMessageComposed,
    onBeforeSend: runtime.hooks.onBeforeSend,
    onAfterSend: runtime.hooks.onAfterSend,
    onTokenLiteral: runtime.hooks.onTokenLiteral,
    onTokenSpecial: runtime.hooks.onTokenSpecial,
    onStreamEnd: runtime.hooks.onStreamEnd,
    onAssistantResponseEnd: runtime.hooks.onAssistantResponseEnd,
    onAssistantMessage: runtime.hooks.onAssistantMessage,
    onChatTurnComplete: runtime.hooks.onChatTurnComplete,
  }
}, {
  synced: {
    actions: ['cleanup', 'deleteSession', 'rerunToolCall', 'retry', 'send', 'compactActiveSession'],
    state: true,
  },
})
