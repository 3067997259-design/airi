import { EMOTION_EmotionMotionName_value, EMOTION_VALUES } from '../emotions'

/**
 * Assembles the app-owned sections of the provider system message.
 *
 * Use when:
 * - Composing the send-time system prompt supplement in the chat store
 *
 * Expects:
 * - The persisted session system message carries only the character identity;
 *   these sections are appended per-request so protocol, formatting, and tool
 *   state stay current without rewriting stored history
 */

/** Matches the ACT token marker to detect cards that already embed the stage protocol. */
const STAGE_PROTOCOL_MARKER = /<\|ACT/

/**
 * Whether a character prompt already teaches the stage control protocol.
 *
 * Use when:
 * - Deciding whether to inject `## Stage Control` for this send
 *
 * Expects:
 * - Legacy cards (e.g. the bundled default card) embed the protocol in their
 *  description; re-injecting it would duplicate hundreds of tokens
 *
 * Returns:
 * - `true` when the text contains an ACT marker
 */
export function containsStageProtocol(text: string | undefined): boolean {
  return typeof text === 'string' && STAGE_PROTOCOL_MARKER.test(text)
}

/**
 * Builds the `## Stage Control` section from i18n `base.prompt.protocol.*`.
 *
 * Use when:
 * - The active character identity does not already contain the protocol
 *
 * Expects:
 * - `t` resolves `base.prompt.protocol.body` (rules + "available emotions" lead)
 *  and `base.prompt.protocol.actions` (DELAY action list)
 *
 * Returns:
 * - The complete protocol section with the generated emotion list interleaved
 */
export function buildStageProtocolSection(t: (key: string) => string): string {
  const emotionList = EMOTION_VALUES
    .map(emotion => `- ${emotion} (Emotion for feeling ${EMOTION_EmotionMotionName_value[emotion]})`)
    .join('\n')
  return [
    '## Stage Control',
    t('base.prompt.protocol.body'),
    emotionList,
    t('base.prompt.protocol.actions'),
  ].join('\n\n')
}

/** Rendered-code-block language rule for the `## Output Formatting` section. */
const CODE_BLOCK_RULE = '- For any programming code block, always specify the programming language that supported on @shikijs/rehype on the rendered markdown, eg. ```python ... ```'

/** Math delimiter rules for the `## Output Formatting` section. */
const MATH_SYNTAX_RULES = [
  '- Use $$...$$ for inline math.',
  '- Use a separate multiline $$ block for each display equation.',
  '- Use a latex fence for a list of independent one-line equations.',
  '- Use a math fence for one multiline equation or LaTeX environment.',
  '- Do not use single dollar signs as math delimiters.',
].join('\n')

/** The app-owned `## Output Formatting` section (was baked into stored system messages). */
export const OUTPUT_FORMATTING_SECTION = [
  '## Output Formatting',
  CODE_BLOCK_RULE,
  MATH_SYNTAX_RULES,
].join('\n')

/** The `## Toolset` replacement used while tool calling is degraded for the model. */
export const TOOLS_UNAVAILABLE_SECTION = [
  '## Toolset',
  'Tool calling is currently unavailable for this model because the provider returned a tool-related error earlier in this session. Do not claim to have used any tools; answer directly from the conversation instead.',
].join('\n\n')
