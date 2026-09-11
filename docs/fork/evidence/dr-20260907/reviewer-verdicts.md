# DR-1 reviewer verdict regression

Date: 2026-09-07. Runtime: Vitest Node. Provider/model: deterministic test boundaries only.
HEAD: `13c8edc2164980f53f4ea86a275155f8cd3df929` with uncommitted changes.
No production profile, remote provider, or packaged Electron run occurred.

## Failure

The completion reviewer parser searched the entire answer for `pass` or `approve` after handling some JSON verdicts.
An explicit abstention with feedback about passing tests therefore became a pass.
The same search also approved negated prose and a rejection that mentioned tests failing to pass.
Malformed JSON could fall through to this word search.

Three new tests failed before the correction, exit code 1.
They cover explicit abstention, unsupported verdicts, negated approval, malformed JSON, and rejection feedback containing `pass`.

## Correction

Structured verdicts are authoritative. Unsupported and malformed structured responses abstain without a prose fallback.
The prose path requires a leading verdict, followed by a colon or dash if feedback follows.
Existing receipt citation requirements still apply to rejections.
The change preserves abstention as a distinct review result and does not change the runtime's settlement policy.

## Checks

```sh
pnpm -F @proj-airi/core-agent exec vitest run src/planning/flow-completion.test.ts src/planning/evidence-gate.test.ts src/runtime/chat-orchestrator-runtime.test.ts
pnpm -F @proj-airi/core-agent build
pnpm typecheck
pnpm lint
```

The focused run passed 112 tests across 3 files, exit code 0. The package build passed, exit code 0.
The package exports target dist, so the rebuild preceded downstream typecheck.
Final root typecheck and lint passed, both with exit code 0. Lint retained existing warnings.
Parser source SHA-256: `62FE5D1C510EC4231F685720DDA662681F180B9DC438550525E97A6308CE6F79`.
Built `dist/index.mjs` SHA-256: `66952067D615B4E7387CD642D2C78D4A79F95FC70985510B6012FF1FEFA2597D`.

## Remaining DR-1 work

This regression proves parser behavior and retains existing runtime coverage. It does not prove real-provider approval refusal or timeout handling.
The full combination of done-boundary interruption, verification exceptions, human takeover, and external-state rechecks remains open.
No agent-browser interaction ran. DR-1 is not marked complete.
