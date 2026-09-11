# 七维升级基本排查记录

日期：2026-09-07。范围：当前工作树的七维升级及其恢复、调度、记忆、技能接线。
性质：代码与已有回归排查。没有修改产品代码，没有执行真实 provider 任务或改动日用 profile。

本轮结论：已有契约回归较完整，但不能据此宣布七维升级全部验收。
定向测试共 65 个文件、555 项通过。全仓 lint 通过，存在警告。
类型检查确认一处桌面包编译错误。恢复和长期目标还存在需要优先处理的接线缺口。

## 1. 基线与检查边界

HEAD 为 `13c8edc21`，本轮升级主要留在未提交工作树中。
检查期间 `git status --short` 有 192 条记录，包含新执行文件和证据目录。
因此，历史提交和旧构建通过记录不能代替当前工作树结果。
以下结论针对本次读取和运行时的文件；后续改动需要重新核对相关结论。

阅读范围包括 [总索引](./upgrade-roadmap.md)、七份执行文件、[魔改记录](./MODS.md)、
[观察前置核查](./observation-readiness-execution.md)，以及它们引用的近期执行证据。
代码重点覆盖 core-agent 的完成门与 journal、memory-core 的有效性与作用域、
stage-ui 的聊天和状态 owner，以及 Electron 的 scheduler、backup、coding、journal 和 memory host。

| 检查 | 本轮结果 | 边界 |
| --- | --- | --- |
| `pnpm typecheck` | 内存不足退出 | 根脚本并行运行，不能记通过 |
| 同范围串行 typecheck | 桌面包 TS2353，见 A1 | 首错停止，不能记全仓通过 |
| `pnpm lint` | 最终退出 0 | 存在既有源码和 `.zcode/tmp` 警告 |
| core-agent、memory-core 与五类 Electron host 定向测试 | 45 文件、377 项通过 | 包含 long-goal、data-backup、life-mode、journal-host、coding-host |
| stage-ui 记忆、计划、技能、恢复等 Node 回归 | 11 文件、113 项通过 | 不代表外部模型行为 |
| stage-ui chat contract、journal、mirror、consciousness settings | 4 文件、55 项通过 | 聊天接线与投影契约 |
| stage-ui 浏览器回归 | 5 文件、10 项通过 | 备份 owner、真实 DuckDB、技能、工具和设置 |
| `git diff --check` | 退出 0 | 仅覆盖 Git 已追踪差异；有换行转换提示 |

浏览器运行出现 DuckDB 依赖 sourcemap 警告，测试仍通过。
一次临时技能程序构造检查也通过，临时脚本已移除，没有留下产品改动。
本轮未重新构建安装包，未重新执行 PostgreSQL 集成测试，未启动真实用户行为切片。
历史证据中的 PostgreSQL 4/4、打包恢复和 MQ 90 条合成样本属于已有记录，不计入本轮 555 项。

## 2. 需要处理的问题

### A1 / P1：memory-host 当前不能通过类型检查

证据等级：命令已复现。

[memory-host](../../apps/stage-tamagotchi/src/main/services/airi/memory-host/index.ts) 第 216 行传入
`{ ...params, tags: [] }`。同文件的 `MemoryHostConnection.repository.insert` 却声明接收
`MemoryHostInsertParams`，该 IPC 类型没有 `tags`。

串行类型检查报告：

```text
src/main/services/airi/memory-host/index.ts(216,70): error TS2353:
Object literal may only specify known properties, and 'tags' does not exist in type 'MemoryHostInsertParams'.
```

影响：当前桌面包检查失败，旧构建通过记录无法作为此次交付依据。
修复应核对 repository 的实际入参类型与 IPC 投影边界，避免再用本地接口模拟外部契约。
承接：DR-0、MD-0。

### A2 / P1：dreaming 绕过用户和角色作用域

证据等级：静态调用链确认，尚未执行真实跨角色模型场景。

[memory store](../../packages/stage-ui/src/stores/modules/memory.ts) 的 `dream()` 调用
`memoryRepository.list({ limit: 1_000 })`，没有传入 scope。
[selectDreamSourceFragments](../../packages/memory-core/src/dream.ts) 过滤事实类型和有效状态，但不筛选主体。
[chat store](../../packages/stage-ui/src/stores/chat.ts) 的 `generateDreamProposals()` 随后把候选内容发送给当前配置的模型。
现有 dream idea 读写也没有用户和角色分区。

触发条件：同一个 profile 有多个用户或角色的有效事实，且 dreaming 开启。
影响：普通检索已建立的主体隔离在 dreaming 输入路径失效，其他角色的事实可以成为当前想法的素材。
这不是已确认的“自动发言泄漏”；本轮确认的是模型输入与想法归属缺少隔离。

下一步需把 scope 从运行时传给 dreaming，并核对 idea 的归属、查询与历史无 scope 记录规则。
回归应使用两个角色的不同事实，直接检查 dream agent 收到的输入，而不只检查最终文案。
承接：PC-0/2、MQ-2、SP-1。

### A3 / P1：恢复副本解除冻结后，长期目标调度器没有重新启动

