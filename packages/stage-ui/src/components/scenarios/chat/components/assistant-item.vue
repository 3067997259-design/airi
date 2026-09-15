<script setup lang="ts">
import type { ChatAssistantMessage, ChatHistoryItem, ChatSlices, ChatSlicesText, ChatSlicesToolCallResult } from '../../../../types/chat'
import type { ChatToolCallRendererRegistry } from './tool-call-renderer'

import { isStageCapacitor, isStageWeb } from '@proj-airi/stage-shared'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import ChatResponsePart from './response-part.vue'
import ChatToolCallBlock from './tool-call-block.vue'

import { MarkdownRenderer } from '../../../markdown'
import { getChatHistoryItemCopyText } from '../utils'
import { ChatActionMenu } from './action-menu'
import { createToolCallResultLookup, resolveToolCallBlockState } from './tool-call-results'

const props = withDefaults(defineProps<{
  message: ChatAssistantMessage
  label: string
  scrollContainer?: HTMLElement | null
  showPlaceholder?: boolean
  variant?: 'desktop' | 'mobile'
  /**
   * Drops tool-call slices from the bubble. Flow-iteration turns use it: their
   * tool activity is owned by the task activity panel, and rendering it here
   * too would show the same call twice (TASK-RUN-AND-UI-PLAN batch B).
   */
  hideToolSlices?: boolean
  toolCallRenderers?: ChatToolCallRendererRegistry
}>(), {
  showPlaceholder: false,
  scrollContainer: null,
  variant: 'desktop',
  hideToolSlices: false,
  toolCallRenderers: () => ({}),
})

const emit = defineEmits<{
  (e: 'copy'): void
  (e: 'delete'): void
  (e: 'toolCallRerun', payload: { toolCallId: string, toolName: string, args: string }): void
}>()

const { t } = useI18n()

const resolvedSlices = computed<ChatSlices[]>(() => {
  let slices: ChatSlices[]
  if (props.message.slices?.length) {
    slices = props.message.slices
  }
  else if (typeof props.message.content === 'string' && props.message.content.trim()) {
    slices = [{ type: 'text', text: props.message.content } satisfies ChatSlicesText]
  }
  else if (Array.isArray(props.message.content)) {
    const textPart = props.message.content.find(part => 'type' in part && part.type === 'text') as { text?: string } | undefined
    slices = textPart?.text
      ? [{ type: 'text', text: textPart.text } satisfies ChatSlicesText]
      : []
  }
  else {
    slices = []
  }

  if (!props.hideToolSlices)
    return slices
  return slices.filter(slice => slice.type !== 'tool-call' && slice.type !== 'tool-call-result')
})

const toolResultById = computed(() => {
  return createToolCallResultLookup(resolvedSlices.value, props.message.tool_results)
})

function getToolCallResult(slice: ChatSlices): ChatSlicesToolCallResult | undefined {
  if (slice.type !== 'tool-call') {
    return undefined
  }

  return toolResultById.value.get(slice.toolCall.toolCallId)
}

function getToolCallState(slice: ChatSlices): 'executing' | 'done' | 'error' {
  return resolveToolCallBlockState(getToolCallResult(slice))
}

function getToolCallRenderer(slice: ChatSlices) {
  if (slice.type !== 'tool-call') {
    return ChatToolCallBlock
  }

  return props.toolCallRenderers[slice.toolCall.toolName] ?? ChatToolCallBlock
}

const showLoader = computed(() => props.showPlaceholder && resolvedSlices.value.length === 0)
// MQ-2 D6: a finished turn can end on tool calls with no text (step budget
// exhausted or the provider stopped after tools). Show an explicit notice
// instead of leaving an empty assistant bubble.
const showEmptyTextNotice = computed(() => {
  if (props.showPlaceholder || resolvedSlices.value.length === 0)
    return false
  if (resolvedSlices.value.some(slice => slice.type === 'text' && slice.text.trim().length > 0))
    return false
  return resolvedSlices.value.some(slice => slice.type === 'tool-call')
})
const containerClass = computed(() => props.variant === 'mobile' ? 'mr-0' : 'mr-12')
const boxClasses = computed(() => [
  props.variant === 'mobile'
    ? ['px-2 py-2 text-sm', 'bg-primary-50/60 backdrop-blur-xl dark:bg-primary-950/60']
    : ['px-3 py-3', 'bg-primary-50/80 dark:bg-primary-950/75'],
])
const copyText = computed(() => getChatHistoryItemCopyText(props.message as ChatHistoryItem))
</script>

<template>
  <div flex :class="['font-cute', containerClass]" class="ph-no-capture">
    <ChatActionMenu
      :copy-text="copyText"
      :can-delete="!showPlaceholder"
      :scroll-container="scrollContainer"
      @copy="emit('copy')"
      @delete="emit('delete')"
    >
      <template #default="{ setMeasuredElement }">
        <div
          :ref="setMeasuredElement"
          flex="~ col" shadow="sm primary-200/50 dark:none"
          min-w-20 gap-2 rounded-xl h="unset <sm:fit"
          :class="[
            'chat-message-item-container',
            boxClasses,
            (isStageWeb() || isStageCapacitor()) && props.variant === 'mobile' ? 'select-none sm:select-auto' : '',
          ]"
        >
          <ChatResponsePart
            v-if="message.categorization"
            :message="message"
            :variant="variant"
          />
          <div class="<sm:hidden">
            <span text-sm text="black/60 dark:white/65" font-normal>{{ label }}</span>
          </div>
          <div v-if="resolvedSlices.length > 0" class="flex flex-col gap-2 break-words" text="primary-700 dark:primary-100">
            <template v-for="(slice, sliceIndex) in resolvedSlices" :key="sliceIndex">
              <component
                :is="getToolCallRenderer(slice)"
                v-if="slice.type === 'tool-call'"
                :tool-call-id="slice.toolCall.toolCallId"
                :tool-name="slice.toolCall.toolName"
                :args="slice.toolCall.args"
                :state="getToolCallState(slice)"
                :result="getToolCallResult(slice)?.result"
                @tool-call-rerun="emit('toolCallRerun', $event)"
              />
              <template v-else-if="slice.type === 'tool-call-result'" />
              <template v-else-if="slice.type === 'text'">
                <MarkdownRenderer :content="slice.text" />
              </template>
            </template>
          </div>
          <div v-else-if="showLoader" i-eos-icons:three-dots-loading />
          <div
            v-if="showEmptyTextNotice"
            :class="['text-sm', 'italic', 'text-black/45', 'dark:text-white/45']"
          >
            {{ t('stage.chat.message.no-text-output') }}
          </div>
        </div>
      </template>
    </ChatActionMenu>
  </div>
</template>
