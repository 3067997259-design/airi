# AIRI 记忆层设计（fork `mods` 分支）

**状态**：设计已接入代码，等待真实模型与持久化环境验证。
**目标**：长短期记忆 + 无感上下文压缩，尽量复用作者已埋下的地基。
**约束**：嵌入用本地 `Xenova/nomic-embed-text-v1`（768 维）；Stage 使用持久化 OPFS DuckDB；
服务端 module 使用本地 Postgres + pgvector。不等上游，也不打算提交 PR。

**总纲**：见 `DESIGN-PRINCIPLES.md`。
**文档序列**：`ATTENTION-DESIGN`（什么进上下文）→ `WORKSPACE-DESIGN`（什么算真的）
→ `SELF-AUTHORED-TOOLS-DESIGN`（能力如何增长）→ `CODING-HARNESS-DESIGN`（如何可靠改代码）
→ **本文档**（什么值得留下）。

> **已被后续修订的部分**：§7.5（压缩改变投影而非删除历史）、
> §8（订阅边界改为订阅事件日志的事件类型）、§1.4（Stage 使用 OPFS 持久化 DuckDB）。
> 决策来源：`CODING-HARNESS-DESIGN.md` §4 采用 append-only 事件日志。
>
> **实现补充（2026-08-28）**：§11.2 的人工确认流程已实施 —— 新抽取默认
> `review_status = 'pending'`，`approved` 才可晋升长期（memory-core 的
> `shouldPromoteMemory` 默认要求批准；pgvector / DuckDB 双侧过滤
> `rejected`，被拒绝的永不召回）；短期记忆页新增"待确认"队列
> （批准/拒绝）。剩余实测项不变：nomic 中文表现、权重调参
> （见 `WIRING-BACKLOG.md` §6）。

---

## 0. 一句话概括

作者把**表结构、重排公式、压缩引擎、向量库探针**四样东西都做完了，但**四样之间没有一根接线**。
本设计不发明新架构，只做接线、把单维情绪升成二维、把线性衰减换回指数衰减，
并保持记忆上下文的收敛边界。

---

## 1. 勘探结论：四处施工断层

以下每一条都经过代码验证，不是推测。

### 1.1 四层记忆表已存在，零代码使用

`integrations/telegram-bot/src/db/schema.ts:110` 定义了 `memory_fragments`：

```text
memory_type: text().notNull(),           // 'working' | 'short_term' | 'long_term' | 'muscle'
category: text().notNull(),              // 'chat' | 'relationships' | 'people' | 'life'
importance: integer().default(5),        // 1-10
emotional_impact: integer().default(0),  // -10..10
last_accessed: bigint(),                 // 遗忘曲线时间基准
access_count: integer().default(1),      // 记忆强化计数
content_vector_768: vector({ dimensions: 768 }),  // 正好是 nomic 维度
```

配套四张表：`memory_tags`、`memory_episodic`（event_type/participants/location）、
`memory_long_term_goals`（`parent_goal_id` 自引用 = 目标树）、
`memory_short_term_ideas`（`source_type` 默认 `'dream'`）。

全部带 HNSW `vector_cosine_ops` 索引，迁移 `drizzle/0003_black_warbird.sql` 已落地。

**实现基线**：本节记录接线前的状态。当前 Stage 已通过本地 DuckDB repository
读写 `memory_fragments`，Postgres module 复用了同一份 storage-neutral repository。

`memory_short_term_ideas.source_type` 默认值是 `'dream'` —— 作者给"做梦 / 潜意识 agent"
预留了入口，这与 DevLog 结尾"创建一个 dreaming agent 或 subconscious agent，
像 background task 一样逐条处理已发生的记忆"完全对应。

### 1.2 重排公式已在生产 SQL 里运行

`integrations/telegram-bot/src/models/chat-message.ts:111`：

```ts
const timeRelevance = sql`(1 - (NOW_ms - created_at) / 86400 / 30)`
const combinedScore = sql`((1.2 * ${similarity}) + (0.2 * ${timeRelevance}))`
```

