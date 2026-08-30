<script setup lang="ts">
import { useSkillsReviewStore } from '@proj-airi/stage-ui/stores/skills'
import { Button, Collapsible } from '@proj-airi/ui'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

// The card renders inside the chat timeline where Pinia is always installed.
// Some component-tests mount ChatHistory without an active Pinia, so resolve
// the store lazily inside the computed — the setup body runs once at module
// evaluation (pre-pinia in those tests) and would freeze `skills` empty. The
// leader app always has Pinia, so this degrades to "no pending reviews" only
// in a storeless test host.
const pending = computed(() => {
  let queue: ReturnType<typeof useSkillsReviewStore>['queue'] = []
  try {
    queue = useSkillsReviewStore().queue
  }
  catch {
    queue = []
  }
  return queue
    .filter(entry => entry.trust === 'probation')
    .map(entry => ({
      reviewRequestId: `review:${entry.toolId}`,
      toolId: entry.toolId,
      contentHash: entry.contentHash,
      reason: entry.quarantine
        ? `兼容性探针失败，已隔离：${entry.description}`
        : `等待审阅：${entry.description}`,
      riskLevel: entry.riskLevel,
    }))
})

function approve(toolId: string): void {
  try {
    useSkillsReviewStore().approve(toolId)
  }
  catch {
    // storeless test host — decision is a no-op there
  }
}

function reject(toolId: string): void {
  try {
    useSkillsReviewStore().reject(toolId)
  }
  catch {
    // storeless test host — decision is a no-op there
  }
}
</script>

<template>
  <div v-if="pending.length > 0" :class="['flex', 'flex-col', 'gap-2']">
    <Collapsible
      v-for="request in pending"
      :key="request.reviewRequestId"
      :default="true"
      label=""
      :class="['rounded-lg', 'border', 'border-sky-300', 'bg-sky-50', 'p-3', 'dark:border-sky-500/40', 'dark:bg-sky-500/10']"
    >
      <!-- Single root for the Collapsible content slot (Transition requirement). -->
      <div :class="['flex', 'flex-col']">
        <div :class="['flex', 'items-center', 'justify-between', 'gap-2']">
          <span :class="['text-sm', 'font-medium', 'text-sky-800', 'dark:text-sky-300']">
            ✦ {{ t('stage.chat.review-card.title') }}
          </span>
          <span :class="['rounded-full', 'bg-sky-200', 'px-2', 'py-0.5', 'text-xs', 'text-sky-800', 'dark:bg-sky-500/20', 'dark:text-sky-300']">
            {{ request.toolId }}
          </span>
        </div>
        <p :class="['mt-2', 'text-xs', 'break-all', 'text-sky-900', 'dark:text-sky-200']">
          {{ request.reason }}
        </p>
        <p :class="['mt-1', 'text-xs', 'font-mono', 'text-sky-600', 'dark:text-sky-400']">
          {{ t('stage.chat.review-card.content-hash') }}: {{ request.contentHash.slice(0, 12) }}… · {{ request.riskLevel }}
        </p>

        <div :class="['mt-3', 'flex', 'gap-2']">
          <Button size="sm" variant="primary" @click="approve(request.toolId)">
            {{ t('stage.chat.review-card.approve') }}
          </Button>
          <Button size="sm" variant="secondary" @click="reject(request.toolId)">
            {{ t('stage.chat.review-card.reject') }}
          </Button>
        </div>
      </div>
    </Collapsible>
  </div>
</template>
