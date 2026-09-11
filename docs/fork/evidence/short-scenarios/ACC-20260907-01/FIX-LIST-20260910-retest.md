# FIX-LIST-20260910 真机复验结果（2026-09-10 重建后）

修复记录：[FIX-LIST-20260910-results.md](./FIX-LIST-20260910-results.md)。
构建：`pnpm -F @proj-airi/stage-tamagotchi build` 退出码 0（`out/` 22:19）；`@vscode/ripgrep` 已在
`apps/stage-tamagotchi` 声明并安装；`core-agent`/`i18n` 的 dist 已是当前源的最新构建。

复验用默认 profile（`C:\Users\86130\AppData\Roaming\@proj-airi\stage-tamagotchi`），CDP `9250`。
结束后已把生命模式恢复为 `autonomous / 间隔 15 / 静默 3–4 / 预算不限 / 冷却 30`，主窗口会话恢复为
`2l-pZQRE4Fwfz1N_Gt2XV`。

| # | 复验项 | 结果 |
| --- | --- | --- |
| 1 | 纠正后的有效 fact 进入 `sourceRefs` | **PASS** |
| 2 | 陈旧活动进入 `stale-stimulus` | **PASS（陈旧路径）／发现迁移缺口** |
| 3 | L04 恢复叙述按 seq 边界归因 | **部分通过**（第二轮补做：Flow 轮次正确、普通追问仍误归因） |
| 4 | grep 不再降级 | **PASS** |
| 5 | follower 能看到 leader 渲染端的本地门 | **PASS** |
| 6 | 损坏 `life-mode.json` → 日志 + `.corrupt-*` | **PASS**（附一条小观察） |

---

## 1. 纠正后的有效 fact 进入候选 —— PASS

数据层（leader renderer，memory scope `3bXjSqeo…/n8cz_qXFx…`）：

| 步骤 | `listShareableFacts` |
| --- | --- |
| 起始 | 3 条 `[656b0f6f, 4c211389, 17edcfbe]` |
| 批准新事实 `275f3bd2…`（「S17b 的测试植物是「白桦」」） | 4 条，`275f3bd2` 在列 |
| `reviseFact` 改成「红枫」并批准修订 `b3961c0e…` | 4 条，**`b3961c0e` 在列、`275f3bd2` 不在**（被替换） |

运行时：手动心跳（与设置页「测试心跳」同一个 store action）在 `2l-pZQRE4Fwfz1N_Gt2XV` 触发考量，
journal `40ae9ae5f845754a6add46f6ce4c8325.jsonl`：

```
seq=5706 (22:23:59) life/decision action=speak
  refs=memory:b3961c0e-1622-4e54-b70f-1ac3742114ba      ← 只有这一条候选
  reason=核对到审阅记忆与刚刚记录的事实冲突，当前有效名称实为「红枫」而「白桦」已作废，需向用户说明更正。
  text=关于刚才提到的 ACC-20260910-S17b……我核对了一下记录，它的当前有效名称其实是「红枫」，「白桦」已经作废了。
```

- `sourceRefs` **只含纠正后的有效 fact**，不含被替换的 `275f3bd2` ✅
- 发言使用有效名称并明确作废旧名称 ✅

复验后已删除两个测试片段（`b3961c0e`、`275f3bd2`），`listShareableFacts` 回到 3 条。

## 2. 陈旧候选 → `stale-stimulus` —— PASS（陈旧路径）／迁移缺口

先清理测试记忆，再切到休眠会话 `WxNnZyJvohEwGl4m_U2Wa`（journal `90e2f342…`，最后活动 2026-09-09 18:07）
触发手动心跳，journal 新增：

```
seq=19 (22:25:47) life/decision action=discarded
  reason=Discarded 2 stale social candidate(s) before model consideration.
  refs=memory:17edcfbe-6195-4369-a2de-d37f9623afca,presence:user:4:9
seq=20 (22:25:47) life/heartbeat gate=stale-stimulus outcome=gated
```

该轮**没有 `turn/start`**（零模型调用）✅。`presence` 与旧的 `memory` 候选都按真实 `occurredAt` 过期。

### 迁移缺口（新发现，建议补一条）

复验项原文要求「约 20 小时前的 **`tool/result`** 进入 `stale-stimulus`」，这一形态**没能复现**：
在 L04 会话（journal `9f9d9fa5…`）里，22:24 的心跳仍把 14:26 写入的 `tool:290`/`tool:314`
（约 8 小时前）当作候选送进模型（`seq=328 life/decision action=silence`）。

原因：`packages/stage-ui/src/stores/journal.ts:128-150` 只在 **`append`** 时给缺失时间戳的活动事件
补 `Date.now()`；`hydrate`/`readAll` 从磁盘读回的旧记录没有回填。`life-mode.ts` 用
`event.timestamp` 作为 `occurredAt`，而这些旧事件没有该字段 → `occurredAt === undefined` →
过期判据 `occurredAt > 0 && occurredAt < staleBefore` 为假 → **永不进入 `expiredRefs`**。
该 journal 里 32 条活动事件中有 31 条无时间戳。