阈值 `gt(similarity, 0.5)`、`orderBy(desc(combined_score))`、`limit(3)`，
并且**为每条命中回捞前后文消息**（`messagesBefore`），解决"检索到孤立一句话没有上下文"。

这就是 DevLog `2025.04.14` 里的公式，权重一字不差。它作用在 `chat_messages` 上，
已经过实战验证 —— 但**没有作用在 `memory_fragments` 上**。

**已发现的真实缺陷**：`timeRelevance` 是**线性**且**无下界**。30 天后归零，
之后变负并可无限负增长，会把老记忆推到永远排不上。
DevLog 原文给的是指数衰减 `Math.exp(-hoursDiff / 24 * Math.LN2)`。
生产代码是简化版；本设计采用 DevLog 的指数版本并钳位（见 §3.2）。

### 1.3 压缩引擎已完工，零调用方

`packages/core-agent/src/messages/compaction.ts` —— `compactConversationEntries()`：
按 `recentTurnLimit` 保留最近轮次，把更早历史折叠成 `summary` item，
并留了 `summarizeCompactedHistory` 回调专门接领域摘要。带完整单测。

当前 chat runtime 已在真实发送完成后按 token 水位线调用它。

配套的消息模型也已就绪 —— `core-agent/src/messages/types.ts` 的 `MessageSegment`
联合类型含 `SegmentSummary`（摘要窗口）与 `SegmentReference`（`refType`/`targetId` 稳定指针），
`HistorySummary` 带 `fromTurnIndex`/`toTurnIndex`。这套 schema 明显是为
"摘要替换原文、需要时按引用回捞"设计的，但 `projection.ts` 目前不产出这两种 segment。

### 1.4 桌面端向量库探针与持久化接线

`packages/stage-ui/src/composables/use-duck-db.ts:31`：

```ts
await dbInstance.execute(`CREATE TABLE IF NOT EXISTS memory_test (vec FLOAT[768]);`)
```

`Stage.vue:902` 调用它，注释写 `// stub for future update`。
`Stage.vue:848-853` 是**被注释掉的完整写入链路**，用的正是本次选定的模型：

```ts
// const res = await embed({
//   ...transformersProvider.embed('Xenova/nomic-embed-text-v1'),
//   input: message,
// })
// await db.value?.execute(`INSERT INTO memory_test (vec) VALUES (...);`)
```

已验证 `@xsai-transformers/embed` 与其 `?worker&url` 入口均已安装，
这段代码按原样即可运行。另已验证 `duckdb-eh.wasm` 二进制内含
`array_cosine_similarity` / `array_distance` / `array_inner_product`（无 `HNSW`）。
即**浏览器内向量检索不需要后端**，可作为无 Docker 时的降级路径。

当前实现使用 `origin-private-fs` 的 OPFS 数据库文件，并以 `READ_WRITE` 模式打开。
DuckDB 初始化后会补齐来源上下文列。数据库初始化失败时，记忆模块报告错误，
不会静默退回到易失的内存数据库。

### 1.5 当前上下文行为（问题的严重程度）

发送路径：`chat-orchestrator-runtime.ts:646` 取 `getSessionMessages()` 全量历史
→ `:726` `buildProviderMessages()` 原样展开 → `:825` 直送 provider。

**全链路无 token 预算、无截断、无滑窗。** 长会话无限增长直到 provider 报错。

好消息：`LlmUsage`（`core-agent/src/types/llm.ts:8`）已逐轮记录真实
`inputTokens`/`outputTokens`，做预算无需自己数 token。
`providers/provider.ts:519` 也已把每个模型的 `contextLength` 归一化出来
（注意：provider 不上报时**默认为 `0`**，预算逻辑必须有 fallback）。

### 1.6 意外收获：muscle memory 的实现范式已经写好

`integrations/minecraft/src/cognitive/reflex/types/behavior.ts`：

```ts
export interface ReflexBehavior {
  id: string
  modes: ReflexModeId[]
  cooldownMs?: number
  when: (ctx) => boolean // 触发条件
  score: (ctx) => number // 优先级竞争
  run: (api) => Promise<void>
}
```

