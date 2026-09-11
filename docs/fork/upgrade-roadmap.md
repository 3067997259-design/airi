# AIRI 七维升级执行总索引

## 2026-09-08 最新验收与修复入口

已实施首批七项修复，并补上设置页目录提交的结构化克隆边界，见 [修复记录与剩余验证顺序](./acceptance-repairs-20260908.md)。
当前构建已用原用户 profile、provider 和 CDP 9250 重启；只有已取得运行证据的 R01/K02 子流程更新状态，其他场景不随代码修复自动转为 PASS。

ACC-20260907-01 已结束执行，62 个场景为 22 PASS、18 FAIL、22 BLOCKED，无 NOT-RUN。
执行完成不代表产品通过。原始结果保留在 [登记表](./evidence/short-scenarios/ACC-20260907-01/run-register.md)。
验收后的代码审查已补回以下原批次；首批实施结果以上述修复记录为准，真实运行补测仍待执行：

| 优先方向 | 原文入口 | 可开始修复 | 先补测定位 |
| --- | --- | --- | --- |
| 导出与恢复 | [MD-1/2](./maintainability-and-data-plan.md) | leader 注册备份 owner、adoption 后启动目标调度 | 非空一致性、恢复副作用、R06 后端 |
| 新会话空回答 | [MQ-0/2](./memory-quality-plan.md) | 先补阶段取证 | 检索等待、provider 输出、解析与消息显示 |
| 长期目标 | [LG-2/3](./long-horizon-goals-plan.md) | 恢复双入口、启动协调、执行前新鲜度 | 旧根读取来源、崩溃结算窗口 |
| 证据与审批 | [DR-1](./daily-reliability-plan.md) | 区分文件检查与测试执行证据 | 步骤归属、拒绝重试边界、60 秒超时、user_ask 工具面 |
| 技能审阅 | [SG-1](./skill-growth-plan.md) | 源码/自测查看、批准绑定已查看哈希 | K03–K07 等审阅前置完成 |
| 社交 | [SP-0/2](./social-presence-plan.md) | 有界跨轮去重 | 迟到 speak、静默时段及环境阻塞变体 |
| 主体隔离 | [PC-0/2](./persona-continuity-plan.md) | dreaming 输入和 idea 归属 | M04 正向召回、M08 公开入口与跨用户变体 |

首批优先解除导出、审阅入口阻塞，并修复恢复双入口与社交去重；MQ 阶段定位可独立推进。
代码审查时 typecheck 通过；验收产物引入的 lint 错误归 MD-0，不能改写原始证据字节掩盖。
以下为原路线与历史状态，阅读时以上述增量和各文件续批为准。

日期：2026-09-06。
状态：DR-0 已完成；DR-1/DR-2 已完成真实 provider 局部验收与任务投影修复；DR-3 已完成长 journal/legacy 回放局部验收；DR-4 Hashline 校准前置已触发但尚未完成；MQ-0 已完成隔离本地 profile 的 Electron renderer 合成基线，外部 provider/真实用户事实仍待执行；PC-0 至 PC-2 已实施，真实行为验收待执行；LG-0 至 LG-2 已实施，LG-3 待组合验收，LG-4 未运行；SP-1/2/3 代码、统一构建与基础生产 UI 验收已完成，SP-0 推广门和 SP-4 行为切片待真实场景。
基线：当前本地工作树与 MODS 的 M-RP 记录，包含尚未提交的改动。
范围：以 stage-tamagotchi 为首个验收端，复用共享包，逐步验证 Web 与移动端适用的能力。

## 1. 产品目标与裁决依据

目标：让她能跨天记住并推进一件真实的事，也能准确讲述与用户共同经历的事情。

上游的陪伴愿景见 [DreamLog 0x1](../content/zh-Hans/blog/DreamLog-0x1/index.md)。
分支的约束见 [设计总纲](./DESIGN-PRINCIPLES.md)：证据优先、上下文有界、能力增长可审阅、规模可维护。
本系列把这些目标拆成可交接的实施批次。它不把设计目标记为已验收能力。