证据等级：静态启动与事件调用链确认，尚未执行带非空目标的打包恢复。

[long-goals store](../../packages/stage-ui/src/stores/modules/long-goals.ts) 的 `initialize()`
在 `areRestoreEffectsHeld()` 为真时直接返回，没有安装 wake listener。
[renderer main](../../apps/stage-tamagotchi/src/renderer/main.ts) 在启动时调用一次该方法。
[adoption listener](../../apps/stage-tamagotchi/src/renderer/bridges/coding-host-install.ts)
解除 hold 后只调用技能 `restore()`，没有重新初始化长期目标调度器。

触发条件：恢复副本首次启动，随后在数据页面解除冻结，保持应用运行。
影响：当前进程仍然没有长期目标 wake consumer。即使 `Run now` 写入了到期计划，也没有该 consumer 接收执行。
再次启动应用可以走正常初始化，但界面动作没有要求这次重启。

下一步需由明确 owner 在 adoption 后恢复调度，并验证重复 adoption 不重复安装 listener。
需要覆盖 leader 和已有 follower，不能只检查 hold 布尔值变成 false。
承接：MD-2、LG-2。

### A4 / P1：运行中重启后，Flow 恢复没有接回长期目标结算

证据等级：静态生命周期调用链确认，需故障注入复现最终 UI 和落盘状态。

[long-goals store](../../packages/stage-ui/src/stores/modules/long-goals.ts) 仅在 `handleWake()`
内部等待 `chat.send()` 后调用 `finishRun()`，并在内存中保存 `runningGoalId`。
进入 `running` 后，[状态契约](../../packages/core-agent/src/authority/contract.ts) 删除 `nextReviewAt`，
[调度桥](../../packages/stage-ui/src/services/long-goal-scheduler.ts) 取消主进程日程。

进程重启后，持久计划仍有 `running/activeRun`，但原来的等待调用与 `runningGoalId` 已丢失。
启动同步会继续取消 running 目标的日程。
renderer main 确实会通过 `resumeFlowAfterRestart()` 恢复普通 Flow，不能把这里误报为“Flow 完全不恢复”。
缺口是这条恢复路径没有重新关联长期目标的 `finishRun()`，journal watcher 也依赖空的 `runningGoalId`。

影响：即使恢复后的 Flow 结束，长期目标仍可能停在 running，缺少下一次复查或终结结算。
下一步需在启动时对 activeRun、journal 和可恢复 Flow 做一次显式协调。
无可恢复执行时，应记录等待或中断原因。可恢复执行结束后，应按原 taskId/flowId 结算一次。
承接：DR-3、LG-2/3/4。

## 3. 已知未完成项与追踪问题

以下不算本轮新发现的已完成批次回归，仍会影响下一轮验收。

| 项目 | 当前边界 | 下一步 |
| --- | --- | --- |
| 自定义技能恢复工作区 | `prepareRestoreProfile()` 将产物复制到新 workspace，但 `restoreQueue()` 保留旧 workspaceRoot；源码复核会因工作区不一致而阻止使用 | MD-2 已明确记录此项未完成。定义新工作区绑定和复核动作，使用非内置技能验证 |
| buildId 不能区分同位置的重建产物 | backup host 只哈希 `app.getVersion()` 与 `app.getAppPath()` | 同版本、同位置更换代码后值不变。MD-0/2 需补实际产物或构建内容标识 |
| 文档页首与增量记录不同步 | MD 页首仍写 MD-1 至 MD-4 尚未执行，正文已记录 MD-1/2 实施与打包验证 | 保留“代码实施 / 契约通过 / 组合验收 / 长期观察”四种状态，更新页首入口 |
| 社交旧活动过期 | plan、tool、task 候选的 `occurredAt` 为 0，过期过滤只处理正时间 | SP-0/2 加入旧 journal 重启样本，检查是否把旧活动作为新刺激 |
| snapshot 一致性 | barrier 拦截指定 store action，部分 owner 还有直接状态变更和异步 IO | MD-1/2 用非空 outbox、后台 flush、设置变更竞争检查跨 owner 一致性 |

## 4. 七个方向的验收判断

| 方向 | 基本排查判断 | 仍需的关键验证 |
| --- | --- | --- |
| [DR 日用可靠性](./daily-reliability-plan.md) | 完成门、审批、journal 和恢复环境已有回归；当前编译失败及 A4 需处理 | 审批拒绝/超时、断线 outbox、强制退出、六条 Attention 与键盘停止 |
| [MQ 记忆质量](./memory-quality-plan.md) | scope、事实状态、双路召回和 trace 已接入；合成基线不代表真实语义收益 | 真实事实纠正、过期事实、跨角色、真实 embedding 与断线重连 |
| [PC 人格连续性](./persona-continuity-plan.md) | 普通行为检索有主体隔离；A2 是独立旁路 | PC-3 新会话、换角色、重启、工作/社交切换；PC-4 长期观察 |
| [LG 长期目标](./long-horizon-goals-plan.md) | 状态与 scheduler 契约通过；A3/A4 尚未闭合 | LG-3 插话/接手/失效条件，LG-4 真实跨日失败恢复 |
| [SP 社交与在场](./social-presence-plan.md) | 决策协议、门控、临时视觉生命周期有代码与回归 | SP-0 的 20 刺激推广门、旧活动、用户忙碌竞争、SP-4 共同活动 |
| [SG 技能成长](./skill-growth-plan.md) | 审核哈希、源码检查、跨窗口和 hold 回归通过 | SG-2 实用技能三种输入、失败、实际收益与重启；非空技能恢复 |
| [MD 维护与数据](./maintainability-and-data-plan.md) | ZIP 检查与真实浏览器 owner 回归通过；整体恢复仍有接线缺口 | 非空技能/outbox/目标一起恢复、adoption、内容可识别产物、7/30 天观察 |

