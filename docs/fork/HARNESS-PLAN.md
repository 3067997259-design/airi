# HARNESS-PLAN：回合语义改造（turn / 中断 / 双车道 / 仓库交互 / 工作画像 / btw）

**状态**：**四批全部落地并提交，§9.1 三处缺口一并补齐**（2026-09-01）。
进度只看三处状态表：§3.0（批次一）、§3.5.0（批次一·五）、§4.0（批次二/三/四 + §9.1）。
剩下的是真机验收（§7 的 T1-T11）——代码面已完成，未做的是构建版走查。
**来源**：真机事故复盘（dsh-web 连接器开发任务）+ dsh（`D:\deepseek-harness`，即 MODS.md 中的 dsh / DeepSeek Harness）源码研究
+ 一次接手前的对照勘探（2026-08-31，对照 opencode 类开源 coding harness 的日常循环，产出 §3.5）。
**总纲**：`DESIGN-PRINCIPLES.md` 七条全部适用（原则七于 2026-08-31 修订：判据从"工具数量"改为"循环形状"，
其修订块直接解禁本计划 §3.5）；本计划新增第八条——**工具性通道与关系性通道分离**：
工作轮（缓存命中、证据门、预算）安静化；人格与情感（角色、表情、btw 旁路）迁到关系性通道。
**批次**：一（回合化 + 中断 + 双车道）→ **一·五（仓库交互原语）** → 二（证据门 + todo + bash 后台）
→ 三（工作画像）→ 四（btw）。每批独立可交付、可验收。批次一是其余一切的地基。

**两层缺口的区分（决定批次顺序，2026-08-31 补）**：
本计划原有四个批次修的是**控制层**——「她是不是一个受控的 agent」（能叫停、能插话、
回合有边界、不违抗用户）。它们没有覆盖**能力层**——「她能不能在一个仓库里干活」
（检索、分页阅读、范围编辑、跨平台 shell）。两层都齐才等于一个标准 coding agent。
能力层的缺口比控制层更硬：**批次二三四优化的是一个还没法在真实仓库里可靠定位和改文件的循环。**
故新增批次一·五，插在批次一与二之间；理由与清单见 §3.5。

---

## 0. 事故诊断（为什么做）

### 0.1 真机事故症状

让 ReLU 自主开发 dsh-web 连接器并执行时观察到五个症状：

| # | 症状 | 用户感受 |
|---|---|---|
| S1 | 回合无法打断，唯一的停止手段是删除会话 | 「根本打不断」 |
| S2 | 用户发「先别做了」后她反而继续疯狂执行 | 「不做不罢休、越劝越来劲」 |
| S3 | 计划卡卡在步骤 1-3；她声称已全部落盘但门不认 | 「完成了却不认账」 |
| S4 | 已完成/进行中的计划重启后整体消失 | 「重启蒸发」 |
| S5 | 「拉起 dsh web」的 bash 转圈 120 秒，期间可打字但无法真正交互 | 「转圈」 |

### 0.2 根因（全部已对到代码，行号为 2026-08-31 基线）

**R1 无中断原语（S1）**
发送是严格串行队列（`packages/core-agent/src/runtime/chat-orchestrator-runtime.ts:1513-1564`），
运行中的回合不完成，后续 send 永远排队。全链路**没有任何代码把 `abortSignal` 传进 LLM 流**
（编排器调用点 `chat-orchestrator-runtime.ts:1270-1374` 未传；而 `StreamOptions.abortSignal`
管道在 `packages/core-agent/src/runtime/llm-service.ts:197` 已存在，只差接线）。
`cancelPendingSends`（`chat-orchestrator-runtime.ts:1566`）只能杀**未开始**的排队项；
`deleteSession` 是全系统唯一停止句柄，且 generation 检查（`shouldAbort`）只挡 UI 效果与
journal 写入，**传输层与工具执行照跑**。删对话不是「停下她」，是「不再看她」。

**R2 续跑调度无视用户意志（S2）**
`packages/stage-ui/src/stores/chat.ts:543-583`：每个回合结束时 `schedulePlanContinuation`
只检查「是否存在可执行的计划步骤」，不看这轮是谁发起、用户说了什么。证据门没判完成（R3）
→ 步骤永远 runnable → 自动发出以用户名义的指令 *"…execute it now … do not stop until it
completes or blocks"*。更糟：用户中途插话是用户消息 → `send()` 里 `planContinuations.delete()`
**重置续跑预算** → 打断反而补满弹药。叠加串行队列，排队消息逐条各开一轮工具循环。
**harness 在结构上替她违抗用户。**

**R3 证据门饥饿（S3、S2 的燃料、S4 的部分成因）**
`chat-orchestrator-runtime.ts:568-573` `planLinkFor`：工具结果**只有**落在「当前焦点步骤」的
`allowedTools` 白名单里才被打 planId/stepId 戳；验证门只消费带戳 tool/result。批处理型
（flash 级）模型「咣咣咣」跨步骤干活时，焦点还在步骤 1，步骤 2/3 的证据全部**永久**无戳丢失
→ 步骤永远 pending → 计划永不 completed → `activePlans`（`packages/stage-ui/src/stores/plans.ts:192`，
只过滤 completed/failed）永远包含它 → 卡片不消失、续跑永远有理由。门本身工作正常，
**但门的输入被「要求模型自律推进焦点」的工作流假设饿死了**——恰与第一原则「结构优先于自律」矛盾。

**R4 持久化静默失败（S4）**
计划真身持久化在 OPFS DuckDB。启动水合确实被调用（`apps/stage-tamagotchi/src/renderer/main.ts:67`）
但失败仅 `console.warn`（`main.ts:69-71`），plans 数组留空、界面无提示。会话内保存失败同样仅
warn（`chat.ts:239-252`）。整条链（水合→保存→恢复）共享 OPFS 单写者这一脆弱失败域
（MODS.md 记录过的 `createSyncAccessHandle` 句柄冲突：残留实例/HMR 僵尸 worker），**每一环都
warn-and-continue**，「蒸发」是该设计的预期输出。journal 本身是内存态，重启后
`stateFromJournal` 无事件可回放，全靠快照；快照没存上就什么都没了。

**R5 前台长驻命令无后台原语（S5）**
「拉起 dsh web」= bash 前台起服务器，进程永不退出。coding-host bash 有 120s 超时
（`packages/coding-harness/src/tools/workspace-host.ts:122`），每个这样的回合挂满 2 分钟；
「转圈的空圈圈」即在飞 bash；输入不被串行队列阻塞（消息进队列）所以可打字但无法交互。

**附带发现（非事故直接成因，本计划一并处理）**

- 工作叙述可见性由 TTS 语音过滤器裁决：`chat-orchestrator-runtime.ts:1080-1130`，
  气泡内容只累积 `categorizer.filterToSpeech(...)` 的输出——「边干边说」这一常识被舞台过滤器塑形。
- KV 缓存杀手在**回合之间**：`appendSystemSupplement`（`chat-orchestrator-runtime.ts:842-853`）
  每次改写系统消息本体，supplement 内含计划投影（每落证据即变）等易变节 → 前缀全灭。
  回合内（一次 send 的 10 步循环）messages 组装一次、只追加尾部，本来就缓存友好。
