# MQ-2 增量 1：空回答归因报告（2026-09-12）

范围：只读侦察 + 旧 scope 对照 + 当日实况采样；**不改产品策略**。原始 FAIL 记录保留在 [short-scenarios/ACC-20260907-01](./../short-scenarios/ACC-20260907-01/)（M01/M02/M04–M07）。

## 结论摘要

1. **主因是作用域漂移（scope drift），不是阈值**：2026-09-07 的 gold 事实写在 `userId: 'local'`；当前 `chat.memoryScope.userId = '3bXjSqeoKBQnOCCXBcudtmM8omc0xKxY'`（认证用户）。`retrieve()` 的 scope 过滤把这些 approved gold 全部挡掉。
   - 用旧 scope 直接检索，同一查询立即命中（M01 植物链 0.558–0.673、M04 识别词 0.526），证明"事实在、链路通、阈值不是挡点"。
2. **状态/角色漂移**：M05/M06 的当前 scope 事实是 `pending`（不参与召回）；其 approved 变体挂在 `characterId: 'default'`，与当前自定义角色不同 scope。
3. **工具回路与记忆链冲突（新发现）**：默认步数下 M01 当天实际回答为 **"……青石。"**——模型用 `grep/read` 从仓库证据文档里抓到**旧名**，而正确当前名（白帆）因作用域漂移不可召回。工作回合的工具面让模型"从文件里找记忆"，与记忆链形成错误来源竞争（原 M05 记录也写明"进入只读工具回路、无最终回答"）。
4. **空消息分支（机械层）**：采样中用 `maxSteps: 1` 时，模型把唯一一步用于工具调用，回合以 `content: ""` 的 assistant 消息结束（`slices=[tool-call]`，有 `tool_results`）。这是与"检索为空"独立的分支：**步数耗尽且最后一轮无文本时，UI 落一条空 assistant 消息**（原记录"user message persisted, assistant message was empty"与此一致或同源）。
5. **M07 不是记忆问题**：库内无任何对应 gold（工作完成态由 plan/journal 承载），查询零召回属预期；该场景要求的能力在计划/日志投影，不在记忆链。

## 逐案归因（R0–R6）

| 案 | 类别 | 证据 |
| --- | --- | --- |
| M01 | **R0 + R6** | 旧 scope 下 gold approved 且命中（`ba50c702`/`97f28111`，0.558/0.673）；当前 scope 命中的是**另一测试链**事实（`90673864` "白帆/紫杉"，M-REPAIR，0.538）；默认步数实况答"青石"（经 grep/read 取自证据文档） |
| M02 | **R0** | 纠正链 gold 同为 local scope（`97f28111` approved、`b8c48026` pending）；当前 scope 无同链事实 |
| M04 | **R0** | 松塔 gold approved 在 local scope（`4868b45a`，0.526 命中）；当前 scope 0 命中（海盐类事实属 default 角色，角色隔离本身正确） |
| M05 | **R0（状态+角色）** | 当前 scope 日程事实 `d378c628` 为 pending；approved 变体 `373fa743` 挂 `characterId: default`；旧 scope 亦 0 命中（查询未达阈值或版本差异）；原记录另含工具回路 |
| M06 | **R0（状态+角色）** | 纸条事实 `8a5b1efb` pending（当前 scope）；approved 变体 `f9f7ea3a` 挂 `default` |
| M07 | **R0（无 gold）** | 全库扫描无 ACC-20260907-01 工作完成态事实；应由 plan/journal 投影承担 |

补充：`maxSteps: 1` 的实验单独产生**空 assistant 消息**（机械分支，见结论 4），不计入 M01 的语义归因。

## 复现与证据

- gold 盘点：`memory.list('short_term'|'long_term')` 过滤 `青石|白帆|松塔|海盐|东门|西门|ACC-20260907|纸条` → 27 条；关键 id 与 scope 见上表。
- scope 对照：同一查询分别以 `{userId:'local',characterId:'n8cz_qXFxNLwpJmuAsfIl'}` 与当前 scope 调 `memory.retrieve`。
- 实况采样：新会话 `zIHTG8FXTfpbhZLaIIUsv`（默认步数）答"……青石。"，`grep`+`read` 各一轮；`35cBTpo-BKzV6RHIjhwHV`（`maxSteps:1`）落空消息。
- 清理：采样会话已删除（4 个）、采样产生的 1 条 pending 事实已移除、活动会话复位 `n1rlqFSVTzYSk1D9ViR4A`、主窗口回 `#/`。

## 对增量 2 的输入（待用户决策）

1. **旧作用域迁移政策**（需决策）：认证切换后 `userId: 'local'` 的历史事实如何处置——(a) 迁移/合并到当前认证 user（需 owning-package 迁移与冲突策略）；(b) 保留为只读历史、明确不可召回；(c) 按 profile 维度做显式“本地身份”绑定。
2. **gold 卫生**：M05/M06 的当前 scope 事实处于 pending；验收前需显式批准或重播夹具（不影响产品缺陷定性）。
3. **工具回路 vs 记忆**：工作回合中模型倾向 grep 仓库；需要（owner: chat runtime/prompt 或工具面策略）在事实类问题上优先记忆引用、或限制工作回路的证据文件对“记忆类问题”的误导（M01 的错答即由此产生）。
4. **空 assistant 消息语义**：步数耗尽且最后一轮无文本时应给可显示的降级文案或自动续一轮（owner: chat runtime/UI），不得留下空消息。
5. **M07**：接计划/日志投影到回答链路（非记忆改动）。
6. **阈值/表示**：本批六案的主因不是阈值；MC-1b 语义改写零召回仍作为独立表示问题留待 MQ-2 增量 2 的对照评估（含 `normalizeMemoryRetrievalQuery` 240 截断回归）。