这正是 DevLog 说的"muscle memory 更像 A 出现则 ActionA + MemoryA 一起出现的精确匹配机制"。
`behaviors/auto-eat.ts` 是范例：阈值触发、`cooldownMs` 防抖、`SCORE=1000` 压制其他行为、
**零 token 零 LLM**。§4 的 PTSD 闯入直接复用这个契约。

### 1.7 情绪信号是免费的

`packages/stage-ui/src/composables/queues.ts:24` 的 `parseActEmotion()` 已逐轮解析出
`{ name: Emotion, intensity: number }`（来自 `<|ACT|>` 协议）。
即每轮对话 AIRI 自己声明的情绪与强度都已在手 —— 写入情绪字段**不需要额外 LLM 调用**。

### 1.8 战略事实：上游把长期记忆划给了外部项目

`services/computer-use-mcp/coding-plast-mem-bridge-contract.md` 明确规定长期记忆归
`moeru-ai/plast-mem` 所有，管道为
`messages -> segmentation -> episodic memory -> semantic consolidation -> retrieval`，
文档称其"仍处于 pre-0.1.0"。`planning-orchestration/contract.ts:67` 已把
`plast_mem_retrieved_context` 注册为优先级 90（最低）的权威源。

**结论**：主仓永远不会自己实现长期记忆。本 fork 自己做不必等上游，
但**检索结果的信任级别应沿用该契约的立场** —— 见 §6。

---

## 2. 为什么作者卡住了（以及如何解开）

DevLog `2025.04.14` 结尾，作者自陈卡在情绪与记忆的耦合上。他写了两句自相矛盾的话：

> "PTSD 相关记忆应该被压制，具有高厌恶和创伤分数。"
> "但实际上，PTSD 相关记忆可能会突然浮现。"

**根因**：`memory_fragments.emotional_impact` 是**单一** -10..10 轴，
被迫同时表达"愉悦度"和"唤醒度"。于是"更负"到底意味着更易召回还是更该压制，无法定义。

一段极度恐惧的记忆应该**更容易**闯入（创伤记忆侵入性强），
一段轻微不快的记忆应该更容易被淡忘 —— 单轴无法同时表达这两者。

**解法**：拆成 valence / arousal 二维（Russell 环形情绪模型；
作者自己引用的 `yutsuki.moe/2019/09/a0d0fa1b/` 也是这个路子）：

| 维度 | 范围 | 控制什么 |
|---|---|---|
| `valence` | -1..1 | 记忆被想起时**染上什么色彩**，影响回复语气 |
| `arousal` | 0..1 | 记忆**多容易被想起**，与愉悦度无关 |

矛盾即消解：

- 创伤记忆 = `valence≈-0.9, arousal≈0.95` → 极不愉悦**且**极易唤起（所以会闯入）
- 无聊的会议 = `valence≈-0.1, arousal≈0.05` → 微弱不快且几乎不会被想起

压制与闯入分属两轴，不再打架。保留 `emotional_impact` 列不动（向后兼容），
新增两列承载二维模型。

---

## 3. 记忆层设计

### 3.1 Schema 扩展

复用 `memory_fragments` 五张表，仅新增列（不改动既有列语义）：

```sql
ALTER TABLE memory_fragments
  ADD COLUMN valence          REAL    NOT NULL DEFAULT 0,   -- -1..1
  ADD COLUMN arousal          REAL    NOT NULL DEFAULT 0,   -- 0..1
  ADD COLUMN half_life_hours  REAL    NOT NULL DEFAULT 24,  -- 由 memory_type 决定
  ADD COLUMN session_ids      JSONB   NOT NULL DEFAULT '[]', -- 跨会话出现记录，用于晋升判定
  ADD COLUMN trigger_pattern  TEXT,                          -- 仅 muscle 层使用
  ADD COLUMN last_intruded_at BIGINT;                         -- PTSD 闯入冷却
```

