<script setup lang="ts">
import type { ChatSendDelivery } from '@proj-airi/core-agent'
import type { ChatToolCallRendererRegistry } from '@proj-airi/stage-ui/components'
import type { ChatHistoryItem } from '@proj-airi/stage-ui/types/chat'

import { errorMessageFrom } from '@moeru/std'
import { useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { useStopSpeakingButton } from '@proj-airi/stage-layouts/composables/useStopSpeakingButton'
import { ChatBtwCard, ChatHistory, ChatPlanCenter, ChatQuestionCard, JournalPreviewModal } from '@proj-airi/stage-ui/components'
import { useAnalytics } from '@proj-airi/stage-ui/composables/use-analytics'
import { restoredOwner } from '@proj-airi/stage-ui/services/restore-gate'
import { useBackgroundStore } from '@proj-airi/stage-ui/stores/background'
import { useCharacterStore } from '@proj-airi/stage-ui/stores/character'
import { useChatStore } from '@proj-airi/stage-ui/stores/chat'
import { useChatSessionStore } from '@proj-airi/stage-ui/stores/chat/session-store'
import { useChatStreamStore } from '@proj-airi/stage-ui/stores/chat/stream-store'
import { CODING_APPROVAL_MODES, useCodingToolsStore } from '@proj-airi/stage-ui/stores/coding'
import { useJournalPreviewStore } from '@proj-airi/stage-ui/stores/journal-preview'
import { useAiriCardStore } from '@proj-airi/stage-ui/stores/modules/airi-card'
import { useConsciousnessStore } from '@proj-airi/stage-ui/stores/modules/consciousness'
import { planSurfaceLanes, resolveFlowEvidencePlan, usePlanStore } from '@proj-airi/stage-ui/stores/plans'
import { useSkillsReviewStore } from '@proj-airi/stage-ui/stores/skills'
import { useTaskStore } from '@proj-airi/stage-ui/stores/tasks'
import { BasicTextarea, Button } from '@proj-airi/ui'
import { useEventListener, useLocalStorage } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuRoot, DropdownMenuTrigger } from 'reka-ui'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'

import JournalToolCallBlock from './chat-tool-renderers/journal-tool-call-block.vue'
import TriggerPanel from './trigger-panel.vue'

import { electronOpenSettings } from '../../shared/eventa'
import { createSlashTriggerProvider } from '../composables/slash-trigger-provider'
import { useHearingInputChannel } from '../composables/use-hearing-input-channel'
import { useTriggerPanel } from '../composables/use-trigger-panel'
import { createWorkspaceTriggerProvider } from '../composables/workspace-trigger-provider'
import { artistryToolReferences, githubReadToolReferences, skillAuthoringToolReferences, todoToolReferences, userAskToolReferences, widgetToolReferences } from '../stores/tools'

const router = useRouter()
const messageInput = ref('')
useHearingInputChannel(messageInput)
const { t } = useI18n()
const codingStore = useCodingToolsStore()

const skillsReviewStore = useSkillsReviewStore()
const {
  sections: slashSections,
  isOpen: isSlashPanelOpen,
  onInput: onSlashInput,
  onKeyDown: onSlashKeyDown,
  select: selectSlashItem,
  selectedIndex: slashSelectedIndex,
  close: closeSlashPanel,
} = useTriggerPanel(messageInput, createSlashTriggerProvider(
  () => skillsReviewStore.reviewedSkills,
  key => t(key),
))
const {
  sections: workspaceSections,
  isOpen: isWorkspacePanelOpen,
  onInput: onWorkspaceInput,
  onKeyDown: onWorkspaceKeyDown,
  select: selectWorkspaceItem,
  selectedIndex: workspaceSelectedIndex,
  close: closeWorkspacePanel,
} = useTriggerPanel(messageInput, createWorkspaceTriggerProvider(
  path => codingStore.listDir(path),
  kind => t(`stage.workspace-reference.${kind}`),
))
const lastEnterTime = ref(0)
const attachments = ref<{ type: 'image', data: string, mimeType: string, url: string }[]>([])

