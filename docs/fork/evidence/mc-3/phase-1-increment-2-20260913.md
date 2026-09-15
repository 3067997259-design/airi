# MC-3 Phase 1 增量 2 真机验证（2026-09-13）

范围：步行执行器（走位/疾跑/跳跃/游泳/parkour）、稳定瞄准骨架、卡死恢复、`game_move_to` 接线。通过 AIRI 域命令路径（渲染端 `game_move_to` 工具 → 注册表 → terrain 执行器）验证；planner 经 devtools 配置为 `terrain`。

## 环境

- 构建：2026-09-13 重建（增量 2 + `set_movement` 工具名修复），CDP 9250；游戏 mod 0.2.3+1.21.1，MCP server 25600；TEST 台与夹具沿用。
- 配置：`movement: { planner: 'terrain' }`（经 `#/devtools/game-host` 探针应用）；`allowPlace` 默认、玩家背包有 128 圆石。

## 结果

| 用例 | 输入 | 结果 | 说明 |
| --- | --- | --- | --- |
| 断桥（全宽 3 格） | start (83.5,67,-18.5) → (89,67,-18) | **PASS** 1.6s，距离 0.32 | 走位 + parkour 起跳沿触发跳跃，无放置 |
| 落差 5 格（默认 `maxFall=4`） | start (87.5,72,-5.5) → (87,67,-5) | `unsupported_action`（0.59s） | 规划出需要放置的下降步骤（先走一步，随后步骤带 place），增量 2 不执行动作 |
| 落差 5 格（`maxFall=6`） | 同上 | **PASS** 5.7s，距离 0.34 | 允许坠落后正常下落到达 |
| 二格墙（全宽） | start (73.5,67,-6.5) → (79,67,-6) | `unsupported_action`（0.13s） | 规划需要垫脚（place），边界符合预期 |
| 水面齐沿水坑 C | start (68.5,66,-9.5) → (68,67,-5) | `unsupported_action`（0.17s） | 规划用"垫 1 块跳上岸"（jump-up + place）；**移植缺"游泳爬出"移动**，纯水退出当前只能靠放置 |

## 观察

1. 基础走位、疾跑、parkour 起跳、`set_movement`/`look`/`jump`/`stop_movement` 工具映射均正确；`unsupported_action` 在有放置/破坏需求时即时返回（不空走）。
2. 工具名回归：首轮实测因 `set_input`（错误名）导致玩家不动并被判 `stuck`；已抽出 `movement/host-port.ts` 并加单测（`set_movement` 等），重建后通过。
3. 落差默认 4 格时规划器给出的方案是"放置台阶下降"而非纯坠落——增量 3 实现放置后应复验；纯拒绝路径需在增量 3 以 `allowPlace=false` 复验。
4. **新缺口**：水坑 C（水面与沿齐平）在 mineflayer 移植中没有"游泳上岸"移动（上游同样以 jump-up+place 处理），而 Phase 0 的 Baritone 能纯游出。增量 3 候选：新增 `swim-shore` 移动（水中面向岸、持续 jump+forward，直到脚下方块为实心）。

## 清理

玩家与测试台保留；planner 保持 `terrain` 配置以便继续验证。Baritone jar 暂存未动。