七个方向共同构成路线。任务可靠性不能替代陪伴体验，主动表达也不能替代工作证据。
沿用现有 journal、Flow、Plan、memory、character 和 skill-forge 边界，先搜索已有实现，再确定新增代码。

## 2. 执行文件与职责

| 方向 | 执行文件 | 批次编号 | 负责的结果 |
| --- | --- | --- | --- |
| 可靠日用与任务透明度 | [日用可靠性](./daily-reliability-plan.md) | DR-0 至 DR-4 | 组合验收、任务状态、恢复与证据 |
| 记忆语义质量 | [记忆质量](./memory-quality-plan.md) | MQ-0 至 MQ-4 | 生产链路评估、多视图事实、纠正和检索质量 |
| 人格与关系连续性 | [人格连续性](./persona-continuity-plan.md) | PC-0 至 PC-4 | 身份、偏好、情绪、共同经历与跨天表达 |
| 跨天目标管理 | [跨天目标](./long-horizon-goals-plan.md) | LG-0 至 LG-4 | 目标等待、唤醒、执行、取消与恢复 |
| 主动交流与共同活动 | [主动交流](./social-presence-plan.md) | SP-0 至 SP-5 | 社交决定、时机、语音、视觉与共同活动 |
| 能力持久积累 | [技能增长](./skill-growth-plan.md) | SG-0 至 SG-4 | 技能恢复、复用、修订和外部执行器 |
| 单人维护与数据所有权 | [维护与数据](./maintainability-and-data-plan.md) | MD-0 至 MD-4 | 可识别构建、导出恢复、成本与维护 |

DR 的组合验收汇总其他方向的证据，不复制它们的实现任务。

短场景统一执行入口：[七维升级短场景交互验收计划](./short-scenario-acceptance-plan.md)。
该文件使用带现有用户 profile 的构建版 Electron、CDP 和 agent-browser，包含 62 个场景的输入话术、预期回答和证据判据。
状态为待执行，不替代各方向的实施记录或真实跨日观察。

MQ 拥有事实有效性，PC 消费有效事实，SP 消费有来源的社交刺激。
LG 拥有跨次执行的调度责任，Flow 仍是一次任务执行的唯一自动推进器。
SG 拥有技能审阅与激活，MD 负责保存和迁移这些数据的整体方案。

## 3. 状态与历史解释规则

| 状态 | 含义 |
| --- | --- |
| 已实施，待验收 | 有代码或后续实施记录，但所需组合场景证据不足 |
| 部分验收 | 只列出确有记录的场景，其余仍待执行 |
| 待实施 | 本系列安排的新增工作，尚无完成证据 |
| 待核对 | 旧记录相互冲突或当前接线尚未查清，先调查再决定工作量 |
| 条件启用 | 保留方向，只有批次前置条件成立才实施 |
| 已替代 | 保留历史动机，按后来的契约执行 |
| 已取消 | 不再安排实施，除非用户明确改变方向 |

阅读顺序：当前代码和对应运行证据 → 明确的后续裁决 → 对应批次实施记录 → 原始设计。
代码说明当前行为，不自动证明它符合目标。过时的页首状态和未勾选清单不能推翻后续记录。
冲突仍无法解释时，记录冲突与受影响批次，不自行宣布任一方案通过。

每个新批次只有一个主归属。其他文件引用该编号，不另造相同功能的实施批次。
旧文件保留历史，新系列负责后续调度。完成后同时更新新批次、原文件对应状态和 [MODS](./MODS.md)。

## 4. 旧计划批次承接表

以下是 2026-09-06 的交接快照，原章节标题和编号用于定位。
“承接”不表示整篇旧计划尚未实现，也不表示本轮重新运行了历史验收。