- `runnablePlanStep()`（`chat.ts:553`）用全局 `activePlan`，跨会话泄漏。
- 工具循环上限硬编码 `stopWhen: stepCountAtLeast(10)`（`llm-service.ts:201`），跑完静默蒸发，
  无模型可见的「预算将尽」信号。

### 0.3 第二类根因：能力层（2026-08-31 接手前勘探补）

§0.2 的 R1-R5 全是**控制层**根因——它们解释「为什么打不断、为什么违抗、为什么卡死」。
另有一类根因不来自这次事故，而来自与 opencode 类 harness 的日常循环对照：
**她的 grep→read→edit 循环第一步就断，编辑原语只够改单行，`write` 无任何校验。**

事故里没暴露它，是因为那次任务卡在更前面（打不断、证据门饿死）就结束了。
但控制层修好之后，她会立刻撞上这一层：C1-C7 七项，诊断与修法见 §3.5。
其中 **C3+C4（`edit` 只能整行 + `write` 零校验）是结构缺陷而非能力缺口**——
Hashline 保护了模型会绕开的那条路，模型必走的那条路没有门（§3.5.2）。

---

## 1. 设计参照：dsh 的「常识机械」

dsh 仓库：`D:\deepseek-harness`。结论：**用户感知为常识的行为，全部是 harness 的显式机械**。

| 常识 | dsh 机械 | 源码位置 |
|---|---|---|
| 回合有始有终有原因 | turn/step 两级边界；`TurnEndReason = completed \| aborted \| blocked \| error \| max-tokens \| interrupted` 落盘 | `packages/core/agent-loop/src/agent.ts`、`packages/core/session/src/types.ts:155-177` |
| 被叫停就停 | 每活动一个 `AbortController`，`signal.throwIfAborted()` 穿透每个 await（每个 chunk、每次组装、每个工具调用）；`cancel(cause, {keepInbox})` 一等操作 | 同上 `agent.ts` |
| 中断后日志仍自洽 | 中止时对未启动的工具调用补写合成错误结果（"replay stays valid"）；崩溃孤儿回合重载时补 `interrupted` 关闭原因 | `packages/core/agent-loop/src/tool-calls.ts:237-259` |
| 插话能被听见（不打断工作） | Inbox 双车道：`next-step`（steer，下一个 step 边界作为 user message 进入上下文）/ `next-turn`（排队新回合）；收件箱 splice 本身是持久会话事件 `agent/inbox/spliced`；队列项可 replace/remove | `packages/core/agent/src/inbox.ts` |
| UI 有插话/排队两种手势 | composer 的 Steer / Queue 双按钮 + QueueDock 队列管理 | `apps/web/tests/steering.e2e.ts` |
| 循环不饿死 | 循环无步数硬上限：模型不再调工具 turn 才算 `completed`；每步工具调用用有界并行池（默认 10 in-flight）+ 独占屏障 | `agent.ts`（`stopWhen` 无）、`tool-calls.ts`、`agent-loop/src/constants.ts` |
| 边干活边说话 | 全部 `assistant/chunk` 逐块落盘并渲染；工具结果 `meta` 携带 UI 载荷（如 diff）供回放重绘卡片 | `agent.ts`、`tool-calls.ts:261-289` |
| 任务清单反映进度 | `todo_write`：模型**自有**整表快照、last-write-wins、UI 从事件流渲染、turn/start 自动清空。**无验证门**——它是通信设备，不是裁决机构 | `packages/todo/tool-todo/src/index.ts` |
| 长命令不挂死 | bash `run_in_background: true` → 立即返回 job id；`job_output` 读输出、`job_kill` 停止；工具描述里教模型使用 | `packages/shell/tool-bash/src/index.ts` |
| 压缩不占工作回合 | compaction 跑在 turn 之间的 `maintenance` 相位，自带 AbortController，wake 闩到空闲重放 | `agent.ts`（`runMaintenance`） |

**关键启示**：dsh 把「任务清单」（模型自有、纯沟通）和「完成裁决」（若有）分成两个器件；
AIRI 把沟通职责压给了证据门，门就被沟通失败（R3）拖死。本计划采纳同样的职责分离。

**与 AIRI 的结构性差距一句话**：dsh 的原语是「turn/step + 可中断 + 可转向 + 全量持久事件日志」；
AIRI 的原语是「消息串行队列」。所有缺失的常识都是这一差距的下游产物。

---

## 2. 与 AIRI 地基的对接点（先确认能站上去）

- journal（`packages/core-agent/src/journal/`）= 持久事件日志雏形；`model-visible means logged`
  原则（M-D 修订块）与 dsh 的 session log 同形状。新增事件类型在
  `packages/core-agent/src/journal/types.ts` 的 `JOURNAL_EVENT_TYPES` 扩展。
- `prepareStep` / `postToolCall` 钩子已从 `streamWithStageAdapters`（`chat.ts:434-523`）穿透到
  streamText——steer 边界检查的现成挂点。
- `StreamOptions.abortSignal` 管道已存在（`llm-service.ts:197`）——只差编排器接线。
- per-send 工具裁剪先例：`executeSend` 的 tools 选择器（`chat.ts:986-993`，self-initiative
  只挂 self_speak/self_note）——工作轮/btw 轮的工具面裁剪照此形状扩展。
- `user_ask` + `runtime-user-ask` 同步 store（COMMAND-PLAN Phase B）：跨窗口问题卡 +
  答案路由回 leader——btw 是它的反向通道，路由骨架可镜像复用（实现时搜 `runtime-user-ask`）。
- turn projection（`packages/core-agent/src/planning/turn-projection.ts`）——计划状态每轮注入
  的现有通道，todo 投影可并行。

---

## 3. 批次一：回合化 + 中断 + 双车道（P0 地基）

**目标**：回合成为一等对象；用户获得真正的停止权与插话权；续跑不再违抗用户。
顺带解掉 10 步硬上限。

### 3.0 实施状态（2026-09-01：**六项全部落地并提交**）

| 项 | 状态 | 落点 |
|---|---|---|
| 步数预算参数化 | ✅ | `StreamOptions.maxSteps` →`llm-service.ts` 的 `stepCountAtLeast(maxSteps)`；`chat.ts` 计划轮 50 / 普通轮 10；倒数第二步经 `prepareStep` 注入收束提示，命中记 `turn/end {reason:'max-steps'}` |
| per-turn AbortController 全链穿透 | ✅ | 每次 `performSend` 建 controller 并传入 `deps.llm.stream`；新增 `abortActiveSend(sessionId?)`；中止时给未结算的 tool call 补写合成失败结果，日志仍可回放 |
| journal 回合事件 | ✅ | `turn/start` + `turn/end {reason: completed \| aborted \| steered \| max-steps \| error}` |
| 串行队列升级双车道 | ✅ | `ChatSendDelivery = 'next-step' \| 'next-turn'`；steer 在 `prepareStep` 边界优雅中止；`cancelQueuedSend(id)` 逐条撤销 |
| UI 停止按钮 | ✅ | `InteractiveArea.vue`：`sending` 时发送键变停止键、Esc 同效、队列坞可撤销；Enter = 插话，Shift+Enter = 排队 |
| 续跑调度重写（R2 根修） | ✅ | 续跑只在带 `planId` 的回合后调度；预算从「每用户消息」改为**每计划**；`runnablePlanStep` 走 `scopedActivePlans(sessionId)`；停止意图或停止键把计划置 `paused`，paused 计划零调度 |

