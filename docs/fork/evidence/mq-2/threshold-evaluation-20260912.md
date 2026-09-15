# MQ-2 步骤 5：可见性与阈值对照评估（2026-09-12）

## 目的

本报告回答两个问题，并给出前后证据：

1. 1c 可见性修复（链接 `local` 历史）对召回的影响。
2. `DEFAULT_MEMORY_SIMILARITY_THRESHOLD` 是否应从 0.5 下调。

按 MQ-2 规范 D2 规则，阈值策略属于需用户确认的决策。本报告只给证据与建议，产品默认值未改。

## 方法

- **夹具**：`docs/fork/evidence/mq-0/gold-corpus.md` 的 20 条事实。每条事实写为一条双语 content（zh 与 en 合并），`reviewStatus: approved`、`factStatus: active`、`originId: fact-*`。写入隔离作用域 `{ userId: 'local', characterId: 'mq2-eval' }`。该作用域只有 gold 事实，没有其他记忆。
- **评测器**：`evaluateProductionRetrieval` 调用 MQ-0 的 90 条用例（`MEMORY_RETRIEVAL_EVALUATION_CASES`），k = 3，`evaluationMemoryId = originId`。
- **评估作用域**：`{ userId: <当前认证 id>, characterId: 'mq2-eval' }`；每次运行使用独立会话标签 `mq2-eval-20260912-<配置>`。
- **配置**：
  - A：`linkLocalHistory = false`，阈值 0.5（1c 前基线）。
  - B：`linkLocalHistory = true`，阈值 0.5（1c 效果）。
  - C：链接，阈值 0.35（D2 候选 c）。
  - D：链接，阈值 0.42（补测的中间点）。
  - E：链接，阈值 0.40（补测的中间点）。
- **计量**：recall@3、precision@3、MRR@3、falsePositiveRate@3（返回项中非相关项的比例），并按 9 个 stratum 分层。
- **评测 seam**：`retrieve`、`retrieveEvaluationTrace`、`evaluateProductionRetrieval` 增加可选 `similarityThreshold`。只有评测路径使用该参数。
- **复现**：经 CDP 调用 store；每配置约 80 秒。注入用 `captureTurn` + 自定义 extractor，一次写入 20 条。
- **清理**：评估后删除 20 条事实，隔离作用域剩余 0 条；`linkLocalHistory` 复位为默认 true。

## 结果

表 1：总体指标（k = 3）。

| 配置 | 可见性 | 阈值 | recall@3 | precision@3 | MRR@3 | 误召回@3 |
|---|---|---|---|---|---|---|
| A | 严格 scope | 0.5 | 0.000 | 0.000 | 0.000 | 0.000 |
| B | 1c 链接 | 0.5 | 0.778 | 0.259 | 0.772 | 0.078 |
| D | 1c 链接 | 0.42 | 0.944 | 0.315 | 0.922 | 0.144（fp 用例 36/90） |
| E | 1c 链接 | 0.40 | 0.956 | 0.319 | 0.933 | 0.185（fp 用例 45/90） |
| C | 1c 链接 | 0.35 | 1.000 | 0.333 | 0.967 | 0.274 |
| MQ-0 参考（2026-09-07） | local 直连 | 0.5 | 0.789 | 0.263 | 0.637 | 0.626（隔离条件不同） |

表 2：分层 recall（每层 10 例）。

| stratum | B (0.5) | D (0.42) | E (0.40) | C (0.35) |
|---|---|---|---|---|
| short-zh | 0.9 | 1.0 | 1.0 | 1.0 |
| long-zh | 0.9 | 1.0 | 1.0 | 1.0 |
| en-to-zh | 0.6 | 1.0 | 1.0 | 1.0 |
| zh-to-en | 0.7 | 0.9 | 0.9 | 1.0 |
| negation | 0.9 | 0.9 | 0.9 | 1.0 |
| multi-fact | 0.8 | 1.0 | 1.0 | 1.0 |
| temporal | 0.7 | 0.9 | 1.0 | 1.0 |
| unrelated-long | 1.0 | 1.0 | 1.0 | 1.0 |
| near-miss | 0.5 | 0.8 | 0.8 | 1.0 |

