# R04 adoption 后排程与「恰好一次有界 Flow」（2026-09-10 深夜）

用户配合完成：登录原 owner + 配置 provider。本文件补的是 R04 关闭条件里最后一段
「adoption 后**不重启**：目标启动**恰好一次**有界 Flow；多窗口状态一致、无重复调度」。

环境：构建版 `@proj-airi/stage-tamagotchi`（`out/` 2026-09-10 深夜 rebuild），CDP `9250`，
副本 `restores\restore-J2TLrx`。

## 准备

| 项 | 值 |
| --- | --- |
| 登录 | `auth: true`、`userId = 3bXjSqeoKBQnOCCXBcudtmM8omc0xKxY`、`index.userId` 同上、113 条会话 |
| 角色卡 | `activeCardId = n8cz_qXFxNLwpJmuAsfIl`（与两个目标 `spec.scope.characterId` 一致） |
| provider | 用户配置 `openai-compatible` / `gemini-3.8-flash`（`apiKeySet: true`、`status: configured`） |
| coding 工作区根 | 用设置 UI 从副本自带目录切到 `D:/airi`（与目标 `spec.workspaceRoot` 一致） |
| 副本状态 | `restore-state.json` → `effectsHeld: false`（此前已完成 adoption） |
| 排程 | `long-goals.json` 两条：`430613eb`、`598e975d`，`nextReviewAt` 均为 00:30:08 |

## 发生了什么

| 时刻 | 事件 |
| --- | --- |
| 00:30:08 | 调度器唤醒目标 `430613eb`：`lastWake.reason = "schedule"`，`runningGoalId = 430613eb`；`long-goals.json` 里的 `430613eb` 条目随之消失（占用 Flow 槽） |
| 00:30:08–00:31:31 | 有界 Flow `6izmfCPf…`（task `abt7YKTL…`，session `2l-pZQRE4F…`）运行 3 轮后 `flow/end reason=done`，`lastRun.outcome = completed` |
| 00:31:38–00:32:39 | 目标 `598e975d` 接上：Flow `FaSIR8xe…`（task `AUG5yPgQ…`）同样 `done` / `completed` |
| 00:33 | 两个目标 lifecycle 都是 `completed`；`runningGoalId = null`；`long-goals.json` → `{"schedules":[]}` |

本轮会话内 journal 计数：**`flow/start` 2 次、`flow/end` 2 次、`goal/update` 6 次**，一次一个，
按单 Flow 槽串行（第二个目标的 `startedAt` 正好在第一个 `endedAt` 之后 7 秒）。

## 判定

**关闭条件满足**：

- adoption 后（本次未重启进程）目标确实进入调度并按 `nextReviewAt` 唤醒；
- 每个目标**只启动一次有界 Flow**，没有第二次启动、没有重复排程；
- 两个目标被「单 Flow 槽」串行化，而不是并发抢占；
- 结算后 `schedules` 清空、`runningGoalId` 归零、lifecycle 走到 `completed`。

**R04 PASS。**

## 但有一个新问题：这次运行的 journal 根本没落盘

| 检查点 | 结果 |
| --- | --- |
| 会话内 journal（`runtime-journal`，session `2l-pZQRE4Fwfz1N_Gt2XV`） | 193 条事件，seq **`0..192`** |
| 磁盘 `restores\restore-J2TLrx\journal\` | 最新写入仍是 **14:46:53**（恢复时刻），`40ae9ae5…jsonl` 仍是 4839 条 / mtime 14:46:31 |
| 整个 profile 树下 15 分钟内被修改的 `*.jsonl` | **0 个** |
| `persistenceStatus` | `pendingCount: 0`、`lastSeq: -1`（`replayAnalysis` 为 `null`，即从未成功 replay） |
| 渲染端警告 | `[Flow] Journal replay is incomplete; flow rebuild is suppressed for this session.`、`[Boot] Flow resume failed. Error: Provider credentials for openai-compatible not found`（后者是配置凭据之前的启动） |

两点后果：

1. **证据消失**：这次「恰好一次有界 Flow」的完整事件链只存在于内存里，重启即丢；恢复副本
   从恢复时刻起就没有再写过一个 journal 事件。这也解释了早先 R04 失败记录里
   「P'' journal 最新写入仍停在恢复时刻」的现象——当时归因于 hold 未释放，但 hold 释放之后
   仍然没有写入。
2. **序列身份断裂**：内存里的运行从 seq 0 重新开始，而不是接在恢复文件的 0..4838 之后；
   也就是说恢复出来的历史与本次运行不在同一 seq 空间，证据引用与水位对不上。

已记为 [FIX-LIST-20260910.md](./FIX-LIST-20260910.md) 新增条目（journal 在恢复副本中既不 replay 也不落盘）。

## 附：多窗口

用户在本副本里打开了设置窗口（follower），主窗口是 leader。验证期间未观察到重复调度或
两个窗口打架的迹象（`schedules` 单调、`runningGoalId` 单一）。真正的「两窗口并发点击」与
「双窗口竞争」仍按 [L07-K07-L02-20260910.md](./L07-K07-L02-20260910.md) 的结论留在下一轮。
