# R 组三条问题修复记录（2026-09-10）

交接件：[R-GROUP-HANDOFF-20260910.md](./R-GROUP-HANDOFF-20260910.md)。本记录只写代码修复与离线回归；
真机复验由用户重建应用后执行，结果追加到本文件。

## 问题 1：R04 adoption 后不调度，「立即运行」无效

### 根因（已确认）

`setupDataBackupHost` 用普通主进程 Eventa context 发 `backupAdopted`。普通 context 的
`emit` 只回给发起 IPC 的渲染窗口；adoption 是从设置窗口（follower）点的，所以：

- 设置窗口收到事件并本地释放 hold；
- leader 渲染窗口从未收到事件：`effectsHeld` 保持 true，`initialize()` 继续被
  `areRestoreEffectsHeld()` 拦住；
- `long-goals.json` 的 `schedules` 永远为空，wake consumer 从未注册；
- 「立即运行」的 `runNow` 就算写入计划状态，`syncLongGoalSchedule` 也会因 hold 直接返回，
  没有调度、没有反馈。

### 修复

- `apps/stage-tamagotchi/src/main/services/airi/data-backup/index.ts`：新增可注入的
  `EventaWindowBroadcast`，adoption 时广播 `backupAdopted` 到所有窗口。
- `apps/stage-tamagotchi/src/main/index.ts`：把主进程的 `eventaBroadcast` 传给
  `setupDataBackupHost`（与 coding-host、life-mode、long-goal 相同）。
- leader 现有监听（`coding-host-install.ts`）收到广播后释放 hold、重新 `initialize()`
  长目标调度器，于是 `syncAllSchedules()` 按每条 `nextReviewAt` 补排程。
- 「立即运行」补可见结果：`plan-card.vue` 根据 `runNow()` 返回值弹 toast；
  失败时卡片上的等待原因仍然由 `waitForCondition` 写入。

### 回归

- `apps/stage-tamagotchi/src/main/services/airi/data-backup/index.test.ts`（新增）：
  复现「只回发起窗口」的缺陷，钉住广播调用；修复前失败，修复后通过。
- `packages/stage-ui/src/stores/modules/long-goals.browser.test.ts`：
  「恢复 hold 期间 boot 被跳过，adoption 释放后必须按 nextReviewAt 补排程」。

## 问题 2：R05 技能不可调用原因不可见 + 回退到 MCP 元工具

### 缺口 A（原因不可见）

被 `artifactError` / quarantine / hash 不符 / schema 非法 / registry 损坏挡下的
reviewed 技能，原先只是从工具面消失。模型只能答「不在工具列表里」。

修复：`packages/stage-ui/src/stores/skills.ts` 的 `syncRuntimeTools()` 额外注册一个
独立的 `## Toolset` 提供者（`self-authored-skills-unavailable`），逐条列出不可用技能名、
toolId、原因和恢复入口（Settings → Modules → Skills），最多列 10 条。

### 缺口 B（无 MCP 服务器仍暴露元工具）

- `apps/stage-tamagotchi/src/renderer/stores/tools/mcp.ts`：只有存在已配置服务器时
  才注册 proxy 元工具；没有任何服务器、也没有 native `mcp_*` 时注册空工具面，并清掉
  `mcp-tools` 说明节。
- `packages/stage-ui/src/stores/ai/chat-llm/tool-resolver.ts`：默认不再注入旧的
  `builtIn_mcp*` 代理工具；运行时 MCP store 是唯一生产者，显式 `builtInTools`
  覆盖仍然优先。

### 回归

- `packages/stage-ui/src/stores/skills.browser.test.ts`：
  工作区不匹配导致技能被挡时，`## Toolset`（work profile）包含技能名、id、原因和
  Settings 入口，且技能没有注册成可调用工具。
- `apps/stage-tamagotchi/src/renderer/stores/tools/mcp.test.ts`：
  无服务器时 `mcp:*` 工具与说明节都不出现；有服务器但发现未落地时 proxy 仍在
  （boot race 保留）。
- `packages/stage-ui/src/stores/ai/chat-llm/tool-resolver.test.ts` 与 `llm.test.ts`：
  默认工具面不含 `builtIn_mcp*`；运行时注册的 proxy 仍然透传。

## 问题 3：R03 恢复后首屏没有明确原因

### 修复

- `apps/stage-tamagotchi/src/main/services/airi/data-backup/profiles.ts`：
  `prepareRestoreProfile` 从归档 identity 读 owner，写入 `restore-state.json`；
  `begin()` 在 leader / follower 两条路径都返回 `ownerId`。
- `apps/stage-tamagotchi/src/shared/eventa/data-backup.ts`：`RestoreBootstrap` 增加
  `ownerId`。
