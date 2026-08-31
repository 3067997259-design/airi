# AIRI 注意力分流设计（fork `mods` 分支）

**状态**：首版已实现。协议分流、任务事件投影、聊天 UI、集成结果分流和模式切换已接线。
**问题**：对话窗口被塞进了三种时间尺度的内容（对话 / 事件流 / 长程任务），
互相污染，且记忆层在混合物上做二次加工。
**与 `MEMORY-DESIGN.md` 的关系**：本文档**先于**记忆层生效。
它定义"记忆层不该看见什么"，是记忆层输入端的过滤契约。

**总纲**：见 `DESIGN-PRINCIPLES.md`。
**文档序列**：**本文档**（什么进上下文）→ `WORKSPACE-DESIGN`（什么算真的）
→ `SELF-AUTHORED-TOOLS-DESIGN`（能力如何增长）→ `CODING-HARNESS-DESIGN`（如何可靠改代码）
→ `MEMORY-DESIGN`（什么值得留下）。

> **已被后续修订的部分**：§7.5（四泳道状态统一为事件日志投影）、
> §8（订阅边界改为订阅日志事件类型）。
> 决策来源：`CODING-HARNESS-DESIGN.md` §4。泳道概念仍成立，
> 它现在描述的是**投影策略**而非存储位置。
>
> **实现补充（2026-08-28）**：缺陷 A 的另一半已补齐 —— Discord
> 频道在场消息 → `context:update`（per-channel replace-self），关键词命中 →
> `spark:notify`（`DISCORD_ATTENTION_KEYWORDS` 环境变量，默认关闭）；
> DM/提及仍走 `input:text`。§6 表的 Discord 行至此全部落地。
> 剩余：integration 通道指引文档、focused 可关开关、§9.1 运行验收
> （见 `WIRING-BACKLOG.md` §5）。

---

## 0. 核心结论

**你担心的架构已经存在并在运行，只是没接到 UI 上。**

`packages/stage-ui/src/stores/character/orchestrator/store.ts` 是一个完整的注意力调度器：
按 urgency 分级、2 秒 tick、重试退避、结果写入环形上限的 `reactions` 而**不进对话历史**。
协议层（`plugin-protocol/src/types/events.ts`）早已区分三条通道。

所以本设计的主体是**接线 + 补一条缺失的通道**，不是重构。

真正的矛盾不是"情绪 vs 工具"，而是**三种时间尺度共用一个 messages 数组**。
澄清了尺度，矛盾就消失了 —— 一个好同事既能开玩笑也能盯长任务，
他做的是上下文切换，不是人格分裂。

---

## 1. 勘探结论

### 1.1 三条通道在协议层已经分好

`plugin-protocol/src/types/events.ts` 定义：

| 通道 | 语义 | 唤醒决策 | 进对话历史 | 现状 |
|---|---|---|---|---|
| `input:text` | 用户说话 | 是 | **是** | 在用 |
| `spark:notify` | 事件/警报（alarm/ping/reminder） | 是，按 urgency 分级 | **否** → `reactions` | 在跑，但 UI 不可见 |
| `context:update` | 被动状态 | **否** | history-only | 在用（MC） |

协议注释（`events.ts:1461-1476`）连反面约束都写了：

> **Don't**: Stream high-frequency telemetry here (keep a separate channel).
> Stuff large blobs into payload/contexts; prefer refs/summaries.

`integrations/minecraft/src/airi/airi-bridge.ts:60-66` 的注释进一步确认了这个设计意图：

> True passive context still has its own dedicated channel — `context:update` —
> which **remains history-only** and is unaffected by this routing.

### 1.2 注意力调度器已在运行

`character/orchestrator/store.ts` 实现了：

- `urgency` → 延迟映射：`immediate` = 0ms，`soon` = 10s，`later` = 60s（`:70-86`）
- 2 秒 tick 循环 + 到期任务出队（`:209-248`）
- 失败重试 + `maxAttempts: 3` 后丢弃（`:226-238`）
- **独立 agent**（`createSparkNotifyAgent`）+ 独立 prompt，不共享对话历史
- 结果写入 `characterStore.reactions`，带 `MAX_REACTIONS` 环形上限
  （`character/index.ts:134`）—— **天然不会无限堆积**
