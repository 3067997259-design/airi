# 未关闭问题清单（2026-09-09）

本文件汇总本轮验收过程中发现的、尚未修复或尚未决策的问题。逐条证据见对应记录。

## 一、待修的产品缺陷

### 1. 修订后的旧计划步骤阻塞完成门（影响 L07，最重）

**状态（2026-09-10）：已解决。** 车道化修复（合取只取每条车道最新计划、`start` 折叠整条车道、`focus/complete` 按 stepId 解析）后，FIX1 与 REV 两次复验的完成门均 `verdict=pass`、`flow/end reason=done`，未再出现旧计划 blocker。见 [修复记录](./fix-1a-superseded-plans-20260909.md)、[FIX1 调试全过程](./FIX1-DEBUG-JOURNEY-20260910.md)、[REV 复验](./REV-structured-revision-pass-20260910.md)。

- 现象：Flow 运行中收到修订、按新约束完成新目标后，完成门连续两次 `verdict=rejected`，Flow 没有 `flow/end`，目标停在 `waiting-condition`。
- 证据：journal `40ae9ae5f845754a6add46f6ce4c8325.jsonl`，`seq=1112` 与 `seq=1231` 的 blockers：
  - `step-1「读取 brief.txt 内容」: step is blocked`
  - `step-2「执行约 300 秒的前台等待」: step has not started`
  - `step-4「读回 initial-result.txt 进行核验比对」: step has not started`
- 判断：修订后模型用 `plan_update start` 重建了计划，但完成门仍在追踪**被替换掉的旧步骤**，它们永远不会完成。与原始 L07 记录里的「plan evidence did not settle」同类。
- 记录：[L07-revision-live-20260909.md](./L07-revision-live-20260909.md)

**1b. 模型自发的 `plan_update start` 会触发约束修订并中断 Flow（可形成循环）**

- 现象：Flow 运行中模型执行 `plan_update start` 重建计划，长目标层把它当作约束修订：`flow/end reason=interrupted` + `goal/update cv 1→2`，随后调度器认领新的有界运行。
- 证据：journal `40ae9ae5…`，`seq=1378 → 1379 → 1381 → 1383`。
- 风险：与 1a 叠加时（完成门拒绝 → 模型重建计划 → 修订 → 中断 → 新运行）可形成反复重建/重启的循环。
- 同一轮还观察到**未验证收尾被记为完成**：`seq=1416` `flow/end detail=closed without verification: step-1`，`seq=1420` 目标仍标 `completed`。
- 记录：[L07-self-revision-20260909.md](./L07-self-revision-20260909.md)

### 2. 记忆同步 `update` 先于 `insert` 时静默丢数据（影响 R06）

- 现象：对尚未镜像的短期事实批准时排入 `update`，`updateByOriginId` 影响 0 行，投递被当作成功，outbox 清空，但远端没有该行。
- 证据：`select … where origin_id='656b0f6f-…'` 返回 0 行，而 UI 显示「0 条记忆等待同步」。
- 判断：`update` 不能充当首次写入；应回退为 upsert，或短期事实的审阅变更不排 `update`。
- 记录：[R06-outbox-reconnect-20260909.md](./R06-outbox-reconnect-20260909.md)

### 3. 构建版 grep 永远走 Node 兜底（C1 未生效）

- 现象：grep 结果带 `Search ran without ripgrep (search binary unavailable)`。
- 根因：主进程把 `@vscode/ripgrep` 打进 chunk，运行时 `createRequire(import.meta.url).resolve` 的上下文是 `out/main/`，看不到平台包 `@vscode/ripgrep-win32-x64`（它只对 `packages/coding-harness` 可见）。
- 判断：C1「检索原语」在构建版从未生效；既有 T8/T9 只断言命中与签名，未断言 `degradedReason` 为空。
- 记录：[live-skill-contract-and-grep-20260909.md](./live-skill-contract-and-grep-20260909.md)

### 4. 恢复叙述把恢复后的动作说成中断前证据（影响 L04 的回答口径）

- 现象：追问「如何恢复」时，模型把恢复后的 `ENOENT` 检查、写入与读回都归到「中断前（18:08）」，并引用恢复后那次 `sleep 90` 的 `exitCode 0`。
- 判断：机制（重绑、单次写入、完成门）通过，但「准确区分中断前证据与恢复后检查」未满足。
- 记录：[L04-crash-clean-20260909.md](./L04-crash-clean-20260909.md)

### 5. 心流指示器显示旧目标的步骤文本（UI）

