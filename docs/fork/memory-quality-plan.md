# AIRI 记忆语义质量执行计划

## 2026-09-08 验收后代码审查与续批

当前结论：MQ-2 未通过。M01/M02/M04–M07 多项出现新会话空回答，不能据此分别认定为召回、纠正或日期算法故障。
事实抽取已在 UI 可见，回答链路仍待定位。见 [M01](./evidence/short-scenarios/ACC-20260907-01/M01-memory-recall.md)
和 [登记表](./evidence/short-scenarios/ACC-20260907-01/run-register.md)。

### MQ-0/2：先定位空回答的共同链路

代码入口：[runtime](../../packages/core-agent/src/runtime/chat-orchestrator-runtime.ts) 的 `ingestMemoryContext()`、
[memory store](../../packages/stage-ui/src/stores/modules/memory.ts) 的 `retrieve()` 和 embedding 服务。
普通非 Flow 回合在请求模型前等待记忆检索；异常有降级，但等待未完成不能靠 catch 解除。
模型流结束后没有可显示文本也是独立分支，不能和检索为空混为一谈。

- [ ] 在测试会话以同一问题比较记忆开启/关闭，记录相同 provider/model、scope 和会话前置。
- [ ] 关联检索开始/结束、`memory/retrieved`、模型请求开始、首个 text-delta、finish/error、消息落盘和实际显示。
- [ ] 分别判定：检索等待、请求未发出、provider 空输出/仅 reasoning、解析丢失、持久化或渲染问题。
- [ ] 定位后修复对应 owner；需要超时和取消时在实际 IO 边界实施，不能只追加一个虚假的成功回答。
- [ ] 回答链路恢复后再复跑 M01/M02/M04–M07，核对有效事实、纠正、日期与来源，保留初次 FAIL。

此轮不先调召回权重、阈值或更换模型掩盖空回答。阶段取证可先做，具体根因修复等待证据。
dreaming 的主体隔离由 PC-0/2 续批定义，MQ-2 核对有效事实筛选与历史无 scope 记录政策，不重复建任务。
以下保留原计划与历史执行记录。

日期：2026-09-06。状态：MQ-0 已完成隔离本地 profile 的 Electron renderer 合成基线；外部 provider、真实用户事实、MQ-2 行为切片及其余 MQ 批次仍待执行（见 §5 执行记录）。
归属：[七维升级总索引](./upgrade-roadmap.md) 方向二。优先级：P0 基线，P1 内容优化。

## 1. 目标与现状

目标：在需要时想起正确事实，接受用户纠正，并让记忆改善回答和行动。
召回命中、回答引用和行为采纳分别测量，不能互相代替。

[M-RP](./MODS.md) 已记录 checkpoint、向量来源、迁移、document/query 区分与双路召回。
[记忆行为切片](./MEMORY-BEHAVIOR-SLICE.md) 的 B/C 已有跨会话召回与纠正胜出的记录，噪声项部分通过。
这些是复用基线，不是重新更换存储或嵌入模型的理由。

本轮源码调查发现两个需要在 MQ-0 核实的差距：

- memory-core 已有 90 条分层样本，evaluateChineseMemoryEmbeddings 仍使用旧 5 条样本。
- 该入口直接做向量排序，没有经过生产 retrieve 的双路合并、状态过滤与注入过程。

这是代码接线观察，不是新模型质量分数。本计划尚未运行真实模型评估。

## 2. 旧批次承接

| 原计划 | 承接方式 |
| --- | --- |
| MEMORY-RETRIEVAL-AND-PERSISTENCE A/B/C/E | 保留已实施状态；MQ-0 接生产评估，DR-3 验持久化 |
| 同文 D 多视图内容 | MQ-1 原批次续作 |
| 同文 F reranker | MQ-3 条件实验，不能先于基线 |
| MEMORY-SEMANTICS-CORRECTION A–D、E | MQ-2 保留事实类型、审批、修订与跨会话行为回归 |
| 同文 §9.1；MEMORY-DESIGN §10/§11 | MQ-0/2 测中文、情绪权重、抽取与反射边界 |
| MAINTENANCE P3.4；WIRING §6/N | nomic 已有历史测量，当前来源已有变化；按新证据标定，不重复旧决策 |
| reliability-and-roadmap §4.1 | MQ-2/4 扩展时间、来源、无答案与长期表现 |

