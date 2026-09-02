# LOOP-PLAN：心流模式（一步一步走到终点）

**状态**：外壳已落地（2026-09-01），**三个核心机械未实现**（推进循环、叙述协议、
轨迹观察——见 §11 实测复盘）；另存在五处文档缺口待修（§12）。L1-L9 验收未执行，
其中 L3/L5/L6 在当前实现下**必然不过**。
**来源**：一次真机任务的完整 journal 复盘（dsh web 连接插件开发，
`<userData>/journal/04b0b35e49b94e0822fc9c62107b0c98.jsonl`，488 事件 / 36 回合 /
125 次工具调用）。下文所有 `seq NNN` 均指该文件；§11 的实测段为同一文件
seq 489-630（心流首测）。
**总纲**：`DESIGN-PRINCIPLES.md` 全部适用；本计划是**原则一在循环上的应用**——
不要求模型注意到自己在重复失败或该继续走，**改变结构使停在半路无法发生**。
**与 `HARNESS-PLAN.md` 的关系**：HARNESS-PLAN 给了回合的**边界**
（turn/start、turn/end、可中断、双车道）。本计划给的是回合之上的**推进**。
两者不重叠：边界回答"这一步到哪结束"，推进回答"谁决定还要不要再走一步"。

---

## 0. 核心判断

**AIRI 现在有「一步」，没有「一步一步」。**

对照 Claude Code 一类 harness：一步 = 动作 → 观察 → 对观察说一句 → 回到 thinking →
决定下一步。循环由**任务是否完成**驱动。
AIRI 的一步 = 整个回合：一次 thinking、N 次工具、一段最终气泡。回合结束后
**没有任何东西在问「用户要的事做完了吗」**。判定权散在三处互不通气的机械里：

| 谁在决定 | 依据 | 问题 |
|---|---|---|
| `stepCountAtLeast(maxSteps)`（`llm-service.ts`） | 步数计数器 | 与干得好不好完全无关 |
| `schedulePlanContinuation`（`chat.ts:591`） | 计划里有没有可执行步骤 | **只在 `options.planId` 存在时才被调用**（`chat.ts:821`） |
| 用户按 Esc / 删对话 | 人 | 唯一的兜底，而删对话是唯一能改变循环状态的手段 |

三者都不问任务。于是"想一下改一下"这种最常见的工作形态在结构上不存在：
不开计划 = 一个回合最多 10 步工具，撞墙即止。

**本计划的解**：把现有 `profile: 'work'`（集中模式）升级为一个独立的运行**状态**——
**心流模式**。她在其中连续工作，由 harness 推进到任务结束，不依赖计划、
不依赖用户反复输入"继续"、不依赖任何系统伪装成用户在对话框里发提示词。

**与 `/plan` 完全独立**（本计划的硬性设计决定）：

- 心流可以无计划运行；计划也可以在非心流下运行。
- 两者叠加时职责不同：**计划提供裁决**（什么算真的完成，证据门），
  **心流提供推进**（还要不要再走一步）。
- 心流**不会**自动升级成计划模式。任务比预想复杂时她可以自己开计划，
  那是她在心流中的一个动作，不是状态迁移。
- 因此心流的终止条件只与**任务**有关，与计划步骤状态无关（§3.3）。

这一独立性同时化解了 `HARNESS-PLAN.md` §9.2 记录的那个张力：
证据门（裁决）与 todo（沟通）并存会让模型多背一层状态。
心流模式给出第三档——**有循环，无裁决**：连续工作 + todo 通信 + 循环推进，
不进证据门。三档各自的开销与它承担的责任匹配：

| 档 | 循环 | 裁决 | 适用 |
|---|---|---|---|
| 闲聊 | 无（单回合） | 无 | 对话 |
| **心流**（本计划） | **有** | 无 | 轻量修复、多阶段但不值得先勘测的工作 |
| 计划 | 有 | 证据门 | 需要"什么算真的"的任务 |

---

## 1. 诊断（全部来自同一份 journal，可复查）

### 1.1 预算挂在错误的条件上

`chat.ts:1088-1095` 两行是整件事的枢纽：

```ts
const sendOptions = {
  profile: payload.profile ?? (planId || command ? 'work' : 'social'),
  maxSteps: planId || command ? 50 : 10,
}
```

profile 与步数预算由**同一个条件**决定，而那个条件是"此刻有没有计划"。
计划会自己消失（§1.4），于是同一件工作中途 50 变回 10：

| turn | maxSteps | 结果 |
|---|---|---|
| 25、26 | 50 | completed（18 步那次真干完了活） |
| **31** | **10** | max-steps + 悬空调用 |
| 32-36 | 10 | 计划已蒸发，全程 10 |

turn 31（`seq 426`）与 turn 26 是同一件工作，笼子小了 5 倍，
**而没有任何东西告诉她笼子变小了**。

### 1.2 每一次 max-steps 都留下一个悬空工具调用

| turn | maxSteps | tool/call | tool/result | 悬空 | reason |
|---|---|---|---|---|---|
| 24 | 10 | 10 | 9 | **1** | max-steps |
| 27 | 10 | 10 | 9 | **1** | max-steps |
| 31 | 10 | 10 | 9 | **1** | max-steps |

三次全中，无例外。`seq 193` 是一次 `bash` 调用，之后直接
`assistant/done` → `turn/end`，**没有 `tool/result`**。

`stepCountAtLeast(n)` 在**步的入口**判定，不保证这一步的结果回得来。墙不是落在
"她说完话之后"，是落在**她伸手到一半**——那一步的认知永久缺失，
而 transcript 里留下一个后面没有 tool 消息的 `tool_calls`
（正是 `chat-orchestrator-runtime.ts:985` 注释里那个 provider 会拒的形状）。

