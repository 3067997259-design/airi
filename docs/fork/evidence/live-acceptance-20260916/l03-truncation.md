# L-03 超过 100 个实体：截断列表不等于目标消失（2026-09-16）

场景：实体查询上限 100 条（`TARGET_QUERY_MAX_RESULTS`）。在 200+ 实体的庭院里验证两件事：

- (b) 非玩家目标不在返回的截断列表内时，诚实返回 `target_not_in_read`，不是 `target_lost`。
- (a) 玩家目标被挤出列表时，名字解析回退到服务端玩家列表；解析成功后按 uuid 追踪到目标附近。

结果：**(b) PASS；(a) PASS**。

## 夹具

- 105 只 NoAI 羊（tag `airi-l03`），网格 x85..93、z-25..-13，全部在距机器人 14.9 格内。
- Lumi（NoAI + NoGravity）悬浮在 (74.5, 90, -38.5)，距机器人约 26 格。
- 机器人 (92.5, 75, -27.5)；用户 `AfterRain` 站在走道西端 (约 74, 75, -28)，距机器人 18.0 格。

首轮夹具尝试留档：第一版只放 95 只羊、Lumi 在地面 23.4 格处。前 100 条的截止距离被羊群和 5 只炽足兽推高到 23.7 格，Lumi 排进第 100 名，被正常解析并按 20 秒时限跟随。修正为 105 只羊加悬浮 Lumi 后，前 100 名的截止距离降到 9.2 格，Lumi 与玩家都在列表外。

## (b) 非玩家目标

- 查询：`total 217 / returned 100`（截断）；Lumi 不在返回列表。
- `game_follow { target: 'Lumi', keepDistance: 3, timeoutSeconds: 20 }` → **264ms** 结束，`endReason: target_not_in_read`、`status: failed`。
- 证据：[l03-swarm.json](./l03-swarm.json)，脚本 [l03-swarm.mjs](./l03-swarm.mjs)。

## (a) 玩家目标（列表回退）

- 前置：`total 218 / returned 100`，第 100 名距离 9.2 格；`AfterRain` 距离 18.0 格，不在返回列表。
- `game_follow { target: 'AfterRain', keepDistance: 3, timeoutSeconds: 25 }` → 解析成功（不是 `target_lost`），机器人从 18.0 格走近，4.3 秒到达目标位置，随后保持距离 0.00 直到 25 秒时限；回执 `timeout`、`met: true`（目标存活时的正常时长结束）。
- F-01 数据点：`keepDistance: 3` 未生效为停车半径——最终距离 0.00（同一脚点），没有保持 3 格间隔。
- 证据：[l03-player.json](./l03-player.json)，脚本 [l03-player.mjs](./l03-player.mjs)。

## 清理核对

- 杀羊前先给标签羊清空掉落表（`DeathLootTable` 置空）再 `kill`，随后按位置核对掉落物品为零。
- `execute if entity @e[tag=airi-l03]` → `Test failed`（0 个）；Lumi 已移除。
- 剩余羊查询只命中用户在远处饲养的 3 只羊，与夹具无关。

## 边界

- 单次运行。未覆盖：实体列表顺序假设（按距离升序来自观测，不是契约）、截断恰好发生在目标名次的边界、多人同时请求时的并发合并。
- 未改产品代码。F-02（跟随开始时目标玩家在 64 格外且列表未截断）未在本项验证，留给 L-02。
