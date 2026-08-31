# AIRI 自造工具与 Skill 设计（fork `mods` 分支）

**状态**：设计完成（待评审）。**第一期 / 第三期 / 第四期（镜像接线）已实现**；
第二期（skill-forge 侧沙箱消费）与第五期未动（详见 `WIRING-BACKLOG.md`）。
**问题**：让她读本地程序源码（如 opencode），按 skill 原则自己写远程工具，
连接/访问/控制/监视，并作为新能力保留下来。
**核心难点**：她写的工具产出她要用的证据 —— **自证循环**。

**总纲**：见 `DESIGN-PRINCIPLES.md`。
**文档序列**：`ATTENTION-DESIGN`（什么进上下文）→ `WORKSPACE-DESIGN`（什么算真的）
→ **本文档**（能力如何增长）→ `CODING-HARNESS-DESIGN`（如何可靠改代码）
→ `MEMORY-DESIGN`（什么值得留下）。

> **已被后续修订的部分**：§3.2（审阅四要素补"读取哪些外部源"）、
> §9.6（外部内容注入，已实证）。
> §2.1 的沙箱提取与 `CODING-HARNESS-DESIGN.md` §3 的 PTC 模式是同一件工作。
>
> **本版完成内容**（2026-08-28，全部结论经代码/本机安装复核）：
> - §1.3 补现状核对：`planning-orchestration/contract.ts` 目前只有原 10 个
>   权威源，42/45/47 三个新源是**第一期的增量 diff**（追加不改动）。
> - §3.4 新增：dsh 动态 cordis 插件通道对生命周期的外部印证，及一处
>   **故意不学**的差异（"双勾 = 预授权未来版本"）。
> - §5 契约补全：`externalSources` 字段（对应 §3.2 审阅项）与
>   `compatibility` 自检字段（原 §9.4 落定）；§9.2 的审阅疲劳缓解
>   落为具体上限（probation 并发数 + dream 批处理）。
> - §9.3（riskLevel 粒度）与 §9.4（目标 API 稳定性）已裁决。
> - §2.1/§2.2 的代码引用在本版全部复核通过（文件/行号见各节）。

---

## 0. 判断：可行、有价值，但必须先解自证循环

**可行性高** —— 三样基础设施已经存在（§2），这不是从零造。

**价值高** —— 它把 AIRI 从「工具的使用者」变成「工具的作者」。
现有路径下她的能力上限 = 你为她包装了多少 MCP；
自造工具让上限变成 **她能理解多少源码**。

**但有一个致命反噬**，且它不是工具调用格式问题（M1 的双重编码坑
已由 `sanitizeMcpToolName` 解决）。真正的问题是权威链的**自证循环**。

---

## 1. 致命处：自证循环

### 1.1 链条

1. 你让她读 opencode 源码，按 skill 原则**自己写**一个远程工具
2. 该工具连上去、控制、监视，返回 `remote_agent_report`（45，不能作变更证明）
3. 她拿这个报告推进任务

问题在第 1 步与第 2 步的**同源性**：

> **她写的工具，产出她要用的证据。**

`remote_agent_report` 降级（45）的前提是「远端是独立的、我们不控制的东西」，
所以自称不可信。但若**远端工具是她自己写的**，这个降级形同虚设 ——
她可以（不必是恶意，弱模型的乐观偏差就够了）写一个总是返回
`{ ok: true }` 的适配层，然后**诚实地**引用它。

**证据链每一环都合法，结论是错的。**

这比 `MODS.md` M2 的幻觉更难查：M2 是模型凭空声称调用了工具；
现在是它**真的调用了**一个真实存在的工具，而那个工具在撒谎。
日志、trace、evidenceRef 全都对得上。

### 1.2 现有权限机制解决不了这个

已验证 `ModulePermissionDeclaration`（`plugin-protocol/src/types/events.ts:435`）：

```text
apis?:         ModulePermissionSpec<'apis', 'invoke' | 'emit'>[]
resources?:    ModulePermissionSpec<'resources', 'read' | 'write' | 'subscribe'>[]
capabilities?: ModulePermissionSpec<'capabilities', 'wait' | 'snapshot'>[]
processors?:   ModulePermissionSpec<'processors', 'register' | 'execute' | 'manage'>[]
pipelines?:    ModulePermissionSpec<'pipelines', 'hook' | 'process' | 'emit' | 'manage'>[]
```

