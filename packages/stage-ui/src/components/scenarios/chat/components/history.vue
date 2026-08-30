<script setup lang="ts">
import type { ChatOrchestratorCompactionSnapshot } from '@proj-airi/core-agent'
import type { VirtualizerHandle } from 'virtua/vue'

import type { CharacterSparkNotifyReaction } from '../../../../stores/character'
import type { PlanView } from '../../../../stores/plans'
import type { AttentionTask } from '../../../../stores/tasks'
import type { ChatHistoryItem, StreamingAssistantMessage } from '../../../../types/chat'
import type { ChatToolCallRendererRegistry } from './tool-call-renderer'

import { Virtualizer } from 'virtua/vue'
import { computed, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'

import ChatApprovalCard from './approval-card.vue'
import ChatAssistantItem from './assistant-item.vue'
import ChatCompactionNotice from './compaction-notice.vue'
import ChatErrorItem from './error-item.vue'
import ChatHistoryMessageFrame from './history-message-frame.vue'
import ChatPlanLanes from './plan-lanes.vue'
import ChatReactionLine from './reaction-line.vue'
import ChatReviewCard from './review-card.vue'
import ChatTaskCard from './task-card.vue'
import ChatUserItem from './user-item.vue'

import { useChatHistoryScroll } from '../composables/use-chat-history-scroll'
import { useChatHistoryTopFade } from '../composables/use-chat-history-top-fade'
import { useVirtualizerScroll } from '../composables/use-virtualizer-scroll'
import { getChatHistoryItemKey } from '../utils'

interface TimelineMessageItem {
  kind: 'message'
  message: ChatHistoryItem
  messageIndex: number
  createdAt?: number
}

interface TimelineReactionItem {
  kind: 'reaction'
  reaction: CharacterSparkNotifyReaction
  createdAt: number
}

interface TimelineTaskItem {
  kind: 'task'
  task: AttentionTask
  createdAt: number
}

interface TimelinePlanGroupItem {
  kind: 'plan-group'
  plans: readonly PlanView[]
  createdAt: number
}

type ChatTimelineItem = TimelineMessageItem | TimelineReactionItem | TimelineTaskItem | TimelinePlanGroupItem

const props = withDefaults(defineProps<{
  messages: ChatHistoryItem[]
  streamingMessage?: StreamingAssistantMessage
  reactions?: readonly CharacterSparkNotifyReaction[]
  tasks?: readonly AttentionTask[]
  plans?: readonly PlanView[]
  sending?: boolean
  assistantLabel?: string
  userLabel?: string
  errorLabel?: string
  retryLabel?: string
  variant?: 'desktop' | 'mobile'
  toolCallRenderers?: ChatToolCallRendererRegistry
  compaction?: ChatOrchestratorCompactionSnapshot
}>(), {
  sending: false,
  reactions: () => Object.freeze([] as CharacterSparkNotifyReaction[]),
  tasks: () => Object.freeze([] as AttentionTask[]),
  plans: () => Object.freeze([] as PlanView[]),
  variant: 'desktop',
  toolCallRenderers: () => ({}),
})

const emit = defineEmits<{
  (e: 'copyMessage', payload: { message: ChatHistoryItem, index: number, key: string | number }): void
  (e: 'deleteMessage', payload: { message: ChatHistoryItem, index: number, key: string | number }): void
  (e: 'retryMessage', payload: { message: ChatHistoryItem, index: number, key: string | number }): void
  (e: 'toolCallRerun', payload: { message: ChatHistoryItem, index: number, key: string | number, toolCallId: string, toolName: string, args: string }): void
}>()

/** Keeps about two mobile viewports ready so fast flicks do not expose an unmounted gap. */
const CHAT_HISTORY_OVERSCAN = 600

const chatHistoryRef = useTemplateRef<HTMLDivElement>('chatHistory')
const virtualizerRef = useTemplateRef<VirtualizerHandle>('virtualizer')
const { scrollToIndex } = useVirtualizerScroll(virtualizerRef)

const { t } = useI18n()
const labels = computed(() => ({
  assistant: props.assistantLabel ?? t('stage.chat.message.character-name.airi'),
  user: props.userLabel ?? t('stage.chat.message.character-name.you'),
  error: props.errorLabel ?? t('stage.chat.message.character-name.core-system'),
  retry: props.retryLabel ?? t('stage.chat.actions.retry'),
}))

const streaming = computed<StreamingAssistantMessage>(() => props.streamingMessage ?? { role: 'assistant', content: '', slices: [], tool_results: [] })
const showStreamingPlaceholder = computed(() => (streaming.value.slices?.length ?? 0) === 0 && !streaming.value.content)
function shouldShowPlaceholder(message: ChatHistoryItem) {
  return !!streaming.value.id && message.id === streaming.value.id
}

const timelineItems = computed<ChatTimelineItem[]>(() => {
  const items: Array<ChatTimelineItem & { order: number }> = props.messages.flatMap((message, messageIndex) => message.hiddenFromHistory
    ? []
    : [{
        kind: 'message' as const,
        message,
        messageIndex,
        createdAt: message.createdAt,
        order: messageIndex,
      }])

  const messageCount = items.length
  props.reactions.forEach((reaction, index) => {
    items.push({
      kind: 'reaction',
      reaction,
      createdAt: reaction.createdAt,
      order: messageCount + index,
    })
  })

  const taskOffset = items.length
  props.tasks.forEach((task, index) => {
    items.push({
      kind: 'task',
      task,
      createdAt: task.startedAt,
      order: taskOffset + index,
    })
  })

  if (props.plans.length > 0) {
    items.push({
      kind: 'plan-group',
      plans: props.plans,
      createdAt: Math.max(...props.plans.map(plan => plan.updatedAt)),
      order: items.length,
    })
  }

  return items
    .sort((left, right) => (left.createdAt ?? Number.MAX_SAFE_INTEGER) - (right.createdAt ?? Number.MAX_SAFE_INTEGER) || left.order - right.order)
    .map(({ order: _order, ...item }) => item)
})

const renderItems = computed<ChatTimelineItem[]>(() => {
  const items = [...timelineItems.value]
  if (!props.sending)
    return items

  const streamId = streaming.value.id
  if (!streamId)
    return items

  const hasStreamAlready = props.messages.some(message => message.role === 'assistant' && message.id === streamId)
  if (hasStreamAlready || streaming.value.hiddenFromHistory)
    return items

  items.push({
    kind: 'message',
    message: streaming.value,
    messageIndex: props.messages.length,
    createdAt: streaming.value.createdAt,
  })
  return items
})
const topFadeRatio = computed(() => props.variant === 'mobile' ? 0.2 : 0)

function getTimelineItemKey(item: ChatTimelineItem, _index: number): string | number {
  if (item.kind === 'message')
    return getChatHistoryItemKey(item.message, item.messageIndex)
  if (item.kind === 'reaction')
    return `reaction:${item.reaction.id}`
  if (item.kind === 'task')
    return `task:${item.task.taskId}`
  return 'plan-group'
}

function canRetryMessage(messageIndex: number) {
  return props.messages[messageIndex - 1]?.role === 'user'
}

useChatHistoryScroll({
  container: chatHistoryRef,
  messages: renderItems,
  getKey: getTimelineItemKey,
  scrollToIndex,
})
useChatHistoryTopFade({
  container: chatHistoryRef,
  fadeRatio: topFadeRatio,
})

function emitCopyMessage(message: ChatHistoryItem, index: number) {
  emit('copyMessage', {
    message,
    index,
    key: getChatHistoryItemKey(message, index),
  })
}

function emitDeleteMessage(message: ChatHistoryItem, index: number) {
  emit('deleteMessage', {
    message,
    index,
    key: getChatHistoryItemKey(message, index),
  })
}

function emitRetryMessage(message: ChatHistoryItem, index: number) {
  emit('retryMessage', {
    message,
    index,
    key: getChatHistoryItemKey(message, index),
  })
}

function emitToolCallRerun(
  message: ChatHistoryItem,
  index: number,
  payload: { toolCallId: string, toolName: string, args: string },
) {
  emit('toolCallRerun', {
    message,
    index,
    key: getChatHistoryItemKey(message, index),
    ...payload,
  })
}
</script>

<template>
  <div
    ref="chatHistory"
    :class="[
      'chat-history-list',
      'relative h-full w-full overflow-y-auto rounded-xl',
      '<sm:px-2 <sm:py-2',
      variant === 'mobile' ? 'chat-history-list--mobile' : '',
    ]"
  >
    <ChatCompactionNotice
      v-if="compaction"
      :compaction="compaction"
      :messages="messages"
    />
    <Virtualizer
      ref="virtualizer"
      :data="renderItems"
      :buffer-size="CHAT_HISTORY_OVERSCAN"
    >
      <template #default="{ item, index }">
        <ChatHistoryMessageFrame
          :key="getTimelineItemKey(item, index)"
          :variant="variant"
          :scroll-container="chatHistoryRef"
        >
          <ChatErrorItem
            v-if="item.kind === 'message' && item.message.role === 'error'"
            :message="item.message"
            :label="labels.error"
            :retry-label="labels.retry"
            :can-retry="canRetryMessage(item.messageIndex)"
            :show-placeholder="sending && index === renderItems.length - 1"
            :scroll-container="chatHistoryRef"
            :variant="variant"
            @copy="emitCopyMessage(item.message, item.messageIndex)"
            @retry="emitRetryMessage(item.message, item.messageIndex)"
            @delete="emitDeleteMessage(item.message, item.messageIndex)"
          />
          <ChatAssistantItem
            v-else-if="item.kind === 'message' && item.message.role === 'assistant'"
            :message="item.message"
            :label="labels.assistant"
            :show-placeholder="shouldShowPlaceholder(item.message) && showStreamingPlaceholder"
            :scroll-container="chatHistoryRef"
            :variant="variant"
            :tool-call-renderers="toolCallRenderers"
            @copy="emitCopyMessage(item.message, item.messageIndex)"
            @delete="emitDeleteMessage(item.message, item.messageIndex)"
            @tool-call-rerun="emitToolCallRerun(item.message, item.messageIndex, $event)"
          />
          <ChatUserItem
            v-else-if="item.kind === 'message' && item.message.role === 'user'"
            :message="item.message"
            :label="labels.user"
            :scroll-container="chatHistoryRef"
            :variant="variant"
            @copy="emitCopyMessage(item.message, item.messageIndex)"
            @delete="emitDeleteMessage(item.message, item.messageIndex)"
          />
          <ChatReactionLine
            v-else-if="item.kind === 'reaction'"
            :reaction="item.reaction"
          />
          <ChatTaskCard
            v-else-if="item.kind === 'task'"
            :task="item.task"
          />
          <ChatPlanLanes
            v-else-if="item.kind === 'plan-group'"
            :plans="item.plans"
          />
        </ChatHistoryMessageFrame>
      </template>
    </Virtualizer>

    <ChatApprovalCard />
    <ChatReviewCard />
  </div>
</template>

<style scoped>
.chat-history-list--mobile :deep(.chat-message-item-container) {
  --chat-top-fade-transparent-stop: -1px;
  --chat-top-fade-opaque-stop: 0px;

  -webkit-mask-image: linear-gradient(
    to bottom,
    transparent var(--chat-top-fade-transparent-stop),
    black var(--chat-top-fade-opaque-stop)
  );
  mask-image: linear-gradient(
    to bottom,
    transparent var(--chat-top-fade-transparent-stop),
    black var(--chat-top-fade-opaque-stop)
  );
  -webkit-mask-repeat: no-repeat;
  mask-repeat: no-repeat;
}
</style>
