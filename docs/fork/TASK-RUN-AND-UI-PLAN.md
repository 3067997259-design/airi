# AIRI 任务运行时与聊天界面改造计划

日期：2026-09-05。
状态：批次 A–E 已实施；批次 F 部分执行（2026-09-05 真机走查，见 §9.0 验收记录）——F2/F5/F6/F7 场景通过，F1/F3/F4/F8–F12 未走查。
范围：`packages/core-agent`、`packages/stage-ui`、`apps/stage-tamagotchi`，以及相关测试和文档。

## 0. 目标

AIRI 需要把聊天、工具执行、计划、记忆和人格组织成一个可恢复的任务运行时。

本计划解决六项工作：

1. 建立统一的 `TaskRun` 投影。
2. 分离聊天、任务活动和计划裁决的界面投影。
3. 让 Flow 成为唯一的自动推进器。
4. 保存完整的 Flow 恢复信息。
5. 为失败、重复调用和大型结果建立有界的内部上下文。
6. 完成真实 Electron 组合验收。

本计划不改变人格设定、记忆提取策略或生命模式政策。它只定义任务运行、任务展示和验收边界。

## 1. 设计依据

### 1.1 Codex CLI 的可借鉴部分

Codex 把 session、turn、事件历史和恢复状态分开管理。

- session 持有可恢复的事件历史。
- turn 是有开始和结束的执行单元。
- 每个工具调用都必须有对应结果。
- 中断发生在明确的取消边界。
- 压缩发生在下一次采样前。
- UI 消费事件投影，不直接消费内部历史结构。

AIRI 应采用这些边界，不复制 Codex 的 TUI、Rust 模块或工具数量。

### 1.2 AstrBot 的可借鉴部分

AstrBot 把 agent run 写成显式的 step loop。

```text
model response
  -> tool call
  -> tool result
  -> append result to context
  -> next step
```

它还提供以下机制：

- stop watcher 监视用户停止请求。
- 达到步数上限后，关闭工具并请求最终总结。
- 重复调用时向模型提供结构化提示。
- 大型工具结果写入外部文件，只在上下文中保留预览和引用。
- 工具状态可以单独发送，不必混入普通聊天文本。

AIRI 已有其中一部分。后续工作应把它们纳入统一的任务投影和恢复协议。

## 2. 当前实现基线

当前代码已经具备以下能力：

- `continueFlow` 在回合边界推进下一次 Flow 迭代。
- Flow 记录 `done`、`blocked`、`budget`、`no-progress` 和 `interrupted`。
- 工具结果记录 `outcome`、失败轨迹和工具层级。
- journal 回放可以重建部分 Flow 计数和状态。
- assistant 输出支持文字和工具调用交错流式展示。
- `flow-timeline-card.vue` 可以显示工具、结果、叙述和 steering。

当前仍有以下边界问题：

1. Plan continuation 和 Flow continuation 仍然并存。
2. Flow continuation 在 provider 请求中使用 user role 的内部提示。
3. 同一次工具活动可以同时出现在 assistant 气泡、Flow 卡和计划卡。
4. Flow 恢复没有保存原始 provider、model、工具集合和工作画像。
5. Flow 活动卡按 `flow/start` 扫描事件，缺少明确的结束截断和任务归属。
6. 真实 provider、停止、重启、多窗口和打包 EXE 尚未形成完整验收证据。

## 3. 实施批次

批次必须按以下顺序执行。后一个批次不得绕过前一个批次的公共契约。

| 批次 | 工作 | 主要结果 | 依赖 |
|---|---|---|---|
| A | `TaskRun` 投影 | 一个任务的统一身份和状态 | 无 |
| B | 三种界面投影 | 消除聊天、工具和计划的重复展示 | A |
| C | 单一推进器 | Flow 独占自动续跑 | A |
| D | 持久化恢复 | 重启后使用原任务配置继续 | A、C |
| E | 有界内部上下文 | 失败、重复和大结果可以收敛 | C |
| F | Electron 组合验收 | 真实运行证据和问题清单 | A–E |

每个批次都必须更新测试、相关设计文档和 `MODS.md`。不要在一个批次中重写无关模块。

## 4. 批次 A：建立 `TaskRun` 投影

> 状态：已实施（2026-09-05）。落地要点与计划的差异记录在本节末尾。

### 4.0 实施记录（2026-09-05）

