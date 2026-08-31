<script setup lang="ts">
import { useGithubConfigStore } from '@proj-airi/stage-ui/stores/github-config'
import { FieldInput } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const config = useGithubConfigStore()
const { pat, repo } = storeToRefs(config)
</script>

<template>
  <div :class="['flex', 'flex-col', 'gap-6']">
    <section :class="['rounded-xl', 'bg-neutral-50', 'p-4', 'dark:bg-[rgba(0,0,0,0.3)]']">
      <div :class="['flex', 'flex-col', 'gap-4']">
        <div>
          <h2 :class="['text-lg', 'text-neutral-500', 'md:text-2xl', 'dark:text-neutral-400']">
            {{ t('settings.pages.modules.github.connection.title') }}
          </h2>
          <p :class="['text-sm', 'text-neutral-400', 'dark:text-neutral-500']">
            {{ t('settings.pages.modules.github.connection.description') }}
          </p>
        </div>

        <FieldInput
          v-model="repo"
          :label="t('settings.pages.modules.github.repo')"
          :description="t('settings.pages.modules.github.repo-description')"
          placeholder="owner/name"
        />
        <FieldInput
          v-model="pat"
          type="password"
          :label="t('settings.pages.modules.github.pat')"
          :description="t('settings.pages.modules.github.pat-description')"
          placeholder="ghp_… / github_pat_…"
        />
        <p :class="['text-xs', 'text-neutral-400', 'dark:text-neutral-500']">
          {{ t('settings.pages.modules.github.rate-hint') }}
        </p>
      </div>
    </section>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.modules.github.title
  subtitleKey: settings.title
  stageTransition:
    name: slide
</route>
