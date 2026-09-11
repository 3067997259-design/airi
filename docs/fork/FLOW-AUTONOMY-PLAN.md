# FLOW-AUTONOMY：心流自主化修复（2026-09-03，已实施）

> 状态：**已实施，单测与类型检查全绿，待真机验收。**
> 前置：本计划以 FLOW-FIX（`0f0f54bbc`）、FLOW-STEP、FLOW-EVIDENCE 三批已落地代码为基线。
> 对照系：对开源 Codex CLI 的 harness 审计结论（软控制/硬控制分层、stop-hook 位置、
> 计划是工作记忆而非调度器）。

## 0. 总纲：外硬内软

FLOW-FIX 之前的心流有一个错位结构：**过程被硬化勒死，完成判定却是弱判据**。
no-progress 只看「有没有改文件」，把合法勘探判死；done 门却只看「有没有过一次变更」，
`ok:true count:0` 型的假完成照样放行（journal `9ce4c7cd` seq 352-490 实测）。

本计划的裁决是**外硬内软**：把「过程」还给模型（Codex 式控制流），把「边界」留给人格
之上的 harness（fork 总纲「让她的错误无法伪装成成功」）。

| | 归属 | 具体项 |
|---|---|---|
| **还给模型（软化）** | 过程 | 继续/停止的默认判断、节奏（步预算是节拍器）、规划与拆解（hint 不再牵引工具选择）、探索自由（新观察 = 进展） |
| **保持硬** | 边界 | call/output 协议与 journal、证据台账与 provenance、bash 分级/审批/workspace 边界、repeat-failure 拦截、stale-edit 强制重读 |
| **升级而非软化** | 完成 | L1 步骤门合取（机械）→ L2 语义正则（已有）→ L3 done 边界 LLM 评审（新增，即 Codex 的 stop-hook 位置），只在声明边界运行 |

## 批次 A：解开过程缰绳（runtime）

- **A1 触发清理**：`structuralFlowTrigger` 移除 `todo_write`（实测 #2：记账动作
  启动了停滞时钟）。保留 write/edit、`plan_update:start`、`flow_update:start`。
- **A2 停滞检测替代 no-progress**：`zeroProgressTurns` 改名 `stalledTurns`，判据从
  「零变更成功」改为「零变更成功 **且** 零新增互异成功观察」。互异 = toolName + args
  哈希在本 flow 内首见（`seenObservations`，上限 200）。勘探轮永远算进展；重复同样的
  调用才算停滞。阈值 3 不变（`FLOW_STALLED_TURNS`）。
- **A3 hint 去武器化**：`plan/hint` 只对变更类工具（write/edit/bash/code_mode）发射；
  勘探工具的结果不再触发 mismatch hint，也不再重置 streak（不确定化）。flowPrompt 里的
  streak 提示从命令式改为 advisory。
- **A4 预算模型**：`softBudget` 改名 `flowStepBudget`，默认 **2**（`FLOW_STEP_BUDGET`），
  send options 可调；turn/start journal 记录生效预算 `stepBudget`（修复 maxSteps=50 死配置
  的不可见性）；新增 `FLOW_MAX_DURATION_MS`（45 分钟墙钟），`continueFlow` 检查。
- **A5 done 门过程半边重定义**：移除 `pendingEnd==='done' && flowMutationSuccesses===0`
  的粗暴拒绝（原 `FLOW_DONE_GATE_MESSAGE`）。变更要求下沉到 L1 步骤门：步骤声明了
  副作用才要变更证明。纯分析型 flow 从此可合法 done，由 L3 裁决内容。

## 批次 B：步的节奏（心流之步 = 迭代）

`flowPrompt` 重构为**迭代开场契约**：

```
[Flow continuation N]
You are working autonomously. This iteration allows about 2 tool steps …
Open with one or two sentences: what you concluded … Then act.
Continue the current task from the verified history. Do not wait for a user message.
[User steering]（如有）
Your earlier done declaration was rejected:（如有驳回反馈）
（Excluded paths / Read before edit / hint advisory / flow projection 照旧）
```

叙述被结构性放在迭代开场（=「思考→输出」的输出位），预算透明化写入开场。
工具间隙的 prepareStep 叙述指令保留（软）；心流最后一步追加「干净收尾」提醒。

## 批次 C：完成权威重构（本计划的心脏）

**三层完成判定，只在 done 声明的回合边界运行，过程零开销：**

1. **L1 步骤门合取**（`packages/core-agent/src/planning/flow-completion.ts` 的
   `evaluateFlowCompletion`）：flow 触及的每个计划（含本 session 的未结会话级计划）
   的每一步，要么证据门 completed，要么被 `plan_update complete` 显式关闭（记
   unverified）。失败 → blockers 写入 `flow.feedbackTrail`（上限 4），下一迭代开场
   注入「Your earlier done declaration was rejected: …」，journal 记
   `flow/completion-review {layer:'gate', verdict:'rejected'}`。