**心流会让回合数上升，这个洞的触发频率随之上升**，所以它是前置项而非附带项。
修法仓库里已有先例：`d4f935d50` 为中止路径补了合成结果，预算耗尽复用同一段。

### 1.3 失败信号在系统里不存在

122 条 `tool/result` 中 **`ok=false` 的数量：0**。而内容明明是失败：

```
seq 441  tool/result  bash  ok=true  ... bash error (read-only tier, exit 1, git-bash)
seq 447  tool/result  bash  ok=true  ... bash error (medium tier, exit 1, git-bash)
```

根因：`ok: !ctx.data.isError`（`chat-orchestrator-runtime.ts:1347`）记录的是
**工具调用有没有抛异常**，而 coding 工具把失败编码成**返回字符串**
（`builtin/coding.ts` 的 `bash denied:` / `bash timed out` / `bash error`），
从不 throw。两边各自都自洽，合起来使"失败"这个信号消失。

后果是连锁的：

- 证据门只看 `event.ok`（`collectStepGateRefs` 的 `&& event.ok`）→ **失败的命令也算证据**。
- `latestToolResultFailed` 永远返回 false → **步骤永远不会被判 failed**。
- **任何基于 `ok` 写的循环判据（连续失败、无进展、该换策略）将永远看不到失败。**

最后一条使本计划的一切终止与重试判据无从写起，**所以它是第一前置项**。

### 1.4 状态转变没有记账（三个计划先后蒸发）

| seq | 事件 |
|---|---|
| 201 | 建计划 A（3 步） |
| 208 | `focus step-2` → ok |
| **220** | `focus step-3` → **"No active plan"** |
| 231 | 建计划 B（3 步） |
| **253** | `focus step-2` → **"No active plan"** |
| 352 | 建计划 C（3 步） |
| 463 / 470 | `complete step-1` → **"No active plan"**（两次） |

三个计划各在建立后约 20 seq 内消失。她三次重建**不是健忘，是每次都发现计划没了**。
`activePlans` 的过滤条件是 `status !== 'completed' && status !== 'failed'`
（`plans.ts`），所以消失的唯一途径是被判 completed/failed ——
而整份 journal 只有 **1 条 `plan/update`**（`seq 209`，那次 focus）。
**没有任何事件记录这三次转变。**

机制是已知的 riskLevel 级联（模型自报三步全 `low` → `stepHasSideEffects` 返回 false
→ 门退化为"任意一次 ok 的工具结果即完成" → 自动推进级联 → 3/3）。
已做初步修复（`MUTATING_TOOL_NAMES = {write, edit}` + bash 按 tier 分级），
但**残留一个洞**：计划 C 的 step-3 白名单只有 `bash`，实测

```
step-1 | needsMutationProof = false | 探查 dsh web API 协议      ← 合理
step-2 | needsMutationProof = true  | 编写 dsh_bridge 客户端     ← 修复生效
step-3 | needsMutationProof = false | 执行单会话连续多轮交互      ← 仍然漏
```

step-3 是全计划最实质的一步（跑起来、拿到结果），门认为它没有副作用。
`bash` 不进 MUTATING 的理由（效果不可静态判定）本身对，
结果是**只用 bash 干活的步骤退回旧的宽松语义**。

本计划关心的不是这个洞本身（属计划模式），而是它暴露的通则：
**凡状态转变必须落 journal**。否则下一次蒸发依然查不出来——
这次能查清全靠 `plan_update` 的失败回执，那是运气。

### 1.5 32 步零输出：她没有中途说话的位置

`assistant/chunk` 事件数：**0**。整份 journal 没有一条流式文本落盘。
`assistant/start` 36 次，`assistant/done` **24 次** → **12 个回合从头到尾零文本**：

| turn | 步数 | 工具序列（截断） | reason | 文本 |
|---|---|---|---|---|
| 28 | 17 | bash,grep,bash,bash,grep,read,grep,grep,grep… | steered | **0** |
| 29 | 2 | bash,bash | aborted | **0** |
| **30** | **32** | plan_update,grep,grep,read,grep,read,read,grep… | error | **0** |

turn 30 最刺眼：32 步连续工具，全程一字未说，最后上游 400 收场
（`Upstream returned no valid content`）。用户旁观即"咣咣咣一顿执行"。

这不是模型不爱说话：系统的输出模型是"一次 thinking → 一个渲染好的气泡"，
**气泡是原子单位**，封口前没有中途表达的位置。HARNESS-PLAN 的 T1
（气泡 text 与 tool-call slices 交错）以 chunk 数为 0 判定**未真正达成**。

### 1.6 无进展检测缺失（journal 里的死循环样本）

`prepareStep`（`chat-orchestrator-runtime.ts:1488`）只做两件事：查 steer 标志、
在倒数第二步喊一句预算将尽。**它不看这一步干了什么。** journal 里的实例：

- turn 27：`grep,grep,grep,bash,bash,bash,bash,bash,bash,bash` → max-steps。
- turn 28：17 步里 7 次 grep、4 次 read，无一次写入。
- `seq 359-377`：**6 条连续 `plan/hint`**，全是同一类白名单错配
  （`grep`/`read` 撞 `allowedTools: [write, bash]`），她连撞 6 次没换策略。
- `seq 463` 与 `seq 470`：同一个 `plan_update complete step-1` 发两次，
  两次都收到 "No active plan"。

