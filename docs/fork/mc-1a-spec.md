# MC-1a 规范：say / collect / follow 上线

日期：2026-09-12。状态：规范定稿，实施未开始。上游：[Minecraft 执行计划](./minecraft-execution-plan.md) 的 MC-1a 行与验收场景、[Fabric 实现方向](./minecraft-fabric-implementation-direction.md) 的"第一个工具面"、[mc-0b-spec](./mc-0b-spec.md) 命令契约、[mc-0c-spec](./mc-0c-spec.md) 工具面/核对、[mc-0d-spec](./mc-0d-spec.md) 反射抢占。

MC-1a 把 MC-0 的"能观察、能走"提升为"能说话、能采集、能跟随"，并且与生存反射无死锁。批次契约不新增证据语义：`checked` 规则、四项核对、单写者与反射抢占全部沿用 MC-0b/0c/0d。

## 范围

交付：

- 三个新领域动作：`say`（聊天）、`collect`（有界采集）、`follow`（跟随目标）；命令参数、执行器、终态回执与工具描述。
- 采集数量以**新鲜库存增量**核对为 `collected` 后置条件；follow/say 为行为动作，不产生变更证据。
- 与反射、用户停止、新命令的抢占/打断规则。

不做：

- 战斗、投喂/繁殖、复杂合成（归 MC-1c 或 MC-2）；服务器管理工具（`players.*`/`command.run`）不进入工具面。
- 新增 Java 补丁：MCPFabric 现有方法组（`world.findBlocks`、`interact.breakBlock`、`inventory.getInventory`、`nav.*`、`entities.query`、`chat.send`/`chat.getRecent`）覆盖 v1；仅当采集事件核验需要第二来源时再评估 P4 扩展（见"证据"）。

## 领域动作契约扩展

加法扩展，信封与结果形状不变：

- `GameDomainAction` += `'say' | 'collect' | 'follow'`（`shared/eventa/game-host.ts` 与 `command-contract.ts` 两侧同步）。
- `GameCommandParams`（collect/say 字段 MC-0b 已预留，补 follow）：

```text
collect?: { blockId: string, itemId?: string, maxCount: number, radius: number }
say?: { text: string }
follow?: { target: string, keepDistance: number, timeoutSeconds?: number }
```

- 后置条件：`collect` 用既有 `collected`（`actual` = 本命令期间目标物品的新鲜库存增量，`target` = `maxCount`）；`say`/`follow` 为 `none`（`checked=false`，不构成变更证明）。
- 动作租约：`say` 10s、`collect` 180s、`follow` 300s（`DOMAIN_COMMAND_DEADLINES` 追加）。start 后走既有 single-writer 门与取消链。

## 工具面（DOMAIN_TOOLS 追加）

| 工具 | 参数（模型面） | 说明 |
| --- | --- | --- |
| `game_say` | `{ text }` | 在游戏内聊天发言；自身消息不得回流为输入 |
| `game_collect` | `{ blockId, itemId?, maxCount?, radius? }` | 在半径内找到 `blockId`，逐个走到并破坏，取回数量；`itemId` 缺省等于 `blockId`；`maxCount` 默认 1、上限 16；`radius` 默认 16、上限 48 |
| `game_follow` | `{ target, keepDistance?, timeoutSeconds? }` | 跟随玩家名或实体 id，保持距离；被新命令/停止/反射打断即终止 |

描述里明确：有界数量、可被打断、`game_status`/`game_cancel` 可查询与停止。

## 执行器设计

沿用 `executeGameAction` 一处入口（main game-host），新增分支：

- **say**：一次 `chat.send`；返回 `endReason='said'`。`chat.send` 报错按文本映射（权限/频率等）；回执 `postCondition.none`。
- **collect**（循环，直到终态）：
  1. 命令开始时记录基线库存（`inventory.getInventory`），只统计 `itemId` 增量；
  2. `world.findBlocks({ blockId, radius, limit })` → 取最近目标；找不到 → `endReason='no_target'`；
  3. `nav.pathTo(目标, reachRadius≈3)` → 轮询 `nav.status`；不可达 → 换下一个候选（最多 3 个），全部失败 → `unreachable`；
  4. 到点后 `interact.breakBlock(目标)`；等待拾取（轮询库存增量，单块最多 5s）→ 超时记 `pickup_timeout` 并继续下一块（不改计数）；
  5. 每轮开始检查：取消请求、租约剩余、反射事件；达到 `maxCount` 或达到 3 个候选失败 → 终态；
  6. 终态后用**新鲜读数**计算 `collectedCount`，写 `collected` 后置条件。
