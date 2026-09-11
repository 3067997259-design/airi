# FIX-LIST-20260910 修复记录（2026-09-10）

交接件：[FIX-LIST-20260910.md](./FIX-LIST-20260910.md)。本轮修 1–7，8 登记为非缺陷。
按要求未重建、未重启用户的 Electron 实例；真机复验由用户重建后执行。

## 1. 纠正后的有效事实进不了记忆候选

- **根因**：`reviseFact` 调 `persistExtractions(..., undefined, revisionScope)`，修订片段没有
  `sourceContext`，`listShareableFacts` 与 `projectMemoryCandidate` 的来源门永久过滤它。
- **改动**：`packages/stage-ui/src/stores/modules/memory.ts` —— 修订片段继承被替换事实的
  `sourceContext`（`copyMemorySourceContext(current.sourceContext)`）。
- **回归**：`memory.test.ts`「inherits the replaced fact source so an approved revision can be
  shared」断言 insert 携带来源，且批准后新片段在 `listShareableFacts`、旧片段不在。

## 2. `life-mode.json` 解析失败静默回落默认值

- **根因**：解析/schema 失败只 `return undefined`，无日志；默认值随第一次 `persist()` 覆盖原文件。
- **改动**：`apps/stage-tamagotchi/src/main/services/airi/life-mode/index.ts` —— 失败时
  `console.warn`（原因 + 路径）并保留 `life-mode.json.corrupt-<ts>` 副本；`writePersistedLifeMode`
  改临时文件 + `rename` 原子写，失败清理临时文件。
- **回归**：`life-mode/index.test.ts`「preserves an unreadable snapshot …」断言默认回落、日志、
  `.corrupt-*` 副本、无 `.tmp` 残留。

## 3. R06：`update` 先于 `insert` 时静默丢数据

- **根因**：尚未晋升的短期待审事实也排 `update`；远端 0 行被当成功，队列清空但镜像缺失。
- **改动**：`memory.ts` —— `update()` 只在 `result.memoryType === 'long_term'` 时排镜像更新；
  `setReviewStatus` 同样只对已晋升的目标排 update，被取代的旧 fact 仅在其本身为 `long_term` 时排；
  `convertMuscleToFact` 不再排 update（muscle/短期待晋升）。晋升时 `enqueueLongTermSync` 的 insert
  携带最终 review/fact 状态。
- **回归**：`memory.test.ts` 新增「short-term 不排 update/不调 host」「long-term 排 update 并投递」
  与「修订批准只更新被取代的长时事实」；肌肉转换测试改为断言 outbox 为空。

## 4. L04：恢复叙述把恢复后动作说成中断前证据

- **根因**：恢复后的迭代 prompt 没有中断边界信息，模型把恢复检查、写入、重跑等待归到中断前。
- **改动**：`packages/core-agent/src/runtime/chat-orchestrator-runtime.ts` ——
  `rebuildFlowFromJournal` 在 `FlowRuntimeRecord` 记录 `resumedAt` 与 `resumedFromSeq`
  （重建窗口最后一条事件的 seq）；`flowPrompt` 每轮注入 `[Recovery boundary]`，要求按 seq 边界归因。
- **回归**：`chat-orchestrator-runtime.test.ts`「marks the recovery boundary in the resumed flow
  prompt」断言 prompt 含 `[Recovery boundary]`、`seq 7`、`recovery action`。

## 5. 构建版 grep 永远走 Node 兜底（方案 a）

- **根因**：`@vscode/ripgrep` 被打进主进程 chunk，运行时 `createRequire` 从 `out/main` 看不到平台包。
- **改动**：`apps/stage-tamagotchi/package.json` 增加 `@vscode/ripgrep`（catalog）；
  `electron.vite.config.ts` 的 `externalizeDeps.include` 显式外部化它；`pnpm-lock.yaml` 已更新。
  `electron-builder.config.ts` 已有 `@vscode/ripgrep*` 的 `asarUnpack`，打包路径沿用既有重定向。
- **回归**：`coding-host/grep-search.test.ts` 从 app 运行上下文 `import('@vscode/ripgrep')`，断言
  `rgPath` 存在且文件可见（修复前 app 不声明依赖，解析失败）。
- **待补**：重建后真机 grep 断言 `degradedReason` 为空（本机未执行应用构建）。

## 6. 渲染端门对 follower 窗口不可见

- **根因**：`recordLocalGate` 只改 leader 本地快照；follower 设置页只读主进程快照。
- **改动**：`shared/eventa` 新增 `lifeModeRecordGate` invoke；主进程 handler 更新 `lastGate`、
  持久化并广播；`LifeModePort` 增加可选 `recordGate`，`recordLocalGate` 回写；Electron 桥接注入。