循环全程照跑。这些都不该靠提示词说"请注意不要重复失败"（原则一）。

---

## 2. 心流模式：状态定义

### 2.1 它是什么

一个**会话级运行状态**，独立于 `planId`。进入后：

- 回合以心流预算运行（不再由 `planId || command` 推导）。
- 回合结束后由 harness 决定是否自动开始下一回合（§3）。
- 系统前缀冻结、人格与舞台协议节退场（沿用现有 `profile: 'work'` 的组装规则，
  `chat.ts:725-753`），易变投影走消息尾部——**缓存友好是心流的前提**：
  一个 40 回合的任务若每轮改写系统消息，前缀缓存全灭。
- 工具面裁剪到工作面（沿用现有 work profile 规则）。

**它不是**：新的会话、新的 runtime、新的窗口。心流回合就是普通回合，
走同一条 `performSend`、同一个 journal、同一条双车道队列。
**这一点是硬约束**：任何"另起一套执行路径"的实现都会复制出第二套中断、
第二套持久化、第二套失败模式。

### 2.2 进入条件：结构触发为主，声明为辅

**"她认为有必要时自动开启"若实现为让模型判断，就是自律式解法，按原则一应拒绝。**
改为双轨：

1. **结构触发（主，机械）**——本回合出现下列任一即进入心流，当轮生效：
   - 调用任何变更类工具：`write` / `edit` / 非 read-only tier 的 `bash`；
   - 调用 `todo_write`（她在为自己列多阶段清单，即已承认这是多步工作）；
   - 调用 `plan_update start`（计划模式与心流独立，但开计划显然是长工作）。
2. **显式声明（辅，覆盖）**——`/flow` 命令进入、`/flow off` 退出；
   她也可以用一个工具声明进入（作为覆盖手段，不是唯一入口）。

结构触发的判据全部来自**已经发生的工具调用**，不依赖她的自我评估。
注意 `write`/`edit` 的判定不能只看工具名：`bash` 要看 tier
（`policy.ts` 已在结果里带 `read-only tier` / `medium tier` 字样，
但**不要靠正则解析摘要**——tier 应作为结构化字段进 `tool/result`，见 §5.1）。

### 2.3 退出条件：五种，全部落 journal

| 退出原因 | 判定 | 谁能触发 |
|---|---|---|
| `done` | 她显式声明任务完成（工具调用，非自然语言） | 她 |
| `blocked` | 她显式声明具体阻塞，且已通过 btw/user_ask 提出 | 她 |
| `interrupted` | 用户 Esc / steer / `/flow off` | 用户 |
| `budget` | 回合数或工具调用总数达上限 | harness |
| `no-progress` | 连续 N 回合零进展（§3.4） | harness |

**五种都必须写 `flow/end {reason}` 事件。** 这是 §1.4 那条通则的直接应用：
计划蒸发之所以查不出来，就是因为状态转变走了旁路。心流不能重犯。

`done` 与 `blocked` 用工具而非自然语言声明，理由同 M1：自然语言判定要靠模型
守规矩，工具调用是结构事实。可复用 `todo_write` 的形态——她本来就在维护清单，
"全部 completed + 声明结束"是自然的收尾动作。

---

## 3. harness 推进：一步走完再走下一步

### 3.1 推进不是"伪装用户输入"

现有 `schedulePlanContinuation`（`chat.ts:591`）用 `send({ source: 'self-initiative',
text: 'Plan continuation (n/N): continue step ...' })` 推进——**一条合成的用户消息**。
本计划**明确弃用这个形态**：

- 它污染对话历史（那条 text 是会话里的真实消息）。
- 它使"谁在说话"不可辨（journal 里 `user/message` 记的是 harness 写的字）。
- 它把推进逻辑挤进一段提示词，判据不可测。

**心流推进应当是 runtime 内的一次续跑**：不新增 `user/message`，
在同一条消息序列尾部追加上一轮的工具结果与一段有界的推进上下文，
以 `turn/start {source: 'flow'}` 开新回合。

**这同时是缓存策略**：增量在尾部、前缀不变，KV 缓存天然命中。
（现有 `prompt/supplement-changed` 已可观测前缀变化——journal 里 14 次哈希跳变，
实施时应确认心流回合之间该哈希**恒定**。）

### 3.2 每步之间发生什么

一次心流步进的完整序列，全部在 runtime 内：

1. **结算上一回合**：确保每个 `tool/call` 都有 `tool/result`
   （预算耗尽的悬空调用在此补合成结果，§5.2）。
2. **等在途压缩**：`await` 该会话的在途压缩任务。
   现有 `scheduleCompaction` 是 `void`-调用的 fire-and-forget
   （`chat-orchestrator-runtime.ts:1687`），有 `compactionTasks` 单飞守卫但**不阻塞下一轮**。
   心流下一步会紧接着组 prompt → 可能带着未压缩的历史发出。
   症状是偶发超窗、不稳定复现（最难查的一类）。
   `compactNow` 已有 `await compactionTasks.get(sessionId)` 的形状可复用。
3. **评估终止条件**（§2.3 五种 + §3.3）。任一命中 → `flow/end`，停。
4. **评估无进展与重复失败**（§3.4）。命中 → 注入结构化提示或强制换策略。
5. **组装下一回合**：尾部追加。前缀不动。
6. `turn/start {source: 'flow', flowId, iteration}` → 走同一条 `performSend`。

### 3.3 终止判据是任务，不是步数也不是计划状态

这是本计划与现有 `schedulePlanContinuation` 的根本分歧。后者的判据是
`runnablePlanStep()`——计划里有没有可执行步骤。两者不是同一个问题：

