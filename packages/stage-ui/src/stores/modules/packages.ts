import { errorMessageFrom } from '@moeru/std'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { useSkillsReviewStore } from '../skills'

/**
 * EP-2a package review port.
 *
 * The package lifecycle lives in the Electron main process; this store is the
 * renderer-side injection port so any window (settings, stage) can review and
 * manage packages. The app shell installs the port once per renderer; web
 * builds never install it, so the settings surface reports the desktop-only
 * state instead of failing.
 *
 * Trust boundary: the renderer supplies the reviewed skill hashes it currently
 * holds (`expectedSkills`) with trial and approve. The main process verifies
 * package bytes against them; this store never decides trust on its own.
 */

export interface PackageSkillHash {
  toolId: string
  contentHash: string
}

export type PackageSkillCheckReason
  = | 'ok'
    | 'source_missing'
    | 'hash_mismatch'
    | 'review_hash_mismatch'
    | 'lock_mismatch'

export interface PackageToolSummary {
  name: string
  description: string
  parameters: Record<string, unknown>
  skill: PackageSkillHash
}

export interface PackageSkillCheckSummary {
  toolId: string
  contentHash: string
  reason: PackageSkillCheckReason
}

export interface PackageTrialSummary {
  packageId: string
  version: string
  digest: string
  tools: PackageToolSummary[]
  skillChecks: PackageSkillCheckSummary[]
  files: Array<{ path: string, sha256: string }>
}

export interface PackageApprovalSummary {
  packageId: string
  version: string
  digest: string
  approvedAt: number
  fileCount: number
}

export interface PackageActivationSummary {
  packageId: string
  version: string
  digest: string
  enabled: boolean
  activatedAt: number
}

export interface PackageVersionSummary {
  version: string
  digest?: string
  staged: boolean
  installed: boolean
  approved: boolean
  active: boolean
  enabled: boolean
}

export interface PackageListEntrySummary {
  packageId: string
  versions: PackageVersionSummary[]
}

/** One enabled, active package with the tools its descriptor exposes. */
export interface ActivePackageSummary {
  packageId: string
  version: string
  digest: string
  tools: PackageToolSummary[]
}

export interface PackageRuntimePort {
  list: () => Promise<PackageListEntrySummary[]>
  active: () => Promise<ActivePackageSummary[]>
  pickArchive: () => Promise<{ path?: string }>
  pickDirectory: () => Promise<{ path?: string }>
  importPackage: (input: { archivePath?: string, directory?: string }) => Promise<{ packageId: string, version: string, entries: PackageListEntrySummary[] }>
  trial: (input: { packageId: string, version: string, expectedSkills: PackageSkillHash[] }) => Promise<PackageTrialSummary>
  approve: (input: { packageId: string, version: string, expectedSkills: PackageSkillHash[] }) => Promise<PackageApprovalSummary>
  activate: (input: { packageId: string, version: string }) => Promise<PackageActivationSummary>
  deactivate: (input: { packageId: string }) => Promise<PackageListEntrySummary[]>
  rollback: (input: { packageId: string, toVersion?: string }) => Promise<PackageActivationSummary>
  uninstall: (input: { packageId: string, version: string, purgeData?: boolean }) => Promise<PackageListEntrySummary[]>
}

let port: PackageRuntimePort | undefined

/** Registers the main-process package host for this renderer. */
export function installPackageRuntimePort(next: PackageRuntimePort | undefined): void {
  port = next
}

/** True when this renderer can reach the main-process package host. */
export function hasPackageRuntimePort(): boolean {
  return port !== undefined
}

export const usePackagesStore = defineStore('extension-packages', () => {
  const entries = ref<PackageListEntrySummary[]>([])
  const activePackages = ref<ActivePackageSummary[]>([])
  const busy = ref(false)
  const error = ref('')
  const lastImported = ref<{ packageId: string, version: string }>()
  const lastTrial = ref<PackageTrialSummary>()

  const portAvailable = computed(() => hasPackageRuntimePort())

  async function refresh(): Promise<void> {
    if (!port)
      return
    const [nextEntries, nextActive] = await Promise.all([port.list(), port.active()])
    entries.value = nextEntries
    activePackages.value = nextActive
  }

  async function run<T>(operation: () => Promise<T>): Promise<T | undefined> {
    if (!port) {
      error.value = 'Package management is available in the desktop app only.'
      return undefined
    }
    busy.value = true
    error.value = ''
    try {
      return await operation()
    }
    catch (cause) {
      error.value = errorMessageFrom(cause) ?? 'Package operation failed'
      return undefined
    }
    finally {
      busy.value = false
    }
  }

  function expectedSkills(): PackageSkillHash[] {
    return useSkillsReviewStore().reviewedSkills.map(skill => ({ toolId: skill.toolId, contentHash: skill.contentHash }))
  }

  async function importFromArchive(): Promise<void> {
    await run(async () => {
      const picked = await port!.pickArchive()
      if (!picked.path)
        return
      lastImported.value = await port!.importPackage({ archivePath: picked.path }).then(result => ({ packageId: result.packageId, version: result.version }))
      await refresh()
    })
  }

  async function importFromDirectory(): Promise<void> {
    await run(async () => {
      const picked = await port!.pickDirectory()
      if (!picked.path)
        return
      lastImported.value = await port!.importPackage({ directory: picked.path }).then(result => ({ packageId: result.packageId, version: result.version }))
      await refresh()
    })
  }

  async function trial(packageId: string, version: string): Promise<void> {
    await run(async () => {
      lastTrial.value = await port!.trial({ packageId, version, expectedSkills: expectedSkills() })
    })
  }

  async function approve(packageId: string, version: string): Promise<void> {
    await run(async () => {
      await port!.approve({ packageId, version, expectedSkills: expectedSkills() })
      await refresh()
    })
  }

  async function activate(packageId: string, version: string): Promise<void> {
    await run(async () => {
      await port!.activate({ packageId, version })
      await refresh()
    })
  }

  async function deactivate(packageId: string): Promise<void> {
    await run(async () => {
      entries.value = await port!.deactivate({ packageId })
      activePackages.value = await port!.active()
    })
  }

  async function rollback(packageId: string, toVersion?: string): Promise<void> {
    await run(async () => {
      await port!.rollback({ packageId, toVersion })
      await refresh()
    })
  }

  async function uninstall(packageId: string, version: string, purgeData = false): Promise<void> {
    await run(async () => {
      entries.value = await port!.uninstall({ packageId, version, purgeData })
      activePackages.value = await port!.active()
    })
  }

  return {
    entries,
    activePackages,
    busy,
    error,
    lastImported,
    lastTrial,
    portAvailable,

    refresh,
    importFromArchive,
    importFromDirectory,
    trial,
    approve,
    activate,
    deactivate,
    rollback,
    uninstall,
  }
})