const chatStore = useChatStore()
const chatSession = useChatSessionStore()
const chatStream = useChatStreamStore()
const planStore = usePlanStore()
const backgroundStore = useBackgroundStore()
const journalPreviewStore = useJournalPreviewStore()
const airiCardStore = useAiriCardStore()
const consciousnessStore = useConsciousnessStore()
const openSettings = useElectronEventaInvoke(electronOpenSettings)

const { activeSessionId, messages, sessionMetas } = storeToRefs(chatSession)
const { streamingMessage } = storeToRefs(chatStream)
const { activeSendSessionId, activeStreamingMessage, compactions, queuedSends, sending, flowStates } = storeToRefs(chatStore)
const { reactions } = storeToRefs(useCharacterStore())
const { tasks } = storeToRefs(useTaskStore())
const { planViews: allPlanViews } = storeToRefs(planStore)
// All plans scoped to this window: current session plus long goals of other
// sessions, which are browsed from the plan center instead of the timeline.
const planViews = computed(() => {
  const current = activeSessionId.value
  return allPlanViews.value.filter(plan =>
    plan.spec.horizon === 'long'
    || !plan.sessionId
    || plan.sessionId === current)
})
// The timeline only carries live work of the session this window shows, plus
// unattributed plans in their own lane. Terminal records, other sessions'
// live long goals, and session plans superseded by a newer plan in the same
// lane move to the plan center (UI-2); before this, finished and superseded
// cards accumulated in every chat until they filled the viewport
// (2026-09-11 field report).
const surfaceLanes = computed(() => planSurfaceLanes(planViews.value, activeSessionId.value))
const timelinePlans = computed(() => planViews.value.filter((plan) => {
  const lane = surfaceLanes.value.get(plan.id)
  return lane === 'current' || lane === 'unattributed'
}))
const sessionLabels = computed<Record<string, string>>(() => {
  const labels: Record<string, string> = {}
  for (const meta of Object.values(sessionMetas.value)) {
    if (meta.title)
      labels[meta.sessionId] = meta.title
  }
  return labels
})
const { activeCard, activeCardId } = storeToRefs(airiCardStore)
const { openImagePreview } = journalPreviewStore
const isComposing = ref(false)
const DOUBLE_ENTER_INTERVAL_MS = 300
const TRAILING_NEWLINES_REGEX = /[\r\n]+$/
const SEND_MODES = ['enter', 'ctrl-enter', 'double-enter'] as const
type SendMode = (typeof SEND_MODES)[number]
const sendMode = useLocalStorage<SendMode>('ui/chat/settings/send-mode', 'enter')
const toolCallRenderers = {
  image_journal: JournalToolCallBlock,
  text_journal: JournalToolCallBlock,
} satisfies ChatToolCallRendererRegistry
const sendModeLabels = computed<Record<SendMode, string>>(() => ({
  'enter': t('stage.send-mode.enter'),
  'ctrl-enter': t('stage.send-mode.ctrl-enter'),
  'double-enter': t('stage.send-mode.double-enter'),
}))
const approvalMode = codingStore.approvalMode
// Cycle the tri-state: require -> substitute -> full -> require.
const APPROVAL_MODE_ICONS: Record<string, string> = {
  require: 'i-solar:shield-warning-bold-duotone',
  substitute: 'i-solar:shield-check-bold-duotone',
  full: 'i-solar:shield-bold-duotone',
}
function cycleApprovalMode() {
  const current = approvalMode.value
  const next = CODING_APPROVAL_MODES[(CODING_APPROVAL_MODES.indexOf(current) + 1) % CODING_APPROVAL_MODES.length]
  void codingStore.setApprovalMode(next)
}
const {
  trackChatMessageDeleted,
  trackChatMessageRetried,
  trackChatMessagesCleared,
} = useAnalytics()
const { showStopSpeakingButton, stopSpeakingFromChat } = useStopSpeakingButton()