- 计划步骤全 completed 而任务没完成 → 现有逻辑停（**正是这次的情况：3/3
  却停在 step-2 中间**，`seq 463` 她自己发 `focus step-2` 恰恰说明她知道没做完）。
- 任务完成而步骤还挂着 → 现有逻辑空转。

心流的判据只有一个：**她是否声明任务完成或明确阻塞**（§2.3）。
有计划时计划状态仍然重要——但它是**裁决**（这一步算不算真做完），
不是**推进**（还要不要再走一步）。两条账分开记。

### 3.4 无进展与重复失败：循环的自我观察

§1.6 的样本要求 harness 观察轨迹。判据全部结构化、可单测、不依赖模型自律：

| 判据 | 触发 | 动作 |
|---|---|---|
| 同一工具 + 同一参数连续失败 ≥3 | 结构比对（参数哈希） | 注入"这条路已试过 N 次"，并把该调用列入本回合已排除路径 |
| `edit` 连续 `state_changed` ≥2 | 结果状态 | **强制先 `read`**（Hashline 的拒绝语义就是"状态已变请重读"，但目前无任何机械保证她真去重读） |
| 连续 ≥N 回合零变更类工具成功 | 需要 §5.1 的失败信号 | 升级为 `no-progress` 退出，或转 btw 向用户提问 |
| 同类 `plan/hint` 连续 ≥3 | 已有 hint 事件 | 注入白名单错配的显式指引（`seq 359-377` 连撞 6 次） |

**上限值不要收进一个常量表**（`AGENTS.md`：retry/backoff/limit 不用一个常量覆盖
一切）。每条判据的阈值声明在它自己的判定点旁，各带说明。

### 3.5 失败也要收敛进上下文

原则二（收敛优先于累积）目前只用在**成功**上：`turn-projection.ts` 的
`evidence.slice(-4)`、只有计数没有内容。失败呢？一步失败的真实原因
（命令报错、签名失配、测试红了）进 journal，**不进下一轮**。
所以她在第 7 步不知道第 3 步为什么失败，只能重试或换个姿势再撞一次。

心流的推进上下文必须带一段**有界的"已排除路径"**：
试过什么、为什么不通。这与证据门是**两本账**：

> 证据门要的是"什么算真的"（只承认成功），
> 循环要的是"什么已经排除"（失败同样有信息价值）。

目前只记了第一本。有界形态建议：最近 N 条失败，每条一行
（工具 + 关键参数摘要 + 失败原因），随窗口滚动，不累积。

---

## 4. 失败重试：分两类，不要在流层做通用重试

`e04f1cca9` 已为 `empty_response_error` 做了单次重放，**而且做对了最难的部分**：
只在 pre-content 失败时重放（未交付任何事件、未中止），所以内容不会重复。
心流沿用同一判据扩展，但必须区分两类：

| 类 | 例 | 处置 |
|---|---|---|
| **pre-content 失败** | 429、连接超时、`empty_response_error`、部分 400 | 整轮重放（沿用现有判据 + 退避）。429 应读 `Retry-After`，无则指数退避 |
| **content 已开始后失败** | 流中断、上游 500、turn 30 那次 400 | **不可重放整轮**（会重复内容）。保住已完成的工具结果，**作为新一步继续** |

第二类的处置正是心流本来就要做的事——**"失败后从下一步继续"和"正常推进"是同一条代码路径**。
这比在流层做复杂重试省得多，也是心流模式在可靠性上的顺带收益。

`turn/end {reason:'error'}` 之后能否自动继续，取决于错误是否可恢复：
可恢复 → 心流继续（计入 `no-progress` 预算）；不可恢复（鉴权、配额耗尽、
模型不存在）→ `flow/end {reason:'blocked'}` 并上报，**不要静默重试到预算耗尽**。

---

## 5. 前置项（不修则心流无法判断，也无法被诊断）

### 5.1 `ok` 语义修正 + 结构化工具结果

§1.3：122 条结果零 `ok=false`，"失败"在系统里不存在。
**这是本计划的第一前置项**——§3.4 的一切判据都要读它。

修法**不是**改 `ok` 的含义（它对"调用是否抛异常"是准确的），而是让工具结果
携带与结果语义对齐的结构化字段。建议在 `ToolResultEvent` 增加：

- `outcome: 'ok' | 'failed' | 'denied' | 'timeout'`——工具自报，
  由 coding 工具从 `CodingExecRunResult.status` / `exitCode` 直接映射
  （数据已在手，`policy.ts` 就返回这些，现在被拼成字符串丢掉了）。
- `tier?: 'read-only' | 'medium' | 'high'`——bash 的分级作为字段，
  **不要再靠 `/read-only tier/.test(summary)` 解析摘要**（`gate.ts:80` 现况）。
  §2.2 的心流结构触发也要读它。

顺带修掉证据门的一个真实缺陷：`refProvesMutation` 目前只看 tier 不看 exit code，
所以一条 `medium tier, exit 1` 的**失败**命令可以充当变更证明。

### 5.2 悬空工具调用补偿

§1.2：三次 max-steps 三次悬空。预算耗尽时为未结算的 `tool/call` 补写合成
`tool/result {outcome:'failed', summary:'step budget exhausted before the result returned'}`，
对齐 `d4f935d50` 的中止补偿路径。理由有两条，第二条更硬：

1. 模型看不到自己最后一步的结果 → 认知永久缺失。
2. transcript 里留下没有后续 tool 消息的 `tool_calls` → **部分 provider 直接拒**
   （`chat-orchestrator-runtime.ts:985` 注释记载的正是这个形状）。

