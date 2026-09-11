# AIRI 跨天目标管理执行计划

## 2026-09-08 验收后代码审查与续批

当前结论：LG 组合验收失败与阻塞均保留。见 [L06](./evidence/short-scenarios/ACC-20260907-01/L06-pause-resume-cancel.md)、
[L02](./evidence/short-scenarios/ACC-20260907-01/L02-workspace-change.md) 和 [登记表](./evidence/short-scenarios/ACC-20260907-01/run-register.md)。

| 承接批次 / 场景 | 判断 | 修改或定位要求 |
| --- | --- | --- |
| LG-2/3；L06 | 可开始修复恢复双入口 | [chat.send](../../packages/stage-ui/src/stores/chat.ts)识别“继续”并调用 resumePlan 后仍进入普通 executeSend。明确长期目标恢复由 scheduler 接管，返回可见反馈；普通对话继续保持独立。一次用户恢复只能启动一个目标管理的 Flow |
| LG-2/3；L02 | 可先加固新鲜度，完整根因待补测 | [checkStartConditions](../../packages/stage-ui/src/stores/modules/long-goals.ts)优先用缓存状态，应在启动前读取 host 最新状态。当前已有切根广播和各窗口 refreshStatus，不能误记为“完全未同步” |
| LG-2/3；L02 | 补测旧根读取来源 | 记录切根广播、leader 刷新完成、目标检查、工具启动与返回时间，核对工具实际参数及执行入口。区分缓存竞态、运行中绑定旧工作区、普通 Flow 绕过调度门；不要静默改写目标授权工作区 |
| LG-2/3；A4、L04/L05 | 代码协调缺口明确，组合恢复仍 BLOCKED | finishRun 仅在 scheduler 的 handleWake 等待链上执行，重启的普通 Flow 恢复未接回目标结算。定义启动协调，按 goalId/taskId/flowId 恢复或中断 activeRun，并结算一次 |
| LG-2；R04 | adoption 接线由 MD-2 主责 | hold 期间 initialize 跳过 listener；解除后必须重新初始化目标 consumer，同进程可唤醒且重复 adoption 不重复注册 |
| LG-1/3；L01/L03/L07 | 证据错误不能靠放宽完成状态解决 | 按 DR-1 续批区分检查语义与步骤归属。对原 journal 复核 gate verdict，文件写对不等于全部目标证据已结算 |

- [ ] 恢复双入口回归通过，再复跑 L06：activeRun/lastRun、文件和 goal 状态一致。
- [ ] L02 在等待、即将启动、已经执行三种切根时点分别检查。
- [ ] R01 可用后补 L04 成功恢复、L05 失败/等待及结算窗口，保留初次 BLOCKED。
- [ ] L06/L07 核对暂停、取消、约束修订和迟到结果不复活旧运行。

短场景不替代 LG-4 真实跨日条件。以下保留原计划与历史执行记录。

日期：2026-09-06。状态：LG-0 至 LG-2 已实施并通过定向测试；LG-3 已有代码路径，待组合验收；LG-4 真实跨天切片尚未运行。
归属：[七维升级总索引](./upgrade-roadmap.md) 方向四。优先级：P1。

## 1. 目标与历史裁决

目标：同一个获授权目标能够等待条件、跨天继续、接收新要求，并在需要时向用户求助。
一次模型循环的恢复，与长期目标的调度是两个责任。

现有 /goal、long horizon 计划、同 id 滚动、持久化和 Flow 提供基础。
[COMMAND](./COMMAND-PLAN.md) Phase E 曾计划通过 life tick 运行工作工具，MODS 也曾记录该批已实现。
后来的 [CONSIDERATION](./CONSIDERATION-PLAN.md) 明确禁止社交考量挂工作工具或推进长期目标。
[TASK-RUN](./TASK-RUN-AND-UI-PLAN.md) 批次 C 又明确 Flow 是唯一自动推进器。

本计划承接长期目标的产品需求，并遵守后两项边界。LG-0 必须先查清旧接线的存留与替代，不能简单记成“从未实现”。

## 2. 旧批次承接

| 原文件与批次 | 处理 |
| --- | --- |
| COMMAND Phase D、/goal 基座 | LG-0/1 复用 long 计划与作用域 |
| COMMAND Phase C | 已被 Flow 唯一推进替代，不恢复 Plan 自动 send |
| COMMAND Phase E；CAPABILITY goal/babysitting | LG-0 至 LG-3 重建清楚的调度责任 |
| LIFE M3 对内面、M4-L3 合流点 | 工作调度与社交表达分工；事件供 SP 消费 |
| reliability-and-roadmap §4.3 | LG-1 至 LG-4 等待、复查、过期与恢复 |
| MEMORY-SEMANTICS §9.3；MEMORY-RETRIEVAL §11.3 | LG-4 跨天工程目标行为切片 |
| FLOW-DIAGNOSIS P2-1 普通对话工具入口 | LG-0 核对入口；普通聊天和 self-initiative 考量分别处理 |

## 3. 拟落实的状态与所有权

