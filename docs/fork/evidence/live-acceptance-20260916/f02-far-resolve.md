# F-02 远距初解析：确认缺陷 → 修复 → 复测（2026-09-16）

## 首测（修复前）

- 目标 `AfterRain` 在 (148.7, 121.5, 71.9)，距机器人水平 124.4 格；实体查询 `total 9 / returned 9`（未截断），目标不在返回列表。
- `game_follow { target: 'AfterRain', keepDistance: 3, travelMode: 'ground' }` → **289ms** 结束，`endReason: target_lost`。
- 根因：`resolveFollowTarget` 只在实体列表截断时回退服务端玩家列表（`index.ts`）。实体查询以玩家为中心、半径 64 格，因此"完整列表 + 远目标"是必现的 `target_lost`。设计 §2 写"首次名字解析可以复用现有查询和玩家列表"。

## 修复

- `index.ts`：实体查询未命中时**总是**回退玩家列表；`truncated` 仍用于把解析失败区分为 `target_not_in_read`。
- 回归测试：`resolves a player target beyond the entity radius when the list is not truncated`（列表完整、目标在半径外 → 解析成功）。
- 验证：`game-host` 定向 **779 passed / 1 skipped**；桌面包 typecheck 0；构建重启。

## 复测（修复后）

- 同目标、同距离 124.4 格、列表未截断。
- `game_follow ground, timeoutSeconds: 8` → 解析成功，`endReason: timeout`（正常时长结束、`met: true`），不再是 `target_lost`。
- 8 秒内没有位移：跨 124 格的徒步穿越属于寻路范围，不在本项核对。
- 证据：[f02-far-follow-ground.json](./f02-far-follow-ground.json)、[f02-far-follow-ground-retest.json](./f02-far-follow-ground-retest.json)，脚本 [follow-far.mjs](./follow-far.mjs)。

## 遗留观察（F-03 候选，待真机滑翔复现）

- 空中跟飞的起飞评估 `assessHostAirLaunch` 只在快捷栏与主背包找鞘翅，**不认已穿戴的胸甲鞘翅**：`readInventorySlots()` 只返回 hotbar/main，而 `equipElytra`（`elytra.ts`）本来支持穿着飞行。她的鞘翅穿在胸甲槽，评估可能直接 `cannot_air_follow`。
- 另外庭院地面可能没有 `selectLaunchPoint` 认可的起飞边缘，若首个失败原因是 `launch_unavailable`，需要换高处边缘再试。
