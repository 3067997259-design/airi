# MC-3c 统一真机验收（含 X-10 与 X-07，2026-09-13）

状态：完成。1.21.11 移植冒烟与主动断线场景标记 NOT-RUN，其余场景通过或有明确证据。本记录合并 MC-3c-1（服务器聊天端到端）、MC-3c-2/3（鞘翅/炽足兽）、X-10（聊天触发）与 X-07（drop/locate）。

## 环境与产物

| 项 | 值 |
| --- | --- |
| 服务端 | `D:\Minecraft-Server`，Fabric 1.21.1 offline，mcpfabric **0.2.3**（0.2.4 无服务端代码改动），桥 25598 |
| AIRI 客户端 | PCL 实例 `AIRI`，mcpfabric **0.2.4**（SHA-256 `060ce33fb92deee0b71cd5914719a833b797f19f60227532878c7045e7189666`），桥 25599 |
| 用户客户端 | 1.21.1-Fabric（无模组） |
| MCP server | 25600 → 25599（新 dist，含 `board_vehicle.type`）；25602 → 25598（新 dist） |
| 应用 | electron-vite preview（最新构建），`ELECTRON_CLI_ARGS=["--remote-debugging-port=9222"]`，`AIRI_TERRAIN_DEBUG=1` |
| 聊天配置 | `admins=["AfterRain"]`、`blocked=[]`、采样 0.2、上下文 5；`serverUrl` 双端点连接成功 |
| 夹具 | 发射台（42..48,140,-30..-15）；山脊（30..60,90..150,60..62）；水岛石台（-25..-13,63,40..52）；熔岩池+5 只鞍具炽足兽（70..84,78-79,-55..-43）；时间 day、晴朗；岛屿区域 forceload |
| 夹具辅助 | 全部为 OP 命令搭建；验收动作走正常玩家操作；记录在案 |

## A. 环境与冒烟

- 双桥连接：客户端 25599 + 服务端 25602 均连接成功；世界身份带 `playerUuid=afebedfb-…`（0.2.4 新字段贯通）。
- 模组新字段：`modVersion=0.2.4+1.21.1`；`player.getState` 含 `name`/`uuid`/`fallFlying`；`player.getEquipment` 返回 chest 装备与耐久。
- 服务端能力组实机使用：`list_players`、`get_player`、`players.give/teleport/applyEffect`、`entities.query/summon`、`world.fill/getBlocks`、`command.run` 全部成功。
- 设置页走查：新字段渲染正确（管理员 `AfterRain`、采样 `0.2`、上下文 `5`、端点 25600/25602）。
- 资源测量：服务端 1065 MB / 用户客户端 1019 MB / AIRI 客户端 1175 MB / Electron 全部 1581 MB / MCP×2 103 MB，合计约 4.9 GB。
- 1.21.11 移植冒烟：**NOT-RUN**（需另建 1.21.11 客户端，本轮未做）。

## B. X-10 聊天触发（D7 十二场景）

