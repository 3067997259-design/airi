<script setup lang="ts">
/**
 * EP-2a package devtools probe.
 *
 * The product surface is the settings section; this probe exists for the
 * acceptance run: it imports from an explicit directory path (the settings
 * page always opens a native dialog), drives the lifecycle through the
 * renderer store, and exposes the tool face plus the evidence author so a CDP
 * session can verify the EP-2a acceptance table end to end.
 */
import { defineInvoke } from '@moeru/eventa'
import { getElectronEventaContext } from '@proj-airi/electron-vueuse'
import { resolveEvidenceAuthor, useLlmToolsStore } from '@proj-airi/stage-ui/stores/ai/chat-llm/tools'
import { usePackagesStore } from '@proj-airi/stage-ui/stores/modules/packages'
import { contentHashOf, useSkillsReviewStore } from '@proj-airi/stage-ui/stores/skills'
import { onMounted, onUnmounted, ref } from 'vue'

import { extensionPackagesExport, extensionPackagesImport } from '../../../shared/eventa'
import { createCodingHostClient } from '../../bridges/coding-host'

declare global {
  interface Window {
    __AIRI_PACKAGES_SMOKE__?: {
      importDirectory: (directory: string) => Promise<{ packageId: string, version: string }>
      importArchive: (archivePath: string) => Promise<{ packageId: string, version: string }>
      list: () => Promise<unknown>
      refresh: () => Promise<void>
      trial: (packageId: string, version: string) => Promise<unknown>
      approve: (packageId: string, version: string) => Promise<unknown>
      activate: (packageId: string, version: string) => Promise<unknown>
      deactivate: (packageId: string) => Promise<unknown>
      rollback: (packageId: string, toVersion?: string) => Promise<unknown>
      uninstall: (packageId: string, version: string, purgeData?: boolean) => Promise<unknown>
      entries: () => unknown
      activePackages: () => unknown
      lastTrial: () => unknown
      lastError: () => string
      registrations: () => unknown
      toolNames: () => string[]
      executeTool: (toolName: string, input?: Record<string, unknown>) => Promise<unknown>
      evidenceAuthor: (toolName: string) => string
      reviewedSkills: () => unknown
      createReviewedSkill: (input: { toolId: string, name: string, description: string, source: string, parameters?: Record<string, unknown>, tools?: string[], executionTimeoutMs?: number }) => Promise<{ contentHash: string, workspaceRoot: string }>
      exportFiles: () => Promise<string[]>
    }
  }
}

const status = ref('idle')

onMounted(() => {
  const context = getElectronEventaContext()
  const importPackage = defineInvoke(context, extensionPackagesImport)
  const exportPackages = defineInvoke(context, extensionPackagesExport)

  window.__AIRI_PACKAGES_SMOKE__ = {
    importDirectory: async directory => importPackage({ directory }),
    importArchive: async archivePath => importPackage({ archivePath }),
    list: async () => usePackagesStore().refresh().then(() => usePackagesStore().entries),
    refresh: () => usePackagesStore().refresh(),
    trial: (packageId, version) => usePackagesStore().trial(packageId, version).then(() => usePackagesStore().lastTrial),
    approve: (packageId, version) => usePackagesStore().approve(packageId, version),
    activate: (packageId, version) => usePackagesStore().activate(packageId, version),
    deactivate: packageId => usePackagesStore().deactivate(packageId),
    rollback: (packageId, toVersion) => usePackagesStore().rollback(packageId, toVersion),
    uninstall: (packageId, version, purgeData) => usePackagesStore().uninstall(packageId, version, purgeData),
    entries: () => JSON.parse(JSON.stringify(usePackagesStore().entries)),
    activePackages: () => JSON.parse(JSON.stringify(usePackagesStore().activePackages)),
    lastTrial: () => JSON.parse(JSON.stringify(usePackagesStore().lastTrial ?? null)),
    lastError: () => usePackagesStore().error,
    registrations: () => useLlmToolsStore().registrations.filter(registration => registration.ownerKind === 'plugin' && registration.ownerId.includes('@')),
    toolNames: () => useLlmToolsStore().tools.map(tool => tool.function.name),
    executeTool: async (toolName, input) => {
      const tool = useLlmToolsStore().getToolsByNames(toolName)[0]
      if (!tool?.execute)
        throw new Error(`Tool "${toolName}" is not registered.`)
      return await tool.execute(input ?? {}, { messages: [], toolCallId: 'packages-smoke' })
    },
    evidenceAuthor: (toolName) => {
      const llmTools = useLlmToolsStore()
      const definition = llmTools.tools.find(tool => tool.function.name === toolName)
      const registration = llmTools.registrations.find(item => item.toolId === definition?.id)
      return resolveEvidenceAuthor(registration, useSkillsReviewStore().reviewedSkills)
    },
    reviewedSkills: () => JSON.parse(JSON.stringify(useSkillsReviewStore().reviewedSkills)),
    createReviewedSkill: async (input) => {
      const client = createCodingHostClient()
      const { workspaceRoot } = await client.listTools()
      await client.writeFile({ path: `skills/${input.toolId}/source.mjs`, content: input.source })
      // MC-1c: the declaration lives on disk and is re-read at execution, so
      // the probe writes the same meta.json shape that skill_submit writes.
      if (input.tools && input.tools.length > 0) {
        await client.writeFile({
          path: `skills/${input.toolId}/meta.json`,
          content: JSON.stringify({ tools: input.tools, ...(input.executionTimeoutMs ? { execution: { timeoutMs: input.executionTimeoutMs } } : {}) }, null, 2),
        })
      }
      const skills = useSkillsReviewStore()
      const result = await skills.submit({
        toolId: input.toolId,
        name: input.name,
        description: input.description,
        tool: {
          ownerExtensionId: 'airi',
          name: input.name,
          description: input.description,
          parameters: input.parameters ?? { type: 'object', properties: { echo: { type: 'string' } }, required: ['echo'], additionalProperties: false },
        },
        activation: { keywords: [input.toolId], patterns: [] },
        prompt: { id: input.toolId, content: `Use ${input.name}.` },
        contentHash: contentHashOf(input.source),
        riskLevel: 'low',
        staticAnalysis: { networkEgress: false, workspaceWrites: false, subprocess: false, readOnlySubprocess: false, credentialedAccess: false, destructiveOps: false },
        externalSources: [],
        ...(input.tools && input.tools.length > 0 ? { tools: [...input.tools] } : {}),
        ...(input.executionTimeoutMs ? { execution: { timeoutMs: input.executionTimeoutMs } } : {}),
        reason: 'self_tested',
      })
      if (!result.accepted)
        throw new Error(`Skill submit rejected: ${result.reason}`)
      const artifacts = await skills.readForReview(input.toolId)
      await skills.approve(input.toolId, artifacts)
      return { contentHash: artifacts.contentHash, workspaceRoot }
    },
    exportFiles: async () => (await exportPackages()).files.map(file => file.path),
  }
  status.value = 'probe ready'
})

onUnmounted(() => {
  delete window.__AIRI_PACKAGES_SMOKE__
})
</script>

<template>
  <div :class="['p-4', 'space-y-2']">
    <h1 :class="['text-lg', 'font-semibold']">
      Extension Packages
    </h1>
    <p :class="['text-sm', 'opacity-70']">
      {{ status }}
    </p>
  </div>
</template>
