# AIRI 日用可靠性与任务透明度执行计划

## 2026-09-08 验收后代码审查与续批

当前结论：DR 仍为部分验收。以下新增任务待实施或待定位，不覆盖原失败记录。
证据入口：[ACC 登记表](./evidence/short-scenarios/ACC-20260907-01/run-register.md)。

| 承接批次 / 场景 | 判断与代码依据 | 下一步与关闭条件 |
| --- | --- | --- |
| DR-1；L01/L03 | 可开始修复。[证据门](../../packages/core-agent/src/authority/gate.ts)将描述中的“检查/验证”归为测试执行，却只接受 bash/code_mode/job_output，普通 read 会被拒绝 | 区分文件观察、写入读回与测试执行。先加最小回归，再用原 journal 核对 gate 缺失原因。读回应能证明文件内容，写测试文件不能证明测试通过 |
| DR-1；L01/L03 | 仍需定位叠加原因。[runtime](../../packages/core-agent/src/runtime/chat-orchestrator-runtime.ts)在工具结果返回时重新选择步骤归属 | 对照原 plan spec、planId/stepId、allowedTools、provenance 和 gate verdict，区分语义误判与证据挂错步骤。不能直接清空 unverifiedSteps |
| DR-1；D05 | 拒绝后自动再次申请已由交互复现，但拒绝的主进程副作用门有效 | 关联 requestId、toolCallId、turn 与 Flow iteration，确定重试发生在同次模型调用还是下一轮 Flow，再在相应运行边界阻止未经重新授权的重复申请 |
| DR-1；D05 timeout/late | 先补测。[coding-host](../../apps/stage-tamagotchi/src/main/services/airi/coding-host/index.ts)明确设置 60 秒超时，原验收仅观察 40 秒 | 等待实际超时加观察余量，检查拒绝回执、跨窗口更新、无文件写入和迟到批准无效。没有倒计时不等于没有超时机制 |
| DR-1；D06 | 先定位工具面。[chat store](../../packages/stage-ui/src/stores/chat.ts)的普通聊天按选中项和历史引用组装工具，工作 profile 使用另一套工具面 | 比较普通聊天与显式工作 Flow 的真实 tools 请求。区分 user_ask 未挂载与模型未调用，再决定入口接线或模型行为修复 |
| DR-3；L04/L05 | 仍受备份前置阻塞，不能宣布崩溃恢复通过 | 先完成 MD-1/2 导出入口，再按 LG 续批验证 Flow 恢复与长期目标结算 |

B01 的 `tags` 类型错误已有修复及复测记录，不再列为待修。2026-09-08 审查时根 typecheck 通过。
同次 lint 的失败来自新验收证据与技能产物，处理责任见 MD-0 续批。
以下日期、状态与执行记录保留为历史基线；最新待办以上表及 ACC 登记表为准。

日期：2026-09-06。状态：DR-0 已完成；DR-1/DR-2 已完成真实 provider 的成功、失败、写入、提问和停止局部验收；DR-3 已完成长 journal 扫描、legacy 回放修复和本地恢复回归；DR-4 的 Hashline 前置已触发但 20 文件校准未完成，其余条件未触发。
归属：[七维升级总索引](./upgrade-roadmap.md) 方向一。优先级：P0，DR-4 为条件扩展。

## 1. 目标与基线

让用户能判断当前任务是否在推进、为什么等待、结果是否有证据，以及重启后能否继续。
本计划复用 Flow、TaskRun、Plan 与 journal，不建立第二个任务推进器。

已知基线：

- [TASK-RUN](./TASK-RUN-AND-UI-PLAN.md) A–E 已实施，F2/F5/F6/F7 有真机通过记录。
- F1/F3/F4/F8–F12 尚未走查。follower 活动面板摘要可见，但明细仍可能显示“暂无动态”。
- [可靠性修复](./reliability-and-roadmap-plan.md) R1–R4/R6 有实施记录，R5 仍需组合验收。
- [M-RP](./MODS.md) 已补记忆 checkpoint 与向量迁移，不能继续按“没有关闭路径”排重复修复。
- 当前 TaskRun 把 flow/end 的 done 映射为 completed，未验证细节另存。实施前核对 UI 是否完整表达二者。

## 2. 旧批次承接