同期附带落地：life-mode 日预算改为「tick 被消费时才计费」（`lifeModeConsumeTick`），
不再发出即扣费而回合根本没跑。

### 3.1 改动清单

1. **步数预算参数化**
   - `StreamOptions` 增加 `maxSteps`；`llm-service.ts:201` 的 `stepCountAtLeast(10)` 改读该参数
     （缺省 10，保持聊天行为不变）。
   - 编排器按回合类型给值：普通聊天 10；计划驱动/work 轮 40-60。
   - 命中预算时在倒数第二步经 `prepareStep` 注入「预算将尽，请收束」的系统可见提示，
     并以 `turn/end {reason:'max-steps'}` 落盘——不再静默蒸发。

2. **per-turn AbortController 全链穿透**
   - `performSend` 为每回合创建 `AbortController`，作为 `abortSignal` 传入
     `deps.llm.stream(...)`（`chat-orchestrator-runtime.ts:1270` 处）。
   - runtime 新增 API `abortActiveSend(sessionId?)`：abort 当前回合的 controller。
   - 中止语义对齐 dsh：流立即中断；已开始的工具调用照常结算、未开始的在 journal 补合成
     `tool/result {ok:false, 中止}` 记录（保证日志可回放）；回合以
     `turn/end {reason:'aborted'|'steered'}` 落盘。

3. **journal 新增回合事件**
   - `turn/start`、`turn/end {reason: 'completed'|'aborted'|'steered'|'max-steps'|'error'}`。
   - 「她为什么停了」从此可查（devtools journal 事件流已具备展示能力）。

4. **串行队列升级双车道**
   - 现有 `sendQueue`（`chat-orchestrator-runtime.ts:1513`）保留为 `next-turn` 车道；
     新增 `next-step` 车道（steer）。
   - **steer 语义**：`sending` 期间收到用户消息 → 进 steer 车道；当前回合在下一个工具轮边界
     （`prepareStep` 钩子内检查）优雅中止（`turn/end {reason:'steered'}`），
     steer 消息立即作为新回合执行。用户在工具执行间隙就能被听见。
   - **queue 语义**：显式手势（输入区排队按钮 / Shift+Enter）→ `next-turn` 车道照旧排队；
     队列可查看、可撤销（复用 `cancelPendingSends` 的按条版本）。
   - 默认手势：Enter = steer（插话），Shift+Enter = queue。与 Claude Code 直觉一致。

5. **UI：停止按钮**
   - `apps/stage-tamagotchi/src/renderer/components/InteractiveArea.vue`：`sending` 时发送按钮
     变停止按钮（调 `abortActiveSend`），Esc 同效。steer/queue 双手势进输入区提示。

6. **续跑调度重写（R2 根修）**
   - 删除全局 `onChatTurnComplete → schedulePlanContinuation` 钩子。
   - 续跑只从**计划驱动回合**链式发出：`options.planId` 存在的回合结束时才调度下一棒。
   - `runnablePlanStep()`（`chat.ts:553`）从全局 `activePlan` 改为
     `scopedActivePlans(activeSessionId)`，消除跨会话泄漏。
   - 续跑预算从「每用户消息」（`MAX_PLAN_CONTINUATIONS_PER_SEND = 2`，`chat.ts:548`）改为
     「每计划」，并在计划记录上落 `paused` 态：用户打断（steer 内容匹配停止意图或按停止键）
     置 paused，只有用户显式「继续」才恢复。paused 计划不参与续跑、不参与自主 tick。

### 3.2 测试

- core-agent：abort 中止流 + 工具结算 + journal 记录；steer 边界触发；max-steps 提示与 reason。
- stage-ui chat：续跑只在计划驱动回合后调度；用户消息不再重置预算；paused 计划零调度。
- 真机：T2、T3（见 §7）。

---

## 3.5 批次一·五：仓库交互原语（P0 能力层，插在批次二之前）

**目标**：让 grep→read→edit 这条日常循环在真实仓库里成立。
本批全部是纯函数为主的小改动、可单测，但它们决定她的成功率上限。

**为什么插在这里**：批次一给的是「她不再失控」，本批给的是「她能干活」。
证据门（批次二）、缓存画像（批次三）优化的都是这条循环的**外围**；
循环本身第一步（定位）目前是断的。先修循环，再优化围绕它的机械。

**判据来源**：`DESIGN-PRINCIPLES.md` 原则七的 2026-08-31 修订块——
工具面按「是否改变工作循环的形状」扩张。本批新增的每一项都改变形状；
被同一修订明确排除的（第 N 个同形状只读工具）不在本批。

### 3.5.0 实施状态（2026-09-01：**七项全部落地并提交**）

**下面 §3.5.1 的诊断表保留原始现状描述**（它记录的是为什么要做，不是当前状态），
实施进度只看本节：

| # | 项 | 状态 | 落点 |
|---|---|---|---|
| C1 | 检索原语 `grep` | ✅ 已落地 | `tools/grep.ts`（纯：`--json` 解析、边界钳制、投影渲染）+ `tools/grep-search.ts`（ripgrep 进程 + Node 兜底走查）+ `workspace-host.grep`；签名按**文件总行数**算，与 `read` 投影逐字节一致（已断言）；工具面里 `grep` 排在 `read` 前 |
| C2 | `read` 分页 | ✅ 已落地 | `hashline/read.ts`：`{ offset, limit }` + `DEFAULT_READ_LINE_LIMIT = 400`；签名仍按总行数算（`lineSignature(content, { lineCount })`，`lineCount` 取自切片前的 `lines.length`） |
| C3 | `edit` 范围化 + `insertAfter` | ✅ 已落地 | `hashline/edit.ts`：`endSignature?` + `operation: replace \| insertAfter` + `afterSignature`；`coding-tool-meta.ts` 描述同步 |
| C4 | `write` 陈旧校验 | ✅ 已落地 | `workspace-host.ts`：`writeFileIfUnchanged(path, content, baseHash)` → `written \| state_changed{currentHash}`；`baseHash: null` 表示"预期不存在"；哈希由 `hashline/text.ts` 的 `contentHash`（FNV-1a → 8 位十六进制）产出 |
| C5 | shell 显式化 | ✅ 已落地 | `tools/shell.ts`（纯选择器）+ `tools/shell-probe.ts`（`git --exec-path` → 程序目录 → PATH → PowerShell）；`execFile` 显式传 shell（Git-Bash 用 `-lc` + `CHERE_INVOKING=1`，否则登录 profile 会把 cwd 换成 `$HOME`）；`bashDescriptionFor(shell)` 动态描述、结果头部带 shell；`classifyBashCommand` 补 PowerShell cmdlet 与别名 |
| C6 | CRLF 保真 | ✅ 已落地 | 新增 `hashline/text.ts`：`parseTextFile`（按 `/\r?\n/` 切行、探测主导行尾、报 `mixedLineEndings`）+ `joinTextFile` |
| C7 | 工作区根目录可切换 | ✅ 已落地 | `codingHostSetWorkspaceRoot` + `codingWorkspaceRootChanged`；主进程校验（存在 / 是目录 / 可写）后**一起重建** host + tools + codeRuntime；切换持久化到 `<userData>/coding-host.json` 并压过 `AIRI_WORKSPACE_ROOT`；切根写 journal `context/inject`；设置页「Coding」可切根并显示当前 shell |