- `notebookStore.getDueTasks()` 已接入定时任务提醒（`:179-207`）

### 1.3 已确认的真实缺陷

**缺陷 A — 部分集成绕过了分流，直灌 `input:text`。**

已验证：`integrations/discord-bot/src/adapters/airi-adapter.ts:263`、
`integrations/twitter-services/src/adapters/airi-adapter.ts:149,188,210,266,277`
都直接发 `type: 'input:text'`。

Minecraft **没有**这个问题（它正确使用 `spark:notify` + `context:update`）。

即"游戏事件以文本堆进对话框"的观感，来源是 Discord/Twitter 这类集成把
所有外部消息当成"用户说话"注入。这是接线错误，不是架构缺陷。

**缺陷 B — `spark:notify` 的处理结果在真实 UI 里不可见。**

已验证：`characterStore.reactions` 的唯一渲染位置是
`packages/stage-pages/src/pages/devtools/context-flow/index.vue`（devtools 页面）。
主对话 UI 从不显示它。

后果：事件反应机制在跑，但用户看不见 → 于是集成作者倾向改用 `input:text`
（因为那个"看得见"）→ 加剧缺陷 A。**这是一个自我强化的退化循环。**

**缺陷 C — 没有长程任务通道。**

`spark:notify` 是**离散事件**语义（alarm/ping/reminder，带 `ttlMs`）。
它不适合表达"一个持续三小时、产生 5000 行日志、状态不断演进"的任务。
这是三条通道里真正缺失的第四条。

### 1.4 收敛状态的范式已经写好了

`services/computer-use-mcp/src/task-memory/types.ts` —— 文件头注释：

> Not a long-term memory system. Only tracks:
> "what are we doing, what's confirmed, what's blocking, what's next."

```ts
export interface TaskMemory {
  status: 'active' | 'blocked' | 'done'
  goal: string | null
  currentStep: string | null
  confirmedFacts: string[]
  artifacts: TaskMemoryArtifact[]
  blockers: string[]
  nextStep: string | null
  updatedAt: number
  sourceTurnId: string
}
```

**这就是长程任务该注入上下文的东西**（几百 token 的快照），
而不是 5000 行日志。配套的 `transcript/`（projector + store + 保留策略）
负责让日志可查但不进 prompt。

### 1.5 可折叠卡片的 UI 范式也已存在

`packages/stage-ui/src/components/scenarios/chat/components/tool-call-shell.vue`
基于 `Collapsible`，带 `state?: 'executing' | 'done' | 'error'` 与对应图标
（loading spinner / 红色 danger / 绿色 check）。

任务卡直接沿用这个范式，视觉语言天然一致。

---

## 2. 设计：四条泳道

在现有三条通道之外补第四条，并明确每条的持久化与记忆订阅边界。

| 泳道 | 时间尺度 | 载体 | 进 prompt 的形态 | 进对话历史 | 记忆层订阅 |
|---|---|---|---|---|---|
| **对话** | 秒 | `input:text` | 完整消息 | 是 | **是** |
| **事件** | 不定时 | `spark:notify` | 不进（独立 agent 处理） | 否 → `reactions` | 仅结论 |
| **状态** | 持续 | `context:update` | `[Context]` 块，replace-self | history-only | **否** |
| **任务** | 分钟~小时 | `task:*`（新） | `TaskMemory` 快照 | 卡片引用 | 仅结论 |

### 2.1 关键规则：日志不进上下文，状态才进

一个 babysitting PR 任务跑三小时、产生 5000 行日志：

- **日志** → 写入 transcript store，可查、可展开、**永不进 prompt**
- **状态** → 收敛成 `TaskMemory` 快照（几百 token），每轮注入
- **结论** → 任务结束时产出一段结论文本，进对话历史 + 供记忆层抽取

这条规则同时解决了"记忆系统二次加工变得更乱"：
**记忆层永远不订阅日志泳道。** 它只看对话，以及任务/事件的**结论**。

### 2.2 为什么 `context:update` 不进记忆

`context:update` 是 `replace-self` 语义的**瞬时状态**（MC 当前血量、
当前坐标、天气）。这类数据：

- 变化频率高，嵌入成本浪费
- 语义价值随时间趋零（"三天前血量是 12"毫无意义）
- 会污染向量空间（大量近似重复的状态描述）