const latestImageEntries = computed(() => {
  if (!activeCardId.value)
    return []
  return backgroundStore.journalEntries.slice(0, 3)
})

function navigateToImageJournal() {
  if (!activeCardId.value)
    return
  router.push(`/settings/airi-card?cardId=${activeCardId.value}&tab=gallery`)
}

async function handleSend(delivery: ChatSendDelivery = 'next-step') {
  if (isComposing.value) {
    return
  }

  if (!messageInput.value.trim() && !attachments.value.length) {
    return
  }

  const textToSend = messageInput.value
  const attachmentsToSend = attachments.value.map(att => ({ ...att }))
  // The active session can change while the cross-window request is pending.
  // Keep one correlation key for both the send and its failure recovery.
  const targetSessionId = chatSession.activeSessionId

  if (!targetSessionId) {
    // A restored or signed-out profile has no selected session. Sending used
    // to clear the draft and then silently restore it, so the user saw a dead
    // input (ACC-20260911 #11). Name the reason and offer the same owner
    // message the onboarding screen uses.
    toast.warning(restoredOwner.value
      ? t('stage.chat.no-active-session-restored', { owner: restoredOwner.value })
      : t('stage.chat.no-active-session'))
    return
  }

  // optimistic clear
  messageInput.value = ''
  attachments.value = []
  closeSlashPanel()
  closeWorkspacePanel()

  try {
    await chatStore.send({
      sessionId: targetSessionId,
      text: textToSend,
      attachments: attachmentsToSend,
      delivery,
      tools: [...artistryToolReferences, ...githubReadToolReferences, ...skillAuthoringToolReferences, ...todoToolReferences, ...userAskToolReferences],
    })

    attachmentsToSend.forEach(att => URL.revokeObjectURL(att.url))
  }
  catch (error) {
    const errorMessage = errorMessageFrom(error) ?? String(error)
    const wasCancelledForDeletedSession
      = errorMessage.includes('Chat session was reset before send could start')
        || errorMessage.includes('Chat session was removed before send completed')
        || errorMessage.includes('Queued chat send was cancelled')
    if (!wasCancelledForDeletedSession && chatSession.activeSessionId === targetSessionId) {
      const currentDraft = messageInput.value
      messageInput.value = currentDraft ? `${textToSend}\n${currentDraft}` : textToSend
      attachments.value = [...attachmentsToSend, ...attachments.value]
    }
    else {
      // This window no longer owns a visible attachment preview, so its Blob
      // URLs must be released instead of surviving until the window closes.
      attachmentsToSend.forEach(attachment => URL.revokeObjectURL(attachment.url))
    }
    // The draft restoration above was the only feedback before; a failure the
    // window does not own silently disappeared (ACC-20260911 #11).
    if (!wasCancelledForDeletedSession)
      toast.error(t('stage.chat.send-failed', { reason: errorMessage }))
  }
}

function sendFromKeyboard(delivery: ChatSendDelivery = 'next-step') {
  messageInput.value = messageInput.value.replace(TRAILING_NEWLINES_REGEX, '')
  void handleSend(delivery)
}

// Declared above the keyboard handler: Enter steers or queues the active turn,
// and Escape stops it, so both branches read this before the template does.
const isActiveSessionSending = computed(() => sending.value && activeSendSessionId.value === activeSessionId.value)
// Task projection for the timeline's activity panel (TASK-RUN-AND-UI-PLAN B).
const activeTaskRuns = computed(() => chatStore.taskRuns)
// The composer indicator reads the live runtime flow for the iteration number;
// the timeline's activity panel is driven by the journal projection instead.
const activeFlow = computed(() => {
  const flow = flowStates.value[activeSessionId.value]
  return flow?.status === 'running' ? flow : undefined
})
// The step she is on right now, so the indicator says what the flow is doing,
// not only that it is running. Resolved through the same lane logic the
// evidence channel and the prompt projection use: iterating every plan in the
// store used to pick the focused step of some unrelated historical plan and
// froze the indicator on an old goal's text (ACC-20260909 UI-2).
const activeFlowStep = computed(() => {
  if (!activeFlow.value)
    return undefined
  const plan = resolveFlowEvidencePlan(planViews.value, { sessionId: activeSessionId.value })
  const stepId = plan?.state.currentStepId
  if (!plan || !stepId)
    return undefined
  return plan.spec.steps.find(candidate => candidate.id === stepId)
})

