<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'

// The sidebar "Memory" entry lands on the short-term page, so the long-term
// page would otherwise be reachable only by typing its URL. Both pages render
// this switch to keep the two scopes one hop apart.
const route = useRoute()
const { t } = useI18n()

const links = computed(() => [
  {
    to: '/settings/modules/memory-short-term',
    label: t('settings.pages.modules.memory-short-term.title'),
    active: route.path.startsWith('/settings/modules/memory-short-term'),
  },
  {
    to: '/settings/modules/memory-long-term',
    label: t('settings.pages.modules.memory-long-term.title'),
    active: route.path.startsWith('/settings/modules/memory-long-term'),
  },
])
</script>

<template>
  <div :class="['flex', 'gap-2']">
    <RouterLink
      v-for="link in links"
      :key="link.to"
      :to="link.to"
      :class="[
        'rounded-full px-3 py-1.5 text-sm transition-colors',
        link.active
          ? 'bg-primary-500/80 text-white dark:bg-primary-400/80'
          : 'bg-neutral-100 text-neutral-500 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700',
      ]"
    >
      {{ link.label }}
    </RouterLink>
  </div>
</template>