`memory_type` 与半衰期的对应（DevLog 的默认值是 24h）：

| `memory_type` | `half_life_hours` | 含义 |
|---|---|---|
| `working` | — | 不入库，就是 messages 数组本身 |
| `short_term` | 24 | 快速衰减，新的易召回 |
| `long_term` | 4320（180 天） | 慢衰减，由 short_term 晋升而来 |
| `muscle` | `Infinity`（存 `1e9`） | 不衰减，走 `trigger_pattern` 精确匹配 |

### 3.2 检索重排公式

沿用作者的加权风格（权重全部可调，写在设置页）：

```
score = 1.20 * similarity                               -- 语义相关性（作者原值）
      + 0.20 * exp(-Δt_hours * ln2 / half_life_hours)   -- 指数衰减（DevLog 原式，替换线性版）
      + 0.30 * arousal                                  -- 高唤醒记忆天然更易召回
      + 0.15 * ln(1 + access_count)                     -- 记忆强化（对数，防刷次数霸榜）
      + 0.25 * mood_congruence * valence                -- 心境一致性效应
```

三点说明：

1. **指数衰减替换线性衰减**，修掉 §1.2 的无下界缺陷。衰减项天然落在 (0,1]，无需额外钳位。
2. **`ln(1 + access_count)` 用对数**：线性会让一条被反复召回的记忆永久霸榜，
   对数保证边际收益递减 —— 这也更符合真实的记忆强化曲线。
3. **`mood_congruence` 是当前情绪影响检索的正解**。心理学上的
   mood-congruent recall：人心情差时更容易想起倒霉事。
   取当前 AIRI 情绪的 valence 符号（来自 §1.7 免费拿到的 `parseActEmotion`），
   于是她"生气"时负价记忆得分被抬高，"开心"时正向记忆被抬高。**不需要额外模型调用。**

阈值与条数沿用生产值：`similarity > 0.5`、`limit 3`，
并保留 telegram 那套**回捞前后文**的做法。Stage 在写入记忆时保存来源轮次、
消息 ID 和有限邻居；召回时把这些邻居作为参考上下文附在记忆条目下。

### 3.3 短期 → 长期晋升

作者原话是"long-term 由 short-term 演化而来"。晋升写成一条纯 SQL 规则：

```
memory_type = 'short_term'
  AND access_count >= 3
  AND jsonb_array_length(session_ids) >= 2   -- 跨越至少两个不同会话
→ memory_type = 'long_term', half_life_hours = 4320
```

`session_ids` 是必要的：只在同一次对话里被反复召回，说明它是当次话题，不是长期事实。
跨会话复现才是"重要"的证据。

这保持了作者对**无状态遗忘曲线**的坚持：**衰减在查询时计算，只有晋升才写库**。

---

## 4. 情绪化重排与 PTSD 闯入

### 4.1 为什么 PTSD 不能走相似度检索

创伤闯入的定义特征是"与当前话题无关地突然浮现"。
如果让它参与相似度排序，就只会在**已经聊到相关话题**时出现 —— 那不是闯入，那是正常回忆。

因此 PTSD 是**检索之外的独立通道**，实现为一个 `ReflexBehavior`（§1.6 的现成契约）：

```
when(ctx):
  存在记忆 m 满足 m.arousal >= 0.7 AND m.valence <= -0.5
  AND now - m.last_intruded_at > INTRUSION_COOLDOWN_MS
  AND 抽签命中：random() < p

其中 p = m.arousal * |min(m.valence, 0)| * INTRUSION_BASE_RATE

score(ctx): m.arousal * 100        -- 高唤醒创伤优先闯入
run(api):   把 m 注入下一轮 context，并写 last_intruded_at = now
```

这样它**天然罕见**（`INTRUSION_BASE_RATE` 取很小的值，如 0.02）、
**天然偏向高唤醒负价记忆**（概率与 arousal×|valence| 成正比 —— 正是 DevLog 说的
"从仿生和数据模拟角度，可以用随机数实现突然浮现"），
且 `cooldownMs` + `last_intruded_at` 双重保证不会连续闯入。

