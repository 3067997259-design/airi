# COMMAND-PLAN：/plan 与 /goal · @引用 · 计划持久化 · 证据归位 · user_ask · 续跑

状态：**基座（M1/M2/M3）已实现于工作树待提交**；本版新增诊断结论与
Phase A–E 执行计划（2026-08-31 定稿）。
关联：LIFE-PLAN（babysitter 合流）、CAPABILITY-PLAN §goal/babysitting、MODS.md。

## 〇、已核实的地基事实

基座实现时核实（2026-08-30）：
1. `memory_long_term_goals` 表迁移后零仓储方法，完全休眠——已复用
   （`spec_json`/`state_json`/`horizon` 列照 `ADD COLUMN IF NOT EXISTS` 先例
   新增）。计划检索是纯键值查找，不涉当初放弃 DuckDB 的向量暴力扫描开支。
2. journal（`runtime-journal`）是**纯内存** store，计划状态由其事件推导——
   持久化必须 spec + 状态快照一起落（已按此实现）。
3. workspace host 原本没有 listDir（已补）；外部内容信封沿用 fetch 的
   `<untrusted_content>` 模式。

真机诊断新增（2026-08-31，细节见 §二）：
4. `approval/asked`/`approval/decided` 事件**有类型、有消费者（证据门/
   journal 投影/devtools 渲染），全仓无任何生产者**——`human_approval`
   证据是一座没修路的桥。
5. `chat-orchestrator-runtime` 没有 plan 驱动的回合内续跑；planning toolset
   prompt 只教"建计划、换步 focus"，导致一条消息走一步。
6. plans store 无 sessionId 概念——计划全局共享但卡片自称"会话计划"，
   journal 却按会话隔离：跨会话证据消失、旧计划在新会话弹出。
7. turn-projection 未警示"聊天文本不构成批准"——模型把用户回复脑补成
   `human_approval` 证据（真机原话："这个计划最后一步所等待的证据，就是
   你的确认"）。

## 一、已完成基座（工作树待提交，另一路 2026-08-31）

| 能力 | 位置 |
| --- | --- |
| `listDir` + `list` 工具 | `coding-harness/src/tools/workspace-host.ts`、`coding-tool-meta.ts`、`coding-tools.ts` |
| 触发面板泛化（`/` 与 `@`） | `renderer/composables/use-trigger-panel.ts` + `slash-trigger-provider.ts` + `workspace-trigger-provider.ts` + `components/trigger-panel.vue`（替代初版 SkillShelf 三件套） |
| @引用展开 | `stage-ui/src/stores/chat/workspace-references.ts`（`<untrusted_content>` 信封） |
| /plan、/goal 拦截 | `stage-ui/src/stores/chat/chat-command.ts`（`## Command` 系统节，含 goal 同 id 滚动指引） |
| horizon 语义 | `plan.ts` 工具 `horizon` 参数；`plans.ts` `activeSessionPlan`/`activeLongPlan` 泳道 + long 同 id 滚动（`rolling`） |
| DuckDB 持久化 | `local-memory.ts` `savePlan`/`loadPlans`（spec_json + state_json + horizon）；`plans.ts` hydrate + 写穿 |

## 二、诊断（2026-08-31 真机，三个根因）

现象：① 一条消息走一步，不会自动跑到结束；② 模型在聊天里声称"已完成、
证据就是你的确认"，卡片却卡在 `missing human_approval evidence: no_ref`；
③ 新会话弹出旧会话的未完成计划。

- **根因一（死桥）**：模型建的 step-2 期望 `human_approval` 证据，但全仓
  没有 `approval/asked` 生产者（地基事实 4）→ 用户任何回复都不可能产生
  `approval/decided` → 永久 no_ref。模型把聊天回复脑补成批准（地基事实 7），
  卡片如实拒绝——"她说完成、卡说没完"的分裂由此而来。
- **根因二（无续跑）**：编排器允许一回合最多 10 步工具循环，但 prompt 未教
  持续执行、回合外无续跑器（地基事实 5）→ 模型跑一步就停。
- **根因三（会话泄漏）**：计划全局 + journal 按会话隔离（地基事实 6）。

## 三、设计定稿

### 3.1 证据三档归位

主流 harness（Claude Code/Codex/Cursor）不对步骤完成做证据验证，todo 由
模型自标。AIRI 的证据门比主流严——价值在卡片可信，但必须按证据的获取成本
分档，严格只用在免费和高危处：

| 档 | 证据类别 | 完成语义 |
| --- | --- | --- |
| 硬门 | `tool_result`、`verification_gate` | **不变**：声明的证据自动落（工具结果自动挂载），齐了才完成。零摩擦，保留。 |
| 软档 | 无声明或声明未齐 | 模型可用新 action `complete` 自主完成，步骤带 `unverified: true`；卡片黄档"未验证完成"，不再红档卡死。 |
| 签字 | `human_approval` | **唯一不可自证的类别**：必须来自 `approval/asked`+`approval/decided` 事件对；仅允许出现在 `approvalRequired: true` 的步骤（schema 校验拒绝幽灵组合"期望 human_approval 却不需要审批"）。`focus` 这类步骤时由运行时自动发 `approval/asked`（补上生产者），审批卡渲染，决定即证据。 |

