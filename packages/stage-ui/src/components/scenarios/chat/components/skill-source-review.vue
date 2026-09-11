<script setup lang="ts">
import type { ReviewQueueEntry, SkillReviewArtifacts } from '../../../../stores/skills'

import { errorMessageFrom } from '@moeru/std'
import { useSkillsReviewStore } from '@proj-airi/stage-ui/stores/skills'
import { Button } from '@proj-airi/ui'
import { computed, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{ entry: ReviewQueueEntry }>()
const { t } = useI18n()
const store = useSkillsReviewStore()
const artifacts = shallowRef<SkillReviewArtifacts>()
const busy = shallowRef(false)
const error = shallowRef<string>()
const current = computed(() => artifacts.value?.contentHash === props.entry.contentHash
  && artifacts.value?.selftest?.contentHash === props.entry.selftest?.contentHash)

async function review(approve = false) {
  busy.value = true
  error.value = undefined
  try {
    if (approve && artifacts.value && current.value)
      await store.approve(props.entry.toolId, artifacts.value)
    else
      artifacts.value = await store.readForReview(props.entry.toolId)
  }
  catch (cause) {
    error.value = errorMessageFrom(cause)
    artifacts.value = undefined
  }
  finally {
    busy.value = false
  }
}

async function requeueChangedSource() {
  busy.value = true
  error.value = undefined
  artifacts.value = undefined
  try {
    await store.requeueChangedSourceForReview(props.entry.toolId)
  }
  catch (cause) {
    error.value = errorMessageFrom(cause)
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <div :class="['mt-3 flex flex-col gap-2']">
    <Button size="sm" variant="secondary" :loading="busy" @click="review()">
      {{ t('settings.pages.modules.skills.sections.queue.view-source') }}
    </Button>
    <Button v-if="entry.trust === 'reviewed' && entry.artifactError" size="sm" variant="secondary" :loading="busy" @click="requeueChangedSource">
      {{ t('settings.pages.modules.skills.sections.queue.re-review-source') }}
    </Button>
    <p v-if="error" role="alert" :class="['text-sm text-red-600 dark:text-red-400']">
      {{ error }}
    </p>
    <template v-if="artifacts && current">
      <p :class="['break-all text-xs font-mono']">
        {{ artifacts.contentHash }}
      </p>
      <pre :class="['max-h-80 overflow-auto rounded p-3 text-xs', 'bg-neutral-100 dark:bg-neutral-900']">{{ artifacts.source }}</pre>
      <template v-if="artifacts.selftest">
        <p :class="['break-all text-xs font-mono']">
          selftest.mjs — {{ artifacts.selftest.contentHash }}
        </p>
        <pre :class="['max-h-80 overflow-auto rounded p-3 text-xs', 'bg-neutral-100 dark:bg-neutral-900']">{{ artifacts.selftest.source }}</pre>
        <pre :class="['max-h-40 overflow-auto text-xs']">{{ artifacts.selftest.logs.join('\n') }}</pre>
        <p :class="['text-xs']">
          {{ t('settings.pages.modules.skills.sections.queue.trace-count', { count: artifacts.selftest.traceCount }) }}
        </p>
      </template>
      <p v-else :class="['text-xs']">
        {{ t('settings.pages.modules.skills.sections.queue.no-selftest') }}
      </p>
    </template>
    <p v-if="entry.trust === 'probation' && (!artifacts || !current)" :class="['text-xs text-neutral-500 dark:text-neutral-400']">
      {{ t('settings.pages.modules.skills.sections.queue.approve-requires-source') }}
    </p>
    <Button v-if="entry.trust === 'probation'" size="sm" variant="primary" :disabled="!artifacts || !current" :loading="busy" @click="review(true)">
      {{ t('settings.pages.modules.skills.sections.queue.approve') }}
    </Button>
  </div>
</template>
