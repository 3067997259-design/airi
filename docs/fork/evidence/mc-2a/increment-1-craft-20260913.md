# MC-2a 增量 1 真机：合成 RPC（2026-09-13）

范围：mcpfabric fork 新增 `craft.byRecipe`（两拍协议）与 MCP 工具 `craft_by_recipe`；真机验证 2×2 合成与 3 宽配方守卫。

## Mod fork 补丁

- `CraftHandlers.java`：`craft.byRecipe { recipeId }`
  - 校验配方存在、类型为 `crafting_shaped|shapeless`、且**能放入随身 2×2**（shaped 宽高 ≤2；shapeless ≤4 材料）；否则返回 `error`（`unknown_recipe`/`unsupported_recipe_type`/`recipe_needs_crafting_table`），不动网格。
  - **两拍协议**（集成服务器在后续 tick 结算）：
    1. 结果槽已有物品 → `claimed`（领取前读取真实堆叠并 quick-move）；
    2. 否则先清空网格残留（quick-move 回背包）→ `handlePlaceRecipe` → `placed` + `expected`。
  - 调用方循环直到 `claimed`；材料不足时结果槽为空，诚实返回（不伪造）。
- MCP server：工具 `craft_by_recipe`（描述两拍语义）。
- jar 迭代：`47c74c40…`（首版，同步多拍）→ `105cf3fe…`（两拍）→ **`c2b5ff40…`（claim-first 顺序修复，最终）**；客户端每次重启验证。

## 真机结果（flint_knife，1×2 配方：燧石+木棍）

| 步骤 | 结果 |
| --- | --- |
| `craft.byRecipe farmersdelight:flint_knife` 第 1 次 | `{placed:true, expected:{flint_knife,1}}` |
| 第 2 次 | `{claimed:true, output:{flint_knife,1}}` |
| 库存前后 | 刀 4→5（+1）、燧石 6→5（−1）、木棍 6→5（−1）**消耗正确** |
| 守卫：`farmersdelight:cutting_board`（3 宽） | `{crafted:0, error:"recipe_needs_crafting_table"}`，材料零消耗 |

## 本轮修掉的问题

1. **目标选型错误**：首目标原定切菜板，实际是 **3 列**图案（`"/##"`），2×2 放不下且第一次尝试把材料卡在网格里；改为 `flint_knife`（1×2），并把切菜板留待 3×3/工作台能力。
2. **同步多拍不可靠**：一次 tick 内连发 `handlePlaceRecipe` 时服务端延迟结算，计数与真实库存不符 → 改为两拍协议（每次 RPC 只做一拍）。
3. **清理顺序 duplication**：先清网格再领取会把服务端已消耗的材料退回（测试中出现过一把"白得"的刀）→ 改为**先领取、无结果再清理+放置**。
4. 配方解锁状态会影响放置（夹具中 FD 配方已解锁）；本增量不处理解锁，记录为夹具前提。

## 测试与检查

- mod 编译通过；`player.getInventory` 读数核对；守卫与正常路径均真机通过。
- 遗留测试物：多出一把 `flint_knife`（缺陷期产物），随夹具保留。
