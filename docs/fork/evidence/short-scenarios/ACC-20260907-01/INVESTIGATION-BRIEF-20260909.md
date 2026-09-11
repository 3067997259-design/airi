# 调查简报：journal 不落盘 + 完成门循环（2026-09-09）

请独立调查下面两个问题。这是一份自包含简报：不需要本仓库的对话历史，只需要按「复现」一节操作并按「需要回答的问题」给出结论。

## 环境

- 仓库：`D:\airi`，分支 `mods`（本地 fork，未提交 upstream）
- 应用：`apps/stage-tamagotchi`（Electron），构建产物 `out/`（本次为 2026-09-09 21:47–21:48）
- 启动：`electron.exe D:\airi\apps\stage-tamagotchi`，环境变量 `SERVER_CHANNEL_PORT=6221`、`APP_REMOTE_DEBUG=true`、`APP_REMOTE_DEBUG_PORT=9250`、`APP_REMOTE_DEBUG_NO_OPEN=true`
- 用户 profile：`C:\Users\86130\AppData\Roaming\@proj-airi\stage-tamagotchi`
- Provider/model：`openai-compatible` / `gemini-3.8-flash`
- 工具：`agent-browser` 通过 CDP `9250` 操作界面；journal 与工作区文件直接读磁盘

## 问题 A：重启后 journal 事件不落盘

### 现象

| 证据 | 值 |
| --- | --- |
| journal 文件 | `C:\Users\86130\AppData\Roaming\@proj-airi\stage-tamagotchi\journal\40ae9ae5f845754a6add46f6ce4c8325.jsonl` |
| 文件最后写入时间 | `2026-09-09 21:57:07` |
| 最后事件 | `seq=1718`（`tool/result`） |
| 再次检查时间 | `2026-09-09 22:17:19` |
| 同一时段的工作区副作用 | `D:\airi\workspace\FIX1-20260909\revised-result.txt` 写入于 `22:02:41`，内容 `FIX1-TOKEN-8A2D63` |
| 界面状态 | Flow 显示「第 17 轮 · 4 次工具调用」，模型持续输出与调用工具 |

即：应用在 21:57 之后运行了 20 分钟、执行了工具并写入了工作区文件，但**没有任何 journal 事件追加到磁盘**。

### 相关代码

- `apps/stage-tamagotchi/src/main/services/airi/journal-host/index.ts`（主进程持有 `<userData>/journal/<sha256 前 32>.jsonl`）
- `packages/stage-ui/src/stores/journal.ts`（渲染端镜像 + 按微任务批量写）
- `docs/fork/MODS.md` 中 DR-3 批次的记录：「journal host 按已落盘 seq 集合去重，允许在 `seq=1,3` 后补写 `seq=2`；写入异常会丢弃内存集合并在下一次调用重新扫描，覆盖写后回执丢失」；R1 批次：「失败批次按序重入队 + 指数退避重试（1s→30s），`flushNow` 挂 beforeunload」
- `docs/fork/evidence/short-scenarios/ACC-20260907-01/` 下 `R01-R02-R07-retest-20260909.md`、`runtime-repair-20260808.md` 提到过 journal 写入失败注入测试

### 需要回答的问题

1. 重启后 journal 的写入链路在哪一步断了：事件没有进入渲染端 store、没有发起 IPC、主进程写盘失败，还是回执丢失后重试逻辑没有再次调度？
2. 渲染端 `persistenceStatus`（pending / gaps / `identityBrokenFrom` / `complete`）在现象发生时是什么值？主进程 journal-host 的已落盘 seq 水位是多少？
3. 这是否与「重启后 replay + 新事件并发」有关？重放把水位推到哪里、新事件 seq 从哪开始？
4. 是否有最小复现：重启后发一条消息，观察事件是否落盘？
5. 修复建议与回归测试建议（按仓库 `enforce-rules-for-vitest` 的要求：先复现再修，回归要覆盖根因）。

## 问题 B：完成门循环（Flow 无法结算）

### 现象

同一会话（journal `40ae9ae5….jsonl`）在修复前记录了 5 次连续拒绝：

```
seq=1526 flow/completion-review verdict=rejected
seq=1573 verdict=rejected
seq=1608 verdict=rejected
seq=1642 verdict=rejected
seq=1709 verdict=rejected
```

blocker 逐次累积，最新一条（`seq=1709`）是：

```
"将凭据写入 workspace/FIX1-20260909/revised-result.txt" step step-1-write-revised: step is blocked
"读回 workspace/FIX1-20260909/revised-result.txt 并比对核验" step step-2-verify-revised: step has not started
"读回 workspace/FIX1-20260909/revised-result.txt 并核对保留凭据" step step-verify-revised: step is blocked
"读取 workspace/FIX1-20260909/revised-result.txt 核验凭据一致性" step step-1-verify-revised: step is blocked
```

重建并重启后（`out/` 21:47，包含下述修复）复验仍然循环：界面显示「进行中 · 第 17 轮 · 4 次工具调用」，卡片四个步骤全部 `blocked / not started`，模型回复「执行计划被判定受阻…接下来我将启动一个包含这四个步骤的长期计划」。用户于 22:17 手动「停止心流」。

