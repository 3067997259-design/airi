# MC-3b 增量 1 真机：船（2026-09-13）

范围：`VehicleMover` 模式抽象、端口补充（`useItem`/`dismount`/`swapSlots`/`getRiding`/`boardNearestVehicle`）、船 mover。

## Mod fork 补丁（mcpfabric）

`entities.query` 不返回船/矿车/马（非生物被过滤），且距离字段不可靠——无法用它做"是否已上船"。因此在本地 fork（pin `1881470` + 既有工作区补丁）新增：

- `player.getVehicle`（读：`riding`/`type`/`uuid`，来自 `player.getVehicle()`）；
- `vehicle.boardNearest`（写：右键最近 4 格内的 Boat/AbstractMinecart/AbstractHorse，返回 `boarded`/`type`/`uuid`）；
- MCP server 工具 `get_vehicle`、`board_vehicle`。

重建 jar（`mcpfabric-0.2.3+1.21.1.jar`，sha256 `3292241b86719454b4a8ef162c26622410b2147b049c3ff1279c02b412e53c3b`，152,861 字节）并重启客户端；`player.getVehicle` 实测返回 `{"riding":false}`。

## 夹具与结果

- 水渠：x 68–88、z 4–6、y=65 底、y=66 水、两侧 y65–66 石砖墙（水面与岸齐平）。
- 流程：给 `oak_boat`×2 → 传送 (69.5,67,5.5) → `game_move_to { x:87, y:67, z:5, tolerance:2, vehicle:'boat' }`。

| 项 | 结果 |
| --- | --- |
| 状态/时间 | **PASS** 8.9s（距离 0.86） |
| 结束位置 | (86.2, 67.1, 4.68)，`riding=false`（已下船） |
| 机制 | `useItem`（朝水道方向俯角 30°）放船 → `boardNearest` 上船 → look+forward 短段修正航行约 17 格 → sneak 脉冲下船 |

## 途中修复

1. 船物品常进主背包（快捷栏满）：端口加 `swapSlots`（映射 `swap_slots`），先换入快捷栏再选择。
2. 固定 yaw 放船会打到岸墙：改为朝目标方向、俯角 30° 放船。
3. 载具不可查询：见上 mod 补丁。

## 测试与检查

- movement 94 passed（含船 mover：已骑乘航行 / 放船即上 / 主背包换槽 / 放船未上需 board / 卡住有界 / 取消 / 马与矿车暂 unavailable）；game-host 85 passed（此前基线）；typecheck/eslint 0。
- 马（增量 2）与矿车（增量 3）仍为 `unavailable` 占位。