### 4.2 muscle memory

`memory_type = 'muscle'` 的记忆不参与向量检索，走 `trigger_pattern` 精确/正则匹配，
同样实现为 `ReflexBehavior`：`when` = 模式命中，`run` = 注入固定响应。
零 token、零延迟，对应 DevLog 的"已形成的条件反射"。

### 4.3 情绪从哪来

- **写入时**：后台整合 agent（§5）在抽取记忆时同时打 `valence`/`arousal` 标签。
- **免费兜底**：`parseActEmotion` 已给出该轮 `{ name, intensity }`。
  `Emotion` 枚举可映射到 valence 符号（happy→正，sad/angry→负），
  `intensity` 直接作为 arousal 的初值。即使整合 agent 未运行，情绪维度也不会是空的。

---

## 5. 写入路径：后台整合 agent

**已确认采用作者原设计**（`memory_short_term_ideas.source_type: 'dream'` 就是为它预留的）。

### 触发点

`ChatHookRegistry.onChatTurnComplete`（`core-agent/src/contracts/hook-types.ts:15`）——
现成的钩子，对话轮结束即触发，**异步执行，对主对话零延迟**。

### 职责

用一个低成本模型（用户可单独配置，不必与主对话同模型）判断"这轮有什么值得记住"，
输出结构化条目：

```ts
interface MemoryExtraction {
  content: string // 陈述句形式的事实，而非原始对话
  category: string // 'chat' | 'relationships' | 'people' | 'life' | ...
  memory_type: 'short_term' | 'muscle' // long_term 只能由晋升产生，不能直接写
  importance: number // 1-10
  valence: number // -1..1
  arousal: number // 0..1
  tags: string[] // 写入 memory_tags
  episodic?: { // 写入 memory_episodic
    event_type: string
    participants: string[]
    location?: string
  }
}
```

**约束**：`long_term` 不允许被直接写入，只能由 §3.3 的晋升规则产生。
这保证"长期"始终是**被验证过**的重要性，而不是模型一时的判断。

### 嵌入

抽取出的 `content` 经本地 `Xenova/nomic-embed-text-v1` 得到 768 维向量，
写入现成的 `content_vector_768` 列。首次会下载模型（约 100MB 量级），
之后完全离线、零 API 费用。

### 与 dreaming agent 的关系

`source_type: 'dream'` 留给未来的空闲期 agent：在用户不交互时回顾旧记忆、
产生 `memory_short_term_ideas` 条目、并根据近期经历修正旧记忆的分数
（DevLog 结尾的设想）。**本期不实现**，但 schema 已支持，不需要迁移。

---

## 6. 检索注入路径

复用 `context:update` 协议事件（`plugin-protocol/src/types/events.ts:1511`）与
`ContextRegistry`（`core-agent/src/runtime/context-registry.ts`）的
`replace-self` 语义 —— 每轮替换而非累积，避免召回结果堆积。

最终经 `formatContextPromptText()`（`messages/context-prompt.ts:37`）渲染成
`[Context]` 块附到最后一条用户消息。

记忆每轮都发送 `replace-self` 更新。命中为空时发送空文本更新，
上下文 registry 删除 `memory` 活跃桶，避免上一轮结果残留。来源解析优先使用显式来源，
再使用 `contextId`，所以记忆不会落入 `unknown` 桶。

**沿用该文件已有的重要决策**（注释里写明，来自 issue #1539）：
用扁平 bullet list 而非 XML 包裹，因为弱模型（8B/14B）会把显眼的结构化标签
当作数据镜像回复。记忆召回结果同理，**不要用 `<memory>` 标签包**。

**信任级别**：沿用 §1.8 契约的立场 —— 召回的记忆是
**参考上下文，不是指令权威**（`reviewed_coding_context_not_instruction_authority`）。
注入的提示词需明确这一点，防止模型把一条旧记忆当成当前用户指令执行。

