# MQ-2 规范：事实纠正、时间与行为采纳

日期：2026-09-12。状态：规范定稿，实施未开始。上游：[记忆质量执行计划](./memory-quality-plan.md) §MQ-2 与 2026-09-08 续批（**先定位空回答共同链路，不先调召回权重/阈值/模型**）、[MQ-0 生产报告](./evidence/mq-0/production-report-20260907.md)、[MQ-2 真实 profile 纠正切片](./evidence/mq-2/real-profile-cdp-20260907.md)、[MC-1b 真机发现](./evidence/mc-1b/live-acceptance-20260912.md)（语义改写查询低于 0.5 阈值 → 召回 0）。MQ-2 是 **MC-2a 的前置闸门**。

通过条件（计划原文）：**新事实在对应范围胜出；旧事实不复活；无关任务行为不变；日志和自述不会经反复复述变成独立事实证据。**

## 现状与证据

- 2026-09-08 续批结论：MQ-2 未通过；M01/M02/M04–M07 出现新会话空回答，当时**不能区分**是检索等待、请求未发出、provider 空输出/仅 reasoning、解析丢失还是持久化/渲染问题。
- 现有仪器（无需新造）：journal `memory/retrieved`（query、top-3 ids/scores/originalSimilarity/normalizedSimilarity、retrievalQuery）、`memory/applied`（回答/工具参数中的 `[memory:<id>]` 引用）、`assistant/start`、`assistant/chunk`、`assistant/done`、`turn/end`、消息落盘与渲染链路。
- 已知定位（MC-1b 真机）：`retrieve()` 双路合并经阈值 `DEFAULT_MEMORY_SIMILARITY_THRESHOLD = 0.5` 过滤；词面重合查询正常（0.517/0.593），**语义改写查询全部 0 命中**（0.4x）。这属于"召回 0"候选类，但尚未证明其解释 M01/M02/M04–M07 的全部失败。
- 已知风险点：`normalizeMemoryRetrievalQuery` 末尾 `slice(0, 240)` 截断，可能丢掉末尾否定或主体限定（MQ-2 步骤 7）。
- 归一化/状态不变量已存在：pending/rejected/disputed/superseded 不参与召回；`memory/applied` 只在回答或工具参数出现显式引用时记数。

## D1 归因协议（先做，不改召回策略）

对每条失败样本（必须保留原始 FAIL 记录），按同一 provider/model、同一 scope、同一会话前置，执行 A/B：

1. **记忆开**：照常发送；采集 journal 序列 `user/message → memory/retrieved → assistant/start → 首个 assistant/chunk → assistant/done → turn/end` 与消息落盘/显示结果。
2. **记忆关**（同一问题、新的等价会话）：作为对照，排除"问题本身无答案"。
3. 归因矩阵（每条样本判定为一类，记录证据字段）：

| 类 | 证据 | 归属 owner |
| --- | --- | --- |
| R0 召回零命中 | `memory/retrieved.memoryIds = []`，scores 空或全低于阈值；A/B 无差异 | stage-ui memory retrieve（阈值/表示/双路合并） |
| R1 有候选未采用 | ids/scores 非空，`memory/applied = []`，回答忽略候选 | core-agent 注入提示/模型行为（记样本，不先改模型） |
| R2 检索异常降级 | journal 无 `memory/retrieved` 或 retrieve 抛错被 catch | stage-ui memory 边界（超时/异常透明化） |
| R3 请求未发出/提前失败 | 无 `assistant/start` 或 provider error | chat runtime（发送条件） |
| R4 provider 空输出/仅 reasoning | `assistant/start` 后无 text-delta 或仅 reasoning，finish 正常 | provider 适配层（记录 provider/model 与 finish reason） |
| R5 解析/持久化/渲染丢失 | 模型有输出但消息缺失或显示为空 | chat/session/journal/渲染 owner |

4. 每类给出确定性复现样本；**在归因完成前不做**：调阈值、调权重、换 embedding/模型、放宽状态过滤。

## D2 修复规则（按归因结果）

