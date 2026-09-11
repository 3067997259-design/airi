# C 波次执行计划（MC-0b ∥ EP-1）

日期：2026-09-11。状态：计划定稿，实施未开始。

本文件给 [MC 执行计划](./minecraft-execution-plan.md) 的 MC-0b 与 [EP 执行计划](./extension-execution-plan.md) 的 EP-1 排列顺序与切入口，并列出 B 波次（EP-0 / CP-0 / MC-0a）完成时应跑的验收测试。契约细节：MC-0b 见 [MC-0b 规范](./mc-0b-spec.md)，EP-0 契约见 [EP-0 规范](./ep-0-spec.md)；本文件不重复。

## 一处修正：C 波次是两项，不是三项

此前把 P1-1（hint 误导）与 P1-3（hint 取条数）列为 C 波次工作，**这个估计是错的**——它们已经落地：

- P1-1 自动拓宽：`packages/stage-ui/src/stores/plans.ts:271-274` 已对含 edit/write/bash 的步骤补 `EXPLORATION_TOOL_NAMES`。
- P1-3 取条数：`packages/stage-ui/src/stores/plans.ts:1095` 的 `recentHints` 已收集全部 hint，不再 `slice(-2)`；`turn-projection.ts:112` 用 `findLast` 按工具去重。
- P1-1 文案：`turn-projection.ts:118` 的 hint 已改写为「Exploration tools are always available; their results do not count as evidence for this step. Keep exploring when that is the right move…」。

这是本对话第三次发现"计划列为待做、实际已落地"（前两次为 P3-1/P3-2 环境块与角色锚）。**C 波次因此为两项：MC-0b ∥ EP-1。**

## B 波次验收测试（本波入场门）

B 波次（EP-0 / CP-0 / MC-0a）完成、进入 C 波次之前，按下表验收。三批性质不同，测试策略也不同；混在一起跑会漏掉最要紧的那类。

### CP-0：证明"缺省等于上游"

纯加法批次，核心不是新功能测试，而是**证明没有改变任何既有行为**。

| 层面 | 测什么 |
| --- | --- |
| 类型 | `pnpm -F @proj-airi/plugin-protocol typecheck`；两个 announce 事件可携带 `forkProtocol` |
| 缺省等价（最要紧） | 选项缺席时发送载荷**不含该键**——字节级对照，不是"字段为 undefined" |
| 协商算法 | 四类各一单测：absent / exact / downgraded / 交集为空抛 `ProtocolVersionIncompatibleError` |
| 未知条目 | 对方 `extensions: ['future-x']` → 协商成功且结果只含交集 |
| 两路径一致 | 主路径与 `extension-peer` 路径对同一模块给相同结果 |
| 本地远程一致 | 本地 `ctx.modules.register` 与远程 announce 同结果 |
| 既有回归 | 既有 announce 测试**不改写**即通过（"纯加法"的机器证明） |
| 台账 | `capability-platform-compat.md` 五列齐全，预登记条目在 |

反模式检查：那个从未接线的 `module:compatibility:*` 事件对**必须保持不被接线**（C0-D2）。若实现方顺手接上，即为违规；检查方式是全仓 grep 该事件的发射与消费点，确认数量仍为零。

### EP-0：证明"行为等价"与"信任不上升"

这批是对信任层的重构，两类测试缺一不可，第一类更容易被漏。

**第一类：既有套件原样通过（等价基线）。** 迁移四条注册路径时这些必须不变绿：

- `packages/core-agent/src/authority/contract.test.ts`（权威表严格升序断言）
- `packages/core-agent/src/authority/provenance.test.ts`（证据作者映射）
- `packages/core-agent/src/authority/gate.test.ts`（含 `not_external_receipt` 三条）
- `packages/core-agent/src/planning/evidence-gate.test.ts`、`flow-completion.test.ts`
- `packages/stage-ui/src/stores/chat.contract.test.ts`

**第二类：有意的测试翻转（预期变红，改完说明是设计变更）。**

- `packages/stage-ui/src/stores/ai/chat-llm/tools.test.ts:54-69` 现断言**静默覆盖**，须改成断言抛 `DuplicateToolRegistrationError`。
- 两个 provider 测试以 spark 工具当 schema 夹具（`openrouter-ai/index.test.ts`、`azure-openai/index.test.ts`），MC-0a 删 spark 后会红，须换等价夹具。

若实现方报告"测试全绿"却没动这两处，说明它没有真正迁移。

