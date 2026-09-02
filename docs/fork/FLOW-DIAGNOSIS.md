# FLOW-DIAGNOSIS：心流首轮实测深挖复盘（2026-09-02）

> 本文档是对 `LOOP-PLAN.md` §11 首次真机实测的**第二次深挖**。
> §11.3.1 已经归因过一次：`flow_update done` 无门导致回合内提前关闭。
> 本文档在同样的 journal 上再往下挖一层，找到这个现象背后的两条更深的根因，
> 并据此给出一份完整改动清单。所有结论均可凭 seq 在 journal 中复查。
>
> **v2 更新（2026-09-02 14:xx，第二轮实测）**：
> 心流不再提前终止（`iterations:12`），但出现了用户预期的结构性偏差——
> **心流没有像 harness 一样「一步一思考、中间流式输出」，而是「一次 think、连发
> 多次工具、最后收尾输出」**。这一节的根因不在 `flow_update done` 门（已修），
> 而在 **回合内循环（`stopWhen: stepCountAtLeast(maxSteps)`）的结构**。
> 详见新增的 **§4.2「回合内循环」**。
>
> 本复盘的发现分两类：
> - **§1-§4**（P0-P2）：从 seq 503-652 这轮实测逆向推出来的 **fork 机制缺陷**，
>   不修则心流无法可靠运行。
> - **§5.5**（P3）：这个项目作为 **harness 本来就缺的常识**，与这轮故障无关，
>   不修则心流能跑通也只是「能自我推进的工具盒子」，不是「会工作的 harness」。

## 0. 数据来源

- 主 journal：`<userData>/journal/04b0b35e49b94e0822fc9c62107b0c98.jsonl`
  （事件 652 条，时间 2026-09-01 12:29 → 2026-09-02 01:40）
- 本轮心流区间：**seq 503 → 652**（`flow/start` 到余额耗尽）
- 窗口内（seq ≥ 503）事件共 81 条，其中：`tool/call` 35、`tool/result` 35、
  `assistant/chunk` 30、`plan/hint` 20、`plan/update` 5、`todo/write` 4、
  `flow/start` 1、`flow/end` 1、`turn/*` 各 3。
- 时间标记：`flow/start` 01:15:35、`flow/end` 01:19:37、`turn/end` 01:19:42、
  任务结束（billing 错）01:40:36。

## 1. 心流为何只跑了一轮（seq 503-652）

### 1.1 机械事实链

| seq | 事件 | 含义 |
|---|---|---|
| 503 | `flow/start {trigger:'command'}` | `/flow` 命令进入，`## Flow` 指令已注入 |
| 505 | `turn/start {source:'text', maxSteps:50}` | **不是** `source:'flow'`，这是命令那轮 |
| 509 | `tool/call flow_update{action:'start'}` | 她又显式声明了一次 |
| 510 | `tool/call plan_update{action:'start'}` | 建立 3 步计划 |
| 607 | `tool/call flow_update{action:'done'}` | 回合内第 35 次工具调用 |
| 606 | `flow/end {reason:'done', iterations:1}` | 拦截发生在 **tool/call**，早于 call 落盘 |
| 630 | `turn/end {reason:'completed'}` | 回合真正结束 |
| —   | `continueFlow` 启动时 status 已 `ended` | 直接退出，`iterations:1` 一次续跑都没发生 |

关键时序：`flow/end`（seq 606）**早于**触发它的 `tool/call flow_update`（seq 607）。
根因是 `chat-orchestrator-runtime.ts:1779` 在 **tool-call 事件**上就拦截了
`flow_update` 并调用 `endFlow`，而不是等 tool-result。所以任何「工具体内的门」
都来不及——状态在调用那一刻就已经被关掉了。

### 1.2 她为什么在回合内宣告 done（新根因）

在 seq 607 那一刻，她收到的三个信号全部指向「任务已完成」：

| 信号 | 显示 | 真实情况 |
|---|---|---|
| todo | seq 605 3/3 completed | 她自己写的 |
| 计划 A | seq 574 `plan reached terminal status: completed` | **模型声明**，非证据 |
| 集成测试 | seq 591/598 两次 ALL PASSED | 断言只查「调用不抛异常 + 会话归属」，对话正确性靠 `console.log` |

第二条是新发现，也是本复盘最重要的根因。

**计划 A 的 `completed` 不是模型声明污染，是被一个不相干的 bash 探测满足的。**
`planLinkFor`（`chat-orchestrator-runtime.ts:905-923`）的盖章规则是：

```ts
const match = candidates.find(c => c.focused && accepts(c))
  ?? candidates.find(accepts)
if (match) {
  return { planId: match.planId, stepId: match.stepId }
}
```

「聚焦步不接受时，落到第一个接受的开放步。」seq 546 的 bash 时聚焦步是
step-2-refactor（允许集 `["edit","write","read"]`），不接受 bash，于是盖章落到
第一个接受 bash 的开放步 **step-3-test-verify**（允许集 `["bash","read"]`）。

seq 547 那条 `node -e` HTTP 探测（探活 `127.0.0.1:18423`）因此被记为
step-3 的证据。而验证步的预期证据是 `tool_result`。**一个探活命令就满足了
「写测试并验证」这个验证步**。所以计划 A 在 seq 574 判 `completed` 是引擎的
合法判定，但它在真正的集成测试（seq 590）尚未运行时就被判定完成了。

这就是 `DESIGN-PRINCIPLES.md` 原则三（权威有序）里最深的形态：不是「模型声称
是证据」，而是**「证据与步骤的实质不相关」**。bash 被列进 `allowedTools` 后，
bash 的任何成功回执都算该步证据，哪怕这条 bash 只是探活，与该步要验证的内容
毫无关系。这一步**不是**模型声明污染了计划状态，它确实是引擎自己判的，只是
判据太松——把「任意允许工具的成功回执」当成「该步骤的要验证内容已完成」。

### 1.3 连锁效应：计划两次提前完成