| 原文件与明确批次 | 当前解释 | 后续归属 |
| --- | --- | --- |
| [短期可靠性](./reliability-and-roadmap-plan.md) §2 R1–R4、R6 | 已有修复记录，保留回归；不重复实施 | DR-0、DR-1 |
| 同文 §2 R5、§3 完成定义 | 组合验收仍待补齐 | DR-1、DR-3 |
| 同文 §4.1–4.6 | 六条长期方向展开为本系列七维 | MQ、PC、LG、SP、SG、MD |
| [任务运行时](./TASK-RUN-AND-UI-PLAN.md) 批次 A–E | 已实施；Flow 唯一推进器是当前边界 | DR-2、LG-0 复用 |
| 同文批次 F | F2/F5/F6/F7 有通过记录；F1/F3/F4/F8–F12 待走查 | DR-1、DR-2、DR-3 |
| [记忆检索与持久化](./MEMORY-RETRIEVAL-AND-PERSISTENCE-PLAN.md) A/B/C/E | M-RP 已实施；生产评估接线与完整验收另核对 | MQ-0、DR-3 |
| 同文批次 D：多视图内容 | 明确未实施 | MQ-1 |
| 同文批次 F：reranker | 明确未实施，须实验支持 | MQ-3，条件启用 |
| 同文 §11.1–11.5 | 记忆、人格、跨天目标、生命模式、能力增长 | MQ、PC、LG、SP、SG |
| [记忆语义纠偏](./MEMORY-SEMANTICS-CORRECTION-PLAN.md) A–D、E | 实施与行为切片已有记录；组 B/C 有通过记录，噪声项部分通过 | MQ-0、MQ-2 回归 |
| 同文 §9.1–9.5 | 后续方向继续有效；嵌入模型已换用新来源，不能按早期约束重做 | MQ、PC、LG、SP、SG |
| [记忆设计](./MEMORY-DESIGN.md) §10 第一期至第四期 | 压缩、抽取、情绪与反射已有接线；行为质量仍需评估 | MQ-2、PC-2、SP-1 |
| 同文 §10 dreaming、长期同步与真实模型验收 | 有代码与部分记录，后台和断线长跑待验证 | SP-1、DR-3、MQ-0 |
| [社交考量](./CONSIDERATION-PLAN.md) 批次 0–4 | 已实施，保持显式 self_decide 契约 | SP-0 复用 |
| 同文批次 5、§16 | Electron、三种决定、20 刺激行为试验待完成 | SP-0 |
| [生命模式](./LIFE-PLAN.md) M1/M2/M3 | mirror、外观事件、心跳已有实现；M3 社交契约由 CONSIDERATION 修订 | SP-0、SP-3、PC-1 |
| 同文 M4-L0 | 观测期 | SP-0、SP-1 |
| 同文 M4-L1 | 记忆分享；只使用有效事实和有来源刺激 | SP-1，依赖 MQ-2 |
| 同文 M4-L2 | 作息与在场判断 | SP-2 |
| 同文 M4-L3 | 多源真实经历和里程碑分享；不恢复社交 tick 执行工作 | SP-4、LG-2 |
| [命令计划](./COMMAND-PLAN.md) Phase A/B/D | 审批、提问、会话边界已有实施记录 | DR-1、LG-0 回归 |
| 同文 Phase C | 旧 Plan 自续跑已被 TASK-RUN 批次 C 替代 | LG-0；不恢复旧入口 |
| 同文 Phase E；[能力计划](./CAPABILITY-PLAN.md) goal/babysitting | MODS 曾记 E 已实现，后续社交契约排除工作工具；须核对残留接线 | LG-0 至 LG-3 |
| [能力计划](./CAPABILITY-PLAN.md) @ 引用、skill 上拉栏 | 后续 COMMAND 和 MODS 已记录实现 | DR-0 核对，不重新立项 |
| 同文自造工具三齿与毕业考 | submit/自测/通知及反转文本示例已有记录；实用收益未等同通过 | SG-0、SG-2 |
| 同文 dsh 内容插件适配 | 2026-08-30 明确放弃；旧顺序中的适配和样本调查不再排期 | SG-4 记录取消 |
| [自造工具设计](./SELF-AUTHORED-TOOLS-DESIGN.md) §8 第二期、第五期 | 沙箱自测、muscle 激活与 dream 修订已有后续接线；恢复与停用传播需核对 | SG-0、SG-1、SG-3 |
| [编码 Harness](./CODING-HARNESS-DESIGN.md) §10 第五期 | opencode 代劳层已有骨架，实际委派验收需独立证明 | SG-4，条件启用 |
| 同文 §2.4；[维护计划](./MAINTENANCE-PLAN.md) P3.2；[接线清单](./WIRING-BACKLOG.md) §7 | 20 文件 Hashline 基准仍待校准 | DR-4 |
| [注意力设计](./ATTENTION-DESIGN.md) §9 第一期至第四期 | 首版已实现，不能按早期“没接 UI”重写 | DR-2、SP-2 复用 |
| 同文 §9.1、§10.5；维护计划 P3.3 | 六条验收与其他长任务生产者迁移 | DR-2、SP-4 |
| [Harness 计划](./HARNESS-PLAN.md) §7 T1–T11、§9.1 | 有后续验收和修复；journal、只读 task、diff 摘要已实现 | DR-0、DR-1、DR-4 |
| 同文 §9 maintenance 相位 | 后续可选；先测压缩延迟与状态交接 | MD-3，条件启用 |
| [循环计划](./LOOP-PLAN.md) §8 后续、§10 rewind | 未纳入当时实现；日志与哈希不能自行撤销文件副作用 | DR-4，条件启用 |
| [Flow 诊断](./FLOW-DIAGNOSIS.md) P1-2 本地 RPC | 独立立项、端口登记与审批分开，不放宽通用 fetch | SG-4，条件启用 |
| 同文 P2-1 social 工具入口 | 历史待裁决项，先核对当前工具面；社交考量轮仍禁工作工具 | LG-0、SP-0 |
| 同文 P3-1 环境块后续扩展 | git 分支、项目概览、测试/构建命令待按当前接线核对 | DR-4 |
| [Flow 自主化](./FLOW-AUTONOMY-PLAN.md) A–F 与 FLOW-KNOWLEDGE | 已实施，原真机清单和增量场景仍需逐项映射 | DR-1、DR-2 |
| [工作区设计](./WORKSPACE-DESIGN.md) §6 第一期至第四期 | 后续已有权威、审批和循环实现；人工接手语义仍需组合验收 | DR-1、LG-3 |
| [镜像计划](./MIRROR-PLAN.md) 步骤 1–3、P0 | 当前有 mirror-visual 适配器；同模型像素与临时帧清理需核对验收 | SP-3 |
| 同文步骤 4 Gemini 原生传输 | 可选优化，不阻塞 P0 | SP-5，条件启用 |
| 同文步骤 5 view_image | 先 gallery 引用；workspace 等只读二进制端口 | SP-5，条件启用 |
| 同文图像长期记忆 | 保留为需单独存储与隐私决定的方向 | SP-5、PC-1、MD-1 |
| [接线清单](./WIRING-BACKLOG.md) §1；维护计划 P3.5 | MC 沙箱切换仍推迟；隔离方案只在需要时评估 | SP-4、SG-4 |
| 接线清单 §6/N；维护计划 P3.4 | nomic 调查、关闭路径等早期状态已被后续 M-RP 部分替代 | MQ-0、DR-3，不重复选型 |
| 维护计划 P3.1；接线清单 §7 全量检查 | 环境与检查失败必须以新运行结果为准 | MD-0 |