以下为待实施契约的行为要求，具体类型名由 LG-1 根据现有定义确定。

| 状态 | 意义 | 可离开的条件 |
| --- | --- | --- |
| 可执行 | 有下一步、执行环境可用、授权仍有效 | 调度成功申请一次运行 |
| 执行中 | 一个 Flow 正为该目标工作 | 本次任务结算 |
| 等待条件 | 外部条件未满足或尚未到复查时间 | 相关事件或到期复查 |
| 等待用户 | 缺信息或需要具体动作批准 | 匹配的问题答案或审批决定 |
| 暂停 | 用户明确暂停 | 用户明确恢复 |
| 已完成、取消或失败 | 已终结，原因和验证状态保留 | 不自动复活；新目标或显式修订另记 |

状态枚举不能混入“结果已验证”的含义，验证结果单独投影。
目标记录保存范围、约束版本、工作区、下次复查时间和待办摘要。凭据从宿主配置解析，不复制到目标记录。
主进程拥有调度时钟和单次运行申请；leader 执行 Flow；其他窗口只读状态并提交命令。
goalId 跨次执行稳定，taskId/flowId 标识一次执行。需要跨会话关联时使用明确关联字段，不按时间窗口猜测。

代码入口：

- packages/stage-ui/src/stores/plans.ts 与 stores/chat/chat-command.ts。
- packages/stage-ui/src/services/memory/local-memory.ts 的计划持久化。
- packages/core-agent/src/journal/types.ts、runtime/chat-orchestrator-runtime.ts、planning/。
- apps/stage-tamagotchi/src/main/services/airi/ 与 src/shared/eventa/index.ts。

调度服务可复用 life-mode 的时钟和持久化模式，但不能调用社交考量来执行工作。

## 4. 实施批次

### LG-0：核对现有 goal 与全部推进入口

前置：DR-0。

1. 追踪 /goal、long 计划、life-mode、notebook、spark 与 Flow continuation 的调用链。
2. 对照 COMMAND Phase E 的旧记录，注明哪些代码保留、删除或被新契约阻断。
3. 区分用户普通聊天的显式工作请求与 self-initiative 社交考量的工具面。
4. 确定一个首批目标：持续跟踪 AIRI 一个有限改进项，先在隔离工作区验收。
5. 调查已有存储和调度原语，记录最小新增边界。

验收：所有能启动工作的入口可列举；任何一次执行只由 Flow 自动推进；社交考量不能启动工作工具。

### LG-1：持久目标与状态转换

前置：LG-0、DR-1/3。

1. 在现有 long 计划与存储边界上定义目标状态、约束版本和运行关联。
2. 通过显式 action 完成暂停、取消、恢复和约束修订，保持单一写入所有者。
3. 每次状态转换记录原因、来源、版本和关联任务，不由 watcher 修复跨字段不变量。
4. 保存待用户问题和复查条件的可序列化数据，不持久化 Promise 或 AbortController。
5. 迁移旧 long 记录时保留身份；缺少执行范围的旧记录进入可见等待状态。

验收：重启恢复同一 goal；session 计划不泄漏；long 可跨会话查看但不借用其他任务的证据。
重复 action 收敛，取消和暂停不被旧快照覆盖。

### LG-2：等待、唤醒与有界执行

前置：LG-1；成本记录与 MD-3 对齐。

1. 为明确到期时间或相关事件安排一次复查，先用便宜条件判断是否需要模型。
2. 主进程原子申请一次目标运行，重复事件、重复唤醒与多窗口不会启动多个 Flow。
3. 启动前检查当前会话、工作区、provider、工具、预算和已有活跃任务。
4. 调用现有 Flow 运行一次有界任务；结算后回写目标状态与下次复查条件。
5. 重启后最多补一次必要的逾期检查，不追赶停机期间全部 tick。
6. 发布有来源的进展或阻塞事件，SP 自行决定是否社交表达。

验收：用户不需要逐轮催促；等待期间不空跑模型；同一目标最多一个活跃 Flow；预算耗尽和环境失效都有可见状态。
目标预算与社交预算分别负责，整体用量由 MD 统计。

### LG-3：新要求、人工接手与过期信息

前置：LG-2、DR-1/2。

1. 将运行中的新要求作为 steering，并更新目标约束版本。
2. 旧版本的异步结果只记录发生事实，不能覆盖新目标状态或结算新要求。
3. 缺信息通过 user_ask 或现有问题通道处理，需要动作授权仍走审批边界。
4. 用户暂停或取消后，停止后续调度；已启动的外部副作用按实际结果记录。
5. 人工接手完成后重新观察工作区，不用一句“做完了”替代要求的工具证据。
6. 条件过期时重新检查，不把昨日的服务可用或测试成功当作今日事实。

验收：插话不会丢失；取消后不会因重启再次执行；回答只匹配所属问题；无效或迟到结果不会复活终结目标。

### LG-4：跨天目标行为切片

前置：LG-3、MQ-2；回顾表达接 PC-2，社交通知接 SP-1/2。