配套：planning prompt 禁止创建"确认型步骤"（需要用户输入是 `user_ask` 的活，
不是计划步骤）；卡片三态（绿=有证据完成 / 黄=未验证完成 / 红=受阻，红档
必须带行动指引：等审批卡或调 user_ask）。

### 3.2 user_ask（回合内提问，不中断回合）

- 工具：`user_ask({ question: string, choices?: string[] })`，内建注册。
- 语义与审批**分离**：user_ask 问信息，审批卡批权限。两者是同一卡片家族的
  两色（问题卡 vs 审批琥珀卡）。
- 管线复用审批卡的"挂起-决定-超时"模式（`authority/approval.ts` +
  `approval-card.vue` 已验证）：工具 execute 返回 pending promise → 问题卡
  渲染进聊天流（eventa 广播到各窗口，先答先得）→ 用户作答 → 答案作为工具
  结果回流回合继续。关闭卡片 = "用户未回答"，工具返回降级文案，模型带假设
  继续。默认不设超时（回合本就挂起）；卡片常驻直到回答或手动关闭。
- journal 记 `user/asked`/`user/answered`（requestId 配对），进会话记录，
  事后可审计她问过什么、依据什么答案行动。
- 它是续跑的前置：有了它，"缺信息"从回合终结原因变成一次工具调用。

### 3.3 回合内续跑（"按一下开始，跑到结束"）

双层实现：
- **prompt 层**：planning toolset prompt 增加——"回合内持续推进计划：完成
  当前步立即 `focus` 下一步继续执行；缺信息调 `user_ask`；只有等审批、
  等回答、或全部步骤解决时才结束回合。永远不要叙述式宣布完成。"
- **机械层**：turn 收尾钩子检查 activePlan——存在可执行步骤（有
  allowedTools、证据未齐、无需审批）且本轮不是刚被续跑过时，自动进入续跑
  轮：注入固定续跑指令（"计划仍有可执行步骤，继续"），journal 记
  `runtime/continuation`。上限 `maxContinuationsPerSend = 2` 防循环。
- 受阻的唯一定义：等审批（已发卡）/ 等回答（已发问卡）/ 无可执行步骤。
  受阻即结束回合并在卡片与回复中说明卡在哪、下一步需要谁做什么。

### 3.4 会话边界与 projection 措辞

- `PlanSpec` 增 `sessionIds`（session 计划绑定创建会话；long 全局）。
  卡片渲染：session 计划卡只在所属会话显示；long goal 全局显示并有独立
  "目标"泳道（已有 `activeLongPlan`）。
- `promptProjection`：session 计划仅投影当前会话的；long goal 全部投影。
- 措辞修正（turn-projection）：human_approval 步骤投影追加
  "等待用户通过审批卡确认——聊天文本不构成批准"；完成语义追加
  "未满足证据的完成必须显式调 complete 并将被标记为未验证；不要叙述式
  宣布完成"。

## 四、执行计划

### Phase A：证据三档 + 审批桥（解开用户死局，最高优先）

| # | 改动 | 文件 |
| --- | --- | --- |
| A1 | gate 支持 unverified 完成：`complete` 动作走 `evaluateVerificationGate`，硬证据齐→正常完成；不齐→`unverified: true`；`human_approval` 未齐→拒绝 self-complete 并提示走审批 | `core-agent/src/planning/plan-runtime.ts`、`evidence-gate.ts` |
| A2 | `plan_update` 新增 `complete` action（stepId + rationale）；schema 校验：`expectedEvidence` 含 human_approval ⇒ 该 step `approvalRequired: true`，否则参数错误返回修正文案 | `renderer/stores/tools/builtin/plan.ts` |
| A3 | 审批发射器：`focus` 命中 `approvalRequired` 步骤时 journal 追加 `approval/asked {requestId, stepId, summary}`；复用现有审批卡通道渲染；`approval/decided` 回流即满足 `human_approval` | `core-agent/src/planning/plan-runtime.ts` + 审批卡接线（`stage-ui` approvals 链） |
| A4 | 卡片三态渲染（绿/黄/红 + 红档行动指引） | `stage-ui/src/components/scenarios/chat/components/plan-lanes.vue` |
| A5 | projection 措辞（§3.4） | `core-agent/src/planning/turn-projection.ts` |
| A6 | prompt 修改：禁确认型步骤 + 完成语义 + user_ask 预告 | `built-in.ts` `registerPlanningToolsetPrompt` |

