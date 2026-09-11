# AIRI 记忆检索与持久化路线计划

日期：2026-09-05。
状态：已实施（2026-09-06）。
范围：`packages/stage-ui`、`packages/memory-core`、`packages/memory-pgvector`、`apps/stage-tamagotchi`，以及记忆评估和文档。

实施记录：

- 批次 A：DuckDB 增加 checkpoint、关闭生命周期、失败状态、OPFS leader-only 保护和设置页状态显示；所有本地记忆写入在完成后确认 checkpoint。
- 批次 B：本地 DuckDB 和 pgvector 增加 provider、model、dimensions、input type、fingerprint、embeddedAt、status 元数据；查询只接受当前 active document 向量；切换 source 时按 20 条一批迁移，保存断点，并提供 `reembedMemoryVectors()` 和设置页按钮。
- 批次 C：长查询使用原始 query 和机械归一化 query 双路召回，按 memory id 去重并取最大相似度；journal 保留两路分数和查询路径。
- 批次 E：增加 9 个 strata、每组 10 条的评估 fixture，并扩展 precision、误召回率、token 成本和额外延迟指标。
- 批次 D、F：多视图内容和 reranker 仍未实施，保留在后续评估范围内。

验证记录：

- memory-core 类型检查和 32 条单元测试通过。
- stage-ui、stage-pages、stage-tamagotchi、memory-pgvector 类型检查通过；stage-ui node 项目 140 个测试文件、873 条测试通过。
- memory-pgvector 单元测试 5 条通过；Docker Postgres integration 4/4 通过，见 [MQ-0 Postgres 证据](./evidence/mq-0/postgres-integration-20260907.md)。
- 全仓 lint 无 error；仓库已有 warning 保持不变。
- Electron 构建版按指定命令使用默认用户 profile `C:\Users\86130\AppData\Roaming\@proj-airi\stage-tamagotchi` 通过 CDP 9250 启动；agent-browser 验收确认 provider 配置、长期记忆设置页和本地 DuckDB 旧表迁移可用。
- 真实对话已成功到达 `openai-compatible` provider 并返回 `provider-ok`；随后询问已有长期记忆对应的偏好，模型回答“跑相关测试”，确认 provider 对话可以读取该 profile 的记忆上下文。
- 正确 profile 中的验收启动约束已由记忆浏览器确认晋升为 `long_term`，状态为 `approved`，累计 3 次访问、2 个会话；旧的“验收应使用独立干净 profile”测试记忆已删除，避免和当前规则冲突。

## 验收启动约束

构建完成后，必须在 PowerShell 中从 `D:\airi\apps\stage-tamagotchi` 启动带 CDP 的 Electron 实例：

```powershell
cd D:\airi\apps\stage-tamagotchi
$env:SERVER_CHANNEL_PORT='6221'
.\node_modules\electron\dist\electron.exe . --remote-debugging-port=9250
```

验收默认使用已有用户 profile：`C:\Users\86130\AppData\Roaming\@proj-airi\stage-tamagotchi`。该 profile 提供 provider 配置和用户 journal，agent-browser 才能完成真实 provider 对话和记忆检索验收。不要为本验收设置 `APP_USER_DATA_PATH` 或 `--user-data-dir` 指向隔离实例；隔离 profile 只适用于不需要真实 provider、journal 或用户配置的独立测试。

## 0. 结论

Voyage4large 已经改善了短查询的记忆召回和噪声过滤。

当前主要问题已经从“embedding 模型太弱”转为三类问题：

1. DuckDB 没有可靠的关闭和 checkpoint 路径。
2. 长文段复述与短事实之间的向量相似度过低。
3. 记忆向量缺少来源和版本信息，模型切换后的迁移边界不清楚。

因此，下一阶段先修存储可靠性和向量生命周期，再优化长查询召回。

不要通过降低阈值来解决长查询问题。降低阈值会重新引入无关记忆。

## 1. 现状证据

### 1.1 记忆行为纵切片

`docs/fork/MEMORY-BEHAVIOR-SLICE.md` 已完成组 B 和组 C：

- approved 事实可以跨会话召回。
- 召回事实可以改变回答策略。
- 用户修订后，新事实会替代旧事实。
- 无关任务的回答没有出现明显的记忆行为干扰。
- journal 可以记录 `memory/retrieved` 和 `memory/applied`。

这证明事实记忆已经具备最小行为闭环。

### 1.2 Nomic 基线

应用原有的 `nomic-embed-text-v1` 在中文和英文转述上的余弦分布较窄：