| 原计划 | 本计划处理 |
| --- | --- |
| reliability-and-roadmap R5；TASK-RUN F | DR-1/2/3 合并验收，保留原场景编号 |
| FLOW-AUTONOMY 真机清单及 FLOW-KNOWLEDGE 增量 | DR-1/2 验证完成、叙述、插话和知识可达性 |
| ATTENTION §9.1 六条；MAINTENANCE P3.3 | DR-2 验证投影与输入分流 |
| COMMAND A/B/D；WORKSPACE §6 第三、四期 | DR-1 验证审批、提问、会话隔离与人工接手 |
| HARNESS §7 T1–T11、§9.1 | DR-0 保留已完成证据，DR-1/4 补失效场景 |
| LOOP §8 后续 rewind；CODING-HARNESS §2.4；WIRING §7 | DR-4 条件扩展与 Hashline 基准 |
| FLOW-DIAGNOSIS P3-1 环境块后续 | DR-4 核对分支、工作区概览与检查命令 |

旧 LOOP 中“无变更不得 done”的规则已被 FLOW-AUTONOMY 修订。分析任务可以零变更完成，但必须有对应观察与来源。

## 3. 所有权和代码入口

| 所有者 | 入口 | 不变量 |
| --- | --- | --- |
| 执行与结算 | packages/core-agent/src/runtime/chat-orchestrator-runtime.ts | 停止、插话和 done 在明确边界结算 |
| 任务投影 | packages/core-agent/src/journal/task-run.ts、types.ts | taskId、flowId、sessionId、seq 保持关联 |
| 证据裁决 | packages/core-agent/src/planning/ | 执行回执与验证证据分开 |
| 日志落盘 | apps/stage-tamagotchi/src/main/services/airi/journal-host/ | 主进程负责文件；回放不伪造 seq |
| 渲染投影 | packages/stage-ui/src/stores/journal.ts、chat.ts | leader 发布最小快照，follower 不反馈状态 |
| 用户界面 | packages/stage-ui/src/components/scenarios/chat/components/ | 聊天、活动、计划裁决各自承担职责 |

## 4. 实施批次

### DR-0：冻结可复查基线

前置：无。与 MD-0 使用同一构建标识。

1. 为旧验收清单建立场景映射，保留 F、T、L 与 R 的来源编号。
2. 核对当前工作树、dist 和运行产物，避免把不同构建的结果混在一起。
3. 列明已通过、待复验、未执行和相互冲突的记录。
4. 准备测试工作区、隔离 profile、受控 provider 和可恢复的数据库测试数据。

验收：每条后续验收均能指向具体构建与前置配置；历史的“9/11”与逐项通过列表等计数冲突不再直接沿用。

### DR-1：执行、完成、停止与人工接手

前置：DR-0。

1. 实跑纯调查任务、文件修改任务和失败后换方法的任务。
2. 覆盖探活回执、空结果、失败退出码、验证门异常与评审弃权。
3. 复现 done 边界到达插话、用户停止、问题卡关闭、审批拒绝和超时。
4. 核对停止模型流、结算已开始工具、停止后续迭代及后台进程的实际语义。
5. 人工接手后重新检查外部状态；用户回答或签字不能自动证明文件已经改变。

验收：合法调查可完成；失败或缺证据不会显示已验证成功；停止后无新工具启动；插话不被旧 done 吞掉；回答与审批保持不同用途。
每次失败保留最小复现与对应行为回归，只有发现差异才修改已有实现。

DR-1 增量（2026-09-07）：已复现并修复完成评审中弃权、否定批准和驳回被关键词误判为通过的问题。
结构化 verdict 优先，损坏或未知结构化裁决保持弃权。完成门、证据门和运行时共 112 条测试通过，core-agent 已重建。
该结果不代替真实审批拒绝、超时及人工接手组合验收。见 [评审回归证据](./evidence/dr-20260907/reviewer-verdicts.md)。

审批主进程增量（2026-09-07）：命令和计划批准的超时都发布 rejected 回执，显式拒绝取消期限，迟到决定被忽略。
13 条主进程和策略测试通过；尚不代表窗口卡片、journal 和人工接手链路验收。见 [审批结算证据](./evidence/dr-20260907/approval-settlement.md)。

完成门增量（2026-09-07）：验证门现在把最近一次批准请求的 `rejected`、`cancelled`
与仍待决定分别投影为“approval rejected”、“approval cancelled”和“approval required”。
超时沿用主进程发布的 rejected 回执，因此不会伪装成待批准。22 条 evidence-gate 测试通过；
这仍不代替真实窗口卡片和人工接手组合验收。