## 3. 数据与所有权

事实类型、有效状态和修订关系归 memory-core。
DuckDB 与 pgvector 的存储契约各归其 repository；远端镜像不等于当前聊天已经使用远端召回。
生产召回与模型注入归 stage-ui memory/chat；评估必须调用同一受支持边界。

代码入口：

- packages/memory-core/src/evaluation.ts、query-normalization.ts、extraction.ts、types.ts。
- packages/stage-ui/src/services/memory/evaluate-chinese-memory.ts、local-memory.ts、local-memory-embedding.ts。
- packages/stage-ui/src/stores/modules/memory.ts、stores/chat.ts。
- packages/memory-pgvector/src/repository.ts、schema.ts。

不变量：pending、rejected、disputed、superseded 不能作为有效事实驱动召回或反射。
普通事实不转成 muscle。情绪和访问次数不提高事实的权威等级。
归一化文本是查询表示，不是新事实；无答案时允许返回空候选。

## 4. 实施批次

### MQ-0：让评估经过生产路径

前置：DR-0、MD-0 的基线标识；允许先进行只读调查。

1. 为 90 条样本补齐 gold 事实内容、语言、来源、状态与适用时间，核对 strata 名称和实际语言方向。
2. 保留旧 5 条作为快速检查，把分层样本接到真实 retrieve 边界。
3. 同时记录原始查询、归一化查询、各路候选与最终注入候选。
4. 使用生产的 document/query、指纹过滤、阈值、状态过滤和有界合并。
5. 对照原始单路与当前双路，固定事实集、provider、模型及参数，只改变一个变量。
6. 实际采集每路调用的 token 与延迟；未采集值记缺失，不能填零冒充免费。
7. 复查附加成本计算；第二路实际调用的成本不能用两段文本长度之差代替。

验收：按九类样本分别输出 recall@3、precision@3、MRR@3、无关查询误召回、延迟与费用。
无答案样本能返回空结果；评估和聊天对同一查询采用相同候选边界。
记录失败样本，再决定 MQ-1/3 的收益门，不预设必须换模型。

### MQ-1：多视图事实内容

前置：MQ-0。承接旧批次 D；仅针对基线确认的表示缺口实施。

1. 搜索现有事实、标签与源消息字段，确定可复用字段和需要新增的检索摘要。
2. 将用户可读内容、短检索表示、关键词和来源引用分开。来源尽量用稳定引用，避免复制整段日志。
3. 明确哪个字段生成 document 向量，记录表示版本与迁移状态。
4. 修改或批准事实修订时，同时使旧摘要和向量失效。
5. 迁移采用已有有界批次与断点机制；失败保留事实内容并公开待迁移状态。
6. UI 展示事实与来源，内部检索文本仅在诊断入口出现。

验收：长短问法命中同一有效事实；摘要保留否定、主体与时间；修订后旧摘要不参与召回。
在同一 MQ-0 样本上报告收益和退化。没有收益时保留实验结论，不扩大迁移。

### MQ-2：事实纠正、时间与行为采纳

前置：MQ-0，不依赖 MQ-1。

1. 复跑 MEMORY-BEHAVIOR-SLICE 的无记忆对照、跨会话召回、纠正与噪声组。
2. 增加同名人物、相似项目、否定句、临时偏好、过期约束和无答案场景。
3. 核对当前事实模型的主体、范围与时间表达；缺失契约先在 owning package 定义，再迁移。
4. 用 memory/retrieved、memory/applied 和实际回答或工具行为分别记录检索、引用与采用。
5. 引用标记只能证明显式引用；用对照任务验证行为变化，不能用标记数量推断理解。
6. 批准修订后检查普通召回、muscle/reflex、dreaming 与远端镜像的旧事实失效。
7. 检查机械归一化的长文本截断是否丢掉末尾否定或主体限定，失败样本加入回归。

验收：新事实在对应范围胜出；旧事实不复活；无关任务行为不变；日志和自述不会经反复复述变成独立事实证据。
持久化故障场景交给 DR-3，MQ 负责重启后的语义结果。

