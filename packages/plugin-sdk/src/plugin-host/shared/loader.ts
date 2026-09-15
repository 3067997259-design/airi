import type { Extension } from '../../extension'
import type { ExtensionLoadOptions, ExtensionManifestV1 } from './types'

/**
 * Fork addition (CP-2): one loading strategy per host instance.
 *
 * `ExtensionHost` resolves a loader once at construction. The default stays
 * {@link import('../runtimes/node/loaders').FileSystemLoader}; an isolated
 * runtime (for example a node-worker) can substitute its own implementation
 * without touching the host core.
 */
export interface ExtensionLoader {
  /** Resolve a manifest entrypoint for the requested runtime. */
  resolveEntrypointFor: (manifest: ExtensionManifestV1, options?: ExtensionLoadOptions) => string
  /** Load one extension definition from its entrypoint. */
  loadExtensionFor: (manifest: ExtensionManifestV1, options?: ExtensionLoadOptions) => Promise<Extension>
}
