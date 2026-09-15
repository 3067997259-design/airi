# MC-2c 真机验收：探索循环（2026-09-13）

范围：增量 2（MCP 实验 + 空闲 claim + trace）与增量 3 六场景。

## 夹具前置

- **App 侧 MCP 注册**（本次新增）：应用真实 userData `%APPDATA%\@proj-airi\stage-tamagotchi\mcp.json` 增 `mcpfabric` stdio 条目（`node D:\mcpfabric\mcp-server\dist\index.js`，env `MCPFABRIC_URL=http://127.0.0.1:25599`、`MCPFABRIC_TOKEN=…`）。此前应用只挂了 student-hub/todoist，`electronMcpListTools` 里没有游戏工具，实验步骤无法执行。注意 `%APPDATA%\Electron\mcp.json` 是另一份未使用的默认 userData，别写错。
- 游戏内桥 25599 在线，MCP 工具 `craft_by_recipe` / `get_inventory` 可经 `electronMcpCallTool` 调用。

## 验收结果

| 场景 | 操作 | 结果 |
| --- | --- | --- |
| 闭环 | 删除 `farmersdelight:flint_knife` 知识 → `exploreOnce` | `reuse-check:done:no fresh knowledge > jar:done:candidate recorded > web:skipped > craft:done:inventory delta matched > record:done:tier=verified`；tier=verified |
| 复用 | 同目标第二次 | `reused:true`，仅 `reuse-check:done:reused verified`，零实验 |
| 空闲窗口（autonomous） | `exploreIdleOnce`（life-mode 原子 claim） | claim 成功 → 全闭环（预算 7→8，tier=verified）；第二次 claim → 复用（8→9）；mode/非 autonomous 与 gate 拒绝时 `ran:false` 不做工 |
| 预算-步数 | `golden_knife` + `maxSteps:2` | `stopped(budget-steps)`：执行步 reuse-check+jar 达 2 即停，craft 未跑；skipped 不占预算 |
| 预算-时长 | `maxDurationMs:0`（增量 1） | `stopped(budget-time)`，0 步 |
| 用户停止 | 运行中 `exploreStop()`（未知目标） | `stopped(user)`，trace 保留 reuse-check |
| 失效-重学 | 改 FD 9.9.9 → 查询 stale/candidate → `exploreOnce` | 不复用 → 全闭环 → `verified/fresh`（9.9.9）；恢复 1.3.4 后按预期 stale |
| 诚实-未知 | `farmersdelight:not_a_thing` | `jar:failed`（`recipe not found in jar`）→ `failed(error)`，不写 verified |
| 诚实-缺材料 | 材料耗尽后 `exploreOnce('flint_knife')` | MCP 合成 5 次未 claim → `stopped(craft-attempts)`，tier 保持 `candidate`（不伪造 verified） |
| 注入边界 | 沿用 MC-2b：网页文本只进卡片字段 | 探索循环未执行任何网页文本指令；实验动作白名单仅 craft+inventory |

## 途中修复（真机发现）

1. **复用误判（语义检索假阳性）**：查询 `farmersdelight:diamond_knife` 命中语义相近的 flint_knife verified 事实 → 误判"已掌握"。修复：`knowledgeMatchesTarget`（originId 精确匹配、内容含完整 itemId 或物品名）；接入 `runExploration`；单测覆盖"近邻刀不算目标"。
2. **步数预算把 skipped 也计数**：`maxSteps:2` 时 web skipped 记录让 trace 多一步。修复：`stepAllowed` 只计非 skipped 步骤 + 单测。
3. trace 步骤补 note（失败原因可见），`writeFact` 诚实失败已在前批完成。

## 检查与夹具状态

- 单测 34/34（explore 13）；eslint 0；stage-tamagotchi typecheck 0；应用多次重建/重启。
- 夹具状态：`flint_knife`/`diamond_knife`/`golden_knife` 为 candidate/fresh（无材料复验）；指南与 web lead 保留；life-mode 复位 `autonomous`、预算计数 9；游戏内燧石/木棍被验收消耗至 0（需材料才能再做 verified 复验）。