配套有完整的 declare / request / granted / denied 流程，`source: 'manifest' | 'runtime'`。

**但这套机制约束的是「工具能访问什么」，不是「工具产出的证据可信几分」。**
权限与证据可信度是两个**正交**维度，目前只有前者。

### 1.3 解法：证据的出处血缘（第三个维度）

`PlanEvidenceRef.source` 现为
`'tool_result' | 'verification_gate' | 'human_approval' | 'runtime_trace'`,
隐含假设「所有 tool_result 一样可信」。自造工具打破该假设,需要细分:

| 证据来源 | 工具作者 | precedence | `maySatisfyMutationProof` |
|---|---|---|---|
| 内置工具返回 | 你 / 上游 | 40 | **✅** |
| **已审阅**自造工具 | 她写，**你读过并批准** | 42 | **✅** |
| 远端 agent 自称 | 远端（独立） | 45 | ❌ |
| **未审阅**自造工具 | 她写，无人审阅 | 47 | ❌ |

新增两个 `PlanningAuthoritySource`：

```text
| 'reviewed_self_authored_tool_result'    // precedence 42, mutationProof: true
| 'unreviewed_self_authored_tool_result'  // precedence 47, mutationProof: false
```

`remote_agent_report`（45）按你已确认的方案加入。

**现状核对（2026-08-28）**：`contract.ts` 的 `PLANNING_AUTHORITY_ORDER`
目前只有原 10 个源（0..90，全部复核无误，`trusted_current_run_tool_evidence`
仍是唯一 `maySatisfyMutationProof: true`）。上述三个新源**尚未在代码里**，
是第一期 `authority/` 提取时的增量 diff：追加三项 + 表格常量更新，
不改动任何既有行 —— 纯加法，零行为变更，这正是第一期能"零新功能"
独立交付的原因。

**注意 47 排在 45 之后**：未审阅的自造工具比独立远端**更**不可信，
因为它同源于使用者，而远端至少是独立实现的。

---

## 2. 可行性：三样基础设施已存在

### 2.1 沙箱执行范式

`integrations/minecraft/src/cognitive/conscious/js-planner-*`
（1503 行主体 + 600 行测试）。已验证的机制：

- **子进程隔离**（`child.send` / `child.on('message')`，非同进程 eval）
- **双层超时**：`hardTimeoutMs = max(request.timeoutMs + 2000, bridgeTimeoutMs + 2000)`
  （`js-planner-sandbox-runner.ts:57`）
- **capability-mediated 通信**：worker 只能发
  `{ type: 'bridge-request', requestId, method, args }`，
  由父进程决定是否执行并回 `bridge-response`
  （`js-planner-sandbox-protocol.ts:93-101`）
- stderr 捕获（`withCapturedStderr`）、catastrophic-error 分类

**`method` + `requestId` 的 bridge 正是自造工具需要的形态**：
工具代码不能直接触碰宿主，只能请求已注册的能力。
「让模型写代码然后安全地跑它」在你的仓库里已有实战实现。

### 2.2 工具注册范式

`packages/plugin-sdk-tamagotchi/src/tools/registry.ts`：

```ts
interface SerializedXsaiToolDefinition {
  ownerExtensionId: string // 所有权隔离
  name: string
  description: string
  parameters: HostDataRecord
}

interface RegisteredPluginToolDescriptor {
  activation: {
    keywords: string[] // ← 这就是 skill 的按需激活机制
    patterns: string[]
  }
}

interface ToolsetPromptManifest { id, title?, content } // 每个工具集自带模型指引
```

`activation.keywords` / `patterns` 已经是「skill 按需加载」的实现基础 ——
不需要把所有自造工具的描述常驻在 prompt 里。

### 2.3 人工审阅记录范式

`services/computer-use-mcp/coding-plast-mem-bridge-contract.md` 已定义：

```text
humanVerified: true
review: { reviewer: string, rationale: string, reviewedAt: string }
trust: 'reviewed_coding_context_not_instruction_authority'
```

**这正是「本地产生的东西如何获得信任」的现成模式，直接复用。**

---

## 3. 信任模型：默认不可信，人工审阅后毕业

**已确认采用。**

### 3.1 生命周期

```
draft        她刚写完，只能在沙箱里干跑（无网络、无文件写）
  ↓ 她自测通过
probation    可实际调用，但证据记为 unreviewed_self_authored_tool_result（47）
  ↓ 你读代码 + 批准
reviewed     证据升级为 reviewed_self_authored_tool_result（42），可作变更证明
  ↓ 代码被修改
probation    任何 diff 都使审阅失效，退回 47
```