- 契约（`packages/core-agent/src/journal/types.ts`）：`flow/start`、`flow/step`、
  `flow/end`、`plan/update`、`tool/call`、`tool/result`、`user/steering`、
  `user/asked`、`user/answered`、`turn/start` 与 `flow/completion-review`
  均携带可选 `taskId`；新增 `TaskRun` 与 `TaskRunStatus` 类型。
  `TaskRunStatus` 相比计划微调：去掉无人产出的 `queued`，把 `no-progress`
  升为独立状态（避免从 `endDetail` 反猜终态）。
- 派生（新文件 `packages/core-agent/src/journal/task-run.ts`）：
  `deriveTaskRuns(events)` 纯函数从事件流按戳记归属派生任务（时间窗口零参与）；
  `openTaskId(events)` 供写方在写入时刻取当前开放任务的 id。旧 journal 的
  flow（无 `taskId` 戳记）按 `flowId` 聚合为一条 `legacy: <flowId>` 的
  一次性投影，`legacy: true`，身份只供展示、不可恢复。
- runtime（`chat-orchestrator-runtime.ts`）：`FlowState` 增加 `taskId`；
  `startFlow` 与 `flowId` 并列铸造 `taskId`（绝不互相派生）；flow 窗口内的
  `flow/step`、`flow/end`、`user/steering`、`flow/completion-review`、
  `turn/start`（续跑轮）与工具 `tool/call`、`tool/result`（含悬空补偿）按
  写入时刻归属戳记；`rebuildFlowFromJournal` 从事件恢复原 `taskId`，
  无戳记的旧 flow 抑制自动续跑（匿名续跑被禁止）。
- stage-ui：journal store 暴露 `taskRuns` 投影；plans store 的全部
  `plan/update` 与 `tool/result` 写入点、user-ask 与 btw store 的问答写入点
  在有开放 flow 时戳记 `taskId`；chat store 只读 `journalStore.taskRuns`
  （`evaluateFlowCompletion` 的计划归属改为戳记优先、legacy 窗口扫描仅作
  旧事件回退并注明优先级）。
- 测试：core-agent 新增 `task-run.test.ts`（11 例）与 runtime 身份一致性、
  恢复保留、legacy 不续跑 3 例；stage-ui 新增 journal 投影 2 例、plans 戳记
  1 例。core-agent 26 files / 261 tests、stage-ui 149 files / 904 tests 全过；
  core-agent / stage-ui / stage-tamagotchi typecheck 通过，改动文件 eslint 干净。
- UI 变更按计划留给批次 B（时间线的任务入口与活动面板在 B 落地）。

### 4.1 目标

为一次连续工程工作建立稳定的任务身份。

`TaskRun` 是 journal 的派生投影。它不是第二份事实来源，也不替代 Flow、Plan 或聊天消息。

建议字段如下：

```ts
interface TaskRun {
  taskId: string
  sessionId: string
  flowId?: string
  planIds: string[]
  title: string
  status: 'queued' | 'running' | 'waiting-user' | 'completed' | 'blocked' | 'interrupted' | 'budget'
  startedAt: number
  updatedAt: number
  currentIteration?: number
  currentStepId?: string
  pendingQuestion?: string
  lastFailure?: string
  endDetail?: string
}
```

字段可以调整，但任务身份必须稳定。`flowId`、`planId` 和消息 id 不能互相充当任务 id。

### 4.2 代码入口

- `packages/core-agent/src/journal/types.ts`
- `packages/core-agent/src/runtime/chat-orchestrator-runtime.ts`
- `packages/stage-ui/src/stores/journal.ts`
- `packages/stage-ui/src/stores/chat.ts`
- `packages/stage-ui/src/stores/plans.ts`
- `packages/stage-ui/src/components/scenarios/chat/components/history.vue`

### 4.3 实施步骤

1. 为 `flow/start`、`flow/step`、`flow/end`、`plan/update`、`tool/call`、`tool/result` 和 steering 事件定义任务关联字段。
2. 让 runtime 在 Flow 创建时生成 `taskId`，并在后续 Flow 事件中携带它。
3. 让 Plan 关联已有任务，禁止根据时间窗口猜测任务归属。
4. 在 journal store 中从连续事件派生 `TaskRun`。
5. 在 Flow 恢复时从事件重新计算任务状态。
6. 为缺少任务字段的旧 journal 提供一次性无任务投影，并标记为不可恢复。
7. 让 chat store 只读取任务投影，不自行拼接 Flow 和 Plan 的身份。

