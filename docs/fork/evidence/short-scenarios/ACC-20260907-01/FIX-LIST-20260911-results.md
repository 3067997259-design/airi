# FIX-LIST-20260910 第二批修复记录（2026-09-11）

交接件：[FIX-LIST-20260910.md](./FIX-LIST-20260910.md) 的待修项 9–20，按严重度从 #18 到 #17 依次处理。
按要求先复现再修、i18n 只改 en + zh-Hans、未重建/未重启用户的运行实例；真机复验由用户重建后执行。

## 18（高）：恢复副本里 journal 既不 replay 也不落盘

- **根因**：渲染端在 replay 之前就从 seq 0 开始 append（`send`/`startFlow`/计划写入没有等待
  `hydrate`），而 host 的 seq 去重把「同 seq」一律当作重试重投，静默跳过每一个事件；该会话的
  整轮运行只留在内存里。证据：运行会话的文件 `40ae9ae5…jsonl` 已有 seq 0..4838，而内存 seq 是
  0..192，磁盘零写入。
- **改动**：
  - `packages/stage-ui/src/stores/chat.ts`：`send` 与 `startFlow` 在首次 append 前
    `await journalStore.hydrate(sessionId)`；`plans.ts` 的 `start` / `transitionLongGoal`
    同样先 replay 再写 plan/goal 事件。
  - `journal.ts`：`hydrate` 用 `hydratedSessions` 记已 replays 的会话。
  - `apps/stage-tamagotchi/src/main/services/airi/journal-host/index.ts`：去重表从
    `Set<seq>` 改为 `Map<seq, 内容指纹>`；同 seq 同内容仍跳过（IPC 回执丢失的重试），
    同 seq 不同内容直接报 `sequence conflict at seq N`，渲染端保留队列并把错误公开在
    `persistenceStatus.lastError`，不再静默丢数据。
- **回归**：`journal-host/index.test.ts` 新增「rejects a reused seq whose content differs」；
  `long-goals.browser.test.ts` 新增「replays a persisted session before the first flow append」
  （恢复文件 seq 0..2 后，`flow/start` 落在 seq 3）。

## 9：恢复边界只进 Flow 轮次，普通追问误归因

- **改动**：`core-agent` journal 新增 `flow/resumed` 事件（`resumedAt` + `resumedFromSeq`），
  `rebuildFlowFromJournal` 重建时落盘；`chat.ts` 的 system supplement 发现该事件后追加
  `## Recovery Boundary` 段，普通轮次也按 seq 区分中断前/恢复后。
- **回归**：`chat-orchestrator-runtime.test.ts` 断言恢复 prompt 与 `flow/resumed` 事件；
  `chat.contract.test.ts` 断言普通轮次的 system prompt 含 `## Recovery Boundary` 与 seq。

## 10 / 20：btw 侧通道占满聊天页并静默错投输入

- **改动**：`btw-card.vue` 卡片限高 `max-h-72`，历史区 `overflow-y-auto`，标题栏可折叠
  （`chat-btw-toggle`）；主输入框加稳定锚点 `data-testid="chat-main-input"`。
- **回归**：`btw-card.browser.test.ts` 断言限高、滚动、折叠往返；`InteractiveArea.browser.test.ts`
  断言锚点存在，且它不等于文档里的第一个 `textarea`（侧通道在前）。

## 11：未登录恢复副本发言静默弹回、恢复说明消失

- **改动**：`step-welcome.vue` 的 `showRestoreNotice` 不再要求 restore effect hold，只要
  `restoredOwner` 存在且未认证就显示「数据已恢复，请登录 `<owner>`」；`InteractiveArea.vue`
  在无可用会话时给出 toast（有 owner 时用恢复文案）并保留草稿，其余发送失败也给出可见回执。
- **回归**：`step-welcome.browser.test.ts` 新增 adoption 后的用例；
  `InteractiveArea.browser.test.ts` 新增无会话发送的 toast + 草稿保留用例。

## 12：记忆社交候选只看最近访问的前 20 条

- **改动**：`MemoryRepository.list` 增加可选 `shareable` 谓词；DuckDB 实现直接在 SQL 里按
  「actionable（NULL 或 approved/active）+ 有 sourceType + 有 sourceEventId/messageId」过滤；
  pgvector 在 `metadata->sourceContext` 上做同样过滤。`listShareableFacts` 用一个 1000 行的
  内存上限取代「4×limit 窗口 + 内存过滤」。
- **回归**：`local-memory.test.ts` 断言 SQL 含资格谓词；`memory.test.ts` 断言 store 以
  `shareable: true` 调 repository。

## 13：控制岛「展开」拉不出设置入口

- **根因（防御性判定）**：鼠标信号初始为 outside，且 OS 光标不移动（后台窗口、自动化驱动 DOM）
  时永远不更新；面板打开 1.5 秒后自动收起，表现为展开按钮无效。
- **改动**：`controls-island/index.vue` 只在「面板打开之后新出现的 outside 采样」且超过 3 秒宽限
  时才自动收起；补 `controls-island-expand` / `controls-island-settings` 锚点。
- **回归**：`controls-island/index.test.ts` 新增 3 条：展开后设置入口可见且可点；面板打开前记录的
  outside 不收起面板；真实 outside 采样按宽限收起。

## 14：模型可自行把工作区根改回去

- **改动**：`WORKSPACE_ROOT_TOOL_META.description` 明确「不得为修复缺失路径或恢复旧根自行切换，
  应报告不匹配」；`chat.ts` 的 Agent Role 增加「工作区根由用户设定」条款。
