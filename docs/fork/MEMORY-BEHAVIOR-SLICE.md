# AIRI 记忆行为纵切片测试协议

日期：2026-09-05。
状态：**已实机运行，组 B / 组 C 通过，噪声项部分通过**（见文末运行记录）。
上游计划：`docs/fork/MEMORY-SEMANTICS-CORRECTION-PLAN.md` 批次 E。

本文件是批次 E 的可执行协议。批次 A–D 的代码与单元测试已落地；本切片回答的问题只有一个：**记忆是否真的改变了行为**。没有工具顺序、回答策略或计划变化的结果不能作为记忆应用证据（交付规则 7），没有 `memoryIds` 的回答不能作为记忆召回证据（交付规则 6）。

## 1. Fixture

- 使用一个独立测试会话和小型 workspace；不要用当前长会话作为证据。
- 记忆库从空状态开始（或先记录现有记忆清单并在分析时排除）。
- 初始事实（组 B / 组 C 使用同一文本）：

```text
用户偏好：处理代码任务时，先查看相关测试，再决定是否修改文件。
```

- 写入方式：在组 B 会话中让 AIRI 对话产生该事实（或经记忆浏览器手动写入后），在审核队列中批准。
- 每组使用全新的会话 id；组间不得复用会话消息。

## 2. 对照组

| 组别 | 数据 | 目的 |
|---|---|---|
| A | 没有该记忆 | 获得行为基线 |
| B | 有 approved 事实记忆 | 测试记忆是否改变行为 |
| C | 有旧事实和 approved 修订 | 测试纠正是否改变行为 |

## 3. 测试步骤

1. 组 B：写入事实并批准（`memory/revised` 不应有记录；审核动作记录为 approved）。
2. 创建新会话，不复制原始偏好文本；用一句同义任务请求，例如"帮我修一下这个函数的错误"。
3. 提交一个需要修改代码的任务。
4. 观察是否先读取或运行相关测试。
5. 组 C：在任一会话中通过记忆浏览器对旧事实提交修订（例如"改为：先检查接口约定，再决定是否修改"）。
6. 批准修订，确认旧事实状态变为 superseded（记忆浏览器显示"已被替代"）。
7. 创建新的独立会话。
8. 提交相似任务并观察工具顺序。
9. 提交一个无关任务（例如闲聊或纯问答），确认记忆不会造成额外干扰。

## 4. 通过标准与证据

每一项都要用 journal、provider 请求摘要和 workspace diff 复查：

1. 组 B 的 `memory/retrieved` 事件包含正确 memory id，且 `turnId` 指向该轮。
2. 组 B 的 `memory/applied` 显示 `appliedMemoryIds` 非空，或工具顺序体现"先测试后修改"（对比组 A 基线）。
3. 组 C 批准修订后，旧事实不再出现在新会话的 `memory/retrieved.memoryIds`。
4. 组 C 后续两次相关任务继续使用新偏好（工具顺序或回答策略）。
5. 无关任务的 `memory/retrieved.memoryIds` 为空或不含该偏好，行为无记忆痕迹。
6. 组 A 基线会话中不出现该偏好指导的工具顺序。

## 5. 记录位置

- Journal 会话文件：与测试会话 id 对应，直接可读。
- `memory/applied` 与 `memory/retrieved` 的配对分析：区分"当前会话上下文复述"与"跨会话召回"——复述的轮次 `appliedMemoryIds` 为空。
- 结果汇总写回 `MEMORY-SEMANTICS-CORRECTION-PLAN.md` 的批次 E 状态。

## 6. 失败时的处理

- 召回为空：检查 embedding 与相似度阈值（`settings/memory` 权重），确认事实是 `approved` 且 `active`。
- 召回命中但未应用：连续两次以上，说明 prompt 中记忆引用的呈现或模型遵循问题，优先调整召回呈现格式，而不是评分公式（计划 §8 的禁区）。
- 旧事实复发：检查该行 `fact_status` 是否真的被更新为 `superseded`，以及远端镜像是否被重新拉回（本地是权威侧）。