## 5. 依赖顺序与里程碑

各文件在批次开头列出直接依赖。里程碑同时包含所列批次的前置项。
以下顺序用于控制整体规模，不表示承诺工期。

| 里程碑 | 必须完成 | 后续入口 |
| --- | --- | --- |
| M0：当前状态可核对 | DR-0、MD-0 | 其余批次的只读调查可同时进行 |
| M1：可靠日用基线 | DR-1/2/3、MQ-0/2、SG-0/1、SP-0 | 进行 MD-4 的 7 天观察 |
| M2：一次跨天协作 | LG-0 至 LG-4、PC-0 至 PC-2、SP-1/2 | 同一授权目标跨天执行，带来源回顾 |
| M3：共同经历产生收益 | PC-3、SG-2/3、SP-4 | PC-4、MQ-4 与 MD-4 合作完成 30 天观察 |

MQ-1 的多视图内容与 MQ-3 的重排器不阻塞已能通过的基础场景。
DR-4、SG-4、SP-5 和 MD-3 的可选扩展，只有各自条件成立才排期。
7 天和 30 天是建议观察窗口，不能作为稳定性结论，也不能用日历到期代替验收。

统一验收故事：用户交付一个 AIRI 改进目标；她调查并保留证据；条件未满足时等待。
用户修改要求后，下一次执行采用新约束。应用重启后仍能恢复目标与记忆。
成果通过验证后，她在合适时机回顾真实经历，并提出一个可重复使用的技能候选。
技能经审阅后在后续任务产生可测收益。每一步都有对应事件和明确的停止边界。