2. **L2 验证语义正则**：已有（`gate.ts` 的 `not_verified_outcome` / `not_diff_content`），不变。
3. **L3 done 边界 LLM 评审**：`deps.reviewFlowCompletion` 端口，输入 = flow 起点后有界
   journal 切片（≤200 事件）+ done 声明文本，输出 `{verdict: pass|bounce|abstain}`。
   stage-ui 接线复用记忆摘要的低费模型通道；bounce 必须引用具体回执（工具名或 seq，
   `parseFlowReviewVerdict` 机械校验），否则降级 abstain；解析失败/无模型 → abstain 放行。
   **bounce 上限 2**（`FLOW_DONE_BOUNCE_LIMIT`）：第 3 次同样被驳时，flowPrompt 指示她
   停止迭代、用 btw_ask/user_ask 带着阻塞项问用户。

**收尾诚实（C5）**：`endFlow('done')` 的 detail 携带 unverified 清单；wrap-up 消息渲染。

**真空通过规则**：无计划活动的 flow L1 真空通过，由 L3 单独裁决——这是分析型任务
能诚实完成的机械保证。

## 批次 D：steering 并入

单一规则：**心流期间用户文本 = steering**。`continueFlow` 把本 session 所有排队 send
（不限 delivery）的文本收进 `flow.steerQueue`（上限 3 条、每条 500 字符），排队项以
**resolve**（非 reject）出队，journal 记 `user/steering`；下一迭代开场以 `[User steering]`
注入并声明其优先级高于当前步序。flow 运行中 `ingest` 不再设置 `steerRequested`
（不再中途杀死回合）。停止按钮与 `/flow off` 仍直接 endFlow。

## 批次 E：可见性

- **E1 时间线卡**：`flow-timeline-card.vue`（stage-ui chat scenarios），`history.vue`
  新增 `flow` 时间线项。收起 = 状态行（轮次 + 工具调用数）；展开 = flow 窗口内的
  journal 活动流（工具调用/结果、她的叙述 chunk、steering、计划更新、完成评审），
  上限 40 行。数据来自 journalStore（`hiddenFromHistory` 的心流迭代从此在时间线上有
  一个可见锚点）。devtools `coding-console` 增加 `flow/*` 显式过滤桶。
- **E2 wrap-up 轮**：harness 结算的四种结束（done/blocked/budget/no-progress）后追加
  一条**可见**助手消息（机械投影：轮次、工具调用数、成功变更数、结束原因、最近失败），
  journal 记 assistant 三事件。用户主动停止不产生 wrap-up。
- **E3 指示器**：composer 琥珀条增加当前聚焦步 intent。

## 批次 F：配套

- **F1** 压缩摘要工作感知：session 有 flow 活动时，摘要提示词追加交接项
  （任务、变更与证据、剩余工作）。journal 判定，不依赖 runtime 前向引用。
- **F2** `plan_update` 描述改写：allowedTools 是证据引导不是围栏（勘探永远允许）；
  无证据关闭必须带因，且会在 wrap-up 中被点名。
- **F3** `flow_update` 描述改写：done 是一个**会被 harness 验证的声明**；分析型任务
  允许零变更声明 done。
- **F4**（文档定案）心流续跑保持合成 user-role 消息（`hiddenFromHistory` +
  `providerTranscript` 已验证跨迭代携带全部工具上下文），不改 system-role 尾插。
  本文 §批次 B 即定案记录（LOOP-PLAN §12(2) 关闭）。

## 测试与验证（已完成）

- core-agent 228/228（新增 11 个：停滞两向、todo 不触发、预算 2/可调、墙钟、steering、
  L1 驳回反馈、L3 两连驳后转用户、wrap-up、flow-completion 纯函数与评审解析）。
- stage-ui chat/plans/chat-components 130/130；stage-ui、stage-tamagotchi、stage-pages
  typecheck 全过；改动文件 eslint 全绿。
- 已知无关失败：stage-tamagotchi 的 `plugins/index.test.ts` 与
  `static-assets/paths.test.ts` 各 2 例，为既有 Windows 路径分隔符/插件宿主问题，
  与本批无关。

## 真机验收清单（待跑）

1. **12 封邮件批处理**（实测 #2 场景）：勘探轮不杀 flow；首次变更尝试出现在前 3 迭代内；
   `count:0` 型完成声明被 L1/L3 驳回并出现驳回反馈。
2. **dsh_bridge 任务**（seq 679 场景）：iterations > 12；迭代开场 chunk > 0；
   中途插话被 `[User steering]` 消费且 flow 存活；时间线卡实时可见；结束出现 wrap-up 消息。
3. **纯调查任务**（无计划）：允许零变更 done；wrap-up 如实呈现。

