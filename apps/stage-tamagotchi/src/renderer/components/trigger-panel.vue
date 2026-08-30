<script setup lang="ts">
import type { TriggerPanelItem, TriggerPanelSection } from '../composables/use-trigger-panel'

defineProps<{
  selectedIndex: number
  sections: TriggerPanelSection[]
  emptyLabel: string
  hint: string
}>()

const emit = defineEmits<{
  select: [item: TriggerPanelItem]
}>()
</script>

<template>
  <div
    :class="[
      'absolute bottom-full left-0 right-0 z-20 mb-2 overflow-hidden rounded-xl',
      'border border-neutral-200/60 shadow-lg backdrop-blur-md',
      'bg-white/95 dark:border-neutral-700/60 dark:bg-neutral-900/95',
    ]"
  >
    <div :class="['max-h-64 overflow-y-auto']">
      <div
        v-if="sections.every(section => section.items.length === 0)"
        :class="['px-3 py-4 text-sm text-neutral-400 dark:text-neutral-500']"
      >
        {{ emptyLabel }}
      </div>
      <template v-else>
        <section v-for="section in sections" :key="section.id">
          <div
            v-if="section.label && section.items.length > 0"
            :class="[
              'border-b border-neutral-100 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide',
              'text-neutral-400 dark:border-neutral-800 dark:text-neutral-500',
            ]"
          >
            {{ section.label }}
          </div>
          <button
            v-for="item in section.items"
            :key="item.id"
            type="button"
            :class="[
              'flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left outline-none transition-colors',
              sections.flatMap(candidate => candidate.items).indexOf(item) === selectedIndex
                ? 'bg-primary-50 dark:bg-primary-900/30'
                : 'hover:bg-neutral-50 dark:hover:bg-neutral-800/60',
            ]"
            @mousedown.prevent
            @click="emit('select', item)"
          >
            <span :class="['flex w-full items-center gap-2']">
              <span
                :class="[
                  'min-w-0 flex-1 truncate text-sm font-medium',
                  sections.flatMap(candidate => candidate.items).indexOf(item) === selectedIndex
                    ? 'text-primary-600 dark:text-primary-300'
                    : 'text-neutral-700 dark:text-neutral-200',
                ]"
              >
                {{ item.label }}
              </span>
              <span
                v-if="item.badge"
                :class="['shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-[9px] text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400']"
              >
                {{ item.badge }}
              </span>
            </span>
            <span :class="['line-clamp-1 text-xs text-neutral-400 dark:text-neutral-500']">
              {{ item.description }}
            </span>
          </button>
        </section>
      </template>
    </div>
    <div
      :class="[
        'border-t border-neutral-100 px-3 py-1 text-right text-[10px] text-neutral-400',
        'dark:border-neutral-800 dark:text-neutral-500',
      ]"
    >
      {{ hint }}
    </div>
  </div>
</template>
