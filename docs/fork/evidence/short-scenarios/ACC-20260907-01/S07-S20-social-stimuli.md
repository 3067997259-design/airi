# S07-S20 social stimuli

- Runtime: Electron build through CDP `9250`; isolated chat session `7khtOKjZRJDBGvUD7HgmD`.
- The restored legacy session `447xo4obMHF4KCJiEbJmc` was never selected during these runs.
- Life Mode and the Live2D appearance state were restored after the runs.

## S07: appearance change during a work Flow

- Status: PASS
- A real work Flow was running with Flow ID `c5achwH2-qtE5kHBmyhNS` when appearance event seq `619` changed the exposed `wenhao` expression.
- The existing Flow remained the only active Flow. No second social Flow or social decision was started by the appearance event.

## S08: focused mode

- Status: BLOCKED
- The focused-mode setting was enabled, but the public runtime had no active `TaskMemory` (`tasks=[]`, `activeTasks=[]`). No public UI path was available to create the required active task without manufacturing a protocol event.

## S09: speech-active gate

- Status: BLOCKED
- The configured speech provider reported an upstream `401`, and the speech runtime was not playing (`nowSpeaking=false`). No valid public playback was available to exercise `speech-active`; no audio state was fabricated.

## S10: no active session

- Status: BLOCKED
- The public runtime always had the isolated test session active. Creating a no-session state would require deleting or altering a session, which is outside this acceptance run and could endanger the restored legacy conversation.

## S11: no stimulus

- Status: PASS
- Heartbeat seq `1050` persisted `outcome=no-stimulus` and `gate=no-stimulus`. No social decision or self-initiative message was added.

## S12: new appearance stimulus

- Status: PASS
- Appearance event seq `1041` changed `liuhan`. Heartbeat seq `1042` emitted a consideration, and decision seq `1049` was a valid `silence` decision with `sourceRefs` including `appearance:1041`.

## S13: repeated appearance stimulus

- Status: FAIL (no duplicate speech, but consideration was not deduplicated)
- Repeating the same expression produced events seq `1051` and `1052`, followed by another emitted heartbeat seq `1053` and decision seq `1060`.
- The decision was `silence`, so no repeated user-visible sentence was published. However, the repeated change still reached a second social decision with new source references instead of being suppressed by novelty deduplication.

## S14: completed D02 activity

- Status: PASS
- A real read/uppercase-write/readback chain ran in `S14-D02`: tool events seq `1066-1072` read `alpha`/`beta`, wrote `ALPHA`/`BETA`, and read the result back.
- Heartbeat seq `1145` led to decision seq `1153`, with `sourceRefs` `tool:1070` and `tool:1072`; the decision was `silence` and did not claim deployment or broader completion.

## S15: failed D03 activity

- Status: PASS
- The real chain read missing `D03/missing.txt` and received `ENOENT` at seq `1160`, listed the directory at seq `1162`, and read `brief.txt` at seq `1164`.
- Heartbeat seq `1176` led to decision seq `1183` with all three tool references. The decision was `silence`; no successful result was invented.

## S16: reviewed memory candidate

- Status: BLOCKED
- `listShareableFacts` returned no active reviewed facts for the isolated session's scope (`characterId=n8cz_qXFxNLwpJmuAsfIl`). No valid memory candidate was available.

## S17: corrected memory candidate

- Status: BLOCKED
- The required M02 corrected fact was not available as a shareable active memory in the isolated scope, so the old-fact rejection could not be exercised without creating or changing memory data outside the recorded M02 run.

## S18: stale old-journal activity

- Status: BLOCKED
- The oldest timestamp in the isolated test journal was only about `0.86` hours old, below the six-hour stale-candidate threshold. The clock was not changed, and the restored legacy session was not used as a stimulus source.

## S19: low-importance activity without a question

- Status: PASS
- A normal read produced tool result seq `1190`; heartbeat seq `1197` led to decision seq `1204` with action `silence`.
- No self-initiative chat message or execution plan was published from this low-importance material.

## S20: user question racing social consideration

- Status: PASS
- Appearance event seq `1205` triggered heartbeat seq `1206` and decision seq `1217`, which was `silence`.
- While consideration was in flight, the user message `先别说刚才的话题，请只回答 7 加 8。` received the assistant answer `15。`. No social speech was inserted before or after that answer.

## Continuation after social repairs (2026-09-09)

The original S13 and S20 records above are preserved. The repaired behavior
has separate controlled evidence:

- S13 now suppresses the same appearance value across heartbeat rounds, keeps
  a changed value eligible, and permits recurrence after a controlled 31-minute
  clock advance. No real 30-minute wait was used.
- S20 has a deterministic regression in which a delayed `speak` decision loses
  to user input and is not published afterward. The live run covered the
  silence branch; a provider-delayed live `speak` run remains unverified until
  a healthy provider is available.

Result: S13 is PASS for the controlled window and S20 is PASS for the race
regression. The live delayed-provider boundary remains open.