- **follow**（循环）：
  1. 解析目标：玩家名经 `players.list`/`entities.query`，实体 id 直接查；未找到 → `target_lost`；
  2. `nav.pathTo(目标当前位置, reachRadius=keepDistance)`；到达后等待目标移动，超过阈值距离再规划；
  3. 目标消失/换维度 → `target_lost`；租约到期 → `timeout`；收到取消 → `nav.stop` 后 `cancelled`；
  4. 终态 `postCondition.none`。

共同规则：

- **单写者**：follow/collect 都是写动作，注册表只允许一个活动写命令；新 `move_to`/`collect`/`follow` 到达时按既有语义抢占或排队（与 MC-0b 一致）。
- **用户停止优先**：`game_cancel` 先 `nav.stop`，再确认执行器已收敛。
- **反射整合（无死锁）**：每轮先读 `nav.status` 与 `events.getRecent`；出现 `reflex_preempted`/`reflex` 事件或导航被反射终止时，立即停手（`nav.stop` + 不再发起新的 `breakBlock`/`pathTo`），回执 `endReason='reflex_preempted'`，不自动重放旧命令。反射期间执行器只观察，不与反射争夺控制权。
- **自身消息回流过滤**：`chat.send` 之后，来自本机器人玩家名的聊天不得作为新的用户输入或对话刺激进入 turn；实现上优先使用 mod 事件里的发送者身份，缺失时按配置的机器人玩家名过滤（写入连接时的身份缓存）。

## 证据与回执

- `checked` 规则不变：`postCondition.kind !== 'none' && state !== 'expired'`。因此 `collect` 可被完成门用作 `tool_result` 证据（`game_checked` 桶），`say`/`follow` 不满足步骤证据（属行为/沟通）。
- 采集数量的来源顺序：**新鲜库存增量**（唯一可置信）为主；若真机发现掉落偏移、未拾取、矿物需工具等导致增量不稳定，再评估 P4 事件流（`break`/`pickup`）作为第二来源，仍以 delta 为准做后置条件。该决策在实施时以夹具数据定案并回写本规范。
- 回执字段沿用 `GameDomainResult`；`finalSnapshot` 为终态新鲜读数。

## 验收场景（环境 A：offline 专用服 + AIRI Fabric 客户端）

| 场景 | 操作 | 期望与证据 |
| --- | --- | --- |
| 采集数量 | `game_collect(blockId=oak_log, maxCount=4, radius=24)` | `checked=true`、`collected.actual>=4`、`met=true`；新鲜库存与回执一致 |
| 采集中取消 | 采集进行中 `game_cancel` | 两 tick 内停止控制意图；不再破坏方块；回执 `cancelled`，计数不虚报 |
| 跟随打断 | `game_follow(玩家)` 中插入 `game_move_to` 或 `game_cancel` | follow 终止，新命令成为唯一写动作；无重叠控制 |
| 反射抢占 | follow/collect 中触发僵尸/岩浆反射 | 回执 `reflex_preempted`，反射结束后新命令可正常执行（无死锁） |
| 聊天与回流 | `game_say("我在采集")` | 游戏内可见；自身消息不产生新的对话 turn / 不触发社交考量 |
| 补给 | 饥饿值 10 + 背包有食物 | auto-eat 反射生效（既有 MC-0d），与 collect 任务不互锁 |
| 目标丢失 | follow 目标退出/切维度 | `target_lost`，不留悬挂导航 |

## 实现落点与测试

- `shared/eventa/game-host.ts`：`GameDomainAction` 扩展。
- `main/services/airi/game-host/command-contract.ts`：`follow` 参数、digest 覆盖（自动）、后置条件映射。
- `main/services/airi/game-host/index.ts`：`DOMAIN_COMMAND_DEADLINES`、`DOMAIN_TOOLS`、`toGameCommandParams`、执行器分支、反射/取消检查。
- 渲染端 `renderer/stores/tools/game-host.ts` 不需改（描述表驱动、requestId 幂等）。
- 测试：main 执行器单测（mock MCP client：say 一次调用、collect 计数与候选切换、follow 重规划与打断、反射抢占不重放）；`command-contract` 单测（digest/后置条件）；协议冒烟脚本追加 say/collect 用例；真机走查按上表。
- 回归：MC-0c 的 21 例 main 测试与四个既有工具行为不变。

## 通过条件（自计划）

- 采集数量用采集事件/库存增量核对；新指令可打断跟随；反射与任务行为整合无死锁。
- 回执与证据遵守 MC-0c 分级；真机证据落 `docs/fork/evidence/mc-1a/`。

## 风险与回退