- `packages/stage-ui/src/services/restore-gate.ts`：新增 `restoredOwner` +
  `setRestoredOwner()`；非恢复启动的 `completeRestoreGate(false)` 会清空它。
- `apps/stage-tamagotchi/src/renderer/main.ts`：bootstrap 结果里带 owner 时写入 gate。
- `step-welcome.vue`：hold 中且未登录时，首屏改成「数据已恢复」标题 + 注明
  `{owner}` 的描述 + 「登录以查看数据」按钮，并隐藏全新安装的 provider 入口。
- i18n 只新增 en 与 zh-Hans（`settings.dialogs.onboarding.restored.*`）。

### 回归

- `profiles.test.ts`：leader / follower bootstrap 都带 `ownerId`。
- `restore-gate.test.ts`：owner 保留到下一次非恢复启动才清空。
- `step-welcome.browser.test.ts`：未认证 + hold 时显示恢复说明与 owner，不显示
  「Setup with your provider」。

## 离线验证

| 命令 | 结果 |
| --- | --- |
| `pnpm exec vitest run --config apps/stage-tamagotchi/vitest.config.ts --project node src/main/services/airi/data-backup src/main/services/airi/long-goal src/renderer/stores/tools` | 16 files / 98 passed（1 skipped） |
| `pnpm exec vitest run --config packages/stage-ui/vitest.config.ts --project node src/stores/ai/chat-llm src/stores/skills.test.ts src/stores/chat.contract.test.ts src/stores/chat-advancer.test.ts src/stores/plans.test.ts src/stores/modules/memory.test.ts src/services/restore-gate.test.ts src/services/data-restore.test.ts` | 全部通过 |
| `pnpm exec vitest run --config packages/stage-ui/vitest.config.ts --project browser src/stores/skills.browser.test.ts src/stores/modules/long-goals.browser.test.ts src/stores/data-backup.browser.test.ts src/components/scenarios/dialogs/onboarding/step-welcome.browser.test.ts src/components/scenarios/chat/components/history.browser.test.ts` | 全部通过 |
| `pnpm exec vitest run --config apps/stage-tamagotchi/vitest.config.ts --project browser src/renderer/components/InteractiveArea.browser.test.ts` | 15 passed |
| `pnpm -F @proj-airi/stage-ui typecheck` / `pnpm -F @proj-airi/stage-tamagotchi typecheck` | 通过 |
| `pnpm lint` | 通过（既有 warning 保留） |

注意：stage-ui 测试消费 `@proj-airi/i18n` 的 dist；改 locale yaml 后已重建 i18n 包。

## 真机复验（待用户执行）

用户重建并重启后重跑三条路径，按交接件的关闭条件判定：

1. 恢复 → 登录 → adoption → 不重启：观察 `long-goals.json` 是否出现目标、journal 是否出现
   `goal/update`，目标是否启动恰好一次有界 Flow；「立即运行」应有 toast。
2. 发送 `请实际调用 acc_20260909_dedupe …`：模型应说明「待重新验证」原因，而不是报
   「不存在」；无 MCP 服务器时工具面不应出现 `builtIn_mcp*`。
3. 恢复副本首次启动：首屏应显示「数据已恢复，请登录 <owner>」并提供登录入口。

已知边界：恢复目标的 `workspaceRoot` 指向原工作区时，唤醒会走
`checkStartConditions` 的工作区比对，并留下可见等待原因（不再静默）。这是设计内的
诚实阻塞；要启动 Flow，需要目标工作区在恢复副本中同路径存在，或用户先接受环境变化。

## 未做

- 未重建、未重启用户的 Electron 实例（按要求）。
- R04 的「恰好一次 Flow / 重复点击不产生第二次」真机口径未在本机执行。

---

# 真机复验结果（2026-09-10 重建后）

- 构建：`pnpm -F @proj-airi/stage-tamagotchi build` 退出码 0，`out/` 更新到 14:44–14:45；`core-agent` 与 `i18n` 的 dist 已是当前源的最新构建，无需重建。
- 复验用的恢复副本：新建 `restores\restore-J2TLrx`（14:46:53，来源 `C:\Users\86130\Downloads\airi-backup-2026-09-09T17_53_15.331Z.zip`），以及既有的 `restores\restore-7IF4GT`（P''，已登录原 owner）。
- 复验结束后应用已重启回默认 profile，生命模式保持 `autonomous / 间隔 15 / 静默 3–4 / 预算不限 / 冷却 30`。

## R03：恢复后首屏 —— PASS

| 检查点 | 结果 |
| --- | --- |
| `restore-state.json` | 新增 `"ownerId":"3bXjSqeoKBQnOCCXBcudtmM8omc0xKxY"`，`effectsHeld:true` |
| 首屏标题 | **数据已恢复** |
| 首屏描述 | 来自 `3bXjSqeoKBQnOCCXBcudtmM8omc0xKxY` 的数据已恢复到本设备。请登录 `3bXjSqeoKBQnOCCXBcudtmM8omc0xKxY` 以查看。 |
| 主按钮 | **登录以查看数据** |
| 全新安装入口 | 「配置您自己的 AI 服务来源」**不出现**（`showRestoreNotice` 生效） |

