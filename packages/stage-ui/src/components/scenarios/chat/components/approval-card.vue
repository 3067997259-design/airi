<script setup lang="ts">
import type { JournalEvent } from '@proj-airi/core-agent'

import { useApprovalsStore } from '@proj-airi/stage-ui/stores/approvals'
import { Button, Collapsible } from '@proj-airi/ui'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { useJournalStore } from '../../../../stores/journal'

const { t } = useI18n()
const approvals = useApprovalsStore()
// The journal is the single source of truth for pending approvals: pairs
// approval/asked with approval/decided so a card always corresponds to a
// decision that has not been recorded yet. The store is resolved lazily
// inside the computed because component-tests mount ChatHistory without an
// active Pinia; in a storeless host the card degrades to empty rather than
// throwing the setup.
const pendingApprovals = computed(() => {
  let events: JournalEvent[] = []
  try {
    events = useJournalStore().events
  }
  catch {
    events = []
  }
  return projectPendingApprovals(events)
})

function projectPendingApprovals(events: JournalEvent[]) {
  const asked = new Map<string, Extract<JournalEvent, { type: 'approval/asked' }>>()
  const decided = new Set<string>()
  for (const event of events) {
    if (event.type === 'approval/asked')
      asked.set(event.requestId, event)
    if (event.type === 'approval/decided')
      decided.add(event.requestId)
  }
  return [...asked.values()].filter(event => !decided.has(event.requestId))
}
</script>

<template>
  <div v-if="pendingApprovals.length > 0" :class="['flex', 'flex-col', 'gap-2']">
    <Collapsible
      v-for="request in pendingApprovals"
      :key="request.requestId"
      :default="true"
      label=""
      :class="['rounded-lg', 'border', 'border-amber-300', 'bg-amber-50', 'p-3', 'dark:border-amber-500/40', 'dark:bg-amber-500/10']"
    >
      <!-- The Collapsible content slot renders inside a Transition, which
      requires a single root — wrap the card body in one div. -->
      <div :class="['flex', 'flex-col']">
        <div :class="['flex', 'items-center', 'justify-between', 'gap-2']">
          <span :class="['text-sm', 'font-medium', 'text-amber-800', 'dark:text-amber-300']">
            ⚠ {{ t('stage.chat.approval-card.title') }}
          </span>
          <span :class="['rounded-full', 'bg-amber-200', 'px-2', 'py-0.5', 'text-xs', 'text-amber-800', 'dark:bg-amber-500/20', 'dark:text-amber-300']">
            {{ request.riskLevel ?? 'medium' }}
          </span>
        </div>
        <p v-if="request.subject" :class="['mt-2', 'font-mono', 'text-xs', 'break-all', 'text-amber-900', 'dark:text-amber-200']">
          {{ request.subject }}
        </p>
        <p :class="['mt-1', 'text-xs', 'text-amber-700', 'dark:text-amber-400']">
          {{ request.reason }}
        </p>

        <div :class="['mt-3', 'flex', 'gap-2']">
          <Button size="sm" variant="primary" @click="approvals.approve(request.requestId, request.planId)">
            {{ t('stage.chat.approval-card.approve') }}
          </Button>
          <Button size="sm" variant="secondary" @click="approvals.reject(request.requestId, request.planId)">
            {{ t('stage.chat.approval-card.reject') }}
          </Button>
          <Button size="sm" variant="secondary" @click="approvals.handOver(request.requestId)">
            {{ t('stage.chat.approval-card.hand-over') }}
          </Button>
        </div>
      </div>
    </Collapsible>
  </div>
</template>