function handleAbort() {
  void chatStore.abortActiveSend(activeSessionId.value)
}

function handleFlowStop() {
  void chatStore.endFlow(activeSessionId.value, 'interrupted', 'flow stopped from the composer')
}

/**
 * Navigates the window to the conversation that owns a plan.
 *
 * The plan center names the source on every foreign goal, so this is the
 * recovery path from "what is she doing over there?". A deleted source session
 * rejects the switch; the toast is the visible refusal the plan surface owes
 * the user instead of a dead click.
 */
async function handleOpenPlanSource(sessionId: string) {
  try {
    await chatSession.setActiveSession(sessionId)
  }
  catch (error) {
    toast.error(t('stage.chat.plan-center.open-source-failed', { reason: errorMessageFrom(error) ?? String(error) }))
  }
}

// TUI convention (HARNESS-PLAN §3.1): Esc interrupts from anywhere, not only
// while the composer holds focus. A trigger panel keeps its own Escape (it
// closes the panel) and the turn is left alone; the same applies while an IME
// composition is in flight, where Esc belongs to the candidate window.
useEventListener(window, 'keydown', (event: KeyboardEvent) => {
  if (event.key !== 'Escape' || event.isComposing || isComposing.value)
    return
  if (isSlashPanelOpen.value || isWorkspacePanelOpen.value)
    return
  if (!isActiveSessionSending.value)
    return
  event.preventDefault()
  handleAbort()
})

const fileInput = ref<HTMLInputElement | null>(null)

function handleManualAttach() {
  fileInput.value?.click()
}

function handleFileSelect(event: Event) {
  const target = event.target as HTMLInputElement
  if (target.files?.length) {
    handleFilePaste(Array.from(target.files))
  }
}

function handleMessageInputKeydown(event: KeyboardEvent) {
  if (isComposing.value)
    return

  if (onWorkspaceKeyDown(event) || onSlashKeyDown(event))
    return

  if (event.key !== 'Enter')
    return

  const hasControl = event.ctrlKey || event.metaKey
  const hasShift = event.shiftKey

  if (isActiveSessionSending.value && !hasControl) {
    event.preventDefault()
    sendFromKeyboard(hasShift ? 'next-turn' : 'next-step')
    return
  }

  switch (sendMode.value) {
    case 'enter':
      if (!hasShift && !hasControl) {
        event.preventDefault()
        sendFromKeyboard()
      }
      return
    case 'ctrl-enter':
      if (hasControl) {
        event.preventDefault()
        sendFromKeyboard()
      }
      return
    case 'double-enter':
      if (!hasShift && !hasControl) {
        const now = Date.now()
        if (now - lastEnterTime.value < DOUBLE_ENTER_INTERVAL_MS) {
          event.preventDefault()
          sendFromKeyboard()
          lastEnterTime.value = 0
        }
        else {
          lastEnterTime.value = now
        }
      }
  }
}

function handleMessageInput() {
  void Promise.all([onSlashInput(), onWorkspaceInput()])
}

async function handleFilePaste(files: File[]) {
  for (const file of files) {
    if (file.type.startsWith('image/')) {
      const reader = new FileReader()
      reader.onload = (e) => {
        const base64Data = (e.target?.result as string)?.split(',')[1]
        if (base64Data) {
          attachments.value.push({
            type: 'image' as const,
            data: base64Data,
            mimeType: file.type,
            url: URL.createObjectURL(file),
          })
        }
      }
      reader.readAsDataURL(file)
    }
  }
}