**实施顺序与实测补记（2026-09-01）**：按建议顺序 C5 → C1 → C7 执行。
`@vscode/ripgrep@^1.18.0` 已装并登记进 catalog；本机实测该版本以平台子包
（`@vscode/ripgrep-win32-x64`）直接分发 `rg.exe`（`ripgrep 15.0.0`），
没有走 postinstall 下载，故 `MODS.md` 记的「只认小写 `https_proxy`」这一坑
本次未触发——但结论不变，换平台或换版本时仍按那条处理。
Node 兜底走查保留，且**降级在结果文本里明说**（M2 教训）。

### 3.5.1 诊断（全部已对到代码，行号为 2026-08-31 基线）

| # | 缺口 | 现状 | 后果 |
|---|---|---|---|
| C1 | **无检索原语** | grep / glob / rg 在 `packages/coding-harness/` 与工具注册面**零匹配**；只有 `list`（`workspace-host.ts:78` 单层 `readdir`） | 定位代码只能靠 bash 或递归 list。coding agent 的核心循环 grep→read→edit **第一步就断** |
| C2 | **`read` 无分页** | `buildSignedFileProjection`（`hashline/read.ts:29`）返回**整个文件**每一行 + 每行一个签名，无 offset/limit | 3000 行文件 = 3000 行 `行号 签名 内容`，另加每行签名的 token 开销。flash 级模型读三个文件即满窗 |
| C3 | **`edit` 只能整行替换** | `applyHashlineEdit`（`hashline/edit.ts:90`）`next[lineNumber-1] = newLineContent`；无插入、无删除、无范围 | 改一个 5 行函数要 5 次调用各带签名；**插入新函数做不到** → 真实重构只能走 `write` |
| C4 | **`write` 无陈旧校验** | `executeWrite`（`builtin/coding.ts:47`）直接落盘，不过 Hashline，不校验 mtime/哈希 | 与 C3 合起来是本批最尖锐的一处，见下 |
| C5 | **win32 上 bash 是 cmd.exe** | `execFile(command, { shell: true })`（`workspace-host.ts:113-122`）→ win32 解析 ComSpec；`CODING_TOOL_META.bash` 的描述对此**一字未提** | 模型习惯性发 `grep -rn` / `ls` / `cat` 全部「不是内部或外部命令」。开发机就是 Windows |
| C6 | **CRLF 签名往返破坏行尾** | `read` 用 `split('\n')`、`edit` 回写 `join('\n')`（`builtin/coding.ts:36,75`）。行尾 `\r` 进签名，模型给的 `newLineContent` 不带 `\r` | 改一行后**该行变 LF、其余仍 CRLF**（行尾混合）。本仓库工作树即 CRLF（git 持续报 `LF will be replaced by CRLF`）→ **让她改 AIRI 自己的代码就会踩到** |
| C7 | **工作区根目录写死** | `DEFAULT_WORKSPACE_ROOT = ~/AIRI-workspace`（`coding-host/index.ts:39`），启动时读 `AIRI_WORKSPACE_ROOT`；`shared/eventa` 里**没有 setter**（只有 `listTools` 返回的只读 `workspaceRoot`） | coding agent 是被「指向一个仓库」的；她现在只有一个固定沙盒 |

**C6 实测证据**（2026-08-31，Node 直算签名，非推断）：
文件 `"const a = 1\r\nconst b = 2\r\n"` → `split('\n')` 得 `["const a = 1\r", "const b = 2\r", ""]`；
首行签名带 CR 为 `m4`、去 CR 为 `fh`（两者不同，所以模型必须回传带 `\r` 的内容才能匹配，
但它看到的投影里 `\r` 不可见）；替换首行后 `join('\n')` 产出
`"const a = 42\nconst b = 2\r\n"` —— 行尾已混合。

### 3.5.2 C3 + C4 是同一个结构缺陷（本批最高优先）

**Hashline 保护的是模型会绕开的那条路，模型必走的那条路没有保护。**

`edit` 门槛高：每行一次调用、要签名要前缀、插入与删除干不了。
`write` 门槛零：一次调用整文件落盘，无任何校验。
理性的模型会一路 `write` —— 于是内容签名这套机械**在最常见的场景里完全不生效**，
而 `write` 连「你读它是 20 步之前的事了」都不检查：她可以覆盖掉自己没看见的改动。

按 `DESIGN-PRINCIPLES.md` 原则一（让错误在结构上无法表达），这不是能力缺口，是**门的位置错了**。
修法是让两条路的门槛匹配，而不是劝模型多用 `edit`（那正是被原则一判为错的自律式解法）：

1. **`edit` 升级为范围操作**：`{ path, startSignature, endSignature?, expectedPrefix, newContent }`——
   `endSignature` 缺省即单行（保持现有行为与现有测试）；给出则替换 `[start, end]` 闭区间；
   `newContent` 允许多行（含空串 = 删除该范围）。**插入**用 `insertAfter` 语义单独表达
   （`{ path, afterSignature, newContent }`），不要把插入编码成"替换成两行"——
   那会让模型必须复述它不打算改的那一行，正是 Hashline 要消除的东西。
2. **`write` 加陈旧校验**：新增必填 `baseHash`（她 `read` 时随投影头部返回的全文哈希；
   复用 `fnv1a32` 即可，威胁模型是疏漏不是伪造，见 `CODING-HARNESS-DESIGN.md` §8.3）。
   不匹配 → 返回 `state_changed` + 当前哈希，语义与 Hashline 拒绝**完全一致**：
   「状态已变，请重读」，不是任务失败。新建文件传 `baseHash: null` 显式声明"我预期它不存在"，
   而文件已存在时该声明本身就是失配 → 拒绝，顺带堵掉"以为在建新文件其实覆盖了旧文件"。

两项合起来，`write` 与 `edit` 的门槛对齐，签名机械开始在真实路径上生效。

### 3.5.3 改动清单