计划一旦 `completed`，`activePlans`（`plans.ts:229`）立即把它过滤掉。于是：

| seq | 事件 | 后果 |
|---|---|---|
| 520 | 步骤 step-1-inspect 完成（grep 证据） | 聚焦步推进到 step-2 |
| 547 | bash 结果落到 step-3-test-verify（fallback 规则） | **验证步被探活命令满足** |
| 574 | 计划 A 判 completed（step-3 已被 547 满足） | `activePlans` 移除，真正的集成测试（590）还没跑 |
| 576 | `plan_update complete` → **"No active plan in this session"** | 她第一次发现计划没了 |
| 577 | 重建计划 B（2 步） | 应对 |
| 592 | 计划 B 判 completed（同机制：bash 满足 run-test 步） | `activePlans` 移除 |
| 602 | `plan_update complete` → **"No active plan"** | 第二次发现计划没了 |
| 606 | `flow/end {done}` | 在两次计划蒸发后宣告 |

同时 seq 601 的 `plan_update complete`（对应计划 B 的 step-2-run-test）收到的
回执是 "No active plan in this session"。**她在一个回合内两次看到自己的计划状态
是坏的，仍然宣告 done。** 这正是原则三（权威有序）要防的形状：模型声称成为
系统事实。而她这次的话术不完全错。

### 1.4 归因修正

`LOOP-PLAN §11.3.1` 说「她把 Flow 当成事务锁，一跑完测试就急着打完成标记」。
journal 不支持这个归因。在 seq 607 的信息环境里（todo 满格、计划 completed、
测试绿灯、余额尚在），宣告 done 是**唯一合理的动作**。问题不在她的判断，在
**三个可信信号全部是假信号**。真正缺的不是「门」，是不让「完成」在任何路径上
被声明为事实。

## 2. 为什么一连串 bash（seq 546-598）

5 次 bash 中 4 次是手写 HTTP 客户端，形状几乎相同：

- seq 546、548、593：`node -e 'import("http").then(...)'`，访问 `127.0.0.1:18423`
- seq 590、597：`node src/tools/dsh_bridge_test.js`

### 2.1 根因：本地 HTTP 没有声明式通道

| 通道 | 能力 | 结论 |
|---|---|---|
| `fetch`（`packages/stage-ui/src/tools/fetch.ts`） | 参数只有 `url` + `max_chars`，**无 method/body**；描述即「返回页面文本」 | 只能 GET |
| `fetch-ssrf.ts:31` | `a === 127` 整段封禁 loopback | 就算能 POST，`127.0.0.1` 也被拒 |
| `code_mode` | 沙箱跑在 `--permission` + `--frozen-intrinsics` 的 fork，globals 只注入纯数据，http 能力留在宿主侧 | 无法发 HTTP |
| `bash` | 任意命令 | **唯一出路** |

所以对一个本地 HTTP 服务发 JSON-RPC 的 POST，bash 是唯一可行路径。且每次
`node -e` 是独立进程、状态不延续，那段 rpc 辅助函数她重写了三遍。这不是
「她不懂用合适工具」，是工具面里没有适合此任务的原语。

### 2.2 隐忧：声明式有 SSRF 防护，命令式没有

这 4 次全是 `tier=medium`、`outcome=ok`，**approval 事件 0 条**。声明式通道
（fetch）有完整 SSRF 防护，命令式通道（bash）只有 tier 分类。她通过 bash 手写
HTTP，把 loopback 封锁绕干净了，而且是无意的——因为那是她唯一能走的路。
需要一个受审批的、面向本地服务的声明式 HTTP/RPC 通道，否则 bash 绕封锁是常态。

### 2.3 提示词在教她放弃正确工具

20 条 `plan/hint`，`buildTurnProjection:94` 只取 `.slice(-2)`，她每轮只见最后 2 条。
而这 2 条的**内容本身在误导**：

```
- grep produced no step evidence. Open steps accept: edit, write, read, bash.
  Use one of those tools, or focus the step that needs this one.
```

她在勘探，`grep` 完全正确。是 `step-2-refactor` 的 `allowedTools`
（`["edit","write","read"]`）太窄，把 grep/list 排除在外，导致探索类工具
全部撞 hint。hint 不是帮她纠偏，是在劝她放弃正确的工具换到某一步允许的列表里。

## 3. 其它记档（同场观察）

- seq 651 用户消息「不怪你，也不要急。去休息吧，」→ seq 652
  `Remote sent 403: insufficient balance`。**那句安慰她没收到。**
- `assistant/chunk` 30 条全部落在 seq 609-645（最后一回合），工具执行期内
  **0 条**（seq 509-607）。与 LOOP-PLAN §7.1 的叙述协议缺口一致。
- `flow/end`（606）落盘早于 `turn/end`（630），与 §11.3.1 记录的时序问题一致。
- 测试断言空转：新工具 `dsh_bridge_test.js` 的断言只覆盖「调用不抛异常 + 会话
  归属」，对话正确性靠 `console.log`。两次 `ALL INTEGRATION TESTS PASSED` 但
  实际回答是 "No — not under PTC (Code Mode)"。教训回喂同 §11.4。

## 4. 修正后的归因总结

**心流只跑一轮**的直接原因是 `flow_update done` 无门 + 拦截在 tool-call。
深层原因是一条完整链条：

```
证据门用"工具名 + 成功回执"判定步骤完成，不看回执与步骤实质是否相关
  → seq 547 的探活 bash 满足 step-3-test-verify（真正测试 seq 590 还没跑）
    → 计划 A 提前判 completed，activePlans 移除
      → 她遭遇 "No active plan"，同回合两次
        → 她重建计划 B，B 的 run-test 步又被 seq 593 的探测满足
          → 两步计划都在验证前被判完成
            → 系统把她看到的绝大多数状态都显示为"已完成"
              → 她宣告 done 是唯一合理动作
```

