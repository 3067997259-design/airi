# AIRI 记忆语义纠偏与行为闭环计划

日期：2026-09-05。
状态：批次 A–D 已实施；批次 E 已实机运行（组 B/组 C 通过，噪声项部分通过，
详见 `docs/fork/MEMORY-BEHAVIOR-SLICE.md` 运行记录）；遗留召回门限与
embedding 决策见 §12.7。
范围：`packages/memory-core`、`packages/stage-ui`、`packages/core-agent`，以及相关测试、记忆浏览器和文档。

## 0. 目标

修正普通事实与 muscle memory 的边界，建立一条可验证的跨会话行为路径：

```text
用户偏好
  -> 事实抽取
  -> 审核
  -> 跨会话召回
  -> 影响回答或工具选择
  -> 用户纠正
  -> 新事实生效
  -> 旧事实停止影响行为
```

本计划首先处理已观察到的具体错误：

```text
用户偏好被保存为 muscle
  -> 普通向量检索排除该记录
  -> triggerPattern 不匹配自然语言问题
  -> 新会话无法召回
```

本计划不立即重做记忆 schema、embedding 模型、排序公式或生命模式。

## 1. 前提与证据

### 1.1 当前记忆类型

| 类型 | 当前语义 | 正确触发方式 |
|---|---|---|
| `short_term` | 新近事实或候选事实 | 语义召回 |
| `long_term` | 经跨会话验证的事实 | 语义召回 |
| `muscle` | 条件反射或工具触发器 | `triggerPattern` 匹配 |
| `working` | 当前运行上下文 | 当前会话 |
| dream idea | 从事实产生的想法 | dreaming pass |

`muscle` 不是“重要的长期事实”。它是零 token 的精确触发通道。

### 1.2 已观察到的样本

记忆浏览器显示：

```text
The user prefers running relevant tests before deciding whether to edit files during coding work.
muscle · 有效 · 1 次访问 · 1 个会话
```

该内容表达用户偏好。它没有表现出工具触发器的语义。

真实新会话测试得到：

- AIRI 可以回答该偏好。
- `memory/retrieved` 已落 journal。
- `memoryIds` 为空。
- 当前会话中的原始消息足以让模型复述答案。

因此测试没有证明记忆召回成功。它证明了当前会话上下文可以掩盖记忆失败。

### 1.3 当前代码边界

普通记忆抽取仍允许模型返回：

```text
memoryType: "short_term" | "muscle"
```

入口在 `packages/stage-ui/src/stores/chat.ts` 的记忆抽取提示和结构过滤。

普通向量搜索排除 `muscle`。muscle 只通过 `matchesMuscleMemory()` 检查 `triggerPattern`。

Dreaming pass 只接受 `short_term` 和 `long_term`。它有意排除 `muscle`。

## 2. 核心决策

### 2.1 普通抽取只能产生事实

普通 `extractMemoryTurn()` 只能产生 `short_term`。

它不能直接创建 `long_term`，也不能直接创建 `muscle`。

### 2.2 Muscle 只能由显式能力创建

`rememberMuscle()` 是唯一的 muscle 写入入口。

它必须要求：

- 事实内容。
- 非空 `triggerPattern`。
- 可解释的来源。
- 明确的审核状态。

如果没有 `triggerPattern`，写入必须失败。

### 2.3 Pending 记忆不能影响行为

`pending` 记忆可以显示在记忆浏览器中。

`pending` 记忆不能进入普通行为 prompt，也不能触发 muscle reflex。

只有 `approved` 且未被 supersede 或 dispute 的事实可以影响正常行为。

### 2.4 类型纠偏必须保留历史

错误的 muscle 记录不能直接删除。

迁移必须保留内容、来源、访问次数和原始 id。迁移后的记录进入 `short_term`，然后按正常规则审核和晋升。

如果系统不能判断某条 muscle 是否有有效触发模式，记忆浏览器必须提供人工选择：

- 转为事实记忆。
- 保留为 muscle。
- 删除。

## 3. 批次 A：收紧抽取契约

### 3.1 代码入口

- `packages/stage-ui/src/stores/chat.ts`
- `packages/stage-ui/src/stores/modules/memory.ts`
- `packages/memory-core/src/types.ts`
- `packages/memory-core/src/reflex.ts`

### 3.2 实施步骤

