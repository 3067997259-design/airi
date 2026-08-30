<script setup lang="ts">
import type { JournalEvent, PlanSpec } from '@proj-airi/core-agent'

import { errorMessageFrom } from '@moeru/std'
import { useCodingToolsStore } from '@proj-airi/stage-ui/stores/coding'
import { useJournalStore } from '@proj-airi/stage-ui/stores/journal'
import { usePlanStore } from '@proj-airi/stage-ui/stores/plans'
import { Button, Collapsible, FieldTextArea } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

// Maintenance console for the coding harness (MAINTENANCE-PLAN P2.3): the
// journal already records every tool call, approval, and plan event — this
// page flattens them plus the plan gate projection so wiring can be verified
// without owning a model credential. The plan editor doubles as a test bench
// for the verification gate, mirroring how the settings coding page benches
// the Code Mode sandbox.
const { t } = useI18n()
const journal = useJournalStore()
const planStore = usePlanStore()
const coding = useCodingToolsStore()
const { events } = storeToRefs(journal)
const { planViews } = storeToRefs(planStore)
// useCodingToolsStore is a plain composable (not a Pinia store), so its
// shallowRef is taken directly; Vue unwraps it in the template.
const codingStatus = coding.status

const showToolCalls = ref(true)
const showToolResults = ref(true)
const showPlanEvents = ref(true)
const showApprovals = ref(true)
const showOthers = ref(false)
const filterText = ref('')

const shownEvents = computed(() => {
  const text = filterText.value.trim().toLowerCase()
  return events.value.filter((event) => {
    if (!typeAllowed(event))
      return false
    if (!text)
      return true
    return JSON.stringify(event).toLowerCase().includes(text)
  })
})

function typeAllowed(event: JournalEvent) {
  if (event.type === 'tool/call')
    return showToolCalls.value
  if (event.type === 'tool/result')
    return showToolResults.value
  if (event.type === 'plan/update')
    return showPlanEvents.value
  if (event.type.startsWith('approval/'))
    return showApprovals.value
  return showOthers.value
}

function eventTitle(event: JournalEvent) {
  switch (event.type) {
    case 'tool/call':
      return `tool/call ${event.toolName}`
    case 'tool/result':
      return `tool/result ${event.toolName} ${event.ok ? 'ok' : 'failed'}${event.stepId ? ` · step ${event.stepId}` : ''}`
    case 'plan/update':
      return `plan/update ${event.planId ?? ''} ${event.stepId ?? ''} → ${event.status ?? ''}${event.reason ? ` (${event.reason})` : ''}`
    case 'approval/asked':
      return `approval/asked ${event.requestId}`
    case 'approval/decided':
      return `approval/decided ${event.requestId}`
    default:
      return event.type
  }
}

// -- Manual plan editor (verification-gate test bench) --

const planSpecText = ref(JSON.stringify({
  goal: 'Bench plan: read then write',
  steps: [
    {
      id: 'step-1',
      lane: 'coding',
      intent: 'Read the target file',
      allowedTools: ['read'],
      expectedEvidence: [{ source: 'tool_result', description: 'read output' }],
      riskLevel: 'low',
      approvalRequired: false,
    },
    {
      id: 'step-2',
      lane: 'coding',
      intent: 'Write the change',
      allowedTools: ['write'],
      expectedEvidence: [{ source: 'tool_result', description: 'write output' }],
      riskLevel: 'medium',
      approvalRequired: false,
    },
  ],
}, null, 2))
const planSpecError = ref('')

async function startPlanFromEditor() {
  planSpecError.value = ''
  try {
    const parsed = JSON.parse(planSpecText.value) as PlanSpec
    if (!parsed.goal || !Array.isArray(parsed.steps) || parsed.steps.length === 0)
      throw new Error('spec needs a goal and at least one step')
    await planStore.start(parsed)
  }
  catch (error) {
    planSpecError.value = errorMessageFrom(error) ?? 'Invalid plan spec'
  }
}

onMounted(() => {
  journal.ensureSession()
  void coding.refreshStatus()
})
</script>

