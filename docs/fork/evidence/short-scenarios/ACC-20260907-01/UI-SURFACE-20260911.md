# UI-SURFACE 批次记录（2026-09-11）：跨会话计划卡堆积、归属、计划中心、输入位状态

对应设计：[UI-SURFACE-PLAN](../../UI-SURFACE-PLAN.md)。本文件记录 UI-2（归属与归档）、
UI-3（窗口能力与可解释拒绝）、UI-4（输入位不可用状态）与 UI-1 剩余部分（辅助表面预算）
的落地内容、验证命令与遗留项。

## 1. 触发缺陷：跨 session 长期目标卡堆积

用户截图：聊天窗里数十张 `长期目标` 卡（已完成 / 已取消）长期停留在时间线，
把正文与输入框挤出视口。根因：

- `InteractiveArea` 只按 `horizon === 'long' || !sessionId || sessionId === 当前` 过滤，
  **不看状态**；`history.vue` 只要 `plans.length > 0` 就注入一个 `plan-group` 条目。
- 已结束/已取消的 long 目标不删除、不归档，于是每次会话都重新渲染整堆卡片。

修复口径按不变量 5/6：

- 新增纯函数 `planSurfaceLane(plan, sessionId)` 与 `planSurfaceLanes(plans, sessionId)`
  （`packages/stage-ui/src/stores/plans.ts`）：
  `current` / `other-session` / `unattributed` / `archived`。
- 时间线只收 `current` + `unattributed`；`other-session` 与 `archived` 进入计划中心。
- `archived` 只改变显示位置：卡片的步骤、证据、未验证标记仍完整保留。

### 1b. agent-browser 验收追加发现（2026-09-11）

用 agent-browser 连着真实 profile 走查时发现同类堆积还有第二形态：切到一个历史会话后，
计划中心显示 `活动 20 待处理 1 历史 29`，其中 19 张 `current` 卡里 9 张是**同会话里被更新
计划取代的 pending 会话计划**、9 张是**已完成但没有验证步骤的计划**。它们都按旧口径留在
活动面，聊天正文仍可能堆卡。追加口径：

- `completed`（无论是否未验证）一律归 `archived`：正文只展示活动工作（不变量 5），
  未验证状态不外移——卡片保留琥珀色 `未验证` 标记，计划中心收起条新增 `待验证 N` 计数，
  不把未验证完成当作干净成功（不变量 6）。
- `planSurfaceLanes` 实施车道取代：每个会话的会话车道只有一个 standing 计划，
  更早的会话计划归 `archived`（与 `selectFlowCompletionPlans` 的取代定义一致），
  记录仍可在计划中心历史中查看。
- 追加修复：补 `stage.chat.plan.status.paused` 文案（验收截图里曾显示裸 key）。

## 2. UI-2　归属、来源与归档

- `plan-center.vue`（新增，`packages/stage-ui/src/components/scenarios/chat/components/`）：
  默认收起的全局入口，显示 `活动 N · 待处理 N · 历史 N` 计数；展开后按
  `当前会话` / `其它会话` / `未归属` / `历史` 分区，复用 `plan-card.vue`。
- 其它会话的 long 目标带 `打开 {会话}` 按钮，点击切换到来源会话；会话已删除时给出
  toast 拒绝理由（`sessions-drawer` 之外不再有静默点击）。
- `plan-lanes.vue` 增加 `未归属` 分区，不再把无 `sessionId` 的计划混进当前会话。
- 归档卡片保留全部内容与 `run-now`（调度器对终止目标走显式修订），只在展开时可见。
- 会话检索（UI-G）：`sessions-dialog.vue` 增加 `data-testid="sessions-search"` 输入；
  `sessions-drawer.vue` 按标题、预览、sessionId 与最近 100 条消息文本过滤；空结果有
  专用文案；关闭抽屉时清空检索词。

## 3. UI-3　窗口能力与可解释拒绝

- `RendererWindowContext` 增加只读派生字段 `capabilities.stage`
  （`leader-only && full`，即主窗）；聊天窗（minimal）声明 `stage: false`。
- Live2D 工具（`expression-tools.ts`）在无模型时不再返回
  `No Live2D model is currently loaded.`，改为说明：舞台窗口没有模型 / 应打开主窗、
  加载模型并保持舞台路由；聊天专用窗口无法显示表情。
- UI-H 的验收映射：主窗切到 `#/chat` 后调用 `expression_set` 得到可解释拒绝。

