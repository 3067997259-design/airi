# L07 修订窗口实测（2026-09-09）

- 状态：行为层 PASS；结算层 FAIL（完成门两次拒绝，Flow 未结束）。
- 日期：`2026-09-09`
- 运行端：`@proj-airi/stage-tamagotchi`，CDP `9250`，原用户 profile
- 会话 journal：`40ae9ae5f845754a6add46f6ce4c8325.jsonl`
- Flow：`cM3wMjRxhhcBsl37Pr9D5`，task：`gPgAWI5iHYI9aHdNZZL04`
- 夹具：`workspace/L07d-20260909/brief.txt` = `L07D-TOKEN-5C2B84`

## 过程

1. 初始目标（`seq=1032`）：读取 brief.txt → 前台等待约 300 秒 → 写入 `initial-result.txt` → 读回核对。
2. `seq=1035` Flow 启动；`seq=1039` 读到 `L07D-TOKEN-5C2B84`；`seq=1054` `date && sleep 300` 开始等待。
3. **等待期间**（`seq=1074`）修订消息以 `user/steering` 送达：`修改要求——保留已经读到的证据，输出改为 revised-result.txt；旧目标中的其他待写文件不要再写。`
4. `seq=1081` 模型按新指令重建计划，`seq=1082` 写入 `revised-result.txt`，`seq=1094` 读回。

## 结果

| 检查点 | 结果 |
| --- | --- |
| 修订在写入之前送达 | PASS（`seq=1074` 早于 `seq=1082`） |
| 旧目标 `initial-result.txt` 未被写入 | PASS（全 journal 无对该路径的 `write`；目录里只有 `brief.txt` 与 `revised-result.txt`） |
| 新目标 `revised-result.txt` | PASS（内容 `L07D-TOKEN-5C2B84`，三次写入均指向该路径，`seq=1082/1128/1147`） |
| 回复承认新约束 | PASS（`seq=1105` flow_update detail：「…旧文件 initial-result.txt 未写入」；面向用户的话术说明已放弃旧目标） |
| 步骤计数不出现 `3/1` | 未出现（由用户界面确认） |
| Flow 结算 | **FAIL**：完成门两次 `verdict=rejected`（`seq=1112`、`seq=1231`），没有 `flow/end`，目标停在 `waiting-condition` |

## 完成门拒绝的原因

`seq=1231` 的 blockers：

```
"读取 workspace/L07d-20260909/brief.txt 内容" step step-1: step is blocked
"执行约 300 秒的前台等待（不用后台任务）并记录时间戳" step step-2: step has not started
"读回 initial-result.txt 进行核验比对" step step-4: step has not started
```

`seq=1112` 还多一条「将 brief.txt 内容写入 revised-result.txt step step-1: step is blocked」。

也就是说：修订后模型重建了计划，但完成门仍在追踪**被替换掉的旧计划步骤**（`step-1` 阻塞、`step-2` 未开始、`step-4` 未开始），因此永远无法结算。这与原始 [L07-revision-and-competition.md](./L07-revision-and-competition.md) 里「plan evidence did not settle」是同一类问题，本次在「修订先于写入」的正确时序下复现。

## 与复核发现 2 的关系

本次修订走的是 **steering 文本**通道（`user/steering`），不是结构化的 `/goal` 约束修订：`goal/update` 全程 `cv=1`、没有 `revision: true`，也没有 `flow/end reason=interrupted`。所以本次**不能**为复核发现 2（旧运行写入被授权器拒绝）提供运行态证据——它证明的是**行为层适配**（模型主动放弃旧目标），不是结构性拒绝。

要拿到发现 2 的运行态证据，需要让 `/goal` 在 Flow 运行时被解析成结构化修订（例如在空闲回合发送，或让 `/goal` 走不排队的通道）。

## 未覆盖

- 双窗口「立即运行」竞争。
- 结构化修订（`constraintVersion` 递增 + `flow/end interrupted`）。