**第三类：EP-0 规范的 7 条不变量测试**，其中最关键的是**包装不提升信任**：同一技能经插件包装后 `getToolEvidenceAuthor` 返回值与直调相同。缺此条则整批意义未被验证。

**第四类：完整取消链路。** 四段各有可跑回归，最少覆盖：注册项 abort 终止在途（MCP 走 requestId 通道、插件走 requestId 通道、沙箱走 signal → SIGKILL，三类各一），以及撤销后迟到回执 `outcome: 'revoked'` 且不进完成门。

### MC-0a：确定性脚本，不经 LLM

- **只读观测**（环境 A 与 B）：位置、背包、世界绑定、采集时间正确。
- **零工具面泄漏（不变量 1）**：对比 MC-0a 前后 `useLlmToolsStore.tools` 名字清单一致。最便宜也最容易漏。
- **非 loopback 拒绝**；**stdio 回归**（判别联合改造不破坏老路径）。
- **退役生效**：工具面无 `builtIn_emitSparkCommand`；广播 `spark:command` 无游戏副作用。
- **遗产 dormant**：设置页显示 offline 而非崩溃。
- **1.21.11 移植冒烟**：构建 + 只读观测通过，不推断全量兼容。

### 跨切面命令与已知坑

```
corepack pnpm lint                          # Windows 偶发退出码 3221225477，重跑即可
pnpm -F <affected> typecheck
pnpm -F @proj-airi/core-agent build         # core-agent 走 dist
pnpm -F @proj-airi/stage-tamagotchi build   # 真机验证前必须
```

三条本对话踩过的坑，执行时须留意：

1. **core-agent 与 i18n 走 dist**：改了不重建，运行态仍是旧逻辑。EP-0 改权威表尤其会踩。
2. **`pnpm type-check` 不存在**，真名是 `pnpm typecheck`（AGENTS.md 写错）。
3. **真机验证需重启应用**（活着的实例是旧 dist），且杀进程后立即重启可能静默绑不上 CDP 9250。

**只能真机验的**（按 fork 惯例记 PASS/FAIL/BLOCKED/NOT-RUN 加证明范围）：包装不提升信任的端到端观感、多窗口撤销一致、MCP/插件取消的实际终止、MC 双环境观测。

## MC-0b：执行契约

契约见 [MC-0b 规范](./mc-0b-spec.md)。本批横跨 Java（补丁 P1、P2）与 TS（game-host 命令注册表）。实施分四步，顺序由 M1-D1 决定：**TS 侧先于 Java 侧**，因为去重、租约、回执形状不依赖游戏，先做能快速暴露设计错误且不阻塞于 Java 构建。

1. **TS 命令注册表 + 状态机 + 去重（假执行器）**。落点：`apps/stage-tamagotchi/src/main/services/airi/game-host/`。用假执行器在无游戏环境下验证：去重（同键同摘要不重跑）、冲突拒绝、状态机转移、租约超时 → `expired`。**此步不需要 MC-0a 的 Java 环境**，可与 EP-1 并行。
2. **租约看门狗 + 终态回执 + 后置条件**。三类可计算后置条件（距离/采集/观测）各自断言。
3. **Java P1 断线清理**。四个触发条件（桥心跳丢失、退出世界、玩家死亡、断连）；验收线为两 tick 内清控，且不依赖 AIRI 再发请求。用"杀桥进程"验证。
4. **Java P2 导航租约与终态**。截止时间生效；**路径耗尽 ≠ 到达**（必须比对最终位置与目标距离）。用标记点与封闭目标夹具验证。

收口：桥接退出、回执丢失、旧世界命令拒绝三个场景。

## EP-1：固定适配器首闭环

前置**已就位**，可立即开工：

- **EP-0**（注册记录与证据桶）由 B 波次交付。
- **SG-1**（源码查看 + 哈希绑定批准）经核实已落地：`packages/stage-ui/src/components/scenarios/chat/components/skill-source-review.vue` 存在，`packages/stage-pages/src/pages/settings/modules/skills.vue:127` 渲染它，`packages/stage-ui/src/stores/skills.ts:342` 有 `contentHashOf(source) !== entry.contentHash` 的绑定校验。

实现形状（见 EP 计划）：适配器把一个已审阅技能暴露到插件工具面，注册为 `ownerKind: 'plugin'`、`execution.chain` 指向该技能、`execution.kind: 'coding_sandbox'`，执行委托 `executeSkill` 走 coding-host 沙箱。**适配器自身不新增执行信任**——这是 EP-0 不变量 1 在真实场景上的第一次检验。