- **回归**：主进程「mirrors a renderer-decided gate into the shared snapshot」（含持久化），
  渲染端 `life-mode.test.ts` 断言 `tools-unavailable` 门调用 `recordGate` 并应用返回快照。

## 7. 活动类候选没有年龄信息

- **根因**：`tool/result`、`plan/update`、`task/update` 的 `occurredAt` 一律 `0`，永不进入
  `stale-stimulus`，新鲜度判断完全交给模型。
- **改动**：`packages/core-agent/src/journal/types.ts` 为三类事件补可选 `timestamp`；
  `packages/stage-ui/src/stores/journal.ts` 的 `append` 为缺时间戳的活动事件记录 `Date.now()`；
  `life-mode.ts` 用真实 `event.timestamp` 作为 `occurredAt`。
- **回归**：`life-mode.test.ts`「expires stale activity candidates …」断言 6 小时前的活动进入
  `expiredRefs`、新鲜活动保留；`journal.test.ts`「stamps activity events …」断言写入即带时间戳。

## 8. `memory.list` 参数异常

登记为非缺陷：store 的 `list` action 只接受 `memoryType` 字符串；复现传的是 repository 风格的
`{ limit, scope }` 对象，属调用方 API 误用。全仓无生产调用方传参，UI 走 `listPending()`。不修。

## 顺带修复：计划长目标视图的时间戳并列回放

回归期间 `long-goals.browser.test.ts` 的 queue-depth 用例如实暴露一个既有缺陷：
`stateFromJournal` 以持久快照为基座回放 journal，旧守卫只跳过 `timestamp < lastTransition`
的事件；连续两次转换落在同一毫秒时（Windows 时钟粒度），已被快照吸收的事件会再次应用，
抛出「paused/cancelled 不能转 waiting-user」。修复：同一毫秒且与快照最新转换不一致的事件也跳过；
该用例连跑多次稳定通过。

## 离线验证（2026-09-10）

| 命令 | 结果 |
| --- | --- |
| `pnpm -F @proj-airi/core-agent exec vitest run` | 27 files / 302 passed |
| `pnpm exec vitest run --config packages/stage-ui/vitest.config.ts --project node src/stores/plans.test.ts src/stores/modules/memory.test.ts src/stores/modules/life-mode.test.ts src/stores/journal.test.ts src/stores/chat.contract.test.ts src/stores/chat-advancer.test.ts src/stores/skills.test.ts src/services/restore-gate.test.ts src/services/data-restore.test.ts` | 9 files / 160 passed |
| `pnpm exec vitest run --config packages/stage-ui/vitest.config.ts --project browser src/stores/modules/long-goals.browser.test.ts src/stores/skills.browser.test.ts src/stores/data-backup.browser.test.ts src/components/scenarios/chat/components/history.browser.test.ts src/components/scenarios/dialogs/onboarding/step-welcome.browser.test.ts` | 5 files / 34 passed |
| `pnpm exec vitest run --config apps/stage-tamagotchi/vitest.config.ts --project node src/main/services/airi/coding-host src/main/services/airi/life-mode src/main/services/airi/data-backup src/main/services/airi/long-goal src/renderer/stores/tools` | 21 files / 133 passed（1 skipped） |
| `pnpm exec vitest run --config apps/stage-tamagotchi/vitest.config.ts --project browser src/renderer/components/InteractiveArea.browser.test.ts` | 15 passed |
| `pnpm -F @proj-airi/core-agent typecheck` / `stage-ui` / `stage-tamagotchi` | 全部通过 |
| `pnpm lint` | 通过（既有 warning 保留） |

注意：core-agent 与 i18n 的 dist 已重建（stage-ui 测试消费 dist）。

## 待用户重建后的真机复验

1. `life/decision.sourceRefs` 只出现批准纠正后的有效 fact（S17 场景）。
2. 约 20 小时前的 `tool/result` 进入 `stale-stimulus`，不再作为候选送模型（S18 残余风险）。
3. 同一 L04 追问：中断前只有未完成的等待，恢复后才是检查与写入。
4. grep 结果无 `Search ran without ripgrep`（`degradedReason` 为空），命中与签名正常。
5. follower 设置页「最近门控」能看到 leader 渲染端的 busy/focused/flow-active/no-session 等门。
6. 可选：用损坏的 `life-mode.json` 复现「日志 + `.corrupt-*` 副本」。
