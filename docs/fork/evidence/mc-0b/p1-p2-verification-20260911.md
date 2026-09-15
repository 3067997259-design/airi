# MC-0b Java 侧 P1/P2 真机验证记录

日期：2026-09-11（本地时间）。结果：**P2 五场景 + P1 三触发 PASS**。环境：fork 0.2.2（jar SHA-256 `79ead8bb3ef8af2ce34a16fca72510672fc88e21c3cb20cd258c7f367e5eac75`）、环境 A（本地 Fabric 专用服，offline，seed `-3029234016717445527`；测试期间 `difficulty peaceful` + `gamerule doMobSpawning false`）、客户端桥 25599、服务端桥 25598。

## 驱动方式

确定性协议脚本（原始 RPC，不经 LLM）：

```powershell
$env:MCPFABRIC_BRIDGE_TOKEN = '<客户端 token>'
pnpm -F @proj-airi/stage-tamagotchi exec tsx scripts/mc-0b-protocol-smoke.ts
```

最终一轮 **7/7 全绿**。

## P2 结果（脚本输出）

| 场景 | 观察值 |
| --- | --- |
| `reached` | `endReason=reached`、`finalDistance=1.325`（方法：先走开，再走回玩家已站过的方块；该终点必然可站） |
| `cancel` | `endReason=cancelled`、停止后位移 `0.472`（制动）|
| `deadline` | `endReason=deadline`、`finalPosition=(44.96, 87, -13.5)`、停止后位移 `0.009` |
| `unreachable` | 错误码 `unreachable`，data 携带 `position=(45.21, 87, -13.5)`（有界失败） |
| `path_exhausted` | `endReason=path_exhausted`、`finalDistance=1.307` > 容差 `1.0`（路径耗尽不再判 `reached`） |

## P1 结果（五类触发）

| 触发 | 证据 |
| --- | --- |
| 心跳超时 | 临时 `heartbeatTimeoutMs=5000`；静默后清理：跳跃中（`maxJumpDelta 1.055`）→ 停止（位移 `0`）。两次独立观察（脚本 + 早前一次意外静默）。测后已恢复 30000（下次重启生效） |
| 断连 | 导航中按「断开连接」→ `endReason=disconnected`、`finalDistance=0.935`、`finalPosition` 落盘；1 秒轮询捕获 |
| 死亡 | 23:50:35 被僵尸击杀（当时仍是 survival）→ 导航 `endReason=death`、`finalDistance=53.86`、`finalPosition` 落盘；随后环境切和平 |
| 世界退出 | 退出到标题会先触发网络 `DISCONNECT` 事件（记录为 `disconnected`），`world_exit` 分支作为"无断连事件的 level 卸载"兜底保留；本次未单独观察到该兜底路径 |

## 服务端能力组（此前验证）

服务端桥 `info.status`：`side=dedicated_server`，能力含 `world_read/entities/players_admin/world_write/command`；`players.list` 返回 `airitest`；`command.run` 可执行 `difficulty`/`gamerule`（用于夹具）。

## 测试侧备注（避免误判）

1. 原始 RPC 返回 `{ok:false,error}` 时 HTTP 仍是 200；驱动脚本必须检查 `ok`，否则被拒的 `nav.pathTo` 看起来像成功（本轮曾因此误判 `bridge_timeout`）。
2. fork 的 A* 把 `reachRadius` 当目标接受半径：目标不可站时路径终点落在半径边界，`finalDistance` 会略大于容差而判 `path_exhausted`。确定性 `reached` 用例应使用"玩家站过的方块"作目标。
3. 清理的"两游戏 tick"验收线：实现为清理标志在下一 tick 应用；本次以秒级采样验证了位移归零，未做 tick 级计时。

## 未覆盖（NOT-RUN）

- `world_exit` 兜底路径的独立触发未观察到（被 DISCONNECT 先手覆盖）。
- 反射（MC-0d）与 collect/say 写路径（MC-1a）不在本批。
- 桥进程被杀（客户端强杀）场景未跑；租约失效由导航截止与心跳覆盖。
