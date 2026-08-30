export interface ChatCommand {
  name: 'plan' | 'goal'
  subject: string
}

const COMMAND_REGEX = /^\/(plan|goal)\s+([\s\S]+)/

/** Parses a supported leading command and removes blank subject edges. */
export function parseChatCommand(text: string): ChatCommand | undefined {
  const match = COMMAND_REGEX.exec(text)
  const subject = match?.[2]?.trim()
  if (!match || !subject)
    return undefined
  return { name: match[1] as ChatCommand['name'], subject }
}

/** Builds the send-specific system section for one intercepted command. */
export function buildCommandSection(command: ChatCommand): string {
  const horizon = command.name === 'goal' ? 'long' : 'session'
  const lines = [
    '## Command',
    `The user selected \`/${command.name}\` for this request.`,
    `Subject: ${JSON.stringify(command.subject)}`,
    `Call \`plan_update\` now with action \`start\` and horizon \`${horizon}\`.`,
    'Create small ordered steps. Declare allowedTools, expectedEvidence, riskLevel, and approvalRequired for every step.',
    'The command does not bypass evidence or approval gates.',
  ]
  if (command.name === 'goal') {
    lines.push(
      'After one step has evidence, rewrite the remaining steps with plan_update action `start`.',
      'Keep the same plan id so the long goal remains one rolling record.',
    )
  }
  return lines.join('\n')
}