**「代码被修改即退回」是这个模型的关键**：否则她可以先提交一个无害版本
骗到审阅，再改成任意内容。审阅绑定的是**内容哈希**，不是工具 id。

### 3.2 审阅时你看到什么

审阅不是看她的自然语言描述（那可以撒谎），而是看：

- 工具源码全文（diff 高亮，若为修订）
- 它声明的 `ModulePermissionDeclaration`（要访问什么 API / 资源 / 网络）
- 静态分析结果：实际出现的网络请求目标、文件路径、子进程调用
  —— **与声明不符时直接拒绝入库**（不进审阅队列）
- 静态判定的 `riskLevel`（§4）
- **该工具会读取哪些外部源**（新增，见 §9.6）——
  抓取外部内容的工具会把不可信输入引入链条，必须显式列出并单独评估

> **修订**：外部内容注入已被实证（`CODING-HARNESS-DESIGN.md` §8），
> 不再是理论风险。凡会抓取网页 / 读取远端文档的自造工具，
> 审阅时须确认它把抓取结果当**数据**处理，而非当指令执行。

### 3.3 为什么不用自动毕业

自动毕业（连续 N 次成功 + 独立验证）的问题：
一个写得差但**碰巧对了 N 次**的工具会蒙混过关，
而它恰恰是最危险的 —— 它在边界情况下的行为无人知晓，
却已经取得了 `maySatisfyMutationProof` 的资格。

自动毕业也无法防御 §1.1 的乐观偏差：一个总返回 `{ ok: true }` 的工具
**总是**「成功」。

### 3.4 外部印证：dsh 的动态 cordis 插件是同一个生命周期

dsh 官方提供**会话内的动态插件通道**（本机安装的
`cordis-plugin-development` skill 验证，工具级对照见
`CODING-HARNESS-DESIGN.md` §7.3）：`cordis_define` 定义不可变
Package（`packageId` 即版本指纹）→ `cordis_run` 激活并等审批 →
单勾授权当前 Package / **双勾授权未来版本** → 停用/撤销走
`cordis_stop`/`cordis_undefine`，fiber 绑定自动清理。

对本设计的两个含义：

1. **生命周期形态有外部验证**。定义 → 运行 → 审批 → 版本不可变，
   与 draft → probation → reviewed 逐点对应；审批审计对
   （`approval/asked` + `decided`）进会话日志，正是
   `CODING-HARNESS-DESIGN.md` §4.1 说的"审阅切片 = 日志切片"的现成实例。
2. **一处故意不学**：dsh 的"双勾 = 预授权该插件的未来版本"。
   对 dsh（普通能力插件）这是便利；对本 fork（自造工具）这是
   打开自证循环的后门 —— 未来版本可能是在"已 reviewed"光环下
   写出的任意代码，未审阅先放行。**我们保持审阅严格绑定内容哈希**
   （硬边界 5），即使这意味着每次修订都要重审。

---

## 4. 硬边界（不可协商）

自造工具最危险的不是它能做什么，而是**它能修改自己的信任状态**。必须硬性禁止：

1. **自造工具不能注册新的自造工具** —— 否则递归绕过审阅
2. **自造工具不能写入任何 `authority/` 状态** —— 不能自我提权、
   不能篡改 evidenceRef、不能改审阅记录
3. **`riskLevel` 由静态规则判定，不能自评** —— 依据是它声明并经静态分析
   确认的访问范围（网络出站 / 文件写 / 子进程 / 凭据读取）
4. **`draft` 态不给网络与文件写** —— 自测只能在沙箱内用 mock bridge
5. **审阅绑定内容哈希** —— 见 §3.1

第 3 条与 `WORKSPACE-DESIGN.md` §7.1 同源：风险等级让模型自评，
它会低估以避免被打断。自造工具场景下这条更关键，因为后果是持久的。

---

## 5. Skill 的形态

「Skill」在本设计里 = **一个自造工具 + 它的激活条件 + 它的模型指引**，
三者已分别对应 §2.2 的三个现成结构：

