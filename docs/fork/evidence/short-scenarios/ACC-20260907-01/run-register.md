# ACC-20260907-01 short-scenario register

- Date: `2026-09-07`
- Profile: `C:\Users\86130\AppData\Roaming\@proj-airi/stage-tamagotchi`
- Build: post-fix Electron build; see [B01](B01-build-identity.md)
- Evidence root: `docs/fork/evidence/short-scenarios/ACC-20260907-01/workspace/`
- Browser control session: `airi-short-acceptance-20260908-file`
- CDP port: `9250`

Only scenarios with answer, behavior, and required persistence evidence can be marked `PASS`. The initial B01 failure is retained in its own record. The initial B02 failure is retained in its own record, and its later UI retest passed.

| Group | Scenario | Status |
| --- | --- | --- |
| B | B01 | PASS |
| B | B02 | PASS (initial attempt blocked; retest passed) |
| D | D01 | PASS |
| D | D02 | PASS (recovery path recorded) |
| D | D03 | PASS |
| D | D04 | PASS (normal and read-failure variants) |
| D | D05 | FAIL (reject retry); timeout/late BLOCKED |
| D | D06 | FAIL (question card unavailable) |
| D | D07 | PASS (Escape stop, exact recovery reply, reload persistence) |
| D | D08 | PASS (same task/flow projection across chat and settings; one write) |
| M | M01 | FAIL (extracted fact visible; new-session answer empty) |
| M | M02 | FAIL (correction fragments visible; new-session answer empty) |
| M | M03 | PASS (unknown and false-premise probes did not fabricate) |
| M | M04 | FAIL (role isolation probes pass; role-scoped recall unavailable) |
| M | M05 | FAIL (new-session date recall unavailable) |
| M | M06 | FAIL (new-session answer empty) |
| M | M07 | FAIL (new-session answer empty) |
| M | M08 | BLOCKED (no public dreaming trigger) |
| L | L01 | FAIL (file path passed; step-1 remains unverified) |
| L | L02 | FAIL (UI switch observed; long-goal run used stale root) |
| L | L03 | FAIL (manual re-check completed; plan evidence remains unverified) |
| L | L04 | BLOCKED (R01 backup prerequisite failed) |
| L | L05 | BLOCKED (R01 backup prerequisite failed) |
| L | L06 | FAIL (pause persisted; resume used ordinary Flow and did not settle the goal) |
| L | L07 | FAIL (revision was received, but the old output was already written; plan evidence did not settle) |
| S | S01 | PASS (off mode ignored real appearance change) |
| S | S02 | PASS (respond mode did not start autonomous social decision) |
| S | S03 | BLOCKED (no public scheduled-heartbeat path inside quiet hours) |
| S | S04 | PASS (daily budget gate) |
| S | S05 | PASS (cooldown gate) |
| S | S06 | PASS (busy gate captured during a real normal stream) |
| S | S07 | PASS (appearance change did not start a second social Flow) |
| S | S08 | BLOCKED (no active public task for focused mode) |
| S | S09 | BLOCKED (no valid speech playback; configured speech upstream returned 401) |
| S | S10 | BLOCKED (no public no-session path; session deletion prohibited) |
| S | S11 | PASS (no-stimulus gate) |
| S | S12 | PASS (appearance source reached a valid silence decision) |
| S | S13 | FAIL (repeat reached another decision; no duplicate speech) |
| S | S14 | PASS (real D02 completion source) |
| S | S15 | PASS (real D03 failure source) |
| S | S16 | BLOCKED (no shareable reviewed memory in isolated scope) |
| S | S17 | BLOCKED (no shareable corrected M02 fact in isolated scope) |
| S | S18 | BLOCKED (journal activity was below stale threshold) |
| S | S19 | PASS (low-importance activity produced silence only) |
| S | S20 | PASS (user arithmetic answer won the race) |
| V | V01 | FAIL (shapes consumed; visible text missed) |
| V | V02 | FAIL (stale-frame guard passed; stop checkpoint unavailable) |
| V | V03 | FAIL (visual activity passed; new-session recall empty) |
| K | K01 | PASS (initial rejected submissions retained) |
| K | K02 | BLOCKED (settings UI does not expose source/self-test) |
| K | K03 | BLOCKED (K02) |
| K | K04 | BLOCKED (K02) |
| K | K05 | BLOCKED (K02) |
| K | K06 | BLOCKED (K02) |
| K | K07 | BLOCKED (K02) |
| R | R01 | FAIL (export gate) |
| R | R02 | BLOCKED (no R01 ZIP) |
| R | R03 | BLOCKED (no restored profile) |
| R | R04 | BLOCKED (no restored profile) |
| R | R05 | BLOCKED (no restored profile) |
| R | R06 | BLOCKED (no sync backend fixture) |
| R | R07 | BLOCKED (no R01 ZIP) |
