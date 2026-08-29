<script setup lang="ts">
import MemoryShortTermControls from './components/memory-short-term-controls.vue'
</script>

<template>
  <MemoryShortTermControls />
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.modules.memory-short-term.title
  subtitleKey: settings.title
  stageTransition:
    name: slide
</route>
