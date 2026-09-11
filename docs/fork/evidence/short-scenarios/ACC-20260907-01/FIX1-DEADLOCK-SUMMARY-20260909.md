# FIX1 死锁总说明（2026-09-09）

给修的人：这份说明汇总 L07/FIX1 场景的全部证据。两个问题，A 已修好并验证，B 未修好且是硬死锁。

## 0. 结论摘要

| 问题 | 状态 |
| --- | --- |
| A. 重启后 journal 20 分钟零落盘 | **已修复并验证**（事件恢复秒级落盘） |
| B. 完成门引用非活跃长期计划的步骤，模型无法关闭 | **未修复，硬死锁**（连续 5 次 `user_ask` 求助，最终只能取消） |

## 1. 场景与夹具

- 应用：`apps/stage-tamagotchi`（Electron），构建 `out/`（23:39 前后），CDP `9250`，provider `openai-compatible` / `gemini-3.8-flash`
- 会话 journal：`C:\Users\86130\AppData\Roaming\@proj-airi\stage-tamagotchi\journal\40ae9ae5f845754a6add46f6ce4c8325.jsonl`
- 夹具：`D:\airi\workspace\FIX1-20260909\brief.txt` = `FIX1-TOKEN-8A2D63`
- 步骤：
  1. 发 `/goal ACC-20260909-FIX1：读取 workspace/FIX1-20260909/brief.txt，执行一次约 300 秒的前台等待，然后把文件内容写入同目录的 initial-result.txt 并读回核对。用多个小步骤的长期计划，等待期间保持 Flow 运行，不要用后台任务。`
  2. 等待步骤开始后发修订：`/goal ACC-20260909-FIX1：修改要求——保留已经读到的证据，输出改为 revised-result.txt；旧目标中的其他待写文件不要再写。`

**行为层结果正确**：`revised-result.txt` = `FIX1-TOKEN-8A2D63`，旧目标不再写。

## 2. 问题 A（已修复，供回归参考）

修复前：`40ae9ae5….jsonl` 最后写入 `21:57:07` / `seq=1718`，但 `revised-result.txt` 在 `22:02:41` 被写入，界面已跑到第 17 轮——**20 分钟零 journal 落盘**。
修复后：文件涨到 4300+ 行，mtime 与当前时间同步（秒级）。

## 3. 问题 B：完成门死锁（未修复）

### 3.1 现象

同一会话出现 **5 次 `user_ask` 求助**（`seq=4400 / 4433 / 4465 / 4487 / 4509`），每次的诉求都是「历史步骤持续阻碍结算，请问如何处理」。摘录（原文要点）：

- `seq=4400`：「评审反馈以下历史步骤持续阻碍结案：1) plan fa4f2116 的 step-verify-revised (has not started)；2) plan 47d19edd 的 step-write-revised (blocked)、step-verify-revised (has not started) 与 step-verify-revised-final (has not started)。实际目标文件 revised-result.txt 内容 FIX1-TOKEN-8A2D63 已就绪，请问如何处理这些历史步骤？」
- `seq=4465`：**「当前活跃计划的步骤列表为 step-1-read-brief 至 step-8-verify-initial，直接调用 complete 会报 Unknown stepId。是否需要我重新加载包含阻断步骤（step-write-revised, step-verify-revised, step-verify-revised-final）的计划后再执行标记完成？」**

最终结果：用户两次选择「忽略/终止」→ `goal/update cancelled`（`seq=4410`、`4517`），`seq=4529` `flow/end reason=interrupted detail=flow stopped from the composer`。期间 `flow/completion-review` 仍是 `rejected`（`seq≥3900` 共 3 次）。

### 3.2 死锁机制（核心）

完成门要求关闭的步骤，属于**非活跃**计划：