### MQ-3：条件性的检索优化实验

前置：MQ-0/2，MQ-1 已完成实验或记录不适用原因。承接旧批次 F。

1. 按失败类型判断是未召回、排序错误、表示错误还是事实状态错误。
2. 只有候选已有正确事实且排序仍差时，评估 reranker；其他问题在拥有它们的边界修复。
3. 如需新库或模型，提交候选对照表，由用户选择。保留当前来源为可回退基线。
4. 比较逐类收益、误召回、延迟、费用与本地资源，并保存失败个案。
5. 重跑留出的样本集，避免用同一批样本反复调参后自证提升。

验收：采用或不采用都有可复查结论。收益阈值在实验前记录，不能看见结果后调整通过标准。
不同时更换 embedding、查询表示和排序公式，不以降低统一阈值掩盖长查询问题。

### MQ-4：跨天记忆质量观察

前置：MQ-2、DR-3；与 MD-4 共享观察记录。

1. 使用跨会话和重启后的真实问法，记录漏召回、误召回、旧事实复发和用户纠正。
2. 将新失败归入已有 strata，保存去除敏感信息的回归样本。
3. 向 PC 提供已批准且有来源的共同经历，向 SP 提供允许分享的有效事实。
4. 验证数据导出恢复后，来源、修订关系与有效候选仍保持一致。

验收：报告分层结果与观察窗口，不能只报总体均分或一次成功对话。

## 5. 完成定义与执行记录

执行与检查遵守 [总索引](./upgrade-roadmap.md)。实现行为回归使用 owning-package Vitest，真实 provider 评估另存报告。

- [x] MQ-0 生产链路基线与分层报告完成（隔离本地 profile 的 Electron renderer；合成 gold，token/cost 缺失边界已记录）。
- [ ] MQ-1 多视图事实实施或实验后明确暂缓。
- [ ] MQ-2 纠正、时间、主体与行为采纳通过。
- [ ] MQ-3 条件实验有采用或不采用结论。
- [ ] MQ-4 跨天报告完成并移交失败样本。

MQ-0/2 是日用基线门。MQ-1/3 的选择不阻塞已通过的基础场景。
首条执行记录：2026-09-06，仅编写计划，未运行新的模型评估或迁移。

### 执行记录（MQ-0 只读调查，2026-09-06）

- **批次**：MQ-0（只读部分：纯数据准备 + 代码核对；与 DR 实例并行执行）。
- **运行端**：本地工作树，未构建；基线构建标识待 DR-0/MD-0 冻结，本轮不声明。
- **provider/model**：未调用（未运行任何模型评估）。
- **测试数据**：`MEMORY_RETRIEVAL_EVALUATION_CASES`（90 条）与 `CHINESE_MEMORY_EVALUATION_CASES`（旧 5 条）。
- **命令退出码**：未运行命令；typecheck/lint/vitest 均未运行（只读调查）。
- **journal 范围**：无（未运行端）。
- **预期**：确认 90 条样本缺事实内容语料、评估适配器绕过生产路径、strata 方向是否有矛盾。
- **实际**：
  - 20 个 fact id 与旧 5 条 id 全仓库无内容定义；已补齐双语（zh/en）合成 gold 语料与元数据 → `evidence/mq-0/gold-corpus.md`。
  - 生产检索链路完整（记忆注入 → 原始/归一化双路 → 状态/空间/阈值门 → 有界投影 → journal），旧适配器 `evaluateChineseMemoryEmbeddings` 绕过全部环节且全仓库零调用方；逐项差距映射到 MQ-0 步骤 1–7 → `evidence/mq-0/wiring-findings.md`。
  - strata 方向核对：8/9 一致；`zh-to-en` 的 10 条查询实际为英文，与“中文查询对英文事实”定义矛盾，待裁决。