## 5. 下一轮验证讨论顺序

1. 先修 A1，并明确 A2 至 A4 的 owner 和验收结果。随后固定一次可识别构建。
2. 先做恢复组合：带事实修订、非空 outbox、自定义技能、等待目标和 journal 来源链的副本。核对冻结前后、重启前后每个 owner。
3. 再做任务故障组合：审批等待、运行中强制退出、恢复后条件变化、人工接手和迟到结果。检查 goal、Flow、task 与证据一致。
4. 再做真实语义行为：纠正一个事实、切换角色、回顾共同经历、20 个社交刺激。同时记录模型输入来源和用户实际看到的行为。
5. 通过短场景后进入 7 天观察，再进入 LG-4/PC-3 与 30 天观察。模拟时钟只验证调度，不替代真实跨日体验。

每个场景保留：构建标识、profile、provider/model、前置数据、触发动作、预期结果、journal/数据库证据和实际结果。
失败需要指出是召回、事实状态、执行、恢复接线还是表达问题，避免只记录“回答不理想”。

## 6. 本轮命令

```powershell
pnpm typecheck
pnpm -r --workspace-concurrency=1 -F "./packages/*" -F "./apps/*" -F "./server/**" -F "./docs" --if-present typecheck
pnpm lint
git diff --check

pnpm exec vitest run packages/core-agent packages/memory-core apps/stage-tamagotchi/src/main/services/airi/long-goal apps/stage-tamagotchi/src/main/services/airi/data-backup apps/stage-tamagotchi/src/main/services/airi/life-mode apps/stage-tamagotchi/src/main/services/airi/journal-host apps/stage-tamagotchi/src/main/services/airi/coding-host --maxWorkers=1 --no-file-parallelism

pnpm exec vitest run --config packages/stage-ui/vitest.config.ts --project node src/services/data-backup.test.ts src/services/data-restore.test.ts src/services/restore-gate.test.ts src/services/flow-resume.test.ts src/services/memory/evaluate-chinese-memory.test.ts src/services/memory/local-memory.test.ts src/stores/plans.test.ts src/stores/skills.test.ts src/stores/modules/memory.test.ts src/stores/modules/life-mode.test.ts src/stores/chat.test.ts src/stores/modules/consciousness.test.ts

pnpm exec vitest run --config packages/stage-ui/vitest.config.ts --project node src/stores/chat.contract.test.ts src/stores/journal.test.ts src/stores/mirror-visual.test.ts src/stores/modules/consciousness-settings.test.ts src/composables/use-data-maintenance.test.ts

pnpm exec vitest run --config packages/stage-ui/vitest.config.ts --project browser src/stores/data-backup.browser.test.ts src/stores/skills.browser.test.ts src/stores/ai/chat-llm/tools.browser.test.ts src/stores/modules/consciousness-settings.browser.test.ts src/composables/use-duck-db-snapshot.browser.test.ts --maxWorkers=1 --no-file-parallelism
```

两个 Node 命令中的 `chat.test.ts` 和 `use-data-maintenance.test.ts` 没有匹配文件，
其结果不能解释为对应文件通过。聊天实际覆盖来自第二组的 `chat.contract.test.ts`，
数据恢复实际覆盖来自 service 和 browser owner 测试。
曾尝试不加目录过滤的串行检查，它进入 Godot 并因缺少 .NET SDK 失败。
此后改为根 typecheck 的相同目录范围；Godot 环境不属于 A1 的代码错误。

关键源文件 SHA-256（报告写入时复核）：

| 文件 | SHA-256 |
| --- | --- |
| `apps/stage-tamagotchi/src/main/services/airi/memory-host/index.ts` | `1071452EA0B07F59CD0949069D8DD5A3D39A4D21429C04F8C1DAD0DAB2EE0FB2` |
| `packages/stage-ui/src/stores/modules/memory.ts` | `19856FE2F975911E6BC8535ADFB50378E98FBA6EC1AD5C0B22D89C5D76056CE2` |
| `packages/stage-ui/src/stores/modules/long-goals.ts` | `011836F23BD414EA8CF1D8C631C8C0DEC413AB5D5F5D310734C4C7BAB8ABE8AB` |
| `apps/stage-tamagotchi/src/renderer/bridges/coding-host-install.ts` | `370A1AD55C16AE42B57146AAD16FC680450C04FA4DFB8757556C7D16AA7C0818` |