- blockers 引用 `plan fa4f2116-10ea-4629-821c-474125c2c941` 与 `plan 47d19edd-f335-4bc6-9106-88ab04e6e352`；
- 而**活跃**计划的步骤是 `step-1-read-brief … step-8-verify-initial`；
- 模型对这些旧 stepId 调 `plan_update complete` 得到 `Unknown stepId`（`builtin/plan.ts:204-206` 只查 `scopedActivePlans(...).at(-1)`）。

于是形成闭环：**完成门要它关 → 它够不着 → 关不了 → 永远 rejected → 模型只能重建计划或求助**。这正是「模型看到的」与「证据落到的」不一致的第二处表现。

### 3.3 已尝试的修复与不足

上一轮修复引入：

- `plans.ts` 的 `resolveFlowEvidencePlan` + `hasOpenPlanSteps`（发送绑定、`getPlanStepCandidates`、投影同源）；
- core-agent 的 `flowCompletionStepInputs`（skipped 不进合取）；
- `builtin/plan.ts` 的取代语义：`plan_update start` 把被取代**session** 计划未决步骤标 `skipped`；
- `selectFlowCompletionPlans`：touched 分支也套 `holdsWork` 过滤。

**不足**：死锁的这几个孤儿步骤挂在 **long** 计划上。`builtin/plan.ts` 的 skipped 取代分支只覆盖 `horizon === 'session'`（`plan.ts:127-131`），long→long 取代后旧计划步骤仍进合取；`selectFlowCompletionPlans` 的 `holdsWork` 也没有挡掉这两个非活跃 long 计划。

### 3.4 待查问题（建议修的人从这里开始）

1. `builtin/plan.ts` 的取代分支为什么只处理 `horizon === 'session'`？long→long 取代应当把旧计划的未决步骤标 `skipped`（或把旧计划标为被取代），否则完成门永远引用它们。
2. `selectFlowCompletionPlans` 的 `holdsWork` 为什么放行了 `fa4f2116` / `47d19edd`？它们既不是最新 long 计划，也（应当）不是活跃计划。
3. **更根本**：完成门引用的「计划集合」与模型可操作的「活跃计划集合」应由**同一个解析函数**产出。上一轮已经统一了「证据落点」，但完成门这一侧仍然独立取集合，于是出现「门要的步骤模型够不着」。
4. 死锁时是否有兜底？现在靠 `user_ask` 求助，但用户回答后仍无解（`seq=4465` 的选项 1 试过，仍死锁）。是否应该：完成门在引用非活跃计划时直接忽略该计划，或把该计划标记为 superseded 并写 journal 事件。

## 4. 验收影响

- L07 行为层：**PASS**（修订先于写入、旧目标未写、新目标正确）。
- L07 结算层：**BLOCKED**（本死锁）。在修复前，L07 不能记 PASS。
- 1a 的修复（`selectFlowCompletionPlans`）让 blocker 从 4–5 条累积收敛到 2–4 条并带 plan id，属于**部分改善**，但不是根修。

## 5. 附：复现与取证

- 复现见 §1 的两条消息；观察 `flow/completion-review` 的 `rejected`、`user/asked` 的连续出现、`goal/update` 停在 `waiting-condition`。
- 取证命令（PowerShell）：

```powershell
$j = 'C:\Users\86130\AppData\Roaming\@proj-airi\stage-tamagotchi\journal\40ae9ae5f845754a6add46f6ce4c8325.jsonl'
Get-Content $j | ForEach-Object { $o = $_ | ConvertFrom-Json; if ($o.type -in 'flow/completion-review','user/asked','flow/end','goal/update') { "$($o.seq) $($o.type)" } }
```

- 相关记录：[L07-revision-live-20260909.md](./L07-revision-live-20260909.md)、[fix-1a-superseded-plans-20260909.md](./fix-1a-superseded-plans-20260909.md)、[fix1-retest-failure-20260909.md](./fix1-retest-failure-20260909.md)、[INVESTIGATION-BRIEF-20260909.md](./INVESTIGATION-BRIEF-20260909.md)