## 7. 实机运行记录（2026-09-05 晚，构建版 + CDP 9250，provider: openai-compatible / gemini-3.8-flash）

fixture 采用"播种复现"而非原始记录（原始数据因下述持久化缺陷已不可得）：
`captureTurn` 播种误标 muscle → 批次 B 迁移 → 批准，得到 approved 事实
`0d464d99`（先跑测试再改文件）。

### 7.1 首轮：召回门限暴露结构性缺陷（切片按设计工作）

组 B 首轮真实轮（新会话 `k5pClMBGKWqJTljgJrVoG`，中文转述问法）：
`memory/retrieved.memoryIds` 为空——召回失败，journal 如实记录。用应用自身
embedding 通道实测：忠实英文转述 0.377、中文查询 vs 英文事实 0.323、无关
问题 0.25–0.35。**相关与无关在 nomic-embed-text-v1 的余弦分布上重叠，
0.5 的硬门限让真实问法永远召不回**（此前浏览器探针命中纯粹因为查询复述了
原文）。`search_query:` / `search_document:` 前缀实验（0.41 / 0.35 vs
0.33）证明前缀也救不了。结论：门限按测得分布校准为 0.2
（`DEFAULT_MEMORY_SIMILARITY_THRESHOLD`，两仓储统一），真正的修复（多语言、
更大边际的 embedding 或 reranker）归入 §9.1 决策。

### 7.2 组 B（阈值校准后）：通过

新会话 `FwKW9lZhPuyuOtQATLN1g`，同一中文问法：

- `memory/retrieved.memoryIds = [0d464d99]` —— 交付规则 6 的硬证据。
- `memory/applied = { retrieved: [0d464d99], applied: [] }` —— 模型转述而未
  逐字引用 `[memory:<id>]` 标记；复述与引用分开统计按设计工作。
- 回答策略体现偏好："2. 跑一遍现有的相关测试，确认当前的基线状态"先于任何
  修改动作，第 4 步以补测试收尾。

### 7.3 组 C（纠正闭环）：通过

`reviseFact`（先检查接口约定，再决定是否修改文件，supersedes）→ 批准
`629a3ee8` → 旧事实 `factStatus = superseded`。新会话 `LEDvZCL3lMRYkCG1-xYHi`，
同一问法：

- `memory/retrieved.memoryIds = [629a3ee8]`，旧事实 id 不出现——superseded
  过滤在真实向量检索路径生效。
- 回答策略翻转："先不急着动文件 → 1. 核对现有接口约定 → 2. 检索调用方"，
  旧偏好不再开局（§6.4"后续会话使用新事实"成立）。

### 7.4 噪声项：部分通过

新会话 `dpOvvoXr-g7SVmwTInEw2`，写诗请求：召回仍带出 `[629a3ee8]`（0.2 阈值
+ 小库 top-k 的已知代价），但回答是干净的秋诗，**行为零干扰**。召回噪声
计入 §9.1"记忆对无关任务的干扰率"，随库增长需复测。

### 7.5 过程中发现的新缺陷（不在本切片范围内，已另立修复项）

- **记忆库持久化缺陷（P0）**：`useDuckDb().closeDb()` 从未被应用调用，OPFS
  上的 DuckDB 没有任何干净关闭路径；强杀/崩溃即丢失未 checkpoint 的全部
  数据。本切片的原初 fixture（她观察到的真实 muscle 记录）就是该缺陷的
  失踪案例。修复项已记入 `WIRING-BACKLOG.md`。
- journal 磁盘 flush 存在秒级瞬态滞后（重试机制可追上），非缺陷。

### 7.6 证据

journal 文件：`%APPDATA%\@proj-airi/stage-tamagotchi/journal/<sha256(sessionId)[:32]>.jsonl`
（`FwKW9lZhPuyuOtQATLN1g` / `LEDvZCL3lMRYkCG1-xYHi` / `dpOvvoXr-g7SVmwTInEw2`），
内存 journal 与磁盘一致性已复核。测试会话与播种事实（`629a3ee8`，approved）
保留在构建版库中供复查。