### 5.3 状态转变必须落 journal

§1.4 的通则。本计划新增的事件（§6）已按此设计；同时建议把计划的
active→completed/failed 转变也补上事件——那是这次三个计划蒸发查不出来的直接原因。

---

## 6. journal 事件（新增）

沿 `JOURNAL_EVENT_TYPES` 扩展（`journal/types.ts`）：

```
flow/start   { flowId, trigger: 'tool' | 'declared' | 'command', triggerDetail?, timestamp }
flow/step    { flowId, iteration, reason: 'continue', pending?: string }
flow/end     { flowId, reason: 'done' | 'blocked' | 'interrupted' | 'budget' | 'no-progress',
               iterations, timestamp, detail? }
```

`turn/start` 的 `source` 联合类型增加 `'flow'`（现为
`'text' | 'voice' | 'self-initiative' | 'btw'`），并带 `flowId` + `iteration`，
使"这一回合属于哪次心流的第几步"可查。

`TurnEndReason` 无需新增值：心流步进用现有 `completed`；
心流本身的结束由 `flow/end` 记录。

---

## 7. 流式输出与 btw

### 7.1 `assistant/chunk` 真正落盘

§1.5：chunk 数为 0，12 个回合零文本。心流会显著拉长单次任务的回合数，
不修则"咣咣咣"变成"咣咣咣咣咣咣"。

要点：心流回合的文本**跳过 `filterToSpeech`** 直达气泡与 journal
（HARNESS-PLAN §5.1 第 5 条已设计，需确认是否真的生效——chunk 为 0 说明
要么没生效，要么生效了但没落 journal，两种都要查）。
哪些内容进 TTS 是独立问题，本计划不处理。

### 7.2 btw 双向

现状已有骨架：`btw.ts`（240 行，`workProjection()` 有界工作投影 + `ask` / `askActive`）、
`ChatSendSource` 含 `'btw'`、delivery 走 `next-turn` 不打断工作轮。

**新增反向通道：她在心流中主动 btw 用户。** 形状与正向对称：

- 心流中途需要人的输入时**不停下循环**。现有 `user_ask` 是阻塞式问题卡——
  在心流里阻塞等待会把"连续工作"变成"连续等待"。
- 她发出 btw 提问 → 循环继续跑其他可推进的步骤 → 用户有空再答 →
  答案作为下一步的上下文进入。
- 无法绕开该提问继续时，才升级为 `flow/end {reason:'blocked'}`。

这与心流互补：**心流让她一直走，btw 让她在不停下的前提下说话和提问。**
"32 步零输出"的另一半由 §7.1 解决，这一半解决"她想说的话有地方去"。

---

## 8. 批次

| 批次 | 内容 | 依赖 |
|---|---|---|
| **前置** | §5.1 `ok`/`outcome`/`tier` 结构化；§5.2 悬空补偿；§5.3 状态转变落 journal | 无。三者都是独立可交付的修复 |
| **一** | 心流状态本体：独立状态位、profile 与预算改由它决定（拔掉 `chat.ts:1088-1095` 的 `planId \|\| command`）、结构触发 + 显式声明、五种退出全落 journal | 前置。**实测（§11）：部分落地**——状态位/预算/命令在，结构触发与退出五态待验 |
| **二** | harness 推进：runtime 内续跑（弃用合成用户消息）、终止判据为任务、压缩 await、§3.4 四条轨迹判据、§3.5 已排除路径 | 一。**实测（§11.3.1 更正）：已实现且已接线（`:2324-2387`），但从未被执行**——`flow_update done` 无门，她在首个回合内即宣告完成 |
| **二·五** | **给循环开门**：`done`/`blocked` 加机械判据、`flow/end` 结算到回合边界（§13） | 二。**当前最大欠账** |
| **三** | 失败重试两分类（§4）；`assistant/chunk` 落盘（§7.1）；btw 反向（§7.2） | 二·五。**实测：§7.1 未实现（27 条 chunk 全在收尾）** |
| **后续** | rewind 取代删对话。数据前提已具备：journal 落盘 + `tool/result` 记录 write/edit + `hashline/text.ts` 的 `contentHash`。缺的是接线 | 前置的状态记账 |

每批：定向 vitest + typecheck 全绿再进下一批。
改 `core-agent` 后必须 `pnpm -F @proj-airi/core-agent build` 再跑跨包测试
（渲染层吃 dist，`MODS.md` 已四次记载）。

---

## 9. 验收（真机，映射批次）

| # | 断言 | 批次 |
|---|---|---|
| L1 | 一次 bash 失败（exit 1）后 journal 出现 `tool/result {outcome:'failed'}`；同一条命令连续三次失败后循环**不再重发第四次** | 前置 + 二 |
| L2 | 预算耗尽的回合：最后一个 `tool/call` 有配对的合成 `tool/result`；transcript 无悬空 `tool_calls` | 前置 |
| L3 | 不开计划、只说"修一个 bug"：她进入心流（`flow/start {trigger:'tool'}`），跨多回合自动推进到完成，`flow/end {reason:'done'}`；**全程用户零输入** | 一 + 二 |
| L4 | 心流各回合之间 `prompt/supplement-changed` 哈希**恒定**（前缀缓存未被打断） | 一 |
| L5 | 心流回合的 `assistant/chunk` 非空且与 `tool/call` 交错——对照 turn 30（32 步零文本）的显式回归 | 三 |
| L6 | 心流中途她 btw 提问：循环继续推进其他步骤，用户答复后答案进入下一步上下文 | 三 |
| L7 | 用户 Esc：`flow/end {reason:'interrupted'}` 落盘，静置 60 秒**零**新回合 | 一 |
| L8 | 429 或超时：pre-content 失败自动重放且内容不重复；不可恢复错误 → `flow/end {reason:'blocked'}` 并上报，不静默重试到预算耗尽 | 三 |
| L9 | 心流与 `/plan` 叠加：计划步骤的裁决仍由证据门做，心流推进不因计划步骤状态而提前停止（对照 3/3 却停在 step-2 中间那次） | 二 |