function removeAttachment(index: number) {
  const attachment = attachments.value[index]
  if (attachment) {
    URL.revokeObjectURL(attachment.url)
    attachments.value.splice(index, 1)
  }
}

watch(sendMode, () => {
  lastEnterTime.value = 0
})

const historyMessages = computed(() => messages.value as unknown as ChatHistoryItem[])
const assistantLabel = computed(() => activeCard.value?.name?.trim() || undefined)
const visibleStreamingMessage = computed(() => activeSendSessionId.value === activeSessionId.value
  ? activeStreamingMessage.value
  : streamingMessage.value)
const activeCompaction = computed(() => compactions.value[activeSessionId.value])
const activeQueuedSends = computed(() => queuedSends.value.filter(send => send.sessionId === activeSessionId.value))

/**
 * Why the composer cannot send right now, with the copy the notice shows.
 *
 * A restored signed-out profile used to keep an enabled input whose sends
 * bounced silently (FIX-LIST #11 / UI-D). Both blockers now disable the input
 * and name the reason plus the recovery entry. The toast in `handleSend`
 * stays for the race where the session disappears after typing.
 */
const composerBlock = computed<{ reason: 'session' | 'provider', message: string } | undefined>(() => {
  if (!activeSessionId.value) {
    return {
      reason: 'session',
      message: restoredOwner.value
        ? t('stage.chat.no-active-session-restored', { owner: restoredOwner.value })
        : t('stage.chat.no-active-session'),
    }
  }
  if (!consciousnessStore.configured) {
    return { reason: 'provider', message: t('stage.chat.no-provider') }
  }
  return undefined
})

function cancelQueuedSend(id: string) {
  chatStore.cancelQueuedSend(id)
}

async function handleDeleteMessage(index: number) {
  const message = messages.value[index]
  await chatSession.deleteMessage({
    sessionId: chatSession.activeSessionId,
    index,
  })
  trackChatMessageDeleted({
    source: 'history',
    message_role: message?.role ?? 'unknown',
  })
}

onMounted(async () => {
  backgroundStore.initializeStore()
  await planStore.initialize()
})

async function handleRetryMessage(index: number) {
  await chatStore.retry({
    sessionId: chatSession.activeSessionId,
    index,
    tools: widgetToolReferences,
  })
  trackChatMessageRetried({
    source: 'history',
  })
}

async function handleToolCallRerun(payload: { message: ChatHistoryItem, index: number, key: string | number, toolCallId: string, toolName: string, args: string }) {
  await chatStore.rerunToolCall({
    sessionId: chatSession.activeSessionId,
    messageId: payload.message.id,
    index: payload.index,
    toolCallId: payload.toolCallId,
    toolName: payload.toolName,
    args: payload.args,
  })
}

async function handleCleanupMessages() {
  const messageCount = messages.value.filter(message => message.role !== 'system').length
  await chatStore.cleanup(chatSession.activeSessionId)
  trackChatMessagesCleared({
    source: 'chat_controls',
    message_count: messageCount,
  })
}
</script>

