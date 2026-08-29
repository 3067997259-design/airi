<script setup lang="ts">
import { useSkillsReviewStore } from '@proj-airi/stage-ui/stores/skills'
import { Button } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const skillsStore = useSkillsReviewStore()
const { queue, catalog, probationCount, canSubmitMore, revisionBatch } = storeToRefs(skillsStore)

const RISK_STYLE: Record<string, string> = {
  low: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400',
  medium: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400',
  high: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-400',
}

const ANALYSIS_LABELS: Array<{ key: string, label: string }> = [
  { key: 'networkEgress', label: 'network' },
  { key: 'workspaceWrites', label: 'workspace-writes' },
  { key: 'subprocess', label: 'subprocess' },
  { key: 'credentialedAccess', label: 'credentials' },
  { key: 'destructiveOps', label: 'destructive' },
]
</script>

<template>
  <div :class="['flex', 'flex-col', 'gap-6']">
    <section :class="['rounded-xl', 'bg-neutral-50', 'p-4', 'dark:bg-[rgba(0,0,0,0.3)]']">
      <div :class="['flex', 'flex-col', 'gap-4']">
        <div>
          <h2 :class="['text-lg', 'text-neutral-500', 'md:text-2xl', 'dark:text-neutral-400']">
            {{ t('settings.pages.modules.skills.sections.queue.title') }}
            <span :class="['ml-2', 'text-sm']">{{ probationCount }}/5</span>
          </h2>
          <p :class="['text-sm', 'text-neutral-400', 'dark:text-neutral-500']">
            {{ t('settings.pages.modules.skills.sections.queue.description') }}
          </p>
        </div>

        <div v-if="!canSubmitMore" :class="['text-sm', 'text-amber-600', 'dark:text-amber-400']">
          {{ t('settings.pages.modules.skills.sections.queue.cap') }}
        </div>

        <div :class="['flex', 'flex-wrap', 'items-center', 'gap-3']">
          <Button icon="i-solar:moon-fog-bold-duotone" variant="secondary" @click="skillsStore.dreamRevisionBatch">
            {{ t('settings.pages.modules.skills.sections.queue.dream') }}
          </Button>
          <span :class="['text-xs', 'text-neutral-400', 'dark:text-neutral-500']">
            {{ t('settings.pages.modules.skills.sections.queue.dream-count', { count: revisionBatch.length }) }}
          </span>
        </div>

        <div v-if="revisionBatch.length > 0" :class="['rounded-lg', 'bg-purple-50', 'p-3', 'text-xs', 'text-purple-700', 'dark:bg-purple-500/10', 'dark:text-purple-300']">
          <div v-for="candidate in revisionBatch" :key="`${candidate.toolId}:${candidate.failureSeq}`" class="mb-1 last:mb-0">
            <span class="font-mono">{{ candidate.toolName }}</span>: {{ candidate.failureSummary }}
          </div>
        </div>

        <div v-if="queue.length === 0" :class="['text-sm', 'text-neutral-400']">
          {{ t('settings.pages.modules.skills.sections.queue.empty') }}
        </div>

        <div v-for="entry in queue" :key="entry.toolId" :class="['rounded-lg', 'border', 'border-neutral-200', 'p-3', 'dark:border-neutral-700']">
          <div :class="['flex', 'items-center', 'gap-2']">
            <span :class="['font-mono', 'text-sm']">{{ entry.name }}</span>
            <span :class="['rounded-full', 'px-2', 'py-0.5', 'text-xs', RISK_STYLE[entry.riskLevel]]">
              {{ entry.riskLevel }}
            </span>
            <span v-if="entry.quarantine" :class="['rounded-full', 'bg-purple-100', 'px-2', 'py-0.5', 'text-xs', 'text-purple-700', 'dark:bg-purple-500/15', 'dark:text-purple-400']">
              quarantine
            </span>
            <span v-if="entry.trust === 'reviewed'" :class="['rounded-full', 'bg-emerald-100', 'px-2', 'py-0.5', 'text-xs', 'text-emerald-700', 'dark:bg-emerald-500/15', 'dark:text-emerald-400']">
              reviewed
            </span>
          </div>
          <p :class="['mt-1', 'text-xs', 'text-neutral-500', 'dark:text-neutral-400']">
            {{ entry.description }}
          </p>

          <div :class="['mt-2', 'flex', 'flex-wrap', 'gap-2']">
            <span v-for="label in ANALYSIS_LABELS" :key="label.key" :class="['rounded', 'px-1.5', 'py-0.5', 'text-[10px]', entry.staticAnalysis[label.key as keyof typeof entry.staticAnalysis] ? 'bg-neutral-200 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200' : 'bg-neutral-100 text-neutral-400 dark:bg-neutral-800 dark:text-neutral-600']">
              {{ label.label }}
            </span>
          </div>

          <div :class="['mt-2', 'text-[10px]', 'text-neutral-400', 'dark:text-neutral-500']">
            <div>{{ t('settings.pages.modules.skills.sections.queue.hash') }}: <span class="font-mono">{{ entry.contentHash }}</span></div>
            <div v-if="entry.externalSources.length > 0">
              {{ t('settings.pages.modules.skills.sections.queue.sources') }}:
              <span v-for="source in entry.externalSources" :key="source" class="font-mono">{{ source }}</span>
            </div>
            <div v-if="entry.compatibility" class="mt-1">
              {{ t('settings.pages.modules.skills.sections.queue.compatibility') }}:
              <span class="font-mono">{{ entry.compatibility.probe.command }}</span>
            </div>
          </div>

          <div v-if="entry.trust === 'probation'" :class="['mt-3', 'flex', 'gap-2']">
            <Button size="sm" variant="primary" @click="skillsStore.approve(entry.toolId)">
              {{ t('settings.pages.modules.skills.sections.queue.approve') }}
            </Button>
            <Button size="sm" variant="secondary" @click="skillsStore.reject(entry.toolId)">
              {{ t('settings.pages.modules.skills.sections.queue.reject') }}
            </Button>
          </div>
        </div>
      </div>
    </section>

    <section :class="['rounded-xl', 'bg-neutral-50', 'p-4', 'dark:bg-[rgba(0,0,0,0.3)]']">
      <h2 :class="['text-lg', 'text-neutral-500', 'md:text-2xl', 'dark:text-neutral-400']">
        {{ t('settings.pages.modules.skills.sections.catalog.title') }}
      </h2>
      <p :class="['text-sm', 'text-neutral-400', 'dark:text-neutral-500']">
        {{ t('settings.pages.modules.skills.sections.catalog.description') }}
      </p>
      <div v-for="entry in catalog" :key="entry.toolId" :class="['mt-3', 'rounded-lg', 'border', 'border-neutral-200', 'p-3', 'dark:border-neutral-700']">
        <div :class="['flex', 'items-center', 'justify-between']">
          <span :class="['font-mono', 'text-sm']">{{ entry.name }}</span>
          <Button size="sm" variant="secondary" @click="skillsStore.submit({ ...entry })">
            {{ t('settings.pages.modules.skills.sections.catalog.submit') }}
          </Button>
        </div>
        <p :class="['mt-1', 'text-xs', 'text-neutral-500', 'dark:text-neutral-400']">
          {{ entry.description }}
        </p>
      </div>
    </section>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.modules.skills.title
  subtitleKey: settings.title
  stageTransition:
    name: slide
</route>
