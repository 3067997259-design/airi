export { applyHashlineEdit, MIN_EXPECTED_PREFIX_LENGTH } from './hashline/edit'
export type { HashlineEditOutcome, HashlineEditParams, HashlineEditResult } from './hashline/edit'

export { buildSignedFileProjection, DEFAULT_MAX_LINE_CONTENT_LENGTH, formatSignedFileProjection } from './hashline/read'
export type { FormatSignedFileProjectionInput, SignedFileProjectionOptions, SignedLine } from './hashline/read'
export { base32Encode, fnv1a32, lineSignature, signatureLengthForLineCount } from './hashline/signature'
export type { LineSignatureOptions } from './hashline/signature'

export { contentHash, joinTextFile, parseTextFile } from './hashline/text'
export type { TextFileSnapshot, TextLineEnding } from './hashline/text'

export { createCodeModeRuntime } from './ptc/code-mode'
export type { CodeModeBridgeTrace, CodeModeRuntime, CodeModeRuntimeOptions, CodeModeTool, CodeRunFailure, CodeRunFailureKind, CodeRunResult } from './ptc/code-mode'

export { createWorkerError, hydrateWorkerError, serializeWorkerError } from './ptc/protocol'
export type {
  ParentToWorkerMessage,
  SandboxRunPayload,
  SandboxRunResult,
  SandboxWorkerState,
  SerializedWorkerError,
  WorkerToParentMessage,
} from './ptc/protocol'

export { executeSandboxedProgram } from './ptc/runner'
export type { SandboxRunnerOptions } from './ptc/runner'

export { bashDescriptionFor, CODING_TOOL_META, createCodingTools } from './tools/coding-tools'
export type { ApprovalOutcome, CodingToolName, CodingToolsOptions, ToolArgs } from './tools/coding-tools'

export {
  DEFAULT_GREP_MAX_MATCHES,
  formatWorkspaceGrep,
  MAX_GREP_CONTEXT_LINES,
  normalizeContextLines,
  normalizeMaxMatches,
  parseRipgrepEvent,
  truncateGrepContent,
} from './tools/grep'
export type { RipgrepHit, WorkspaceGrepMatch, WorkspaceGrepQuery, WorkspaceGrepResult } from './tools/grep'

export { resolveRipgrepPath, searchWorkspace } from './tools/grep-search'
export type { WorkspaceSearchOptions, WorkspaceSearchOutcome } from './tools/grep-search'

export { gitBashShell, POSIX_SHELL, powershellShell, selectWorkspaceShell, WINDOWS_POWERSHELL_FALLBACK } from './tools/shell'
export type { WorkspaceShell, WorkspaceShellKind, WorkspaceShellProbe, WorkspaceShellSyntax } from './tools/shell'

export { probeWorkspaceShell } from './tools/shell-probe'
export type { WorkspaceShellProbeOptions } from './tools/shell-probe'

export { createNodeWorkspaceHost, resolveInsideWorkspace } from './tools/workspace-host'
export type { CommandResult, NodeWorkspaceHostOptions, WorkspaceDirectoryEntry, WorkspaceHost, WorkspaceReadResult, WorkspaceWriteResult } from './tools/workspace-host'

export { bashApprovalRequired, classifyBashCommand } from '@proj-airi/core-agent'
export type { BashRiskTier } from '@proj-airi/core-agent'
