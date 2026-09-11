# L04 long-goal restart recovery continuation

- Date: 2026-09-09
- Runtime: rebuilt Electron with the original user profile and CDP `9250`
- Workspace fixture: `D:/airi/workspace/L04-crash-recovery-20260909`
- Plan: `aafe63da-a875-4a65-950d-a07877fbd4d3`

## Evidence

The scheduler-owned run was Flow `qL906jeE8-UjN2alkiEhn` and task
`8092EfV5Jo6TW1p_A9VPT`. Its `sleep 120` call was recorded at journal
sequence 492. After the Electron restart, that pending shell call returned a
failure at sequence 503. The same task then issued one write at sequence 518
with the exact content `CRASH-RECOVERY-V4-20260909`, followed by one readback
at sequence 539.

The write was not repeated, and the target file was read back with the exact
marker. This demonstrates the restart rebind and the no-duplicate-write
boundary. The old evidence gate nevertheless marked the final step
`unverified` at plan completion because it selected the readback under the
wrong step. The repaired attribution regression is now green, but a clean
live rerun with the rebuilt evidence gate is still required before L04 can be
marked PASS.

The later attribution run used unique step IDs and linked `brief.txt` to
`attribution-step-1` and `crash-result-v4.txt` to `attribution-step-2`. Its
final remote completion was blocked by the provider's HTTP 403 balance
response, so that external failure is kept separate from the attribution
result.

## Next run

Use a fresh unique plan and step IDs. Kill Electron only while a scheduler
tool call is pending, restart with the same profile and CDP, and require all
of the following: the same run identity is rebound, one write occurs, one
readback occurs, the plan has no unverified steps, and the goal settles once.