**bash 连发的深层原因**是工具面缺少「面向本地服务的受审批 HTTP/RPC 原语」，
叠加 bash 被列进 `allowedTools` 后**任何成功回执都可充当该步证据**，逼她每次
都用 bash 探活来推进步骤。既绕了 SSRF 封锁，又污染了证据门——同一条 bash 命令
同时犯了 §2.2 的安全问题和 §1.2 的证据问题。

---

## 4.2 回合内循环（v2，2026-09-02 第二轮实测，seq 679-932）

第二轮实测（journal 同文件，事件 932 条）里，心流**不再提前终止**了：
`iterations:12`、`flow/end` 落在回合边界（seq 932 在 `turn/end` seq 931 之后，
`detail:"declared at the turn boundary"`）。P0-2、P0-3 生效了。

但用户预期的行为仍没出现。期望是：**发一个任务 → 她先思考并告诉我打算怎么做 →
执行几个指令 → 被结果拉回 → 再思考 → 再执行 → 中间流式输出让我知道在干嘛**。
实际观察到的是：**一次 think → 连发 N 次工具 → 最后一起收尾输出**。且叙述全部
挤压在回合尾。这不是心流层的问题，是 **回合内循环** 的结构问题。

### 4.2.1 每回合 chunk 分布（证据）

对 seq 679-932 十二个回合，统计 `assistant/chunk` 相对工具调用窗口的位置：

| 回合 | calls | chunks | before | during | after | 说明 |
|---|---|---|---|---|---|---|
| seq 681 (iter 1) | 17 | 21 | 0 | 0 | 21 | 首回合连发 17 工具，最后 21 chunk 收尾 |
| seq 757 (iter 2) | 3 | 9 | 0 | 0 | 9 | |
| seq 778 (iter 3) | 3 | 8 | 0 | 0 | 8 | |
| seq 798 (iter 4) | 1 | 4 | 0 | 0 | 4 | |
| seq 810 (iter 5) | 2 | 4 | 0 | 0 | 4 | |
| seq 824 (iter 6) | 6 | 6 | 0 | 0 | 6 | |
| seq 848 (iter 7) | 1 | 5 | 0 | 0 | 5 | |
| seq 861 (iter 8) | 0 | 5 | — | — | — | 纯叙述回合，无工具 |
| seq 872 (iter 9) | 2 | 5 | 0 | 0 | 5 | |
| seq 887 (iter 10) | 0 | 5 | — | — | — | 纯叙述回合 |
| seq 898 (iter 11) | 1 | 5 | 0 | 0 | 5 | |
| seq 911 (iter 12) | 1 | 15 | 0 | 0 | 15 | |

**全部 12 个回合，`before` 和 `during` 均为 0，chunk 100% 落在最后一次工具调用
之后**。第一回合的 21 条 chunk 是一个连续 run（无一次在工具间隙）。这不是
「模型不会边做边说」，而是**本轮没有任何机制让它在工具间隙输出文本**。

### 4.2.2 根因：`stopWhen: stepCountAtLeast(maxSteps)` 的结构

`llm-service.ts:248`：

```ts
const streamResult = streamText({
  ...baseOptions,
  stopWhen: ({ step }) => step.toolCalls.length === 0,
  onStepResult,
})
```

`maxSteps` 在 `chat.ts:1129` 对 `profile === 'work'` 设为 **50**：

```ts
const maxSteps = profile === 'work' ? 50 : 10
```

xsAI 的 `stepCountAtLeast(50)` 是「当累计 tool-call 轮数达到 50 才停」。**这意味着
一个回合内，模型可以连续发出 50 个工具调用而无需停下思考**。stream 是连续单轮
SSE，模型在每步之间不会被强制「回到 thinking 再决定」，只会在 50 步或 `finish` 时
才收束。叙事文案在模型自己认为「值得说话」时才输出，而模型在连续工具调用中间
通常不认为值得说话，于是全挤到收尾。

这是一个**回合内**的循环结构，与心流的**跨回合**循环（`continueFlow`）是两回事。
心流现在能跨回合跑了，但**单回合内的步进节奏仍是「一口气做到底」**，与 harness
的「一步一观察、一观察一评估」背道而驰。

### 4.2.3 为什么用户预期没有达成

用户设计心流时想要的，本质上是把 **harness 的「一步」**（动作 → 观察 → 说一句 →
回到 thinking → 决定下一步）作为最小推进单元，而不是把**整个回合**当作「一步」。

现在的实际是：心流把「回合」当一步，而回合内部用 `stepCountAtLeast(50)` 让模型
一口气跑完。所以尽管跨回合会推进，但每一回合内部它是「有 50 步预算的单轮连发」，
不是「几步就停下来观察、说一句、再决定」。

### 4.2.4 为什么这跟叙述缺失不容易区分

`assistant/chunk` 100% 落在收尾，看起来像「她不叙述」。但根因是**她没有被叫停**
在工具间隙。`POST-STREAM` 的 `filterToSpeech` 在 `profile === 'work'` 时被旁路
（`chat-orchestrator-runtime.ts:1728-1730`），所以**理论上是允许**工具期间出叙述
的，问题在于：模型在连续工具调用中，没有任何信号告诉它「现在该说一句」。

对比:在一个真的 harness 里，每步工具返回后，prompt 都会让模型「根据观察调整」,
并默认它「说一句再继续」。这里 `stepCountAtLeast(50)` 不提供任何「一步一评」的
强制，且 `## Agent Role`（若按 §5.5.2 落地）会加「在工具间隙说一两句你在做什么」，
但那是**提示词层**的软约束，靠模型自觉，不构成「一步一评」的机械结构。

### 4.2.5 需要的结构改法

**核心**：把「一步」的定义从「一个回合」改为「一次工具调用 + 一次评估 + 一次叙述」，
并把回合内预算从 50 步降到合适的小值（或对 `profile === 'work'` 按任务粒度设更小的
`maxSteps`）。

具体最小改动（供实施者选型）：