建议：读回时对缺失时间戳的活动事件做一次回填（用 journal 文件内的相邻事件或文件 mtime），
或把「无时间戳」按「年龄未知」处理为过期。补一条回归：**没有时间戳的历史 `tool/result` 也要过期**。

## 3. L04 恢复叙述 —— 本次未完成

需要一条「跑到一半被杀、重启后继续」的 Flow。三次尝试：

1. 「用长期目标跟踪这件事：…」→ 模型**没有**调用 `plan_update`，直接用 `todo_write`/`read`/`bash`
   内联完成（journal 无 `plan/update`、无 `flow/start`），因此没有可恢复的 Flow。
2. 显式点名 `plan_update` 的版本 → 同样内联。
3. 给出完整 steps 的版本 → 建出 `flow/start`（`seq=5741`），但模型把「90 秒等待」那一步省掉了，
   Flow 在写入 + 读回后迅速收尾，**没有留下中断窗口**。

同时默认 profile 里旧的 FIX1 长期目标被调度器唤醒并在后台连续跑 turn，进一步压缩了可用的干净窗口。

结论：修复本身的提示词边界已由 `chat-orchestrator-runtime.test.ts`「marks the recovery boundary in the
resumed flow prompt」在代码层覆盖；真机口径需要一条至少有 2 分钟挂起步骤的 Flow。补做方式：
在下一次有干净窗口时（后台无长期目标在跑）用一条「step-1 必须执行 `sleep 240`」的计划建 Flow，
在 `sleep` 挂起时杀进程，重启后按 seq 边界追问答。

## 4. grep 不再降级 —— PASS

leader 会话 `2l-pZQRE4Fwfz1N_Gt2XV`，消息「请用 grep 工具在工作区里搜索 FIX1-TOKEN-8A2D63…」：

```
seq=5644 tool/call   grep {"pattern":"FIX1-TOKEN-8A2D63"}
seq=5645 tool/result grep ok=true outcome=ok
  summary=grep "FIX1-TOKEN-8A2D63" · 14 matches in 7 files
  workspace/FIX1-20260909/revised-result.txt
       1  cl  FIX1-TOKEN-8A2D63
  ...
```

- 结果里有真实文件/行/列命中，**没有** `Search ran without ripgrep (search binary unavailable)`。
- 对整份 journal 检索 `ripgrep|degraded` 只剩 09-07 的一条旧记录 → 本轮工具路径未再降级 ✅

## 5. follower 能看到 leader 渲染端的本地门 —— PASS

在 leader（主窗口）触发 `stale-stimulus` 后：

| 读取点 | 值 |
| --- | --- |
| 主进程持久化 `life-mode.json` | `"lastGate": "stale-stimulus"` |
| follower（聊天窗口，`synced-leader=false`）的 `life-mode` store `snapshot.lastGate` | `stale-stimulus` |

修复前渲染端门只写 leader 本地快照、不进主进程，follower 设置页永远读不到；现在两端一致 ✅
（设置页「最近门控」渲染的就是 follower 的 `snapshot.lastGate`。）

## 6. 损坏 `life-mode.json` —— PASS

把 `life-mode.json` 写成截断 JSON 后重启：

| 检查点 | 结果 |
| --- | --- |
| `.corrupt-*` 副本 | `life-mode.json.corrupt-1789050406176`（62 B，内容为损坏原文） |
| `.tmp` 残留 | 无 |
| 主配置 | 回落默认（`off / 0–0 / 24 / revision 0`）并重写 |
| 日志（主进程 stderr） | `[life-mode] Ignoring unreadable <path>; preserved a copy at <path>.corrupt-1789050406176. Unexpected token '', "{ "config"... is not valid JSON` |

**小观察**：这条 warn 走的是 `console.warn`（stderr），**没有进** `<userData>/logs/*.log` 的持久日志
（该文件只收 logg 钩子的输出）。正常启动（不接 stdio）时它不可见，durable 证据只有 `.corrupt-*` 副本。
若希望「日志」是持久日志，建议改走 logg 或同时写一份。

复验后已把生命模式改回 `autonomous / 间隔 15 / 静默 3–4 / 预算不限 / 冷却 30`（`revision` 重新计数）。

---

## 遗留

