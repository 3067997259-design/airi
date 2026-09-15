<script setup lang="ts">
import type { PackageListEntrySummary, PackageSkillCheckReason, PackageVersionSummary } from '../../../stores/modules/packages'

import { errorMessageFrom } from '@moeru/std'
import { Button } from '@proj-airi/ui'
import { computed, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { usePackagesStore } from '../../../stores/modules/packages'
import { useSkillsReviewStore } from '../../../stores/skills'

/**
 * EP-2a review surface: import, trial, approve, activate, roll back, uninstall.
 *
 * Approval binds the whole-package digest the trial computed; the user must
 * have seen the descriptor and the skill sources before confirming, so the
 * trial block lists every tool with its schema and offers the reviewed skill
 * source inline. A digest change invalidates the approval and the UI falls
 * back to "Approve".
 */

const { t } = useI18n()
const packagesStore = usePackagesStore()
const skillsStore = useSkillsReviewStore()

const purgeData = ref(false)
const sourceByTool = reactive<Record<string, string>>({})
const sourceError = ref('')

void packagesStore.refresh()

const entries = computed(() => packagesStore.entries)
const lastTrial = computed(() => packagesStore.lastTrial)

const CHECK_LABEL: Record<PackageSkillCheckReason, string> = {
  ok: 'settings.pages.modules.skills.sections.packages.skill-check.ok',
  source_missing: 'settings.pages.modules.skills.sections.packages.skill-check.source-missing',
  hash_mismatch: 'settings.pages.modules.skills.sections.packages.skill-check.hash-mismatch',
  review_hash_mismatch: 'settings.pages.modules.skills.sections.packages.skill-check.review-hash-mismatch',
  lock_mismatch: 'settings.pages.modules.skills.sections.packages.skill-check.lock-mismatch',
}

function rowKey(entry: PackageListEntrySummary, row: PackageVersionSummary): string {
  return `${entry.packageId}@${row.version}`
}

function isActiveElsewhere(entry: PackageListEntrySummary, row: PackageVersionSummary): boolean {
  return entry.versions.some(other => other.active) && !row.active
}

async function loadSource(toolId: string): Promise<void> {
  sourceError.value = ''
  try {
    sourceByTool[toolId] = (await skillsStore.readForReview(toolId)).source
  }
  catch (error) {
    sourceError.value = errorMessageFrom(error) ?? 'Cannot read the skill source.'
  }
}
</script>

<template>
  <section :class="['rounded-xl', 'bg-neutral-50', 'p-4', 'dark:bg-[rgba(0,0,0,0.3)]']">
    <div :class="['flex', 'flex-wrap', 'items-start', 'justify-between', 'gap-3']">
      <div>
        <h2 :class="['text-lg', 'text-neutral-500', 'md:text-2xl', 'dark:text-neutral-400']">
          {{ t('settings.pages.modules.skills.sections.packages.title') }}
        </h2>
        <p :class="['text-sm', 'text-neutral-400', 'dark:text-neutral-500']">
          {{ t('settings.pages.modules.skills.sections.packages.description') }}
        </p>
      </div>
      <div v-if="packagesStore.portAvailable" :class="['flex', 'flex-wrap', 'gap-2']">
        <Button size="sm" variant="secondary" :loading="packagesStore.busy" @click="packagesStore.importFromArchive()">
          {{ t('settings.pages.modules.skills.sections.packages.import-archive') }}
        </Button>
        <Button size="sm" variant="secondary" :loading="packagesStore.busy" @click="packagesStore.importFromDirectory()">
          {{ t('settings.pages.modules.skills.sections.packages.import-directory') }}
        </Button>
        <Button size="sm" variant="secondary" :loading="packagesStore.busy" @click="packagesStore.refresh()">
          {{ t('settings.pages.modules.skills.sections.packages.refresh') }}
        </Button>
      </div>
    </div>

    <p v-if="!packagesStore.portAvailable" :class="['mt-3', 'text-sm', 'text-neutral-400', 'dark:text-neutral-500']">
      {{ t('settings.pages.modules.skills.sections.packages.desktop-only') }}
    </p>

    <p v-if="packagesStore.error" role="alert" :class="['mt-3', 'text-sm', 'text-red-600', 'dark:text-red-400']">
      {{ packagesStore.error }}
    </p>
    <p v-if="sourceError" role="alert" :class="['mt-3', 'text-sm', 'text-amber-600', 'dark:text-amber-400']">
      {{ sourceError }}
    </p>

    <p v-if="entries.length === 0" :class="['mt-3', 'text-sm', 'text-neutral-400']">
      {{ t('settings.pages.modules.skills.sections.packages.empty') }}
    </p>

    <div v-for="entry in entries" :key="entry.packageId" :class="['mt-4', 'rounded-lg', 'border', 'border-neutral-200', 'p-3', 'dark:border-neutral-700']">
      <div :class="['flex', 'items-center', 'gap-2']">
        <span :class="['font-mono', 'text-sm']">{{ entry.packageId }}</span>
      </div>

      <div v-for="row in entry.versions" :key="rowKey(entry, row)" :class="['mt-2', 'rounded', 'border', 'border-neutral-200', 'p-2', 'dark:border-neutral-800']">
        <div :class="['flex', 'flex-wrap', 'items-center', 'gap-2']">
          <span :class="['font-mono', 'text-sm']">v{{ row.version }}</span>
          <span v-if="row.staged" :class="['rounded-full', 'bg-neutral-200', 'px-2', 'py-0.5', 'text-[10px]', 'dark:bg-neutral-700']">
            {{ t('settings.pages.modules.skills.sections.packages.status.staged') }}
          </span>
          <span v-if="row.approved" :class="['rounded-full', 'bg-emerald-100', 'px-2', 'py-0.5', 'text-[10px]', 'text-emerald-700', 'dark:bg-emerald-500/15', 'dark:text-emerald-400']">
            {{ t('settings.pages.modules.skills.sections.packages.status.approved') }}
          </span>
          <span v-if="row.active && row.enabled" :class="['rounded-full', 'bg-sky-100', 'px-2', 'py-0.5', 'text-[10px]', 'text-sky-700', 'dark:bg-sky-500/15', 'dark:text-sky-400']">
            {{ t('settings.pages.modules.skills.sections.packages.status.active') }}
          </span>
          <span v-else-if="row.active" :class="['rounded-full', 'bg-amber-100', 'px-2', 'py-0.5', 'text-[10px]', 'text-amber-700', 'dark:bg-amber-500/15', 'dark:text-amber-400']">
            {{ t('settings.pages.modules.skills.sections.packages.status.disabled') }}
          </span>
        </div>
        <p v-if="row.digest" :class="['mt-1', 'break-all', 'font-mono', 'text-[10px]', 'text-neutral-400', 'dark:text-neutral-500']">
          {{ row.digest }}
        </p>

        <div :class="['mt-2', 'flex', 'flex-wrap', 'gap-2']">
          <Button size="sm" variant="secondary" :loading="packagesStore.busy" @click="packagesStore.trial(entry.packageId, row.version)">
            {{ t('settings.pages.modules.skills.sections.packages.actions.trial') }}
          </Button>
          <Button size="sm" variant="primary" :loading="packagesStore.busy" @click="packagesStore.approve(entry.packageId, row.version)">
            {{ t('settings.pages.modules.skills.sections.packages.actions.approve') }}
          </Button>
          <Button v-if="row.approved && !(row.active && row.enabled)" size="sm" variant="secondary" :loading="packagesStore.busy" @click="packagesStore.activate(entry.packageId, row.version)">
            {{ t('settings.pages.modules.skills.sections.packages.actions.activate') }}
          </Button>
          <Button v-if="row.active && row.enabled" size="sm" variant="secondary" :loading="packagesStore.busy" @click="packagesStore.deactivate(entry.packageId)">
            {{ t('settings.pages.modules.skills.sections.packages.actions.deactivate') }}
          </Button>
          <Button v-if="row.approved && row.installed && isActiveElsewhere(entry, row)" size="sm" variant="secondary" :loading="packagesStore.busy" @click="packagesStore.rollback(entry.packageId, row.version)">
            {{ t('settings.pages.modules.skills.sections.packages.actions.rollback') }}
          </Button>
          <Button v-if="row.staged || row.installed" size="sm" variant="secondary" :loading="packagesStore.busy" @click="packagesStore.uninstall(entry.packageId, row.version, purgeData)">
            {{ t('settings.pages.modules.skills.sections.packages.actions.uninstall') }}
          </Button>
        </div>
        <label :class="['mt-1', 'flex', 'items-center', 'gap-2', 'text-[10px]', 'text-neutral-400', 'dark:text-neutral-500']">
          <input v-model="purgeData" type="checkbox">
          {{ t('settings.pages.modules.skills.sections.packages.purge-data') }}
        </label>

        <div v-if="lastTrial && lastTrial.packageId === entry.packageId && lastTrial.version === row.version" :class="['mt-3', 'rounded-lg', 'bg-neutral-100', 'p-3', 'dark:bg-neutral-900']">
          <p :class="['text-xs', 'text-neutral-500', 'dark:text-neutral-400']">
            {{ t('settings.pages.modules.skills.sections.packages.trial.digest') }}
          </p>
          <p :class="['break-all', 'font-mono', 'text-[10px]']">
            {{ lastTrial.digest }}
          </p>
          <div v-for="tool in lastTrial.tools" :key="tool.name" class="mt-2">
            <p :class="['font-mono', 'text-xs']">
              {{ tool.name }}
            </p>
            <p :class="['text-xs', 'text-neutral-500', 'dark:text-neutral-400']">
              {{ tool.description }}
            </p>
            <p :class="['font-mono', 'text-[10px]', 'text-neutral-400', 'dark:text-neutral-500']">
              skill:{{ tool.skill.toolId }}@{{ tool.skill.contentHash }}
            </p>
            <pre :class="['mt-1', 'max-h-40', 'overflow-auto', 'rounded', 'bg-neutral-100', 'p-2', 'text-[10px]', 'dark:bg-neutral-900']">{{ JSON.stringify(tool.parameters, null, 2) }}</pre>
            <Button size="sm" variant="secondary" :class="['mt-1']" @click="loadSource(tool.skill.toolId)">
              {{ t('settings.pages.modules.skills.sections.packages.actions.view-source') }}
            </Button>
            <pre v-if="sourceByTool[tool.skill.toolId]" :class="['mt-1', 'max-h-80', 'overflow-auto', 'rounded', 'bg-neutral-100', 'p-2', 'text-[10px]', 'dark:bg-neutral-900']">{{ sourceByTool[tool.skill.toolId] }}</pre>
          </div>
          <div class="mt-2">
            <p :class="['text-xs', 'text-neutral-500', 'dark:text-neutral-400']">
              {{ t('settings.pages.modules.skills.sections.packages.trial.skill-checks') }}
            </p>
            <p v-for="check in lastTrial.skillChecks" :key="check.toolId" :class="['font-mono', 'text-[10px]']">
              {{ check.toolId }} — {{ t(CHECK_LABEL[check.reason]) }}
            </p>
          </div>
          <p :class="['mt-2', 'text-xs', 'text-neutral-500', 'dark:text-neutral-400']">
            {{ t('settings.pages.modules.skills.sections.packages.trial.files', { count: lastTrial.files.length }) }}
          </p>
        </div>
      </div>
    </div>
  </section>
</template>
