# L07 revision during a running long goal

- Status: FAIL (the revision was received, but the old output was written before the revision)
- Isolated chat session: `EiMwdlHKDXUTiLkEI2dS_`.
- Workspace: `workspace/L07-retest/`.
- Fixture: `workspace/L07-retest/brief.txt`.

The goal first required the assistant to read `brief.txt`, write `initial-result.txt`, and read that file back. While the goal was running, the user changed the output requirement to `revised-result.txt` and asked the assistant not to write the old target.

The assistant received the revision and wrote `revised-result.txt`. It also read the revised file back with the expected value `ACC-20260907-01-L07`. However, the earlier execution had already written and read `initial-result.txt` before the revision arrived. Both output files therefore remained in the workspace:

- `initial-result.txt`: `ACC-20260907-01-L07`
- `revised-result.txt`: `ACC-20260907-01-L07`

The revised plan reached a user-facing completed state, but the persisted projection retained `missing tool_result evidence: no_ref` / `not_verified_outcome`. The long-goal projection remained at `需要输入 · 1/2`, and its Flow had to be stopped after it continued without settling. The scenario fails because the latest constraint did not prevent the already-started write, and the evidence gate did not settle cleanly.