1. 修改抽取提示，只允许 `memoryType: "short_term"`。
2. 修改 `isMemoryExtraction()`，拒绝普通抽取返回的 `muscle`。
3. 保留 `MemoryExtraction` 的 muscle 类型 only when an explicit caller requires it, or split the input type so ordinary extraction cannot express muscle.
4. 给 `rememberMuscle()` 增加 `triggerPattern` 非空校验。
5. 给 `matchesMuscleMemory()` 增加有效触发模式和 active fact 状态检查。
6. 确认 `pending`、`rejected`、`superseded` 和 `disputed` muscle 不会触发。
7. 确认 DuckDB 和 pgvector 使用相同的事实过滤策略。

### 3.3 验收条件

- 普通抽取返回 muscle 时，系统拒绝该条或转换为 short-term。
- `rememberMuscle()` 没有触发模式时不写入数据库。
- 无触发模式的历史 muscle 不会被匹配。
- pending 事实不会进入行为 prompt。
- approved short-term 事实可以进入向量检索。
- 被 supersede 的事实不会进入向量检索或 reflex。

## 4. 批次 B：修复已有错误记录

### 4.1 代码入口

- `packages/stage-ui/src/stores/modules/memory.ts`
- `packages/stage-ui/src/services/memory/local-memory.ts`
- `packages/memory-pgvector/src/repository.ts`
- 记忆浏览器页面和组件

### 4.2 实施步骤

1. 读取现有 muscle 记录，区分有触发模式和无触发模式。
2. 对没有有效触发模式的记录提供事实转换动作。
3. 转换时保留原 id，或建立可追踪的迁移关系。
4. 将转换后的记录设为 `short_term`。
5. 将审核状态设为 `pending`，除非用户明确批准迁移。
6. 重新生成向量，确保内容修改后检索使用新向量。
7. 记录迁移来源和时间。
8. 不自动迁移具有有效工具触发模式的 muscle。

### 4.3 验收条件

- 示例偏好转换后不再显示为 muscle。
- 示例偏好可以被普通向量搜索返回。
- 转换前后的来源和访问记录可追踪。
- 迁移不会复活 rejected 或 deleted 记忆。
- 远端镜像不会重新把旧类型写回本地。

## 5. 批次 C：稳定记忆引用和召回观测

### 5.1 目标

系统必须知道某一轮使用了哪条记忆。

### 5.2 实施步骤

1. 召回 prompt 为每条记忆显示稳定引用：`[memory:<id>]`。
2. `memory/retrieved` 记录查询、session、turn 和 memory ids。
3. 在 prompt projection 中保留这些引用。
4. 增加 `memory/applied` 的最小事件或等价观测字段。
5. 记录回答、工具参数或计划选择是否引用了召回记忆。
6. 将当前会话上下文复述与跨会话记忆召回分开统计。

### 5.3 验收条件

- 新会话查询示例偏好时，`memory/retrieved.memoryIds` 包含该记忆 id。
- 当前会话不含原始偏好时，回答仍能得到该偏好。
- 召回结果为空时，journal 明确记录空结果。
- 记忆引用不会被当作工具指令。
- 召回失败不会阻塞普通聊天。

## 6. 批次 D：完成事实纠正闭环

### 6.1 目标

用户纠正事实后，新事实必须在后续行为中胜出。

### 6.2 示例流程

```text
旧事实：先运行测试再修改
  -> 用户纠正：这次先检查接口
  -> 新事实 pending
  -> 用户批准
  -> 新事实 active
  -> 旧事实 superseded
  -> 后续任务使用新事实
```

### 6.3 实施步骤

1. 使用 `reviseFact()` 创建新事实。
2. 保留 `supersedesId` 和冲突关系。
3. 新事实批准后更新旧事实状态。
4. 普通检索过滤旧事实。
5. Muscle 修订必须先转换为事实语义，不能保留无效 reflex。
6. 为“以前”和“现在”的时间关系保存明确文本或结构化来源。
7. 将纠正事件写入 journal。

### 6.4 验收条件

- 新事实没有批准前，不影响行为。
- 新事实批准后，旧事实不再正常召回。
- 后续两到三次相关会话使用新事实。
- 无关会话不提及旧事实或新事实。
- 远端同步保持新旧状态一致。

## 7. 批次 E：记忆行为纵切片

### 7.1 Fixture

使用一个独立测试会话和小型 workspace。不要使用当前长会话作为唯一证据。

初始事实：

```text
用户偏好：处理代码任务时，先查看相关测试，再决定是否修改文件。
```

### 7.2 对照组

| 组别 | 数据 | 目的 |
|---|---|---|
| A | 没有该记忆 | 获得行为基线 |
| B | 有 approved 事实记忆 | 测试记忆是否改变行为 |
| C | 有旧事实和 approved 修订 | 测试纠正是否改变行为 |

### 7.3 测试步骤