所以它 history-only、不入库。**唯一例外**是状态**跨越阈值形成事件**时
（"血量归零 = 死亡"），那应该由 integration 主动升级为 `spark:notify`，
走事件泳道。这也是 MC bridge 现有的做法。

---

## 3. 任务泳道设计

### 3.1 协议事件（新增）

沿用 spark 系列的命名与 `id`/`eventId` 去重惯例：

```text
'task:start'     { taskId, goal, kind, estimatedDurationMs? }
'task:progress'  { taskId, memory: TaskMemory, logRef?: string }
'task:blocked'   { taskId, memory: TaskMemory, needsInput: string }
'task:done'      { taskId, memory: TaskMemory, conclusion: string }
```

`logRef` 是 transcript 里的指针，**不是日志内容本身** ——
对应协议注释里的 "prefer refs/summaries"。

### 3.2 收敛而非累积

`task:progress` 携带的是**当前完整快照**，语义等同 `replace-self`：
第 N 次 progress 覆盖第 N-1 次，不追加。

于是无论任务跑多久、发多少次 progress，
它在上下文里**永远只占一个 `TaskMemory` 的体积**。这是"长程任务不炸上下文"的根本机制。

### 3.3 何时唤醒她

| 事件 | 是否打断对话 | 理由 |
|---|---|---|
| `task:start` | 否 | 她自己发起的，已经知道 |
| `task:progress` | **否** | 静默更新卡片；打断会变成噪音轰炸 |
| `task:blocked` | **是** | 需要你输入才能继续，不说就卡死 |
| `task:done` | 是（软） | 结论值得说一句 |

`task:progress` 静默是这个设计的关键取舍：**进度更新不该说话**。
一个盯着 CI 的同事不会每 30 秒汇报一次"还在跑"。

---

## 4. 人格边界：同一人格 + 模式切换

**已确认采用同一人格 + 模式切换。**

三条泳道共用同一份 `## Character`（角色身份），
差异体现在**注入哪些工作上下文**与**当前模式提示**：

```
## Character        （所有泳道共用，人格一致）
## Stage Control    （仅对话泳道 —— 事件/任务不需要 ACT/情绪协议）
## Mode             （新增：focused | casual）
## Toolset          （按泳道裁剪可用工具）
```

### 4.1 `## Mode` 的作用

- `casual`（默认，无活跃任务）：完整情绪表达，`## Stage Control` 注入
- `focused`（有 `status: 'active'` 的任务）：提示她"手上有正在进行的任务，
  回应可以简短，优先把事做对"

这对应现实里同一个人在工作与闲聊时的语气差异 —— 不是两个人格，是同一个人的两种状态。

### 4.2 为什么长任务内部不注入 `## Stage Control`

`## Stage Control` 教的是 `<|ACT|>` 情绪协议 + 动作表（`system-sections.ts:47`）。
长任务内部的推理步骤（读日志、判断 CI 状态）**不需要**表情动作，
注入它只会诱导模型在每个内部步骤都输出情绪标记，浪费 token 且干扰任务判断。

但**任务结论**要经过对话泳道发出，那一步带完整人格和情绪 ——
所以你感受到的仍然是"她"在告诉你结果，而不是一个系统在打印状态。

这就是"既是朋友又是助手"在 prompt 层的落点：**内核专注，出口有人格**。

---

## 5. UI：单窗口 + 任务卡折叠

**已确认采用单窗口 + 任务卡折叠。**

对话流保持单一时间线（她还是"一个人"），长程任务以可折叠卡片内联，
沿用 `tool-call-shell.vue` 的 `Collapsible` + 状态图标范式（§1.5）。

```
┌─────────────────────────────────────────┐
│ 你：帮我盯一下 #1234 这个 PR            │
│                                          │
│ AIRI：好，我盯着，有动静叫你 (｀・ω・´)  │
│                                          │
│ ▸ ⟳ 盯着 PR #1234        [进行中 · 12m] │  ← 折叠态：只有状态行
│                                          │
│ 你：（继续聊别的）                       │
│ AIRI：（正常带情绪回应）                 │
│                                          │
│ ▾ ⚠ 盯着 PR #1234           [需要输入]  │  ← blocked 才冒泡
│   目标：CI 通过后合并                     │
│   当前：等 e2e 测试                       │
│   卡在：lint 失败，2 处 import 顺序        │
│   ├ 日志（47 行）  ▸                     │  ← 二级折叠，默认收起
│   └ 下一步：需要你决定是否自动修          │
│                                          │
│ AIRI：lint 卡住了，两处 import 顺序，     │  ← 结论走对话泳道，带人格
│       我改还是你来？                      │
└─────────────────────────────────────────┘
```

