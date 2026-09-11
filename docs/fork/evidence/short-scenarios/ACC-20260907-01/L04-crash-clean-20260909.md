# L04 崩溃后恢复干净重跑（2026-09-09）

- 状态：机制 PASS；回答口径不准确（单独记录）。
- 日期：`2026-09-09`
- 运行端：重建后的 `@proj-airi/stage-tamagotchi`（`out/` 17:35，含 authority 与 skill-forge 修复），CDP `9250`，原用户 profile
- 会话：`383m9uJ6PbTyIjsCQvqxu`
- Journal：`C:\Users\86130\AppData\Roaming\@proj-airi\stage-tamagotchi\journal\9f9d9fa56b59d6feeba0a0d6d7f07750.jsonl`
- Flow：`NrT0v5xVbSUhOu23KJuVa`，task：`4Xx7BT7q6_mVMIV6Ow0kl`
- 计划/目标：`ced5f008-568a-4433-aba6-f49859cf5ca4`
- 夹具：`workspace/L04-clean2-20260909/brief.txt`

本记录承接 [L04-recovery-continuation-20260909.md](./L04-recovery-continuation-20260909.md) 的「Next run」要求：全新计划与步骤 ID、在工具调用挂起时结束进程、同 profile 同 CDP 重启、要求同运行身份重绑、一次写入、一次读回、计划无 unverified 步骤、目标只结算一次。

## 崩溃点

- `seq=21`（18:09:00）`bash {command: "sleep 90"}` 已发出。
- `seq=22`（18:09:02）`todo/write` 之后结束 Electron 主进程树。
- 结束前核对：`workspace/L04-clean2-20260909/crash-result.txt` 不存在。因此中断前没有任何写入。

## 恢复

- 重启后 journal 未出现新的 `flow/start`：同一 Flow `NrT0v5xVbSUhOu23KJuVa` 与 task `4Xx7BT7q6_mVMIV6Ow0kl` 继续（`seq=23` `flow/step`）。
- 模型用全新步骤 ID 重建了计划（`seq=30` `plan_update start`，`step-1..step-3`）。
- 恢复后序列：
  - `seq=50` `bash sleep 90`（本次真正完成，`seq=51` `exitCode 0`）；
  - `seq=70/71` `read crash-result.txt` → `ENOENT`（写前检查）；
  - `seq=72/73` `write {baseHash: null, content: "CRASH-CLEAN2-WRITE-20260909\n"}` → `status: written`；
  - `seq=87/88` `read crash-result.txt` → `ok`；
  - `seq=89/90` `flow_update done`；
  - `seq=101` `flow/completion-review verdict=pass`；
  - `seq=102`（18:12:17）`flow/end reason=done iterations=5`。
- 全 journal 对 `crash-result.txt` 只有一次 `write` 与两次 `read`（一次写前 ENOENT、一次读回成功）。
- 文件内容：`CRASH-CLEAN2-WRITE-20260909`。
- 目标卡：`读取 brief.txt，执行 90 秒前台等待并校验写入 crash-result.txt [已完成 · 3/3]`。

## 关闭条件核对

| 条件 | 结果 |
| --- | --- |
| 相同运行身份可追溯 | PASS（重启前后同一 flowId/taskId，无新 `flow/start`） |
| 旧运行无重复副作用 | PASS（只有一次写入；被中断的等待被重新发起，没有产生重复写入） |
| 新证据完成门通过 | PASS（`completion-review verdict=pass`，无 unverified 步骤） |
| 目标只结算一次 | PASS（`已完成 · 3/3`） |

## 发现 — 恢复叙述把恢复后的动作说成中断前证据

追问 `ACC-20260909-L04-clean2 是如何在中断后恢复的？哪些结果经过重新检查？` 的回答把时间线讲反了：

- 它把「`crash-result.txt` 初检 ENOENT」「写入 `CRASH-CLEAN2-WRITE-20260909`」「首次读回确认」都归到「中断前（18:08 初始阶段）」，并称恢复后「并没有盲目重新执行 90 秒等待或直接覆盖写入」，只做了只读核对。
- journal 显示相反：中断前只有一次未完成的 `sleep 90`，没有任何写入；ENOENT 检查、写入和读回全部发生在重启之后（`seq=70..88`）。
- 它引用的 `sleep 90（exitCode 0）` 属于恢复后 `seq=50/51` 的那次等待。

因此 L04 的「准确区分中断前证据和恢复后检查」这一条**未满足**：模型没有声称停机期间仍在运行，但为中断前阶段编造了不存在的写入与读回证据。

机制部分（重绑、单次写入、完成门、目标结算）成立；叙述准确性问题单独列出，供后续定位。

## 检查

- 未修改产品代码、用户 profile 或原始验收登记。
- 夹具 `workspace/L04-clean2-20260909/` 保留为证据。
