# REV 复验：结构化修订 + 完成门通过（2026-09-10）

- 状态：PASS（结构化修订生效、完成门通过、队列语义可见）；授权器拒绝路径未触发（属合理结果）。
- Journal：`40ae9ae5f845754a6add46f6ce4c8325.jsonl`
- 夹具：`workspace/REV-20260910/brief.txt` = `REV-TOKEN-6D1F94`
- 目标前缀：`ACC-20260910-REV`

## 步骤

与 FIX1 同构：

1. `/goal ACC-20260910-REV：读取 workspace/REV-20260910/brief.txt，执行一次约 300 秒的前台等待，然后把文件内容写入同目录的 initial-result.txt 并读回核对。用多个小步骤的长期计划，等待期间保持 Flow 运行，不要用后台任务。`
2. 等待期间发修订：`/goal ACC-20260910-REV：修改要求——保留已经读到的证据，输出改为 revised-result.txt；旧目标中的其他待写文件不要再写。`

## 结果（重建 R1–R5 之后）

| 检查点 | 证据 | 结论 |
| --- | --- | --- |
| **结构化修订** | `seq=5356 goal/update executable cv=2 revision=true reason=long-goal constraints revised`；`seq=5390` 再到 `cv=3 revision=true` | ✅ 「steering 携带命令结构」修复生效：Flow 运行中发 `/goal` 终于产生结构化修订（此前 `cv` 恒为 1、无 `revision`） |
| **完成门** | `seq=5233 / 5296 / 5464 flow/completion-review verdict=pass`；`flow/end reason=done` | ✅ 重建后本窗口无 `rejected`；两次 `rejected`（`seq=4944/5026`）均在重建前 |
| **R1 唤醒串行化** | `seq=5342 / 5357 / 5391 goal/update waiting-condition reason=Waiting for another goal that holds the single Flow slot.` | ✅ 等待原因变成队列语义，替代旧的 `Another chat Flow is active` |
| **刷屏量** | `seq≥4840` 的 `goal/update` 共 **14 次 / 约 2 小时** | ✅ 对比昨晚 `cv 1→11` 的持续互相改写，明显收敛 |
| `stale_plan_run` | 全文 **0 次** | 修订直接中断 Flow，没有产生迟到的旧写入 |

## 对「发现 2」的结论

复核发现 2 的可观察条件是「旧约束写入不执行」。本次通过**修订即中断**满足：Flow 被中断后没有产生迟到的旧写入，因此授权器拒绝分支（`stale_plan_run`）没有被触发——这是合理结果，不是漏测。

**新增证据**：结构化修订的触发条件已经具备（`revision: true` + `constraintVersion` 递增），此前这一条在运行态从未成立。

**可选补充变体**：构造「工具调用已派出、修订在其结算前到达」的窗口，专门验证授权器的 `stale_plan_run` 分支。属于加强项，不是关闭条件。

## 夹具污染说明

`workspace/REV-20260910/initial-result.txt` 曾在 **02:25:20** 出现，那是**重建前**那轮（修订走 steering 文本通道时）写出的；重建后的运行没有再写它（`revised-result.txt` 为 12:53:38）。复验结束后已删除该文件。

## 未覆盖（慢验证）

- **R3 退避阶梯**（5→10→20→30 分钟）与 **R4 排队超时提问三分支**：需要目标排队超过 2 小时才会触发，本轮窗口不足以观察。
- 同 session 多 goal 的**队列位次 UI**：按建议登记为已知缺口，见 `docs/fork/WIRING-BACKLOG.md`。