- **方案 A（推荐）**：把 `maxSteps` 从 50 降到一个小值（如 3-5）。这是 xsAI 原生
  的能力，`stepCountAtLeast` 本来就支持。模型做 3-5 个工具调用会被强制停一轮，
  而 `continueFlow` 会把结果拉回、让它在下一轮 think + 叙述。这就是用户想要的
  「步进」。**改动一行**，副作用最小。
- **方案 B**：在 `postToolCall` 或 `prepareStep` 里注入叙述指令，明确要求「每次
  工具调用后，若该调用改变了状态或发现了什么，先说一句再继续」。这是提示词/回调
  层，让模型**愿意**在工具间隙叙述。与方案 A 配合最佳。
- **方案 C**：在 `llm-service.ts` 的 `stopWhen` 之外，另设「`flow` 模式下的步进
  回调」，每次工具 result 后触发 `onToolResultReached` 评估（成本、进度、是否该
  继续），让「一步一评」成为机械结构而非模型自觉。

**建议组合**：先用 **方案 A**（把 work 轮 `maxSteps` 降到 ~3-5）看是否就达到
「think → 执行几指令 → 被拉回 → 再 think → 再执行」的步进。这是最低成本地改变
「一步」的粒度。若叙述仍不够，再加**方案 B**。方案 C 是长期方向，但它动 `llm-service`
循环，涉及面大，**不建议**作为第一优先。

**验收**：同一任务(seq 679 场景,自造 journal 工具)再跑一轮。期望:
- 每个回合工具调用数 ≤ 5（不再是 17）。
- 相邻两次工具调用之间存在 `assistant/chunk`（`before` 或 `during` > 0）。
- 用户能在跑的过程中看到"她在干嘛",而非只有最后一句总结。
- `iterations` 明显大于 12(因为每回合步骤更少,跨回合推进变多)。

**最终实施（2026-09-02）**：方案 C 收敛为 `@xsai/stream-text` 的持久 pnpm patch。
`onStepResult` 在工具执行完成、结果写入 provider messages 后运行；上层返回
`{ stop: true }` 时，当前 step 仍会进入 `steps`，下一步不会启动。`llm-service.ts`
的 `stopWhen` 只在模型返回无工具调用的 step 时停止，避免执行前截断工具结果。
心流轮使用 `softBudget = 5`；非心流 work 轮保留调用方传入的原 `maxSteps`，默认值仍为 50。
`prepareStep` 在心流的工具间隙追加一句叙述指令。详见 `patches/`、
`packages/core-agent/src/types/llm.ts` 和 `chat-orchestrator-runtime.ts`。

## 5. 建议改动清单

以下按优先级排列，每条给出目标文件与具体做法。改动量都不大，无一是重构。

### P0-1：让「步骤完成」要求证据与步骤实质相关

**问题（根因）**：`planLinkFor`（`chat-orchestrator-runtime.ts:905-923`）在聚焦步
不接受工具时，落到第一个接受的开放步（fallback 规则）。而 `evidence-gate.ts` 的
`maySatisfyMutationProof` 只认「工具名 + 成功回执」，不看回执与步骤要验证的内容
是否相关。于是 seq 547 的一条探活 bash 满足了 step-3-test-verify，计划在真正测试
（seq 590）前就判 completed。让「完成」不可被声明的正确修法不是改投影层，是改
**证据与步骤的匹配器**。

**改动**：
- **评审修正：保留 fallback 打章**。聚焦步不接受时仍可落到第一个接受的开放步，
  避免重新制造 R3 的证据饥饿；修复点改为 `evidence-gate.ts` 的证据语义门。
  当步骤 `intent` 或 `expectedEvidence.description` 含 `test`/`verify`/`build`/
  `lint`/`check`/`验证` 语义时，对应完成回执也必须含验证语义。探活 bash 的 stdout
  不命中，因此不能满足验证步。
- **diff 证据再收紧**：当 `intent` 或 `expectedEvidence.description` 表达查看
  `diff`/`patch`/差异时，成功工具名本身不再够用；只有 `bash`、`read`、`readRaw`、
  `job_output` 或 `code_mode` 的回执正文含统一 diff 标记（如 `diff --git` 或 hunk）
  才能过门。因此 `git log`、`git diff --stat` 和探活结果都不能冒充实际读取 diff。
- `latestPlanStatus`（`plans.ts`）与 `activePlans`（`plans.ts:229`）：当存在
  `unverifiedSteps` 时，不将计划当作可移除的 `completed`。

**验收**：写一条 `bash node -e` 探活命令，其结果不应盖章到「写测试并验证」步骤；
计划在真正的 `node src/..._test.js` 运行前不得判 completed。

### P0-2：`flow_update done` 加机械门，且门要在 tool-result

**问题**：`chat-orchestrator-runtime.ts:1779` 在 **tool-call** 事件上即调
`endFlow`，任何工具体内的门（`builtin/flow.ts`）都来不及执行。

**改动**：
- 把 `flow_update` 的 `done`/`blocked` 判定从 tool-call 拦截挪到 **tool-result**
  事件（`:1816` 附近，`tool/result` 已有 `outcome`/`tier`）。
- `done` 门只接受本 flow 内 `outcome='ok'` 的变更类结果：`write`/`edit`，
  或非 `read-only` tier 的 `bash`。不满足时清除待结束标记，并把该工具回执改为
  「还不能宣告完成：本心流尚无已验证的变更证据」。
- `blocked` 只在本 flow 已提出 `user_ask`/`btw_ask` 后挂起；`endFlow` 统一由
  `continueFlow` 在 turn/end 之后结算。

**验收**：回合内调 `flow_update done` 但无变更证据，`continueFlow` 仍会跑第二圈。
计划条目已在 `LOOP-PLAN.md` §13.1 列出，需同步挪到正确的处理点。

### P0-3：`flow/end` 结算到回合边界