### 4.4 验收条件

- 一个 Flow 及其所有迭代只有一个 `taskId`。
- 一个任务可以关联多个 Plan 更新，但不会产生多个任务卡。
- 用户 steering 不会创建新任务。
- Flow 结束后，任务状态只从 journal 推导。
- 重启和重新 hydrate 后，`taskId`、`flowId` 和 `planId` 保持不变。
- 缺少任务关联字段的旧事件不会被静默改写。

## 5. 批次 B：分离三种界面投影

> 状态：已实施（2026-09-05）。实施记录见本节末尾。

### 5.0 实施记录（2026-09-05）

- **任务活动投影**：新组件 `task-activity-panel.vue` 以 `TaskRun` 为唯一输入，
  事件窗口按 `taskId` 截断（`flow/start` 起至同一任务的 `flow/end` 止），
  不再按 `flow/start` 扫描到日志尾；活动上限 40 行，头部显示标题、状态、
  当前迭代与工具调用数，正文含 pendingQuestion、lastFailure、endDetail、
  叙述、steering、计划更新与完成评审。提供停止按钮（emit `stop`）与
  收起/展开（desktop 默认展开，mobile 默认摘要行）。运行中/等待用户为
  琥珀色活跃态，结束任务为中性色。
- **时间线装配**（`history.vue`）：`flow` prop（FlowState）移除，改收
  `taskRuns`；live 任务（running/waiting-user）固定在时间线末端不随时间
  排序；结束任务按 `updatedAt` 取最近 3 个渲染为可展开摘要行，任务结束后
  仍可从聊天打开活动记录。旧 `flow-timeline-card.vue` 删除。
- **聊天投影去重**：`assistant-item.vue` 新增 `hideToolSlices`——
  `flowIteration` 气泡只渲染叙述文本，其工具活动归属任务活动面板；
  非 flow 轮气泡保持现状（无任务归属的工具块是它们唯一的可见位置）。
  每投影内一次工具调用至多出现一次。
- **计划裁决投影**：plan-card 仅显示 evidence source 与截断 summary，
  不显示工具参数与完整输出，本批核对无需改动。
- **接线**：tamagotchi `InteractiveArea.vue` 传 `:task-runs` 并接
  `@stop-task`（复用既有 endFlow 中断路径）；composer 琥珀指示条继续读
  runtime `flowStates`（即时步数权威，与投影分离）。
- **i18n**：`stage.task-activity.*` 新键（en + zh-Hans），删除无消费者的
  `stage.flow-timeline.*`。
- **验证**：stage-ui 150 files / 908 tests 全过（新增面板契约测试 3 例）、
  stage-tamagotchi typecheck 0 错误、生产构建通过、改动文件 eslint 干净。
  真机走查（桌面 + 移动布局、F1/F2 对应的投影不重复）随批次 F 执行。

### 5.1 目标

聊天窗口需要回答三个不同问题：

1. 她对用户说了什么？
2. 她正在执行什么？
3. 她怎样判断任务完成？

这三个问题必须使用三个投影。一个事件可以被多个投影读取，但不能在每个投影中重复渲染同一段内容。

### 5.2 三种投影

#### 聊天投影

聊天投影只显示以下内容：

- 用户真实消息。
- assistant 的工作叙述。
- 最终结果和收尾说明。
- 用户问题、审批请求和阻塞说明。
- 社交通道中经过验证的公开发言。

工具参数、完整工具结果和计划证据不直接进入普通 assistant 气泡。

#### 任务活动投影

任务活动投影显示：

- 当前任务标题和状态。
- 当前迭代和工具调用数。
- 最近的工具调用和结果。
- 失败、重试、重复路径和 steering。
- 当前等待原因和停止控制。

活动列表必须有上限。完整记录留在 journal 和 devtools。

#### 计划裁决投影

计划投影显示：

- 步骤意图。
- 当前焦点。
- 已验证、未验证、失败和等待审批的步骤。
- 证据门结果。
- 完成评审结果。

计划投影不重复显示工具参数。它只显示工具结果是否满足步骤要求。

### 5.3 代码入口

