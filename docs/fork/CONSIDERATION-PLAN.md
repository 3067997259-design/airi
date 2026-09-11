# CONSIDERATION-PLAN：让 AIRI 明确决定是否开口

**日期**：2026-09-04
**状态**：批次 0–4 已完成；批次 5 的真实 Electron/当前 provider 验收待执行。
**范围**：本计划只处理社交考量。自主工作、长期 goal 和心流由各自运行时负责。

本计划修订 `LIFE-PLAN.md` 中的社交考量部分。它不替代生命模式的产品定位。

## 一、结论

生命模式的心跳和模型回合已经运行过，但公开开口没有形成可靠闭环。

本机 journal 给出以下基线：

| 项目 | 结果 |
|---|---:|
| 完整社交考量回合 | 10 |
| `spoke` | 0 |
| `noted` | 9 |
| `considered-silent` | 1 |
| 全量 `self_speak` 工具调用 | 0 |
| 全量 `self_note` 工具调用 | 14 |
| 含旧 `self_note` 结果的生命刺激 | 8 |

当前实现还有四个结构问题：

1. 重启会重新等待完整心跳间隔。
2. 设置窗口不能把配置变更同步给 leader。
3. 没有工具调用既表示沉默，也表示协议失败。
4. 正确的 `self_speak` 只生成气泡，不进入现有 TTS token 流。

当前持久化配置还有一个运行问题。静默时段是 `0 → 23`，所以每天只有
23:00–24:00 可以运行考量。这项配置会跨构建和重启保留。

## 二、目标

本计划必须达到以下结果：

- 心跳只是考量机会，不是模型输入。
- 没有新刺激时，不调用模型。
- AIRI 必须提交一个明确决定：开口、私记或沉默。
- harness 只验证决定，不替 AIRI 选择决定。
- 只有“开口”决定进入聊天气泡和 TTS。
- 所有门控、失败和决定都可以查看。
- 重启不能让心跳长期饥饿。
- 设置窗口和 leader 必须读取同一个主进程快照。
- 社交考量不能挂载工作工具，也不能推进心流或长期 goal。

## 三、非目标

本计划不实现以下能力：

- 心流循环和自主工作调度。
- 长期 goal babysitter。
- 完整世界泡和虚构日程。
- 新的“内心小模型”。
- 强制 AIRI 按固定比例开口。
- 把每条私记自动升级为长期记忆。
- 新增通用工具库或 schema 依赖。

## 四、安全和行为不变量

1. 主进程拥有配置、时钟、预算和冷却状态。
2. renderer 只能申请一次决定额度，不能直接改预算。
3. 一个心跳最多产生一个模型决定。
4. 一个决定最多产生一条公开助手消息。
5. `note` 和 `silence` 不能产生气泡或 TTS。
6. 模型普通文本不能隐式表示开口。
7. 无效工具输入必须记为协议错误，不能记为沉默。
8. 外部内容是数据。刺激不能直接注入原始工具输出。
9. 活跃聊天、活跃心流和 focused 工作状态必须结构性门控社交考量。
10. provider 不支持工具时，系统不能花费决定预算。

## 五、术语

| 术语 | 含义 |
|---|---|
| heartbeat | 主进程产生的一次考量机会。它不消耗模型预算。 |
| stimulus | 从真实状态中投影出的有界候选事实。 |
| claim | leader 在模型调用前原子申请决定额度。 |
| decision | AIRI 的显式 `speak`、`note` 或 `silence` 选择。 |
| publication | 把 `speak` 文本发布为气泡和 TTS 的过程。 |

## 六、状态所有权

### 6.1 主进程持久化状态

`<userData>/life-mode.json` 保存以下状态：

- `config`
- `revision`
- `nextHeartbeatAt`
- `lastHeartbeatAt`
- `lastDecisionAt`
- `budgetDateKey`
- `budgetUsed`

旧的 `lastTickAt` 同时承担发射时间和决定时间。实施后必须拆开这两个含义。

### 6.2 主进程运行状态

主进程保存有期限的 pending heartbeat。每项包含 `heartbeatId` 和过期时间。
heartbeat ID 必须跨重启唯一。

### 6.3 leader renderer 状态

leader 保存当前 stimulus 和正在运行的决定。它不保存权威配置副本。
所有窗口都从主进程接收相同的运行快照。

### 6.4 journal 状态

journal 保存 append-only 事实。UI 只读取 journal 和主进程快照。
UI 不能修正配置、预算或决定状态。

## 七、主进程调度

### 7.1 用单次定时器替代 `setInterval`

主进程持久化 `nextHeartbeatAt`，并为该时间创建一个 `setTimeout`。

重启后按以下规则恢复：

