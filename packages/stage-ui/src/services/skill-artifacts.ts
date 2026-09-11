import { contentHashOf } from '@proj-airi/skill-forge'

/** Built-in review example. It has no workspace files and uses its own executor. */
const source = [
  '// opencode adapter skeleton',
  'export async function run(rawArgs: string[]) {',
  '  const args = parseArgs(rawArgs)',
  '  return await execCommand(\'opencode \' + args.join(\' \'))',
  '}',
].join('\n')

export const builtInSkillArtifact = {
  toolId: 'opencode-adapter',
  source,
  contentHash: contentHashOf(source),
}