表 3：分层误召回。

| stratum | B (0.5) | D (0.42) | E (0.40) | C (0.35) |
|---|---|---|---|---|
| short-zh | 0.100 | 0.200 | 0.300 | 0.300 |
| long-zh | 0.133 | 0.133 | 0.200 | 0.367 |
| en-to-zh | 0.067 | 0.200 | 0.200 | 0.233 |
| zh-to-en | 0.033 | 0.133 | 0.200 | 0.300 |
| negation | 0.100 | 0.200 | 0.233 | 0.333 |
| multi-fact | 0.133 | 0.233 | 0.267 | 0.367 |
| temporal | 0.067 | 0.100 | 0.133 | 0.267 |
| unrelated-long | 0.000 | 0.000 | 0.000 | 0.033 |
| near-miss | 0.067 | 0.100 | 0.133 | 0.267 |

## 观察

1. **1c 是主修复**：A → B，recall 0 → 0.778。阈值不变，只开可见性链接。这确认 scope drift 是空回答的主因（与增量 1 归因一致），阈值是次因。
2. **0.5 的损失集中在跨语言与近义层**：B 的 en-to-zh 为 0.6、zh-to-en 为 0.7、near-miss 为 0.5。这些用例使用语义改写，不是词面重叠。
3. **0.42 回收大部分损失，代价低**：D 的 recall 为 0.944（比 B 高 0.167），误召回为 0.144（比 B 高 0.066）。near-miss 召回升到 0.8。
4. **0.35 的边际收益不成立**：C 相比 D，recall 仅高 0.056，误召回高 0.13（0.144 → 0.274，接近翻倍）。near-miss 误召回从 0.100 升到 0.267，multi-fact 从 0.233 升到 0.367。
5. **0.40 被 0.42 支配**：E 的 recall 更高（0.956 对 0.944），但误召回也更高（0.185 对 0.144）。曲线在 0.40–0.42 之间回折，0.42 是更优点。
6. **隔离作用域让误召回偏低**：本次作用域只有 20 条 gold。真实 profile 的干扰记忆更多，误召回会更高。决策应偏保守，因此建议 0.42 而不是 0.35。
7. **`unrelated-long` 层在所有配置下正确弃答**（B/D 误召回 0，C 为 0.033）。低阈值的主要风险不是无关长文，而是 near-miss 与 multi-fact 的细节混淆。

## 结论与建议

- **建议采用策略 b：把 `DEFAULT_MEMORY_SIMILARITY_THRESHOLD` 从 0.5 下调到 0.42**，与 1c 修复一起发布。证据：D 点 recall 0.944、误召回 0.144、near-miss 0.8；相对 0.5 的收益为 +0.167 recall，代价为 +0.066 误召回。
- 备选：保持 0.5（策略 a，误召回最低，放弃 0.167 recall）；或 0.35（策略 c，recall 满但上下文污染最重，边际不成立）。
- 按 D2，用户确认后才改产品默认值。
- 若后续引入分层阈值（例如近义/否定层单独放宽），需在本报告之上补测。

### 决策落地（2026-09-13）

用户确认策略 b。`DEFAULT_MEMORY_SIMILARITY_THRESHOLD` 已改为 0.42（`packages/memory-core/src/types.ts`，注释记录本次对照数据与证据路径）；`memory-pgvector` 默认阈值断言同步更新。测试：memory-core 40/40、memory-pgvector 6 passed（4 integration skipped）、stage-ui memory 47/47。

## 局限

- 双语合并为单条 content，没有独立 zh/en 记录。跨语言层的结论限于该表示。
- 90 条用例、k = 3。
- 评估使用隔离作用域，误召回绝对值不能直接外推到真实 profile。
- A–B 对照依赖 `linkLocalHistory` 开关，运行在同一构建上；未测多用户账号切换。