| 场景 | 证据 | 结果 |
| --- | --- | --- |
| 管理员免提及送达 | 事件 39/40/42/44/46/53/54/58 accepted `trigger=admin`；其中两次她选择不回应 | PASS |
| 管理员指令与回报 | 提及型指令后她用 `game_say` 回复（55/56/59 等） | PASS |
| `\` 前缀跳过 | 事件 57 `\AIRI应该不回复这条消息。` 无 accepted 行 | PASS |
| 提及送达（非管理员窗口） | 事件 60/61/72 accepted `trigger=mention` | PASS |
| 采样命中 | 事件 75 accepted `trigger=mentionless-sample`（采样率 1.0） | PASS |
| 采样未命中 | 事件 64（采样率 0）与 70（落在限频窗口）无 accepted | PASS |
| 限频 | 快速对 72/73 仅 72 accepted；两次人工尝试间隔 ≥4 秒属正常送达 | PASS（窗口内复现） |
| 自身回声 | 她的全部回复（55/56/59/62/63/67/68/71/74）从未 accepted | PASS |
| 黑名单 | 事件 76 `AIRI 黑名单测试`（`blocked=["AfterRain"]`）无 accepted、无回复 | PASS |
| 上下文 | 载荷含 `context`（单元测试覆盖 `chatContextOf` 与广播注入）；模型输入侧无法直接观察，标记为单测覆盖 | 单测 |
| 去重/游标 | 轮询单测 + 现场无重复 accepted | PASS |
| 配置往返 | `applyConfig` 热更新（admins/blocked/采样率）多次生效并触发重连；设置页读回一致 | PASS |

- 方法说明：第三名非管理员玩家缺失，提及/采样用「临时把管理员移出 admins」实现；黑名单用「临时把管理员放入 blocked」实现；限频窗口内复现依赖快速连发（人工有两次间隔 ≥4 秒的记录）。
- 消息 70 被限频窗口吞掉而非采样失败，已在日志与事件对照中确认。

## C. MC-3c 聊天端到端

- **MC 聊天**：用户在 MC 聊天多轮下令（含"过来"等），她执行游戏动作（含鞘翅飞行到用户身边）并用 `game_say` 回报；执行结果与回执链路正常。
- **AIRI 桌面聊天**：用户在应用聊天下令后，她执行了游戏动作（elytra 飞行与着陆）并回复；所执行动作与字面指令不完全一致属模型选择，信道、命令注册表与回执链路正常。
- **取消**：在飞命令经 `game_cancel` 收敛为 `cancelled`（island2 一次；取消后完成受控着陆，暴露并修复了落点区问题）。
- **断线**：NOT-RUN（未在验收中主动断开客户端；清理逻辑沿用 MC-0d 既有证据）。

## D. 鞘翅 D5

| 场景 | 结果 | 关键证据 |
| --- | --- | --- |
| 发射塔闭环（跨山脊） | PASS | flight4 `reached`，落点 0.56 ≤ 4，`checked: true`；日志 `elytra terrain ahead at 48; cruise band raised to 168`；满血 |
| 低补给提前着陆 | PASS | 2 发烟花 → `endReason=elytra_low_supply`、落点 2.0、满血；两次 `thrust fired` 用于爬过山墙 |
| 水岛安全着陆 | PASS | 石台重建后 `reached`，落点 0.77，站立高度 y=64，满血 |
| 着陆失败与重试 | PASS（修复后） | 修复前两次失败（30° 长俯冲砸地、薄墙点采样漏检、落点区上下振荡），修复后三飞全过 |
| 耐久策略 | PASS | 近损（≥90%）无备用 → 拒绝起飞 `unavailable`，避免空中破碎摔死；≥75% 时只做提前着陆 |
| 取消 | PASS | `cancelled` 收敛并完成受控着陆 |

- 巡航参数：高度带 `y_goal+30`（起飞高度钳制）、前方 8–48 格区域切片扫描、落点区 16 格内渐进拉平、着陆后 24 格内走位补差。
- 烟花与耐久消耗逐飞记录；`heldItem` 与 snapshot 一致。

## E. 炽足兽

| 场景 | 结果 | 证据 |
| --- | --- | --- |
| 上骑（类型过滤） | PASS | `board_vehicle type=minecraft:strider`，`strider mounted (minecraft:strider)` |
| 熔岩池横渡与下骑 | PASS | `reached`，落点 0.61 ≤ 2，手持诡异菌钓竿 |

- 夹具注记：首轮召唤的炽足兽在区块卸载后未在现场留存，验收时重新召唤 3 只并立即测试。

## F. X-07 drop / locate

| 场景 | 结果 | 证据 |
| --- | --- | --- |
| `game_locate` | PASS | 读到 AfterRain 位置 `(84.4, 80, -49.3)`；`checked=false` 属预期（无后置条件） |
| `game_drop` | PASS | 丢出 2 个面包，`verifiedBy=inventory-delta`，`dropped.count=2`，后置条件 met |

## 验收中修复（代码与夹具）

1. **着陆剖面**：长俯冲 + 5 格晚拉平导致砸地 → 改为按剩余距离计算下降角、14 格窗口渐进拉平；落点 16 格内不再扫描地形，直接混合拉平；低空急降（vy < -0.6）用最后一枚烟花在抬头姿态下缓降。
2. **避障采样**：离散点采样会漏掉 3 格薄墙 → 改为沿航向 8–48 格的区域切片读取（一次 `get_blocks_region`），巡航与着陆模式共用；遇墙优先用烟花爬升。
3. **落点区振荡**：落点附近「爬升↔俯冲」往复导致原地耗尽烟花坠海 → 落点区内禁止爬升分支，仅拉平着陆。
4. **耐久安全**：近损（≥90%）且无备用时拒绝起飞；≥75% 时起飞后只执行提前着陆。
5. **夹具教训**：沙是重力方块，水中沙台整片沉底 → 改用平滑石重建水岛。
6. **运行环境**：`game-host.json` 曾因 PowerShell BOM 解析失败导致应用不连接（已修复，写入无 BOM）；应用以 `ELECTRON_CLI_ARGS` 开启 CDP、`AIRI_TERRAIN_DEBUG=1` 采集弹道证据。

## 未决与限制

- 1.21.11 移植冒烟、主动断线清理场景：NOT-RUN。
- 上下文注入只做到单测覆盖；模型输入侧无直接观测。
- 非管理员第三人、独立黑名单玩家缺失，用配置窗口模拟；限频的人工复现依赖输入速度。
- 服务端 jar 仍为 0.2.3；应用当前带调试日志运行，正式使用前需无调试重启。
- 世界内保留夹具（发射台/山脊/熔岩池/水岛）与岛屿 forceload，待用户决定拆除。