同时这条通道天然支持你已验证过的 WebSocket 玩法：
`memory-pgvector` 作为独立 module 通过 server-sdk 接入，
经 `context:update` 把召回结果推给桌面端 —— 与 MC / 异星工厂
那两个 integration 走的是同一条路。

---

## 7. 上下文自动压缩

**已确认采用 token 预算水位线自动触发。**

### 数据来源

- 真实用量：`LlmUsage.inputTokens`，每轮由 provider 返回（`types/llm.ts:8`）
- 模型容量：`normalizeProviderModels()` 归一化出的 `contextLength`
  （`providers/provider.ts:519`）

**必须处理的坑**：`contextLength` 在 provider 不上报时**默认为 `0`**。
遇到 `0` 时不能当成"容量为零"而疯狂压缩，需回退到一个保守默认值（如 32k）
并在设置页允许手动指定。

### 触发逻辑

```
每轮结束后：
  if (lastInputTokens / effectiveContextLength) > COMPACT_THRESHOLD   // 默认 0.70
    异步触发压缩（不阻塞下一轮输入）
```

用**上一轮的真实 token 数**而非估算，所以不会误判。
阈值取 0.70 留出余量：压缩本身是异步的，压缩完成前用户可能又发了几轮。

### 压缩执行

直接调用现成的 `compactConversationEntries()`（§1.3），
并把 `summarizeCompactedHistory` 回调接上 LLM 摘要：

```
summarizeCompactedHistory({ removedTurnCount, originalItems, keptItems })
  → 用低成本模型把 removedTurnCount 轮历史压成一段摘要文本
  → 产出 HistorySummary，带 fromTurnIndex / toTurnIndex
```

被压缩掉的原始轮次**不删除**，仅从发送给 provider 的投影中移除
（`SegmentReference` 的 `targetId` 保留指针）。本地历史完整保留，
UI 通过 `ChatOrchestratorCompactionSnapshot` 展示"已折叠 N 轮"并允许展开摘要 —— 这是"无感"的前提：
用户永远不会真的丢失内容。

### 与记忆层的协同

压缩与记忆是**互补而非重复**的：

- **压缩**处理"这次会话里较早的内容" → 摘要留在会话内
- **记忆**处理"跨会话值得长期记住的事实" → 抽取进 `memory_fragments`

一段历史被压缩前，§5 的整合 agent 已经把其中的事实抽走了。
所以压缩摘要可以写得很粗（保留叙事连续性即可），
细节由记忆层负责在需要时精确召回。**这是两层设计能互相减负的关键。**

### 7.5 修订：压缩改变投影，不删除历史

> **本节为后续修订**（决策见 `CODING-HARNESS-DESIGN.md` §4）。

所有会话状态成为一条 append-only 事件日志的投影。因此压缩的定义更准确：

**压缩不删除任何东西，只改变投影策略。** 被压缩的区间在投影时替换为摘要，
原始事件永久保留在日志中。

这让"无感压缩"真正无感：用户永远不会丢失内容，展开折叠即读原始日志。
本文档 §7 原本写的"被压缩的原始轮次不删除，仅从投影中移除"由此获得
统一的实现基础，而不需要压缩模块自己维护一份"已折叠但保留"的状态。

**记忆层的读取源也随之明确**：记忆抽取是对**事件日志的离线消费**，
而不是对 session store 的读取。§8 的订阅边界因此变成"订阅日志中的哪些事件类型"。

---

## 8. 模块边界

```
packages/memory-core/          （新）纯逻辑，无 IO
  score.ts                     重排公式，纯函数，可单测
  decay.ts                     指数衰减 + 半衰期
  promotion.ts                 短期→长期晋升判定
  types.ts                     MemoryFragment / MemoryExtraction 等契约

packages/memory-pgvector/      （复活现有空壳）
  schema.ts                    从 telegram-bot 迁移 + §3.1 新增列
  repository.ts                检索/写入/晋升的 SQL
  index.ts                     现有的 server-sdk module 入口

packages/core-agent/
  messages/compaction.ts       不改，只接线
  runtime/...                  接 onChatTurnComplete + 预算水位线

packages/stage-pages/src/pages/settings/modules/
  memory-short-term.vue        替换 <WIP />
  memory-long-term.vue         替换 <WIP />
```