七步闭环（勘探文档定义，逐项验收）：生成 → 自测 → 查看源码并批准（绑定哈希）→ 插件入口调用 → 查看执行日志 → 撤销 → 确认工具消失且在途调用终止。

## EP-1 适配器接口（补充契约）

EP-1 不单独出规范（七步闭环在 EP 计划、注册记录在 EP-0 规范）；此处只补适配器的接口契约，避免实现时自由发挥。

```ts
/** One adapter-exposed tool backed by a reviewed skill. */
export interface SkillAdapterTool {
  /** Model-facing name; unique against every other registered toolName. */
  toolName: string
  /** The reviewed skill this adapter delegates to. */
  skillToolId: string
  description: string
  /** Input schema derived from skill-forge validation. */
  inputSchema: Record<string, unknown>
}

/** Registration metadata the adapter supplies to the tool store. */
export interface SkillAdapterRegistration {
  ownerKind: 'plugin'
  /** Stable adapter id, distinct from the skill id. */
  ownerId: string
  execution: { kind: 'coding_sandbox', chain: string[] }
  /** Bound to the reviewed skill's content hash at registration time. */
  approvedContentHash: string
  tools: SkillAdapterTool[]
}
```

规则：

1. 适配器工具名不得与任何既有工具名冲突（EP-0 双键唯一）。
2. `approvedContentHash` 取注册时该技能的有效批准哈希；技能源码变化使哈希失效时，整链降级（EP-0 不变量 5）。
3. `execution.chain` 形如 `['plugin:<adapterId>', 'skill:<skillToolId>']`；证据在链最深处判定。
4. 适配器只暴露**已审阅**技能；`probation` 或哈希失效的技能不得进入工具面。
5. 撤销适配器注册时走 EP-0 撤销三步（撤工具面、终止在途、迟到回执标 `revoked`）。

## 排序与交错

| 起点 | 工作 | 说明 |
| --- | --- | --- |
| 立即 | MC-0b 步骤 1–2 | TS 侧，无 Java 依赖，快速闭环 |
| 立即 | EP-1 | 前置已就位；完成后给 CP-1 送去第一个消费者 |
| 环境就绪后 | MC-0b 步骤 3–4 | 需 MC-0a 的环境 A |
| 收口 | MC-0b 三场景 + EP-1 七步 | 留痕 |

两项并行且互不阻塞。**关键路径是 MC-0b 的 Java 补丁**（3–4 依赖环境与 Java 构建）；EP-1 是纯 TS，可先完成。MC-0b 步骤 1–2 与 EP-1 在同一时段内可交错推进。

## 下游解锁

- EP-1 完成 → 解锁 **CP-1** 的首个能力消费者（技能适配器）。
- MC-0b 完成 → 解锁 **MC-0c**（wave D，还需 EP-0，已在 B 完成）与 **MC-0d**。
- 因此 wave D = `MC-0c ∥ MC-0d ∥ CP-1`，CP-1 的消费者由 EP-1（技能适配器）与 MC-0c（game-host）自然送达。

## 风险与回退

- **MC-0b Java 补丁是 C 波次最重**：P1 的四条件清理与 P2 的"路径耗尽 ≠ 到达"需要读改 MCPFabric 控制代码。若补丁面积超出 P1/P2 量级，触发 MC 计划的 D1 退路评估（转最小自写桥，领域契约不变）。
- **EP-1 的哈希绑定依赖 SG-1 现状**：若审阅入口在实现期间有变动，重新核对 `skills.ts` 的哈希校验点。
- **环境依赖**：MC-0b 步骤 3–4 需要环境 A；环境未就绪时先推 TS 侧与 EP-1，不停摆。
- **不要串行等待**：TS 侧与 EP-1 先做完，再等 Java 环境；任一卡住不影响另一项。

## 与其他计划的关系

契约与验收细节：MC-0b 在 [mc-0b 规范](./mc-0b-spec.md)，EP-0 在 [EP-0 规范](./ep-0-spec.md)，EP-1 与 CP 建线在各自计划。B 波次入场门（本文第一节）验收通过后方进入 C 波次。

## 本轮交付与检查

本轮只新增本计划文档并更新 MODS.md 索引。未实现代码、未编写 Java、未运行游戏、未安装外部依赖。文中第三处修正（P1-1/P1-3 已落地）的依据为 `plans.ts:271-274,1095` 与 `turn-projection.ts:112,118`。代码锚点为 2026-09-11 工作区实际位置，行号漂移以符号名为准。
