# S06 social heartbeat during a normal stream

- Status: PASS
- Runtime: Electron build through CDP `9250`; isolated test session `7khtOKjZRJDBGvUD7HgmD`.

The retest sent a long normal response and immediately confirmed `sending=true`. It then invoked the public test-heartbeat action while the same chat send was still active. The persisted journal recorded:

- heartbeat seq `722`, outcome `gated`, gate `busy`;
- no `life/decision` for that heartbeat;
- after the response ended, the chat returned to `sending=false`.

The earlier invalid timing attempt remains retained in this file's history. Life Mode was restored to `off`, with a 15-minute interval, quiet hours `0-23`, unlimited daily budget, and a 30-minute cooldown. The appearance state was reset. The restored legacy session was not touched.