```
Skill := {
  tool:       SerializedXsaiToolDefinition   // 做什么
  activation: { keywords, patterns }         // 何时加载
  prompt:     ToolsetPromptManifest          // 怎么用
  trust:      'draft' | 'probation' | 'reviewed'
  contentHash: string                        // 审阅绑定（任何 diff 使审阅失效）
  review?:    { reviewer, rationale, reviewedAt }
  externalSources: string[]                  // 会读取哪些外部源（§3.2 审阅项四）
  compatibility?: {                          // 目标程序版本自检（§9.4 落定）
    probe: { command: string, expectedPattern: string }
    onMismatch: 'quarantine'                 // 探测失败 → 退回 probation + 标记待审
  }
}
```

`externalSources` 在 `draft` 阶段由工具的静态分析填充
（抓取 URL 前缀 / 文档路径），审阅时**对照声明逐项确认**
（`CODING-HARNESS-DESIGN.md` §8.2 的外部输入端检查项）。
`compatibility` 是防"目标程序升级后适配层静默失效"的结构手段：
每次调用前跑一个轻量探测（如 `opencode --version` 匹配预期模式），
失配即 `quarantine` —— 返回错误结果之前先承认自己过时了。

**按需激活是必须的**：如果她攒了 40 个自造工具，全部描述常驻 prompt
会挤占上下文（这正是 `ATTENTION-DESIGN.md` 要解决的同一类问题）。
`activation` 决定哪些进入当轮 `## Toolset`。

**审阅队列的配套约束**（§9.2 疲劳风险的结构化解法）：

- `probation` 态工具**并发上限 = 5**（可配）。超限时新工具停在
  `draft`，直到有工具毕业或撤回 —— 上限制造队列，队列制造审阅节奏，
  防止你开始盲批。
- `dream` 修订默认**攒批**（按周汇总），不逐条即时提交。
- 审阅队列条目 = `{ toolId, contentHash, diff?, staticAnalysis, riskLevel,
  externalSources, reason }` —— 全部是静态产物，没有她的自然语言描述
  （那可以撒谎，`DESIGN-PRINCIPLES.md` 原则六）。

### 5.1 opencode 场景的具体形状

以你举的例子走一遍：

1. **读源码**：她用内置的文件读取工具（40，可信）读 opencode 的
   CLI 定义、配置格式、API 表面
2. **写适配层**：产出一个 skill —— 声明需要「子进程调用 `opencode` 二进制」
   + 「读写某个工作目录」
3. **静态分析**：确认代码里的子进程调用与声明一致，`riskLevel = high`
   （子进程 + 文件写）
4. **draft 自测**：沙箱内用 mock bridge 跑通参数解析
5. **probation**：真实调用，但任何「我改好了」的声称都不算证明（47）
6. **你审阅**：读那几十行适配代码 —— 这是**有界的**审阅工作，
   不是审阅一个黑箱
7. **reviewed**：升到 42，从此她用它完成的改动可以作为变更证明

第 6 步的有界性是这个设计能成立的原因:**给一个有 CLI/配置/API 的
程序写适配层是有界、可验证的工作**,不是开放式的代码生成。

---

## 6. 与记忆层的耦合：工具即 muscle memory

**已确认采用。** 这是本设计我认为最有价值的部分。

`MEMORY-DESIGN.md` 里 `memory_type: 'muscle'` 当时只能给出
「精确匹配触发固定响应」这样很弱的定义 —— 因为纯对话场景下
muscle memory 没什么可做的。自造工具给了它真正的语义：

> **一个被审阅通过、反复成功使用的自造工具,就是 muscle memory 的物理形态。**

「条件反射」不再是一段文本,而是一个**可执行单元**。于是记忆层的
既有字段全部获得具体含义:

| `memory_fragments` 字段 | 自造工具语义 |
|---|---|
| `memory_type: 'muscle'` | 这是一个 skill，不是一段陈述 |
| `content` | 工具用途描述（供语义检索） |
| `trigger_pattern`（§3.1 新增列） | `activation.patterns` |
| `access_count` | 成功调用次数 |
| `half_life_hours = ∞` | 不衰减（reviewed 工具不会因久置而失效） |
| `session_ids` | 跨会话使用记录 |
| `importance` | 由 trust 状态映射（reviewed 更高） |

**晋升规则获得新含义**：`short_term → long_term` 原本是
「跨会话反复召回的事实变成长期记忆」；在工具上就是
**「从试验品变成常备能力」**。

作者四层记忆里最虚的一层,因此落地了。

### 6.1 dream 字段的新用途