## 6. 每批交付规则

1. 先读本文件、目标执行文件、承接的旧章节和最新 MODS。
2. 核对当前代码、工作树改动和已有内部实现。记录新增、复用与不再适用的部分。
3. 如果需要新依赖，先调研现有库与仓库用法，列候选表，由用户选择；本系列不预选新库。
4. 先确定所有权、持久化、事件关联和失败语义，再实现功能。新类型与事件名是实施时的契约工作。
5. 行为修改遵守 [Vitest 规则](../../.agents/skills/enforce-rules-for-vitest/SKILL.md)，先复现再修复，通过公共行为验收。
6. UI 修改遵守 [UnoCSS 规则](../../.agents/skills/enforce-rules-for-unocss/SKILL.md) 与 Vue 技能。新增用户文案先读术语表，只更新 en 和 zh-Hans。
7. Electron 交互使用仓库规定的 agent-browser 技能；截图使用对应 Vishot 技能。文件导入追加文件输入技能。
8. 使用与生产相同的包导出。改到 exports 指向 dist 的依赖时，先重建该包再跑跨包检查。
9. 运行所属包检查，再运行仓库 typecheck 与 lint。根脚本实际名为 typecheck，见 [package.json](../../package.json)。
10. 保存执行记录，更新批次状态、原章节状态和 MODS。实施期间不创建提交。

执行记录至少包含：批次编号、日期、代码或构建标识、运行端、provider/model、测试数据、命令退出码、journal 范围、预期、实际、未覆盖项。
运行日志与评估产物放在本目录匹配的批次证据目录，或记录可访问的本地产物路径。文档不得包含密钥。
没有运行的检查写“未运行”。已有环境失败必须记录本次结果，不能直接沿用历史免责说明。
远端写入、付费模型和真实用户数据的操作按实际会话授权执行。本次文档请求本身只交付计划。

## 7. 本次文档交付记录

- 2026-09-06：建立总索引和七份执行计划，记录旧批次承接与替代关系。
- 本次未实现七维路线的生产代码，也未重新验收历史功能。
- 各文件末尾保留批次状态表，后续从对应编号继续。
- 文档检查：八篇文件的本地 Markdown 链接均可解析，每篇只有一个一级标题，文档差异检查通过。
- 仓库检查：pnpm type-check 因脚本不存在失败；改用根 package.json 的 pnpm typecheck 后通过。
- pnpm lint 通过，退出码 0；已有代码与临时文件中仍有警告，本批未修改这些文件。
- 本轮未运行 Vitest、真实 provider、Electron 或 Postgres 场景；上述检查不构成路线功能验收。

## 12. SP-1 至 SP-3 代码实施记录（2026-09-06）

- `life-mode` 增加有作用域、有来源的记忆事实筛选、共享 reaction/任务活动投影、`noveltyKey` 去重、消费水位复用和过期候选 `discarded` 记录。
- `speech-output` 的现有播放状态端口接入社交门控；播放中、忙碌、Flow/focused 和重复考量不会触发社交模型请求，社交决策仍只挂载 `self_decide`。
- `mirror-visual` 采用一次性临时帧槽，成功调用覆盖旧帧，失败/下游异常/取消生命周期和 `prepareStep` 完成后都释放；持久工具结果不携带原图。
- 定向回归：`stage-ui` life-mode 与 mirror-visual 共 20 tests 通过；`core-agent` 重建后 `stage-ui` 与 `stage-tamagotchi` typecheck 通过。根 lint、typecheck、生产构建和真实 profile 的 agent-browser 记录见 [SP 执行证据](./evidence/sp-20260906/sp-execution-record.md)；SP-0 推广门和 SP-4 行为切片仍待真实场景。