三条 UI 规则：

1. **`task:progress` 只更新卡片，不产生新的对话气泡。** 否则长任务会把对话冲走。
2. **日志是卡片内的二级折叠，默认收起。** 它在 DOM 里、可看，但不在 prompt 里。
3. **`blocked` / `done` 才产生对话气泡**，且由她用人格化语言说出。

### 5.1 顺带修掉缺陷 B

`reactions`（事件反应）目前只在 devtools 可见。本设计要求把它也渲染进对话流 ——
形态是轻量的单行提示（不是完整气泡），例如：

```
  · MC：被女巫攻击了，我先撤 [事件]
```

这样 integration 作者不再需要为了"让用户看见"而滥用 `input:text`，
打破 §1.3 描述的退化循环。

---

## 6. 修正现有集成（缺陷 A）

Discord / Twitter 目前把所有外部消息当 `input:text`。应按语义拆分：

| 内容 | 现状 | 应改为 |
|---|---|---|
| 有人直接跟她说话（@ 她、私信） | `input:text` | 保持 `input:text` ✓ |
| 频道里的普通消息（她只是在场） | `input:text` | `context:update`（history-only） |
| 提及/关键词触发 | `input:text` | `spark:notify`（kind=ping） |

**判断标准**：这条消息是"对她说的"，还是"她碰巧看见的"？
只有前者才是 `input:text`。

这一改动本身就能大幅削减你观察到的文本堆积，且**不需要任何新架构**。

---

## 7. 模块边界

```
packages/core-agent/src/
  attention/                    （新）
    lanes.ts                    四泳道的类型与路由规则（纯函数）
    task-memory.ts              从 computer-use-mcp 提取的可复用 TaskMemory 契约
    mode.ts                     casual/focused 判定（纯函数）

packages/plugin-protocol/src/types/
  events.ts                     新增 task:* 事件

packages/stage-ui/src/stores/
  character/orchestrator/       扩展：接管 task:* 泳道（复用现有 tick/重试机制）
  tasks/                        （新）活跃任务状态 + transcript 引用

packages/stage-ui/src/components/scenarios/chat/components/
  task-card.vue                 （新）沿用 tool-call-shell 的 Collapsible 范式
  reaction-line.vue             （新）事件反应的轻量单行渲染

integrations/discord-bot, twitter-services
  adapters/airi-adapter.ts      按 §6 拆分通道
```

**为什么 `TaskMemory` 要从 `computer-use-mcp` 提取到 `core-agent`**：
它现在耦合在 computer-use 里，但任务泳道是通用能力（babysitting PR、
盯 CI、长时间数据处理都需要）。提取时保持契约不变，
`computer-use-mcp` 改为引用共享定义 —— 这符合 AGENTS.md 里
"可复用领域契约放在拥有该领域的包"的要求。

---

## 7.5 修订：状态统一到 append-only 事件日志

> **本节为后续修订**（决策见 `CODING-HARNESS-DESIGN.md` §4）。
> 它取代本文档原先"四条泳道各有持久化策略"的表述。

四条泳道**不再各自持久化**。所有状态成为同一条 append-only 事件日志的**投影**，
遵循 `model-visible means logged`：凡模型看到的必被记录。

| 本文档原有的独立状态 | 修订后 |
|---|---|
| `TaskMemory` | 日志的人类可读投影 |
| `reactions`（事件泳道） | 日志中事件类型的投影 |
| `context:update` 的 `replace-self` | 日志中该 `contextId` 的最新事件 |
| 任务日志 / transcript | 日志本身 |

**§2 那张表的"进 prompt 的形态"一列语义不变** —— 变的只是数据来源：
从各自的 store 改为统一日志的不同投影。泳道概念仍然成立，
它现在描述的是**投影策略**而非存储位置。