### 相关代码

- `packages/stage-ui/src/stores/chat.ts` 的 `evaluateFlowCompletion`（约 938–980 行）：从 `planStore.planViews` 选出计划，展平每个计划的 `spec.steps`，用 `plan.state.completedSteps` / `unverifiedSteps` / `currentStepId` / `blockers` 归一化后交给完成门
- `packages/core-agent/src/planning/flow-completion.ts` 的 `evaluateFlowCompletion()`：`gateCompleted` 或 `declaredComplete` 才算完成；否则按 `status` 报 `step is blocked` / `step is still in progress` / `step has not started`
- `apps/stage-tamagotchi/src/renderer/stores/tools/builtin/plan.ts` 的 `executePlanUpdate()`：`action: 'start'` 时**总是** `planStore.start(spec, undefined, { sessionId })` 创建新计划 id；注释写着「A long goal is a separate rolling lane and keeps its stable id across replans」，但代码里长期目标同样每次都新建 id
- `packages/stage-ui/src/stores/plans.ts`：`planViews`（由 journal 投影 `stateFromJournal`）、`activeLongPlan`（`activePlans.filter(long && !paused).at(-1)`）、`start()`、`updateStep()`、`completeStep()`

### 已经尝试过的修复（均不完整）

新增 `selectFlowCompletionPlans(plans, { sessionId, touchedPlanIds })`，供 `evaluateFlowCompletion` 使用。

- 第一版：长期目标按 `sessionId` 分组，只保留每组最新一份 → 无效，因为这些长期计划 `sessionId === undefined`，全部落进「被触及」分支。
- 第二版（当前工作树）：

```ts
const latestLongPlanId = [...plans].reverse().find(plan => plan.spec.horizon === 'long')?.id

return plans.filter((plan) => {
  if (plan.spec.horizon === 'long') {
    return plan.id === latestLongPlanId
      && (input.touchedPlanIds.has(plan.id) || plan.sessionId === input.sessionId)
  }
  if (input.touchedPlanIds.has(plan.id))
    return true
  return plan.sessionId === input.sessionId
    && !plan.state.paused
    && plan.status !== 'completed'
    && plan.status !== 'failed'
})
```

第二版让 blocker 不再来自「被替换的旧计划」，但**最新计划自己的步骤仍然 `blocked / not started`**，循环照旧。

### 需要回答的问题

1. 为什么长期目标每次 `plan_update start` 都新建计划 id？这符合注释里的「keeps its stable id across replans」吗？如果应当复用 id，复用后完成门与 `activeLongPlan` 的语义会怎么变？
2. 最新计划的步骤为什么长期停在 `blocked`？`plan.state.blockers` 与 `currentStepId` 是谁写进去的（`updateStep(..., 'blocked', ...)` 的调用点有哪些）？重建计划时旧计划的当前步骤被标 blocked（`plan.ts:127-131`，仅 `horizon === 'session'` 分支）是否应该对长期目标也生效，或者反过来根本不该产生 blocked？
3. 模型反复重建计划是不是被完成门的拒绝反馈诱导出来的？如果是，正确的收敛方式是什么（拒绝理由要怎样写，模型才能用「完成已有步骤」而不是「重建计划」来回应）？
4. 是否存在「一个 Flow 只应绑定一个计划」的不变式？如果有，违反它的写点在哪里？
5. 修复建议 + 回归测试建议。测试应通过稳定公共行为验证（仓库规则禁止为测试新增导出或依赖袋）。

## 复现步骤

1. 夹具：`D:\airi\workspace\FIX1-20260909\brief.txt`，内容 `FIX1-TOKEN-8A2D63`（无换行）。
2. 在 AIRI 聊天窗口发送：
   `/goal ACC-20260909-FIX1：读取 workspace/FIX1-20260909/brief.txt，执行一次约 300 秒的前台等待，然后把文件内容写入同目录的 initial-result.txt 并读回核对。用多个小步骤的长期计划，等待期间保持 Flow 运行，不要用后台任务。`
3. 等待步骤开始后（journal 出现 `bash date && sleep 300` 的 `tool/call`）发送：
   `/goal ACC-20260909-FIX1：修改要求——保留已经读到的证据，输出改为 revised-result.txt；旧目标中的其他待写文件不要再写。`
4. 观察：`flow/completion-review` 是否出现连续 `rejected`；`flow/end` 是否缺失；`goal/update` 是否停在 `waiting-condition`；`initial-result.txt` 是否被创建（预期不被创建）；journal 是否继续落盘。

## 已知边界

- `agent-browser` 在本机频繁「产出结果后不退出」，且 `snapshot -i` 在大窗口上可超过 200–400 秒不返回；建议用 CSS 选择器驱动（`textarea`、`[i-solar\:chat-line-line-duotone]`），不要依赖 `@eN`。
- 结束 Electron 后立刻重启可能静默绑定失败（CDP 端口不监听）；结束后等数秒再启动，并用 `http://127.0.0.1:9250/json/version` 复核。
