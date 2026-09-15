import type { ModulePermissionDeclaration } from '@proj-airi/plugin-sdk/plugin-host'

import { defineEventa, defineInvokeEventa } from '@moeru/eventa'

/**
 * CP-2 permission approval contracts.
 *
 * Approvals are persisted in the main process (`extensions/permissions.json`)
 * and bound to the manifest bytes. The renderer may display requests and
 * submit the user's approve/revoke action; it never decides the grant.
 */

/** One discovered extension with its requested and approved permission state. */
export interface ExtensionPermissionEntry {
  extensionId: string
  version: string
  path: string
  enabled: boolean
  loaded: boolean
  /** Declaration from the current manifest (`extension.airi.json`). */
  requested: ModulePermissionDeclaration
  /** Present only while the approval's manifest digest still matches. */
  approved?: {
    grant: ModulePermissionDeclaration
    approvedAt: number
  }
  /** Present when an approval record exists, even if the digest no longer matches. */
  manifestDigestMatches?: boolean
}

export const extensionPermissionsList = defineInvokeEventa<ExtensionPermissionEntry[]>('airi:permissions:list')
export const extensionPermissionsApprove = defineInvokeEventa<
  ExtensionPermissionEntry[],
  { extensionId: string, grant?: ModulePermissionDeclaration }
>('airi:permissions:approve')
export const extensionPermissionsRevoke = defineInvokeEventa<ExtensionPermissionEntry[], { extensionId: string }>('airi:permissions:revoke')
/** Broadcast after approve/revoke so other windows refresh the approval surface. */
export const extensionPermissionsChanged = defineEventa<void>('airi:permissions:changed')
