<script setup lang="ts">
import { useLifeModeStore } from '@proj-airi/stage-ui/stores/modules/life-mode'
import { Button, FieldInput } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const lifeMode = useLifeModeStore()
const { config } = storeToRefs(lifeMode)

const MODES = ['off', 'respond', 'autonomous'] as const
type Mode = (typeof MODES)[number]

function modeKey(mode: Mode): string {
  return `settings.pages.modules.life-mode.modes.${mode}`
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
            v-for="mode in MODES"
            :key="mode"
            :color="config.mode === mode ? 'primary' : 'neutral'"
            @click="lifeMode.setMode(mode)"
          >
            {{ t(modeKey(mode)) }}
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
          v-model.number="config.intervalMinutes"
          type="number"
          min="1"
          :label="t('settings.pages.modules.life-mode.sections.rhythm.interval')"
          @change="lifeMode.setConfigPatch({ intervalMinutes: config.intervalMinutes })"
        />
        <FieldInput
          v-model.number="config.dailyBudget"
          type="number"
          min="0"
          :label="t('settings.pages.modules.life-mode.sections.rhythm.budget')"
          @change="lifeMode.setConfigPatch({ dailyBudget: config.dailyBudget })"
        />
        <FieldInput
          v-model.number="config.cooldownMinutes"
          type="number"
          min="0"
          :label="t('settings.pages.modules.life-mode.sections.rhythm.cooldown')"
          @change="lifeMode.setConfigPatch({ cooldownMinutes: config.cooldownMinutes })"
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
            v-model.number="config.quietHoursStart"
            type="number"
            min="0"
            max="23"
            :label="t('settings.pages.modules.life-mode.sections.quiet.start')"
            @change="lifeMode.setConfigPatch({ quietHoursStart: config.quietHoursStart })"
          />
          <FieldInput
            v-model.number="config.quietHoursEnd"
            type="number"
            min="0"
            max="23"
            :label="t('settings.pages.modules.life-mode.sections.quiet.end')"
            @change="lifeMode.setConfigPatch({ quietHoursEnd: config.quietHoursEnd })"
          />
        </div>
        <p :class="['text-xs', 'text-neutral-400', 'dark:text-neutral-500']">
          {{ t('settings.pages.modules.life-mode.sections.quiet.hint') }}
        </p>
      </div>
    </section>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.modules.life-mode.title
  subtitleKey: settings.title
  stageTransition:
    name: slide
</route>