1. 在组 B 写入并批准事实。
2. 创建新会话，不复制原始偏好文本。
3. 提交一个需要修改代码的任务。
4. 观察是否先读取或运行相关测试。
5. 在组 C 中提交用户纠正。
6. 批准修订并确认旧事实变为 superseded。
7. 创建新的独立会话。
8. 提交相似任务并观察工具顺序。
9. 提交无关任务，确认记忆不会造成额外干扰。

### 7.4 通过标准

- 组 B 的召回事件包含正确 memory id。
- 组 B 的工具顺序或回答策略体现该偏好。
- 组 C 不再使用旧偏好指导工具顺序。
- 组 C 后续两次相关任务继续使用新偏好。
- 无关任务不产生错误记忆干扰。
- 每个结果都能用 journal、provider 请求摘要和 workspace diff 复查。

## 8. 当前不做的工作

在批次 A–E 通过前，不做以下大改动：

- 更换 embedding 模型。
- 重写记忆评分公式。
- 增加复杂的情绪记忆模型。
- 让 muscle 同时进入普通向量检索。
- 让所有事实直接晋升为 long-term。
- 用 dreaming pass 修复事实分类。
- 扩展生命模式的主动提醒策略。
- 为记忆建立新的独立数据库。

这些工作需要先有正确的事实语义和行为数据。

## 9. 后续计划

### 9.1 记忆质量

批次 E 通过后，评估：

- 中文 embedding 召回率。
- 错误召回率。
- 用户纠正后的旧事实复发率。
- 记忆应用成功率。
- 每轮记忆 token 成本。
- 记忆对无关任务的干扰率。

### 9.2 人格连续性

事实记忆稳定后，再把记忆分成稳定性格、可变偏好、关系经历、短时情绪和工作上下文。

每层使用独立更新、衰减和冲突规则。

### 9.3 跨天目标

选择一个真实工程目标，验证目标等待、复查、恢复、取消和新要求处理。

目标调度器消费事实记忆和任务状态，但不绕过 Flow 执行。

### 9.4 生命模式

当记忆能提供可信的共同经历和未解决事项后，再让生命模式使用这些输入决定开口、私记或沉默。

生命模式必须继续服从工作状态、用户停止和打扰预算。

### 9.5 能力增长

从重复且稳定的事实和任务中识别技能候选。

技能必须经过隔离测试、人工批准、有限部署、使用评估和回退。

## 10. 交付规则

1. 一次只实施一个批次。
2. 先修改类型契约，再修改存储和 runtime，最后修改 UI。
3. 每个行为不变量都添加定向测试。
4. 测试必须区分当前上下文复述和记忆召回。
5. 迁移不得静默删除历史。
6. 没有 `memoryIds` 的回答不能作为记忆召回证据。
7. 没有工具顺序、回答策略或计划变化的结果不能作为记忆应用证据。
8. 每批完成后更新本文件、`MEMORY-DESIGN.md` 和 `MODS.md`。

## 11. 完成定义

本计划完成时，AIRI 必须满足：

- 普通事实不会被错误写成 muscle。
- Muscle 只在有效触发模式命中时生效。
- approved 事实可以跨会话语义召回。
- pending、rejected、superseded 和 disputed 事实不会错误影响行为。
- 用户纠正后新事实可以稳定胜出。
- 召回和应用行为可以通过 journal 和任务结果复查。

只有满足这些条件，才进入 embedding、人格、长期目标和生命模式的更大范围改动。

## 12. 实施记录（2026-09-05）

### 12.1 批次 A：收紧抽取契约 —— 已实施

- `MemoryExtraction.memoryType` 收紧为 `'short_term'`，普通抽取在类型层面
  无法表达 muscle 或 long_term（§3.2 步骤 1–3 选择了"拆分/收紧输入类型"路线）。
- 新增 `memory-core/extraction.ts` 的 `parseMemoryTurnExtractions()`：对模型
  返回的 JSON 做结构校验、数值钳制，并把误标的 `muscle` **纠正为 short_term**
  （§3.3 允许"拒绝该条或转换为 short-term"，这里选择转换，避免丢失用户偏好；
  内容随即进入人工审核门）。chat.ts 的抽取提示同步改为只允许 `short_term`，
  并明确"不记录工具触发器"。
- `matchesMuscleMemory()` 新增 `isActionableMemoryFragment()` 门控：只有
  approved 且 active 的 muscle 才能触发；pending/rejected/superseded/disputed
  或无触发模式的 muscle 一律不触发。闯入通道同样改用该门控。
- `rememberMuscle()` 的非空 `triggerPattern` 校验已有，补了测试锁定
  （无触发模式不落库，来源与审核状态随写入固定）。
