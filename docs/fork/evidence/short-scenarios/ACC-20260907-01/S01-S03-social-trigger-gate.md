# S01-S03 social trigger gate

- Status: S01 PASS; S02 PASS; S03 BLOCKED (no public scheduled-heartbeat path inside quiet hours)
- Runtime: Electron build through CDP `9250`; isolated test session `7khtOKjZRJDBGvUD7HgmD`; original `off` settings restored afterward.

The active Live2D model exposes appearance controls through the normal chat tool surface. `expression_set` produced real `appearance/changed` journal events for `flag` (seq 37) and `angry` (seq 51). No social decision or self-initiative message was added while the mode was `off` or `respond`.

S01 ran with mode `off` and an appearance change to `flag`. The heartbeat consumer did not run a social decision. S02 ran with mode `respond` and an appearance change to `angry`; the mode remained non-autonomous and no social decision was emitted.

S03 remains blocked. The UI test heartbeat is enabled only in `autonomous` mode and intentionally bypasses schedule and quiet-hour gates. Scheduled heartbeats are moved to the end of quiet hours by the main-process scheduler, so the product exposes no UI path that produces an appearance stimulus and then observes the `quiet-hours` gate during the quiet window. No store action or journal write was used to manufacture one.