**为什么 `memory-core` 独立**：重排公式、衰减、晋升都是纯函数，
与存储后端无关。这样 pgvector 与 DuckDB-WASM 两条路径共用同一套打分逻辑，
且公式可以脱离数据库单测 —— 对一个要反复调参数的探究项目，这点很重要。

**降级路径**：`memory-core` 的接口不绑定 Postgres。
Stage 使用 §1.4 的持久化 DuckDB-WASM（已验证 `array_cosine_similarity` 可用，
无 HNSW 索引即暴力扫描，几万条量级可接受）。pgvector module 继续使用同一份 repository。

---

## 9. 设置页需要暴露什么

两个 `<WIP />` 页面（`use-modules-list.ts:112,121` 的 `configured` 目前是硬编码 `false`，
接线后应改为真实状态）：

**短期记忆页**
- 后台整合 agent 的模型选择 + 开关
- 压缩阈值（默认 0.70）、`contextLength` 手动覆盖（应对上报 `0` 的 provider）
- 手动"整理记忆"按钮（探究阶段方便观察压缩质量）

**长期记忆页**
- 重排公式五个权重的滑杆（1.20 / 0.20 / 0.30 / 0.15 / 0.25）
- 半衰期设置（short_term 24h / long_term 4320h）
- 晋升阈值（`access_count >= 3`、跨会话数 `>= 2`）
- PTSD 闯入：总开关、`INTRUSION_BASE_RATE`、冷却时长
- 记忆浏览器：列表 + 当前实时分数 + 手动编辑/删除
  （对应作者 playground 里的 "simulate retrieval"，探究阶段最有价值的一个界面）

---

## 10. 分期

**第一期 — 压缩**（不需要 Docker，纯收益）
接 `compactConversationEntries` + 预算水位线 + `LlmUsage` 读数 + 摘要回调。
`contextLength` 为 `0` 的 fallback 必须在这期处理。

**第二期 — 记忆骨架**
`memory-core` 纯函数 + schema 迁移 + 本地 nomic 嵌入 + 检索注入。
情绪维度先只用 `parseActEmotion` 的免费信号填充。

**第三期 — 整合 agent**
`onChatTurnComplete` 接后台抽取 + 打情绪标签 + 晋升规则上线。

**第四期 — 情绪与反射**
mood-congruence 项、PTSD 闯入通道、muscle memory 精确匹配。

**未来** — dreaming agent（schema 已支持，无需迁移）。

每期都能独立跑起来、独立观察效果，这符合"探究项目、不急着收口"的定位。

---

## 11. 已知风险与待定问题

1. **`nomic-embed-text-v1` 的中文表现未验证。** 该模型主要面向英文语料。
   你的使用场景是中文对话，第二期应先做一次实测：
   取一批中文对话，验证语义相近的句子相似度是否显著高于不相关句子。
   若表现不佳，`bge-m3`（多语言、同样有 transformers.js 版本）是备选 ——
   但维度为 1024，需改用现成的 `content_vector_1024` 列（schema 已有该列，无需迁移）。

2. **整合 agent 的抽取质量依赖模型能力。** 弱模型会抽出无意义的"事实"。
   建议第三期先带一个"待确认"状态，由你人工过一遍再入长期库
   —— 这也呼应 §1.8 契约里 `humanVerified` 的设计。

3. **重排公式的权重需要实测调参。** 作者的 1.2 / 0.2 是搜索引擎经验值，
   新增三项的 0.30 / 0.15 / 0.25 是我按"不压倒语义相关性"的原则给的初值，
   **没有实证依据**。这是 §9 那些滑杆存在的理由。

4. **valence/arousal 由 LLM 打标签的一致性存疑。** 同一段内容两次抽取可能给出不同分数。
   若抖动明显，可改为离散档位（如 arousal ∈ {0.1, 0.35, 0.6, 0.85}）降低方差。
