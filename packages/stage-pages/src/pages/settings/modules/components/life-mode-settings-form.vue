<script setup lang="ts">
import type { LifeMode, LifeModeConfig } from '@proj-airi/stage-ui/stores/modules/life-mode'

import { Button, Callout, FieldInput } from '@proj-airi/ui'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  config: LifeModeConfig
}>()

const emit = defineEmits<{
  setMode: [mode: LifeMode]
  patch: [patch: Partial<LifeModeConfig>]
}>()

const { t } = useI18n()
const intervalMinutes = ref(props.config.intervalMinutes)
const dailyBudget = ref(props.config.dailyBudget)
const cooldownMinutes = ref(props.config.cooldownMinutes)
const quietHoursStart = ref(props.config.quietHoursStart)
const quietHoursEnd = ref(props.config.quietHoursEnd)
const modes: LifeMode[] = ['off', 'respond', 'autonomous']

watch(() => props.config, (config) => {
  intervalMinutes.value = config.intervalMinutes
  dailyBudget.value = config.dailyBudget
  cooldownMinutes.value = config.cooldownMinutes
  quietHoursStart.value = config.quietHoursStart
  quietHoursEnd.value = config.quietHoursEnd
}, { deep: true })

const quietHoursDuration = computed(() => {
  if (quietHoursStart.value === quietHoursEnd.value)
    return 0
  return (quietHoursEnd.value - quietHoursStart.value + 24) % 24
})

function commitNumber(key: keyof Omit<LifeModeConfig, 'mode'>, value: number): void {
  if (!Number.isFinite(value))
    return
  emit('patch', { [key]: value })
}
</script>

<template>
  <div :class="['flex', 'flex-col', 'gap-6']">
    <section :class="['rounded-xl', 'bg-neutral-50', 'p-4', 'dark:bg-[rgba(0,0,0,0.3)]']">
      <div :class="['flex', 'flex-col', 'gap-4']">
        <div>
          <h2 :class="['text-lg', 'text-neutral-500', 'md:text-2xl', 'dark:text-neutral-400']">
            {{ t('settings.pages.modules.life-mode.sections.mode.title') }}
          </h2>
          <p :class="['text-sm', 'text-neutral-400', 'dark:text-neutral-500']">
            {{ t('settings.pages.modules.life-mode.sections.mode.description') }}
          </p>
        </div>
        <div :class="['flex', 'flex-wrap', 'gap-2']">
          <Button
            v-for="mode in modes"
            :key="mode"
            :color="config.mode === mode ? 'primary' : 'neutral'"
            @click="emit('setMode', mode)"
          >
            {{ t(`settings.pages.modules.life-mode.sections.mode.${mode}`) }}
          </Button>
        </div>
        <p :class="['text-xs', 'text-neutral-400', 'dark:text-neutral-500']">
          {{ t(`settings.pages.modules.life-mode.sections.mode.${config.mode}-description`) }}
        </p>
      </div>
    </section>

    <section :class="['rounded-xl', 'bg-neutral-50', 'p-4', 'dark:bg-[rgba(0,0,0,0.3)]']">
      <div :class="['flex', 'flex-col', 'gap-4']">
        <div>
          <h2 :class="['text-lg', 'text-neutral-500', 'md:text-2xl', 'dark:text-neutral-400']">
            {{ t('settings.pages.modules.life-mode.sections.rhythm.title') }}
          </h2>
          <p :class="['text-sm', 'text-neutral-400', 'dark:text-neutral-500']">
            {{ t('settings.pages.modules.life-mode.sections.rhythm.description') }}
          </p>
        </div>
        <FieldInput
          v-model.number="intervalMinutes"
          type="number"
          min="1"
          :label="t('settings.pages.modules.life-mode.sections.rhythm.interval')"
          @change="commitNumber('intervalMinutes', intervalMinutes)"
        />
        <FieldInput
          v-model.number="dailyBudget"
          type="number"
          min="0"
          :label="t('settings.pages.modules.life-mode.sections.rhythm.budget')"
          @change="commitNumber('dailyBudget', dailyBudget)"
        />
        <FieldInput
          v-model.number="cooldownMinutes"
          type="number"
          min="0"
          :label="t('settings.pages.modules.life-mode.sections.rhythm.cooldown')"
          @change="commitNumber('cooldownMinutes', cooldownMinutes)"
        />
      </div>
    </section>

    <section :class="['rounded-xl', 'bg-neutral-50', 'p-4', 'dark:bg-[rgba(0,0,0,0.3)]']">
      <div :class="['flex', 'flex-col', 'gap-4']">
        <div>
          <h2 :class="['text-lg', 'text-neutral-500', 'md:text-2xl', 'dark:text-neutral-400']">
            {{ t('settings.pages.modules.life-mode.sections.quiet.title') }}
          </h2>
          <p :class="['text-sm', 'text-neutral-400', 'dark:text-neutral-500']">
            {{ t('settings.pages.modules.life-mode.sections.quiet.description') }}
          </p>
        </div>
        <div :class="['flex', 'flex-wrap', 'gap-4']">
          <FieldInput
            v-model.number="quietHoursStart"
            type="number"
            min="0"
            max="23"
            :label="t('settings.pages.modules.life-mode.sections.quiet.start')"
            @change="commitNumber('quietHoursStart', quietHoursStart)"
          />
          <FieldInput
            v-model.number="quietHoursEnd"
            type="number"
            min="0"
            max="23"
            :label="t('settings.pages.modules.life-mode.sections.quiet.end')"
            @change="commitNumber('quietHoursEnd', quietHoursEnd)"
          />
        </div>
        <p :class="['text-xs', 'text-neutral-400', 'dark:text-neutral-500']">
          {{ t('settings.pages.modules.life-mode.sections.quiet.hint') }}
        </p>
        <Callout
          v-if="quietHoursDuration >= 20"
          theme="orange"
          :label="t('settings.pages.modules.life-mode.sections.quiet.warning-title')"
        >
          {{ t('settings.pages.modules.life-mode.sections.quiet.long-warning', { hours: quietHoursDuration }) }}
        </Callout>
      </div>
    </section>
  </div>
</template>