<template>
  <div h-full w-full flex="~ col gap-1">
    <div w-full flex-1 overflow-hidden>
      <ChatHistory
        :messages="historyMessages"
        :reactions="reactions"
        :tasks="tasks"
        :plans="timelinePlans"
        :task-runs="activeTaskRuns"
        :assistant-label="assistantLabel"
        :sending="isActiveSessionSending"
        :streaming-message="visibleStreamingMessage"
        :compaction="activeCompaction"
        :tool-call-renderers="toolCallRenderers"
        @delete-message="handleDeleteMessage($event.index)"
        @retry-message="handleRetryMessage($event.index)"
        @tool-call-rerun="handleToolCallRerun"
        @stop-task="handleFlowStop"
      />
    </div>

    <!-- Journal Preview Chips -->
    <div v-if="latestImageEntries.length > 0" class="flex gap-2 overflow-x-auto px-2 py-1 scrollbar-none">
      <div
        v-for="entry in latestImageEntries"
        :key="entry.id"
        :class="[
          'group relative h-14 w-14 shrink-0 cursor-pointer of-hidden rounded-lg',
          'border border-primary-200/30 transition-all hover:border-primary-500',
          'dark:border-primary-800/30 dark:hover:border-primary-400',
        ]"
        @click="openImagePreview(entry)"
      >
        <img :src="entry.url || ''" class="h-full w-full object-cover">
        <div :class="['absolute inset-0 flex items-end p-1', 'bg-gradient-to-t from-black/60 to-transparent']">
          <span class="truncate text-[8px] text-white font-medium">{{ entry.title }}</span>
        </div>

        <!-- Save Button (Top Right, Hover Only) -->
        <button
          :class="[
            'absolute right-1 top-1 z-10 p-1 rounded-md bg-black/40 text-white backdrop-blur-sm',
            'opacity-0 transition-opacity group-hover:opacity-100 hover:bg-black/60',
          ]"
          title="Save to computer"
          @click.stop="journalPreviewStore.downloadImage(entry.url || '', entry.title)"
        >
          <div class="i-solar:download-minimalistic-bold-duotone text-[10px]" />
        </button>
      </div>
    </div>
    <div
      v-if="attachments.length > 0"
      :class="[
        'flex flex-wrap gap-2 border-t border-primary-100 p-2',
      ]"
    >
      <div v-for="(attachment, index) in attachments" :key="index" class="relative">
        <img :src="attachment.url" :class="['h-20 w-20 rounded-md object-cover']">
        <button
          :class="[
            'absolute right-1 top-1 h-5 w-5 flex items-center justify-center rounded-full',
            'bg-red-500 text-xs text-white',
          ]"
          @click="removeAttachment(index)"
        >
          &times;
        </button>
      </div>
    </div>
    <div :class="['flex items-center justify-end gap-2 py-1']">
      <DropdownMenuRoot>
        <DropdownMenuTrigger as-child>
          <button
            :class="[
              'max-h-[10lh] min-h-[1lh] flex items-center justify-center rounded-md p-2 outline-none',
              'transition-colors transition-transform active:scale-95',
            ]"
            bg="neutral-100 dark:neutral-800"
            text="lg neutral-500 dark:neutral-400"
            :title="t('stage.send-mode.title')"
          >
            <div class="i-solar:keyboard-bold-duotone" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuPortal>
          <DropdownMenuContent
            align="end"
            side="top"
            :side-offset="8"
            :class="[
              'z-50 min-w-[180px] rounded-xl p-1 shadow',
              'bg-white dark:bg-neutral-800',
              'flex flex-col gap-1',
              'data-[side=top]:animate-slideDownAndFade',
              'data-[side=left]:animate-none',
              'data-[side=bottom]:animate-none',
              'data-[side=right]:animate-none',
            ]"
          >
            <DropdownMenuItem
              v-for="mode in SEND_MODES"
              :key="mode"
              :class="[
                'w-full flex cursor-pointer items-center rounded-md px-3 py-2 text-left text-xs outline-none transition-colors',
                'hover:bg-primary-50 dark:hover:bg-primary-900/20',
                sendMode === mode ? 'bg-primary-50 text-primary-600 font-semibold dark:bg-primary-900/20 dark:text-primary-300' : 'text-neutral-500',
              ]"
              @select="sendMode = mode"
            >
              <div class="mr-2 h-4 w-4 flex shrink-0 items-center justify-center">
                <div v-if="sendMode === mode" class="i-ph:check-bold text-base" />
              </div>
              <span>{{ sendModeLabels[mode] }}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenuPortal>
      </DropdownMenuRoot>

      <button
        data-testid="approval-mode-button"
        :class="[
          'max-h-[10lh] min-h-[1lh]',
          approvalMode !== 'substitute' ? 'bg-primary-100 dark:bg-primary-900/40' : '',
        ]"
        bg="neutral-100 dark:neutral-800"
        text="lg neutral-500 dark:neutral-400"
        hover:text="primary-500 dark:primary-400"
        flex items-center justify-center rounded-md p-2 outline-none
        transition-colors transition-transform active:scale-95
        :title="t(`stage.approval-mode.${approvalMode}`)"
        :aria-label="t(`stage.approval-mode.${approvalMode}`)"
        @click="cycleApprovalMode"
      >
        <div :class="APPROVAL_MODE_ICONS[approvalMode]" />
      </button>

      <button
        v-if="showStopSpeakingButton"
        data-testid="stop-speaking-button"
        :class="[
          'max-h-[10lh] min-h-[1lh]',
        ]"
        bg="neutral-100 dark:neutral-800"
        text="lg neutral-500 dark:neutral-400"
        hover:text="primary-500 dark:primary-400"
        flex items-center justify-center rounded-md p-2 outline-none
        transition-colors transition-transform active:scale-95
        title="Stop speaking"
        aria-label="Stop speaking"
        @click="stopSpeakingFromChat"
      >
        <div class="i-solar:stop-circle-bold-duotone" />
      </button>

      <button
        :class="[
          'max-h-[10lh] min-h-[1lh]',
        ]"
        bg="neutral-100 dark:neutral-800"
        text="lg neutral-500 dark:neutral-400"
        hover:text="red-500 dark:red-400"
        flex items-center justify-center rounded-md p-2 outline-none
        transition-colors transition-transform active:scale-95
        @click="handleCleanupMessages"
      >
        <div class="i-solar:trash-bin-2-bold-duotone" />
      </button>

      <!-- Image Journal Deep Link -->
      <button
        class="max-h-[10lh] min-h-[1lh]"
        bg="neutral-100 dark:neutral-800"
        text="lg neutral-500 dark:neutral-400"
        hover:text="primary-500 dark:primary-400"
        flex items-center justify-center rounded-md p-2 outline-none
        transition-colors transition-transform active:scale-95
        title="Image Journal"
        @click="navigateToImageJournal"
      >
        <div class="i-solar:gallery-bold-duotone" />
      </button>

      <!-- Attach Image -->
      <button
        class="max-h-[10lh] min-h-[1lh]"
        bg="neutral-100 dark:neutral-800"
        text="lg neutral-500 dark:neutral-400"
        hover:text="primary-500 dark:primary-400"
        flex items-center justify-center rounded-md p-2 outline-none
        transition-colors transition-transform active:scale-95
        title="Attach Image"
        @click="handleManualAttach"
      >
        <div class="i-solar:camera-add-bold-duotone" />
      </button>
      <input
        ref="fileInput"
        type="file"
        accept="image/*"
        class="hidden"
        multiple
        @change="handleFileSelect"
      >
    </div>
    <!-- Auxiliary surfaces share one budgeted zone: side channel, question
         card, and the plan center scroll inside at most 40% of the chat area,
         so the history and the composer stay in view (UI-SURFACE §4). -->
    <div
      data-testid="chat-auxiliary-surfaces"
      class="max-h-[40%] w-full flex shrink-0 flex-col gap-1 overflow-y-auto"
    >
      <ChatQuestionCard />
      <ChatBtwCard :active="isActiveSessionSending" />
      <ChatPlanCenter
        :plans="planViews"
        :session-id="activeSessionId"
        :session-labels="sessionLabels"
        @open-session="handleOpenPlanSource"
      />
    </div>
    <div
      v-if="activeFlow"
      :class="['mb-1 flex items-center justify-between gap-2 rounded-lg px-2 py-1 text-xs', 'bg-amber-50/80 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300']"
      data-testid="chat-flow-indicator"
    >
      <span>
        {{ t('stage.turn.flow-active', { iteration: activeFlow.iteration }) }}
        <template v-if="activeFlowStep">
          · {{ activeFlowStep.intent }}
        </template>
      </span>
      <Button size="sm" variant="secondary" color="neutral" @click="handleFlowStop">
        {{ t('stage.turn.flow-stop') }}
      </Button>
    </div>
    <div class="relative w-full">
      <div
        v-if="composerBlock"
        data-testid="chat-composer-blocked"
        :class="['mb-1 flex items-center gap-2 rounded-lg px-2 py-1 text-xs', 'bg-amber-50/80 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300']"
      >
        <span class="i-solar:danger-circle-bold-duotone shrink-0" aria-hidden="true" />
        <span class="min-w-0 flex-1">{{ composerBlock.message }}</span>
        <Button
          v-if="composerBlock.reason === 'provider'"
          data-testid="chat-composer-open-settings"
          size="sm"
          variant="secondary"
          color="neutral"
          @click="openSettings({ route: '/settings/providers' })"
        >
          {{ t('stage.chat.open-settings') }}
        </Button>
      </div>
      <div
        v-if="activeQueuedSends.length > 0"
        :class="[
          'mb-1 flex flex-col gap-1 rounded-lg p-2',
          'bg-neutral-100/80 dark:bg-neutral-900/80',
        ]"
        data-testid="chat-queue-dock"
      >
        <div
          v-for="queued in activeQueuedSends"
          :key="queued.id"
          :class="['flex min-w-0 items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400']"
        >
          <span class="shrink-0 font-medium">{{ t('stage.turn.queued') }}</span>
          <span class="min-w-0 flex-1 truncate">{{ queued.messagePreview }}</span>
          <Button
            size="unset"
            variant="secondary"
            color="neutral"
            :class="['h-6 w-6 shrink-0 p-0']"
            :aria-label="t('stage.turn.cancel-queued')"
            @click="cancelQueuedSend(queued.id)"
          >
            <span class="i-solar:close-circle-bold text-sm" aria-hidden="true" />
          </Button>
        </div>
      </div>
      <TriggerPanel
        v-if="isSlashPanelOpen"
        :sections="slashSections"
        :selected-index="slashSelectedIndex"
        :empty-label="t('stage.skill-shelf.empty')"
        :hint="t('stage.skill-shelf.hint')"
        @select="selectSlashItem"
      />
      <TriggerPanel
        v-if="isWorkspacePanelOpen"
        :sections="workspaceSections"
        :selected-index="workspaceSelectedIndex"
        :empty-label="t('stage.workspace-reference.empty')"
        :hint="t('stage.skill-shelf.hint')"
        @select="selectWorkspaceItem"
      />
      <BasicTextarea
        v-model="messageInput"
        data-testid="chat-main-input"
        :disabled="!!composerBlock"
        :submit-on-enter="false"
        :placeholder="t('stage.message')"
        :class="[
          'ph-no-capture [scrollbar-gutter:stable]',
        ]"
        text="primary-600 dark:primary-100  placeholder:primary-500 dark:placeholder:primary-200"
        border="solid 2 primary-200/20 dark:primary-400/20"
        bg="primary-100/50 dark:primary-900/70"
        max-h="[10lh]" min-h="[1lh]"
        w-full shrink-0 resize-none overflow-y-auto rounded-xl p-2 font-medium outline-none
        transition="all duration-250 ease-in-out placeholder:all placeholder:duration-250 placeholder:ease-in-out"
        @compositionstart="isComposing = true"
        @compositionend="isComposing = false"
        @input="handleMessageInput"
        @keydown="handleMessageInputKeydown"
        @paste-file="handleFilePaste"
      />
      <p
        v-if="isActiveSessionSending"
        :class="['mt-1 px-1 text-[10px] text-neutral-400 dark:text-neutral-500']"
      >
        {{ t('stage.turn.steer-hint') }}
      </p>
    </div>

    <!-- Shared Preview Modal -->
    <JournalPreviewModal />
  </div>
</template>
