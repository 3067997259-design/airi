# FIX1 复验失败：完成门循环未解 + journal 不落盘（2026-09-09）

- 状态：两项新问题，均未修复
- 日期：`2026-09-09`
- Journal：`40ae9ae5f845754a6add46f6ce4c8325.jsonl`
- 夹具：`workspace/FIX1-20260909/brief.txt` = `FIX1-TOKEN-8A2D63`

## 1. 完成门循环没有被 1a 修复解决

在**重建并重启后**（21:57，`out/` 21:47–21:48，含 `selectFlowCompletionPlans` 第二版）复验：

- 卡片显示「下次复查 22:16」+「立即运行」，四个步骤全部 `blocked / not started`：`step-1-verify-revised`、`step-write-revised`、`step-verify-revised`、`step-verify-revised-final`。
- 界面显示 `ACC-20260909-FIX1 … 进行中 · 第 17 轮 · 4 次工具调用`，模型回复「执行计划被判定受阻…接下来我将启动一个包含这四个步骤的长期计划」——仍在重建计划。
- 用户于 22:17 前手动点「停止心流」结束循环。

**结论**：blocker 这次指向的是**最新那份计划自己的步骤**，不是被替换的旧计划。所以 1a 的「排除旧计划」不是循环的唯一原因；新计划自身的步骤为什么停在 `blocked / not started` 需要继续定位。

## 2. journal 事件 20 分钟未落盘

| 证据 | 值 |
| --- | --- |
| `40ae9ae5….jsonl` 最后写入时间 | `21:57:07` |
| 最后事件 | `seq=1718 tool/result` |
| 检查时间 | `22:17:19` |
| 同一时段文件系统副作用 | `revised-result.txt` 写入于 `22:02:41`（内容正确 `FIX1-TOKEN-8A2D63`） |

即：应用在 21:57 之后持续运行、执行了工具并写入了工作区文件，但**没有任何 journal 事件落到磁盘**。这与 DR-3 批次修过的「按已落盘 seq 去重 / flush 竞态」相关，重启后可能再次踩到。

**可能的因果**：完成门读 journal 投影；若投影/落盘链路在重启后异常，证据进不去，完成判定必然失败 → 模型重建计划 → 再次被拒，形成观察到的循环。

## 3. 未变好的部分

- `initial-result.txt` 仍然没有被写（旧目标未复活）。
- `revised-result.txt` = `FIX1-TOKEN-8A2D63` 正确。

## 下一步

1. 查 journal 落盘：比对内存投影与磁盘、journal-host 的 `persistenceStatus`（pending/gaps/identityBrokenFrom）。
2. 回到完成门：定位**新计划自身步骤**为何长期停在 `blocked / not started`（`currentStepId` 与 `blockers` 的来源）。
3. 在两项都定位前，不再把 1a 标记为「已解决」。
