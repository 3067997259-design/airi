# L02 workspace change and stale assumptions

- Status: FAIL (the workspace switch and observation passed; the long-goal run used the stale root)
- Isolated chat session: `qvPBnEycPmJ0uUNjeIHX7`.
- Plan: `b0d1e003-2c79-42a2-90a7-b17d0e0e5fce`.
- Workspace before switch: `workspace/`.
- Temporary workspace: `workspace/L02-alt/`.

The test created `workspace/L02-retest/brief.txt` under the original root and started a read-only long goal. The first run correctly read the original-root fixture and reported `project=ACC-20260907-01-L02`, `mode=original-root`, and `count=1`.

Through the Coding settings UI, the workspace root was switched to `workspace/L02-alt/`, which contains only `README.txt`. A user-facing follow-up then used the current workspace and correctly reported that `L02-retest/brief.txt` did not exist there and that the earlier result belonged to the original root. This part of the environment-change behavior passed.

The long-goal plan itself did not adopt the changed root: its run continued to read the original-root file, and its persisted plan snapshot remained `waiting-condition` with `step-read-brief` unverified. The plan therefore failed the required environment-change gate. The Coding settings UI was then used to restore the original workspace root.
