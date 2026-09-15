import type { Extension } from '../../../../extension'
import type { ExtensionLoadOptions, ExtensionManifestV1 } from '../../../shared/types'

import { isAbsolute, join } from 'node:path'
import { cwd } from 'node:process'
import { pathToFileURL } from 'node:url'

function isExtensionDefinition(value: unknown): value is Extension {
  return typeof value === 'object'
    && value !== null
    && 'id' in value
    && typeof (value as { id?: unknown }).id === 'string'
    && 'setup' in value
    && typeof (value as { setup?: unknown }).setup === 'function'
}

export function coerceExtensionFromModule(moduleValue: unknown): Extension {
  if (isExtensionDefinition(moduleValue)) {
    return moduleValue
  }

  if (typeof moduleValue === 'object' && moduleValue !== null) {
    const defaultExport = (moduleValue as { default?: unknown }).default
    if (isExtensionDefinition(defaultExport)) {
      return defaultExport
    }
  }

  throw new Error('Failed to resolve extension module. The entrypoint must export defineExtension(...).')
}

/**
 * Loads extension entrypoints from the local filesystem for the current runtime.
 *
 * Use when:
 * - The host needs to resolve a manifest entrypoint path
 * - The host needs to import a `defineExtension(...)` export
 *
 * Expects:
 * - Entry points are valid importable module paths for the active runtime
 *
 * Returns:
 * - Filesystem-backed helpers for resolving and loading extension entrypoints
 */
export class FileSystemLoader {
  /**
   * Resolve a manifest entrypoint for the requested runtime.
   *
   * Resolution order:
   * 1) `entrypoints.<runtime>`
   * 2) `entrypoints.default`
   * 3) `entrypoints.electron` (legacy fallback for current local extension manifests)
   */
  resolveEntrypointFor(manifest: ExtensionManifestV1, options?: ExtensionLoadOptions) {
    const runtime = options?.runtime ?? 'electron'
    const root = options?.cwd ?? cwd()
    const entrypoint
      = manifest.entrypoints[runtime]
        ?? manifest.entrypoints.default
        ?? manifest.entrypoints.electron

    if (!entrypoint) {
      throw new Error(''
        + `Extension entrypoint is required for runtime \`${runtime}\`. `
        + 'Define one of `entrypoints.<runtime>`, `entrypoints.default`, '
        + 'or `entrypoints.electron` in the extension manifest.',
      )
    }

    return isAbsolute(entrypoint) ? entrypoint : join(root, entrypoint)
  }

  async loadExtensionFor(manifest: ExtensionManifestV1, options?: ExtensionLoadOptions) {
    const entrypoint = this.resolveEntrypointFor(manifest, options)
    // NOTICE:
    // The default ESM loader rejects Windows absolute paths (`C:\...`) with
    // "Only URLs with a scheme in: file, data, node, and electron are
    // supported". Convert absolute entrypoints to file URLs; relative
    // specifiers keep their resolution semantics.
    // Source: surfaced live during CP-2 acceptance on Windows.
    // Removal: when upstream converts absolute paths internally.
    const specifier = isAbsolute(entrypoint) ? pathToFileURL(entrypoint).href : entrypoint
    const extensionModule = await import(specifier)
    return coerceExtensionFromModule(extensionModule)
  }
}