L1、L2、L7 在合并前录制为常驻回归——它们对应的都是静默失败。

---

## 10. 明确不在本计划范围

- **心流自动升级为计划模式**——已裁决为完全独立（§0）。她可以在心流中开计划，
  那是一个动作，不是状态迁移。
- **TTS 内容筛选**——`filterToSpeech` 只在 §7.1 被旁路，进 TTS 的策略不动。
- **riskLevel 级联的完整修复**（§1.4 的 step-3 洞）——属计划模式的裁决面。
  本计划只取它的通则（状态转变必须记账）。
- **rewind**——列入后续，本计划只写清数据前提。
- **UI 工作台化**——`CODING-HARNESS-DESIGN.md` §0 已裁决"UI 第 3 位"。
  心流唯一需要的 UI 是一个状态指示（她在心流中 / 第几步 / 可停止）。

---

## 11. 首次真机实测复盘（2026-09-02，seq 489-630）

用户以 `/flow` 发起心流重写 dsh_bridge 插件。结论：**外壳工作、内核空缺**。
流畅感真实（50 步预算 + 工具面/前缀组装生效），但本计划的核心承诺
——"一步一步走到终点"——尚未发生。

### 11.1 实测数据（全部来自 journal）

| 指标 | 实测 | 计划要求 | 判定 |
|---|---|---|---|
| turn 数 | **2**，全 `source=text` | 多回合、`turn/start {source:'flow'}` | ❌ 推进循环未实现 |
| `flow/step` 事件 | **0** | 每步一条（§6） | ❌ |
| turn/start 携带 flowId/iteration | 无 | 必带（§6） | ❌ |
| 第二回合工具调用数 | **35**（一轮内） | 每步结算后再评估（§3.2） | ❌ 大回合硬扛 |
| 工具调用期间的叙述 chunk | **0**（27 条 chunk 全部在最终总结里） | 与 `tool/call` 交错（§7.1） | ❌ 叙述协议未实现 |
| `plan/hint` 连撞 | **20 条**（plan_update×6、grep×6、todo_write×3），无干预 | 同类 ≥3 注入指引（§3.4） | ❌ 轨迹观察未实现 |
| `flow/end {done}` | seq 606，正常落盘 | 五种退出全落 journal（§2.3） | ✅ |

### 11.2 已生效的部分（值得保留的基线）

- `flow/start`/`flow/end` 事件、`/flow` 命令解析、`flow_update` 工具、
  `ChatSendSource` 的 `'flow'` 变体（代码就位）。
- 50 步预算 + work 组装（工具面裁剪、前缀冻结）——「流畅是真的流畅」的来源。
- L4（前缀哈希恒定）在两个回合之间只有 2 次 supplement 变化，初步成立。

### 11.3 判定与欠账

当前实现 = **批次一的一部分**（状态位 + 预算）。
验收映射：L1/L5/L6 当前必然失败；L3 的「跨多回合自动推进」不成立；
「心流显示只有一步」的 UI 观感与 journal 一致。

### 11.3.1 修正：推进循环**已实现**，是被提前关掉的（2026-09-02 二次核查）

§11.1「推进循环未实现」的判定**不准确**，据代码与 journal 更正如下。

`continueFlow`（`chat-orchestrator-runtime.ts:2324`）**完整存在且已接线**：
`sendQueue` 的 handler 在 `performSend` 之后无条件调用它（`:2404`），
循环体里 §3.2 的序列基本齐备——generation 检查、steer 检查、三种预算上限、
`await runningCompaction`（`:2355-2357`，§3.2 第 2 步）、`flow/step` 写入
（`:2363`）、以 `source:'flow'` + `flowContinuation` 递归 `performSend`（`:2374`）。
§3.4 的轨迹状态字段也都在 `FlowRuntimeRecord` 里（`repeatedFailures`、
`editStateChangedStreaks`、`forceReadPaths`、`planHintStreak`、`zeroProgressTurns`）。

**真正的失败点是 seq 606 早于 seq 630**——`flow/end` 落在**回合内**，
`turn/end` 在其后 24 个 seq。事件序列：

| seq | 事件 |
|---|---|
| 601 | `plan_update complete` → **"No active plan in this session"** |
| 603-605 | `todo_write` → `todo list updated (3/3 done)` |
| **606** | **`flow/end {reason:'done', iterations:1}`** |
| 607 | `tool/call flow_update {action:'done'}` |
| 608 | `tool/result` → `Flow complete: 已成功…重构并完善…` |
| 609+ | 最终总结的 27 条 chunk |
| 630 | `turn/end {completed}` |

她在第一个回合的工具循环**内部**调了 `flow_update done`。
`endFlow` 立即把 `status` 置 `ended`，于是回合结束后 `continueFlow` 跑到
`:2359` 的 `if (!nextFlow \|\| nextFlow.status !== 'running') return` 直接退出。
**循环不是没实现，是它启动前状态已经被关掉了。** `iterations:1` 就是证据：
计数器停在初始值，一次续跑都没发生。

