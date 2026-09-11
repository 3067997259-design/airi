# FIX1 调试全过程（2026-09-09 → 2026-09-10）

这份记录保留完整调试链路：两个问题、三次修复尝试、每次失败的原因、最终验证证据，以及还没解决的 UI 问题。它同时是「哪些做法有效、哪些无效」的复盘。

## 1. 背景

验收场景 L07（修订窗口）要求：一个长期目标运行中收到修订后，旧目标文件不再写、新目标完成、Flow 能结算。用 FIX1 夹具复现：

- 夹具 `workspace/FIX1-20260909/brief.txt` = `FIX1-TOKEN-8A2D63`
- 消息 1：`/goal ACC-20260909-FIX1：读取 …/brief.txt，执行一次约 300 秒的前台等待，然后把文件内容写入同目录的 initial-result.txt 并读回核对。用多个小步骤的长期计划，等待期间保持 Flow 运行，不要用后台任务。`
- 消息 2（等待期间）：`/goal ACC-20260909-FIX1：修改要求——保留已经读到的证据，输出改为 revised-result.txt；旧目标中的其他待写文件不要再写。`

行为层从一开始就正确（`revised-result.txt` 内容对、旧目标不写）；问题全部出在**结算**。

## 2. 时间线（journal `40ae9ae5f845754a6add46f6ce4c8325.jsonl`）

| 时间 / seq | 事件 |
| --- | --- |
| 21:57:07 / seq=1718 | journal 最后一次落盘（此后 20 分钟零写入） |
| 22:02:41 | `revised-result.txt` 被写入（应用仍在跑） |
| 22:37:21 | `initial-result.txt` 被写入（循环期污染，后续复验前已删除） |
| 22:17 | 用户手动「停止心流」，循环暂停 |
| 23:39 起 | 外部模型第一批修复上线，journal 恢复秒级落盘 |
| seq=4322 / 4400-4509 | 仍 `rejected`；连续 5 次 `user/ask` 求助 |
| seq=4410 / 4517 | 用户两次选择终止 → `goal/update cancelled` |
| seq=4529 | `flow/end reason=interrupted` |
| 00:40 | 车道化修复后复验：`seq=4721 verdict=pass`、`seq=4722 flow/end done` |
| 00:44 | 第二次有界运行 `seq=4789 pass`、`seq=4790 done`、**`seq=4794 goal/update completed`** |

## 3. 问题 A：重启后 journal 静默断供

**现象**：应用持续运行 20 分钟、执行工具、写工作区文件，但 journal 一条事件都没落盘。完成门依赖 journal 投影，因此这很可能是结算失败的直接原因。

**根因**：`flushPending` 的 append IPC 若永不返回回执，就会永久占住 in-flight 锁，后续批次再也排不上。

**修复**：把 append IPC 与 10 秒超时竞速；超时走既有的 1s→30s 退避重试（重发整队，主进程按 seq 去重，不重复）。

**验证**：修复后 journal 从 1718 行涨到 4700+ 行，mtime 与当前时间同步（秒级）。

**教训**：只读 journal 的验收会漏掉这类故障——必须同时看**文件系统副作用的时间戳**与 **journal 的落盘时间**，两者对不上就说明证据通道断了。

## 4. 问题 B：完成门死锁（三次修复）

### 4.1 第一版：按会话分组保留最新长期计划（我自己写的）

```ts
const latestLongPlanBySession = new Map<string, string>()
for (const plan of plans) {
  if (plan.spec.horizon === 'long' && plan.sessionId !== undefined)
    latestLongPlanBySession.set(plan.sessionId, plan.id)
}
```

**为什么失败**：这些长期计划 `sessionId === undefined`，全部落进「被触及就纳入」的分支，旧计划继续阻塞。

### 4.2 第二版：全局最新长期计划（我自己写的）

```ts
const latestLongPlanId = [...plans].reverse().find(plan => plan.spec.horizon === 'long')?.id
```

**为什么失败**：blocker 不再来自被替换的旧计划，但**最新计划自己的步骤仍然 `blocked / not started`**，循环照旧。

### 4.3 外部模型的诊断修正（关键）

我提交的简报里有一个**事实错误**，被纠正：

- 我判断 `fa4f2116` / `47d19edd` 是 long 计划，因此提出「long→long 取代也应 skip」。
- 实际它们是 **session 计划**（journal 里没有任何 `goal/update` 事件）；本会话真正的 long 计划是 `430613eb` 与 `598e975d`。
- 并且**不建议**对 long 车道做 skip：两个长期目标可以并行存在（调度器整晚互相踢 `Another chat Flow is active`），skip 另一个活跃目标的步骤会关闭不属于它的工作。long 车道由合取规则挡住即可。

另外两点诊断：

- `holdsWork` 只排除 paused/failed/cancelled，僵尸状态是 `pending/blocked` → 通过。它们从两个口进来：创建它们的 Flow 走 `touched` 分支；之后的每个 Flow 走 session 绑定分支，该分支放行**所有**绑定该 session 的非终态 session 计划。
- `seq=4322` 那次拒绝实际是 **31 条 blocker 横跨 12 个计划**，我引用的两条只是清单第 23–27 项。
- 上一轮的取代只折 `activeSessionPlan`；重启后它是 `b81eb4ce`（步骤都已在 `completedSteps` 里）→ `openSteps` 为空 → 一条 skip 都没写。**折一个不够，要折整条车道。**