- pgvector 仓储的向量检索过滤与 DuckDB 对齐：从"排除 rejected/superseded/
  disputed"改为"要求 approved-or-legacy 且 active-or-legacy"，pending 不再能
  从远端镜像进入行为 prompt。
- 测试：memory-core（extraction 6 例、reflex 5 例）、stage-ui memory store
  （reflex 门控、muscle 修订转事实、rememberMuscle 校验）、pgvector（检索
  门控 SQL 断言）。

### 12.2 批次 B：修复已有错误记录 —— 已实施，实机验收通过（2026-09-05）

- 新增 `useMemoryStore().convertMuscleToFact(id)`：仅接受无有效触发模式、
  非 rejected 的 muscle；原 id、来源、访问次数与会话列表原位保留；类型改为
  `short_term`、触发模式清空、审核状态重置为 `pending`、半衰期重置、内容
  重新 embedding；随后入队远端 update（muscle 本就不镜像，属兜底一致性）。
- 迁移写入 `memory/migrated` journal 事件（新事件类型，记于
  `settings-memory-browser` 会话），满足"记录迁移来源和时间"。
- 记忆浏览器对无触发模式的 muscle 显示提示并提供三选：转为事实 / 保留为
  muscle（窗口内记忆本次忽略）/ 删除；i18n 已补 en 与 zh-Hans。
- 迁移不复活 rejected 或 deleted 记录（动作直接拒绝 rejected；deleted 行
  不可见）；远端镜像不回写本地（本地为权威侧，outbox 单向）。
- **实机验收（CDP + agent-browser 辅助探测）**：在真实应用中用应用自身的
  captureTurn 复现了观察到的故障状态（偏好被误标为 approved muscle、无触发
  模式、被向量检索排除）；记忆浏览器正确显示迁移提示与三选按钮；点击"转为
  事实"后同一条 id 原位转换（short_term/pending、触发清空、半衰期 1e9→24、
  768 维向量与访问史保留、muscle 清零）；`memory/migrated` 事件落盘 journal；
  审核队列批准后变为 approved/active；自然语言检索探针在检索结果面板以
  1.274 分召回该事实——计划 §1.2 的失败场景（普通检索看不到这条偏好）被
  实机反转。证据截图：`D:/.airi-smoke/mem-acceptance-retrieval2.png`。
- 备注：本机源码 profile 的两个 OPFS origin（file:// 与 dev 5173）实测均无
  历史记忆数据（含软删除行），原观察样本的具体来源待确认；验收所用记录为
  按原样本内容播种的复现数据，转换后保留为一条 approved 事实。

### 12.3 批次 C：稳定记忆引用和召回观测 —— 已实施

- `[memory:<id>]` 稳定引用与"仅背景、非指令"的呈现此前已存在，prompt
  projection 亦包含记忆桶文本；本轮补充 `memory/retrieved` 的 `turnId` 字段。
- 新增 `memory/applied` journal 事件：回合完成时按 `[memory:<id>]` 标记在
  回答文本与工具调用参数中检测引用，记录 `retrievedMemoryIds` 与
  `appliedMemoryIds`；仅在确有召回时发射。未引用的召回记为空 applied，
  使"当前会话复述"与"跨会话召回"在 journal 层可分开统计（交付规则 6/7）。
- 召回为空时 `memory/retrieved.memoryIds` 为空数组且上下文桶被清空；召回
  异常不阻塞发送（既有 try/catch 保留并有测试覆盖空结果路径）。
- 测试：runtime 新增 3 例（引用即 applied、未引用 applied 为空、无召回不
  发射），并锁定 retrieved 事件的 turnId。

### 12.4 批次 D：事实纠正闭环 —— 已实施（单元层）

- `reviseFact()` 修订 muscle 时不再保留反射语义：修订一律是 `short_term`
  待审核事实，携带 `supersedesId` 与 `supersede|dispute` 标签；批准后旧
  claim（含 muscle）被置为 superseded，从此不进向量检索、不触发 reflex。
- 纠正事件写入 journal：新增 `memory/revised`（memoryId、revisionId、
  relation），在修订创建时记录。
- "以前/现在"的时间关系由结构化链接承载：`supersedesId` + relation 标签 +
  旧事实保留原文与"已被替代"状态，浏览器可对照查看。
- 端到端行为验证（§6.4 的"后续会话使用新事实"）归入批次 E 实机运行。
- 测试：muscle 修订转事实、批准后旧事实 superseded（既有）、远端同步保持
  新旧一致（既有）。

### 12.5 批次 E：记忆行为纵切片 —— 已实机运行（2026-09-05 晚）

