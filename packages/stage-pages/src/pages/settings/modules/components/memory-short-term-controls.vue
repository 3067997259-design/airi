<script setup lang="ts">
import type { MemoryFragment } from '@proj-airi/memory-core'

import { useChatStore } from '@proj-airi/stage-ui/stores/chat'
import { useMemoryStore } from '@proj-airi/stage-ui/stores/modules/memory'
import { Button, FieldCheckbox, FieldInput, FieldRange } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { onMounted, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const memoryStore = useMemoryStore()
const chatStore = useChatStore()
const {
  enabled,
  captureEnabled,
  compactionEnabled,
  activeProvider,
  activeModel,
  compactionThreshold,
  contextLengthOverride,
  compactionRecentTurnLimit,
  databaseStatus,
  databaseError,
  dreamingEnabled,
  dreamIdeas,
  dreaming,
  isLeader,
} = storeToRefs(memoryStore)
const compacting = shallowRef(false)

const pendingFragments = shallowRef<MemoryFragment[]>([])
const reviewingId = shallowRef<string>()

async function loadPending() {
  pendingFragments.value = await memoryStore.listPending()
}

async function loadDreamIdeas() {
  await memoryStore.refreshDreamIdeas()
}

async function decide(id: string, status: 'approved' | 'rejected') {
  reviewingId.value = id
  try {
    await memoryStore.setReviewStatus(id, status)
    await loadPending()
  }
  finally {
    reviewingId.value = undefined
  }
}

onMounted(async () => {
  await Promise.all([loadPending(), loadDreamIdeas()])
})

async function initializeMemory() {
  await memoryStore.initialize()
}

async function compactNow() {
  compacting.value = true
  try {
    await chatStore.compactActiveSession()
  }
  finally {
    compacting.value = false
  }
}

async function dreamNow() {
  await memoryStore.dream()
}

async function setDreamIdeaStatus(id: string, status: 'developing' | 'implemented' | 'abandoned') {
  await memoryStore.updateDreamIdea(id, { status })
}
</script>

<template>
  <div :class="['flex', 'flex-col', 'gap-6']">
    <section :class="['rounded-xl', 'bg-neutral-50', 'p-4', 'dark:bg-[rgba(0,0,0,0.3)]']">
      <div :class="['flex', 'flex-col', 'gap-4']">
        <div>
          <h2 :class="['text-lg', 'text-neutral-500', 'md:text-2xl', 'dark:text-neutral-400']">
            {{ t('settings.pages.modules.memory-short-term.sections.runtime.title') }}
          </h2>
          <p :class="['text-sm', 'text-neutral-400', 'dark:text-neutral-500']">
            {{ t('settings.pages.modules.memory-short-term.sections.runtime.description') }}
          </p>
        </div>

        <FieldCheckbox
          v-model="enabled"
          :label="t('settings.pages.modules.memory-short-term.enabled')"
          :description="t('settings.pages.modules.memory-short-term.enabled-description')"
        />
        <FieldCheckbox
          v-model="captureEnabled"
          :label="t('settings.pages.modules.memory-short-term.capture-enabled')"
          :description="t('settings.pages.modules.memory-short-term.capture-enabled-description')"
        />
        <FieldCheckbox
          v-model="compactionEnabled"
          :label="t('settings.pages.modules.memory-short-term.compaction-enabled')"
          :description="t('settings.pages.modules.memory-short-term.compaction-enabled-description')"
        />

        <div :class="['grid', 'gap-4', 'md:grid-cols-2']">
          <FieldInput
            v-model="activeProvider"
            :label="t('settings.pages.modules.memory-short-term.provider')"
            :description="t('settings.pages.modules.memory-short-term.provider-description')"
            :placeholder="t('settings.pages.modules.memory-short-term.provider-placeholder')"
          />
          <FieldInput
            v-model="activeModel"
            :label="t('settings.pages.modules.memory-short-term.model')"
            :description="t('settings.pages.modules.memory-short-term.model-description')"
            :placeholder="t('settings.pages.modules.memory-short-term.model-placeholder')"
          />
        </div>
      </div>
    </section>

    <section :class="['rounded-xl', 'bg-neutral-50', 'p-4', 'dark:bg-[rgba(0,0,0,0.3)]']">
      <div :class="['flex', 'flex-col', 'gap-4']">
        <div>
          <h2 :class="['text-lg', 'text-neutral-500', 'md:text-2xl', 'dark:text-neutral-400']">
            {{ t('settings.pages.modules.memory-short-term.sections.dreaming.title') }}
          </h2>
          <p :class="['text-sm', 'text-neutral-400', 'dark:text-neutral-500']">
            {{ t('settings.pages.modules.memory-short-term.sections.dreaming.description') }}
          </p>
        </div>

        <FieldCheckbox
          v-model="dreamingEnabled"
          :label="t('settings.pages.modules.memory-short-term.dreaming-enabled')"
          :description="t('settings.pages.modules.memory-short-term.dreaming-enabled-description')"
        />
        <div :class="['flex', 'flex-wrap', 'items-center', 'gap-3']">
          <Button
            :loading="dreaming"
            :disabled="!enabled || !dreamingEnabled"
            icon="i-solar:moon-fog-bold-duotone"
            color="primary"
            @click="dreamNow"
          >
            {{ t('settings.pages.modules.memory-short-term.dream-now') }}
          </Button>
          <span :class="['text-sm', 'text-neutral-400', 'dark:text-neutral-500']">
            {{ t('settings.pages.modules.memory-short-term.dream-count', { count: dreamIdeas.length }) }}
          </span>
        </div>

        <div v-if="dreamIdeas.length === 0" :class="['text-sm', 'text-neutral-400']">
          {{ t('settings.pages.modules.memory-short-term.sections.dreaming.empty') }}
        </div>
        <div v-for="idea in dreamIdeas" :key="idea.id" :class="['rounded-lg', 'border', 'border-neutral-200', 'p-3', 'dark:border-neutral-700']">
          <p :class="['text-sm']">
            {{ idea.content }}
          </p>
          <div :class="['mt-2', 'text-xs', 'text-neutral-400', 'dark:text-neutral-500']">
            {{ idea.status }} · {{ t('settings.pages.modules.memory-short-term.excitement', { value: idea.excitement }) }}
          </div>
          <div :class="['mt-3', 'flex', 'flex-wrap', 'gap-2']">
            <Button size="sm" variant="secondary" @click="setDreamIdeaStatus(idea.id, 'developing')">
              {{ t('settings.pages.modules.memory-short-term.idea-actions.develop') }}
            </Button>
            <Button size="sm" color="primary" @click="setDreamIdeaStatus(idea.id, 'implemented')">
              {{ t('settings.pages.modules.memory-short-term.idea-actions.implement') }}
            </Button>
            <Button size="sm" variant="secondary" @click="setDreamIdeaStatus(idea.id, 'abandoned')">
              {{ t('settings.pages.modules.memory-short-term.idea-actions.abandon') }}
            </Button>
          </div>
        </div>
      </div>
    </section>

    <section :class="['rounded-xl', 'bg-neutral-50', 'p-4', 'dark:bg-[rgba(0,0,0,0.3)]']">
      <div :class="['flex', 'flex-col', 'gap-4']">
        <div>
          <h2 :class="['text-lg', 'text-neutral-500', 'md:text-2xl', 'dark:text-neutral-400']">
            {{ t('settings.pages.modules.memory-short-term.sections.compaction.title') }}
          </h2>
          <p :class="['text-sm', 'text-neutral-400', 'dark:text-neutral-500']">
            {{ t('settings.pages.modules.memory-short-term.sections.compaction.description') }}
          </p>
        </div>

        <FieldRange
          v-model="compactionThreshold"
          :label="t('settings.pages.modules.memory-short-term.compaction-threshold')"
          :description="t('settings.pages.modules.memory-short-term.compaction-threshold-description')"
          :min="0.5"
          :max="0.95"
          :step="0.05"
          :format-value="value => `${Math.round(value * 100)}%`"
          :default-value="0.7"
        />
        <FieldInput
          v-model="contextLengthOverride"
          type="number"
          :label="t('settings.pages.modules.memory-short-term.context-length')"
          :description="t('settings.pages.modules.memory-short-term.context-length-description')"
        />
        <FieldRange
          v-model="compactionRecentTurnLimit"
          :label="t('settings.pages.modules.memory-short-term.recent-turn-limit')"
          :description="t('settings.pages.modules.memory-short-term.recent-turn-limit-description')"
          :min="1"
          :max="20"
          :step="1"
          :default-value="4"
        />

        <div :class="['flex', 'flex-wrap', 'items-center', 'gap-3']">
          <Button
            :loading="compacting"
            :disabled="!compactionEnabled"
            icon="i-solar:magic-stick-3-bold-duotone"
            color="primary"
            @click="compactNow"
          >
            {{ t('settings.pages.modules.memory-short-term.compact-now') }}
          </Button>
          <Button
            v-if="isLeader"
            icon="i-solar:database-bold-duotone"
            @click="initializeMemory"
          >
            {{ t('settings.pages.modules.memory-short-term.initialize') }}
          </Button>
          <span :class="['text-sm', 'text-neutral-400', 'dark:text-neutral-500']">
            {{ t(`settings.pages.modules.memory-short-term.database-status.${databaseStatus}`) }}
            <template v-if="databaseError">: {{ databaseError }}</template>
          </span>
        </div>
      </div>
    </section>

    <section :class="['rounded-xl', 'bg-neutral-50', 'p-4', 'dark:bg-[rgba(0,0,0,0.3)]']">
      <div :class="['flex', 'flex-col', 'gap-4']">
        <div>
          <h2 :class="['text-lg', 'text-neutral-500', 'md:text-2xl', 'dark:text-neutral-400']">
            {{ t('settings.pages.modules.memory-short-term.sections.review.title') }}
          </h2>
          <p :class="['text-sm', 'text-neutral-400', 'dark:text-neutral-500']">
            {{ t('settings.pages.modules.memory-short-term.sections.review.description') }}
          </p>
        </div>

        <div v-if="pendingFragments.length === 0" :class="['text-sm', 'text-neutral-400']">
          {{ t('settings.pages.modules.memory-short-term.sections.review.empty') }}
        </div>

        <div v-for="fragment in pendingFragments" :key="fragment.id" :class="['rounded-lg', 'border', 'border-neutral-200', 'p-3', 'dark:border-neutral-700']">
          <p :class="['text-sm']">
            {{ fragment.content }}
          </p>
          <div :class="['mt-2', 'text-xs', 'text-neutral-400', 'dark:text-neutral-500']">
            {{ fragment.memoryType }} · {{ fragment.category }} · <span class="font-mono">{{ fragment.id.slice(0, 8) }}</span>
          </div>
          <div :class="['mt-3', 'flex', 'gap-2']">
            <Button
              size="sm"
              color="primary"
              :loading="reviewingId === fragment.id"
              @click="decide(fragment.id, 'approved')"
            >
              {{ t('settings.pages.modules.memory-short-term.sections.review.approve') }}
            </Button>
            <Button size="sm" variant="secondary" @click="decide(fragment.id, 'rejected')">
              {{ t('settings.pages.modules.memory-short-term.sections.review.reject') }}
            </Button>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>
