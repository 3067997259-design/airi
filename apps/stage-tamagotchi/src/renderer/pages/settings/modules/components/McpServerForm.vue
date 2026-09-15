<script setup lang="ts">
import type { ServerForm } from '../mcp-config'

import { Button, FieldInput, FieldKeyValues, FieldSelect, GhostButton } from '@proj-airi/ui'
import { useI18n } from 'vue-i18n'

defineEmits<{ remove: [] }>()

const model = defineModel<ServerForm>({ required: true })

const { t } = useI18n()
const tn = (k: string, params?: Record<string, unknown>) => t(`settings.pages.modules.mcp-server.${k}`, params ?? {})

const transportOptions = [
  { label: tn('fields.transport.options.stdio'), value: 'stdio' },
  { label: tn('fields.transport.options.streamable-http'), value: 'streamable-http' },
  { label: tn('fields.transport.options.sse'), value: 'sse' },
]
</script>

<template>
  <div flex="~ col gap-4">
    <FieldInput
      v-model="model.identifier"
      :label="tn('fields.identifier.label')"
      :description="tn('fields.identifier.description')"
      :placeholder="tn('fields.identifier.placeholder')"
      required
    />
    <FieldSelect
      v-model="model.kind"
      :label="tn('fields.transport.label')"
      :description="tn('fields.transport.description')"
      :options="transportOptions"
      :placeholder="tn('fields.transport.label')"
    />

    <template v-if="model.kind === 'stdio'">
      <FieldInput
        v-model="model.command"
        :label="tn('fields.command.label')"
        :description="tn('fields.command.description')"
        :placeholder="tn('fields.command.placeholder')"
        required
      />
      <FieldInput
        v-model="model.argsText"
        :single-line="false"
        :label="tn('fields.args.label')"
        :description="tn('fields.args.description')"
        :placeholder="tn('fields.args.placeholder')"
        input-class="font-mono"
      />
      <FieldInput
        v-model="model.cwd"
        :label="tn('fields.cwd.label')"
        :description="tn('fields.cwd.description')"
        :placeholder="tn('fields.cwd.placeholder')"
        input-class="font-mono"
        :required="false"
      />
      <div flex="~ col gap-2">
        <FieldKeyValues
          v-model="model.envEntries"
          :label="tn('fields.env.label')"
          :description="tn('fields.env.description')"
          :key-placeholder="tn('fields.env.key-placeholder')"
          :value-placeholder="tn('fields.env.value-placeholder')"
          :required="false"
          @remove="(i) => model.envEntries.splice(i, 1)"
        />
        <div class="flex justify-end">
          <GhostButton
            size="sm"
            icon="i-solar:add-circle-bold-duotone" :label="tn('actions.add-env')"
            @click="model.envEntries.push({ key: '', value: '' })"
          />
        </div>
      </div>
    </template>

    <template v-else>
      <FieldInput
        v-model="model.url"
        :label="tn('fields.url.label')"
        :description="tn('fields.url.description')"
        :placeholder="tn('fields.url.placeholder')"
        input-class="font-mono"
        required
      />
      <div flex="~ col gap-2">
        <FieldKeyValues
          v-model="model.headersEntries"
          :label="tn('fields.headers.label')"
          :description="tn('fields.headers.description')"
          :key-placeholder="tn('fields.headers.key-placeholder')"
          :value-placeholder="tn('fields.headers.value-placeholder')"
          :required="false"
          @remove="(i) => model.headersEntries.splice(i, 1)"
        />
        <div class="flex justify-end">
          <GhostButton
            size="sm"
            icon="i-solar:add-circle-bold-duotone" :label="tn('actions.add-header')"
            @click="model.headersEntries.push({ key: '', value: '' })"
          />
        </div>
      </div>
    </template>

    <div :class="['grid grid-cols-1 gap-4', 'md:grid-cols-2']">
      <FieldInput
        v-model="model.requestTimeoutMs"
        type="number"
        :label="tn('fields.request-timeout.label')"
        :description="tn('fields.request-timeout.description')"
        :placeholder="tn('fields.request-timeout.placeholder')"
        :required="false"
      />
      <FieldInput
        v-model="model.maxTotalTimeoutMs"
        type="number"
        :label="tn('fields.max-total-timeout.label')"
        :description="tn('fields.max-total-timeout.description')"
        :placeholder="tn('fields.max-total-timeout.placeholder')"
        :required="false"
      />
    </div>

    <div class="flex justify-end border-t border-neutral-200/70 pt-2 dark:border-neutral-800">
      <Button
        size="sm"
        icon="i-solar:trash-bin-2-bold-duotone" :label="tn('actions.remove')"
        color="red"
        variant="primary" @click="$emit('remove')"
      />
    </div>
  </div>
</template>
