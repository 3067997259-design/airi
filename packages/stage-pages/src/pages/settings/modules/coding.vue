<script setup lang="ts">
import { ChatApprovalCard } from '@proj-airi/stage-ui/components'
import { useCodingToolsStore } from '@proj-airi/stage-ui/stores/coding'
import { Button, FieldTextArea } from '@proj-airi/ui'
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const coding = useCodingToolsStore()
const { status, runView } = coding
const program = ref(`// Try the Code Mode sandbox: bridge() dispatches the four
// coding tools (read / write / edit / bash) against the workspace.
const file = await bridge('read', ['README.txt'])\nreturn file`)
const timeoutMs = ref(10_000)

onMounted(() => {
  void coding.refreshStatus()
})

async function run() {
  await coding.runProgram(program.value, timeoutMs.value)
}
</script>

<template>
  <div :class="['flex', 'flex-col', 'gap-6']">
    <ChatApprovalCard />

    <section :class="['rounded-xl', 'bg-neutral-50', 'p-4', 'dark:bg-[rgba(0,0,0,0.3)]']">
      <div :class="['flex', 'flex-col', 'gap-4']">
        <div>
          <h2 :class="['text-lg', 'text-neutral-500', 'md:text-2xl', 'dark:text-neutral-400']">
            {{ t('settings.pages.modules.coding.sections.tools.title') }}
          </h2>
          <p :class="['text-sm', 'text-neutral-400', 'dark:text-neutral-500']">
            {{ t('settings.pages.modules.coding.sections.tools.description') }}
          </p>
        </div>

        <div v-if="status" :class="['text-sm']">
          <span class="text-neutral-400">{{ t('settings.pages.modules.coding.sections.tools.root') }}:</span>
          <span class="font-mono">{{ status.workspaceRoot }}</span>
        </div>
        <div v-else :class="['text-sm', 'text-neutral-400']">
          {{ t('settings.pages.modules.coding.sections.tools.unavailable') }}
        </div>

        <div v-if="status" :class="['flex', 'flex-wrap', 'gap-2']">
          <span
            v-for="tool in status.tools"
            :key="tool.name"
            :class="['rounded-full', 'px-2', 'py-0.5', 'text-xs', tool.available ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400' : 'bg-neutral-200 text-neutral-500 dark:bg-neutral-700 dark:text-neutral-400']"
            :title="tool.description"
          >
            {{ tool.name }}
          </span>
        </div>
      </div>
    </section>

    <section :class="['rounded-xl', 'bg-neutral-50', 'p-4', 'dark:bg-[rgba(0,0,0,0.3)]']">
      <div :class="['flex', 'flex-col', 'gap-4']">
        <div>
          <h2 :class="['text-lg', 'text-neutral-500', 'md:text-2xl', 'dark:text-neutral-400']">
            {{ t('settings.pages.modules.coding.sections.code-mode.title') }}
          </h2>
          <p :class="['text-sm', 'text-neutral-400', 'dark:text-neutral-500']">
            {{ t('settings.pages.modules.coding.sections.code-mode.description') }}
          </p>
        </div>

        <FieldTextArea
          v-model="program"
          :rows="12"
          :label="t('settings.pages.modules.coding.sections.code-mode.program')"
          :placeholder="t('settings.pages.modules.coding.sections.code-mode.placeholder')"
        />

        <div :class="['flex', 'items-center', 'gap-3']">
          <Button icon="i-solar:play-bold-duotone" color="primary" :loading="runView.running" @click="run">
            {{ t('settings.pages.modules.coding.sections.code-mode.run') }}
          </Button>
          <span :class="['text-xs', 'text-neutral-400']">timeout {{ timeoutMs }}ms</span>
        </div>

        <div v-if="runView.traces.length > 0 || runView.logs.length > 0 || runView.value !== undefined || runView.error" :class="['rounded-lg', 'border', 'border-neutral-200', 'p-3', 'dark:border-neutral-700']">
          <div v-if="runView.error" :class="['text-sm', 'text-red-600', 'dark:text-red-400']">
            {{ runView.error }}
          </div>
          <div v-if="runView.traces.length > 0" :class="['flex', 'flex-col', 'gap-2']">
            <div v-for="(trace, index) in runView.traces" :key="`${trace.toolName}:${index}`" :class="['rounded', 'bg-neutral-100', 'p-2', 'text-xs', 'dark:bg-neutral-900']">
              <div :class="trace.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'">
                {{ trace.ok ? '✓' : '×' }} {{ trace.toolName }}
              </div>
              <pre :class="['mt-1', 'overflow-x-auto', 'whitespace-pre-wrap', 'text-neutral-500', 'dark:text-neutral-400']">{{ trace.resultSummary }}</pre>
            </div>
          </div>
          <pre v-if="runView.value !== undefined" :class="['mt-2', 'text-xs', 'overflow-x-auto']">{{ JSON.stringify(runView.value, null, 2) }}</pre>
          <pre v-if="runView.logs.length > 0" :class="['mt-2', 'text-xs', 'text-neutral-500', 'dark:text-neutral-400', 'overflow-x-auto']">{{ runView.logs.join('\n') }}</pre>
        </div>
      </div>
    </section>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.modules.coding.title
  subtitleKey: settings.title
  stageTransition:
    name: slide
</route>