- **R0**：先区分"表示问题"还是"阈值问题"：把失败查询与其 gold 事实的相似度逐条记录（`retrieveEvaluationTrace`/`memory/retrieved` 已有字段）。若 gold 事实在候选内但排序被阈值滤掉 → 阈值策略；若 gold 未进候选（表示差异）→ 记入 MQ-1/MQ-3，不在 MQ-2 硬调。
- **阈值策略（需用户确认）**：候选方案——(a) 保持 0.5，仅修复表示与无答案诚实性；(b) 有证据地下调阈值（以 MQ-0 90 条 + 新增 MQ-2 夹具做**前后对照**，报告 recall/precision/误召回变化，禁止只看通过样本）；(c) 增加**词面回退**（向量零命中且有内容词时做有界关键词检索，仅限 approved/active，返回带来源）。任何方案都要保存失败个案与 before/after 报告。
- **R1**：只改注入措辞/引用格式或对照任务脚本，不把"引用数"当理解；行为采纳用对照任务（例如要求依据记忆执行一次工具/回答一个派生问题）判定。
- **R2**：在真实 IO 边界加超时与显式降级记录（journal 记 `memory/retrieved` 的空结果与原因），不得伪造成功回答。
- **R3/R4/R5**：修对应 owner；provider 空输出记录 finish reason 与 model 元数据，样本回填计划。
- 步骤 6（失效检查）：批准修订后验证旧事实在普通召回、muscle/reflex、dreaming、远端镜像四处均不复活（复用 2026-09-07 纠正切片流程 + 远端镜像回归）。
- 步骤 7（归一化截断）：新增长查询回归样本（末尾否定/主体限定），验证 `normalizeMemoryRetrievalQuery` 240 字符截断不丢语义；必要时改为按子句边界截断。

## D3 场景矩阵（验收夹具）

| 组 | 样本 | 期望 |
| --- | --- | --- |
| 复跑（保留原 FAIL） | M01/M02/M04–M07 原问法（记忆开/关 A/B） | 每条：归因类别 + 修复后重跑结果；原 FAIL 记录不覆盖 |
| 跨会话召回 | 会话 A 写入事实 → 新会话 B 提问 | `memory/retrieved` 命中且回答采用（`memory/applied` 或对照任务） |
| 纠正胜出 | 旧事实 approved → 修订 supersedes | 新事实胜出；旧事实在任何召回/反射/dreaming/镜像中不出现 |
| 同名人物 | 两个同名不同主体的偏好事实 | 主体限定正确；错误主体不被召回 |
| 相似项目 | 相似名称的两个项目事实 | 范围限定正确；不串事实 |
| 否定句 | "不要用 X / 不喜欢 X" | 否定保持；不被反问召回成正向 |
| 临时偏好 | "这次/今天想…" 的短期范围 | 临时事实不升级为长期；过期后不再召回 |
| 过期约束 | 带适用时间的事实 | 过期事实按契约降级/不召回；时间表达可核对 |
| 无答案 | 仓库无对应事实的问题 | 候选为空且回答不编造（允许说不知道） |

- 步骤 3（事实模型）：先审计 memory-core 现有主体/范围/时间字段（`scope`、`sourceContext`、`factStatus`、`supersedesId`、`conflictGroup`、`halfLifeHours` 等），缺契约时**先在 memory-core 定义**再迁移；不在 stage-ui 造局部字段。

## 验收映射（计划原文）

| 计划验收 | 本规范判定 |
| --- | --- |
| 新事实在对应范围胜出 | 纠正/同名/相似/临时组的 A/B 与对照任务 |
| 旧事实不复活 | 失效检查四处 + supersedes 回归 |
| 无关任务行为不变 | 噪声组 + 无答案诚实性 + 对照任务 |
| 日志/自述不变成独立证据 | 反复复述同一自述的样本，确认不产生新事实证据（`memory/applied` 与来源字段核对） |

## 实现落点

- 评估/归因：`packages/core-agent`（journal 关联与 `memory/applied` 判定）、`packages/stage-ui/src/stores/modules/memory.ts`（`retrieve`/trace 字段）、`packages/stage-ui/src/services/memory/{evaluate-chinese-memory.ts, query-normalization.ts}`。
- 场景夹具：`memory-core` 评估样本扩展（新增 MQ-2 strata）；stage-ui memory 定向测试（阈值/回退/无答案/截断）。
- 行为采纳记录：journal `memory/retrieved`/`memory/applied` 已有，不改契约；只补样本与报告。
- 真机：打包 Electron + 真实 provider + 真实 profile 副本（沿用 MQ-0/MQ-2 既有流程），报告存 `docs/fork/evidence/mq-2/`。

## 增量拆分

