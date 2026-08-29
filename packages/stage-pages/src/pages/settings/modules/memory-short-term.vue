<script setup lang="ts">
import MemoryScopeNav from './components/memory-scope-nav.vue'
import MemoryShortTermControls from './components/memory-short-term-controls.vue'
</script>

<template>
  <div :class="['flex', 'flex-col', 'gap-6']">
    <MemoryScopeNav />
    <MemoryShortTermControls />
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.modules.memory-short-term.title
  subtitleKey: settings.title
  stageTransition:
    name: slide
</route>