- `world.findBlocks` 的参数与返回形状以实施时的 mod 源码/实测为准；若语义不满足（无 limit/性能差），退化为"以 `world.raycast` + 固定步进扫描"，仍不加补丁。
- 拾取延迟/掉落偏移导致计数抖动：以 delta + 单块超时收敛；必要时启用 P4 事件第二来源。
- follow 高频重规划造成调用量上升：最小重规划间隔 500ms、只在距离变化超过阈值时规划；预算约束归 MC-1b。

## 实施记录（2026-09-12）

- 对 MC-0b 的加法修订：`GameCommandAction` += `follow`；`WRITE_ACTIONS` = `move_to`/`collect`/`say`/`follow`（follow 加入；`say` 沿用 MC-0b 已定义的写动作语义，不改为并发）；`GamePostConditionInput` 增可选 `endReason`，follow 以 `target_lost`/`reflex_preempted`/`no_progress` 判 `met=false`（kind 仍为 `none`，不构成变更证据）。
- 参数定形：`collect` = `{ blockId, itemId?, maxCount, radius }`（blockId 必填，itemId 缺省等于 blockId，maxCount ≤16、radius ≤48）；`follow` = `{ target, keepDistance ≤16, timeoutSeconds? }`。
- 执行器：`say` → `send_chat`；`collect` → `find_blocks`（center=玩家位置）→ `navigate_to` → `break_block(survival)` → 拾取轮询（库存增量，单块 5s）→ 单轮最多 3 个候选；`follow` → `query_entities` 解析目标（name/uuid/type）→ 逐腿 `navigate_to`（reachRadius=keepDistance），未命中 → `target_lost`。
- 取消：`stop` 先置位 `stopRequested`（循环检查），再 `stop_navigation` + `stop_movement`，后者按"任一确认即算停止"。
- 反射检测：导航腿内用 `navigation_status.endReason`；破坏/等待阶段用 `poll_events`（单调 `sinceId`）匹配 `preemptedCommandId`。
- 采集后置条件：handler 在 submit 前读基线，终态后用**新鲜库存增量**重算（partial 采集也如实报数）；执行器的 `collectedCount` 只作中间量。
- 租约：say 10s / collect 180s / follow 300s；工具面 7 个 `game_*`。
- 验证：game-host main 40 例（含 say/collect/follow 新用例）全绿、既有 21 例回归不变；renderer 11 例；typecheck 与 eslint 0。
- **真机夹具全套（2026-09-12）**：① 采集数量 `game_collect`（sand 1/1）PASS（`ok`/`checked:true`/`collected met`）；② 采集中取消 PASS（运行中 `game_status` 报命令 id → `game_cancel` → `cancelled`，`actual 0` 如实）；③ 跟随打断 PASS（跟随中 `game_cancel` → `cancelled`，玩家跟随移动约 11 格后停止、导航确认停止）；④ 目标丢失 PASS（uuid 目标被 `entities.remove` 后回执 `failed`/`target_lost`/`met:false`）；⑤ 反射抢占 PASS（跟随中召唤僵尸触发防御反射：回执 `failed`/`reflex_preempted`，玩家被推离，血量 20→17）；⑥ 反射后无死锁 PASS（随后 `game_move_to` 正常结算 `ok`/`checked`）；⑦ 聊天回流 PASS（`game_say` 文本出现在游戏聊天，应用聊天会话消息数不变、无新 turn）。
- 冒烟中发现并修复三个缺陷：① `game_status` 在有活动命令但尚无回执时错误回退到 `lastReceipt`（改为报告 `running` + 活动 commandId，补回归测试）；② 近距方块（≤4 格）应跳过导航——`navigate_to` 的目标是"可站立位置"，脚下方块没有可站点，近距离也会 `unreachable`（改为 ≤4 直接破坏）；③ `break_block` 的 survival 模式是**启动式** tick 挖掘（立即返回 "poll get_block to confirm"），执行器必须轮询 `get_block` 直到 air（15s/块上限）再等拾取。
- 夹具注意：单人集成服在窗口失焦时**整世界暂停**，挖掘/导航都不推进（曾误判为执行器卡死）；夹具 `options.txt` 已设 `pauseOnLostFocus:false`，重启生效（用户已确认）。夹具操作使用桥的 `entities.summon`/`entities.remove`/`world.setBlock`/`players.applyEffect` 作为管理员动作，不经模型工具面。
- 夹具注意：单人集成服在窗口失焦时**整世界暂停**，挖掘/导航都不推进（曾误判为执行器卡死）；夹具 `options.txt` 已设 `pauseOnLostFocus:false`（重启生效）。无人值守冒烟应在客户端重启后执行。

## 本轮交付与检查

本轮仅新增本规范文档并更新 MODS.md 索引。未改动产品代码、未新增 Java 补丁、未运行游戏。
