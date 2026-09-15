import type { ExecutableTool, ToolRegistrationInput } from '@proj-airi/stage-ui/stores/ai/chat-llm/tools'
import type { ActivePackageSummary } from '@proj-airi/stage-ui/stores/modules/packages'

import { errorMessageFrom } from '@moeru/std'
import { useLlmToolsStore } from '@proj-airi/stage-ui/stores/ai/chat-llm/tools'
import { usePackagesStore } from '@proj-airi/stage-ui/stores/modules/packages'
import { useSkillsReviewStore } from '@proj-airi/stage-ui/stores/skills'
import { defineStore } from 'pinia'
import { ref, toRaw, watch } from 'vue'

import { isSyncedLeaderWindow } from '../window-context'

/**
 * EP-2a registration sync: projects enabled active packages onto the tool face.
 *
 * Only the leader window registers executors — followers would bind closures
 * that the leader's model calls can never reach. Registration is replace-first:
 * a changed digest or version removes the package's old tools before adding the
 * new ones, so no model-facing name is ever owned by two registrations.
 *
 * Package tools execute the reviewed skill named in their descriptor through
 * the skills store's sandbox; the package adds no execution trust of its own
 * (EP-0 D1: the evidence author is read from the deepest chain entry).
 */
export const usePackageToolsRegistrationStore = defineStore('package-tools-registration', () => {
  const packagesStore = usePackagesStore()
  const llmToolsStore = useLlmToolsStore()
  const lastError = ref('')

  /** packageId → digest + tool registration ids currently on the tool face. */
  const registered = new Map<string, { digest: string, toolIds: Set<string> }>()

  function packageToolId(pkg: ActivePackageSummary, toolName: string): string {
    return `plugin:${pkg.packageId}@${pkg.version}:${toolName}`
  }

  function registrationFor(pkg: ActivePackageSummary, tool: ActivePackageSummary['tools'][number]): { tool: ExecutableTool, registration: ToolRegistrationInput } {
    const toolId = packageToolId(pkg, tool.name)
    return {
      tool: {
        id: toolId,
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          // `activePackages` is a reactive projection; structuredClone needs
          // the raw object (same pattern as the skills store registrations).
          parameters: structuredClone(toRaw(tool.parameters)),
        },
        defaultActive: true,
        execute: input => useSkillsReviewStore().executeReviewedSkill(tool.skill.toolId, input),
      },
      registration: {
        toolId,
        toolName: tool.name,
        ownerKind: 'plugin' as const,
        ownerId: `${pkg.packageId}@${pkg.version}`,
        execution: {
          kind: 'coding_sandbox' as const,
          chain: [`plugin:${pkg.packageId}@${pkg.digest}`, `skill:${tool.skill.toolId}@${tool.skill.contentHash}`],
        },
        approvedContentHash: pkg.digest,
      },
    }
  }

  async function sync(): Promise<void> {
    if (!isSyncedLeaderWindow())
      return
    lastError.value = ''

    const desired = new Map(packagesStore.activePackages.map(pkg => [pkg.packageId, pkg]))

    const stale: string[] = []
    for (const [packageId, entry] of registered) {
      const next = desired.get(packageId)
      // A re-approved digest under the same version replaces the whole
      // package: the chain and evidence hash must follow the approved bytes.
      if (!next || next.digest !== entry.digest) {
        stale.push(...entry.toolIds)
        continue
      }
      for (const toolId of entry.toolIds) {
        if (!next.tools.some(tool => packageToolId(next, tool.name) === toolId))
          stale.push(toolId)
      }
    }
    if (stale.length > 0)
      await llmToolsStore.removeToolsByIds(...stale)

    const nextRegistered = new Map<string, { digest: string, toolIds: Set<string> }>()
    for (const [packageId, pkg] of desired) {
      const existing = registered.get(packageId)
      const kept = new Set<string>()
      const additions: Array<{ tool: ExecutableTool, registration: ToolRegistrationInput }> = []

      for (const tool of pkg.tools) {
        const toolId = packageToolId(pkg, tool.name)
        if (existing?.digest === pkg.digest && existing.toolIds.has(toolId) && !stale.includes(toolId)) {
          kept.add(toolId)
          continue
        }
        additions.push(registrationFor(pkg, tool))
      }

      if (additions.length > 0) {
        try {
          await llmToolsStore.addRegisteredTools(...additions)
          for (const addition of additions)
            kept.add(addition.registration.toolId)
        }
        catch (error) {
          lastError.value = errorMessageFrom(error) ?? 'Package tool registration failed'
        }
      }
      nextRegistered.set(packageId, { digest: pkg.digest, toolIds: kept })
    }

    registered.clear()
    for (const [packageId, entry] of nextRegistered)
      registered.set(packageId, entry)
  }

  watch(() => packagesStore.activePackages, () => {
    void sync()
  }, { deep: true, immediate: true })

  return { lastError, sync }
})