- 现象：当前 Flow 的 step-2 是「执行约 300 秒等待」，底部指示器却显示「心流运行中 · 第 1/6 步 · 有界检查 L01/signal.txt 是否存在」（旧 L01 目标的文本）。
- 判断：指示器未跟随当前 Flow 的 `activeFlowStep`，属显示不同步。
- 证据：2026-09-09 用户截图两次；journal 里当前 Flow `cM3wMjRxhhcBsl37Pr9D5` 的步骤为「读取 brief.txt」「300 秒等待」。
- **状态（2026-09-10）：已修复并经用户确认。** 指示器已跟随当前 Flow 的真实步骤。

### 6. 显式纠正产生的新事实永远进不了记忆候选（影响 S17）

- 现象：对一条事实执行显式纠正（`reviseFact`，含「记忆浏览器」的「修正」按钮）并批准后，**被替换的旧事实正确失效，但新的有效事实也不再出现在记忆候选里**。
- 证据：纠正后 `listShareableFacts(scope, 10)` 与 `(scope, 50)` 返回的都是同样 4 条，纠正前后的两个片段 ID 都不在其中；`listPending` 已不含该条目（说明纠正与批准都已生效）。
- 根因：`listShareableFacts` 与 `projectMemoryCandidate` 都要求候选带 `sourceContext`（`sourceType` + `messageId`/`sourceEventId`，`memory.ts:794`、`life-mode.ts:249-257`），而 `reviseFact` 调 `persistExtractions(..., undefined, revisionScope)`，`persistExtractions` 只在有值时写入该字段（`memory.ts:1256-1262`）。
- 影响：S17 要求的「记忆候选和发言均使用有效事实」在纠正场景下结构性不可达；社交考量既看不到旧的，也看不到新的。
- 判断：应让修订片段继承被替换事实的来源，或在 `reviseFact` 入参里带上当前消息来源；补回归「批准纠正后有效片段在 `listShareableFacts` 中、被替换片段不在」。
- 记录：[S03-S18-recovery-20260910.md](./S03-S18-recovery-20260910.md)

### 7. 重启后 `life-mode.json` 被静默重置为默认值

- 现象：2026-09-10 收尾重启后，原 profile 的 `life-mode.json` 从 `autonomous / 静默 3–4 / 预算不限 / revision 36` 变成 `off / 0–0 / 24 / revision 0`。
- 代码路径：`setupLifeMode` 读不到合法持久状态时直接回落默认并立即 `persist()`（`apps/stage-tamagotchi/src/main/services/airi/life-mode/index.ts:153-155, 314-315`）；`readPersistedLifeMode` 解析失败只 `return undefined`，**不写任何日志**（同文件 `:110-130`）。
- 判断：无论根因是文件被写坏还是 schema 拒绝，**静默回落 + 无日志**本身就可诊断性不足，且会让用户的自主模式配置无声消失。建议补日志、保留损坏副本、并考虑原子写。
- 记录：[S03-S18-recovery-20260910.md](./S03-S18-recovery-20260910.md)

## 二、运行环境备忘（非产品缺陷）

### 6. 重启后 CDP 可能静默绑定失败

结束 Electron 后立刻重启，新实例可能不监听 `9250`（`/json/version` 拒绝连接），而 renderer 命令行仍带该端口，磁盘 journal 照常写入。处理：结束后等数秒再启动，启动后用 `/json/version` 复核。

### 7. agent-browser 挂起与守护进程堆积

CLI 常在产出结果后不退出；`snapshot -i` 在 AIRI 大窗口上可超过 200–400 秒不返回；残留守护进程会累积（一次 14 个）并卡死。规避：清守护进程、改用 CSS 选择器驱动、避免 snapshot。

## 三、需要你决定的三件事

1. **R03 恢复账户契约**：恢复副本 P' 不带认证凭据，未登录时看不到原 owner 的会话索引。选「要求重新认证」还是「设计安全的本地 owner remap」？不决定则 R03 只能停在 PARTIAL。
2. **grep 修复方案**：需要动依赖或构建配置，按仓库规则由你选：
   - a) 把 `@vscode/ripgrep` 加为 `apps/stage-tamagotchi` 的依赖并外部化；
   - b) 构建时解析二进制绝对路径并注入；
   - c) 先不修，只保留降级提示。
3. **是否要我修问题 1（完成门）**：这是本批最重的缺陷，但属产品逻辑改动，需要你确认范围和验收口径。