**关键边界不变**（与 `DESIGN-PRINCIPLES.md` 原则二一致）：
`model-visible means logged` 是**单向**的。凡记录的**不必**都给模型看 ——
日志记录一切，上下文只包含投影。§2.1"日志不进上下文，状态才进"因此更准确：
日志是唯一真相来源，上下文是它的收敛投影。

## 8. 与记忆层的接口契约

这是本文档最重要的产出，因为执行模型正在实现记忆层，**这条边界必须提前钉死**：

```
记忆层订阅（修订后：订阅事件日志中的这些事件类型）：
  ✓ 对话泳道的 user / assistant 消息
  ✓ 任务泳道的 conclusion（task:done 的结论文本）
  ✓ 事件泳道的 reaction（她对事件的反应）

记忆层不订阅：
  ✗ 任务日志 / transcript
  ✗ task:progress 的中间快照
  ✗ context:update 的瞬时状态
  ✗ 工具调用的原始返回值
```

理由：记忆是"值得长期记住的事实"。日志、中间状态、原始工具返回都是
**过程副产品**，它们的价值在当次任务内就已耗尽。让它们进向量库只会
稀释检索质量 —— 一个装满 CI 日志的记忆库，检索"我们上次聊到什么"
会返回一堆 `npm install` 输出。

**这也是 `MEMORY-DESIGN.md` §7 那句"压缩与记忆互补"的完整版本**：
不只是两层互补，而是四条泳道共享事件日志，记忆层只订阅允许的收敛产物。

---

## 9. 分期

**第一期 — 修集成（已完成）**
Discord 的 DM/提及继续使用 `input:text`。Twitter 的命令结果和错误改用 `spark:emit`。

**第二期 — 接 reactions 到 UI（已完成）**
`reaction-line.vue` 已加入主聊天时间线。事件反应不再需要伪装成聊天消息。

**第三期 — 任务泳道（已完成首版）**
`task:*` 协议、共享 `TaskMemory` 契约、事件日志投影、`task-card.vue` 和上下文桥接已接线。

**第四期 — 模式切换（已完成首版）**
聊天提示词会根据活动任务注入 `## Mode`。有 active 任务时使用 `focused`，否则使用 `casual`。

每期独立可用、独立观察。第一二期不依赖任何新设计，可以和记忆层并行推进。

### 9.1 首版验收条件

- 对话消息仍由 `input:text` 进入聊天历史。
- 事件反应只进入反应投影，不追加聊天消息。
- `task:progress` 只替换任务的当前快照，不累加快照内容。
- 任务卡默认折叠进度，`blocked` 自动展开，并只显示 `logRef`。
- `task:done` 的结论和 `event:reaction` 的反应可以被记忆订阅；日志、进度和瞬时状态不能被订阅。
- active 任务让普通对话进入 `focused` 模式；没有 active 任务时保持 `casual` 模式。

---

## 10. 已知风险与待定问题

1. **`task:progress` 静默可能让你觉得"她不理我"。** 设计上进度不说话，
   但如果长时间无冒泡，体验上像卡死。缓解：卡片状态行显示已耗时
   （`[进行中 · 12m]`），必要时加"超过 N 分钟无进展则主动提一句"的兜底。

2. **`TaskMemory` 的收敛质量依赖模型。** 弱模型可能把日志原文塞进
   `currentStep`，那就退化成日志进上下文了。缓解：对各字段做长度上限硬截断
   （`confirmedFacts` 每条 ≤ 200 字符、总数 ≤ 10 等），在 `attention/task-memory.ts`
   里用纯函数强制，不信任模型自律。

3. **`focused` 模式可能让她显得冷淡。** 这是"既是朋友又是助手"最容易翻车的点。
   `## Mode` 的措辞需要实测调整 —— 目标是"专注但仍然是她"，
   而不是"任务期间变成机器人"。建议第四期先做成可关闭的开关。

4. **四条泳道对 integration 作者是认知负担。** 现有 integration 之所以滥用
   `input:text`，部分原因是那是最简单的路径。§5.1 让 reaction 可见能改善动机，
   但仍需要在 integration 文档里给明确的判断标准（§6 那张表）。

5. **任务生产者仍需逐步迁移。** 共享 `TaskMemory` 契约已放在 `core-agent`，
   `computer-use-mcp` 现在引用该契约。其他长任务生产者仍需按 `task:*` 事件发送快照。
