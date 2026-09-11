# M07 新会话首问配对（记忆开/关）

- 日期：`2026-09-09`
- 运行端：`@proj-airi/stage-tamagotchi` 构建版 `out/`，Electron `43.4.1`，CDP `9250`
- Profile：`C:\Users\86130\AppData\Roaming\@proj-airi\stage-tamagotchi`
- 角色：`n8cz_qXFxNLwpJmuAsfIl`
- Provider / model：`openai-compatible` / `gemini-3.8-flash`
- 浏览器控制 session：`airi-acc-20260909`

本记录回答 [独立复核](../acceptance-review-20260909.md) 发现 4 的开放条件：全新会话的**首轮**自然语言问句能否检索到带 Flow 来源的已批准事实，并用同一问句配对记忆开关。它不重写此前的自然语言召回失败记录。

## 前置状态

已批准事实 `17edcfbe-6195-4369-a2de-d37f9623afca` 在本次运行前就已存在且为 `long_term · 有效`（记忆浏览器显示 `3 次访问 · 3 个会话`）。因此本次两个会话都建立在「先批准、后建会话」的先后顺序之上，满足复核要求的顺序条件。

问句沿用同一句：`回顾一下 ACC-20260909-M07 的来源链验收，你记得我们确实做过什么？`

## 记忆开启：首问命中

- 会话：`kvscT8RXQZtQ1a07HlkSE`
- Journal：`C:\Users\86130\AppData\Roaming\@proj-airi\stage-tamagotchi\journal\e71fbe33e3f76a80f1134dd80654584f.jsonl`

事件链：

- `seq=4` `user/message`：上述问句（本会话第一条用户消息）。
- `seq=5` `memory/retrieved`：`memoryIds: ["17edcfbe-6195-4369-a2de-d37f9623afca"]`，`score 1.1528`，`originalSimilarity 0.5647`，`retrievalQuery: both`。
- 整个回合**没有任何 `tool/*` 事件**，说明回答只可能来自记忆注入，而不是工作区检索。
- `seq=19` `assistant/done`，`seq=20` `memory/applied`（`appliedMemoryIds: []`，回答未写 `[memory:<id>]` 标记），`seq=21` `turn/end {reason: completed}`。

回答内容与实际文件逐字核对一致：`M07-FLOW-MEMORY-SOURCE-CHAIN-20260909`、`M07-NETWORK-RESPONSE-SOURCE-CHAIN-20260909`，以及 `baseHash db5cf06f` / `a529bfd5`。

哈希用 `packages/coding-harness/src/hashline/text.ts` 的 `contentHash`（FNV-1a 32 位，8 位十六进制）在本机重算：

| 文件 | 实际内容 | 实际哈希 | 回答中的哈希 |
| --- | --- | --- | --- |
| `workspace/M07-flow-memory-20260909/marker.txt` | `M07-FLOW-MEMORY-SOURCE-CHAIN-20260909` | `db5cf06f` | `db5cf06f` |
| `workspace/M07-network-response-20260909/marker.txt` | `M07-NETWORK-RESPONSE-SOURCE-CHAIN-20260909` | `a529bfd5` | `a529bfd5` |

回答没有声称该工作仍在运行，也没有宣告部署或发布。

## 记忆关闭：检索为空

- 会话：`h9m2mS1vPMlqyTP3z6cdm`
- Journal：`C:\Users\86130\AppData\Roaming\@proj-airi\stage-tamagotchi\journal\393d082ab0ec180039a05b5848477396.jsonl`

事件链：

- `seq=4` `user/message`：同一问句。
- `seq=5` `memory/retrieved`：`memoryIds: []`。
- `seq=7..20`：7 组 `tool/call` + `tool/result`。
- `seq=37` `turn/end {reason: completed}`。

记忆开关的机械隔离成立：检索为空。但这条对照**不构成"无法回忆"的行为证据**——模型改用工作区工具读取验收证据后作答，回答里复述了本复核文档的结论。工作区检索替代记忆正是复核提醒要避免的路径，这里如实记录为混杂项，不当作记忆排除的行为通过。

开关在两次运行之间通过记忆设置页切换，运行结束后已恢复为开启。

## 旁证

复核提到的首问为空发生在会话 `ihapa7PsW4DmImuDX9xvW`（journal `05b386832dcc569d71e23cd05fcc7536.jsonl`）。只读复核该 profile 时另发现 `journal\51007aa99c85914de6914da2b4544edb.jsonl` 的会话 `wQr6RyCuEkT39YcO4rlxm` 在 `seq=5`（首轮）就已命中同一事实 `17edcfbe-6195-4369-a2de-d37f9623afca`。该轮问句是关于 L04 恢复的中文任务描述，不是 M07 问句，所以它只作首问可命中的旁证，不替代本次配对。

## 结论

| 检查点 | 结果 |
| --- | --- |
| 先批准、后建新会话的顺序 | 成立（事实在本次运行前已批准且有效） |
| 全新会话首问检索命中 | PASS（`kvscT8RXQZtQ1a07HlkSE` seq=5 命中） |
| 回答与实际文件/哈希一致 | PASS（两个 marker 内容与 `contentHash` 逐字节一致） |
| 无工作区检索替代记忆 | PASS（开启运行时零 `tool/*` 事件） |
| 记忆关闭时检索为空 | PASS（机械隔离） |
| 记忆关闭时的行为对照 | 混杂项：模型改用工作区工具作答，不作为行为通过 |

M07 的「新会话首问自然语言召回」开放项在本次配对中成立。此前 `ihapa7PsW4DmImuDX9xvW` 的首问为空与自然语言召回失败记录保持原样，不因本次结果被改写。
