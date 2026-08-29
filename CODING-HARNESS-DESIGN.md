# AIRI Coding Harness 设计（fork `mods` 分支）

**状态**：设计完成（待评审）。**第一~四期核心已实现**（含单测）；
第五期与桌面接线未动（详见 `WIRING-BACKLOG.md`）。
**问题**：她要能 coding（写自己的适配层、改配置、修 bug），
现在的 chatbox 式交互撑不起这个飞轮。要不要 harness？什么形态？
**结论**：要，但它是**跑在现有插件系统上的一个 coding 插件**，不是新外壳。

**总纲**：见 `DESIGN-PRINCIPLES.md`。
**文档序列**：`ATTENTION-DESIGN`（什么进上下文）→ `WORKSPACE-DESIGN`（什么算真的）
→ `SELF-AUTHORED-TOOLS-DESIGN`（能力如何增长）→ **本文档**（如何可靠地改代码）
→ `MEMORY-DESIGN`（什么值得留下）。

> **本版完成内容**（2026-08-28，全部结论经代码/本机安装复核）：
> - **§7.1 已验证**：dsh 插件的 manifest 与安装机制不再是未知环节 ——
>   静态装配是「pnpm link 依赖 + `dsh.profile.bundles` 列表」这一机械操作；
>   另发现第二条通道：**动态 cordis 插件**（模型会话内定义-运行-审批，
>   package 不可变 + 审批与授权记录进日志），它同时验证了 §3.1 的
>   "创造模式 ↔ `draft` 态"对应，并对 `SELF-AUTHORED-TOOLS-DESIGN.md` §3
>   的生命周期构成外部印证（见本文档 §7.3）。
> - **§2.4 新增**：Hashline 的完整模型侧协议规格（签名算法、read 投影、
>   edit 校验规则、碰撞处置），原 §11.1 改为实测标定计划。
> - **§4.4 新增**：事件日志的具体规格 —— 事件类型表、append-only 存储
>   格式（对齐 dsh 的 session JSONL）、投影注册表范式、**归档策略**
>   （原 §11.3 落定）。
> - **§11.5 / §11.6 已裁决**：`bash` 默认只读 + 升权走审批（镜像 dsh
>   bash-sandbox 的 fail-closed 设计）；PTC 证据粒度 = 每次 bridge 请求
>   一条日志事件。
> - 补充一个反向证据：dsh 官方自带编辑工具是**字面量唯一匹配**的
>   `str_replace`（拒绝 0/多匹配、无 `replace_all`）—— 它不解决弱模型
>   逐字复现问题，Hashline 的差异化价值因此仍然成立（§2.4 末尾）。

---

## 0. 核心判断

「Harness」这个词把三件事混在一起了：

| | 是什么 | AIRI 现状 |
|---|---|---|
| 1. **编辑原语** | 模型如何可靠地改一个文件 | ❌ 完全没有 |
| 2. **事件日志** | 状态如何被重建 | ❌ 没有（各处自有 store） |
| 3. **UI 表面** | TUI / IDE / chatbox | ✅ 有，够用 |

**你担心的是 3，真正卡住飞轮的是 1 和 2。**

而架构层面有一个重要更正：**AIRI 现有的插件架构已经是对的**，
不需要换（§1）。所以本设计的内容是「在现有架构上补 1 和 2」。

---

## 1. 架构更正：AIRI 已经是 Cordis 那个形状