完成边界补充（2026-09-07）：L1 完成门现在先处理审批等待和失败状态，再处理模型的
`declaredComplete` 声明；因此待审批或失败步骤不能借由 done 声明越过完成边界。core-agent
flow-completion 定向回归 13 条通过；这仍不代替真实审批拒绝、超时和人工接手组合验收。

环境恢复增量（2026-09-07）：长期目标现在保存最近一次接受的 provider、model、workspace 和可用工具快照。
下一次调度会比较快照；provider、model 或工具变化会进入可见等待状态。`Run now` 会在用户接手后重新读取当前环境，并把该环境作为新的观察基线。
journal host 还增加写失败注入边界；9 条定向测试通过，确认失败写入不会推进回执水位，后续重试只写入一次。
普通 Flow 恢复现在复用同一环境检查，比较 provider、model、workspace 和 coding-host 工具集合；Electron renderer 在恢复前刷新 host status，因此缺失或变化会显示为等待原因，不会静默续跑。`flow-resume` 与 chat contract 定向测试 35 条通过，core-agent、stage-ui 和 stage-tamagotchi typecheck 通过。
远端镜像写入失败现在把 remote status 置为 `error`，保留带退避信息的 outbox 项；状态重新报告 `ready` 后立即重试并恢复定时发送。stage-ui memory module 定向测试 24 条通过。
journal host 的去重现在按已落盘 seq 集合执行，并在写入异常后重新扫描文件；因此损坏文件的低序号补洞不会被高序号吞掉，写入成功但回执丢失也不会重复追加。journal-host 定向回归 11 条通过。
聊天历史现在也响应 Escape 停止当前运行中的 TaskRun，并避开输入框自身的取消语义；task activity contract 定向回归 4 条、stage-ui typecheck 通过。窄屏布局和真实键盘链路仍未运行。
打包启动补充：`@proj-airi/skill-forge` 已加入 Electron main 的 workspace alias 与 bundle exclude，修复打包后外置包加载 `./hash` 的 ESM 错误。`@proj-airi/stage-tamagotchi` build 退出码 0；`memory-runtime-smoke.ts --launch --port 9267` 通过并获得 Chrome CDP 版本响应，main SHA-256 为 `7e173eb43b0d3a0770737a66427340310e7153eecf1b7d9a6d40ecde530c5342`。该冒烟未做页面交互、profile 导入或真实 provider。
该代码证据不代替真实 Postgres、断线重连、打包 EXE 或生产故障组合验收。

Postgres 复查补充（2026-09-07）：`DATABASE_URL` 下的 `memory-pgvector` 集成回归 4/4 通过。额外用固定 owner scope（`userId=mq-reconnect-20260907`、`characterId=default`）插入一条带 embedding 元数据的长期事实，关闭客户端后重新连接并按相同 scope 检索，命中同一 `originId`，随后删除清理。该结果证明客户端重连后的持久化和作用域过滤；没有模拟网络断开、自动 outbox 重试或 90 条生产检索。

当前复查命令的结果见 [MQ-0 Postgres 证据](./evidence/mq-0/postgres-integration-20260907.md)。旧的“端口拒绝连接”文字属于 2026-09-06 的历史运行记录，不描述当前 Docker 状态。

### DR-2：用户可见状态与跨窗口活动

前置：DR-0；复用 DR-1 的结算场景。

1. 对任务分别投影执行状态、验证状态和待用户事项，优先扩展拥有这些语义的现有契约。
2. 为 follower 提供按 taskId 查询或发布的有界活动明细；不全量同步 journal。
3. 保持活动窗口以 taskId 和结束边界隔离，不读取后续任务事件。
4. 检查聊天叙述、工具活动和计划裁决的去重，结束任务仍可查看记录。
5. 执行 ATTENTION §9.1 六条，检查进度替换、blocked 提示、logRef 与记忆订阅边界。
6. 检查窄屏摘要、键盘停止和展开后的可读性。

验收：主窗口与聊天窗口表达一致；远端快照不产生本地同步提案；每个投影内同一调用至多出现一次；待验证结果无需打开 devtools 才能理解。

### DR-3：恢复和持久化组合验收

前置：DR-1/2；记忆事实样本由 MQ-0 提供。社交场景复用 SP-0。