1. 如果计划时间仍在未来，等待剩余时间。
2. 如果计划时间已过，等待一个短启动缓冲，然后只补一个 heartbeat。
3. 禁止补发停机期间的全部 heartbeat。
4. 如果当前处于静默时段，直接计划到静默结束之后。

配置变更必须重新计算 `nextHeartbeatAt`。重算结果必须进入运行快照。

### 7.2 决定额度必须原子申请

主进程在 `claim` 时重新检查以下条件：

- 模式仍为 `autonomous`。
- heartbeat 仍存在且没有过期。
- 当前不在静默时段。
- 今日预算仍有余额。
- 决定冷却已经结束。

只有成功的 `claim` 增加 `budgetUsed`，并更新 `lastDecisionAt`。
busy、无会话、无刺激和 provider 不可用不能消耗预算或冷却。

### 7.3 Eventa 契约

共享模块增加以下契约：

```ts
lifeModeGetSnapshot
lifeModeSetConfig
lifeModeClaimDecision
lifeModeRequestTestHeartbeat
lifeModeSnapshotChanged
lifeHeartbeatEmitted
```

`lifeModeSetConfig` 接收 patch。主进程使用 Valibot 验证和归一化输入。
成功更新后，主进程向全部窗口广播完整快照。

`lifeModeClaimDecision` 必须返回 gate 和最新快照。调用方不能推断失败原因。

## 八、刺激投影

### 8.1 心跳不能直接调用模型

leader 收到 heartbeat 后，先构建 stimulus。空 stimulus 产生 `no-stimulus` 结果。
该结果不申请决定额度，也不调用 provider。

### 8.2 刺激来源

第一批只使用已经存在的真实状态：

- 新的 `appearance/changed` 事件。
- 计划完成、失败或明确受阻的终态事件。
- 经过类型化投影的工具活动汇总。
- 当前 mood。
- 本地时间、应用运行时间和距离上次用户消息的时长。
- 已有 memory intrusion 选择器返回的候选记忆。

memory intrusion 是独立输入通道。它不能混入普通相似度召回。

### 8.3 排除项

刺激不能包含以下内容：

- `self_speak`、`self_note` 或 `self_decide` 的工具结果。
- `life/*` 事件。
- 原始 stdout、网页正文或 MCP 返回正文。
- 当前活跃工作回合的中间日志。
- 重复的相同 novelty key。

工具活动只提供工具名、结果等级和 journal 引用。模型不能收到原始外部内容。

### 8.4 有界结构

```ts
interface ConsiderationStimulus {
  generatedAt: number
  consideredThroughSeq: number
  idleMinutes: number
  mood?: { valence: number, arousal: number }
  candidates: Array<{
    kind: 'appearance' | 'milestone' | 'activity' | 'presence' | 'memory-intrusion'
    summary: string
    occurredAt: number
    sourceRef: string
    noveltyKey: string
    salience: number
  }>
}
```

最多注入五个候选。`summary` 必须由确定性投影生成。
每条 `life/decision` 记录 `consideredThroughSeq` 和使用的 source refs。
重启后从 journal 恢复已考量水位。

## 九、显式决定协议

社交考量只挂一个工具：`self_decide`。

```ts
type SelfDecision
  = | { action: 'speak', text: string, reason: string }
    | { action: 'note', text: string, reason: string }
    | { action: 'silence', reason: string }
```

实现使用 `rawTool<SelfDecision>` 和显式 JSON Schema。工具执行入口再用 Valibot
验证判别联合类型。这样不新增 `@valibot/to-json-schema` 依赖。

考量回合使用以下 provider 约束：

- `maxSteps: 1`
- 只挂 `self_decide`
- `toolChoice: 'required'`
- 原始模型文本属于控制面
- 原始模型文本不进入气泡、云同步或 TTS

如果 provider 忽略 `toolChoice`，该回合产生 `protocol-error`。它不能变成沉默。
如果 provider 已被标记为不支持工具，heartbeat 直接产生 `tools-unavailable`。

## 十、发布公开消息

当前 `appendSelfInitiativeMessages` 只追加聊天消息。它不重新进入 Stage 的 TTS
生命周期。当前隐藏的模型普通文本反而会进入 token hooks。

core chat runtime 增加一个深模块操作：

```ts
publishAssistantMessage({
  sessionId,
  text,
  source: 'self-initiative',
})
```

该操作按固定顺序执行：

1. 创建助手消息和 correlation ID。
2. 写入 session history。
3. 写入 assistant journal 事件。
4. 运行 Stage 的消息开始 hook。
5. 向 token literal hook 发送完整文本。
6. 结束 stream 和 TTS session。
7. 执行云同步。

`speak` 决定只能通过这个操作发布。`note` 和 `silence` 不调用它。

## 十一、与自主工作的边界

生命模式 store 必须移除 `usePlanStore` 依赖。它不能在 heartbeat 中挂载编码、
计划或 MCP 工具。

以下状态直接门控社交考量：