1. 第一天创建目标，完成调查并进入真实可复现的等待条件。
2. 重启应用，保留目标、约束、证据和等待原因。
3. 第二天满足条件，验证只启动一次 Flow。
4. 中途修改要求并进行一次暂停、恢复或人工接手。
5. 检查完成结果、未验证项和引用证据，再检查对共同经历的回顾。

验收：同一 goal 跨天保持身份，单次执行身份独立；不用重新说明全部上下文；她能准确解释做过什么、尚欠什么与为何等待。
记录至少一个失败恢复案例，不以只跑通顺利路径宣告完成。

## 5. 完成定义与执行记录

调度用可控时钟验证，IPC 与 provider 在外部边界模拟，生产数据状态不通过不可能的测试状态制造。
执行规则见 [总索引](./upgrade-roadmap.md)。

- [x] LG-0 旧接线和入口核对完成。
- [x] LG-1 状态、作用域与重启恢复通过定向测试。
- [x] LG-2 等待、唤醒、单次执行和租约恢复通过定向测试。
- [ ] LG-3 插话、取消、人工接手与过期处理通过。
- [ ] LG-4 真实跨天切片完成。

### 2026-09-06 首轮实施记录

- LG-0：核对 `/goal` → `plan_update` → `PlanStore`、普通聊天、社交 self-initiative、现有 Flow continuation、life-mode、journal、notebook/memory 与 spark 入口。保留 Flow 作为唯一自动推进器；社交考量仍只挂 `self_*` 工具。
- LG-1：`PlanSpec` 保存 user/character scope 与 workspace root；`PlanState.longGoal` 保存 lifecycle、constraintVersion、next review、pending question、active/last run 和 transition；`goal/update` 记录每次转换。旧 long 行缺少范围时保留 goalId 并进入可见等待。
- LG-2：新增 Electron 主进程 long-goal scheduler，持久化唤醒时间，发出 startup/schedule/retry wake，并用带过期时间的单租约阻止多窗口重复 Flow。leader renderer 只在会话、范围、workspace、provider、model、工具和已有 Flow 检查通过后启动一次有界 Flow。
- LG-3 初步路径：用户暂停、取消、恢复和 `Run now` 会走显式状态转换；`user_ask`/审批事件可进入 waiting-user；旧 task/flow 结算在 goal 修订、暂停或取消后不会覆盖新状态。
- 已通过：core-agent long-goal authority 6 例、Electron scheduler 4 例、plan tool 11 例、stage-ui plan store 16 例；core-agent、stage-ui、stage-tamagotchi 分包 typecheck 通过。
- 2026-09-07 增量：Electron long-goal scheduler 增加过期 wake 拒绝回归，确认 pending claim 窗口结束后旧唤醒不会重新取得租约；scheduler 定向测试 5 条通过。该契约测试不替代真实跨天停机重启、人工接手与失败恢复组合验收。
- 尚未宣称：LG-3 的约束版本递增、人工接手后重新观察、过期复查和失败恢复仍未完成；LG-4 的真实跨日外部条件、单次唤醒竞争、Postgres、预算成本组合和 PC/SP 回顾表达仍未运行。

环境重查增量（2026-09-07）：长期目标状态保存最近一次接受的 provider、model、workspace 和工具快照。
调度唤醒会比较当前快照；变化会把目标置为可见的 `waiting-condition`。用户执行 `Run now` 时，调度器会重新读取环境并接受新的快照。
core-agent 8 条长期目标契约测试和 stage-ui 18 条计划测试通过。该实现仍不代表 LG-3 组合验收或 LG-4 真实跨天行为通过。

### 2026-09-06 构建版 Electron 局部组合验收

- 使用 `pnpm -F @proj-airi/stage-tamagotchi build` 构建，退出码为 0。关闭旧 Electron 后，使用相同的用户 profile、CDP 9250 和调度端口 6221 重启。没有启动 dev 或隔离 profile。
- 真实 provider 返回 `PROFILE-CHAT-OK`。`/goal` 创建长期目标后，模型使用 `plan_update`、`todo_write`、`read` 和 `list` 完成只读文档调查。目标卡显示步骤、等待原因和文档证据。
- 结束已有 Flow 后执行 `Run now`，目标卡显示“已完成 · 3/3”。重启应用后，目标卡、3/3 状态和文档证据仍在。
- 有界 Flow 运行时的新只读要求在聊天界面留下 `stage.turn.steer-hint`。另一个目标实际进入 `user_ask` 等待；发送“取消”并停止 Flow 后，目标卡显示“已取消”。再次重启后目标仍为“已取消”，没有恢复 Flow 或继续调度。
- 验收初次发现修订规格后目标卡显示 `3/1`。回归测试复现并修复旧步骤完成状态残留；重建并重启后，目标卡显示“已取消 · 1/1”和“已完成 · 1/1”。
- 详细命令、时间线和未覆盖项见 [LG-3 与 LG-4 局部执行证据](./evidence/lg-20260906/lg-execution-record.md)。
- 本次不把 LG-3 或 LG-4 标为完成。constraintVersion 递增、人工接手后重新观察、过期复查、失败恢复和真实跨日外部条件仍待组合验收。