1. **检索原语（C1）**——新增 `grep` 工具，落在 coding-host（主进程持有工作区）：
   - 参数 `{ pattern, path?, glob?, maxMatches?, contextLines? }`；返回 `文件:行号: 内容` 扁平列表，
     **带每行签名**（与 `read` 投影同形状，命中行可直接喂 `edit`，省掉一次 read）。
     签名宽度按**该文件总行数**算，与 `read` 一致（否则命中行签名喂不进 `edit`，见 §8 第 8 条）。
   - **不要**用 `bash grep` 实现——那会把 C5 的平台问题继承进来，且 grep 输出要过审批分级。
   - 结果有界：默认 50 命中 / 每行截断至 200 字符，超出报总数与"请收窄 pattern"。
   - **检索后端已定（2026-08-31 用户拍板）：引入 `@vscode/ripgrep`，自带平台二进制。**
     判据是「任何用户机器上行为一致」——只探测系统 `rg` 会让行为随机器变
     （本机实测 `rg` 不在 PATH，即一直走慢回落），而"行为随环境不确定"正是原则一要消除的；
     纯 Node 遍历在 AIRI 这种体量的仓库上慢到影响循环。
     具体要求：
     - 二进制路径从包导出的 `rgPath` 取，**不要硬编码路径**；开发态与 asar 打包态的路径不同。
     - 打包：`electron-builder.config.ts` 的 `asarUnpack` 需覆盖该二进制
       （现有条目只有 `**/*.node`），否则打包后进程内拿到的是 asar 内路径、`spawn` 直接 ENOENT。
       主进程 bundling 另按 §8 第 2 条双配置处理（`externalizeDeps.exclude` + `resolve.alias`，整包名）。
     - postinstall 下载走代理时注意本仓已记载的坑：**只认小写 `https_proxy`**（`MODS.md` 构建配方节）。
     - 仍保留一条 Node 遍历兜底路径，只在二进制缺失/spawn 失败时启用，并在结果里明说已降级
       ——降级必须可见（M2 的教训：静默降级会让模型继续表演能力）。
2. **`read` 分页（C2）**——`buildSignedFileProjection` 增加 `{ offset?, limit? }`
   （缺省 limit 建议 400 行，与现有 `DEFAULT_MAX_LINE_CONTENT_LENGTH` 并列声明）：
   - 投影头部补 `总行数 / 本次范围 / 是否还有后续`，让模型知道自己只看了一段
     （不知道就会把片段当全文推理，这是分页最大的风险）。
   - **签名宽度必须仍按文件总行数计算**，不是按本页行数——否则同一行在不同分页里签名不同，
     `edit` 立刻失配。这是本项唯一容易写错的地方，测试要专门覆盖。
3. **`edit` 范围化 + `insertAfter`（C3）**——见 §3.5.2 第 1 条。
   `applyHashlineEdit` 的四种机械裁决（`state_changed` / `ambiguous` / `prefix_mismatch` / `applied`）
   语义不变，`ambiguous` 对 start/end 各自独立判定。
4. **`write` 陈旧校验（C4）**——见 §3.5.2 第 2 条。
5. **shell 显式化（C5）**——**方案已定（2026-08-31 用户拍板）：探测 Git-Bash →
   缺失回落 PowerShell → 无论走哪条都在工具描述里动态声明当前 shell。**

   选 Git-Bash 作首选的判据是**安全面**而非便利：`classifyBashCommand`
   （`authority/approval.ts:43-68`）的分级正则全是 POSIX 形态，Git-Bash 让它继续有效；
   换 PowerShell 等于要重写整张分级表，而漏一条就是高危命令降级为 read-only 直接执行、
   不弹审批卡（§8 第 7 条）。用"补正则"这个安全任务换"模型少试错"不划算。

   实现要点：
   - **探测**：按序找 `git --exec-path` 推出的 `usr/bin/bash.exe`、
     `%ProgramFiles%\Git\bin\bash.exe`、PATH 上的 `bash`。
     本机实测两者都在（`C:\Program Files\Git\usr\bin` 下有 `grep.exe`，
     PowerShell 在 `System32\WindowsPowerShell\v1.0`），但**不能假设用户机器有 Git**。
     探测结果缓存在 host 上，不要每条命令重探。
   - **`runCommand` 改造**：`execFile` 当前传 `{ shell: true }`，win32 上解析 `ComSpec`
     （本机实测 = `cmd.exe`）。改为显式传选定的 shell 可执行文件 + 其命令参数
     （bash 用 `-lc`、PowerShell 用 `-NoProfile -Command`），不再依赖 `shell: true` 的平台默认。
   - **声明当前 shell**：`CODING_TOOL_META.bash.description` 需要能带运行时事实
     （当前是纯静态常量）。做成 `bashDescriptionFor(shell)` 之类的纯函数，
     由 coding-host 在 `listTools` / 工具注册时注入，**保持 meta 模块无副作用**
     （该模块的现有约束：浏览器包要能只引元数据、不拉 Node 宿主）。
   - **回落到 PowerShell 那条路仍须补分级正则**：`Remove-Item`/`ri`/`rd` 对应 `rm`、
     `Invoke-WebRequest`/`iwr`/`curl` 别名对应网络出口、`Stop-Service`/`Restart-Service`
     对应 `systemctl`、`Set-Content`/`Out-File`/`>>` 对应写入。
     逐条加测试样本，不要批量正则改写（§8 第 7 条）。
     PowerShell 的**别名**是这里最容易漏的一类（`ri`/`iwr`/`sc`）。
   - 两条路都要在 journal / 工具结果里可辨认当前 shell，否则真机排查时无法判断她在哪种 shell 下失败。
6. **CRLF 保真（C6）**——在 coding-host 的读写边界统一：
   - `read` 侧按 `/\r?\n/` 切行，**签名只对不含行尾符的内容计算**；
     同时探测文件主导行尾（首个 `\r\n` 或 `\n`）并随投影返回。
   - 写回侧用探测到的行尾 `join`，保持文件原有风格；混合行尾文件按主导风格归一并在结果里说明。
   - 回归测试必须包含 CRLF 与混合行尾 fixture，断言"改一行后其余行行尾不变"。
7. **工作区根目录可切换（C7）**——新增 `codingHostSetWorkspaceRoot` eventa 契约 + 设置页入口：
   - 主进程校验目标存在且可写，重建 `host` 与 `codeRuntime`（两者都闭包持有 `canonicalRoot`，
     必须一起重建，否则 Code Mode 仍在旧根跑）。
   - 切根是**会话级事实**：切换后向 journal 记一条 `context/inject`（或按 §4.2 的 todo 通道形态）
     让她知道地面换了；不要静默切换。
   - 与 `AIRI_WORKSPACE_ROOT` 的优先级要写明：启动环境变量 = 初值，运行时 setter 覆盖它并持久化
     （沿 `life-mode.json` 的 `<userData>` 模式）。

### 3.5.4 测试

已落地部分（C2/C3/C4/C6）的测试面：`hashline/read.test.ts`、`hashline/edit.test.ts`、
`hashline/text.test.ts`、`tools/coding-tools.test.ts`——覆盖分页（含"签名按总行数计算"的
跨页一致性）、范围 edit、insertAfter、`write` 陈旧校验三态（匹配 / 失配 / 新建声明失配）、
CRLF 与混合行尾往返保真。

剩余三项要补的：

- **C1 grep**：结果有界（命中数上限、行截断）、路径包含性（`resolveInsideWorkspace` 不可绕出根）、
  命中行签名与同文件 `read` 投影**逐字节一致**（否则喂不进 `edit`——这是最容易漏的断言）、
  二进制缺失时降级路径可见。
