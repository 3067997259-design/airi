# Core agent

This package owns chat orchestration, Flow lifecycle, planning evidence gates, approval contracts, and journal projections.
Stage applications supply model streams, tools, persistence, and other external boundaries.

## Use

Import public contracts and runtime functions from `@proj-airi/core-agent`.
Package exports resolve to `dist`, so rebuild this package before checking downstream changes.

```sh
pnpm -F @proj-airi/core-agent build
pnpm -F @proj-airi/core-agent typecheck
pnpm -F @proj-airi/core-agent exec vitest run
```

Use this package for execution policy shared by stage runtimes.
Keep Vue presentation in stage UI packages and Electron IPC or filesystem ownership in the desktop app.

## Completion reviews

The mechanical completion gate and the reviewer provide separate evidence.
The reviewer parser honors a structured verdict before reading its feedback.
Unsupported or malformed structured responses abstain. Feedback cannot turn abstention into approval.
Prose responses require a leading verdict, followed by a colon or dash when feedback follows.
A rejection must cite a receipt. The runtime records abstention separately from a passing review.

Regression tests cover parser decisions, evidence gates, and Flow settlement.
Production provider and packaged desktop acceptance remain separate checks.
