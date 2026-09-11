# D07 stop and recovery

- Status: `PASS`
- Session: the active UI-created chat session, reused for the D-series run
- Workspace: `D:/airi/docs/fork/evidence/short-scenarios/ACC-20260907-01/workspace/D07`
- Required behavior: stop an active read-only task, then recover with a new user turn

## Initial read-only run

The normal D07 prompt asked the model to list `D07`, read `one.txt`, `two.txt`, and
`three.txt`, repeat the reads, and report progress. The UI displayed the expected
`list` and `read` tool calls. The model reported all three values and stated that
the files were unchanged.

A first controlled variant used `sleep 20`. It completed before a usable stop
boundary appeared. This is retained as an observation, not as the stop result.

## Stop boundary

The second controlled variant asked for:

1. a read of `one.txt`;
2. a non-mutating 120-second wait; and
3. reads of `two.txt` and `three.txt` after the wait.

The live UI showed the first `read` complete and the `bash` wait active. Pressing
Escape stopped the task before the two post-wait reads appeared. The live-state
screenshot is [D07-interruption-live.png](D07-interruption-live.png); the
post-stop UI is [D07-interruption-after-escape.png](D07-interruption-after-escape.png).

## Recovery and persistence

After the stop, the next user turn was:

`停止刚才的任务后，请只回复 STOP-RECOVERED。`

The assistant replied exactly `STOP-RECOVERED`. After reloading the chat window,
the same user turn and exact assistant reply were still present.

The workspace still contained only the original three files:

| File | SHA-256 |
| --- | --- |
| `one.txt` | `287EBD2B7E9047F4381C541DEB70E947C67869AA9A5FB1D153022C5E2C92AB4B` |
| `two.txt` | `DFE331E713CEC8B101DEB5AC45E4C202AEC9654F11410C8C97203A7F5D119349` |
| `three.txt` | `398EFF94F8537370C670B116E7957B25BEA33E8B75C359D78E3D69D3F77F7990` |

No write tool call occurred in any D07 variant.
