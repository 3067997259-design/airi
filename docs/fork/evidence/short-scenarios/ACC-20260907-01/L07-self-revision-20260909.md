# L07d 自触发约束修订与「未验证收尾」（2026-09-09）

- 状态：发现（L07 的结算问题出现新变体）
- 日期：`2026-09-09`
- Journal：`40ae9ae5f845754a6add46f6ce4c8325.jsonl`
- 目标：`e3ba3149-6711-4583-9b85-8e386e063a91`

## 现象

用户与执行者都没有点「停止心流」，但 L07d 的 Flow 在 `seq=1379` 变成 `interrupted`。时间点与一次模型自发的 `plan_update` 重合。

## 事件链

| seq | 事件 | 说明 |
| --- | --- | --- |
| 1376 | `tool/call plan_update complete` | 模型标记某步完成 |
| 1378 | `tool/call plan_update start` | **模型重新起了一份计划** |
| 1379 | `flow/end reason=interrupted`，`detail=long-goal e3ba3149… constraints revised to version 2: long-goal constraints revised` | 长目标层把这次 `plan_update start` 当成约束修订，中断了正在跑的 Flow |
| 1381 | `goal/update executable cv=2 reason=long-goal constraints revised` | `constraintVersion` 1 → 2 |
| 1383 | `flow/start g6ALd3ro_PnZI4V-sfPE-` | 调度器在新版本下认领了新的有界运行 |
| 1384 | `goal/update running cv=2 reason=scheduler claimed one bounded Flow run` | 新运行开始 |
| 1416 | `flow/end reason=done detail=declared at the turn boundary; closed without verification: step-1` | 第二次运行收尾，**但 step-1 未验证** |
| 1420 | `goal/update completed cv=2 reason=Flow completed the goal steps; evidence remains visible in the plan record.` | 目标被标记为 `completed` |

## 两个判断

1. **自触发修订**：模型在 Flow 运行中执行 `plan_update start`，会被长目标层当作「约束修订」，从而中断当前 Flow 并把 `constraintVersion` 递增、重新调度一次有界运行。本例只发生一次；若模型反复重建计划，这条路径可以形成「重建 → 中断 → 新运行 → 再重建」的循环。这与 [未关闭问题清单](./open-findings-20260909.md) 第 1 条（完成门被旧计划步骤阻塞）叠加时尤其危险：完成门拒绝会促使模型重建计划，重建又触发修订与中断。

2. **未验证收尾被记为完成**：`seq=1416` 的 `flow/end` detail 明确写着 `closed without verification: step-1`，`seq=1420` 仍把目标标成 `completed`。detail 里保留了未验证字样（符合 R4 的可见性要求），但**目标状态本身没有反映未验证**。

## 与 L07 验收的关系

- 行为层仍然 PASS：旧目标 `initial-result.txt` 未被写入，新目标 `revised-result.txt` 已写入并读回。
- 结算层这次**以「未验证收尾」结束**，不是干净的完成；与 [L07-revision-live-20260909.md](./L07-revision-live-20260909.md) 里两次 `rejected` 是同一族问题的不同表现。
- 本轮的结构化修订（`cv=2`、`flow/end interrupted`）由**模型自身**的 `plan_update start` 触发，不是用户 `/goal`，因此仍不能作为「用户修订 → 授权器拒绝旧运行写入」的运行态证据。