`memory_short_term_ideas.source_type: 'dream'` 原本只是个占位。
自造工具场景下它有了具体形态：**空闲期回顾失败的工具调用、
改进自己写的适配层**。

产出的是 `probation` 态的工具修订（退回审阅），而不是直接生效 ——
硬边界 §4.5 保证了这一点。这是 DevLog 结尾
「dreaming agent 处理并索引记忆」的一个可执行版本。

### 6.2 检索边界不变

`MEMORY-DESIGN.md` §8 的订阅边界仍然成立：
工具的**调用日志不进记忆库**，只有工具本身（作为 muscle 条目）
和它的**结论**进。一个装满 `opencode --help` 输出的记忆库毫无价值。

---

## 7. 模块边界

```
packages/core-agent/src/authority/
  contract.ts             +3 个 authority source（42 / 47 / 45，纯增量，§1.3）
  provenance.ts           （新）证据血缘判定：给定 evidenceRef → 权威等级

packages/skill-forge/     （新包）
  types.ts                Skill 契约（§5，含 externalSources / compatibility）
  lifecycle.ts            draft→probation→reviewed 状态机 + quarantine 转移（纯函数）
  static-analysis.ts      声明与实现一致性检查、riskLevel 静态判定（§9.3 档位表）
  hash.ts                 内容哈希与审阅绑定
  sandbox/                复用 js-planner 的子进程 + bridge 范式

packages/stage-ui/src/stores/
  skills.ts               （新）skill 注册 / 激活 / 审阅队列（probation 并发上限 5）

packages/stage-pages/src/pages/settings/modules/
  skills.vue              （新）审阅界面：源码 diff + 声明 + 静态分析结果 + externalSources
```

**为什么 `skill-forge` 独立成包**：它同时被桌面端（注册/激活）和
未来可能的 CLI（批量审阅）使用，且状态机与静态分析是纯逻辑、可单测。
沙箱部分从 minecraft 的 js-planner 提取共享 ——
那份实现现在耦合在 MC 集成里，但它是通用能力。

---

## 8. 分期

**第一期 — 血缘维度 ✅（已实现，`packages/core-agent/src/authority/`）**
`contract.ts` 提取 + 3 个权威源（42/45/47，纯增量）+ `provenance.ts`
（证据→权威映射，`tool_result` 必须带作者）；连同验证门 `gate.ts`
与分级审批 `approval.ts`（含 bash 静态规则）一并落地，带单测。
`computer-use-mcp` 侧未迁（按 §8「不要求同步迁移」原则，双份并存）。

**第二期 — 沙箱提取 ⏳（共享提取已就位，skill-forge 消费待 install）**
通用沙箱（子进程 + capability bridge）已随 `CODING-HARNESS-DESIGN.md`
第三期提取到 `packages/coding-harness/src/ptc/`（通用化 + 8 单测）。
skill-forge 侧把 `sandbox/` 接到该共享包属接线期（WIRING-BACKLOG §1），
MC 侧 import 切换同理。

**第三期 — Skill 契约与生命周期 ✅（已实现，`packages/skill-forge/`）**
`types.ts`（§5 契约，含 externalSources / compatibility）/ `lifecycle.ts`
（draft→probation→reviewed + quarantine + probation 并发上限 +
审阅/隔离输入校验）/ `hash.ts`（内容哈希，审阅绑定）/ `static-analysis.ts`
（riskLevel 档位表 + 声明一致性），21 个单测。仍不接运行路径，可完全单测。

**第四期 — 审阅界面 ✅（镜像接线，`packages/stage-ui/src/stores/skills.ts` +
`packages/stage-pages/.../skills.vue`）**
审阅队列 store（probation 并发上限 5、内容变更即退回、审阅绑定哈希、
拒绝即移除）+ 设置页（风险徽章 / 静态分析 / 外部来源 / 哈希 / 批准拒绝）
+ 设置模块注册 + i18n（en/zh-Hans）+ opencode 适配器**骨架**入 catalog
（7 个单测）。镜像层与 `@proj-airi/skill-forge` 的收敛条件见 store 头部
NOTICE（install 后执行，WIRING-BACKLOG §0）。
**此期结束后才允许她真的写第一个工具。**

**第四期 — 审阅界面**
`skills.vue`:源码 diff、声明对照、静态分析结果、批准/拒绝。
**此期结束后才允许她真的写第一个工具。**

**第五期 — 接入记忆层**
muscle 条目、activation 按需加载、dream 修订。