1. **增量 1（归因）**：建立 A/B 协议与归因矩阵；复跑 M01/M02/M04–M07；产出逐条归因报告（R0–R5）+ 复现样本。此增量不改产品策略代码（最多补 journal 字段的只读采集）。
2. **增量 2（按类修复）**：R0 阈值/回退决策（用户确认后）+ R2 异常透明化 + R5 owner 修复；配 before/after 评估报告。
3. **增量 3（场景与失效）**：D3 场景矩阵 + 失效检查 + 截断回归 + 真机报告；四条验收逐一判定。

## 明确不做

- 换 embedding/模型、引入新检索库（需用户另行确认，属 MQ-3）。
- 用调阈值/权重掩盖未归因的空回答。
- 把引用标记数量当作理解或采纳证明。

## 本轮交付与检查

本轮新增本规范并更新 MODS.md 索引；不改产品代码、不跑真机。实施与报告按增量推进。

## 实施记录

### 增量 1（2026-09-12）：空回答归因（只读）

按 D1 协议完成只读归因，报告见 [evidence/mq-2/attribution-20260912.md](./evidence/mq-2/attribution-20260912.md)。主要结论（**改变增量 2 的修复优先级**）：

1. **主因是作用域漂移，不是阈值**：2026-09-07 的 gold 写在 `userId: 'local'`；当前认证 scope `3bXjSq…` 的过滤把 approved gold 全部挡掉。用旧 scope 直接检索同一查询立即命中（M01 0.558–0.673、M04 0.526）。
2. **状态/角色漂移**：M05/M06 当前 scope 事实为 pending；approved 变体挂 `characterId: default`。
3. **工具回路与记忆链冲突（新发现）**：默认步数下 M01 当天答"青石"（旧名）——来自 `grep/read` 仓库证据文档，而非记忆（正确当前名白帆因 scope 漂移不可召回）。原 M05 记录同样有"只读工具回路、无最终回答"。
4. **空 assistant 消息分支（机械层）**：步数耗尽且最后一轮无文本时遗留空 assistant 消息（`maxSteps:1` 复现）；与"检索为空"独立。
5. **M07 无 gold**：工作完成态属 plan/journal 投影域，不是记忆问题。

增量 2 的输入（待用户决策）：旧 scope 迁移政策（迁移/合并 vs 只读历史 vs 本地身份绑定）；gold 卫生（批准或重播）；工具回路 vs 记忆的优先策略；空消息降级文案/自动续轮；M07 计划投影接线；阈值/表示为独立次因（含 `normalizeMemoryRetrievalQuery` 240 截断回归）。本增量未改任何产品策略代码；采样会话/事实已清理。

### 增量 2（2026-09-12，步骤 1–3；用户决策：1c + 不合并数据）

用户决策：作用域采用 **1c（显式本地身份维度、按 profile 决定可见性）**，**不合并现有数据**（合并会改写来源归属且不可逆；可见性策略可回退）；步骤 2/3 采纳建议（记忆优先提示；续轮建议留待真机验证后再定，先做 UI 兜底）。

- **步骤 1（D1c 可见性）**：`memory-core` 新增 `isMemoryScopeVisible(scope, active, linkedUserIds)`（角色精确匹配、user 维度可含显式链接身份；`isSameMemoryScope` 语义不变）；仓库 `search`/`list` 接口增可选 `linkedUserIds`；`local-memory` 两处过滤改用可见性函数；`stage-ui` memory store 新增设置 `settings/memory/link-local-history`（默认开）与 `linkedUserIdsForScope()`（认证 id 时链接 `local`，角色不放宽），`retrieve` 两路与 `listShareableFacts` 传入；设置页 `长期记忆 → 记忆身份` 增开关（i18n en/zh-Hans）。测试：memory-core 2 例、local-memory 11 例（含链接可见/严格不可见/其他角色不可见）、全部 typecheck/eslint 0。
- **步骤 2（工具回路 vs 记忆）**：`ingestMemoryContext` 在存在记忆引用时追加一行显式指引——"These are your own recorded memories. Answer questions about your history…; do not search the workspace for your own facts."（core-agent 91 例全绿）。
- **步骤 3（空消息语义，UI 兜底）**：`assistant-item.vue` 在"回合已结束、仅有工具调用切片、无文本"时渲染显式提示（`chat.message.no-text-output`，i18n en/zh-Hans），不再留空气泡；"自动续一轮"待真机验证后再决定是否加。
- **待续（增量 2 步骤 4–5）**：M07 的 plan/journal 投影接线；阈值/表示对照评估（含 `normalizeMemoryRetrievalQuery` 240 截断回归），按 MQ-0 90 条 + 新增夹具出前后报告。

