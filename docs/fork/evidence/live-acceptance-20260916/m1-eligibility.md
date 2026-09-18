# CD-M1 工具资格、主背包换槽与耐久：真机记录（2026-09-16）

夹具：目标方块 (78, 75, -24)，她站在 (77.5, 75, -24.5)。每例先清理测试物品并空出背包槽位（评估在背包放不下掉落时会拒绝），放置方块后经 AIRI 的 `game_break`（survival 模式）执行。注意：该桥的 `instant` 模式是创造专属，生存下不可用。

| 例 | 场景 | 结果 | 判读 |
| --- | --- | --- | --- |
| M-01a | 石 + 木镐 | `broken`，`tool: wooden_pickaxe`，耐久 59/59 | 资格与工具选择正确 |
| M-01b | 石 + 铁斧（错误工具） | `tool_level_too_low`，开挖前拒绝 | 不降低要求 |
| M-01c | 钻石矿 + 石镐 | `tool_level_too_low` | 等级不足拒绝 |
| M-01d | 石 + 空手 | `no_tool` | 无工具拒绝 |
| M-01e | 原木 + 铁斧 | `broken`，`tool: iron_axe` | 木类工具正确 |
| M-01f | 小麦 + 空手 | `broken`，`tool: hand` | 作物无需工具 |
| M-02 | 镐移至主背包后开挖 | `broken`，`tool: wooden_pickaxe` | 从主背包换槽成功 |
| M-03 | 钻石镐余 6 耐久 + 满耐久备用 | `broken`，`tool: diamond_pickaxe`，`durability 6/6`、无风险标记 | 余量足够时使用；风险策略未触发 |

证据：[m1-eligibility.json](./m1-eligibility.json)，脚本 [m1-eligibility.mjs](./m1-eligibility.mjs)。

## 途中修复（F-07）：采掘工具名与桥不一致

首次运行 8 例全部回退"手动破坏"（回执无 `tool`/`rejection`）。根因：宿主调用 `mine_evaluate_harvest` / `mine_break_evidence`，而桥（mcp-server dist）实际暴露 `evaluate_harvest` / `get_break_evidence`。评估永远失败 → 静默回退手动路径，工具选择、资格拒绝、耐久策略与前置流程全部不生效。

修复：宿主改用真实工具名（`evaluate_harvest`、`get_break_evidence`），`SERVER_FIRST_TOOLS` 同步；能力表 `break-evidence` 加入 `get_break_evidence`；单测 mock 同步。game-host 定向 **781 passed / 1 skipped**；重建重启后本记录 8/8 通过。

## 边界

- 每例单次运行；未覆盖附魔（效率/耐久）、水下采掘、疲劳与模组工具分组（设计要求的后续分组）。
- `inventory_full` 由评估按"背包放不下掉落"触发（已在夹具中通过清理规避）；掉落归属见后续 M-2 批次记录。
