# S04-S05 social budget and cooldown gates

- Status: PASS for S04 and S05
- Runtime: Electron build through CDP `9250`; isolated chat session `7khtOKjZRJDBGvUD7HgmD`.
- Appearance events: `CryButton` at journal seq 65, `LoveButton` at seq 80, and `BlackButton` at seq 105.

## S04 daily budget

The UI set Life Mode to `autonomous` and changed the daily budget to `1`. The persisted runtime snapshot already showed one real decision used for the current day. After the `CryButton` appearance change, the visible `测试心跳` action reported `每日预算已用尽`. The budget gate prevented another social consideration; no second `life/decision` was appended.

## S05 cooldown

The UI changed the daily budget to unlimited and disabled quiet hours by setting both quiet-hour endpoints to `0`. A manual test heartbeat produced one real `silence` decision. A second appearance change to `BlackButton` then occurred inside the 30-minute cooldown. The next scheduled heartbeat persisted `outcome=gated` and `gate=cooldown` at journal seq 113; the decision count did not increase.

Life Mode was restored through the UI to `off`, 15-minute interval, unlimited budget, 30-minute cooldown, and quiet hours `0-23`. The appearance state was reset through the UI-exposed `expression_reset_all` tool. The restored legacy session was not selected or modified.