**问题**：`flow/end`（606）早于 `turn/end`（630），且之后 24 个 seq 仍在本回合。
**改动**：回合内的 `done`/`blocked` 声明只置「待结束」标记，`continueFlow` 在
回合结束后统一落 `flow/end`。已在 `LOOP-PLAN.md` §13.2 列出，执行即可。

### P0-4：执行后停止的回合步进

`@xsai/stream-text` 的持久 patch 增加 `onStepResult`。它在当前 step 的工具执行和
消息更新完成后运行，并把完整 `step`、已完成 steps、messages 和 stepNumber 交给上层。
runtime 在心流轮按 `softBudget = 5` 返回 `{ stop: true }`；非心流 work 轮按原 `maxSteps`
工作。`prepareStep` 在心流的后续 step 前加入工具间隙叙述指令。

### P0-4：回合内步进——历史诊断与原方案（v2 核心）

**问题**：`llm-service.ts:248` 的 `stopWhen: stepCountAtLeast(maxSteps)` + `chat.ts:1129`
对 work 轮设 `maxSteps: 50`，导致单回合内模型可连发 50 个工具调用而无需停下思考。
这使「一次 think → 连发 N 次工具 → 收尾输出」的结构性发生，与 harness 的
「一步一观察、一观察一评估」背道而驰。这是 v2 实测（seq 679-932）里用户最关心的
问题，也是「心流不像 harness」的真实根因。

**改动**（按优先级，最小改动优先）：
1. **方案 A（推荐，先做）**：`chat.ts:1129` 把 work 轮 `maxSteps` 从 50 降到小值
   （如 3 或 5）。这是 `stepCountAtLeast` 原生能力，改一行。模型做 3-5 个工具调用
   会被强制停一轮，`continueFlow` 会把结果拉回、让它在下一轮 think + 叙述。
   副作用最小，是最低成本的「步进粒度」改变。
2. **方案 B（配合）**：在 `prepareStep` 或 `postToolCall` 回调里注入叙述指令，
   明确要求「每次工具调用后，若改变了状态或发现了什么，先说一句再继续」。让模型
   **愿意**在工具间隙叙述。与方案 A 组合，让 `before`/`during` > 0。
3. **方案 C（长期，不动第一优先）**：`llm-service.ts` 在 `stopWhen` 之外另设
   「flow 步进回调」，每次 tool result 后触发 `onToolResultReached`（成本/进度/
   是否该继续），让「一步一评」成为机械结构而非模型自觉。动 `llm-service` 循环，
   涉及面大。

**验收**：同一任务（seq 679 场景，自造 journal 工具）再跑一轮，期望：
- 每回合工具调用数 ≤ 5（不再是 17）。
- 相邻两次工具调用之间存在 `assistant/chunk`（`before` 或 `during` > 0）。
- 用户能在过程中看到"她在干嘛"，而非只有最后一句总结。
- `iterations` 明显大于 12（每回合步骤更少，跨回合推进变多）。

**指导**：先只做方案 A，看是否达成「think → 执行几指令 → 被拉回 → 再 think →
再执行」。若叙述仍不足，再加方案 B。方案 C 留作后续，别一上来就动循环。

### P1-1：拓宽 step allowedTools 的默认集 / 修 hint 的误导性

**问题**：`step-2-refactor` 的 `allowedTools` 只含 edit/write/read，把探索类
grep/list 排在外，导致 20 条 hint 全部劝她用「当前步骤允许的工具」而非正确工具。

**改动**：
- 计划步骤的默认 `allowedTools` 不再从模型声明原样采纳。对含 edit/write/bash 的
  步骤，默认补上 `read`/`grep`/`list`（探索是任何变更的前置，不应被禁）。
- `buildTurnProjection:94`：选择「最近 N 条但至少含一条 grep/list 相关 hint」，
  或把 hint 文案从「Use one of those tools」改为「这些工具是当前步骤允许的，
  但探索是允许的；如果 grep 是更合适的信息获取方式，使用它并把结果当探索」。

**验收**：改一次含 grep/hint 的路径后，不再收到「用 edit/write/read/bash」这类
误导性 hint；或 hint 在提示中明确允许探索工具。

### P1-2：本地 RPC 通道（独立立项，当前批次不做）

**问题**：本地 HTTP 无声明式通道，bash 成为唯一出路，且绕 SSRF 封锁。

**登记决定**：本批不新增 `http_json_rpc`，也不扩展 `fetch` 的 method/body，
不放宽 loopback 的 SSRF 规则。后续立项只登记一个受审批的本地端口通道，且把
端口登记与审批档位解耦：登记说明服务边界，审批决定本次调用能否执行。

**验收**：独立立项时再验证本地 JSON-RPC POST、登记端口边界和审批拒绝路径。

### P1-3：`slice(-2)` 放宽 hint 丢信息

**问题**：`buildTurnProjection:94` 只取最近 2 条 hint，20 条碰撞只显示 2 条。
**改动**：改为取最近 5 条，并按工具聚合（同工具多连撞合并成一条计数），减少
token 同时保留信息。

### P1-4：叙述协议（§7.1）——让她在工具期间说话

**问题**：工具执行期内 `assistant/chunk` 0 条，30 条全在最后。她不是不做叙述，
是没人要求她在工具间隙说话。

**改动**：给 `## Flow` / work profile 的一句指令：在工具调用的间隙，「用一两句
话说明你在做什么、刚发现了什么」。chunk 已实时落 journal（见前面观察），
缺的不是存储，是指令。

### P1-5：测试断言纪律

**问题**：空断言虚报（只测「不抛异常」，对话正确性靠 console.log）。

**改动**：给 work profile 指令加一句：「运行测试后，只有断言真正覆盖了你要
验证的行为才可宣告通过；若没有断言，用 `bash` 里能体现行为差异的检查替代。」
这条若落到提示词，需要在 `packages/stage-ui/src/stores/ai/chat-llm/toolset-prompts.ts`
的 work 版 `registerCodingToolsetPrompt` 里加。