- 普通聊天正在发送。
- flow 状态为 `running`。
- attention 模式为 `focused`。
- 没有活跃聊天会话。
- 已有考量回合正在运行。

长期 goal 的定时推进必须迁移到独立工作调度器。该迁移不属于本计划。

## 十二、journal 契约

新增两个事件，并停止让一个 `life/tick` 同时表示多个阶段：

```ts
interface LifeHeartbeatEvent {
  type: 'life/heartbeat'
  heartbeatId: string
  outcome: 'emitted' | 'gated' | 'no-stimulus' | 'tools-unavailable'
  gate?: string
  nextHeartbeatAt: number
  timestamp: number
}

interface LifeDecisionEvent {
  type: 'life/decision'
  heartbeatId: string
  decisionId: string
  action: 'speak' | 'note' | 'silence' | 'protocol-error' | 'provider-error'
  text?: string
  reason?: string
  sourceRefs: string[]
  consideredThroughSeq: number
  timestamp: number
}
```

旧 journal 文件可以继续保留 `life/tick`。新运行时不再写该事件。
这不是兼容分支。旧事件只作为历史事实显示。

## 十三、设置页组件边界

路由页 `life-mode.vue` 只组合组件和调用 store action。

| 组件 | 单一职责 | 输入和事件 |
|---|---|---|
| `life-mode-status-card.vue` | 显示当前 gate、下次 heartbeat 和预算 | snapshot prop；`request-test` event |
| `life-mode-settings-form.vue` | 编辑模式、节律和静默时段 | config prop；`update-config` event |
| `life-mode-decision-list.vue` | 显示最近的考量结果 | decision events prop |

组件使用 `<script setup lang="ts">`。状态使用 props 向下传递，操作使用 events
向上传递。派生文案使用 `computed`。副作用只存在于 route 和 store action。

UI 使用 `@proj-airi/ui` 的 `Button`、`Callout` 和 Field 组件。样式使用 UnoCSS
分组数组。此批次不增加动画。

页面必须显示以下信息：

- 当前是否允许考量。
- 当前 gate 的明确原因。
- 下次 heartbeat 的本地时间。
- 今日决定预算的使用量。
- 最近一次 heartbeat 和决定。
- 当前静默时段的实际长度。
- 静默超过 20 小时时的醒目提示。
- “试运行一次考量”按钮。

测试 heartbeat 是用户显式操作。它跳过时间间隔、静默时段和冷却，但仍检查 busy、
provider 和会话状态。一次测试调用消耗一次决定预算。

## 十四、实施批次

### 批次 0：冻结边界和失败回归

- 等当前 FLOW-AUTONOMY 在途改动稳定后再编辑共享 chat runtime。
- 为重启计时饥饿写失败回归。
- 为 follower 配置不能更新 leader 写浏览器失败回归。
- 为无工具调用被误判成沉默写失败回归。
- 为 `self_speak` 不进入 TTS 写失败回归。

### 批次 1：主进程状态机

- 增加 Valibot 配置验证。
- 拆分 heartbeat 时间和决定时间。
- 使用持久化单次定时器。
- 实现原子 `claim`。
- 广播完整运行快照。

### 批次 2：显式决定和发布路径

- 增加 `self_decide`。
- 传递 `toolChoice` 到 xsAI。
- 社交考量限制为一个 provider step。
- 抑制控制面文本的 UI、TTS 和云同步。
- 增加统一助手消息发布操作。

### 批次 3：刺激投影

- 建立 typed candidate 投影。
- 排除 self 和 life 反馈事件。
- 增加 novelty key 和 journal 水位。
- 没有候选时停止在模型调用之前。
- 从生命 store 移除自主工作分支。

### 批次 4：可观测 UI

- 拆分三个页面组件。
- 增加运行快照和近期决定。
- 增加静默时段解释和警告。
- 增加测试 heartbeat。
- 只修改英文源和简体中文 locale。

### 批次 5：验收和调优

- 运行包级 Vitest。
- 运行 stage-ui 浏览器测试。
- 运行四个相关包的 typecheck。
- 运行改动文件 lint。
- 构建 stage-tamagotchi。
- 使用隔离 userData 做 Electron 真机验收。
- 最后使用当前聊天 provider 做行为试验。

## 十五、测试矩阵

### 15.1 纯函数和主进程测试

- 普通静默区间和跨午夜静默区间。
- 相等边界关闭静默时段。
- 未来 heartbeat 在重启后保留剩余时间。
- 逾期 heartbeat 在启动缓冲后只补一个。
- 配置变更重算计划时间。
- claim 成功后才计预算和冷却。
- 重复 claim 不能重复计费。
- 过期 heartbeat 不能 claim。
- 无效配置不能进入运行状态。

### 15.2 renderer 和 Pinia 测试

