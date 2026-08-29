<script setup lang="ts">
import { useApprovalsStore } from '@proj-airi/stage-ui/stores/approvals'
import { Button, Collapsible } from '@proj-airi/ui'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const approvals = useApprovalsStore()
const { pending } = approvals
</script>

<template>
  <div v-if="pending.length > 0" :class="['flex', 'flex-col', 'gap-2']">
    <Collapsible
      v-for="request in pending"
      :key="request.requestId"
      :default-open="true"
      :class="['rounded-lg', 'border', 'border-amber-300', 'bg-amber-50', 'p-3', 'dark:border-amber-500/40', 'dark:bg-amber-500/10']"
    >
      <div :class="['flex', 'items-center', 'justify-between', 'gap-2']">
        <span :class="['text-sm', 'font-medium', 'text-amber-800', 'dark:text-amber-300']">
          ⚠ {{ t('chat.approval-card.title') }}
        </span>
        <span :class="['rounded-full', 'bg-amber-200', 'px-2', 'py-0.5', 'text-xs', 'text-amber-800', 'dark:bg-amber-500/20', 'dark:text-amber-300']">
          {{ request.riskLevel }}
        </span>
      </div>
      <p :class="['mt-2', 'font-mono', 'text-xs', 'break-all', 'text-amber-900', 'dark:text-amber-200']">
        {{ request.subject }}
      </p>
      <p :class="['mt-1', 'text-xs', 'text-amber-700', 'dark:text-amber-400']">
        {{ request.reason }}
      </p>
      <p v-if="request.expectedEvidence" :class="['mt-1', 'text-xs', 'text-amber-600', 'dark:text-amber-500']">
        {{ t('chat.approval-card.expected-evidence') }}: {{ request.expectedEvidence }}
      </p>

      <div :class="['mt-3', 'flex', 'gap-2']">
        <Button size="sm" variant="primary" @click="approvals.approve(request.requestId)">
          {{ t('chat.approval-card.approve') }}
        </Button>
        <Button size="sm" variant="secondary" @click="approvals.reject(request.requestId)">
          {{ t('chat.approval-card.reject') }}
        </Button>
        <Button size="sm" variant="secondary" @click="approvals.handOver(request.requestId)">
          {{ t('chat.approval-card.hand-over') }}
        </Button>
      </div>
    </Collapsible>
  </div>
</template>