- `packages/stage-ui/src/components/scenarios/chat/components/history.vue`
- `packages/stage-ui/src/components/scenarios/chat/components/flow-timeline-card.vue`
- `packages/stage-ui/src/components/scenarios/chat/components/assistant-item.vue`
- `packages/stage-ui/src/components/scenarios/chat/components/plan-lanes.vue`
- `packages/stage-ui/src/stores/journal.ts`
- `packages/stage-ui/src/stores/chat.ts`

### 5.4 实施步骤

1. 用 `TaskRun` 作为聊天时间线中的唯一任务入口。
2. 将 Flow 卡改为任务活动面板，不再作为普通消息参与时间排序。
3. 让 assistant item 隐藏已归属于任务活动面板的工具 slice。
4. 让计划卡只读取计划事件和证据门结果。
5. 为活动面板增加收起、展开、查看完整记录和停止操作。
6. 让活动面板按 `taskId` 和结束事件截断事件窗口。
7. 让正在运行的任务固定在输入框上方或聊天末端，不随旧消息时间移动。
8. 为移动端保留摘要行，详细活动使用独立抽屉或折叠面板。

### 5.5 验收条件

- 一次工具调用在聊天投影中最多出现一次，在任务活动投影中最多出现一次。
- 计划卡不显示完整工具参数和完整工具输出。
- 新任务不会把旧任务的活动带入当前卡片。
- 任务结束后仍可从聊天中打开活动记录。
- 任务状态、当前步骤和停止按钮在桌面端可见。
- 移动端不会因为活动记录增长而挤压聊天输入区。
- UI 组件使用 Vue 3 Composition API 和显式 props/emits 契约。

## 6. 批次 C：让 Flow 成为唯一推进器

> 状态：已实施（2026-09-05）。实施记录见本节末尾。

### 6.0 实施记录（2026-09-05）

- **路径勘探**（步骤 1）：任务推进类的自动发送只有两处——runtime 内部的
  flow continuation（`source: 'flow'`，批次 A 起携带 `taskId`）与 chat store
  的 `schedulePlanContinuation`（合成 `self-initiative` 文本，每计划上限 2
  次）。life-mode 的 `self-initiative` 是社交考量轮、btw 是反向提问通道，
  均不推进任务，不在本批范围。
- **删除 Plan 自续跑**（步骤 2/3）：`schedulePlanContinuation`、其预算/
  冷却常量与 `runnablePlanStep` 全部移除，`onChatTurnComplete` 不再调度。
  "仍有未裁决步骤"的交接由两个既有机制承担：计划投影随 work 轮尾部注入
  （裁决可见），L1 完成门在 flow 收 done 声明时合取全部步骤（计划不会在
  flow 未裁决时关闭）。计划步骤的剩余状态不再产生任何自动发送。
- **入口收敛**（步骤 4）：保留用户显式发送、`/flow` 命令、Flow 内部
  continuation 三个入口，与计划一致。
- **continuation 卫生**（步骤 5–7）：`source: 'flow'` + `taskId`（批次 A）；
  合成 user-role 提示不写 `user/message`、不进记忆提取与用户消息统计
  （FLOW-KNOWLEDGE F4 定案 + 现有早退分支），runtime 测试继续断言
  continuation 后 `user/message` 仍只有用户那一条。
- **结算与停止**（步骤 8–10）：续跑前的工具结算、journal 顺序、压缩等待、
  终止检查，steering 先于 done 结算，停止取消模型流/工具/后续迭代——
  均为 FLOW-AUTONOMY/R4 已落地行为，本批核对无回归。
- **测试**：新增 `chat-advancer.test.ts` 契约测试钉住调度器已删除；
  core-agent 261/261、stage-ui 911/911 全过，stage-ui typecheck 干净。

### 6.1 目标

一次任务只能有一个自动推进入口。Plan 提供裁决，Flow 提供推进。

### 6.2 需要保留的职责

| 机制 | 职责 |
|---|---|
| Flow | 决定是否开始下一次迭代 |
| Plan | 决定步骤是否满足证据要求 |
| Chat | 接收用户目标和 steering |
| Journal | 保存事实和状态转变 |
| Completion review | 判断完成声明是否诚实 |

### 6.3 实施步骤