- 忠实英文转述约为 `0.377`。
- 中文查询对英文事实约为 `0.323`。
- 无关查询约为 `0.25–0.35`。

原来的 `0.5` 硬阈值会拒绝真实相关查询。该阈值曾临时校准为 `0.2`。

### 1.3 Voyage4large 结果

Voyage4large 的实测结果为：

- 短而相关的中文查询约为 `0.547`。
- 无关噪声约为 `0.105`。
- 完整长转述约为 `0.12`。

当前 `0.5` 阈值可以保留短查询并过滤噪声。

长转述分数低，更可能表示查询文本过长，包含了超出事实本身的背景信息。

## 2. 设计边界

### 2.1 记忆向量的来源必须可见

每条向量记录必须能回答以下问题：

- 使用了哪个 provider？
- 使用了哪个 model？
- 使用了哪个维度？
- 该向量何时生成？
- 向量代表文档还是查询？

建议保存：

```text
embeddingProvider
embeddingModel
embeddingDimensions
embeddedAt
```

不要只根据向量长度判断来源。不同模型可以使用相同维度。

### 2.2 文档向量和查询向量必须分开

Voyage 的调用必须使用：

```text
memory document -> input_type: document
user query      -> input_type: query
```

所有历史记忆必须用当前 active embedding source 重新生成后，才可以参与新的检索。

禁止混合使用 nomic 文档向量和 Voyage 查询向量。

### 2.3 长查询不能直接降低阈值

长查询包含任务背景、时间、约束和礼貌表达。这些内容会稀释它与一条短事实之间的向量相似度。

系统应先提取检索意图，再进行召回。

## 3. 批次 A：修复 DuckDB 持久化

### 3.1 目标

保证记忆在正常关闭、重启和应用异常退出后不会静默丢失。

### 3.2 代码入口

- `packages/stage-ui/src/composables/use-duck-db.ts`
- `packages/stage-ui/src/stores/modules/memory.ts`
- `apps/stage-tamagotchi/src/renderer/main.ts`
- `apps/stage-tamagotchi/src/renderer/App.vue`

### 3.3 实施步骤

1. 暴露 DuckDB 的明确 `closeDb()` 生命周期。
2. 在 renderer 卸载和应用退出路径调用关闭操作。
3. 在关闭前完成待写 SQL 和事务提交。
4. 让数据库关闭失败进入可见的持久化状态。
5. 防止多个 renderer 同时持有同一 OPFS 数据库句柄。
6. 对记忆写入增加 checkpoint 或等价的完成确认。
7. 让 memory browser 显示数据库状态和未完成写入数量。

### 3.4 验收条件

- 写入 approved 记忆后正常关闭应用，重启仍能读取。
- 写入后立即重启，已确认的记录不会丢失。
- 模拟关闭失败时，UI 显示错误状态。
- 多窗口不会出现第二个同步句柄冲突。
- 记忆行为切片在重启前后仍然通过。

## 4. 批次 B：补齐 embedding 生命周期

### 4.1 目标

让系统知道每条向量是否能与当前 embedding source 一起使用。

### 4.2 实施步骤

1. 为本地和远端记忆增加 embedding source 元数据。
2. 统一 provider、model、dimensions 和 input type。
3. 写入记忆时使用 `document` input type。
4. 查询时使用 `query` input type。
5. 切换 embedding source 时标记旧向量为 stale。
6. 检索时过滤维度或来源不匹配的向量。
7. 提供显式的重新嵌入命令。
8. 重新嵌入过程使用有界批次和断点状态。
9. 重新嵌入失败时保留旧向量，但禁止混合排序。

### 4.3 验收条件

- Nomic 和 Voyage 向量不会混合参与同一次搜索。
- 维度不匹配的记录不会导致运行时错误。
- 重新嵌入中断后可以继续。
- 重新嵌入完成后旧向量不再被使用。
- DuckDB 和 pgvector 返回相同的候选集合边界。
- Voyage 文档向量和查询向量使用正确的 `input_type`。

## 5. 批次 C：实现长查询归一化

### 5.1 目标

让长文段中的核心事实可以召回，而不降低噪声过滤能力。

### 5.2 第一版方案：双路查询

每次检索生成两条查询：

```text
original query
  -> query embedding

normalized retrieval query
  -> query embedding
```

例如：

```text
原始查询：
我这次在修改 Student Hub 的接口之前，想先看一下现有测试，避免改完以后才发现协议已经变了。

归一化查询：
用户偏好修改接口前先检查测试和协议。
```

### 5.3 实施步骤