1. 在超过 2,000 条事件的任务中重启，核对身份、证据引用、未完成步骤和预算。
2. 分别注入 journal 缺口、损坏行、写入失败与回执丢失，观察退避与恢复结果。
3. 测试 provider 缺失、模型或工具可用性变化、工作区变更时的恢复决策。
4. 记忆写入确认后正常退出及异常退出，重启检查 approved 事实、修订关系与检索结果。
5. 运行真实 Postgres 集成与断线恢复：插入、更新、修订、删除、重试及单 owner。
6. 在可识别的打包 EXE 上复验关键链路，记录安装产物与开发构建的差异。

验收：已确认持久化的数据在对应场景存活；不完整日志不自动续跑；失效环境有可见原因；重试不重复执行副作用或复活旧事实。
不把一次 570 条 journal 恢复通过扩大为所有长日志与故障组合均通过。

### DR-4：有证据后扩展工作可靠性

前置：DR-1 至 DR-3。每个子项独立排期，不阻塞日用基线。

| 子项 | 触发条件 | 交付与验收 |
| --- | --- | --- |
| Hashline 校准 | 有目标模型和真实编辑样本 | 沿用旧 20 文件基准，覆盖 30–5000 行、分页、CRLF、陈旧写；记录拒绝、重读、碰撞和最终 diff |
| 环境摘要 | 重复定位成本在记录中明显 | 从工作区真实状态提取分支、项目结构、检查命令；切根或分支变化后失效；记录前缀变化与成本 |
| rewind | 用户确有回到某次决策的需要 | 先定义会话分支与文件撤销的区别；展示拟恢复差异，检查文件陈旧状态，保持原日志与审阅血缘 |

rewind 不能仅凭 contentHash 恢复旧字节。先核对是否保存了内容或补丁，再决定存储方案。
网络调用、邮件和未知外部副作用不承诺自动撤销。该能力需独立的具体范围与用户决策。

## 5. 验证与完成定义

遵守 [总索引交付规则](./upgrade-roadmap.md)。回归在 owning package 中验证，跨窗口状态变更增加多窗口用例。
真实 provider、Postgres 和 EXE 场景分别记录，不能互相代替。

- [x] DR-0 基线与旧编号映射完成（2026-09-06；代码、构建产物、隔离 Electron profile 与证据目录已登记）。
- [ ] DR-1 执行和结算场景通过（真实 provider 已覆盖调查、失败后换方法、写入验证、user_ask 和停止；审批拒绝、超时、验证门异常仍待补齐）。
- [ ] DR-2 多窗口与用户可见状态通过（TaskRun 有界活动投影、follower 快照和真实生产聊天局部验收已通过；六条 Attention、键盘停止与完整窄屏可读性仍待补齐）。
- [ ] DR-3 恢复、数据库与 EXE 组合场景通过（长 journal 扫描和 legacy header 回放修复已通过；真实 Postgres 集成 4/4 于 2026-09-06、2026-09-07 Docker 复查通过，并完成客户端关闭/重连后的持久化 scope 复查——见 MD-0 基线证据与 MQ-0 接线证据；journal 写失败回归和长期目标环境快照已接线，但网络断线/outbox 重试、provider 变更与可识别打包 EXE 仍待补齐）。
- [x] DR-4 条件核查完成（Hashline 因目标模型和一次真实写入样本已触发；20 文件校准未完成，环境摘要与 rewind 条件未触发，均暂缓）。

DR-0 至 DR-3 完成后，可进入 MD-4 的日用观察。DR-4 不作为基础完成的硬门。
历史首条执行记录：2026-09-06，仅编写计划，未复跑本文件场景。

## 6. 本次执行记录（2026-09-06）

