# R01 变体：写入/抽取进行中导出（2026-09-10）

- 场景：R01 原口径为「导出闸门」；本文件补的是登记里剩的变体「写入/抽取进行中导出」。
- 运行端：构建版 `@proj-airi/stage-tamagotchi`（`out/` 2026-09-10 深夜 rebuild），CDP `9250`，默认 profile。
- 操作路径：主窗口 →「设置 → 数据」→ 可见的 `Backup ZIP` 按钮（原生保存框由用户确认；产物落在 `Downloads`）。

## 怎么制造「进行中的写入」

记忆的 embedding 迁移是一次**长时间、连续**的落盘写入：在「设置 → 机体模块 → 短期记忆」切换 embedding 模型后，
`memory.embeddingMigration` 进入 `state: "running"`，`total: 77` 条片段逐条重新生成向量并写回 DuckDB。
两次导出都在这个窗口里点击 `Backup ZIP`。

## 结果

| | 导出 1 | 导出 2 |
| --- | --- | --- |
| 归档 | `airi-backup-2026-09-10T16_12_11.590Z.zip`（13,831,088 B） | `airi-backup-2026-09-10T16_13_28.313Z.zip`（13,732,314 B） |
| 点击瞬间的迁移 | `running`，`0/77` | `running`，`0/77` |
| 归档落盘后的迁移 | `running`，`20/77` → 最终 `complete 77/77` | 仍是 `running`，**`0/77`** |
| 条目数 | 155（manifest 154 条） | 155（manifest 154 条） |
| **逐条哈希核对** | **154/154 一致，0 缺失、0 不匹配** | **154/154 一致，0 缺失、0 不匹配** |
| 契约字段 | `credentials: excluded`、`outbox: held`、coverage 7 域 | 同左 |

哈希核对使用 manifest 里每条 `sha256`/`bytes` 与实际字节逐一比对（PowerShell `ZipFile` + SHA256）。

## 判断

- **归档本身是自洽的**：154 条全部与 manifest 的哈希、字节数一致，没有半截文件；`credentials: excluded`、`outbox: held`
  与既有契约一致。
- **导出 2 的窗口里迁移没有任何推进**（点击前后都是 `0/77`，归档落盘 9 秒后仍是 `0/77`），迁移在窗口结束后才继续并最终
  `complete 77/77` —— 说明快照抓到的是一个静止点，而不是「写了一半」的库。
- 导出 1 里迁移在归档落盘后立刻到了 `20/77`，说明窗口结束后写入立即恢复。

结论：**这个变体 PASS** —— 写入进行中导出得到的是自洽且可校验的归档，没有观察到半成品状态。

## 给修复方的两点观察

1. **闸门不覆盖后台 IO**。`stores/data-backup.ts:57` 只拒绝
   `chat.sending`、正在运行的 Flow、`memory.dreaming` 三种情况；embedding 迁移不在其中（本次没有拒绝，符合现状设计）。
   真正的第二道防线是 `:109` 的 `before !== sourceState()`（`sourceState()` 含 `embedding: memory.embeddingMigration`），
   两次都没有触发——与「窗口内确实没有推进」一致。
2. **barrier 只看得见 store action**。`services/snapshot-barrier.ts:16-32` 只跟踪 9 个 owner store 的 Pinia action，
   迁移这类「不走 action 的后台 IO」不在其内（源码注释也写明这类 IO 需要自己的锁）。也就是说这里的自洽性来自
   DuckDB 写入串行化 + 状态比对，而不是 barrier 本身。若将来后台 IO 与快照并行推进，`before !== after` 会抛
   `Profile state changed during the snapshot. Ask again when all owners are idle.`——这是设计好的兜底，值得保留并可加回归。

## 收尾

- embedding 模型已切回 `voyage-4-large`（与开始时一致），迁移 `complete 77/77`，指纹
  `api:https://api.voyageai.com/v1/:voyage-4-large`。
- 两份导出归档保留在 `C:\Users\86130\Downloads\` 作为证据。
- 应用仍在默认 profile，生命模式未改动。