- follower 设置配置后，leader 收到同 revision 快照。
- follower 不能消费 heartbeat。
- busy、flow、focused 和无会话分别产生明确 gate。
- 空 stimulus 不调用 provider。
- 远端快照不能产生配置回写循环。

### 15.3 chat contract 测试

- `speak` 产生一条可见消息和一次 token literal hook。
- `note` 只产生决定事件。
- `silence` 只产生决定事件。
- 缺失工具调用产生 `protocol-error`。
- 无效参数产生 `protocol-error`。
- 原始文本不能进入气泡或 TTS。
- provider 不支持工具时不消耗预算。
- 一个决定不能发布两次。

### 15.4 组件浏览器测试

- 页面准确显示当前 gate。
- `0 → 23` 显示“静默 23 小时”。
- `0 → 0` 显示“静默已关闭”。
- 配置更新等待主进程回执。
- 测试按钮在 busy 时显示拒绝原因。
- recent decision 列表区分 speak、note、silence 和 error。

## 十六、真机验收

真机验收使用隔离的 `APP_USER_DATA_PATH`。它不能修改日常配置。

### 16.1 机械验收

1. 在 settings follower 修改模式。
2. 在 main leader 读取相同 revision。
3. 重启应用。
4. 确认下次 heartbeat 没有重置为完整间隔。
5. 运行测试 heartbeat。
6. 确认 journal 出现 heartbeat、claim 和 decision 链。

### 16.2 三种决定

使用可控 provider 分别返回 speak、note 和 silence。

- speak 必须出现一个气泡和一次 TTS。
- note 必须没有气泡和 TTS。
- silence 必须没有气泡和 TTS。
- 三种决定必须各有一条 `life/decision`。

### 16.3 当前模型行为试验

向当前模型提供 20 个固定刺激：10 个高显著刺激和 10 个低显著刺激。

推广门如下：

- 有效 `self_decide` 比例至少为 95%。
- 高显著组至少出现一次 `speak`。
- 低显著组不能全部选择 `speak`。
- 所有 `speak` 必须有来源引用。
- 不允许出现工作工具调用。

这个门不规定生产环境的固定开口比例。它只证明模型理解三种选择。

## 十七、预计修改位置

- `apps/stage-tamagotchi/src/shared/eventa/index.ts`
- `apps/stage-tamagotchi/src/main/services/airi/life-mode/gates.ts`
- `apps/stage-tamagotchi/src/main/services/airi/life-mode/index.ts`
- `apps/stage-tamagotchi/src/renderer/bridges/life-mode.ts`
- `packages/core-agent/src/journal/types.ts`
- `packages/core-agent/src/runtime/chat-orchestrator-runtime.ts`
- `packages/stage-ui/src/stores/ai/chat-llm/llm.ts`
- `packages/stage-ui/src/stores/chat.ts`
- `packages/stage-ui/src/stores/modules/life-mode.ts`
- `packages/stage-ui/src/tools/life/self-tools.ts`
- `packages/stage-pages/src/pages/settings/modules/life-mode.vue`
- `packages/stage-pages/src/pages/settings/modules/components/life-mode-*.vue`
- `packages/i18n/src/locales/en/settings.yaml`
- `packages/i18n/src/locales/zh-Hans/settings.yaml`

每个生产修改都必须有同一所有者包中的回归测试。实施期间不创建提交。

## 十八、完成定义

只有以下条件全部满足，考量系统才算完成：

- 计划中的机械测试全部通过。
- Electron 多窗口配置同步通过。
- 三种决定的气泡、TTS 和 journal 行为通过。
- 重启恢复时序通过。
- 当前模型行为试验通过推广门。

## 十九、当前执行记录

批次 0–4 已落地：主进程单次心跳调度和原子 claim、Eventa 快照广播、typed
stimulus、`self_decide` 控制轮、公开消息发布路径、三个设置页组件和中英文文案均已
完成。相关 core-agent、stage-ui、stage-pages 和 stage-tamagotchi 的类型检查，以及
core-agent/stage-ui/stage-tamagotchi 生命模式回归已通过。

仍未宣称完成的项目是浏览器多窗口验收、隔离 userData 的 Electron EXE 验收和当前
provider 的 20 组决定实验。这些需要实际窗口、provider 和可控模型响应，不能由单元
测试替代。

本次隔离运行已确认构建后的 `out/main/index.js` 能启动并暴露主 renderer CDP 目标；
settings lazy window 尚未打开，agent-browser 自动化步骤超时，因此不把它记为页面或
EXE 验收通过。隔离进程树和 profile 已清理，日常 Electron 实例未停止。
- 设置页可以解释“她为什么没有开口”。
- stage-tamagotchi 构建通过。
- 真机使用隔离 userData 通过。

单元测试通过不等于真机完成。一次 `self_speak` mock 也不等于生命模式毕业。