## 非目标（明确不做）

AGENTS.md 发现、world-state 差量引擎、bash OS 级沙箱、本地 RPC 通道（P1-2 独立立项）、
子代理、非 flow work 轮的 maxSteps=50 形态、评审模型换用强模型（保持低费通道）。

---

## FLOW-KNOWLEDGE：知识可达性与呈现修复（2026-09-03 第二批，已实施）

> 触发：验收实测（journal `iC70XC6OyBm0UIrPPtRbJ`，40 轮预算用尽）。复盘见会话记录；
> 两条根因是设计性的：(1) student-hub 类「skill + MCP server 复合体」的 agent 契约
> 写在 workspace 文件里（SKILL.md / AGENTS.md / MCP server instructions），而工作面
> 没有任何通道把它送达模型；(2) 一次早期失败回执把计划判死并关闭盖章通道 35 轮。
> 另含用户指出的三项呈现问题（气泡不可见、开场叙述不稳、机械 wrap-up 直接摆给用户）。

### 五条原则与对应改动

**原则一：观察不是判决。** 失败回执不再把步骤/计划打成 `failed`——那是「缺证据」的
blocked 观察材料；`failed` 只来自模型的显式 `plan/update failed` 声明。修掉「一条
`cd /d` 探针 → 计划猝死 → 盖章失聪 35 轮」，同时不需要限制模型的重规划自由。
（`evidence-gate.ts` 投影 + 测试）

**原则二：知识可达性是工作面的职责。** 三处：
- 2a（一行）：work 轮也渲染 `## Toolset` 段（`renderFor` 的 profile 过滤保留，
  Live2D 仍 social-only）——MCP server instructions 从此可达，student-hub 的
  instructions 里恰好写着「写路径走 CLI、遵循 triage-school-items skill」。
- 2b：`workspace-docs.ts`——skill 目录进冻结前缀。来源：workspaceRoot 下的
  `.agents/skills/*/SKILL.md`（只取 frontmatter name+description，≤12 项、4k 字符）
  + 已审自造技能；正文不注入，目录给路径，模型用现有 `read` 工具按需去读
  （Codex 渐进披露的最小实现）。缓存按 root + 10 分钟 TTL。
- 2c：workspaceRoot 的 `AGENTS.md` 有界注入（6k 字符，untrusted 数据声明）——
  「Python API 是内部的、写路径走 CLI」这类守门条款从此可达。

**原则三：解释器即盲区。** `python -m student_hub import-candidates`（真实数据库
写入）曾被判 read-only，变更证据口径失真。凡解释器/脚本调用（python/node/deno/
bun/ruby/perl/php/bash/sh/zsh/`./script`）归 medium；`--version`/`--help` 探针
除外。medium 默认仍免审批——本改动只修正证据账本，安全仍归沙箱（未来）。
（`approval.ts` + 测试）

**原则四（用户项 1+2）：心流的每一步是可见的气泡，且以叙述开场。**
- flow 迭代的助手消息不再 `hiddenFromHistory`，改带 `flowIteration` 标记——时间线
  正常渲染（含流式占位），云同步按标记跳过（触发提示是合成消息、不落盘）。
- 迭代开场（step 0）注入系统级开场指令（上一轮 40 轮里 27 轮有开场叙述、13 轮
  静默起步——提示词问了但没 commanding；现在同指令以 system 权威再发一次）。
  工具间隙的中文提醒保留。

**原则五（用户项 3）：结束的陈述权归模型，事实归 harness。** wrap-up 从机械文本
直出改为一个真实的模型轮：机械记录（原因/轮次/调用数/变更数/最近失败）作为合成
提示（不落盘为用户消息）发给模型，由她以自己的声音写收尾气泡；模型轮失败时回退
机械文本。可选 `flowWrapUp` send 标记复用 flow 车道（短步预算、合成提示不落盘、
回复可见可同步）。（runtime + 回退测试）

### 验证

core-agent 232 / stage-ui 873（145 文件）全过；新增：failed 语义 2 例、解释器分类
1 例、开场叙述 1 例、wrap-up 模型轮与回退 2 例、气泡可见+flowIteration 1 例、
workspace-docs 4 例。core-agent / stage-ui / stage-tamagotchi / stage-pages
typecheck 过；改动区 lint 干净。

### 真机验收增量

在原清单之上：④ 心流期间聊天页每个迭代出现她的叙述气泡（流式可见）；⑤ 结束时
收尾消息是她的话（不是「心流已结束（…）」系统腔；除非模型轮失败回退）；⑥ 对
student-hub 做 `/flow` 时，工作前缀应含 `## Skills`（triage-school-items 等）与
`## Project instructions`（若根内有 AGENTS.md）；她应在前 5 轮内走上 CLI 路径而
不是猜 python API。
