---
module: tooling
tags: [mimosa, git-hook, enobufs, memory-pressure]
problem_type: workflow
---

# Mimosa pre-commit scan: `scanner_enobufs` means machine resource exhaustion

Observed 2026-08-29 during the maintenance batches; resolved same day.

## Symptom

Every `git commit` printed:
"Mimosa 在 git commit 前没有得到完整扫描结论（scanner_enobufs）。本次按兼容策略继续，但不要宣称项目安全".

## Root cause

`scanner_enobufs` wraps the OS error `ENOBUFS` ("no buffer space available"):
the scanner could not allocate socket/system buffers at scan start. It is a
**machine resource exhaustion signal**, not a scanner defect. In this session
every affected commit ran while 7 Electron processes (DuckDB/Live2D/Pinia per
renderer), electron-vite builds, and CDP smoke tests were live on a 23.6 GB
RAM host.

## Solution

Rerun the audit with the machine idle. The same deep scan completed in ~28 s
once Electron instances and builds were stopped (7.4 GB free). Results of
that sealed run are recorded in `MAINTENANCE-PLAN.md`
(seal `sha256:4953f1f4...`).

## Rule of thumb

Do heavyweight commits (or trust their security verdicts) only when no
builds or Electron instances are running. If `scanner_enobufs` appears,
stop background load first, rerun the full audit via the Mimosa MCP tool
(`security_scan_start`, poll `security_scan_status`), and only then trust
or quote the verdict.