<template>
  <div :class="['flex', 'flex-col', 'gap-6']">
    <section :class="['rounded-xl', 'bg-neutral-50', 'p-4', 'dark:bg-[rgba(0,0,0,0.3)]']">
      <div :class="['flex', 'flex-col', 'gap-4']">
        <div>
          <h2 :class="['text-lg', 'text-neutral-500', 'md:text-2xl', 'dark:text-neutral-400']">
            {{ t('tamagotchi.settings.devtools.pages.coding-console.title') }}
          </h2>
          <p :class="['text-sm', 'text-neutral-400', 'dark:text-neutral-500']">
            {{ t('tamagotchi.settings.devtools.pages.coding-console.plans-description') }}
          </p>
        </div>

        <div v-if="planViews.length === 0" :class="['text-sm', 'text-neutral-400']">
          {{ t('tamagotchi.settings.devtools.pages.coding-console.no-plans') }}
        </div>
        <Collapsible
          v-for="plan in planViews"
          :key="plan.id"
          :class="['rounded-lg', 'bg-neutral-100', 'px-3', 'py-2', 'dark:bg-neutral-800/60']"
        >
          <template #trigger="{ visible, setVisible }">
            <button
              type="button"
              :aria-expanded="visible"
              :class="['flex w-full items-center gap-2 text-start text-sm']"
              @click="setVisible(!visible)"
            >
              <span class="min-w-0 flex-1 truncate font-medium">{{ plan.goal }}</span>
              <span class="shrink-0 text-xs text-neutral-500">
                {{ plan.status }} · {{ plan.state.completedSteps.length }}/{{ plan.spec.steps.length }}
              </span>
            </button>
          </template>
          <div :class="['mt-2', 'flex', 'flex-col', 'gap-1', 'text-xs']">
            <div v-for="step in plan.spec.steps" :key="step.id" :class="['flex', 'gap-2']">
              <span class="w-20 shrink-0 font-mono">{{ step.id }}</span>
              <span class="min-w-0 flex-1 truncate">{{ step.intent }}</span>
              <span class="shrink-0 text-neutral-500">tools: {{ step.allowedTools.join(', ') || '—' }}</span>
            </div>
            <div v-if="plan.state.blockers.length > 0" :class="['text-red-500']">
              blockers: {{ plan.state.blockers.join('; ') }}
            </div>
            <div v-if="plan.state.evidenceRefs.length > 0" :class="['text-neutral-500']">
              evidence: {{ plan.state.evidenceRefs.length }} tool result(s)
            </div>
          </div>
        </Collapsible>
      </div>
    </section>

    <section :class="['rounded-xl', 'bg-neutral-50', 'p-4', 'dark:bg-[rgba(0,0,0,0.3)]']">
      <div :class="['flex', 'flex-col', 'gap-4']">
        <div>
          <h2 :class="['text-lg', 'text-neutral-500', 'md:text-2xl', 'dark:text-neutral-400']">
            {{ t('tamagotchi.settings.devtools.pages.coding-console.bench-description') }}
          </h2>
        </div>

        <FieldTextArea
          v-model="planSpecText"
          :rows="14"
          label="PlanSpec (JSON)"
          placeholder="{ goal, steps: [...] }"
        />
        <div v-if="planSpecError" :class="['text-sm', 'text-red-600']">
          {{ planSpecError }}
        </div>
        <div>
          <Button @click="startPlanFromEditor">
            {{ t('tamagotchi.settings.devtools.pages.coding-console.start-plan') }}
          </Button>
        </div>
      </div>
    </section>

    <section :class="['rounded-xl', 'bg-neutral-50', 'p-4', 'dark:bg-[rgba(0,0,0,0.3)]']">
      <div :class="['flex', 'flex-col', 'gap-4']">
        <div>
          <h2 :class="['text-lg', 'text-neutral-500', 'md:text-2xl', 'dark:text-neutral-400']">
            {{ t('tamagotchi.settings.devtools.pages.coding-console.host-description') }}
          </h2>
        </div>

        <div v-if="codingStatus" :class="['flex', 'flex-wrap', 'gap-2']">
          <span
            v-for="tool in codingStatus.tools"
            :key="tool.name"
            :class="['rounded-full', 'px-2', 'py-0.5', 'text-xs', tool.available ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400' : 'bg-neutral-200 text-neutral-500 dark:bg-neutral-700']"
          >
            {{ tool.name }}
          </span>
        </div>
        <div v-else :class="['text-sm', 'text-neutral-400']">
          {{ t('tamagotchi.settings.devtools.pages.coding-console.host-unavailable') }}
        </div>
      </div>
    </section>

    <section :class="['rounded-xl', 'bg-neutral-50', 'p-4', 'dark:bg-[rgba(0,0,0,0.3)]']">
      <div :class="['flex', 'flex-col', 'gap-4']">
        <div>
          <h2 :class="['text-lg', 'text-neutral-500', 'md:text-2xl', 'dark:text-neutral-400']">
            {{ t('tamagotchi.settings.devtools.pages.coding-console.journal-description') }}
          </h2>
        </div>

        <div :class="['flex', 'flex-wrap', 'items-center', 'gap-4', 'text-sm']">
          <label :class="['flex', 'items-center', 'gap-1']">
            <input v-model="showToolCalls" type="checkbox"> tool/call
          </label>
          <label :class="['flex', 'items-center', 'gap-1']">
            <input v-model="showToolResults" type="checkbox"> tool/result
          </label>
          <label :class="['flex', 'items-center', 'gap-1']">
            <input v-model="showPlanEvents" type="checkbox"> plan/update
          </label>
          <label :class="['flex', 'items-center', 'gap-1']">
            <input v-model="showApprovals" type="checkbox"> approval/*
          </label>
          <label :class="['flex', 'items-center', 'gap-1']">
            <input v-model="showOthers" type="checkbox"> other
          </label>
          <input
            v-model="filterText"
            :class="['min-w-40', 'flex-1', 'rounded-md', 'border', 'border-neutral-300', 'px-2', 'py-1', 'text-xs', 'dark:border-neutral-700', 'dark:bg-neutral-900']"
            placeholder="filter text"
          >
        </div>

        <div :class="['flex', 'flex-col', 'gap-1']">
          <div :class="['text-xs', 'text-neutral-400']">
            {{ shownEvents.length }} / {{ events.length }} events
          </div>
          <details
            v-for="event in shownEvents.slice(-300)"
            :key="event.seq"
            :class="['rounded', 'bg-neutral-100', 'px-2', 'py-1', 'text-xs', 'dark:bg-neutral-800/60']"
          >
            <summary :class="['cursor-pointer', 'font-mono']">
              #{{ event.seq }} {{ eventTitle(event) }}
            </summary>
            <pre :class="['mt-1', 'overflow-x-auto', 'whitespace-pre-wrap', 'text-neutral-500', 'dark:text-neutral-400']">{{ JSON.stringify(event, null, 2) }}</pre>
          </details>
        </div>
      </div>
    </section>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: tamagotchi.settings.devtools.pages.coding-console.title
  subtitleKey: tamagotchi.settings.devtools.title
</route>