- 第 3 项（L04 真机口径）待补。
- 第 2 项的迁移缺口建议修（`journal.ts` 读回不回填时间戳）。
- 复验留下的工作区产物：`D:\airi\workspace\L04b-20260910\`（含模型写入的 `result.txt`）、
  `D:\airi\workspace\L04c-20260910\`（仅 `brief.txt`）。

---

# 第二轮：第 3 项真机复验 + 两条新修（2026-09-10 深夜）

修复方未动产品代码；两条新修由本机实现，见 `packages/stage-ui/src/stores/journal.ts` 与
`apps/stage-tamagotchi/src/main/services/airi/life-mode/index.ts`。

## 3. L04 恢复叙述 —— 部分通过

夹具 `workspace/L04d-20260910/brief.txt` = `L04D-TOKEN-B83C17`。用 `/flow` 起了一条含
`bash sleep 240` 的有界 Flow，在等待挂起时（23:07:51）杀掉进程，23:08:01 重启。

| 检查点 | 结果 |
| --- | --- |
| 中断前实际完成 | 只有一次 `bash sleep 240`（`seq=6478`）**没有任何结果**，没有读文件、没有写入 |
| 是否续跑同一 Flow | ✅ 重启后同一 Flow 继续（无新的 `flow/start`） |
| Flow 轮次的边界 | ✅ `seq=6485`「**中断恢复后**已确认当前任务目标。接下来我将先通过 bash 执行 `sleep 240`…」 |
| 任务是否完成 | ✅ `result.txt` = `L04D-TOKEN-B83C17`，与 brief 一致；`flow_update done` + 完成门通过 |
| **普通追问的归因** | ❌ 追问「这个任务是在中断后如何恢复的」的回答把**恢复后**才发生的两次 `sleep 240` 失败（`seq=6488` 23:10:31、`seq=6494` 23:12:36）说成「**中断前**…连续两次以 exitCode: 1 异常退出」 |

同一回答里「中断前未读取 brief.txt、未写入 result.txt」是对的，但失败次数归错阶段。

**结论**：`[Recovery boundary]` 只注入 Flow 的每一轮提示词（`flowPrompt`），普通轮次叙述已恢复任务时
仍然混淆阶段。记为 [FIX-LIST-20260910.md](./FIX-LIST-20260910.md) 第 9 条。

## 新修 A：活动事件时间戳回填 —— 已实现并真机验证

- **改动**：`packages/stage-ui/src/stores/journal.ts` 新增 `backfillActivityTimestamps()`，在
  `hydrate()` 把文件事件交给 `createJournalStore` 之前，给 `tool/result`/`plan/update`/`task/update`
  中缺时间戳的事件补上**同一轮次里最近的**时间戳（先取前一条，再为开头的活动事件取后一条）；
  两侧都没有时间戳时保持原样——填 `Date.now()` 会重新制造这个缺陷。
- **回归**：`journal.test.ts` 新增两条（回填方向 + 无邻居不填）；`journal.test.ts` 15 项全通过。
- **真机验证**：重建后在会话 `iv4bAQfGmsy…`（journal `8471c32e…`，09-09 的旧会话，14 条活动事件在
  watermark 之上且原本没有时间戳）触发手动心跳：

```
seq=846 (23:25:16) life/decision action=discarded
  reason=Discarded 16 stale social candidate(s) before model consideration.
  refs=tool:818,tool:840,tool:813,tool:65,tool:203,tool:235,tool:460,tool:335,tool:337,tool:481,tool:728,tool:571,tool:507,tool:815,memory:17edcfbe-…,presence:user:834:12
seq=847 (23:25:16) life/heartbeat gate=stale-stimulus outcome=gated
```

这 14 条 `tool/result` 修复前会被当成候选送进模型（同一天 22:24 的 L04 心跳就是 `refs=tool:290,tool:314`）；
现在全部进 `expiredRefs`，**零模型调用**。

## 新修 B：不可读配置的告警进持久日志 —— 已实现并真机验证

- **改动**：`apps/stage-tamagotchi/src/main/services/airi/life-mode/index.ts` 的
  `readPersistedLifeMode` 改用 `useLogg('main/life-mode').useGlobalConfig()`（原来只 `console.warn`，
  永远进不了 `<userData>/logs`）。
- **回归**：`life-mode/index.test.ts` 改为 mock `@guiiai/logg` 并断言 warn 文案含「Ignoring unreadable」
  与「preserved a copy at」；life-mode 两个文件 21 项全通过。
- **真机验证**：截断 `life-mode.json` 后重启，持久日志
  `logs/airi-tamagotchi-1789053960688.log` 出现：

```
2026-09-10T15:26:11.723Z [warn] [main/life-mode] Ignoring unreadable <path>; preserved a copy at
<path>.corrupt-1789053971721. { error=Unexpected token '', "{ "config"... is not valid JSON
stack=SyntaxError: … }
```

`.corrupt-1789053971721` 同时落盘；无 `.tmp` 残留。

## 本机检查（两条新修）

| 命令 | 结果 |
| --- | --- |
| `pnpm -F @proj-airi/stage-ui typecheck` / `stage-tamagotchi typecheck` | 退出码 0 |
| `pnpm exec eslint <4 个改动文件>` | 退出码 0 |
| `journal.test.ts` | 15 passed |
| `life-mode`（`index.test.ts` + `gates.test.ts`） | 21 passed |
| 应用重建（`pnpm -F @proj-airi/stage-tamagotchi build`） | 退出码 0，`out/` 更新 |

收尾：生命模式已恢复 `autonomous / 间隔 15 / 静默 3–4 / 预算不限 / 冷却 30`，主窗口会话恢复为
`2l-pZQRE4Fwfz1N_Gt2XV`。profile 里留下两份 `.corrupt-*` 诊断副本（62 B / 28 B）。

