<script setup lang="ts">
import { useMemoryStore } from '@proj-airi/stage-ui/stores/modules/memory'
import { FieldCheckbox, FieldInput, FieldRange } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const memoryStore = useMemoryStore()
const {
  shortTermHalfLifeHours,
  longTermHalfLifeHours,
  promotionAccessCount,
  promotionSessionCount,
  weightSimilarity,
  weightTimeRelevance,
  weightArousal,
  weightAccessCount,
  weightMoodCongruence,
  intrusionEnabled,
  intrusionBaseRate,
  intrusionCooldownMs,
} = storeToRefs(memoryStore)
</script>

<template>
  <div :class="['flex', 'flex-col', 'gap-6']">
    <section :class="['rounded-xl', 'bg-neutral-50', 'p-4', 'dark:bg-[rgba(0,0,0,0.3)]']">
      <div :class="['flex', 'flex-col', 'gap-4']">
        <div>
          <h2 :class="['text-lg', 'text-neutral-500', 'md:text-2xl', 'dark:text-neutral-400']">
            {{ t('settings.pages.modules.memory-long-term.sections.ranking.title') }}
          </h2>
          <p :class="['text-sm', 'text-neutral-400', 'dark:text-neutral-500']">
            {{ t('settings.pages.modules.memory-long-term.sections.ranking.description') }}
          </p>
        </div>

        <FieldRange v-model="weightSimilarity" :label="t('settings.pages.modules.memory-long-term.weights.similarity')" :min="0" :max="2" :step="0.05" :default-value="1.2" />
        <FieldRange v-model="weightTimeRelevance" :label="t('settings.pages.modules.memory-long-term.weights.time-relevance')" :min="0" :max="2" :step="0.05" :default-value="0.2" />
        <FieldRange v-model="weightArousal" :label="t('settings.pages.modules.memory-long-term.weights.arousal')" :min="0" :max="2" :step="0.05" :default-value="0.3" />
        <FieldRange v-model="weightAccessCount" :label="t('settings.pages.modules.memory-long-term.weights.access-count')" :min="0" :max="2" :step="0.05" :default-value="0.15" />
        <FieldRange v-model="weightMoodCongruence" :label="t('settings.pages.modules.memory-long-term.weights.mood-congruence')" :min="0" :max="2" :step="0.05" :default-value="0.25" />
      </div>
    </section>

    <section :class="['rounded-xl', 'bg-neutral-50', 'p-4', 'dark:bg-[rgba(0,0,0,0.3)]']">
      <div :class="['flex', 'flex-col', 'gap-4']">
        <div>
          <h2 :class="['text-lg', 'text-neutral-500', 'md:text-2xl', 'dark:text-neutral-400']">
            {{ t('settings.pages.modules.memory-long-term.sections.promotion.title') }}
          </h2>
          <p :class="['text-sm', 'text-neutral-400', 'dark:text-neutral-500']">
            {{ t('settings.pages.modules.memory-long-term.sections.promotion.description') }}
          </p>
        </div>
        <FieldRange v-model="shortTermHalfLifeHours" :label="t('settings.pages.modules.memory-long-term.short-term-half-life')" :min="1" :max="720" :step="1" :format-value="value => `${value}h`" :default-value="24" />
        <FieldRange v-model="longTermHalfLifeHours" :label="t('settings.pages.modules.memory-long-term.long-term-half-life')" :min="24" :max="8760" :step="24" :format-value="value => `${value}h`" :default-value="4320" />
        <div :class="['grid', 'gap-4', 'md:grid-cols-2']">
          <FieldInput v-model="promotionAccessCount" type="number" :label="t('settings.pages.modules.memory-long-term.promotion-access-count')" :description="t('settings.pages.modules.memory-long-term.promotion-access-count-description')" />
          <FieldInput v-model="promotionSessionCount" type="number" :label="t('settings.pages.modules.memory-long-term.promotion-session-count')" :description="t('settings.pages.modules.memory-long-term.promotion-session-count-description')" />
        </div>
      </div>
    </section>

    <section :class="['rounded-xl', 'bg-neutral-50', 'p-4', 'dark:bg-[rgba(0,0,0,0.3)]']">
      <div :class="['flex', 'flex-col', 'gap-4']">
        <div>
          <h2 :class="['text-lg', 'text-neutral-500', 'md:text-2xl', 'dark:text-neutral-400']">
            {{ t('settings.pages.modules.memory-long-term.sections.intrusion.title') }}
          </h2>
          <p :class="['text-sm', 'text-neutral-400', 'dark:text-neutral-500']">
            {{ t('settings.pages.modules.memory-long-term.sections.intrusion.description') }}
          </p>
        </div>
        <FieldCheckbox v-model="intrusionEnabled" :label="t('settings.pages.modules.memory-long-term.intrusion-enabled')" :description="t('settings.pages.modules.memory-long-term.intrusion-enabled-description')" />
        <FieldRange v-model="intrusionBaseRate" :label="t('settings.pages.modules.memory-long-term.intrusion-base-rate')" :min="0" :max="0.1" :step="0.005" :format-value="value => value.toFixed(3)" :default-value="0.02" />
        <FieldInput v-model="intrusionCooldownMs" type="number" :label="t('settings.pages.modules.memory-long-term.intrusion-cooldown')" :description="t('settings.pages.modules.memory-long-term.intrusion-cooldown-description')" />
      </div>
    </section>
  </div>
</template>