1. 找出所有生成 `self-initiative` 或 continuation 文本的路径。
2. 将 Plan continuation 改为向 Flow 提交“仍有未裁决步骤”的状态。
3. 删除 Plan 自己调用 `send()` 的自动续跑路径。
4. 保留用户显式发送、`/flow` 命令和 Flow 内部 continuation 三种入口。
5. Flow continuation 使用明确的内部来源字段，例如 `source: 'flow'` 和 `taskId`。
6. 将 continuation 从用户历史、记忆提取和用户消息统计中排除。
7. 如果 provider 只接受 user role 的上下文，保留该 role，但同时写入内部元数据，并禁止把它投影为真实用户消息。
8. 在每次续跑前完成工具结果结算、journal flush、压缩等待和终止检查。
9. 用户 steering 必须在 `done` 结算前消费。
10. 停止请求必须取消当前模型流、工具执行和后续续跑。

### 6.4 验收条件

- 同一个任务不会同时触发 Plan continuation 和 Flow continuation。
- Flow 结束后不会再产生排队的自动 continuation。
- 用户发送 steering 后，旧的 done 声明不会吞掉新输入。
- 用户停止后，当前工具和后续迭代都会停止。
- continuation 不出现在真实用户消息列表中。
- journal 顺序为：工具结果、turn/end、必要的 flow/end。
- 连续失败和无进展会进入统一的 Flow 终止判定。

## 7. 批次 D：保存完整的 Flow 恢复信息

> 状态：已实施（2026-09-05）。实施记录见本节末尾。

### 7.0 实施记录（2026-09-05）

- **契约**（`journal/types.ts`）：新增 `FlowResumeConfig`（providerId、model、
  profile、toolNames、workspaceRoot——不含 API key、prompt 或任何 secret）
  与 `FlowResumeContext`（恢复时组装的完整校验视图：+taskId/flowId/
  sessionId/iteration/lastJournalSeq/status）。`flow/start` 携带 `resume`
  快照；`flow/step` 携带 `lastJournalSeq`（已结算 journal 游标）并刷新
  `resume`——重启后以最新快照为准。
- **runtime**：新 deps `getFlowResumeSnapshot`（写入时采集）与
  `verifyFlowResume`（恢复前校验）。`rebuildFlowFromJournal` 组装
  FlowResumeContext：flow/start 的 resume + 窗口内最后一个 flow/step 的
  resume/lastJournalSeq；校验失败或快照缺失 → 写 `flow/end
  { reason: 'interrupted', detail: 'waiting to resume: …' }` 并放弃自动续跑
  （等待原因经 detail 进入活动面板与 devtools，不静默）。身份用事件游标
  （原 taskId/flowId/seq 不变，不重新编号）；journal 完整性检查与续跑前
  压缩等待沿用既有机制。
- **宿主**（chat store）：`getFlowResumeSnapshot` 返回当前
  provider/model/work 画像/常驻工作工具面/coding host workspaceRoot；
  `verifyFlowResume` 以 provider 配置库（localStorage 持久、启动即可同步读）
  校验 provider 仍在。model 目录与工具注册表为懒加载/动态，严格比对会产生
  假阴性阻断——记录不校验（已在代码注释与本文档声明此裁决）。
- **多窗口**：恢复 owner 仍是 leader（main.ts 恢复调用在 leader-only 门内），
  其他窗口只读 journal 投影，符合步骤 9。
- **测试**：runtime 新增 2 例——flow/step 携带 lastJournalSeq+刷新 resume；
  verify 不通过时阻断并写可见 `flow/end`。core-agent 263/263、stage-ui
  911/911、两侧 typecheck 干净、eslint 干净。

### 7.1 目标

重启后的任务必须在原执行环境中继续，或明确进入等待用户恢复状态。

### 7.2 必须保存的信息

```ts
interface FlowResumeContext {
  taskId: string
  flowId: string
  sessionId: string
  providerId: string
  model: string
  profile: 'social' | 'work'
  toolNames: string[]
  workspaceRoot?: string
  iteration: number
  lastTurnId?: string
  lastJournalSeq: number
  status: 'running' | 'waiting-user' | 'interrupted' | 'ended'
}
```

不要保存 API key、完整 prompt 或未脱敏的 provider secret。

### 7.3 实施步骤

1. 在 `flow/start` 中保存恢复所需的非敏感运行配置。
2. 在 `flow/step` 中保存迭代号和最后一个已结算 journal seq。
3. 在 `flow/end` 中保存终止原因和收尾状态。
4. 恢复时验证 provider、model、工具集合和 workspace root 是否仍可用。
5. 环境不一致时暂停任务，并显示恢复原因。
6. 使用事件游标恢复未完成任务，不能通过重新编号构造新身份。
7. 恢复前等待 journal 完整性检查和未完成压缩。
8. 恢复失败时写入明确的 `flow/end` 或 `flow/recovery-failed` 事件。
9. 为多窗口指定一个恢复 owner，其他窗口只读取任务投影。

