# F-01 停车半径（选项 B）：修复与真机抽检（2026-09-16）

用户裁定：`keepDistance` 改为**停车半径**语义。腿的终点从目标格改为"以目标为圆心、`keepDistance` 为半径的圆环站位"；进入半径即停，目标走近时不主动后退。

## 改动

- `index.ts`：跟随腿的规划目标改为圆环站位（`self -> target` 连线上距目标 `activeKeepDistance` 的点），到达容差新增常量 `FOLLOW_RING_TOLERANCE = 0.75`；粗定位的 8 格会合语义不变。
- 回归：新增"腿瞄准圆环站位、不瞄准目标格"（读窗口 max 边 23 vs 目标格的 26）；更新受影响的旧用例（读窗口 min 边 -18 vs -19）。
- `game-host` 定向 **781 passed / 1 skipped**；typecheck 0；重建重启。

## 真机抽检（2026-09-16 深夜）

- 夹具：NoAI 羊 `Lumi` 距机器人 6 格（走廊平台 (82.5, 75, -28.5)），`game_follow { keepDistance: 3, timeoutSeconds: 12 }`。
- 结果：**PASS**。最小距离 = 最终距离 = **2.77 格**（`endReason: timeout`）；对照修复前同夹具为 0.14（最近）/0.92（终点），玩家目标为 0.00。
- 证据：[f01-standoff-check.json](./f01-standoff-check.json)，脚本 [f01-standoff-check.mjs](./f01-standoff-check.mjs)。

## 边界

- 单次运行、单一目标类型（羊）。未覆盖：高速移动目标下的圆环重规划频率、圆环点落在障碍/虚空时的规划退化（走既有失败边逻辑）。
- 环境掉线事故：抽检前 MC 服务端与双客户端/MCP 全部退出，已按 mcserver-wrap、launch-client、mcp-wrap（25600 指向 bot 桥 25601）顺序恢复；Fabric 服务端 `Done (1.344s)`。
