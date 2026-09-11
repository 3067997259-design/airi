<script setup lang="ts">
import type { MemoryFragment, ScoredMemoryFragment } from '@proj-airi/memory-core'

import { useAuthStore } from '@proj-airi/stage-ui/stores/auth'
import { useAiriCardStore } from '@proj-airi/stage-ui/stores/modules/airi-card'
import { MEMORY_BROWSER_SESSION_ID, useMemoryStore } from '@proj-airi/stage-ui/stores/modules/memory'
import { Button, FieldInput } from '@proj-airi/ui'
import { onMounted, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const authStore = useAuthStore()
const cardStore = useAiriCardStore()
const memoryStore = useMemoryStore()
const fragments = shallowRef<MemoryFragment[]>([])
const retrievalResults = shallowRef<ScoredMemoryFragment[]>([])
const query = shallowRef('')
const selectedId = shallowRef<string>()
const draftContent = shallowRef('')
const revisionContent = shallowRef('')
const busy = shallowRef(false)
// "Keep as muscle" is an explicit per-window decision; a dismissed suggestion
// stays dismissed until the browser reloads.
const dismissedMigrationIds = shallowRef<Set<string>>(new Set())

async function refresh() {
  fragments.value = await memoryStore.list()
}

async function simulateRetrieval() {
  if (!query.value.trim()) {
    retrievalResults.value = []
    return
  }

  retrievalResults.value = await memoryStore.retrieve(query.value, MEMORY_BROWSER_SESSION_ID, {
    recordAccess: false,
    scope: {
      userId: authStore.userId,
      characterId: cardStore.activeCardId || 'default',
    },
  })
}

/**
 * A muscle record without a usable trigger pattern can never fire, so it only
 * blocks its content from ordinary recall; those get the conversion offer.
 */
function needsMigration(fragment: MemoryFragment): boolean {
  return fragment.memoryType === 'muscle'
    && !fragment.triggerPattern?.trim()
    && fragment.reviewStatus !== 'rejected'
    && !dismissedMigrationIds.value.has(fragment.id)
}

function keepAsMuscle(id: string) {
  dismissedMigrationIds.value = new Set([...dismissedMigrationIds.value, id])
}

async function convertToFact(id: string) {
  busy.value = true
  try {
    await memoryStore.convertMuscleToFact(id)
    if (selectedId.value === id) {
      selectedId.value = undefined
      draftContent.value = ''
    }
    await refresh()
  }
  finally {
    busy.value = false
  }
}

function selectFragment(fragment: MemoryFragment) {
  selectedId.value = fragment.id
  draftContent.value = fragment.content
  revisionContent.value = fragment.content
}

async function saveFragment() {
  if (!selectedId.value)
    return

  busy.value = true
  try {
    await memoryStore.update(selectedId.value, { content: draftContent.value })
    await refresh()
  }
  finally {
    busy.value = false
  }
}

async function removeFragment(id: string) {
  busy.value = true
  try {
    await memoryStore.remove(id)
    if (selectedId.value === id) {
      selectedId.value = undefined
      draftContent.value = ''
    }
    await refresh()
  }
  finally {
    busy.value = false
  }
}

async function proposeRevision(relation: 'supersedes' | 'disputes') {
  if (!selectedId.value || !revisionContent.value.trim())
    return
  busy.value = true
  try {
    await memoryStore.reviseFact({ memoryId: selectedId.value, content: revisionContent.value, relation })
    await refresh()
  }
  finally {
    busy.value = false
  }
}

onMounted(() => {
  void refresh()
})
</script>

<template>
  <div :class="['flex', 'flex-col', 'gap-6']">
    <section :class="['rounded-xl', 'bg-neutral-50', 'p-4', 'dark:bg-[rgba(0,0,0,0.3)]']">
      <div :class="['flex', 'flex-col', 'gap-4']">
        <div>
          <h2 :class="['text-lg', 'text-neutral-500', 'md:text-2xl', 'dark:text-neutral-400']">
            {{ t('settings.pages.modules.memory-long-term.sections.browser.title') }}
          </h2>
          <p :class="['text-sm', 'text-neutral-400', 'dark:text-neutral-500']">
            {{ t('settings.pages.modules.memory-long-term.sections.browser.description') }}
          </p>
        </div>
        <div :class="['flex', 'flex-col', 'gap-3', 'md:flex-row', 'md:items-end']">
          <div :class="['min-w-0', 'flex-1']">
            <FieldInput v-model="query" :label="t('settings.pages.modules.memory-long-term.search-label')" :placeholder="t('settings.pages.modules.memory-long-term.search-placeholder')" />
          </div>
          <Button icon="i-solar:magnifer-bold-duotone" color="primary" @click="simulateRetrieval">
            {{ t('settings.pages.modules.memory-long-term.search') }}
          </Button>
          <Button icon="i-solar:refresh-bold-duotone" @click="refresh">
            {{ t('settings.pages.modules.memory-long-term.refresh') }}
          </Button>
        </div>

        <div v-if="retrievalResults.length > 0" :class="['flex', 'flex-col', 'gap-2']">
          <div :class="['text-xs', 'font-medium', 'uppercase', 'tracking-wide', 'text-neutral-400']">
            {{ t('settings.pages.modules.memory-long-term.results') }}
          </div>
          <article v-for="result in retrievalResults" :key="result.id" :class="['rounded-lg', 'border', 'border-primary-200', 'bg-primary-50', 'p-3', 'dark:border-primary-800', 'dark:bg-primary-900/20']">
            <div :class="['flex', 'items-start', 'justify-between', 'gap-3']">
              <p :class="['text-sm', 'text-neutral-700', 'dark:text-neutral-200']">
                {{ result.content }}
              </p>
              <span :class="['shrink-0', 'font-mono', 'text-xs', 'text-primary-600', 'dark:text-primary-300']">{{ result.score.toFixed(3) }}</span>
            </div>
          </article>
        </div>

        <div v-if="fragments.length === 0" :class="['rounded-lg', 'border', 'border-dashed', 'border-neutral-200', 'p-4', 'text-sm', 'text-neutral-400', 'dark:border-neutral-800']">
          {{ t('settings.pages.modules.memory-long-term.empty') }}
        </div>
        <div v-else :class="['flex', 'flex-col', 'gap-2']">
          <article v-for="fragment in fragments" :key="fragment.id" :class="['rounded-lg', 'border', 'border-neutral-200', 'bg-white', 'p-3', 'dark:border-neutral-800', 'dark:bg-neutral-900']">
            <div :class="['flex', 'items-start', 'gap-3']">
              <button type="button" :class="['min-w-0', 'flex-1', 'text-left']" @click="selectFragment(fragment)">
                <p :class="['text-sm', 'text-neutral-700', 'dark:text-neutral-200']">
                  {{ fragment.content }}
                </p>
                <p :class="['mt-1', 'text-xs', 'text-neutral-400']">
                  {{ fragment.memoryType }} · {{ t(`settings.pages.modules.memory-long-term.fact-status.${fragment.factStatus ?? 'active'}`) }} · {{ t('settings.pages.modules.memory-long-term.access-count-value', { count: fragment.accessCount }) }} · {{ fragment.sessionIds.length }} {{ t('settings.pages.modules.memory-long-term.sessions') }}
                </p>
              </button>
              <Button color="red" icon="i-solar:trash-bin-trash-bold-duotone" :loading="busy" @click="removeFragment(fragment.id)">
                {{ t('settings.pages.modules.memory-long-term.delete') }}
              </Button>
            </div>
            <div
              v-if="needsMigration(fragment)"
              :class="['mt-2', 'flex', 'flex-wrap', 'items-center', 'gap-2', 'rounded-md', 'bg-orange-50', 'p-2', 'text-xs', 'text-orange-600', 'dark:bg-orange-950/40', 'dark:text-orange-300']"
            >
              <span :class="['min-w-0', 'flex-1']">
                {{ t('settings.pages.modules.memory-long-term.muscle-migration.hint') }}
              </span>
              <Button size="sm" color="primary" :loading="busy" @click="convertToFact(fragment.id)">
                {{ t('settings.pages.modules.memory-long-term.muscle-migration.convert') }}
              </Button>
              <Button size="sm" variant="secondary" @click="keepAsMuscle(fragment.id)">
                {{ t('settings.pages.modules.memory-long-term.muscle-migration.keep') }}
              </Button>
            </div>
          </article>
        </div>

        <div v-if="selectedId" :class="['flex', 'flex-col', 'gap-3', 'border-t', 'border-neutral-200', 'pt-4', 'dark:border-neutral-800']">
          <FieldInput v-model="draftContent" :label="t('settings.pages.modules.memory-long-term.edit-label')" :single-line="false" />
          <Button :loading="busy" color="primary" icon="i-solar:diskette-bold-duotone" @click="saveFragment">
            {{ t('settings.pages.modules.memory-long-term.save') }}
          </Button>
          <FieldInput v-model="revisionContent" :label="t('settings.pages.modules.memory-long-term.revision-label')" :single-line="false" />
          <div :class="['flex', 'flex-wrap', 'gap-2']">
            <Button :loading="busy" variant="secondary" @click="proposeRevision('supersedes')">
              {{ t('settings.pages.modules.memory-long-term.revise') }}
            </Button>
            <Button :loading="busy" variant="secondary" @click="proposeRevision('disputes')">
              {{ t('settings.pages.modules.memory-long-term.dispute') }}
            </Button>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>