- **未覆盖项**：未运行真实 provider 评估；gold 内容为合成数据，语义终审（尤其 near-miss 组）与 fixture 修改属于 MQ-0 实施；旧 5 条保留为快速检查需调用方传入内容语料，仓库无内置语料。
- **代码增量（2026-09-07）**：`retrieveEvaluationTrace` 已在生产 `retrieve` 内记录原始/归一化查询、两路完整候选和最终注入候选，不再从最终三条结果反推路由；OpenAI-compatible embedding provider 的两路 query token usage 也会按调用分别保留，缺失时不猜测。测试固定 `sessionId` 与 profile/character scope，并验证四条原始候选在有界注入后仍可追溯；该测试不等同真实 provider/profile 评估。
- **成本指标增量（2026-09-07）**：`MemoryEvaluationCase` 与生产 trace 现在接受可审计的 `costUsd`；评估聚合报告 measured zero 与 missing 分开。生产适配器可传入已知的 `costPerMillionTokens` 价目，按两路实际 token usage 生成估算，否则 Markdown 报告明确显示缺失，不把缺失填成零。memory-core 评估 4 条、stage-ui 评估 3 条通过；真实 provider/profile、价目选择和 90 条生产报告仍未运行。
- **误召回报告增量（2026-09-07）**：90 条生产 trace 现在同时保存 gold `relevantIds` 和 top-3 范围内的 `falsePositiveIds`。Markdown 报告除 `False-positive@3` 汇总值外，还列出每个误召回样本、stratum 和错误 id，便于真实 profile 运行后逐条回查。stage-ui 评估 4 条通过；这仍不构成真实 90 条生产报告。
- **运行上下文增量（2026-09-07）**：`useMemoryStore().evaluateProductionRetrieval` 现在要求显式传入 `profileId`、`sessionId` 和 `scope`，并把同一上下文随 90 条结果返回；stage-ui memory module 24 条定向测试通过。该契约为真实运行准备绑定边界，但本轮仍未调用真实 provider/profile。
- **远端镜像增量（2026-09-07）**：Docker 恢复后 `memory-pgvector` 真实集成回归 4/4 通过，覆盖 origin 幂等、删除 tombstone 防复活和审阅/修订/删除传播。这证明远端镜像契约，不等于 90 条生产检索评估；真实 provider/profile、价目选择和 90 条报告仍未运行。
- **真实 profile 纠正切片（2026-09-07）**：使用打包 Electron、真实 profile、真实 provider 和 agent-browser 完成一次实际对话；leader 以 `userId=local` 与活动角色卡 scope 运行 pending→approved、supersedes、muscle/reflex 失效和远端 outbox 插入/删除。修订后的事实被真实回答采用，临时消息与记忆已清理；完整记录见 [MQ-2 real-profile evidence](./evidence/mq-2/real-profile-cdp-20260907.md)。dreaming、时间过期和无关行为不变仍待覆盖。
- **断线状态增量（2026-09-07）**：远端镜像写入失败现在会把状态标成 `error`，保留带 attempts/nextAttemptAt 的本地 outbox；host 再次报告 `ready` 时立即重试并恢复定时发送。stage-ui memory module 24 条定向测试通过。真实 Postgres 断线重连仍未运行。
- **生产路径基线增量（2026-09-07）**：在实际 Electron renderer 中使用现有本地 profile 的临时副本，按真实 `userId=local`、`characterId=n8cz_qXFxNLwpJmuAsfIl` scope 写入 20 条 approved synthetic gold facts，并以 `sessionId=mq-0-production-20260907` 运行全部 90 条 fixture。稳定 `originId` 已用于评估 trace，报告为 recall@3 `0.789`、precision@3 `0.263`、MRR@3 `0.637`、false-positive@3 `0.626`、平均检索延迟 `1104.84ms`；逐样本误召回和九个 strata 见 [生产报告](./evidence/mq-0/production-report-20260907.md)。本地 embedding worker 未提供 token usage，因此 query/normalized-query token 和 cost 均明确记录为 `missing (90/90)`。这完成了生产 renderer、profile 副本、session、scope 和双路检索的接线基线；合成语料、真实用户事实、外部 provider 价格与质量结论仍待后续验证。
- **待裁决**：① fact id 双语存储方案（两条记录 vs 可派生字段）；② 真实 provider/profile 运行和费用价目配置仍未执行。
- 本记录不构成 MQ-0 完成；`evidence/mq-0/` 两份报告起初是只读调查产物，后续代码接线、成本指标和远端镜像回归已另行记录。