截图：[R03-restored-first-screen-20260910.png](./R03-restored-first-screen-20260910.png)。原文（含「欢迎来到 AIRI！」+ 双入口）已不再出现。

## R04：adoption 后调度 —— PASS（机制）／Flow 启动未达（环境边界）

| 检查点 | 结果 |
| --- | --- |
| adoption 前 | `long-goals.json` = `{"schedules": []}`（与修复前失败现场一致） |
| 点击「使用恢复的 profile」（**未重启**） | UI 提示「恢复的 profile 已启用。」 |
| `restore-state.json` | `effectsHeld` → **false** |
| `long-goals.json` | **2 条排程**：`430613eb-071b-4459-908a-f79130ce706a`、`598e975d-1f6b-4ecd-980f-1055f26126a2`，`nextReviewAt` ≈ 14:49:40 |
| 唤醒是否发生 | 两个目标的 `longGoal.lastTransition.source = "scheduler"`，时间戳 = adoption 时刻；`waitReason = "The current user or character is outside the goal scope."` |

结论：广播修复生效——leader 收到 `backupAdopted` 后释放 hold、重新初始化调度器并按 `nextReviewAt` 补排程，且唤醒把**可见原因**写进目标状态，而不是像修复前那样完全静默。

**未达部分（环境边界，非缺陷）**：没有观察到「恰好一次有界 Flow」。`checkStartConditions` 的第一道门就拦住了（`packages/stage-ui/src/stores/modules/long-goals.ts:106-158`）：

1. 新建副本未登录，`chatSession.index.userId = 'local'`，与目标 scope 的原 owner 不一致 → `The current user or character is outside the goal scope.`；
2. 之后还有 `No provider and model are configured.`；
3. 再之后是 `status.workspaceRoot !== plan.spec.workspaceRoot`（目标记录的原工作区是 `D:/airi`，副本的 coding root 是 `<copy>\workspace`）；
4. 最后是环境差异门，需要 `acceptEnvironmentChange`（即修复方说的「用户先接受环境变化」）。

要跑完这一条，需要在新副本里：登录原 owner → 配置 provider → 把 coding 工作区根设为 `D:/airi`（或走接受环境变化的入口）。这三步都需要用户凭据，本次未执行。

另：「立即运行」的 toast 未逐项复验——目标卡不在该副本聊天窗口当前会话的计划视图里。adoption 的成功提示可见。

## R05：技能不可调用原因可见 + 元工具 —— PASS（两个缺口）

### 缺口 A（原因可见）

prompt 组装（leader，`llm-toolset-prompts` 的 `self-authored-skills-unavailable` 提供者）末尾出现：

```
### Unavailable reviewed skills

These reviewed self-authored skills are not callable right now. Do not call them and do not invent
their results. Tell the user the reason below and ask them to re-verify the skill in
Settings → Modules → Skills.
- acc_20260909_dedupe (acc-20260909-dedupe): This skill belongs to a different workspace. Return to
  its workspace before use.
```

运行时（P''，已登录原 owner，同一句提问）：

| | 回答 |
| --- | --- |
| 修复前（13:39） | 「工具列表中不存在 `acc_20260909_dedupe`，当前无法实际调用它。」 |
| **修复后（14:53）** | 「`acc_20260909_dedupe` 当前无法调用。原因：该技能属于不同的工作区（This skill belongs to a different workspace. Return to its workspace before use）。请返回其对应的工作区，或在 `…Settings → Modules → Skills` 中重新验证该技能。」 |

journal（P'' 的 `40ae9ae5f845754a6add46f6ce4c8325.jsonl`）：`seq=4853`–`4863`，**整轮零 `tool/call`**。

### 缺口 B（元工具）

| 检查点 | 结果 |
| --- | --- |
| 工具面 | 33 个工具，**没有任何名字含 `mcp`** 的项（修复前该副本会出现 `builtIn_mcpListTools`/`builtIn_mcpCallTool`） |
| 运行时行为 | 修复前 `seq=4845` 调 `builtIn_mcpListTools`；修复后同一提问**没有任何工具调用**，模型直接说明原因 |

## 仍未覆盖

- R05 的 **embedding 切换**与**凭据缺失**两个变体仍未执行（凭据缺失这次只在新建副本里间接触及：唤醒原因可见，但不是 R05 定义的探针）。
- R04 的「恰好一次有界 Flow / 重复点击不产生第二次」需要登录后的副本（见上）。
- R06 的 `update` 先于 `insert` 静默丢数据仍是未修项。