### 7.4 验收条件

- 重启后可以恢复 provider、model、工作画像和工具集合。
- 原有 `taskId`、`flowId`、turn id 和 journal seq 保持不变。
- journal 存在缺口时不会自动续跑。
- provider 配置被删除时，界面显示“等待恢复”，不会静默失败。
- 多窗口不会同时恢复同一个 Flow。
- 恢复任务不会重复执行已经结算的工具调用。

## 8. 批次 E：建立有界的内部上下文

> 状态：已实施（2026-09-05）。实施记录见本节末尾。

### 8.0 实施记录（2026-09-05）

- **失败路径**：`FlowFailureRecord` 增加 `outcome` 分类（failed/denied/
  timeout）；参数摘要维持 240 字符截断、轨迹维持 6 条上限
  （`FLOW_FAILURE_TRAIL_LIMIT`）；迭代开场提示的失败段改为
  `Recent failures ([outcome] tool args: reason)`——明示每条是教训不是证据
  （证据门本就只认成功回执，语义不变）。
- **重复调用**：指纹拦截维持阈值 3（结构化 blocked 提示）；新增升级阈值
  `FLOW_REPEAT_FAILURE_ESCALATION = 6`——同一指纹失败达到 6 次后，blocked
  返回不再给"换条路"的提示，改为要求问她（btw_ask/user_ask）、声明 blocked
  或彻底换方法。与停滞判定（3 轮无新观察 → no-progress 终止）共同保证重复
  失败必然收敛。
- **大型结果**：新 `boundLargeToolResults`——provider 上下文中的 tool 消息
  超过 `TOOL_RESULT_CONTEXT_LIMIT`（4000 字符）时截断并追加
  `[truncated N characters — the full result is preserved in the journal …]`
  提示。**设计调整**：不另写 workspace 临时文件——journal 本就是
  append-only 的完整结果存储（"可读取对象"），已满足"用户可打开完整结果"
  （devtools journal 浏览器/活动面板→journal），且免去文件清理失败面；
  上下文有界由截断直接达成。UI 与 journal 不受影响（截断只发生在发给
  provider 的消息数组）。
- **验证**：runtime 新增 2 例——同一指纹 7 连败时第 4-6 次普通拦截、第 7 次
  升级拦截；6000 字符结果下一轮 provider 消息 ≤4200 字符且带截断提示、
  journal summary 保全量。core-agent 265/265、typecheck 0、eslint 干净。

### 8.1 目标

让失败、重复和大型结果帮助下一步决策，同时防止上下文无限增长。

### 8.2 失败路径

每次 Flow 迭代只保留最近的有界失败摘要。每条摘要至少包含：

- 工具名称。
- 参数的安全摘要或哈希。
- 失败分类。
- 失败原因的短文本。
- 是否已经尝试过替代路径。

失败摘要不等同于证据。证据门只消费成功且满足来源要求的结果。

### 8.3 重复调用

1. 对工具名和规范化参数计算调用指纹。
2. 同一指纹连续失败达到阈值时，注入结构化提示。
3. 提示中列出失败原因和建议的下一步观察。
4. 连续重复达到更高阈值时，暂停 Flow 或请求用户介入。
5. 不使用完整参数文本作为长期提示，避免泄露和上下文膨胀。

### 8.4 大型工具结果

1. 计算工具结果的大小或估算 token 数。
2. 小结果直接进入模型上下文。
3. 大结果写入任务作用域的临时文件或可读取对象。
4. 上下文只保留摘要、路径、结果类型和读取提示。
5. 工具结果文件必须受 workspace 和任务权限限制。
6. 任务结束或用户删除任务时清理临时结果。

### 8.5 代码入口

- `packages/core-agent/src/runtime/chat-orchestrator-runtime.ts`
- `packages/core-agent/src/journal/types.ts`
- `packages/stage-ui/src/stores/chat.ts`
- `apps/stage-tamagotchi/src/renderer/stores/tools/builtin/`
- `packages/core-agent/src/runtime/chat-orchestrator-runtime.test.ts`

### 8.6 验收条件