1. 先实现机械归一化规则，去除礼貌语、时间背景和无关任务细节。
2. 保留原始查询作为第一路召回。
3. 为归一化查询生成第二路向量。
4. 合并两路候选并按 memory id 去重。
5. 第一版使用两路分数的最大值。
6. 保留两路分数供诊断。
7. 归一化失败时继续使用原始查询。

### 5.4 验收条件

- 短中文查询继续命中。
- 长中文转述可以命中同一事实。
- 无关长文本不会因为降低阈值而大量命中。
- 两路候选集合可在 journal 中复查。
- 归一化不会删除用户的否定条件。
- 归一化不会把任务指令变成记忆事实。

## 6. 批次 D：多视图记忆内容

### 6.1 目标

让一条事实同时适合检索、展示和审阅。

### 6.2 建议字段

```text
content
retrievalSummary
keywords
sourceContext
```

`content` 是用户可读事实。`retrievalSummary` 是短的事实检索句。
原始对话仍然保存在 `sourceContext`，不直接作为主要嵌入文本。

### 6.3 验收条件

- 短查询和长查询都能命中同一事实。
- UI 不显示内部向量文本。
- 摘要不会改变事实原意。
- 用户修订后摘要同步更新。
- 旧事实的摘要不会继续参与检索。

## 7. 批次 E：扩展评估集

### 7.1 数据分层

至少加入：

- 短中文查询。
- 长中文转述。
- 英文查询对中文事实。
- 中文查询对英文事实。
- 否定句。
- 多事实长文本。
- 时间变化事实。
- 无关长文本。
- 相似但错误的事实。

每个 strata 至少准备 10 个 query，并保存 gold memory ids。

### 7.2 指标

- `recall@3`
- `MRR@3`
- `precision@3`
- 长查询召回率。
- 无关查询误召回率。
- superseded 事实复发率。
- 查询 token 成本。
- 归一化额外延迟。

整体平均值不能掩盖某一类完全失败。

## 8. 批次 F：只有证据充足后才评估 reranker

不要现在直接加入 reranker。

只有在持久化修复、向量迁移、双路查询和分层评估全部完成后，才评估：

```text
dual query retrieval
  -> merge and deduplicate
  -> optional reranker
  -> active approved filter
  -> bounded prompt projection
```

reranker 必须有独立的延迟、成本和误召回评估。

## 9. 当前可以立即做的工作

1. 修复 DuckDB `closeDb()` 和 checkpoint 生命周期。
2. 增加 embedding source 元数据和 stale 向量过滤。
3. 确认 Voyage `document/query` input type 和历史迁移流程。
4. 建立长查询与无关长文本评估 fixture。
5. 实现机械查询归一化和双路召回。
6. 重新运行 `MEMORY-BEHAVIOR-SLICE` 的组 B、组 C 和噪声项。
7. 结果稳定后，再决定是否加入多视图记忆内容。

## 10. 当前不要做的工作

在批次 A–E 完成前，不做：

- 继续降低 Voyage 的 `0.5` 阈值。
- 把所有长文本直接截断成固定前缀。
- 立即引入 reranker。
- 同时更换 embedding 模型和排序公式。
- 让 `muscle` 进入普通向量检索。
- 让无关召回进入人格或生命模式 prompt。
- 用一次总体平均分决定生产权重。

## 11. 后续方向

### 11.1 记忆质量

完成分层评估后，继续处理召回噪声、记忆应用率、旧事实复发、时间变化和 token 成本。

### 11.2 人格连续性

事实召回稳定后，再区分稳定性格、可变偏好、关系经历、短时情绪和工作上下文。

### 11.3 跨天目标

选择一个真实工程目标，连接记忆、Flow 和长期调度，支持等待、复查、暂停、取消、恢复和新要求。

### 11.4 生命模式

当记忆可以可靠提供近期经历和未解决事项后，再让生命模式使用这些信息决定开口、私记或沉默。

### 11.5 能力增长

从稳定重复的目标和任务中提取技能候选，并经过隔离测试、人工审核、有限部署、使用评估和回退。

## 12. 完成定义

- 记忆数据库在正常退出和重启后保持完整。
- 每条向量有明确来源、模型和维度。
- Voyage 文档向量和查询向量使用正确 input type。
- 长查询可以通过归一化路径召回相关事实。
- 无关长文本不会依赖低阈值进入 prompt。
- superseded 事实不会重新出现。
- 评估结果按 strata、成本和延迟记录。
- 是否使用 reranker 有可复查的实验依据。
