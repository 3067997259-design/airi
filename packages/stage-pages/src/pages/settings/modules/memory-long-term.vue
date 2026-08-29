<script setup lang="ts">
import MemoryBrowser from './components/memory-browser.vue'
import MemoryLongTermControls from './components/memory-long-term-controls.vue'
</script>

<template>
  <div :class="['flex', 'flex-col', 'gap-6']">
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