- 同一失败调用不会无限重复。
- 下一次迭代能看到最近失败原因。
- 失败摘要有固定数量和字符上限。
- 大型结果不会直接耗尽模型上下文。
- 证据门不会把失败摘要当成成功证据。
- 用户可以从任务活动面板打开完整结果。
- 清理失败会进入 journal 或 devtools 状态，而不是静默丢弃。

## 9. 批次 F：Electron 组合验收

> 状态：**部分执行**（2026-09-05 真机走查，环境：构建版 electron.exe + CDP 9250 +
> 日常 profile + agent-browser/raw CDP eval）。结果与发现：
>
> **通过**
> - F2（Flow 独占推进 + 迭代自动续跑）：真实任务 25 轮迭代自动推进，
>   `user/message` 全程只有用户那条（无合成消息，批次 C）。
> - F5（任务可见性）：活动面板在 chat 窗口渲染标题/状态/迭代/最近失败/
>   结束原因；flow 迭代叙述气泡可见。
> - F6（停止）：运行中停止按钮呈现、结束后消失；点击端到端
>   （按钮 → endFlow → `flow/end {interrupted}` → 投影 `interrupted`）通过。
> - F7（运行中重启恢复）：flow 运行中强杀进程，重启后同 taskId 自动恢复
>   继续迭代（3→6→9）；journal 重放 570 条，投影跨重启稳定。
> - 批次 A/D 写入面：flow/start+step 全程共享 taskId；flow/step 携带
>   `lastJournalSeq`（17→35→50→560）与完整 resume 快照；真实 bash 失败被
>   `lastFailure` 捕获；no-progress 停滞终止真实触发（批次 E 判据）。
>
> **发现并当场修复**
> - 跨窗口投影缺口（本批 B 的缺陷）：活动面板渲染在 follower 聊天窗口，
>   而 journal 投影只存在于 leader（journal store 刻意不跨窗口同步），
>   follower 的面板永远为空。修复：leader 监听投影变化、经 synced action
>   发布快照（`chat.taskRuns`），follower 读快照；内容哈希去重防广播风暴。
>   修复后复验：follower 面板渲染、停止按钮可用。已知限制：follower 的
>   面板活动明细行为空（显示"暂无动态"），完整记录在 journal/devtools。
>
> **未走查**（保持 §9.2 的通过标准要求）
> - F1/F3/F4（投影去重与失败场景）、F8（多窗口 owner 并发）、F9（打包
>   EXE）、F10/F11/F12（大结果、缺 provider、journal 缺口）；批次 E 的
>   升级拦截与截断由单测覆盖，真机未构造。
>
> **工具坑（复现 MODS 记录）**：agent-browser 的 tab/connect 激活层在本机
> 挂死（eval 交互层正常）；CDP fill 非 ASCII 变乱码；Git Bash 把 `#/chat`
> 参数转换为文件系统路径。窗口切换与断言用 `D:/.airi-smoke/cdp-eval.cjs`
> raw CDP eval 完成。
>
> 与本计划改动直接对应的重点场景：
> - F1/F2（投影不重复、Flow 独占推进）：验证批次 B 的活动面板/气泡去重与
>   批次 C 删除 Plan continuation 后无排队的自动续跑。
> - F3/F4（失败摘要、连续失败收敛）：验证批次 E 的失败分类行与 6 次升级
>   拦截、no-progress 终止。
> - F6（停止）：活动面板新增的停止按钮与既有 Esc/stop 路径并行验证。
> - F7（重启恢复）：验证批次 D 的 resume 快照——正常恢复携带原
>   taskId/flowId；provider 被删除时显示 `waiting to resume: …`（flow/end
>   detail），不会静默循环。
> - F12（journal 缺口）：缺口时抑制自动续跑（R1 既有行为）+ 活动面板状态
>   可见。
>
> 真机环境配方沿用 MODS 记录：构建版 electron.exe + 隔离
> `APP_USER_DATA_PATH` + CDP 9250 raw eval（非 ASCII 用
> `.zcode/tmp/cdp-eval-utf8.sh`）。

### 9.1 前置条件

执行前完成以下准备：

1. 使用隔离 userData 目录。
2. 配置一个真实可用的 provider 和 model。
3. 准备一个可修改、可测试的小型 workspace。
4. 准备一个会失败一次再成功的任务。
5. 准备一个需要用户 steering 的任务。
6. 准备一个需要重启恢复的任务。

不得使用用户日常配置作为首次验收环境。

### 9.2 场景清单