- **C5 shell**：探测顺序（Git-Bash → PowerShell）的纯函数化选择器 + 缺失场景；
  PowerShell 分级正则的新增高危样本，**别名必须单独列样本**（`ri` / `iwr` / `sc`）。
- **C7 切根**：目标不存在 / 不可写时拒绝；切根后 `host` 与 `codeRuntime` 都指向新根
  （断言 Code Mode 也换了根，这是最容易漏的一半）。
- 真机：T8、T9、T10、T11（见 §7）。

---

## 4.0 批次二 / 三 / 四 与 §9.1 的实施状态（2026-09-01：全部落地并提交）

| 批次 | 项 | 状态 | 落点 |
|---|---|---|---|
| 二 | 证据门去焦点化（R3 根修） | ✅ | `getActivePlanStep` → `getPlanStepCandidates`（返回全部未完成步骤，焦点仅作优先级）；`planLinkFor` 先焦点后计划序匹配；焦点由 `stateFromJournal` **派生推进**（步骤解决后自动指向下一未决步骤），不再需要模型手动 focus |
| 二 | 错配反馈 | ✅ | 新增 journal 事件 `plan/hint`（工具名 + 当前开放步骤可用工具集），`buildTurnProjection` 渲染「Unattached tool results」段回喂模型 |
| 二 | todo 通道 | ✅ | journal `todo/write` + `todo_write` 工具 + `stores/todos.ts`（**派生态**：取最近 `turn/start` 之后的最后一次写入，故新回合天然空）+ 聊天区卡片；不参与验证门、也不被门阻塞；写入有界（20 条 / 每条 200 字） |
| 二 | 持久化可见化（R4） | ✅ | `plans.persistence`（ready / unavailable / failed + 原因）+ 开库退避重试（200ms、600ms 共 3 次）+ 保存失败上浮 + 计划泳道琥珀色芯片与重试按钮 |
| 二 | bash 后台原语（R5） | ✅ | `tools/jobs.ts`（作业注册表：环形输出缓冲 20k 字、`taskkill /T` 杀进程树、切根即清）+ `bash runInBackground` + `job_output` / `job_kill` 工具；审批门在 spawn 之前 |
| 三 | 工作画像 | ✅ | `ChatOrchestratorSendOptions.profile`（计划轮默认 `work`）：系统前缀不注入 Stage Control / 注意力节；计划投影改走**尾部** `[Plan]` 块（新增 `getTailProjection` dep）；工具面裁到工作集；叙述跳过 `filterToSpeech`；artistry 副作用退场 |
| 三 | 缓存可观测 | ✅ | 每次 supplement 变化记 journal `prompt/supplement-changed{hash, previousHash}`（同一 supplement 不重复记），T5 验收依赖它 |
| 四 | btw 旁路 | ✅ | `stores/btw.ts`：独立 `streamFrom` + 独立 AbortController，**不写主会话、不进队列、不触发回合钩子、不挂任何工具**；上下文 = 有界工作投影（计划步骤 + todo + 最近 6 条工具摘要）+ 角色卡人格；聊天区侧线卡片 |
| §9.1 | diff 面 | ✅ | `hashline/diff.ts` `summarizeLineDiff`（公共前后缀 + 有界列举）；`write` 先读后写以产出 diff，`edit` 直接对比；Code Mode 结果同带 |
| §9.1 | journal 落盘 + 回放 | ✅ | 主进程 `journal-host`（`<userData>/journal/<hash>.jsonl` 追加写 + 有界读回）+ 渲染端 `installJournalPersistence` 端口（**微任务批量**镜像，失败不影响内存流）+ `journal.hydrate()`，leader 启动时**先回放再水合计划** |
| §9.1 | 委派原语 | ✅ | `stores/delegation.ts` + `task` 工具：子运行有独立消息列表、只读工具（grep/read/list）、12 步预算；报告显式标注「是主张不是证据」，不能满足计划步骤 |

**真机验收（2026-09-01）**：T1-T11 已走查——T1/T2/T3/T5-T11 通过，T4 阻塞于
「btw 无首问入口」；另移交两个缺陷（journal 回放的启动时序、write 行尾未按
主导 EOL 归一）。完整记录见 `MODS.md`「真机验收（2026-09-01）」小节。

---

## 4. 批次二：证据门去焦点化 + todo 通道 + bash 后台

**目标**：门从「要求自律」回到「结构使然」；沟通与验证解耦；长命令不再挂死。

### 4.1 证据门去焦点化（R3 根修）

1. **打戳放宽**：`planLinkFor` 从「当前焦点步骤白名单」改为「**任何** `allowedTools` 匹配该
   工具名的未完成步骤」——证据按步骤独立累积，焦点只决定投影建议先干哪步。
   `getActivePlanStep` dep 的返回形状相应调整（返回候选步骤列表或新增
   `planLinksFor(toolName, options)` 回调）。
2. **门驱动自动推进**：`plans.ts` 的 `recordToolResult` 后评估焦点步骤验证门，满足即
   `completeStep` 并自动 `focusStep` 下一可执行步骤（循环推进 + 防重入守卫）。
   `plan_update focus` 保留为模型手动覆盖。
3. **错配反馈**：无戳的工具结果记 `plan/hint` journal 事件（工具名 + 当前焦点步骤白名单），
   turn projection 里向模型反馈「你用了 bash，但当前步骤只允许 read——先 focus 或完成当前步」。
   给她改行为的结构化信号，而非放任证据丢失。
4. **卡片消解**：R3 修复后计划可真正 completed，`activePlans` 现有过滤
   （`plans.ts:192`）自动让卡片消失，无需另改。

### 4.2 模型自有 todo 通道（沟通与验证解耦）

- 新增 `todo_write` 风格工具：模型每次提交**整张清单**（content + status:
  pending/in_progress/completed），last-write-wins，journal 事件 `todo/write`。
- UI 卡片纯渲染 journal 投影；turn/start 时清空（对齐 dsh 语义）。
- 该清单**不参与验证门**，只是「她在干什么」的沟通面。计划卡（证据门）继续承担裁决。

### 4.3 计划持久化可见化（R4）

- 启动水合失败从 `console.warn` 上浮：计划卡区域显示状态芯片「计划库未初始化 / 重试」。
- `persistPlan` 失败同样上浮到芯片（复用既有 `deliveryState` 模式：idle/pending/failed）。
- OPFS 初始化加退避重试（2-3 次），仍失败才进 failed 态。

### 4.4 bash 后台原语（R5）

- coding-host bash 工具新增 `run_in_background?: boolean`：
  detached spawn（`windowsHide`，脱离 120s 前台超时），主进程持有 job 注册表
  （jobId → pid + 环形日志缓冲 + 状态）。
- 新增 `job_output(jobId, {tail?})` 与 `job_kill(jobId)` 两个工具。
- 工具描述教模型：「长驻命令（起服务、watch）用 run_in_background，用 job_output 轮询」。
- Eventa 契约在 `apps/stage-tamagotchi/src/shared/eventa` 的 coding-host 段扩展。

### 4.5 测试