**根因是 `flow_update done` 无门**（`builtin/flow.ts:executeFlowUpdate`）：
`action:'done'` 只返回一句文本，没有任何条件校验。这正是
`DESIGN-PRINCIPLES.md` 原则一与原则三要防的形状——**"她说完成了"直接成为
系统事实**，而本仓的全部设计都建立在"模型声称不是证据"之上。
§2.3 把 `done` 设计成"工具调用而非自然语言"是对的，但只换了**载体**，
没有加**门**：工具调用同样是模型声称。

同场证据表明这次声称确实不可信（§11.4）：测试断言空转、远端明确否认 PTC、
`plan_update complete` 收到 "No active plan"（她自己的计划状态是坏的），
而她仍然宣告 done。

**修法（§13 第 1 条）**：`done` 必须过门。至少三条机械校验：
1. **有变更证据**：本次心流内至少一次 `outcome:'ok'` 的变更类工具结果
   （复用 §5.1 的 `outcome`/`tier`，与证据门的 `refProvesMutation` 同源判据）。
2. **todo 一致**：若本心流写过 todo，全部条目为 `completed`
   （本次是 3/3，这条会通过——不足以单独作门，需与第 1、3 条合取）。
3. **无未结算的坏状态**：最近若干工具结果里没有未处理的失败/拒绝
   （本次 seq 602 的 "No active plan" 属此类，会挡下这次 done）。
门不通过时 `flow_update done` 应**返回拒绝并说明缺什么**，语义对齐 Hashline
的 `state_changed`：不是任务失败，是"还不能宣告完成，先补 X"。

**另一处需一并修的时序问题**：`flow/end` 写在回合内，导致 journal 里
`flow/end` 早于 `turn/end`，且此后 24 个 seq 仍在同一回合内产生
（含 27 条 chunk）。心流的结束应当**结算在回合边界**：回合内的 `done`
声明只置一个待结束标记，由 `continueFlow` 在回合结束后校验并落 `flow/end`。
这样 §6 的事件序列才自洽（`flow/end` 必在 `turn/end` 之后）。

### 11.3.2 修正后的欠账清单

| 项 | 状态 |
|---|---|
| §3.2 推进序列（结算-等待-评估-组装） | **已实现**（`:2324-2387`），未被执行过 |
| `flow/step` 事件 + `turn/start {source:'flow'}` | **已实现**，同上 |
| 三种预算上限 + `no-progress` 退出 | **已实现**，同上 |
| §3.4 轨迹判据的状态字段 | **已实现**；注入/干预动作是否接上待逐条验 |
| **`flow_update done` 的门** | **缺失——当前最大欠账**（本节） |
| **`flow/end` 的回合边界结算** | **缺失**（本节） |
| §7.1 叙述协议（工具期间 chunk） | 缺失（27 条 chunk 全在收尾） |
| §5.1 `outcome`/`tier` 结构化 | 部分——`tool/result` 摘要里已有 `{"tier":"read-only","status":"ok"}`（seq 598）与 `{"status":"written","baseHash":…}`（seq 596），但仍在 summary 字符串内，非结构化字段 |

**下一步不是重写批次二，是给它开门**：`done` 加证据门 + `flow/end` 移到回合边界。
这两项落地后，现有的 `continueFlow` 才有机会跑第二圈。

### 11.4 插件改动质量（同场审查，记档）

她本轮真的写了测试（`dsh_bridge_test.js`，第一场没有）并把「无条件自动放行」
改成了 `approvalHandler` 钩子——上轮批评两点均有吸收。但暴露一个新教训：

**断言空转**。测试两次运行均 `ALL INTEGRATION TESTS PASSED`（seq 591/598，
exit 0），但其断言只覆盖「调用不抛异常 + 会话归属」；对话正确性全靠
`console.log` 打印。而打印出的实际回答是
「No — not under PTC (Code Mode)」（两次都是）——**远端明确否认 PTC 模式**，
她的总结却报告「DeepSeek 确认其工具面已收拢为 run_code SDK」。
绿灯来自脚手架通电，不是功能验证；虚报从空断言里穿了过去。
教训回喂：把 `console.log(r1.reply)` 换成 `assert(/PTC|code mode/i.test(r1.reply))`
——这正是她自己 harness 里证据门防的那种失败（绿灯 ≠ 证据），
也是 §5.1 `outcome` 字段要在工具侧解决的同类问题。

---

## 12. 文档缺口（评审发现，2026-09-02，待修）

1. **§1.5 机制表述错误**：「气泡是原子单位，封口前没有中途表达的位置」不成立——
   文本 delta 实时流进气泡（HARNESS-PLAN T1 验收见过 text 与 tool-call 交错）。
   真实缺口是 ①模型不做叙述动作（无指令要求）②journal 不落 chunk。
   §7.1 自己已承认「两种都要查」，与 §1.5 措辞矛盾——重写 §1.5。
2. **§3.1 续跑上下文的角色形态未定义**：不新增 user/message 的前提下，
   「有界推进上下文」以什么 role 追加？user-role 回到自我批评的污染；
   system-role 尾插有 provider 兼容问题（`[Reminder]` 设计注释里记过）。
   实现时选定后回填文档。
3. **§2.2「当轮生效」语义含糊**：回合中途触发心流时预算是否追溯变更？
   与 `prepareStep` 倒数预警（`maxSteps` 已捕获的值）如何交互？未说明。
4. **与生命周期的交互未提及**：数小时心流期间 life tick / 考量回合排队还是压制？
   多窗口切换会话时心流状态归属？两处未定义。