| 编号 | 场景 | 必须观察 |
|---|---|---|
| F1 | 单工具读取任务 | chat 与活动投影不重复显示结果 |
| F2 | 多轮修改任务 | Flow 迭代自动推进，Plan 只作裁决 |
| F3 | 工具失败后换路径 | 失败摘要进入下一迭代 |
| F4 | 连续重复失败 | Flow 停止或请求用户介入 |
| F5 | 用户发送 steering | steering 进入下一迭代，旧 done 不吞输入 |
| F6 | 用户点击停止 | 模型流、工具和续跑都停止 |
| F7 | 运行中重启 | 任务恢复或明确显示等待恢复 |
| F8 | 多窗口打开 | 一个 owner 执行，其他窗口只显示投影 |
| F9 | 打包 EXE | 主 renderer、聊天窗口、工具和活动面板可用 |
| F10 | 大型工具结果 | 聊天上下文保持有界，完整结果可读取 |
| F11 | 缺失 provider | 任务进入等待恢复，不产生无提示循环 |
| F12 | journal 缺口 | 自动续跑被抑制，健康状态可见 |

### 9.3 证据要求

每个场景保存：

- journal 片段。
- 任务活动面板截图。
- 必要时保存 provider 请求摘要。
- 结束状态和 Flow 终止原因。
- 失败场景的恢复动作。

截图只证明界面状态。journal 才证明事件顺序和任务身份。

### 9.4 通过标准

- F1–F6 必须全部通过，才能合并控制层改动。
- F7–F8 必须全部通过，才能声明支持重启和多窗口任务。
- F9 必须通过，才能声明桌面端交付可用。
- F10–F12 必须通过，才能声明任务运行时具备生产级边界。
- 任一场景失败都必须登记复现步骤、journal 证据和下一步处理方式。

## 10. 测试计划

### 10.1 单元测试

为以下公共行为添加测试：

- `TaskRun` 从事件序列派生。
- 任务结束后事件窗口正确截断。
- Plan 不再触发独立 continuation。
- Flow continuation 不产生真实用户消息。
- 恢复保留 task、flow、turn 和 journal seq 身份。
- 缺口或配置不一致时禁止自动恢复。
- 失败摘要、重复调用和大型结果保持上限。

### 10.2 集成测试

至少覆盖以下顺序：

```text
user message
  -> flow/start
  -> turn/start
  -> tool/call
  -> tool/result
  -> turn/end
  -> flow/step
  -> next turn
  -> flow/end
```

测试必须同时读取 runtime 状态和 journal 事件。只测试 UI 快照不足以证明循环正确。

### 10.3 命令

按修改范围运行定向测试，然后运行仓库要求的检查：

```text
pnpm exec vitest run packages/core-agent/src/runtime/chat-orchestrator-runtime.test.ts
pnpm exec vitest run packages/stage-ui/src/stores/journal.test.ts
pnpm run typecheck
pnpm lint
```

如果全仓命令因环境问题失败，记录失败命令、首个错误和是否与本批次相关。

## 11. 交给其他模型时的执行规则

1. 先读取本文件、`FLOW-AUTONOMY-PLAN.md`、`HARNESS-PLAN.md` 和 `MODS.md`。
2. 先确认当前工作区的未提交改动，再决定修改范围。
3. 一次只执行一个批次。
4. 先修改公共契约，再修改 runtime，最后修改 UI。
5. 每次修改都添加能证明行为的测试。
6. 不要通过新增兼容分支掩盖旧状态来源不明的问题。
7. 不要把 continuation 写成新的真实用户消息。
8. 不要在 UI 中复制完整 journal。
9. 不要在没有真实 provider 的情况下声称 Electron 场景通过。
10. 每批完成后更新本文件状态和 `MODS.md`。

## 12. 完成定义

本计划完成时，AIRI 必须满足以下条件：

- 一个工程任务有一个稳定的 `TaskRun` 身份。
- Flow、Plan、聊天和 journal 的职责清楚。
- 自动推进只有一个入口。
- 每个工具调用都有结果和任务归属。
- 失败信息帮助下一步决策，并且有界。
- 重启可以恢复，或明确显示需要用户恢复。
- 聊天窗口不会重复展示同一工具活动。
- Electron 组合验收有真实 provider 和可复查证据。

完成这些条件后，AIRI 才具备继续发展长期记忆、连续人格和能力增长的稳定运行基础。