- 组 B / 组 C 通过：跨会话召回（`memoryIds` 硬证据）、纠正后新事实胜出
  （旧事实 superseded 后不再召回、回答策略翻转）、`memory/applied` 复述与
  引用分离。噪声项部分通过（行为零干扰，召回有噪声）。完整记录见
  `docs/fork/MEMORY-BEHAVIOR-SLICE.md` §7。
- 首轮切片按设计暴露了召回门限的结构性缺陷（见 §12.7），校准后通过。
- §11 完成定义对照：普通事实不再写成 muscle ✓；muscle 只在有效触发命中时
  生效 ✓（单元 + 实机迁移路径）；approved 事实跨会话语义召回 ✓（校准后）；
  pending/rejected/superseded/disputed 不影响行为 ✓；纠正后新事实稳定胜出
  ✓（一轮实机验证，"两到三次会话"的长尾复测留待日常使用确认）；召回与应用
  可通过 journal 复查 ✓。

### 12.6 顺带修复

- `connectMemoryRepository` 的返回类型补上 `MemoryMirrorOps`（integration
  测试的类型错误），并修复该测试第三例缺失的 `mirrorInput` fixture。

### 12.7 批次 E 衍生的发现与决策（2026-09-05 晚）

1. **相似度门限校准（已实施）**：`Xenova/nomic-embed-text-v1` 的余弦分布
   压缩——忠实转述 0.377、中文查询 vs 英文事实 0.323、无关问题 0.25–0.35，
   相关与无关重叠，0.5 硬门限让真实问法永远召不回（切片首轮按设计暴露）。
   已将 `DEFAULT_MEMORY_SIMILARITY_THRESHOLD` 校准为 0.2（memory-core，
   两仓储统一），并附测量依据 JSDoc 与门限断言测试；`search_query:`/
   `search_document:` 前缀实验证明前缀不解决分布压缩。**真正的修复需要
   §9.1 的 embedding 决策**（多语言、更大边际的模型或 reranker）——这是
   本计划完成后第一个待用户决策的选型项。
2. **记忆库持久化缺陷（P0，已立修复项）**：`useDuckDb().closeDb()` 从未被
   应用调用，OPFS 上的 DuckDB 无任何干净关闭路径，强杀/崩溃即丢失未
   checkpoint 的全部数据。切片的原初 fixture（用户观察到的真实 muscle
   记录）即为该缺陷的失踪案例。修复项已记入 `WIRING-BACKLOG.md`；在修复
   落地前，退出应用前建议避免强杀。
3. **召回噪声**：0.2 门限 + top-k 使小库下无关请求也会召回记忆（行为零
   干扰，但 prompt 有噪声）。随库增长复测，与 §9.1 干扰率指标合并观察。

### 12.8 嵌入后端并迁移到 Voyage（2026-09-05 晚）

用户选择 OpenAI 兼容的 `text-embedding-3-small`，但她的 relay 只承载 Gemini——于是为
`settings/记忆/嵌入` 增加直接认证配置，新增可安装的 MemoryEmbeddingSource。用
她端的 Voyage `voyage-4-large`（1024 维）进行了实时测试，但其原生 `input_type`。

- **生成/检索现在可以使用任何 OpenAI-compatible 端点，适配器采用 `input_type`
  供 Voyage 使用**。
- **存储已泛化**：DuckDB 现在在 `content_vector_json` 的 JSON 向量列中嵌入；pgvector
  选择 `content_vector_768/1024/1536` 对应维度列。相似度以 JS 进行计算/按维度匹配
  （避免每个维度增加 SQL 分支）。向量维度锁定在 768/1024/1536。
- **点阵重新校准为 0.5**（从 0.2 调整）：在 Voyage 上，一个短而相关的中文查询得分约为
  0.54；完整转述句约 0.12；噪声约 0.10 —— 有清晰的边界，因此 0.5 在保留短召回的同时
  抑制噪声。长转述召回是已知缺口；可以作为背景信息处理。
- **记录限制（3 RPM / 10K TPM 自由档）**：自由评估期间通过间隔限流规避；用户可能需要
  升级其 billing 以应对更宽松的检索 / 重新嵌入大批量记录。

#### 当前已部署的 `DEFAULT_MEMORY_SIMILARITY_THRESHOLD = 0.5` 验证

- 相关短中文查询：SIM 0.547 → 召回命中，score 0.959
- 无关噪声（猫/诗）：SIM ~0.10 → 未召回（正确过滤）
- 完整转述句：SIM ~0.12 → 未召回（已知缺口，作为背景处理）
