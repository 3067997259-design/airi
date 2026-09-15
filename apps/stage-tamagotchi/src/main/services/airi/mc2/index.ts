/**
 * MC-2a host service: serves read-only mod-jar access to the renderer probe.
 */
import type { createContext as createMainEventaContext } from '@moeru/eventa/adapters/electron/main'

import { resolve } from 'node:path'
import { env } from 'node:process'

import { defineInvokeHandler } from '@moeru/eventa'

import { mc2ReadJar } from '../../../../shared/eventa'
import { Mc2DataError, readJarEntries } from './mod-data'

export interface Mc2HostOptions {
  /** Overrides the `AIRI_MC2_JAR_ROOTS` allowlist (semicolon separated). */
  jarRoots?: string[]
}

/** Registers the MC-2a invoke handlers; no code inside any jar is executed. */
export async function setupMc2Host(
  context: ReturnType<typeof createMainEventaContext>['context'],
  options: Mc2HostOptions = {},
): Promise<void> {
  const roots = (options.jarRoots ?? (env.AIRI_MC2_JAR_ROOTS ?? '').split(';'))
    .map(root => root.trim())
    .filter(Boolean)
    .map(root => resolve(root))

  defineInvokeHandler(context, mc2ReadJar, async ({ jarPath, entryPaths, patterns }) => {
    try {
      return await readJarEntries(jarPath, {
        roots,
        ...(entryPaths ? { entryPaths } : {}),
        ...(patterns ? { patterns } : {}),
      })
    }
    catch (error) {
      if (error instanceof Mc2DataError)
        throw new Error(`mc2 ${error.code}: ${error.message}`)
      throw error
    }
  })
}
