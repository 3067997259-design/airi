# 问题 1a 修复 — 被替换的长计划不再阻塞完成门（2026-09-09）

- 状态：已修复并回归；运行态复验待重建。
- 日期：`2026-09-09`
- 对应：[未关闭问题清单](./open-findings-20260909.md) 第 1 条（1a）

## 根因

`packages/stage-ui/src/stores/chat.ts` 的 `evaluateFlowCompletion` 把**本 Flow 窗口内出现过的所有计划**都交给完成门：

```ts
const plans = planStore.planViews.filter((plan) => {
  if (touchedPlanIds.has(plan.id)) return true
  return plan.spec.horizon === 'session' && ...
})
```

而 `plan_update start` 对长期目标**总是新建一个计划 id**（`apps/stage-tamagotchi/.../builtin/plan.ts:167` 的 `planStore.start(...)`），旧计划留在 `planViews` 里。它的步骤永远不会再被执行，于是完成门每次都报 `step has not started` / `step is blocked`。

journal 证据（`40ae9ae5…`）：同一目标下并存三份长期计划 —— `e3ba3149`（原始，步骤含 `initial-result.txt`）、`9551a882`、`50582b08`；完成门 blockers 引用的正是 `e3ba3149` 的旧步骤。

## 修复

- 新增 `selectFlowCompletionPlans()`（`packages/stage-ui/src/stores/plans.ts`）：
  - 长期目标按「每个会话只保留**最新**的一份长期计划」进入完成门；
  - 没有会话绑定的长期计划只有在 Flow 真正触及时才进入；
  - 会话计划维持原逻辑（被触及的、或本会话仍活跃的）。
- `chat.ts` 的 `evaluateFlowCompletion` 改用该函数。

## 回归

| 检查 | 结果 |
| --- | --- |
| `src/stores/plans.test.ts` | 30 通过（新增 5 条：只保留最新长期计划、被触及的会话计划、活跃会话计划、暂停计划被排除、无会话绑定的长期计划按触及判定） |
| `src/stores/chat.contract.test.ts` | 30 通过 |
| `src/stores/modules/long-goals.browser.test.ts` | 6 通过 |
| `pnpm -F @proj-airi/stage-ui typecheck` | 退出码 0 |
| 改动文件 eslint | 退出码 0 |

## 未改动的部分（1b）

「未验证收尾被记为完成」按现状保留：`finishRun`（`long-goals.ts:251`）在 `endReason === 'done' && plan.status === 'completed'` 时把目标标为 `completed`，而 `flow/end` 的 detail 仍写明 `closed without verification: <stepId>`，计划卡也会把该步渲染为 amber。也就是说未验证是**可见**的，只是不改变目标生命周期。是否需要让目标也停在「待确认」属于产品口径决定，未擅自改动。

**用户拍板（2026-09-09）：按口径 A 处理。** 目标仍为 `completed`，但把未验证步骤写进目标的原因。已实现 `longGoalCompletionReason()`（`long-goals.ts`）：

- 无未验证步骤：`Flow completed the goal steps; evidence remains visible in the plan record.`（不变）
- 有未验证步骤：`Flow completed the goal steps; closed without verification: step-1.`

回归：`long-goals.browser.test.ts` 7 通过（新增 1 条）；typecheck 与改动文件 eslint 退出码 0。

## 构建与重启（2026-09-09 21:47）

- `pnpm -F @proj-airi/stage-tamagotchi build` 退出码 0，`out/` 更新到 21:47–21:48。
- 结束 Electron（PID 22744），等待 8 秒后以原参数重启；`/json/version` 立即返回，新主进程 PID 26004。

## 第一版修复不够（2026-09-09 21:54 复验）

复验时完成门仍然拒绝，blockers 同时引用 `430613eb`、`550d1d78`、`158c58cc` 等多份计划。原因：第一版按 `sessionId` 分组，而这些长期计划**没有会话绑定**（`sessionId === undefined`），全部落进「被触及」分支。

**修正**：改为只保留**全局最新的一份长期计划**进入完成门（与 `activeLongPlan` 的 `at(-1)` 语义一致），并且它必须被本 Flow 触及或属于本会话。

回归：`plans.test.ts` 31 通过（新增「无会话绑定的两份长期计划只保留最新」）；typecheck 与 eslint 退出码 0。21:57 重新构建并重启（CDP `9250` 就绪）。

## 运行态复验（待做）

修复只改了 stage-ui 源码；当前运行实例是 17:35 的构建。重建并重启后应复验：

1. 运行一个长期目标，中途让它重建计划；
2. 期望：完成门不再引用被替换计划的旧步骤，`flow/end reason=done` 且没有 `step has not started` 的 blocker；
3. 同时确认旧目标文件仍然不被写入。