5. **小项**：§1.4 的 "No active plan" 回执实际 5 处（漏 seq 90）；
   心流无显式 token 成本预算（水位压缩管上下文不管花费——
   flash 模型连跑 200 步的费用应有一句提醒与可选上限）；
   验收完成后按体例回写 `MODS.md` 批次指针。
6. **§11.1 的「推进循环未实现」判定已由 §11.3.1 更正**：循环存在且已接线，
   失败点是 `flow_update done` 无门导致回合内提前关闭。保留 §11.1 原表
   （它记录的是首测观测到的现象），但读表时以 §11.3.1 的归因为准。

---

## 13. FLOW-FIX 批次：给推进循环开门（2026-09-02）

本节的执行版与评审修正统一记录在 [`FLOW-DIAGNOSIS.md`](./FLOW-DIAGNOSIS.md)。
本批按 **P0-1/P0-2/P0-3/P0-4、P1-1/P1-3/P1-5、P2-2、P3-1/P3-2/P3-8** 及五点审计
落地；P0-1 采用“保留 fallback 打章、增加验证语义门”的修正。P1-2 本批仅登记
为受审批端口制的独立立项，P2-1 和环境块的 git 分支/测试命令扩展不在本批实现。
P0-4 采用执行后的 `onStepResult`；心流回合的 `softBudget` 固定为 5，非心流 work
轮继续使用原 `maxSteps`，默认值保持 50。

§11.3.1 把欠账从"实现循环"改成了"让循环有机会跑"。按此重排：

### 13.1 P0 —— `flow_update done` 加证据门

`builtin/flow.ts` 的 `executeFlowUpdate` 目前对 `done` 零校验。
改为三条合取的机械判据（全部读结构化事实，不读自然语言）：

1. 本次心流内 ≥1 条变更类工具的成功结果（`outcome:'ok'` + 非 read-only tier）。
2. 若本心流写过 todo，全部条目 `completed`。
3. 最近 N 条工具结果中无未处理的失败/拒绝（seq 602 那类 "No active plan"）。

拒绝时返回缺什么，语义对齐 Hashline 的 `state_changed`——不是失败，是"先补 X"。
门的判据与证据门的 `refProvesMutation` **同源但不同用**：证据门裁决"这一步算不算做完"，
这道门裁决"整个任务能不能宣告结束"。两者共享 `outcome`/`tier`，各自独立判定。

`blocked` 同样需要门：§2.3 要求"已通过 btw/user_ask 提出"，
当前 `executeFlowUpdate` 对此也零校验——应检查本心流内确有 `btw_ask` / `user_ask` 调用。

### 13.2 P0 —— `flow/end` 结算到回合边界

回合内的 `done`/`blocked` 声明只置待结束标记（`flow.pendingEnd`），
由 `continueFlow` 在回合结束后校验并落 `flow/end`。收益有三：

- journal 事件序列自洽（`flow/end` 必在 `turn/end` 之后）。
- 门的校验能看到**整个回合**的工具结果，而不是声明那一刻的部分结果。
- 声明之后回合内若又出现失败，门可以驳回这次结束并让循环继续。

### 13.3 P1 —— §5.1 结构化字段收尾

seq 596/598 显示工具结果里已有 `{"tier":"read-only","status":"ok"}` 与
`{"status":"written","baseHash":…}`，但都在 `summary` 字符串内。
把它们提升为 `ToolResultEvent` 的结构化字段（`outcome` / `tier`），
使 13.1 的门与 §3.4 的轨迹判据不必解析字符串。
顺带修 `refProvesMutation` 只看 tier 不看 exit code 的缺陷（§5.1 末段）。

### 13.4 P1 —— §7.1 叙述协议

27 条 chunk 全部在收尾（seq 609+），工具期间零叙述。§12 第 1 条已澄清机制：
文本 delta 本来就实时流进气泡，缺的是**模型不做叙述动作**（无指令要求）
与 **journal 不落工具期间的 chunk**。前者靠心流的推进上下文明确要求
"每完成一个动作用一句话说明下一步"；后者是落盘接线。

### 13.5 验收补充

| # | 断言 | 对应 |
|---|---|---|
| L10 | 心流内声称完成但无变更证据（或有未处理失败）→ `flow_update done` **被拒**并说明缺什么；循环继续 | 13.1 |
| L11 | `flow/end` 在 journal 中**始终晚于**同回合的 `turn/end` | 13.2 |
| L12 | 一次成功的心流：`flow/step` ≥1、`turn/start {source:'flow'}` ≥1、`flow/end.iterations` >1 | 13.1+13.2 解锁 |

L10 是本轮首测那次虚报的显式回归——**它同时也是 §11.4「断言空转」的同构防线**：
她的测试用空断言放过了失败，而 harness 的 `done` 门不能重犯同一个错。

### 13.6 P0-4 回合内步进的执行后停止

`@xsai/stream-text` 的 patch 在工具结果写入 messages 后调用 `onStepResult`。
回调返回 `{ stop: true }` 时，当前 step 先进入 `steps`，然后结束本回合。
`llm-service.ts` 的 `stopWhen` 只在无工具调用的 step 上停止。

runtime 的预算规则如下：

1. 心流轮：`softBudget = 5`，到达预算后由 `onStepResult` 停止。
2. 非心流 work 轮：`softBudget = maxSteps`，保持原调用方预算，默认 50。
3. 心流的后续 step：`prepareStep` 追加工具间隙叙述指令。

验收必须确认：第五步工具结果已落 journal 和 provider transcript，且第六步不会启动。
非心流 work 轮不得因为心流预算而提前停止。