- 批次：DR-0、DR-2 局部；DR-1 仅完成 owning package 回归与既有实现核对。
- 代码标识：工作树基于 `13c8edc2164980f53f4ea86a275155f8cd3df929`；本次 Electron 构建为 `apps/stage-tamagotchi/out`，main bundle SHA-256 为 `2dbccc179882c0f70aa4fccac7576a7139e17607d8e77f4ff6f8a1feef4ec3e7`，renderer `index.html` SHA-256 为 `b6975aacf8873e952d289c5944f7930fd8756eb9647d778b8695c906f6176f32`。
- 运行端：Windows；stage-tamagotchi 构建版 Electron；独立 userData 与 CDP 端口 9251。测试后已停止隔离进程并删除临时 userData，保留日志与截图。
- provider/model：未使用。Electron 冒烟通过 Pinia journal 的受控事件输入，不连接真实 provider、Postgres 或用户数据。
- 测试数据与 journal 范围：`sessionId=dr-session`、`flowId=dr-flow`、`taskId=dr-task`；包含 session header、user message、flow start/end、assistant narration、一次 tool call/result，活动行包含 narration、tool-call、tool-result；核心活动窗口上限为 40 行。
- 预期：leader 发布的单任务有界活动快照可被 follower 按 `taskId` 接收；follower 不读取全量 journal，也不产生本地同步提案；结束任务仍能查看活动摘要。
- 实际：core-agent 回归确认活动按 taskId 和 flow 边界隔离并截断到 40 行；两个 Electron 窗口的 follower 收到完整活动数组，页面显示 `Read the project guide`、`已完成 · 1 次工具调用`；agent-browser 截图、Vishot 直接窗口截图和运行日志见 [DR 执行证据](./evidence/dr-20260906/dr-execution-record.md)。本次冒烟的 console/error 队列无新增输出。
- 未覆盖：真实 provider 的调查、修改、失败恢复、停止、审批、提问和超时；ATTENTION 六条、键盘停止、完整窄屏展开可读性；超过 2,000 条事件重启、journal 缺口/损坏/写失败/回执丢失；provider/model/tools/workspace 变更恢复；真实 Postgres 及断线恢复；可识别打包 EXE；DR-4 Hashline、环境摘要和 rewind。

验证命令的逐项退出码、环境失败和未运行项见 [DR 执行证据](./evidence/dr-20260906/dr-execution-record.md)。

## 7. 继续执行记录（2026-09-06）

- 运行端：重建后的 stage-tamagotchi production Electron，默认用户 profile，CDP 9250；实例已重启并保持运行。当前 provider/model 为 `openai-compatible` / `gemini-3.8-flash`，未记录任何密钥或连接凭据。
- DR-1 真实 Flow：只读读取路线图成功；不存在文件的读取按预期返回 ENOENT；受控 probe 先读失败，再写入并读取验证，最后 `flow_update(done)`。probe 文件内容精确匹配 `DR1-WRITE-PROBE-20260906`，SHA-256 为 `A455FA880D9299EB841525EC62EFF27654FF8B90FA147DE0F82AA91B6E6F15FD`，证据文件见 [probe](./evidence/dr-20260906/dr1-write-probe.md)。
- DR-1 人工接手与停止：真实 `user_ask` 问题卡显示并收到回答；另一次在问题等待中停止心流，journal 记录 `flow/end(interrupted)`，停止后没有新的工具调用，关闭问题卡后无遗留等待项。
- DR-2 任务投影：production follower 聊天窗口显示真实 `read`、`write`、`flow_update` 活动；从 journal 重新派生的最新 TaskRun 为 `completed`，标题对应本轮命令，活动为 28 行并以 `completion-review` 收尾。修复后的 follower 截图见 [after-fix](./evidence/dr-20260906/follower-task-activity-after-fix.png)。
- DR-3 重启与持久化：重启后的主窗口和 follower 正常恢复；最新日志没有 `seeded event seq` 或 replay suppression 警告。用户 profile 中最大的现存 journal 文件有 3,308 行、最高 seq 3,113，无缺口、损坏行或未编号行，但含 195 条重复 seq，仍不能宣布所有历史文件健康。
- DR-3 数据库边界：`127.0.0.1:5435` 当前拒绝连接；本机没有可用的 `psql`/`postgres` 命令，Docker daemon 也未运行，因此真实 Postgres 插入、更新、修订、删除和断线恢复未执行。memory-core 32/32、memory-pgvector 单测 5/5 通过，4 个 Postgres integration 测试跳过。
- DR-4：目标模型和一次真实写入样本已满足 Hashline 校准前置，但尚未具备旧计划要求的 20 文件、30–5000 行、分页、CRLF、陈旧写和碰撞统计；环境摘要没有重复定位成本证据，rewind 没有用户回退决策需求，均暂缓。

未完成项仍包括审批拒绝、超时、验证门异常、ATTENTION 六条、键盘停止、完整窄屏可读性、journal 缺口/损坏/写失败/回执丢失、provider/model/tools/workspace 变更、真实 Postgres、打包 EXE 和 DR-4 Hashline 20 文件校准。上述真实生产运行不把局部成功扩大为 DR-1 至 DR-3 完成。
