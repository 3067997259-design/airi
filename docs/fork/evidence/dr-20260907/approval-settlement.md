# DR-1 command approval settlement

Date: 2026-09-07. Runtime: Vitest Node with an in-memory Eventa context and real coding host setup.
Window broadcasts are captured at the external transport boundary. Deadlines use fake timers.
No production profile, packaged Electron run, or agent-browser interaction occurred.

Two regressions failed before the fix: timeout denied execution without publishing a decision, and explicit rejection left its deadline active.
The host now settles each request ID once, clears its timer, and broadcasts the authoritative decision with the stored plan ID.
Late or duplicate decisions do not reopen a settled request. Plan-step approval uses the same deadline and rejection receipt.

The focused run passed 13 tests across coding-host/index.test.ts and coding-host/policy.test.ts.
It covers denied results, command and plan timeout rejection broadcasts, cancelled deadlines, and ignored late approval.
The first green run reported a process-close timeout and exited with code 0.
The final run after lint fixes passed all 12 tests and exited with code 0 without that warning.
This does not prove renderer card removal, journal persistence, real cross-window delivery, or human takeover rechecks.
DR-1 remains open.