- core-agent：多步骤白名单累积打戳；门满足自动推进；plan/hint 事件。
- coding-harness / coding-host policy：后台 spawn、job 输出截断、kill。
- stage-ui：todo 投影与卡片；持久化失败芯片。
- 真机：T6、T7。

---

## 5. 批次三：工作画像（集中模式的实体化）

**目标**：工作轮缓存友好 + 人格安静 + 叙述可见；集中模式从「一节提示词文本」升级为回合画像。

### 5.1 改动清单

1. **回合类型**：`ChatSendSource` 增加 work 变体（或复用 `planId` 存在 + coding 工具挂载判定），
   携带画像开关；注意力设置页的 focused 开关升级为「工作轮画像」档位（默认开）。
2. **系统前缀冻结**：工作轮的 supplement（`chat.ts:665-691`）不注入 Stage Control 协议节、
   不注入注意力模式节；Character 身份留在持久化 system 消息里不动（天然稳定）。
3. **易变投影移尾部**：计划投影从 supplement 移到末条用户消息尾部（`[Plan]` 块，与
   `[Context]`/`[Reminder]` 同投递形态）——前缀缓存不再被证据落盘打断。
4. **工具面裁剪**：工作轮只挂 coding 四工具 + code_mode + 计划工具 + fetch/web_search
   （复用 `chat.ts:986-993` 先例）。表情/参数/mirror/spark 等关系性工具退场。
5. **叙述旁路**：工作轮文本跳过 `filterToSpeech`（`chat-orchestrator-runtime.ts:1087`）直达气泡
   ——「干几步说两句」不再由 TTS 分类器裁决。非工作轮行为不变。
6. **副作用裁剪**：工作轮跳过 artistry 自主任务钩子（`chat.ts:743-747`、`769-772`）；
   记忆抽提（`chat.ts:760-765`）保留但可配置。
7. **缓存可观测**：supplement 做稳定哈希，变化时记 journal（`prompt/supplement-changed`）——
   对齐 dsh 的 `request/header {reason:'change'}`，验收 T5 依赖它。

### 5.2 测试

- stage-ui：工作轮 supplement 不含 Stage Control/注意力节、计划投影在尾部；
  哈希稳定性；工具面断言。
- core-agent：叙述旁路开关（工作轮全量可见、普通轮过滤不变）。
- 真机：T1、T5。

---

## 6. 批次四：btw 旁路通道

**目标**：长任务执行期间，用户可以随时提问，她以完整人格回答——同时工作轮缓存零污染。

### 6.1 架构约束（硬性）

1. **独立 ephemeral 会话**：btw 轮不进主聊天会话、不进 `sendQueue` 双车道、
   不受 `sending` 门控、不触发 `onChatTurnComplete` 钩子全家桶（记忆抽提、续跑、cloud sync、
   self 轮审计全部不跑）。**任何写入工作会话上下文的行为都使缓存目的作废。**
2. **有界上下文**：输入 = 工作回合 journal 的投影（当前计划步骤 + 最近 N 条 tool/call+result
   摘要 + todo 清单）+ 角色卡人格节（Character + 适度 Stage Control——这里人格是主角）。
3. **工具面**：表情/参数/mirror（她可以边答边做表情，皮套就在同一渲染进程，
   表情值 localStorage-backed last-write-wins，双通道写不冲突）；**无** coding/bash/写类工具。
4. **生命周期**：随工作回合结束而结束（或空闲超时）；可被停止按钮中断。

### 6.2 实现要点

- `ChatSendSource` 增加 `'btw'`；旁路用独立的轻量 runtime 实例（或 orchestrator 的
  btw 专用 send 路径），目标会话为 ephemeral。
- UI：工作回合气泡旁的侧线卡片（对话式，可多轮追问，追问即再次 btw send）。
- 跨窗口：chat 窗口发起的 btw，问题与回答经 eventa 路由回 leader 执行——
  复用 `runtime-user-ask` 的跨窗口路由骨架（反向通道）。
- 开源参照评估标准（用户将另找 btw 参考实现，按此五条评估）：
  独立会话 / 只读投影 / 有界上下文 / 自身可中断 / 显式生命周期。dsh 的 `packages/subagent`
  + web subagent-activity 侧栏是已知同形状实现。

### 6.3 测试

- stage-ui：btw 轮不写主会话、不触发钩子；投影有界。
- 真机：T4。

---

## 7. 验收清单（真机，映射批次）

环境：构建版 electron + CDP 9250 raw eval 直连 leader 渲染进程；非 ASCII 注入用
TextDecoder 姿势（`.zcode/tmp/cdp-eval-utf8.sh`）；造数据必须在主窗口（leader，
follower 的 synced store 本地写会被快照覆盖）。

| # | 断言 | 批次 |
|---|---|---|
| T1 | 工作轮多步任务中，气泡 text 与 tool-call slices **交错出现**（她边干边说） | 三 |
| T2 | 工具执行中途发「先停一下」：流在超时内中止；journal `tool/call` 计数冻结；出现 `turn/end {reason}`；她复述收到并停手 | 一 |
| T3 | 打断后静置 60 秒**零**新 send——对照旧 bug（旧版会自动发 "do not stop until it completes"）的显式回归断言 | 一 |
| T4 | 工作轮执行中 btw 提问：侧线回答带人格口吻与正确项目进展；期间工作轮 tool journal 持续推进；工作轮 supplement 哈希不变 | 四 |
| T5 | 工作轮多步之间 supplement 哈希恒定；对照组（关画像）哈希跳动 | 三 |
| T6 | 带计划执行：步骤随证据**自动**推进完成、卡片更新且完成后从活跃列表消失、模型全程未调 `plan_update focus` | 二 |
| T7 | 让她起服务器：bash 立即返回 job id、回合继续、`job_output` 可读、`job_kill` 可停——不再有 120 秒转圈 | 二 |
| T8 | 「在 AIRI 仓库里找到 X 并改掉」：她用 `grep` 定位（未退化为递归 `list` 或 bash）、分页读、`edit` 落改动；**改完 `git diff` 只显示预期行，无行尾噪声** | 一·五 |
| T9 | 让她改一个 3000 行文件里的一处：单轮内未把整文件读进上下文（分页头部可见"本次范围"），且跨页拿到的签名 `edit` 一次命中 | 一·五 |
| T10 | 陈旧覆盖被挡：读文件 → 从外部改同一文件 → 让她 `write` → 返回 `state_changed` 且**未落盘**；她重读后重试成功 | 一·五 |
| T11 | 她在 Windows 上首次发 POSIX 命令（`grep -rn` / `ls`）后能从工具描述与错误里自行改用正确形态，不反复重试同一失败命令 | 一·五 |

T2/T3 在批次一合并前录制为常驻回归；T10 在批次一·五合并前同样录制为常驻回归
（陈旧覆盖是静默数据损坏，回归成本远低于事后排查）。
每批完成后：定向 vitest + typecheck 全绿再进下一批。

**批次一·五额外留一项观察（非断言）**：跑一个 20 步以上的真实任务，
观察她**有没有被计划机械绊住**——证据门（裁决）与 todo（沟通）在批次二后并存，
模型要多背一层状态。职责分离的论证是成立的（沟通失败拖死裁决机构正是 R3），
但对 flash 级模型它可能是净收益也可能是摩擦。这一项没有通过标准，
只要求记录观察结果进 `MODS.md`，供后续决定是否把计划卡在工作轮里降为只读投影。