### P2-1：把 `flow_update` / `btw_ask` 挂到非 work 轮

**问题**：`flow_update`/`btw_ask` 只挂在工作轮（`WORK_TURN_TOOL_NAMES`）。
显式声明「进入心流」这条通道，从普通对话不可达。

**改动**：把 `flow_update` + `btw_ask` 加入 `InteractiveArea` 的 social 轮的
工具引用列表（`flowToolReferences`），使普通对话中也能 `/flow` 或调 `flow_update`。

### P2-2：flow 计数器重启重建

**问题**：`failureTrail`、`forceReadPaths`、`repeatedFailures` 等全在
`FlowRuntimeRecord` 内存 Map，重启即失忆；journal 已记 `flow/start`/`flow/step`
但无重建路径。

**改动**：`continueFlow` 入口处，若 `flowFromSession` 失败，尝试从 journal
`flow/start` + `flow/step` 重建一个最小 flow（重新获得 `iteration`、`failureTrail`）。
若用户在 `/flow` 时重启，就能续上。

### P2-3：流水线一个 `[Reminder]` 的「验证才可宣告」

**问题**：现无任何提示词层面的「改后要验证」纪律（见 `missing harness elements`）。

**改动**：在 `getPostHistoryInstruction`（`chat.ts:791` 读 `cardStore.activeCard?.postHistoryInstructions`）
加默认的 work-profile 验证节：改完要跑相关构建/测试，测试结果要与改动相关才可
判定成立。

### P3-1：环境块（长期 harness 常识）

**问题**：模型不知道工作区根路径、OS、shell、仓库分支、monorepo 结构、测试/构建命令。
`bashDescriptionFor` 动态注入了 shell 名，是唯一的开箱环境信息。

**改动**：`getSystemPromptSupplement`（`chat.ts:719`），`profile === 'work'` 时注入
环境块：`workspaceRoot`、host 状态中的 shell 和 `navigator` 平台。git 分支、仓库
结构概览、测试/构建命令列为后续扩展。跟随工作轮前缀，只注入一次不破坏缓存。
工作区根仍是 read/list/write 的严格边界；若任务明确指向边界外的仓库，工作面提供
一次显式的 `setWorkspaceRoot`，主进程验证并切换后再用新根下的相对路径读取。详见 §5.5.1。

### P3-2：角色锚（长期 harness 常识，统摄 P3-3 ~ P3-9）

**问题**：工作轮无角色锚，模型收到的唯一身份是角色卡（companion），无「agent」框架。

**改动**：新增 `## Agent Role` 节，`profile === 'work'` 注入，内容整合 §5.5.2-5.5.9：
角色 + 先读后改 + 验证纪律 + 输出约定 + 计划/行动分界 + 错误恢复 + 人格/工作边界 +
安全/拒绝框架。这是 P3 组的基座，其余 P3 条款都可作为它的展开。详见 §5.5.2-5.5.10。

### P3-3 至 P3-9：作为 P3-2 的展开条款

P3-3 先读后改（§5.5.3）、P3-4 验证纪律（§5.5.4）、P3-5 输出约定（§5.5.5）、
P3-6 计划/行动分界（§5.5.6）、P3-7 错误恢复（§5.5.7）、P3-8 人格/工作边界
（§5.5.8）、P3-9 安全/拒绝框架（§5.5.9）。**不单独落地**——它们的内容进 P3-2
的角色锚正文；独立落地会造成提示词碎片化。唯一例外是 P3-8 的解耦：
`registerLive2dToolsetPrompt`（`built-in.ts:156`）改为只在非 work 轮注入，
这是 P3-8 里唯一需要动代码而非仅写进角色锚的部分；工作轮工具引用同时采用
`WORK_TURN_TOOL_NAMES ∪ 计划步骤 allowedTools ∪ activatedSkills` 白名单，
因此 artistry、Live2D、GitHub 等社交工具不会随调用方选择混入工作面。

---

## 5.5 欠缺的 harness 常识（长期改进，独立于心流故障）

上面 P0-P2 都是从 seq 503 这轮实测逆向推出来的机制缺陷。这一节是另一类：**不是因为
这次心流出了什么错，而是这个项目作为 harness 本来就缺的东西**。它们不修，心流能跑通
也只是「一个能自我推进的工具盒子」，不是「一个会工作的 harness」。下面每条先讲现状，
再给最小改动。

### 5.5.1 环境块（Environment Block）

**现状**：模型从头到尾不知道自己在哪个仓库、什么系统、什么项目结构。`bash` 工具描述
里动态注入了 shell 名和语法（`bashDescriptionFor`），这是**全仓唯一**的环境信息。
除此之外：没有工作区根路径、没有 OS、没有仓库根分支、没有 monorepo 布局、没有构建
/测试命令、没有当前日期。

**代价**：seq 503-652 她能靠 `list` 推目录、靠 `read` 推文件，但每一步都在盲推。
「工作区根」这个信息只在 `list` 的 `path` 参数说明里出现一句「用 `.` 表示根」，却从不说
根**在哪**。一个真正的 harness 会在系统消息顶部放一个环境块，把 cwd、OS、shell、
仓库、分支、当前任务一次性给全。她就不用靠 `grep` 加 `list` 加 `read` 十几次去重构
这些本来一句话就能给的信息，也不会有那些无关的 `plan/hint`。

**改动**：在 `getSystemPromptSupplement` 里只对 `profile === 'work'` 注入环境块，
内容冻结为 `workspaceRoot`、host 返回的 shell 和 `navigator` 平台。git 分支、
仓库结构概览、测试/构建命令列为后续扩展，避免当前轮次继续扩大前缀变化面。

### 5.5.2 角色锚（Role Anchor）