## 8. DR-0 与 DR-2 局部执行记录（2026-09-06）

- 已核对当前工作树、代码入口、构建产物和旧 F/T/L/R 编号，并建立隔离 Electron profile。
- `TaskRun` 现在发布按 `taskId`/`flowId` 隔离、最多 40 行的结构化活动投影；follower 使用该投影显示活动，不复制全量 journal。
- 受控双窗口冒烟已证明 leader → follower 快照和任务面板可见性；provider/model、Postgres、打包 EXE 和长日志故障组合均未运行。
- 详细命令退出码、构建标识、journal 范围、截图和未覆盖项见 [日用可靠性执行证据](./daily-reliability-plan.md#6-本次执行记录2026-09-06) 与 [证据记录](./evidence/dr-20260906/dr-execution-record.md)。

## 9. DR-1 至 DR-4 继续执行记录（2026-09-06）

- 生产 profile 已重启并保持运行。真实 provider 完成只读成功、只读失败、失败后写入并复读、`user_ask` 回答和问题等待中停止；审批拒绝、超时、验证门异常仍待验收。
- `TaskRun` 标题时序修复和 legacy journal 合成 header 修复已加入 owning package 回归；重建后的生产窗口正常回放，最新 TaskRun 标题、状态和活动与 journal 一致。
- 真实 user profile 的长 journal 扫描发现一份 3,308 行文件（最高 seq 3,113，无 gap/坏行，但有 195 条重复 seq）；本地 >2,000 事件回放回归通过。真实 Postgres 端口拒绝连接且 Docker daemon 不可用，打包 EXE 未运行。
- DR-4 的 Hashline 校准前置因目标模型和一次真实写入样本成立，但旧 20 文件基准尚未执行；环境摘要和 rewind 的触发条件未成立。
- 详见 [日用可靠性继续执行记录](./daily-reliability-plan.md#7-继续执行记录2026-09-06) 与 [DR 证据记录](./evidence/dr-20260906/dr-execution-record.md)。

## 10. PC-0 至 PC-2 继续执行记录（2026-09-06）

- `MemoryScope = { userId, characterId }` 已接入聊天记忆、任务/反应事件、技能肌肉记忆、
  本地 DuckDB、PostgreSQL/pgvector 和 Electron memory-host 合约。
- 带作用域的检索只返回当前用户与当前角色的已审、有效事实；无作用域旧记录仍可审阅，
  但不会进入行为 prompt。聊天 prompt 增加有界的角色连续性规则，保留现有 top-3 记忆投影，
  不复制完整任务或工具日志。
- 抽取器保留经过结构校验的 episodic 事件，明确区分已发生事件与建议、梦想或计划。
- owning-package 单元测试和类型检查通过；真实 provider、跨角色重启、实际 Postgres、
  PC-3 场景集与 PC-4 长期观察未运行。详细记录见 [人格连续性执行计划](./persona-continuity-plan.md#5-完成定义与执行记录)。

## 11. LG-0 至 LG-2 首轮实施记录（2026-09-06）

- 长期目标现在复用现有 long plan 行并保存稳定 goalId、作用域、workspace root、约束版本、等待原因、待回答问题和 taskId/flowId/sessionId 运行关联；缺少执行范围的旧行不会自动执行。
- Electron 主进程新增长期目标调度时钟和租约；leader renderer 负责便宜条件检查、provider/tool 可用性、一次有界 Flow 和结算。社交 life-mode 不执行工作工具。
- `goal/update` 事件支持重放；同一转换幂等，终结目标只能通过显式修订重新变为 executable，暂停、取消或修订后的旧运行结算不会覆盖新版本。
- 定向测试和三个受影响包的 typecheck 已通过。真实 provider、打包 Electron、跨天停机重启和 LG-4 行为切片尚未运行，不能将本记录视为完整长期目标验收。
