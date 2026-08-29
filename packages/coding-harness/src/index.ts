export { applyHashlineEdit, MIN_EXPECTED_PREFIX_LENGTH } from './hashline/edit'
export type { HashlineEditOutcome, HashlineEditParams, HashlineEditResult } from './hashline/edit'

export { buildSignedFileProjection, DEFAULT_MAX_LINE_CONTENT_LENGTH, formatSignedFileProjection } from './hashline/read'
export type { FormatSignedFileProjectionInput, SignedFileProjectionOptions, SignedLine } from './hashline/read'

export { base32Encode, fnv1a32, lineSignature, signatureLengthForLineCount } from './hashline/signature'
export type { LineSignatureOptions } from './hashline/signature'

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

export { createCodingTools } from './tools/coding-tools'
export type { ApprovalOutcome, CodingToolsOptions, ToolArgs } from './tools/coding-tools'

export { createNodeWorkspaceHost, resolveInsideWorkspace } from './tools/workspace-host'
export type { CommandResult, WorkspaceHost, WorkspaceReadResult } from './tools/workspace-host'

export { bashApprovalRequired, classifyBashCommand } from '@proj-airi/core-agent'
export type { BashRiskTier } from '@proj-airi/core-agent'