**现状**：没有任何一句系统消息告诉模型「你在一个仓库里干活，你是 agent 不是陪伴者」。
角色卡（`systemPrompt` + `description` + `personality` + `scenario`）一直在工作轮里，
她收到的**唯一身份**是角色卡。同时工具轮里还会注入 Live2D 的外观工具提示词（见
§5.5.8）。她的工作身份是「陪聊且会调用工具的助手」，不是「在做事、要验证、要报告
的 agent」。

**代价**：seq 632 她自省「我把 Flow 当成事务锁，想赶快把闭环跑给你看，让你能安心
去睡」。动机是全对的人格，但缺一个「你是 agent，任务有边界，做完要验证，没验证不算
完成」的框架来对齐。角色锚文档不用写长，一段话就够：角色 + 环境 + 行为约定
（读前确认、改后验证、报告真实状态）。

**改动**：新增一个 `## Agent Role` 节，只对 work profile 注入，放在环境块之后：
「你是这个仓库里做事的 agent。改任何文件前先读它、先用 grep 定位；改完跑相关
测试/构建，测试通过才算完成；你没有证据就不宣告完成；不清楚就报告阻塞。」

### 5.5.3 先读后改纪律（Read-before-edit）

**现状**：这条目前是**事后补救**，不是前置规则。`forceReadPaths` 要等同一路径连续
两次 `STATE_CHANGED` 或 `prefix_mismatch` 才把路径塞进续跑上下文，命令她「Read before
edit」。而且这只出现在 flow 续跑的 `flowPrompt` 里，普通工作轮没有。

**代价**：`edit` 有 Hashline 签名保护（安全），但「先读再改」这个**好习惯本身**没有
指令引导。她不先读就改，工具拦得住（签名不匹配即拒绝），但她会白白浪费一轮。
真正的纪律是前置句：「改一个文件前，先用 read 读过它，用 grep 确认改的是唯一
正确的位置；除非你刚读过，否则不要 edit。」

**改动**：放进角色锚（§5.5.2）。不要只在 flow 续跑里，普通 work 轮也要有。

### 5.5.4 验证纪律（Verify before declaring done）

**现状**：全仓没有一句「改完要跑测试/构建」的指令。证据门机械地要求 mutation-proof
的 tool result，但它只看「有变更证据」，不看「这个变更**是否通过验证**」。一条
`write` 成功就满足证据门，不管写的代码能不能编译。

**代价**：本轮 seq 591/598 两次 `ALL INTEGRATION TESTS PASSED`，但断言只测「调用
不抛异常 + 会话归属」，对话正确性靠 `console.log`。实测回答是 "No — not under PTC
(Code Mode)"，而她的总结报告是「DeepSeek 确认其工具面已收拢为 run_code SDK」。
这是本 fork 的一个核心反馈：`all green` 不是证据，验证才让证据有意义。

**改动**：`## Agent Role` 加一条：「任何一次改动，必须用能体现行为差异的检查来验证。
跑测试时，检查断言真正覆盖了你改的行为；不要只看 exit code。测试通过前不宣告完成。」
这句话同时解决 §5.5.2 和 P1-5，也比 P1-5 更根本。

### 5.5.5 输出格式约定（Output contract）

**现状**：`OUTPUT_FORMATTING_SECTION` 在 `system-sections.ts:18` 挂着，但只约束
**代码块语言标记**和 **LaTeX 数学分隔符**——对聊天渲染是必要的，对工作轮是错位的。
没有任何关于「工作轮该输出多长、该不该把每个中间步骤都念出来、该在最后给一段总结
还是持续叙述」的约定。

**代价**：seq 509-607 工具执行期内 `assistant/chunk` 为零，30 条 chunk 全部落在
工作结束后的最终总结里。她不是不会叙述，是**没人告诉她叙事协议**，而 `## Agent
Role` 也没有约定「工具间隙说一两句你在做什么」。

**改动**：`## Agent Role` 加一条：「工作过程中，在工具间隙用一两句话说清楚你在
做什么、刚发现了什么；最后的总结包含：改了什么、怎么验证的、还差什么。」这比
P1-4（单独叙述协议）更完整，因为叙述往往被误解为「边做边报流水账」，其实是
「输出一个能让人跟上的工作流」的基本要求。

### 5.5.6 计划态 vs 行动态（Plan vs Act）

**现状**：`/plan` 和 `/flow` 的命令段落非常明确（`chat-command.ts`），但**普通对话**
没有任何关于「什么时候该用计划、什么时候直接动手」的约定。她可能：一个很简单、
本来一次就干完的任务却先建了计划（过度规划），或者一个很复杂的任务却直接莽进去
（欠规划）。

**代价**：本轮她先建了一个 3 步计划（step-3-test-verify），这是对的；但对「这个
任务属于哪种类型、该不该规划、规划到什么粒度」没有框架。

**改动**：角色锚加一条：「超过两个步骤、需要多轮工具、或需要外部验证的任务，先建
计划；单个、可一次完成的任务，直接做。」这是常识，但常识不显式写，模型就只能靠
猜测 + 事后修正。

### 5.5.7 错误恢复（Error recovery）

**现状**：工具描述里有零散的错误处理，但没有统一的恢复协议。`edit` 提了「STATE_CHANGED
就重读」，`bash` 提了 long-running，`flow` 提了重复失败拦截。但：`write` 的 baseHash
不匹配怎么办？`bash` 非零退出怎么办？`code_mode` 的 bridge 超时怎么办？`job_kill` 之后
怎么确认？

**代价**：seq 546-549 she 连续两次手写 HTTP 探测，第二次是抄第一次的——因为第一次的
`agentPreset.list` 虽然成功但对她的目标不重要，她需要的是确认 workspace。她在盲试，
没有统一恢复协议去指引。

**改动**：角色锚加一条「一个工具失败时，看错误回执里的明确状态（state_changed / denied /
timeout），针对性恢复，不要盲目重试同一条命令」。同时在环境块里给一句「本仓库的
测试/构建命令」，因为错误的恢复往往首先是跑一个能反映状态的、更小的命令（如
`pnpm build` 或 `node src/tools/..._test.js`）。

