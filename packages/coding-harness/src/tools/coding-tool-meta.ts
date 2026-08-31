/**
 * Single-source model-facing metadata for the coding tools. Both
 * consumers derive their declarations from it — the Electron renderer builds
 * its xsAI zod tool descriptions here, and `createCodingTools` labels its
 * Code Mode bridge entries — so the two surfaces cannot drift apart.
 *
 * Lives in its own side-effect-free module so browser bundles can import the
 * metadata without pulling the Node-only workspace host.
 */
export const CODING_TOOL_META = {
  list: {
    name: 'list',
    description: 'List one directory level inside the workspace. Use it to discover files and subdirectories without running a shell command.',
    parameterDescriptions: {
      path: 'Directory inside the workspace, relative or absolute. Use "." for the workspace root.',
    },
  },
  read: {
    name: 'read',
    description: 'Read a text file inside the workspace. Every line carries a short content signature; use signatures (not copied lines) for edit.',
    parameterDescriptions: {
      path: 'Path inside the workspace, relative or absolute.',
      offset: 'Zero-based first line to read. Default 0.',
      limit: 'Maximum lines to return. Default 400.',
    },
  },
  readRaw: {
    name: 'readRaw',
    description: 'Read a text file inside the workspace and return its exact bytes unchanged. Use this when content is going to be parsed or executed (no line signatures).',
    parameterDescriptions: {
      path: 'Path inside the workspace, relative or absolute.',
    },
  },
  write: {
    name: 'write',
    description: 'Replace a whole text file only when baseHash still matches the latest read. Use null only when you expect a new file.',
    parameterDescriptions: {
      path: 'Path inside the workspace, relative or absolute.',
      content: 'Full new file content.',
      baseHash: 'Whole-file baseHash from read, or null only when the file must not exist.',
    },
  },
  edit: {
    name: 'edit',
    description: 'Replace a signed line range, delete it with empty newContent, or insert after one signed line. A rejection means the file changed; read it again.',
    parameterDescriptions: {
      path: 'Path inside the workspace, relative or absolute.',
      operation: 'Use replace for a line or closed range. Use insertAfter to add content after an unchanged anchor.',
      startSignature: 'Start-line signature for replace.',
      endSignature: 'Optional end-line signature for a closed replace range.',
      afterSignature: 'Anchor-line signature for insertAfter.',
      expectedPrefix: 'Leading characters of the start or anchor line as shown by read (16-32 chars).',
      newContent: 'Replacement or inserted content. Multiple lines are allowed. Empty content deletes a replace range.',
    },
  },
  bash: {
    name: 'bash',
    description: 'Run a shell command inside the workspace. Read-only/tests run freely; high-risk commands (push, delete, network, production) require user approval.',
    parameterDescriptions: {
      command: 'Shell command to run inside the workspace. High-risk commands require approval.',
      mediumApprovalRequired: 'Force approval for medium-tier commands (default false).',
    },
  },
} as const

export type CodingToolName = keyof typeof CODING_TOOL_META
