# MC-0c / CP-1 应用内验证记录

日期：2026-09-12。结果：**工具面、证据分级、CP-1 两消费者、工具面真实执行 PASS**。环境：重建后的 Electron（CDP 9250）；环境 A 专用服 + 客户端桥 25599（mod 0.2.3）+ MCP server 25600；玩家在服内。

## 工具面（MC-0c）

- 工具面 54 个（原 50 + 四个 `game_*`）：`game_observe`/`game_move_to`/`game_status`/`game_cancel`。
- 四条注册均为 `ownerKind: game_adapter`、`ownerId: game-host`、`execution.chain: ['game-adapter','game-host']`；MCPFabric 原始工具零泄漏（不变量 1）。
- 包装技能的证据作者仍为 `reviewed_self_authored`（不提升信任）。

## CP-1 两消费者

| 时点 | 能力快照 |
| --- | --- |
| 初始（game-host 已连接） | `game.minecraft.control` = ready（消费者 1） |
| 执行 `wrap('acc-20260909-dedupe')` 后 | `skill.adapter.self-authored` = ready（`wrappedCount: 1`，消费者 2） |

两消费者互相可见（`observerMode` 判定所需的两条能力均出现）。

## 工具面真实执行（经注册表 → main → MCP → mod）

| 调用 | 结果 |
| --- | --- |
| `game_observe` | `ok`、`checked: true`、`postCondition {observed, 8, 8, true}`、含 commandId 与位置 |
| `game_move_to`（不可达） | `failed`、`checked: true`、`endReason: unreachable`、`distance 2 m 未达` |
| `game_move_to`（路径耗尽） | `failed`、`checked: true`、`endReason: path_exhausted`、`actual 3.17 > target 3` |
| `game_move_to`（到达） | `ok`、`checked: true`、`endReason: reached`、`actual 2.78 ≤ 3` |
| `game_status`（无活动命令） | 返回最近终态回执（commandId + `endReason: unreachable`） |
| `game_cancel` | `ok`、`commandId: null`、`endReason: idle` |

## 验证中发现并修复的缺陷

1. **main 执行器误用桥方法名**：私有 MCP session 面向 Node MCP server，工具名是 `navigate_to`/`navigation_status`/`stop_navigation`，原实现发送 `nav.pathTo`/`nav.status`/`nav.stop`，全部被 MCP server 判为未知工具（回执显示 `executor_error`、玩家不动）。修复后 `unreachable`/`path_exhausted`/`reached` 等真实原因全部正确落回执。原始 RPC（桥直连）不受影响，这也是 MC-0b 冒烟此前能通过的原因。
2. **`game_status` 缺"最近终态"回退**：规范要求无 `commandId` 时返回活动写命令或最近终态；原实现只查活动命令。已在 main 侧保留 `lastReceipt` 并在 status 中回退。

## 未覆盖（NOT-RUN）

- **raw（未核对）游戏回执在真机被拒**：仅由单测覆盖（`evidence-gate.test.ts` 的 checked/raw 用例、运行时结果分级用例）；真机链路始终产生 checked 回执。
- 真聊天下令与完成门已另测（[real-chat-gate-20260912.md](./real-chat-gate-20260912.md)）。
