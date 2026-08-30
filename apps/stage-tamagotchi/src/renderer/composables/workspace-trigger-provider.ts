import type { TriggerPanelProvider } from './use-trigger-panel'

export type WorkspaceListDir = (path: string) => Promise<Array<{ name: string, kind: 'file' | 'dir' }>>
export type WorkspaceKindLabel = (kind: 'file' | 'directory') => string

/** Creates the `@` provider that lists only the current token directory. */
export function createWorkspaceTriggerProvider(listDir: WorkspaceListDir, labelFor: WorkspaceKindLabel): TriggerPanelProvider {
  return {
    trigger: '@',
    tokenCharacters: '[\\w\\-./]',
    async getSections(token) {
      const slashIndex = token.lastIndexOf('/')
      const directory = slashIndex < 0 ? '.' : token.slice(0, slashIndex) || '.'
      const basename = slashIndex < 0 ? token : token.slice(slashIndex + 1)
      const prefix = slashIndex < 0 ? '' : token.slice(0, slashIndex + 1)
      const needle = basename.toLocaleLowerCase()
      const entries = (await listDir(directory))
        .filter(entry => entry.name.toLocaleLowerCase().startsWith(needle))
        .sort((left, right) => left.kind === right.kind
          ? left.name.localeCompare(right.name)
          : left.kind === 'dir' ? -1 : 1)

      return [{
        id: 'workspace',
        items: entries.map(entry => ({
          id: `${entry.kind}:${prefix}${entry.name}`,
          label: `${entry.name}${entry.kind === 'dir' ? '/' : ''}`,
          description: labelFor(entry.kind === 'dir' ? 'directory' : 'file'),
          replacement: `@${prefix}${entry.name}${entry.kind === 'dir' ? '/' : ' '}`,
          ...(entry.kind === 'dir' ? { continueInput: true } : {}),
        })),
      }]
    },
  }
}