### 增量 2（2026-09-12，步骤 4–5 确定性部分）

- **步骤 4（M07 计划投影）**：`plans.ts` 新增纯函数 `formatRecentPlanProjection(views, limit)` 与 store 动作 `recentPlansProjection()`——把**已终态**（completed/failed/cancelled/blocked）的计划按 `updatedAt` 倒序渲染为"## Recent work (historical background, not current tasks)"：goal、status、completed、failed、unverified、not finished、blockers、session，并附"不得把未验证/未完成当作完成"。`chat.ts` 非工作回合在**解析不到活动计划**时回退到该历史投影（新会话问历史工作有据可答）。测试：plans 2 例（终态汇总与 live 忽略、无历史返回空）。
- **步骤 5（确定性部分）** `normalizeMemoryRetrievalQuery` 截断修复：否定子句**前置**（长查询被截断时先丢动作子句、永不先丢"不要/避免"约束）+ 新增 `truncateAtClauseBoundary`（在 limit 前的最后一个子句分隔符处截断，避免把子句切成半句；无分隔符时才硬截）。回归 2 例（否定在长查询截断后完整保留、保留段均为原查询完整子句）；framing 测试期望同步为否定前置顺序（有意行为变更）。
- **待续**：阈值/表示的**对照评估**（MQ-0 90 条 + 新增夹具的前后报告）与增量 3（重跑 M01/M02/M04–M07、场景矩阵、失效检查四处、真机验证 1c/提示/UI 兜底）。

### 增量 2（2026-09-12，步骤 5 对照评估）

- **评测 seam**：`retrieve`、`retrieveEvaluationTrace`、`evaluateProductionRetrieval` 增加可选 `similarityThreshold`（仅评测路径；产品默认值未改）。
- **运行**：A（严格 scope/0.5）、B（1c 链接/0.5）、C（链接/0.35）、D（链接/0.42）、E（链接/0.40），各 90 用例、k = 3。报告：`docs/fork/evidence/mq-2/threshold-evaluation-20260912.md`。
- **结果**：A recall 0.000 → B 0.778（1c 是主修复）；D(0.42) recall 0.944、误召回 0.144；E(0.40) 被 D 支配（0.956/0.185）；C(0.35) recall 1.000、误召回 0.274（边际收益不成立）。
- **建议**：策略 b（默认阈值 0.5 → 0.42），待用户确认后改默认值。
- **清理**：20 条 gold 已删除、隔离作用域剩余 0、`linkLocalHistory` 复位默认 true。

### 增量 3（2026-09-13，真机验收）

- **M 案重跑**：M01/M02/M04 PASS（记忆来源、0 工具调用）；M05/M06 带工件号的查询被工具回路接管（来源是仓库文档），夹具卫生（批准 pending `d378c628`/`8a5b1dab`）+ 自然查询后 PASS（0 工具）；M07 PASS（plan 历史投影，明确未完成与未验证）。记录见 `docs/fork/evidence/mq-2/increment-3-live-20260913.md`。
- **D3 矩阵**：同名人物、相似项目、临时偏好、否定句、过期约束、无答案（内容 PASS，用工具）、跨会话、纠正胜出全部通过。
- **UI**：空消息兜底经 `maxSteps: 1` 复现并渲染；**修复 i18n key 前缀缺陷**（`chat.message.no-text-output` → `stage.chat.message.no-text-output`）；设置页「记忆身份」开关真机渲染正常；M07 投影真机生效。
- **失效检查**：`listShareableFacts` 9 条全 approved、泄漏 0（muscle/reflex/dreaming/镜像共享入口）。
- **遗留**：工件号式查询仍触发仓库工具回路（已知行为，owner: chat runtime/工具面）；多账号切换、dreaming 真机、0.42 决策后复测未做。
- **清理**：矩阵夹具移除、15 个探针会话删除、活动会话与路由复位。
- **阈值决策落地（2026-09-13）**：用户确认策略 b，`DEFAULT_MEMORY_SIMILARITY_THRESHOLD` 0.5 → 0.42；`memory-pgvector` 默认阈值断言同步；测试 memory-core 40/40、pgvector 6 passed、stage-ui memory 47/47。**MQ-2 完成。**
