# L-01 同名新实体不顶替：真机验收记录（2026-09-16）

场景：跟随中移除原目标，再生成同名同类新实体。判据：回执 uuid 固定、新实体不顶替、失败类型化。

结果：**PARTIAL**。

- **新实体不顶替：PASS**。目标消失后她没有转向新实体。
- **类型化有界失败：FAIL**。目标消失后跟随一直运行到 `timeoutSeconds`（40 秒），回执 `endReason: timeout`、`status: ok`、`postCondition.met: true`。设计要求的 `entity_unloaded` 或 `waiting_for_target`（3 秒转粗 + 10 秒预算）没有出现。目标消失被记为一次干净的时长结束。

证据：[l01-same-name.json](./l01-same-name.json)、夹具脚本 [l01-same-name.mjs](./l01-same-name.mjs)。

## 环境

- 客户端模组 0.2.17（`airitest`，gameDir `versions\AIRI-bot`），服务端模组 0.2.16，AIRI 构建运行中（CDP 9222）。
- 夹具：平滑石平台 z=-28 一列。机器人起始 (76.5, 75, -28.5)；A 实体羊 `Lumi`（NoAI）在 (82.5, 75, -28.5)；B 同名羊在 (91.5, 75, -28.5)。
- 命令：`game_follow { target: 'Lumi', keepDistance: 3, timeoutSeconds: 40 }`，经 devtools 探针下发。

## 时间线

| 时刻（相对） | 事件 | 机器人位置 |
| --- | --- | --- |
| 0 s | 跟随下发，目标 A 距 6.0 格 | (76.5, -28.5) |
| ~1.1 s | 接近中，距 A 2.13 | (80.37, -28.5) |
| ~2.2 s | 越过 A，距 A 最小 0.07，随后停在 A 东侧 | (83.42, -28.5) |
| ~5 s | 移除 A（`remove_entity`），确认列表为空 | (83.42, -28.5) |
| ~5.6 s | 生成同名的 B（uuid 不同） | (83.42, -28.5) |
| 5.6 s 到 40 s | 她不再移动，距 B 恒为 8.08；跟随未结束 | (83.42, -28.5) |
| ~40 s | 回执 `endReason: timeout`、`met: true`、`status: ok`、`serverSettled` 未观察 | (83.42, -28.5) |

B 的最近距离 8.08 格，无任何接近趋势，说明按 uuid 固定、同名不顶替成立。

## 代码根因（只读核对）

1. 非玩家目标从所有读取消失后，粗定位返回 `unloaded`，跟随循环调用 `tracker.forceOutcome('entity_unloaded')`（`apps/stage-tamagotchi/src/main/services/airi/game-host/index.ts:3383`）。
2. `forceOutcome` 在 `TargetTracker.outcome()` 里是**粘性**的（`movement/target-tracking.ts:197-210`：`if (forced) return forced`），`acceptFine`/`acceptCoarse` 都不清除它。
3. 跟随循环唯一的有界收尾分支要求 `outcome === 'waiting_for_target'`（`index.ts:3352`）。forced 值不是 `waiting_for_target`，所以等待预算永远不会开始，循环每 200 毫秒空转一次直到命令期限。
4. 循环退出时 `endReason` 还是初始值 `'timeout'`（`index.ts:3262`），而 `timeout` 不在 follow 的失败清单里（`command-contract.ts:752-778`），于是 `met: true`。
5. 玩家目标的经典路径不受影响：粗定位对玩家返回 `offline` 时直接 `break`（`index.ts:3372-3374`），这也是既有单测覆盖的路径。非玩家目标缺少等价的有界分支。

影响：任何跟随非玩家实体（动物、展示实体、载具等）的目标丢失，都会静默降级为"正常时长结束"，并在完成门里记为成功。

## 附带观察（待复核，不计入 L-01 判定）

`keepDistance: 3` 没有形成停车半径：单腿把目标格当作终点，最近距离 0.07，最终停在目标东侧 0.92 格（目标格角 1.51 格）。既有 MC-1a 真机记录也写过"追到 1 格并保持"。需要确认 `keepDistance` 的语义是"腿部重规划阈值"还是"保持距离"。若是后者，当前行为偏近，与 `game_follow` 描述（"keeping a distance"）不符。

## 复现

```powershell
node l01-same-name.mjs "<out.json>"
```

脚本从 25602 生成实体、从 25600 采样、经 CDP 9222 下发 `game_follow`，并在结束时清理两只羊与恢复机器人原位置。

## 复测（2026-09-16，修复批后）

修复内容：

- `movement/target-tracking.ts`：只有终态 forced 原因（`target_offline`、`target_dimension_changed`）短路等待窗口；非终态的 `entity_unloaded`/`locator_unavailable` 只留作诊断，等待预算继续计时。终态一旦写入，后续非终态读取不能降级它。
- `index.ts`：跟随循环在 `outcome` 为终态时立即结束，不再依赖下一次粗读重复原因。
- 新增回归：tracker 两条（非终态不绕过等待窗口、终态不被降级），follow 两条（维度不符即时 `target_dimension_changed`、非玩家消失有界 `entity_unloaded`）。

结果：**PASS**。

- 目标移除后 14.1 秒（3 秒转等待 + 10 秒预算）以 `entity_unloaded` 结束。回执 `status: failed`、`checked: false`、`postCondition.met: false`。
- 同名新羊不顶替依旧成立：B 最近距离 9.92 格。
- `game-host` 定向 778 passed / 1 skipped；桌面包 typecheck 0；重建重启后复测。

证据：[l01-same-name-retest.json](./l01-same-name-retest.json)。

残留观察（不阻塞本项）：`keepDistance` 仍未形成停车半径（复测单腿最近 0.14 格、终点距目标 0.92 格），语义待复核。

## 边界

- 单次运行，一个实体类型（羊）。未覆盖：玩家目标离线（既有单测覆盖 `target_offline`）、瞬移型消失、区块卸载与实体移除的区分。
- 未改产品代码。修复另开批次，修复后按本记录复验。
