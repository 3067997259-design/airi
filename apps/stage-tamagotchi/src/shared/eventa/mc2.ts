import type { Mc2RecipeCandidate } from '../mc2/recipe'

import { defineInvokeEventa } from '@moeru/eventa'

/**
 * MC-2a mod-data contracts.
 *
 * The main process owns filesystem access; the renderer probe asks for
 * whitelisted entries only. Paths must stay under the roots configured with
 * `AIRI_MC2_JAR_ROOTS` (semicolon separated) or passed by the host.
 */
export interface Mc2ReadJarParams {
  jarPath: string
  entryPaths?: string[]
  patterns?: string[]
}

export interface Mc2ReadJarEntry {
  path: string
  text: string
}

export interface Mc2ReadJarResult {
  entries: Mc2ReadJarEntry[]
  candidates: Mc2RecipeCandidate[]
  truncated: boolean
}

export const mc2ReadJar = defineInvokeEventa<Mc2ReadJarResult, Mc2ReadJarParams>('eventa:invoke:electron:mc2:read-jar')