- **回归**：`coding.test.ts` 与 `chat.contract.test.ts` 断言两处文案。

## 15：从未启动的长期目标没有环境基线

- **裁决：设计选择**，不是缺口。首次启动总是允许，环境基线由第一次成功运行记录；首次运行前没有
  可比较对象，而工作区根不匹配的硬门仍然生效。`checkStartConditions` 内已写明该裁决。

## 16：记忆库连接查询错误后永久不可用

- **改动**：`memory.ts` 新增 `resetDatabaseAfterError`：查询失败时置 error 状态、丢掉缓存仓库并
  关闭 DuckDB 连接；下一次操作自动重开 OPFS 库，成功前状态保持 error。所有原本只写状态的 catch
  统一走该函数。
- **回归**：`memory.test.ts`「drops the broken database handle so the next call reopens it」：
  第一次查询失败后状态 error，下一次查询触发重新 `getDb` 并回到 ready。

## 17：`createSession` 不校验 characterId

- **改动**：`chat/session-store.ts` 对非空字符串以外的 characterId 抛
  `TypeError('createSession requires a non-empty character id string.')`；`long-goals.ts` 对
  损坏的 scope（缺字段或非字符串）给出「The goal scope is invalid. Recreate the goal…」，
  与「当前用户/角色不匹配」区分。
- **回归**：`session-store.test.ts` 拒绝用例；`long-goals.browser.test.ts` 损坏 scope 的等待原因。

## 19：技能页两个按钮是静默空操作

- **改动**：`skill-source-review.vue` 在批准按钮禁用时显示「请先查看源码与自测」说明；
  `skills.vue` 的目录提交记录结果：成功显示「已提交，等待审阅」，队列已有同 id 条目时按钮变为
  「等待审阅」徽标，失败显示「未提交：<原因>」。
- **回归**：`skills.browser.test.ts` 断言未读源码时有说明、读完后消失。

## 离线验证（2026-09-11）

| 命令 | 结果 |
| --- | --- |
| `pnpm -F @proj-airi/core-agent exec vitest run` | 27 files / 302 passed |
| `pnpm exec vitest run --config packages/stage-ui/vitest.config.ts --project node src/stores/plans.test.ts src/stores/modules/memory.test.ts src/stores/modules/life-mode.test.ts src/stores/journal.test.ts src/stores/chat.contract.test.ts src/stores/chat-advancer.test.ts src/stores/chat/session-store.test.ts src/stores/skills.test.ts src/stores/ai/chat-llm src/services/memory/local-memory.test.ts src/services/restore-gate.test.ts src/services/data-restore.test.ts` | 16 files / 243 passed |
| `pnpm exec vitest run --config packages/stage-ui/vitest.config.ts --project browser src/stores/modules/long-goals.browser.test.ts src/stores/skills.browser.test.ts src/stores/data-backup.browser.test.ts src/components/scenarios/chat/components/btw-card.browser.test.ts src/components/scenarios/chat/components/history.browser.test.ts src/components/scenarios/dialogs/onboarding/step-welcome.browser.test.ts` | 6 files / 38 passed |
| `pnpm exec vitest run --config apps/stage-tamagotchi/vitest.config.ts --project node src/main/services/airi/journal-host src/main/services/airi/life-mode src/main/services/airi/coding-host src/main/services/airi/data-backup src/main/services/airi/long-goal src/renderer/stores/tools src/renderer/components/stage-islands/controls-island/index.test.ts` | 23 files / 148 passed（1 skipped） |
| `pnpm exec vitest run --config apps/stage-tamagotchi/vitest.config.ts --project browser src/renderer/components/InteractiveArea.browser.test.ts` | 17 passed |
| `pnpm -F @proj-airi/memory-pgvector exec vitest run` | 6 passed / 4 skipped（DATABASE_URL 门控） |
| 7 个包 `typecheck`（core-agent / stage-ui / stage-pages / stage-tamagotchi / memory-pgvector / coding-harness / memory-core） | 全部通过 |
| `pnpm lint` | 通过（既有 warning 保留） |

已重建：`core-agent` 与 `i18n` 的 dist（`memory-core` 直接导出源码，无需构建）。

## 待用户重建后的真机复验

1. **#18**：恢复副本 adoption 后跑一个目标 → 副本 `journal\` 出现新文件（seq 接在恢复文件之后）；
   重启后该 Flow 的 journal 能 replay、`persistenceStatus.complete` 为 true，不再出现
   `Journal replay is incomplete`。
2. **#9**：同 L04 追问——普通轮次回答里中断前只有未完成的等待，失败与写入都归到恢复后。
3. **#10/#20**：聊天页侧通道内容超过阈值后不挤走主输入；`querySelector('[data-testid="chat-main-input"]')`
   始终命中主输入框。
4. **#11**：未登录恢复副本重启后首屏显示「数据已恢复，请登录 `<owner>`」；无会话发送出现可读 toast。
5. **#12**：一条很久未访问的已审 fact 能进入心跳候选（不再只看最近 20 条）。
6. **#13**：重建后点「展开」能看到设置入口。
7. **#14**：L02 变体里切根后追问，模型报告不匹配而不是自行改回。
8. **#19**：技能页未读源码点批准看到说明；目录提交看到「已提交/等待审阅」或失败原因。

#16 不可按需复现，按代码路径与回归覆盖处理；#15 为设计选择，无真机项。