### 4.4 第三版：车道化（外部模型实施，通过）

1. `selectFlowCompletionPlans` 车道化：合取只取每条车道最新的一个
   - session 车道：Flow 所在 session 最新的 holds-work session 计划；身后旧计划按定义已被取代，**无论 touched 与否都不进合取**（结构性排除，不依赖 skip 事件是否写过，对磁盘上已存在的僵尸堆直接生效）；
   - long 车道：该 Flow 触及的最新 long 计划；没触及才落到 session 绑定的最新一个。
2. `executePlanUpdate` 取代折叠整条车道：新计划 start 时把作用域内所有还有开放步骤的 session 计划全部 skip（含遗留堆，自愈）；long 车道不动。
3. `focus` / `complete` 按 stepId 解析目标：不再只认 `scopedActivePlans().at(-1)`，而是在可操作计划里从新到旧找拥有该 stepId 的那个——直接拆掉「门要求关 → Unknown stepId 够不着」的死锁闭环。

## 5. 最终验证证据

| seq | 事件 |
| --- | --- |
| 4536 | `flow/start Avs6VLx-2BW3ikt2AIaE9` |
| 4617 | `goal/update executable cv=2 reason=long-goal constraints revised` |
| 4721 | `flow/completion-review verdict=pass`（blockers 为空） |
| 4722 | `flow/end reason=done`，`closed without verification: step-write-revised, step-verify-revised, step-verify-revised-final` |
| 4745 | 第二次有界运行 `flow/start` |
| 4789 / 4790 | `verdict=pass` / `flow/end reason=done` |
| 4794 | `goal/update completed cv=2` |

文件：`revised-result.txt` = `FIX1-TOKEN-8A2D63`；`initial-result.txt` 不存在。修复后**没有再出现 `user/ask`**。

## 6. 复盘：哪些做法有效

1. **把「模型能看到的计划」与「证据落到哪」收敛到同一个解析函数**——第一轮修复统一了证据落点，死锁的最后一块是把 `focus/complete` 也收敛到同一语义。
2. **结构性排除优于事件补偿**：车道规则在合取侧直接忽略旧计划，不依赖「skip 事件是否写过」，因此对磁盘上已存在的僵尸堆立刻生效。上一轮「折一个 activeSessionPlan」就是依赖事件、且折错范围。
3. **逃生口有价值**：两次拒绝后出现「ask the user」让问题显式暴露（5 次求助把 blocker 原文和 plan id 都写清楚了），但**逃生口不能替代修复**——用户回答后仍然死锁。
4. **自查容易把事实搞错**：我基于「这些是 long 计划」提了错误入口。定位到具体 plan id 后，应该先回 journal 确认这些计划的性质（有没有 `goal/update`）再下结论。
5. **验收必须同时看三处**：journal 落盘时间、工作区文件时间戳、UI 卡片状态。本次三个地方曾同时给出互相矛盾的信号。

## 7. 仍未解决的 UI 问题（交接件）

### UI-1：「停止任务」按钮无响应

- 现象：任务列表残留一行 `ACC-20260909-FIX1：读取 workspa… 进行中 · 第 10 轮 · 0 次工具调用`，其「停止任务」按钮点不动；同一列表里另一行 `已中断 · 第 16 轮 · 18 次工具调用` 正常。
- 影响：用户无法从 UI 回收这条幽灵任务行。
- 线索：该 taskId 对应的 Flow 已结束，但投影行未被回收；`task-activity-panel` 按 `taskId` + `flow/end` 截断事件窗口，可优先查这条残留行的 `taskId` 是否与已结束的 Flow 一致，以及停止按钮的绑定是否只对「运行中」的任务生效。

### UI-2：心流指示器标题恒为旧文本

- 现象：底部条始终显示「心流运行中 · 第 N 步 · 有界检查 L01/signal.txt 是否存在」，无论当前 Flow 的真实步骤是什么（本次真实步骤是「读取 brief.txt」「300 秒等待」「写 revised-result.txt」）；N 会变，标题不变。
- 影响：指示器给出了错误的当前步骤语义，容易被误读为「还在跑 L01」。
- 线索：`chat.ts` 的 `activeFlowStep` 投影；怀疑取到了历史 Flow 的步骤 intent（L01 是很早的一个目标），或 `currentStepId` 指向的步骤属于已结束的计划。

## 8. 相关记录

- [L07-revision-live-20260909.md](./L07-revision-live-20260909.md) — 第一次成功复现「修订先于写入」的窗口
- [L07-self-revision-20260909.md](./L07-self-revision-20260909.md) — 模型自触发修订与未验证收尾
- [fix-1a-superseded-plans-20260909.md](./fix-1a-superseded-plans-20260909.md) — 我写的前两版修复与失败原因
- [fix1-retest-failure-20260909.md](./fix1-retest-failure-20260909.md) — 第一轮复验失败（journal 断供 + 循环未解）
- [INVESTIGATION-BRIEF-20260909.md](./INVESTIGATION-BRIEF-20260909.md) — 交给外部模型的简报
- [FIX1-DEADLOCK-SUMMARY-20260909.md](./FIX1-DEADLOCK-SUMMARY-20260909.md) — 死锁总说明（含外部模型的诊断修正）
- [FIX1-lane-fix-pass-20260910.md](./FIX1-lane-fix-pass-20260910.md) — 车道化修复复验通过
