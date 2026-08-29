<script setup lang="ts">
import { useAttentionStore } from '@proj-airi/stage-ui/stores/attention'
import { FieldCheckbox } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const attentionStore = useAttentionStore()
const { focusedModeEnabled } = storeToRefs(attentionStore)
</script>

<template>
  <div :class="['flex', 'flex-col', 'gap-6']">
    <section :class="['rounded-xl', 'bg-neutral-50', 'p-4', 'dark:bg-[rgba(0,0,0,0.3)]']">
      <FieldCheckbox
        v-model="focusedModeEnabled"
        :label="t('settings.pages.modules.attention.focused-mode')"
        :description="t('settings.pages.modules.attention.focused-mode-description')"
      />
    </section>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.modules.attention.title
  subtitleKey: settings.title
  stageTransition:
    name: slide
</route>