---

## 8. 实施红线（工具链，违反即白干）

1. **渲染层吃 dist**：改 `core-agent` / `i18n` / `skill-forge` 源码后必须
   `pnpm -F @proj-airi/core-agent build`（或 `build:packages`）再跑跨包测试，
   否则测的是旧产物（MODS.md 三次记载的教训）。
2. **主进程 workspace 依赖双配置**：electron.vite.config.ts 的 `externalizeDeps.exclude` +
   `resolve.alias` 两处都要加，且只认**整包名**（子路径条目不生效）；漏配症状是启动即
   `ERR_MODULE_NOT_FOUND`、进程停在 3 个不进渲染。
3. **follower 写会被覆盖**：synced store 的本地变更会被 leader 快照覆盖；
   测试造数据在主窗口做。
4. **先收编在途改动**：工作区现有 16 个未提交文件（life-mode tick 消费重构）与批次一同时
   碰 `chat.ts` / `life-mode.ts`——动手前先验证（定向测试 + typecheck）并提交入库。
5. **提交纪律**：Conventional Commits，不使用 gitmoji；批次完成后按仓库体例在 `MODS.md`
   补批次小节（动机/改动/验证/遗留）。
6. **新依赖必须由用户选择**（`AGENTS.md` 明文）：批次一·五的两处依赖决策
   **已于 2026-08-31 拍板**（`@vscode/ripgrep`；探测 Git-Bash → 回落 PowerShell），
   见 §3.5.3 第 1 / 第 5 条。此后若还要引入新依赖（例如 glob 匹配库），
   同样**不要自行选定**：列成 Markdown 对照表交用户判断，然后再动手。
7. **改分级正则是安全变更**：`classifyBashCommand`（`authority/approval.ts:43-68`）漏一条
   高危模式，该命令就降级为 read-only 直接执行、不弹审批卡。补 win32 等价命令时
   逐条加测试样本，不要批量正则改写。**PowerShell 别名**（`ri` / `iwr` / `sc`）
   是最容易漏的一类，每个别名单独一条样本。
8. **签名宽度按文件总行数**：`read` 分页与 `grep` 命中行的
   `signatureLengthForLineCount` 入参必须是**文件总行数**而非本页/本次命中行数，
   否则同一行在不同调用里签名不同、`edit` 必然失配。
   这是批次一·五唯一容易静默写错的地方（C2 已按此实现，C1 实施时同样适用）。

## 9. 明确不在本计划范围

- 聊天 UI 的工作台化（diff 视图、文件树、终端面板）——CODING-HARNESS-DESIGN §0 已裁决
  「UI 是第 3 位，够用」；本计划的侧线卡片是唯一新增 UI 面。
- 工具命名空间的全面重构（debug/spark/mcp 混挂问题）——批次三的画像裁剪已缓解主症状。
- dsh 式 maintenance 相位（压缩独立相位化）——现有 waterline compaction 够用，列为后续可选。
- life-mode / 自主节拍的语义变更——仅按批次一需要接 paused 态，其余不动。

### 9.1 范围外但已确认存在的三处缺口（2026-08-31 勘探补）

> **2026-09-01 更新：三项均已由用户拍板纳入并实现**（落点见 §4.0 状态表）。
> 下面保留原始诊断文本——它记录的是「为什么要做」，不是当前状态。
> 实现时对原诊断的三处修正：
> （1）journal 落盘选了**主进程 JSONL owner + 渲染端只读镜像**，
> 而不是让每个渲染进程各自写盘——OPFS 单写者的教训在前，多写者是同一个坑；
> 回放**先于**计划水合，因为计划态是从事件派生的。
> （2）委派原语落成**只读子运行 + 报告**，不是完整子会话：
> 按原则三，子运行的报告是「主张」不是「证据」，工具描述与返回文本都写明了这一点，
> 它不能满足任何计划步骤。
> （3）diff 面按原文的「最小形态」做：结果里带行级摘要，不新增 UI 面；
> 代价是 `write` 多一次读（为了拿到改前内容），换来整文件覆盖也可审阅。

这三项**不是**本计划的遗漏，是需要用户按产品判断单独拍板的事。
写在这里是为了「接手时知道它们存在且知道为什么没做」，避免误以为批次二给了。

**一、journal 仍是内存态 → 真正的 resume 不在任何批次里。**
`journal/store.ts:11-13` 自己写着 "in-memory and inert by design"；
`journalToJSONL` / `journalFromJSONL` 已实现但**零调用方**（全仓搜索确认）；
stage-ui 的 journal store 是 `synced: { state: false }`（`stores/journal.ts:118-120`），
每个渲染进程各持一份。所以 `CODING-HARNESS-DESIGN.md` §4.4 承诺的
「白送 fork/resume、审阅切片、回放」目前是**设计意图，不是运行事实**。
计划真身能活是靠 DuckDB 存的 `stateSnapshot`，不是靠日志回放。
本计划 §4.3（R4）只把持久化失败从 `console.warn` 上浮成状态芯片——
那治的是「用户不知道丢了」，**没治「日志本身不落盘」**。
要「重启后接着干」，需要另立一批：journal 落盘 + 启动回放 + 跨窗口归属决策。

**二、没有委派原语（subagent / task）。**
opencode 与 dsh 都用它把大搜索、大阅读的上下文开销隔离在子会话里。
本计划批次四的 btw 是**反向**通道（用户在她干活时提问），不是这个。
少了它，长任务的上下文经济就少了一个主要手段——现有手段只有 §2 的收敛投影与 waterline compaction。
dsh 的 `packages/subagent` 是已知同形状实现，可作参照。

**三、没有 diff 面。**
`executeWrite` 返回 `wrote <path>`（`builtin/coding.ts:49`），用户看不到改了什么。
§9 第一条已有意识地裁决"UI 第 3 位"，这里只是把代价写明：
对 coding agent 来说审阅面就是产品本身。批次一·五的 `write` 陈旧校验会让
覆盖变得安全，但**看不见**这一点不变。若后续要补，最小形态是 `write`/`edit`
的结果里带一段行级 diff 摘要（工具结果里，不新增 UI 面），而不是完整 diff 视图。

### 9.2 补齐后仍与 opencode 不同的地方（预期差异，非缺陷）

批次一 + 一·五 + 二三四全部完成后，她在大部分场景下会像一个能用的 coding agent。
但仍有一处结构性不同，属于本 fork 的**有意选择**，不要当缺陷去"修平"：

**她比 opencode 更繁琐。** opencode 只有一个 todo（纯沟通，无验证门）；
本计划批次二之后 AIRI **同时**有证据门（裁决）与 todo（沟通）。
职责分离的论证成立（§1 关键启示：沟通职责压给证据门，门就被沟通失败拖死），
代价是模型要多背一层状态。这是原则一（结构优先于自律）与
原则七修订后（不因数量拒绝必需品）之间的一次真实取舍，
观察方法见 §7 的额外观察项。