DeepSeek Harness 官方（[deepseek.com/harness](https://deepseek.com/harness/)）说明其 Cordis 内核：

> Cordis 内核只负责插件的加载、卸载和依赖关系，**不承载 Agent 的具体能力**

模型、工具、技能、会话、沙箱、存储、循环、调度、UI —— 全部是插件，
通过 Cordis 的**服务与事件**层协作，而非插件间直接调用。

**AIRI 已经有这一层**（均经代码验证）：

| Cordis 概念 | AIRI 对应物 |
|---|---|
| 内核只管加载/卸载/依赖 | `injeca` DI + `module:announce` / `de-announced` 生命周期 |
| 依赖声明 | `ModulePermissionDeclaration`（`events.ts:435`，五类权限） |
| 服务与事件层 | server-channel + `@moeru/eventa` 契约 |
| 插件即能力 | `extension:kit:announce`、`SerializedXsaiToolDefinition` |
| 配置协商 | `module:configuration:{validate,plan,commit}` 完整三阶段 |

**所以我此前"参照物选错了"的说法要修正一半**：

- **UI 层面仍然坚持**：不要模仿 OMP（31 工具 / 60+ provider / 8 万行 Rust 核心）。
  见 `DESIGN-PRINCIPLES.md` 原则七。
- **架构层面我错了**：dsh 不是"另一种参照物"，它**印证了 AIRI 现有插件架构是对的**。

结论：**coding 能力应实现为一个插件，不是一个新的 harness 外壳。**

---

## 2. 编辑原语：Hashline

### 2.1 这是 M1 的同类问题

传统 text-replacement 编辑要求模型**逐字复现**目标行（含空白），
系统才能定位替换。弱模型必然失败。

Hashline（Pi / OMP 的做法）：读文件时给每行打一个 2-3 字符的
**内容签名**，模型引用签名而非复述整行。文件变了签名就不匹配，
编辑**在造成损坏前被拒绝**。

引用的 benchmark（[yuv.ai](https://yuv.ai/blog/oh-my-pi-omp-explained)）：
Grok Code Fast 1 从 6.7% → 68.3%，16 个模型平均 +15pp。

**这与 M1 完全同构**：

| | M1（已完成） | Hashline（本设计） |
|---|---|---|
| 症状 | 模型调用 MCP 工具失败率极高 | 模型改文件定位失败率极高 |
| 根因 | `"<server>::<tool>"` + JSON 套 JSON 双重编码 | 要求逐字复现含空白的整行 |
| 自律式解法 | 提示词强调"请正确调用" | 提示词强调"请精确复现" |
| 结构式解法 | `sanitizeMcpToolName` 扁平化 | 内容签名替代逐字复现 |

**对 AIRI 尤其关键**：她跑在用户配置的任意 provider 上，
经常是弱本地模型 —— 整个 M1/M2 都是在对付弱模型的工具调用失败。
若现在随便选一个编辑格式，就是把 M1 那个坑重新挖一遍。

**这一项的性价比高于整个 workspace。**

### 2.2 设计要点

- 签名由**行内容**计算（非行号），所以插入/删除行不会使其他行失效
- 签名随 `read` 结果一起返回，模型只能引用它读过的行
- 编辑时校验签名 → 不匹配即拒绝，并回报当前签名（让模型重读而非盲改）
- 签名短（2-3 字符）以控制 token 开销；碰撞用「签名 + 期望内容前缀」二次确认

**与权威链的关系**：编辑成功返回的是 `tool_result`（precedence 40，
可作变更证明）。签名不匹配的拒绝**不是**失败证据，是"状态已变，请重读"——
这个区分要在返回值里明确，否则模型会把它当成任务失败而放弃。

### 2.3 最小工具集

沿用 Pi 的 4 工具（`read` / `write` / `edit` / `bash`），
`edit` 走 Hashline。理由见 `DESIGN-PRINCIPLES.md` 原则七：
小到能读懂、能审阅，且足以支撑自造工具飞轮 ——
写一个几十行的适配层不需要 LSP 和 debugger。

### 2.4 Hashline 协议规格（模型侧）

**签名算法**：对原始行内容（含行尾前的全部字符，不含换行符）计算
FNV-1a 32 位 → base32 编码 → 取前 N 位。N 按文件行数自适应：
`< 500` 行取 2、`< 4_000` 行取 3、以上取 4（对应 10/15/20 bit 空间）。
签名空间是**对抗非恶意错误的**：本 fork 的威胁模型是弱模型的乐观偏差与
疏漏（本文档 §8.3），不是对抗故意伪造，FNV 足够。
无需密码学哈希 —— 那只是浪费 token。

**read 投影**（模型看到的样子，扁平 bullet，遵守 issue #1539 约束）：

```
src/adapters/opencode.ts  (87 行 · mtime 2026-08-28T10:12)
   12  q7k  export async function run(rawArgs: string[]): Promise<void> {
   13  z9p  const flags = parseArgs(rawArgs)
   14  mn2  if (flags.help) return printHelp()
   ...
   60  c3a  // TODO: pass through --model
```

行号是定位辅助、**签名才是身份**。插入/删除行会让行号漂移，
但签名按行内容计算，不受影响 —— 这正是"签名替代复现"的全部意义。

**edit 请求**（模型 → 工具）：

```
edit(path, signature, expectedPrefix, newLineContent)
```

校验规则（全部机械判定，无一依赖模型自律）：

1. 对目标行计算当前哈希；无行匹配 `signature` → **拒绝**，
   返回 "STATE_CHANGED" + 当前该区间的候选签名（让模型重读而非盲改）。
2. 唯一匹配但 `expectedPrefix`（该行前 16-32 个可见字符）不符 →
   **拒绝**，同上返回当前签名 —— 这是签名 + 内容的前缀二次确认，
   处理 §11.1 的碰撞与"换行后内容仍在但前缀已变"两类情况。
3. 多个匹配 → **拒绝**，返回冲突行号；不自动选第一行
   （自动选择就是把歧义偷偷藏起来，弱模型会以为编辑成功了）。
4. 全部通过 → 整行替换为 `newLineContent`，返回 `tool_result`
   （precedence 40，可作变更证明）。

**token 账**：每行签名 2-4 字符 + 1 空格。一个 500 行的文件
多花约 1.5-2.5K 字符 —— 相比"模型复现整行导致的重试循环"是净省。
**截断策略**：超长行（> 200 字符）在投影中截断显示，但截断后的
前缀（前 32 字符）仍足以作为 `expectedPrefix` 二次确认。

**与权威链的关系**（沿用 2.2 原文）：编辑成功的 `tool_result` 是
precedence 40 的变更证明；拒绝**不是**失败证据，是"状态已变，请重读" ——
返回值里显式区分（`STATE_CHANGED` 命名即为此）。

**校准计划（替代拍脑袋）**：第一期用目标弱模型跑一个 20 文件
（覆盖 30~5_000 行）的编辑基准：统计拒绝率、重读次数、碰撞命中率。
N 的档位阈值据此微调；在实测之前按上表默认值实现，
全部参数收敛在 `hashline/signature.ts` 顶部一处，可单测、可改。

**反向证据**：dsh 官方自带的编辑工具是字面量唯一匹配的
`str_replace`（`view`/`create`/`str_replace`/`insert`，绝对路径 + 行号，
拒绝 0/多匹配、无 `replace_all`）—— 它把"逐字复现"的要求保留给了模型。
对本 fork 的弱模型场景，Hashline 的差异化价值由此得到反面印证。

---

## 3. PTC 模式：控制流在代码里

dsh 的四个运行模式中，**PTC 模式**（Code Mode SDK：
模型在**一个 TypeScript 程序里串联多次工具调用**，而非分散调用）
正是 `SELF-AUTHORED-TOOLS-DESIGN.md` §2.1 所需的运行时形态。

**为什么它更可靠**：控制流在**代码**里，不在模型的多轮决策里。
一个"读三个文件 → 比较 → 改其中一个"的任务，
分散调用要经过 4 次模型决策（每次都可能跑偏），
写成一段程序则只需 1 次决策 + 确定性执行。

**AIRI 已有这个东西**：`integrations/minecraft/src/cognitive/conscious/js-planner-*`
（1503 行主体 + 600 行测试），已验证的机制：

- 子进程隔离（`child.send` / `child.on('message')`，非同进程 eval）
- 双层超时：`hardTimeoutMs = max(timeoutMs + 2000, bridgeTimeoutMs + 2000)`
  （`js-planner-sandbox-runner.ts:57`）
- **capability-mediated bridge**：worker 只能发
  `{ type: 'bridge-request', requestId, method, args }`，
  父进程裁定后回 `bridge-response`（`js-planner-sandbox-protocol.ts:93-101`）
- stderr 捕获、catastrophic-error 分类

`method` + `requestId` 的 bridge **正是自造工具需要的形态**：
工具代码不能直接触碰宿主，只能请求已注册的能力。

**所以不需要发明，只需要把它从 MC 集成提取出来**
（对应 `SELF-AUTHORED-TOOLS-DESIGN.md` §8 第二期）。

### 3.1 创造模式对应 `draft` 态

dsh 的**创造模式**（标准能力 + 运行时自省 + **内存中的插件实验**）
恰好是 `SELF-AUTHORED-TOOLS-DESIGN.md` §3.1 的 `draft` 态：
先在内存里试，不落盘、不给网络、不给文件写。

即：这个状态机不是我们独创的，是一个已被验证的形态。

### 3.2 dsh Code Mode 的运行时形态（本机验证）

dsh 的 PTC 载体是本机安装可查的 `@deepseek-ai/dsh-code-runtime`：
`ctx.codeRuntime.run(request)` 对宿主提供的一组**具名异步绑定**
运行一段模型写的程序，报告 `{ value, logs, error? }`；
`CodeRunFailure` 用正交的 `kind` 分类全部失败形态
（解析/转换失败、异常、无效完成值、输出溢出、预算到期、中止、基底终止）。
Consumer 是工具注册表的 Code Mode：它生成面向模型的 SDK 并**桥接工具分发**；
首个 provider 是 Node worker 线程后端。

这与 AIRI 的 `js-planner-*` 是同一个设计点（§3 正文）：
**程序是消费者，工具分发是宿主裁定**。§9 的提取因此获得一个
平行参照实现 —— 提取时若 bridge 语义有疑问，可对照 dsh 的
"绑定 + 分发"切分复核。

**证据粒度裁决（原 §11.6）**：一段 PTC 程序里串联 5 次工具调用，
产生 **5 条**日志事件（每次 `bridge-request`/`tool-result` 各一条）——
对齐 §4.4 的 `tool/call` + `tool/result` 事件对，验证门按事件粒度判定，
投影层再按需聚合（§4.4 的投影注册表只管视图，不管事件数）。
dsh 的会话日志同样逐工具调用记录，粒度假说由此获得外部确认。

---

## 4. 事件日志：统一四泳道状态

**已确认采用。**

dsh 的核心不变量（官方页面）：

> 模型看到的一切都会写入**仅追加**设计的会话日志
> —— 系统提示、思维链、工具调用与结果、子 agent 派发、上下文注入。
> **恢复、分叉、检索与回放共享同一份事件流。**

一句话：**model-visible means logged**。

### 4.1 它简化了已有的三份设计

`WORKSPACE-DESIGN.md` §5.1 原本写"`TaskMemory` 与 `PlanState` 是
同一对象的两个视图，不要维护两份状态"。事件日志是这句话的完整版本：

**四条泳道的状态全部是同一条 append-only 日志的投影。**

| 原设计中的独立状态 | 修订后 |
|---|---|
| `PlanState` | 日志投影 |
| `TaskMemory` | 同一日志的人类可读投影 |
| `evidenceRefs` | 日志中 `tool_result` 事件的索引 |
| `reactions` | 日志中事件泳道的投影 |
| 记忆抽取 | 对日志的离线消费 |
| 压缩摘要 | 对日志区间的投影 |

比"四条泳道各有持久化策略"更干净，且**白送三样东西**：

1. **fork / resume** —— 试一个工具的两种写法（oh-my-pi 用的是
   JSONL **session tree** 而非平坦日志，支持分支与分支级 compaction）
2. **审阅切片** —— 审阅一个自造工具时，"它做了什么"就是日志的一段切片
3. **回放** —— 复现一次失败的任务，不必重跑

### 4.2 与压缩的关系

`MEMORY-DESIGN.md` §7 的压缩由此获得更准确的定义：
压缩**不删除日志**，只改变**投影策略** ——
被压缩的区间在投影时替换为摘要，原始事件永久保留。

这让"无感压缩"真正无感：用户永远不会丢失内容，
展开折叠即读原始日志。

### 4.3 边界：日志不等于上下文

必须与 `DESIGN-PRINCIPLES.md` 原则二一起读：
**日志记录一切，上下文只包含投影。**

"model-visible means logged" 是**单向**的 ——
凡模型看到的必被记录；但**凡被记录的不必都给模型看**。
工具的完整 stdout 进日志，进 prompt 的只有摘要。

### 4.4 日志的具体规格（第二期开工前定稿）

**存储格式**：每会话一条 append-only JSONL（可选 zstd 压缩），
首条为不可变的 `session/header`（含 `sessionId`、`parentSessionId`、
`cwd`、`createdAt`、`agentPreset`、`delegationDepth`），
后续每条一条事件；`seq` 连续（`events[i].seq === i`），
流式 `assistant/chunk` 事件**永不丢弃**。
这与 dsh `dsh-session-persistence-jsonl` 的磁盘布局逐点一致
（本机验证：`.jsonl.zstd` + 校验头 + append 帧 + 连续 seq）——
实现时直接对齐它，不必另发明。

**事件类型**（最小集，全部是原始快照，不是摘要）：

| 事件 | 载荷要点 | 说明 |
|---|---|---|
| `session/header` | id / parent / cwd / preset | 首条，不可变 |
| `user/message` | 文本 / 时间 | 对话泳道 |
| `assistant/start` / `chunk` / `done` | 分片流 | chunk 永不丢弃（4.1 不变量） |
| `tool/call` + `tool/result` | 工具名 / 参数 / 结果 | **evidenceRefs 就是这类事件的索引** |
| `plan/update` | 步骤状态 / 证据引用 | PlanState 是它的投影 |
| `task/update` | TaskMemory 快照 | replace-self，第 N 次覆盖第 N-1 次 |
| `context/inject` | 注入的上下文块 | 含来源标签（§8.1(4)） |
| `approval/asked` + `approval/decided` | 审批请求 / 决定 | 对齐 dsh approval seam 的审计对 |
| `review/asked` + `review/decided` | 审阅请求 / 结论 | 自造工具审阅切片（§4.1 白送 2） |
| `fork/point` | 分支锚点 / 父 seq | fork / resume 的唯一记录 |

**投影层**：`journal/projection.ts` 提供注册表 —— 领域侧注册
「纯数学投影单元」（PlanState、TaskMemory、reactions、压缩摘要……），
日志提交驱动已注册单元，快照带 `asOfSeq` 一致性切面。
这正是 dsh `dsh-session-projection` 的设计（本机验证），照抄其形状：
`register(def)` + `onChanged(listener)` + `snapshot(session) → { asOfSeq, values }`。

**归档策略（原 §11.3 落定）**：日志永远不删，但**冷归档**是明确策略：

- 触发：会话关闭后，日志 > 10MB（阈值可配）；
- 动作：整段 JSONL 导出到本地存档（用户目录/工作区外），
  会话存储中留下 `archived/pointer` 事件（指向存档路径 + 段范围）；
- 查询：`journal/` 打开折叠时按指针回读，展示层不变；
- 投影：归档会话的**活跃投影**随会话关闭销毁，只保留计数摘要。

原则二在这里是"压缩不删除"的存储级延伸：**原始事件永久保留，
被归档的只是活跃服务的对象**。不归档的热日志量级：
一个 3 小时任务约千级事件、几 MB —— 远低于阈值，不会常触发。

---

## 5. coding 能力归属：双层

**已确认采用「内置极简 + 外部代劳」。**

| 层 | 用于 | 实现 | 证据等级 |
|---|---|---|---|
| **内置** | 小任务：写适配层、改配置、修 bug | Pi 式 4 工具 + Hashline + PTC | `tool_result`（40，**可作变更证明**） |
| **外部** | 大任务：重构模块、跑完整测试链 | 写 skill 驱动 opencode / dsh / omp | `remote_agent_report`（45，**不可作变更证明**） |

两层的分工判据：**这个任务的产出需要作为"改动发生了"的证明吗？**
需要 → 内置层做（证据可信）；不需要或可事后本地核验 → 外部层做。

### 5.1 为什么飞轮必须靠内置层启动

若只做编排（不自己 coding），会遇到**启动依赖循环**：
她写第一个自造工具时也得靠外部工具，而外部工具的产出不可信，
于是第一个工具永远无法通过审阅进入 `reviewed`。

内置的 4 工具打破这个循环：**用可信的原语造出第一个工具。**

### 5.2 外部层的证据降级不是缺陷

让 omp 去重构一个模块，它回报"重构完成" —— 那是远端自称（45）。
但**本地可以核验**：用内置 `read` + `bash`（跑测试）产生
真正的 `tool_result`（40）。

即：**外部层负责干活，内置层负责取证。** 这与
`WORKSPACE-DESIGN.md` §2.4 的验证门天然契合 ——
`expectedEvidence` 声明"需要 tool_result 证明测试通过"，
omp 的自称满足不了它，本地跑一次测试才行。

---

## 6. Workspace：由审阅需求推导

`WORKSPACE-DESIGN.md` §4 当时的结论是"没有任何契约字段推导出 IDE 式多面板"。
`SELF-AUTHORED-TOOLS-DESIGN.md` §3.2 改变了这个结论 —— **审阅需要**：

- 工具源码全文
- diff 高亮（若为修订）
- `ModulePermissionDeclaration` 声明对照
- 静态分析结果（实际网络目标 / 文件路径 / 子进程调用）
- 该工具会读取哪些外部源（§3.2 第五项，`externalSources` 声明对照）

**这五样放在一起就是一个 workspace。** 但它的正当性来自
"审阅必须可行"，不是"我想要个像 Codex 的界面"。

所以你的直觉是对的，且与原推导不矛盾：

> **workspace = 审阅表面 + 证据表面，被需求推导出来，而非被参照物模仿出来。**

具体形态沿用 `ATTENTION-DESIGN.md` §5 的单窗口 + 任务卡折叠：
审阅是一个特殊的任务卡（`blocked` 且 `needsInput`），
展开即上述五要素。**没有多面板 IDE，因为没有需求推导出它。**

---

## 7. dsh 插件机制（已验证）与社区机会

`github.com/topics/dsh-plugin` 是一个活跃生态，且与本 fork 的设计高度对位：

| 插件 | 做的事 | 与我们的关系 |
|---|---|---|
| `EverMind-AI/EverOS` | local-first、Markdown-native 记忆层 | 与 `MEMORY-DESIGN` 同域 |
| `MemTensor/MemOS` | 自演化记忆，宣称省 35.24% token | 同域 |
| `volcengine/OpenViking` | 统一 memory / RAG / skills 的 Context DB | 同域 |
| `titanwings/distilly` | 可复用 **Skills** 蒸馏 | 与 `SELF-AUTHORED-TOOLS` 同域 |
| `anywhere-labs/dsh-desktop` | "万物皆插件，桌面本身也是插件" | 架构参考 |

**建议**：`MEMORY-DESIGN.md` 第二期开工前，先看前三个的 schema。
可能不必自己写（`DESIGN-PRINCIPLES.md` 原则五：先确认没有等价物）。

### 7.1 已验证：静态装配是 pnpm + bundles 列表（原"未验证假设"已解除）

本机安装的 dsh CLI（`@deepseek-ai/dsh`）、真实运行中的 `web` profile
与一个已装配插件（`dsh-super-injector`）共同证明了完整机制：

- **profile 目录** = `package.json` + `cordis.patch.yml`（用户 patch 层）+
  `pnpm-workspace.yaml`。`package.json` 里的 `dsh.profile.bundles`
  数组按顺序列出组合包：`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、
  以及用户插件（真实例子：`@dsh-external/dsh-super-injector`）。
  树外插件经 `dependencies` 的 `link:` 协议指向
  `~/.dsh/plugins/<name>`（junction 链接），由 pnpm 安装。
- **安装命令**：`dsh plugin --profile <name> <pnpm args>` —— 就是
  在 profile 目录里转发 pnpm。没有专门的包管理器，没有魔法。
- **插件包 = 普通 npm 包** + 少量 dsh 元数据
  （真实 package.json 验证）：`main` 指向 lib/（cordis 插件入口）、
  `peerDependencies` 声明 `cordis` / `schemastery` / `@deepseek-ai/dsh-tools`、
  可选 `dsh.bundle.patch`（本包自带的 patch 层 yml）与
  `dsh.client.inject` / `dsh.client.platform`（客户端运行时依赖）。
- **patch 层**是顶层 YAML 数组（id 定位的配置覆盖/禁用/插入表，
  允许 `!!js` 表达式）；层序：各 bundle 的 patch → profile 的
  `cordis.patch.yml` → home 级 → `--patch` 覆盖。

结论：**"AIRI 自己装插件"的机制问题已闭环** —— 静态安装是
「pnpm link + bundles 列表 + 一行 patch」的机械操作，
§7.2 的"读文档照做"只对**选包与验包**成立，安装动作本身是确定性的。

**残余风险（替换原"格式未知"风险）**：供应链与权限。一个第三方
bundle 的代码以 profile 权限执行 —— 装它之前应走
`SELF-AUTHORED-TOOLS-DESIGN.md` 同款审阅视角（源码 + 声明的
`ModulePermissionDeclaration` + 静态分析），只是审阅主体从"她写的工具"
换成"她要装的插件"。

### 7.2 「装插件 = 读文档照做」的双刃性

你观察到 codex 装插件是"把提示词发给模型让它执行"。
§7.1 的验证收窄了这句话的边界：**安装本身是机械的 pnpm 操作**，
读文档只用于两件事 —— 判断这个包值不值得装（供应链审阅），
以及确认它需要的配置项。前者是审阅问题（§7.1 残余风险），
后者是配置问题（`module:configuration` 三阶段已有）。

所以 AIRI 不需要包管理器，她需要的是**读文档并判别的能力** ——
而那正是自造工具飞轮的第一圈。**她装一个 dsh 插件和她给 opencode
写适配层，是同一个动作。**

**但这把 §8 的威胁放到了最大**：她读一段外部 README，然后按它说的做。

### 7.3 第二条通道：动态 cordis 插件（创造模式的完整形态）

本机安装的 cordis 插件开发 skill（`cordis-plugin-development`）证明
dsh 还有**会话内的动态插件通道**，工具级完全对照：

| dsh 原语 | 语义 | 对照本 fork 设计 |
|---|---|---|
| `cordis_define` | 定义插件的一个**不可变 Package**（`packageId` 即版本指纹） | `draft` 态产物；`packageId` = 内容哈希绑定 |
| `cordis_run` | 激活某 Package；`awaiting-approval` 等审批 | `draft` → `probation`，人工放行 |
| 勾选授权 | 单勾 = 仅当前 package；双勾 = 未来版本也放行 | 单勾 = 我们的审阅；**双勾是我们明确拒绝的**（`SELF-AUTHORED-TOOLS-DESIGN.md` 硬边界 5：审阅绑定内容哈希） |
| `cordis_inspect_*` | 运行时自省：注册表、服务、**自己 Package 的源码与诊断** | 审阅数据源（§6 workspace 四要素） |
| `cordis_stop` / `undefine` | 停用（保留版本与授权）/ 永久删除 | 降级 / 撤销 |
| fiber 绑定清理 | 插件停止后其工具/监听/UI 全部自动移除 | `ctx.effect` 资源规范（仓库已有） |
| `approval/asked` + `decided` 审计对 | 每次审批成对追加日志 | §4.4 事件表已有对应项 |

三个要点：

1. **它印证了 `SELF-AUTHORED-TOOLS-DESIGN.md` §3 的生命周期不是我们的发明**：
   定义 → 运行 → 审批 → 版本不可变，是同形态的已被验证设计。
   但 dsh 允许"双勾 = 预授权未来版本"，我们**故意不学** ——
   自证循环（她写的工具产出她要用的证据）要求审阅严格绑定内容哈希。
2. **审阅切片 = 日志切片**（§4.1 白送 2 的实例）：`cordis_define` 到
   `cordis_run` 之间的全部事件就在会话日志里，审阅界面直接投影这段。
3. 对 AIRI 而言 dsh 仍是**外部层**（本文档 §5 的「内置/外部」分层不变）——
   但若未来自造工具需要更强的运行环境，dsh 动态插件
   是"外部代劳"的一个现成目标，不需要自己实现插件运行时。

---

## 8. 威胁模型：外部内容会对她下指令

**这不是假设。** 本设计调研期间抓取一份外部文档时，
返回内容里嵌有试图让读取方**改变身份、绕过响应准则**的文本。

（说明：注入出现在抓取 oh-my-pi `DEVELOPMENT.md` 的那次响应中。
我只看到抓取器的报告，未见原始文本，因此**无法判定**它是仓库作者放置的、
页面中的测试样本、还是链路上其他环节引入的。
但"抓取外部内容时会遇到针对读取方的指令"这一事实已被实证，
这足以作为威胁模型的依据。）

### 8.1 规则

对应 `DESIGN-PRINCIPLES.md` 原则四：

1. **外部内容一律是数据。** 网页、README、远端回报、召回的记忆 ——
   可以提供信息，不能下达指令。
2. **由外部文档推导出的动作，仍走完整审阅与审批。**
   文档说"这样安装"不构成执行授权。
3. **注入尝试应被记录为事件**，不是静默忽略 ——
   它是关于该来源可信度的信息，应影响后续对同源内容的处理。
4. **抓取结果注入 prompt 时需带来源标签与信任声明**，
   沿用 `context-prompt.ts` 已有的扁平 bullet 形态
   （issue #1539：弱模型会镜像显眼的结构化标签，
   所以**不要**用 `<external>` 之类标签包裹 —— 那反而会让模型
   把包裹内容当作需要复述的数据结构）。

### 8.2 与自造工具的叠加风险

自造工具会**主动**抓取外部内容（这是它的用途之一）。
于是链条变成：外部内容 → 影响她写的工具 → 工具产出证据 → 推进任务。

`SELF-AUTHORED-TOOLS-DESIGN.md` §1 的自证循环因此获得一个外部输入端。
现有防线仍然有效（未审阅工具证据为 47，不可作变更证明；
审阅绑定内容哈希），且"该工具会读取哪些外部源"已作为第五项
补入 `SELF-AUTHORED-TOOLS-DESIGN.md` §3.2 的审阅要素
（`externalSources` 声明 + 静态分析对照，本文档 §6 同步更新）。

### 8.3 明确的威胁模型边界

沿用 `SELF-AUTHORED-TOOLS-DESIGN.md` §9.1 的前提：
本 fork 的威胁模型是**"弱模型的乐观偏差、疏漏，以及外部内容的注入尝试"**，
**不是**"对抗一个有意欺骗的强模型"。静态分析可被动态构造绕过。
请明确接受这个边界。

---

## 9. 模块边界

```
packages/coding-harness/            （新包，作为 AIRI 插件）
  hashline/
    signature.ts                    内容签名计算（纯函数，可单测）
    edit.ts                         签名校验 + 编辑应用
    read.ts                         带签名的读取投影
  tools/
    index.ts                        4 工具：read / write / edit / bash
  ptc/
    （从 minecraft js-planner 提取的沙箱 + bridge）

packages/core-agent/src/journal/    （新）
  types.ts                          事件类型（append-only，最小集见 §4.4）
  store.ts                          JSONL 追加 + seq 连续校验（对齐 dsh session JSONL）
  projection.ts                     投影注册表：日志 → PlanState / TaskMemory / 上下文
  tree.ts                           分支（fork / resume）
  archive.ts                        冷归档：导出 + pointer 事件 + 回读

packages/skill-forge/               （见 SELF-AUTHORED-TOOLS-DESIGN §7）
  sandbox/                          ← 与 coding-harness/ptc 共用提取成果
```

**`hashline/` 独立且纯函数化**是关键：签名算法与编辑校验必须能脱离
文件系统单测，因为它是弱模型可靠性的关键路径
（`DESIGN-PRINCIPLES.md` 原则一）。

---

## 10. 分期

**第一期 — Hashline ✅（已实现，`packages/coding-harness/`）**
签名算法 + 带签名的 read + 校验式 edit（`hashline/`：signature / read / edit，
纯函数，18 个单测）。`bash` 静态规则随 `authority/approval.ts` 落地
（`packages/core-agent/src/authority/`，authority 24 + journal 23 个新单测）。
两个新包尚未 `pnpm install` 进锁文件，装完即可 `pnpm -F @proj-airi/coding-harness test`。
§2.4 的弱模型编辑基准（校准 N 档位）留给接线期实测。

**第二期 — 事件日志底座 ✅（已实现，`packages/core-agent/src/journal/`）**
`types.ts`（§4.4 最小事件集）/ `store.ts`（JSONL + seq 连续 + header 首条）/
`projection.ts`（注册表 + replace-self/证据索引/context 三个内置单元）/
`tree.ts`（fork / 分支续 seq）/ `archive.ts`（阈值 + 指针事件），带单测。
接线（旁路记录 → 对照 → 切换读取侧）未做，属第四期以后的运行时工作。

**第三期 — 沙箱提取 + PTC ✅（核心已实现，`packages/coding-harness/src/ptc/`）**
MC 通用沙箱三件（protocol/runner/worker）已通用化提取（node:vm 基座、
fork 权限隔离，8 个单测过）；Code Mode SDK（dsh `codeRuntime` 形态，
失败按正交 kind 分类）+ 4 工具（read/write/edit-Hashline/bash 静态分级 +
审批回调）挂可注入宿主 + Node fs/子进程宿主（headless 可测）。
minecraft 侧双份并存待 install 后切换（WIRING-BACKLOG §1）；
Electron IPC 宿主与渲染注册属接线期。

**第四期 — 与权威链接合 ✅（核心闭环，`packages/core-agent/src/planning/`）**
journal `tool/result`（带 `stepId`/`provenance`）→ `collectStepGateRefs` →
验证门 → `projectStepGateStates`（pending/in_progress/blocked/completed/failed），
8 个单测；模型不能宣告完成，门是唯一完成判定。桌面审批卡/短会话循环属接线期
（WIRING-BACKLOG §3）。

**第五期 — 外部代劳层**
写第一个驱动 opencode 的 skill，走 `SELF-AUTHORED-TOOLS-DESIGN` 的审阅流程。

顺序依据：第一期独立收益最高且无依赖；第二期是后续三期的公共底座；
第五期必须在审阅界面（`SELF-AUTHORED-TOOLS-DESIGN` 第四期）之后。

---

## 11. 已知风险与待定问题

> 本版状态标注：**已裁决** = 决策已定并写入正文；**保持** = 仍需实测/试验数据。

1. **Hashline 签名碰撞 —— 已裁决 + 待实测。**
   碰撞由三层结构消化，不依赖模型自律：签名空间按文件行数自适应
   （<500 行 2 字符 / <4k 行 3 / 以上 4）；投影中长行截断保留前缀；
   `edit` 用「签名匹配 + 期望内容前缀二次确认」消歧，多匹配时拒绝不猜测。
   参数档位仍需按 §2.4 的校准计划在目标模型上实测微调 ——
   但**实现不等待实测**：默认值已定，全部收敛在 `hashline/signature.ts`
   顶部一处，换参数不需改逻辑。

2. **引用的 benchmark 数字未经我独立验证 —— 保持。**
   +15pp 与 6.7%→68.3% 来自二手文章（[yuv.ai](https://yuv.ai/blog/oh-my-pi-omp-explained)）。
   机制的合理性是清楚的（消除逐字复现要求），但**具体幅度应以你自己
   在目标模型上的实测为准**（§2.4 校准计划顺带产出本地基准）。
   此外 dsh 官方编辑工具是字面量唯一匹配（§2.4 反向证据），
   说明"逐字复现"假设在主流实现里也未被拆掉 —— 差异化的前提成立。

3. **事件日志的存储增长 —— 已裁决。**
   §4.4 归档策略：会话关闭 + 超阈值即冷导出，原始事件永不删除，
   活跃投影随会话销毁。不归档的热日志量级为千级事件/几 MB，不会常触发。

4. **dsh 插件机制 —— 已裁决。**
   静态装配（pnpm link + `dsh.profile.bundles` + patch 层）与动态
   cordis 插件通道均已本机验证（§7.1 / §7.3）。可以安心在其上建方案。
   剩余风险从"格式未知"变成**供应链信任**：第三方 bundle 以 profile
   权限执行，装前走与自造工具同款的审阅视角（§7.1 残余风险）。

5. **`bash` 工具的风险等级 —— 已裁决（第一期落地）。**
   结论：**默认只读沙箱 + 升权走审批**，镜像 dsh bash-sandbox 的
   fail-closed 设计（无约束执行器时返回 `SANDBOX_UNAVAILABLE`，
   绝不静默无约束运行）。静态规则在 `approval.ts` 硬编码，模型只能提议：
   - `read-only`（默认）：查询、测试、日志、`git status`/`diff` 类 —— 免审批
   - `medium`：工作区内写文件、安装依赖 —— 默认免审批，可配置改审批
   - `high`：`git push`、删除、网络出站、生产命令 —— **必审批**
   分级由命令模式/工具名的静态匹配判定；具体名单第一期用
   `computer-use-mcp` 已有的分类经验起步，随实测调整。

6. **PTC 模式下的证据粒度 —— 已裁决。**
   每次 `bridge-request`/`tool-result` 各一条日志事件，
   5 次调用 = 5 个证据（§3.2）。验证门按事件粒度判定，
   投影层可按步骤聚合显示。dsh 会话日志同样逐调用记录，外部印证。

7. **既有 store → 日志投影的迁移成本 —— 新增待办。**
   第二期把 `PlanState`/`TaskMemory`/`reactions` 等的来源统一到日志投影时，
   会触碰 `ATTENTION-DESIGN.md` 与 `WORKSPACE-DESIGN.md` 描述的状态所在
   的现有代码路径。风险不是逻辑（投影是纯函数），而是**接线期间双写**：
   建议第二期先在 `journal/` 侧旁路记录、与现有 store 并存对照，
   对照一致后再切换读取侧 —— 这与"提取契约不要求同步迁移"的
   `WORKSPACE-DESIGN.md` §7.2 原则一致。