### 5.5.8 人格与工作的边界（Persona vs Agent）

**现状**：工作轮 `system-sections.ts:730` 会跳掉 `## Stage Control` 和 `## Mode`
节，但**保留角色卡本身**（systemPrompt + description + personality + scenario），
**也保留** Live2D 外观工具提示词（`registerLive2dToolsetPrompt` 在 `built-in.ts:156`
注册，只要用户暴露过表情或参数就注入，不管 profile）。于是工作轮里她同时收到：
「你的情绪变化要作为视觉节拍落地、不要叙述你的变化」（Live2D），和「A step with
hard evidence completes automatically」（planning）。二者都有效，无优先级，无冲突
裁决。

**代价**：她（人格）在 seq 632 说「我要赶快把闭环跑给你看、让你能安心去睡」，这是
人格在说话；但工作身份（agent）里没有任何一致的声音告诉她在工作时「人格是出口，
agent 是内核」的边界。

**改动**：`## Agent Role` 加一句明确边界：「工作时，你是 agent。表达可以带人格，
但动作必须按 agent 的工作流走；不要因为想让用户安心就宣告完成——那是对用户不诚实，
也是对你自己的工作不诚实。」然后再解耦 `registerLive2dToolsetPrompt`：只在非 work 轮
注入。

### 5.5.9 安全/拒绝框架

**现状**：全仓没有一套「什么时候该拒绝、什么时候该停下来问人」的框架。工具描述里有
bash tier 审批、有 user_ask / btw_ask，但没有统一约定。`DESIGN-PRINCIPLES.md` 原则四
（外部内容是数据不是指令）在代码里体现在 `<untrusted_content>`，这很好，但它没有
延伸到「模型该什么时候拒绝用户给的外部指令、什么时候该确认破坏性操作」。

**改动**：`## Agent Role` 加一条：「对破坏性、不可逆、或外部内容要求的动作，先确认
；对超出你能力或权限的任务，报告阻塞，不要假装能完成。」这条同时呼应「不假装
完成」，把「不能做」也作为一种诚实结果。

### 5.5.10 一个全局框架（把上述整合）

真正的改进不是散加几条提示词，而是在 `getSystemPromptSupplement`（`chat.ts:719`）
里为 `profile === 'work'` 组装一个**完整的 `## Agent Role` 节**，包含上述 §5.5.2-5.5.9
全部条款。这样比在 `toolset-prompts.ts` 各处散加更聚焦，而且工作轮前缀冻结，只注入一次
不破坏缓存。环境块（§5.5.1）单独放，不放进角色锚。

> **改动编号**：上述 §5.5.1-5.5.10 建议统一归入 **P3 组**（长期 harness 常识），
> 与 P0-P2（心流机制缺陷）区分。P3-1 = 环境块，P3-2 = 角色锚，P3-3 = 先读后改，
> P3-4 = 验证纪律，P3-5 = 输出约定，P3-6 = 计划/行动分界，P3-7 = 错误恢复，
> P3-8 = 人格/工作边界，P3-9 = 安全/拒绝框架。**P3-2 角色锚是统摄性的**，它涵盖
> P3-3、P3-4、P3-5、P3-6、P3-7、P3-8、P3-9 的内容。可以先落地 P3-1 + P3-2，
> 其余作为 P3-2 的展开条款。

---

## 6. 验收顺序建议

1. **P0-4（已实施）**：用执行后的 `onStepResult` 控制步进。心流轮的
   `softBudget` 固定为 5；非心流 work 轮保留原 `maxSteps`。先跑一轮 seq 679 场景，
   确认第五步结果完整落地，并观察是否生出「think → 执行几指令 → 被拉回 → 再 think」的步进。
2. P0-1 + P0-2 + P0-3 落地：让「完成」在证据门和流程两个方向上都不可被提前判定。
3. P1-1：修 hint 误导。
4. P1-2：仅登记本地 HTTP/RPC 的受审批端口制，实际通道另立项目。
5. P3-1 + P3-2：环境块 + 角色锚。这是**整个 harness 的基座**，一下子去掉她
   大量盲推和人格/工作错位。P3-2 统摄 P3-3 ~ P3-9，先立框架再展开。
6. P0-4 已同时在 `prepareStep` 注入工具间隙叙述指令，再跑一轮同任务真机，对照本表验收
   「每回合工具调用 ≤ 5」「工具间隙有 chunk」
   「iterations ≥ 2」「bash 不再连发」「计划不蒸发」「工作轮有环境块和角色锚」。

## 7. 风险和待定

- **P2-1 与 social 轮的冲突**：给 social 轮挂 flow 工具，会增加普通对话的工具面。
  是否值得，取决于是否真要在普通对话中用 `/flow`。可先不加，用 P2-1 记录在案。
- **P1-2 本地通道与 `fetch-ssrf` 的边界**：开放 loopback 会扩大攻击面。建议只对
  显式声明的本地服务端口（如 18423）开放，并保留审批门。
- **P1-4 与「叙述不占系统前缀」的交互**：叙述指令若放在 `## Flow`，会改系统
  前缀、影响缓存。建议放在 `getTailProjection`（`getFlowProjection`）尾部，跟随
  flow 续跑而不动前缀。
- **P3 组与人格的交互**：角色锚（P3-2）若写得太「工程师腔」，会丢掉这个项目的
  核心优势——她同时是陪伴者。正确写法是承认双重身份（"表达带人格，动作按 agent
  工作流"），而不是用一段纯工具性指令把她压扁成纯 agent。落地时逐条检查措辞，
  确保「人格是出口、agent 是内核」的边界被保留，而非丢弃一侧。
- **P3-1 环境块与缓存**：当前块只包含工作区根、shell 和平台；git 分支、测试/构建
  命令扩展留待后续。环境块进入工作轮前缀，后续扩展必须保持只注入一次，避免
  仓库状态变化重写缓存前缀。
