# R07 导入中途终止（2026-09-10）

- 场景：R07 原口径为「坏包拒绝」；本文件补的是登记里剩的变体「导入中途终止」。
- 运行端：构建版 `@proj-airi/stage-tamagotchi`（`out/` 2026-09-10），CDP `9250`，默认 profile。
- 归档：`C:\Users\86130\Downloads\airi-backup-2026-09-09T17_53_15.331Z.zip`（14,280,283 B）。

## 步骤

1. 主窗口进「设置 → 数据」，确认隐藏的 `input[accept*=zip]`（index 0）存在。
2. 把归档赋给该 input 触发 `importBusinessSnapshot` → `stageRestore`（写 `backups/`、准备恢复副本、随后 `relaunchRestore`）。
3. **700 ms 后强杀应用进程树**（23:44:40），此时恢复流程尚未完成。
4. 检查残留物，再在默认 profile 重启并核对数据完整性。

## 结果

| 检查点 | 结果 |
| --- | --- |
| 新的恢复副本 | **没有**：`restores/` 仍是原来 4 个（`restore-2CLTVP` / `restore-7IF4GT` / `restore-J2TLrx` / `restore-uugF7G`） |
| 半截归档 | **没有**：`backups/` 最新的仍是 14:46:31 那份，没有 23:44 的残留 |
| 重启是否成功 | ✅ 正常回到默认 profile，CDP `9250` 就绪 |
| 会话索引 | 115 条（含本轮新建的探针会话） |
| 计划 | `plans=61`、`activePlans=27` |
| 记忆库 | `databaseStatus=ready`，`repo.list` 返回 77 条 |
| 生命模式 | `autonomous / 间隔 15 / 静默 3–4` 未受影响 |

结论：中途终止的导入**没有留下半成品**，原 profile 数据完整。R07 的这个变体 PASS。

## 顺带发现：记忆候选只看「最近访问的前 20 条」

核对记忆完整性时发现，同一 scope 下 `listShareableFacts` 的结果会**随 limit 变化而增减**：

```
listShareableFacts(scope, 10) → [656b0f6f, 17edcfbe]                    （2 条）
listShareableFacts(scope, 25) → [656b0f6f, 4c211389, 17edcfbe]          （3 条）
```

而 `4c211389` 本身是 `long_term / approved / active`、scope 匹配、`sourceContext` 齐全——完全具备候选资格。
原因是 `memory.ts:783-786` 先用 `limit: Math.max(limit * 4, limit)` 取「按 `last_accessed` 倒序」的一窗，
再在内存里过滤；超出窗口的合格事实就被静默丢掉。生命模式的调用是
`listShareableFacts(chat.memoryScope, MAX_SHAREABLE_MEMORY_FACTS = 5)` → **窗口只有 20 行**。

影响：库里 77 条记忆时，只有最近访问过的 20 条有机会成为社交候选；一条很久没被读到的已审事实
永远不会被主动提起，而且没有任何地方提示发生了截断。

已记入 [FIX-LIST-20260910.md](./FIX-LIST-20260910.md)（新增条目）。
