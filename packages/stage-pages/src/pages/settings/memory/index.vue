<script setup lang="ts">
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'

// The "Memory" settings entry was a `<WIP />` shell. The actual memory
// settings (MEMORY-DESIGN §9) live under settings/modules: short-term
// (runtime / compaction / pending-confirmation queue) and long-term
// (ranking / promotion / intrusion / browser). Redirect to the short-term
// page so the side-bar entry always lands on real content.
const router = useRouter()
onMounted(() => {
  void router.replace('/settings/modules/memory-short-term')
})
</script>

<template>
  <div />
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.memory.title
  subtitleKey: settings.title
  descriptionKey: settings.pages.memory.description
  icon: i-solar:leaf-bold-duotone
  settingsEntry: true
  order: 5
  stageTransition:
    name: slide
</route>