## 4. UI-4　输入位不可用状态

- `InteractiveArea.vue` 在发送前计算 `composerBlock`：
  - 无会话：显示 `no-active-session`（恢复副本用 `no-active-session-restored` 带 owner）。
  - 无 provider/model：显示 `no-provider` 并提供「打开设置」按钮，
    经 `electronOpenSettings` 打开 `#/settings/providers`。
  - 两种状态都禁用主输入框；会话在输入后消失的竞态仍走 toast。
- 工作区不匹配继续由 long 目标卡上的 `waitReason` 呈现（既有行为）。

## 5. UI-1 剩余部分　辅助表面预算

- `InteractiveArea.vue` 把 `问题卡 + 侧通道 + 计划中心` 收进
  `data-testid="chat-auxiliary-surfaces"`，`max-h-[40%] overflow-y-auto`，
  正文与输入位始终在视口内；展开/折叠仍是窗口局部状态。

**agent-browser 真机验收（2026-09-11，重建后）**：

- 聊天窗（follower, minimal）打开与刷新：时间线只剩活动卡；计划中心条显示
  `活动 1 · 待验证 9 · 历史 48`（堆积会话），刷新后计数不变。
- 切换会话：原堆积会话的时间线无卡片；其它会话的 paused 长期目标进入 `其它会话` 分区，
  来源按钮点击可切回原会话；历史分区可展开查看被取代/已完成的卡片。
- 未验证状态：收起条 `待验证 9`，历史卡片带琥珀色 `未验证` 旗标（DOM 计数 13 处含非
  completed 记录），完成为 0 不再读作干净成功。
- `已暂停` 状态文案正常（此前显示裸 key）。
- 走查截图：`ui-acceptance-20260911/01`–`13`（01 堆积会话时间线、02 计划中心、03 历史、
  04 会话检索、05 切换会话、07–12 修复后同一会话、13 来源跳转返回）。

## 6. 验证

- `pnpm -F @proj-airi/stage-ui exec vitest run --project node src/stores/plans.test.ts`
  → 49 passed（新增 7 条 `planSurfaceLane`/`planSurfaceLanes` 回归）。
- `pnpm -F @proj-airi/stage-ui exec vitest run --project browser
  src/components/scenarios/chat/components/plan-center.browser.test.ts` → 5 passed。
- `pnpm -F @proj-airi/stage-tamagotchi exec vitest run --project browser
  src/renderer/components/InteractiveArea.browser.test.ts` → 19 passed（新增堆积回归、
  无会话/无 provider 输入位回归）。
- `pnpm -F @proj-airi/stage-ui-live2d exec vitest run src/tools/expression-tools.test.ts`
  → 6 passed（新增可解释拒绝回归）。
- `pnpm -F @proj-airi/stage-tamagotchi exec vitest run --project node
  src/renderer/window-context.test.ts` → 6 passed。
- `pnpm -F @proj-airi/i18n test` → 20 passed（重建 dist 后）。
- 全量回归：stage-ui / stage-tamagotchi / stage-ui-live2d / i18n 测试、相关包 typecheck
  与根 lint（见 MODS.md 批次记录的命令与计数）。

**环境基线（非本批回归）**：

- stage-ui 全量 browser 套件里 `sessions-dialog.browser.test.ts` 会 15 s 超时；
  单文件与小组件批次运行通过。已用 HEAD 版本的 `sessions-dialog.vue` / `sessions-drawer.vue`
  复跑全量，同样失败，确认与本次改动无关。
- stage-tamagotchi node 全量里 `plugins/index.test.ts` 与 `static-assets/paths.test.ts`
  共 4 条失败：3 条是 Windows 无 symlink 权限（EPERM），1 条是路径分隔符断言；均与 UI 无关。
- stage-ui node 全量 146 files / 969 passed。

## 7. 遗留

- **真机复验已完成（2026-09-11）**，见上节截图索引。仍未覆盖：窄窗口下辅助区 40% 预算的
  观感、聊天窗无 provider / 无会话禁用状态的实机走查（自动化回归已覆盖）。
- UI-1 的「侧通道与主输入不同时接受回车」按「焦点决定归属 + `chat-main-input` 锚点」
  处理；如需严格互斥，需再定交互（例如侧通道改 Ctrl+Enter），本轮未改。
- UI-3 只做能力声明与可解释拒绝，未按能力在 leader 侧裁剪工具注册表。
