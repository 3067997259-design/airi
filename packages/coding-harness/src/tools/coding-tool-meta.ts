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
    description: 'Replace a whole text file inside the workspace with new content.',
    parameterDescriptions: {
      path: 'Path inside the workspace, relative or absolute.',
      content: 'Full new file content.',
    },
  },
  edit: {
    name: 'edit',
    description: 'Line-level edit gated by Hashline: pass the target line\'s signature from read plus its expected prefix. Rejection means the file changed — re-read first.',
    parameterDescriptions: {
      path: 'Path inside the workspace, relative or absolute.',
      signature: 'The 2-4 character content signature of the target line from the read projection.',
      expectedPrefix: 'Leading characters of the line as shown by read (16-32 chars).',
      newLineContent: 'The full replacement line content.',
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