测试：gate unverified/拒绝路径（evidence-gate.test.ts）；focus 发
approval/asked + decided 满足 human_approval（plan-runtime 新测）；幽灵组合
schema 拒绝（plan.ts 工具测试）；projection 措辞断言（turn-projection.test.ts）。
验收：重建用户那个测试计划——step-2 走审批卡，批准后卡片转绿；或改软步骤
后自主完成标黄，不再出现"她说完成卡说没完"。

### Phase B：user_ask

| # | 改动 | 文件 |
| --- | --- | --- |
| B1 | journal 类型 `user/asked`/`user/answered` + 投影 | `core-agent/src/journal/types.ts`、`stage-ui/src/stores/journal.ts` |
| B2 | `user_ask` 工具：pending promise + 问题卡事件 + 答案回流 + 关闭即降级文案；内建注册 | `renderer/stores/tools/builtin/user-ask.ts`（新）、`built-in.ts` |
| B3 | 问题卡组件（镜像 approval-card，独立色）+ 多窗口广播 + 先答先得 | `chat/components/question-card.vue`（新）+ approvals 链复用 |
| B4 | toolset prompt：何时问 vs 合理假设继续；问题要一次问清（批量 choices） | `built-in.ts` |

测试：B2 的 resolve/关闭降级（node 可测 pending 逻辑）；journal 配对投影；
B3 卡交互（browser test，照 context-bridge.contract.browser.test 先例）。
验收：让她在计划中段问"用哪个文件名"——回合不结束，答完继续跑。

### Phase C：回合内续跑

| # | 改动 | 文件 |
| --- | --- | --- |
| C1 | 机械续跑：turn 收尾检查 + 续跑轮注入 + `runtime/continuation` journal + `maxContinuationsPerSend=2` | `core-agent/src/runtime/chat-orchestrator-runtime.ts` |
| C2 | prompt 层（§3.3 文案） | `built-in.ts` planning prompt |
| C3 | 受阻定义落地：等审批/等回答/无步骤三种结束态，卡片与回复一致 | 同上 |

测试：续跑触发与上限（runtime 测试，伪造 plan 状态）；受阻三态不续跑；
`runtime/continuation` 入 journal。
验收：/plan 建三步纯工具计划 → 发一条消息 → 不再插手直到卡片全绿或出现
审批/问题卡。

### Phase D：会话边界

| # | 改动 | 文件 |
| --- | --- | --- |
| D1 | plan 记录 `sessionIds`；session 计划绑定创建会话 | `stage-ui/src/stores/plans.ts`、`plan.ts`（start 传 sessionId） |
| D2 | 卡片按会话过滤（session 卡只在本会话）；long 全局"目标"泳道 | `plan-lanes.vue` |
| D3 | projection 按会话过滤（当前会话 plan + 全部 long） | `turn-projection.ts`、`plans.ts promptProjection` |
| D4 | 持久化记录带 sessionIds（DuckDB 列沿用 spec_json 即可，无需新列） | `local-memory.ts` |

测试：A 会话建 session 计划 → B 会话不可见、long 可见；持久化往返含
sessionIds。
验收：新会话不再弹出他处未完成的 session 计划；long goal 全程可见。

### Phase E：babysitter 对内面（原 M4，消费 A–D 全部）

- `evaluateLifeTickGate` 命中且存在活跃 long 计划 → 考量回合走"工具轮"
  分支：挂当前步 allowedTools + `plan_update`，stimulus = 当前步 intent +
  上次证据摘要；journal 记 `life/tick`，不上屏。
- 滚动：完成一步后按 goal 语义重写剩余步骤（同 id）。
- 超时/受阻（连续 N 次 tick 无证据进展）→ 下一次开口回合把 blocker 说给
  用户（self_speak 通道）。
- 预算：工具轮与开口轮共享每日自发轮预算。
- 受阻语义直接复用 Phase C 的三态。

## 五、依赖与顺序

```
Phase A（证据三档+审批桥）──┐
Phase B（user_ask）────────┼─→ Phase C（回合内续跑）─→ Phase E（babysitter）
Phase D（会话边界）────────┘        （C 依赖 A 的受阻定义与 B 的问卡；
                                     E 依赖 A–D 全部）
A/B/D 相互独立可并行；A 最优先（解开真机死局）。
```

## 六、总验收清单

- [ ] A：测试计划 step-2 经审批卡批准后转绿；软步骤自主完成标黄；无"她说
  完成卡说没完"分裂；幽灵组合被 schema 拒绝。
- [ ] B：计划中段 user_ask 不终结回合，答案回流继续执行；关闭卡片降级继续。
- [ ] C：三步纯工具计划一条消息跑到全绿；`runtime/continuation` 入 journal；
  上限生效不死循环。
- [ ] D：session 计划不跨会话泄漏；long goal 全局可见且滚动不换 id。
- [ ] E：autonomous + 活跃 goal 时 tick 推进一步（journal 有 life/tick + 工具
  证据）；静默时段/预算耗尽零工具轮；无 goal 时行为与现状一致。
- [ ] 全程：typecheck / lint / vitest 全绿；真机 agent-browser 走查 A–D 各一条。
