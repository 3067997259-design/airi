<script setup lang="ts">
import type { SkillShelfItem } from '../composables/use-skill-shelf'

import { useI18n } from 'vue-i18n'

defineProps<{
  selectedIndex: number
  skills: SkillShelfItem[]
}>()

const emit = defineEmits<{
  select: [skill: SkillShelfItem]
}>()

const { t } = useI18n()
</script>

<template>
  <div
    :class="[
      'absolute bottom-full left-0 right-0 z-20 mb-2 overflow-hidden rounded-xl',
      'border border-neutral-200/60 shadow-lg backdrop-blur-md',
      'bg-white/95 dark:border-neutral-700/60 dark:bg-neutral-900/95',
    ]"
  >
    <div class="max-h-64 overflow-y-auto">
      <div
        v-if="skills.length === 0"
        class="px-3 py-4 text-sm text-neutral-400 dark:text-neutral-500"
      >
        {{ t('stage.skill-shelf.empty') }}
      </div>
      <button
        v-for="(skill, index) in skills"
        :key="skill.toolId"
        :class="[
          'flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left outline-none transition-colors',
          index === selectedIndex
            ? 'bg-primary-50 dark:bg-primary-900/30'
            : 'hover:bg-neutral-50 dark:hover:bg-neutral-800/60',
        ]"
        @mousedown.prevent
        @click="emit('select', skill)"
      >
        <span
          :class="[
            'text-sm font-medium',
            index === selectedIndex
              ? 'text-primary-600 dark:text-primary-300'
              : 'text-neutral-700 dark:text-neutral-200',
          ]"
        >
          {{ skill.name }}
        </span>
        <span class="line-clamp-1 text-xs text-neutral-400 dark:text-neutral-500">
          {{ skill.description }}
        </span>
      </button>
    </div>
    <div
      :class="[
        'border-t border-neutral-100 px-3 py-1 text-right text-[10px] text-neutral-400',
        'dark:border-neutral-800 dark:text-neutral-500',
      ]"
    >
      {{ t('stage.skill-shelf.hint') }}
    </div>
  </div>
</template>