前四期都是结构工作,不考验基底模型;第五期开始才需要她真的会写代码。
**顺序上必须先有审阅界面再有自造能力** —— 否则第一个工具就无从验证。

---

## 9. 已知风险与待定问题

> 状态标注：**已裁决** = 决策已定并写入正文；**保持** = 仍需实测/试验数据。

1. **静态分析可以被绕过 —— 保持。**
   动态构造的字符串（`eval`、拼接出来的 URL、`require(变量)`）能躲过静态检查。
   缓解：`draft`/`probation` 阶段禁用动态代码求值原语；
   审阅时若发现动态构造，默认拒绝。
   **这仍然不是密码学意义的安全** —— 本设计的威胁模型是
   「弱模型的乐观偏差与疏漏」，不是「对抗一个有意欺骗的强模型」。
   请明确接受这个前提。

2. **审阅疲劳 —— 已裁决（结构性缓解）。**
   如果她每天产出 10 个工具修订，你会开始盲批，审阅就退化成橡皮章。
   缓解已写入 §5：`probation` 并发上限 5（制造队列、控制节奏）、
   `dream` 修订默认攒批、审阅条目只含静态产物（无自然语言描述）。
   剩余部分依赖你的实际负荷，第四期上线后按真实队列长度调上限。

3. **`riskLevel` 静态判定的粒度 —— 已裁决（先粗后细，档位表先行）。**
   判定依据是静态分析确认的访问范围，**模型不能自评**（§4 硬边界 3）。
   起步档位表（第三期按实际产出的工具调参，规则集中在
   `static-analysis.ts` 一处）：

   | 档位 | 静态发现 | 默认 |
   |---|---|---|
   | `low` | 纯计算 + 只读资源访问（参数解析、格式转换） | 无需审批 |
   | `medium` | 工作区内文件写 / 只读子进程（白名单命令） | 无需审批，可配置改审批 |
   | `high` | 网络出站 / 任意子进程 / 凭据读取 / 删除破坏类 | **必审批** |

   判据与 `CODING-HARNESS-DESIGN.md` §11.5 的 `bash` 静态规则同一套
   思路（命令模式/动作类型静态匹配），实现可共用一份规则组。

4. **opencode 这类目标的 API 稳定性 —— 已裁决。**
   她写的适配层依赖目标程序的 CLI/配置格式，目标升级后适配层静默失效。
   解药是 §5 的 `compatibility` 自检字段：调用前轻量探测版本，
   失配即 `quarantine`（退回 probation + 标记待审），**先承认过时、
   再谈修复** —— 而不是返回一个看起来成功的错误结果。
   第三期把它与 `probe` 执行器一起落地。

5. **与 plast-mem 的潜在冲突 —— 保持。**
   若 upstream 的 plast-mem 将来定义了自己的 skill/能力概念，两者可能语义重叠。
   当前 plast-mem 仍 pre-0.1.0 且专注 conversation ingestion，冲突风险低，
   但 `skill-forge` 的契约应避免占用过于通用的命名。

6. **外部内容注入（已实证，非理论风险）。**
   自造工具的用途之一就是抓取外部内容，而外部内容会试图对读取方下指令。
   本 fork 调研期间抓取一份外部文档时，返回内容里就嵌有试图让读取方
   改变身份、绕过响应准则的文本（详见 `CODING-HARNESS-DESIGN.md` §8）。

   于是自证循环（§1）多了一个外部输入端：

   ```
   外部内容 → 影响她写的工具 → 工具产出证据 → 推进任务
   ```

   现有防线仍然有效（未审阅工具证据为 47 不可作变更证明；
   审阅绑定内容哈希），但需要三条补充：

   - 审阅四要素补一条"该工具读取哪些外部源"（§3.2 已更新）
   - 抓取结果注入 prompt 时带来源标签与信任声明，
     且**不要**用 `<external>` 之类标签包裹 ——
     `context-prompt.ts` 的注释（issue #1539）已证明弱模型会镜像
     显眼的结构化标签，反而把包裹内容当成需复述的数据结构
   - 注入尝试应**记录为事件**而非静默忽略：它是关于该来源可信度的信息，
     应影响后续对同源内容的处理

   **威胁模型边界不变**（§9.1）：本设计对抗"弱模型的乐观偏差、疏漏，
   以及外部内容的注入尝试"，**不对抗有意欺骗的强模型**。
