<script setup lang="ts">
import { Callout } from '@proj-airi/ui'
import { useI18n } from 'vue-i18n'

import MemoryBrowser from './components/memory-browser.vue'
import MemoryLongTermControls from './components/memory-long-term-controls.vue'
import MemoryScopeNav from './components/memory-scope-nav.vue'

const { t } = useI18n()
</script>

<template>
  <div :class="['flex', 'flex-col', 'gap-6']">
    <MemoryScopeNav />
    <Callout theme="orange" :label="t('settings.pages.modules.memory-long-term.wiring-note')">
      {{ t('settings.pages.modules.memory-long-term.wiring-note-description') }}
    </Callout>
    <MemoryLongTermControls />
    <MemoryBrowser />
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.modules.memory-long-term.title
  subtitleKey: settings.title
  stageTransition:
    name: slide
</route>
