# OV-5 鞘翅地面起飞宏：实机验收记录

日期：2026-09-18。批次：OV-5（OV 计划 §9）。模组版本：客户端 `mcpfabric-0.2.34+1.21.1`
（本次重建，产出 `versions/1.21.1/build/libs/mcpfabric-0.2.34+1.21.1.jar`，256483 字节，
部署前原件另存 `.bak-ov5`）。宿主：`@proj-airi/stage-tamagotchi` 本次重编译产物。

## 1. 被验收项（OV 计划 §9 原文逐条）

| # | 判据 | 本轮结果 |
| --- | --- | --- |
| 1 | 平地无坡起飞，交接巡航并完成降落 | **通过**：模组级两处平地起飞（平台 y=202、谷底 y=128）+ 宿主级单程飞行 `status: "reached"`（§5） |
| 2 | 可用的边缘起飞路径不回归 | 通过（离线：`elytra.test.ts` 新增「宏失败后回退边缘跑」用例仍 `reached`；未改边缘跑代码路径） |
| 3 | 低顶棚、前方障碍和未知区域得到明确处理 | **离线通过**，真机未测：`launch_unavailable` 与 `launch_terrain_unknown` 分开，`unknownColumns` 计数；低顶棚用例进 `lifecycle.test.ts` |
| 4 | 无烟花、鞘翅不可用或耐久不足时原因正确 | **通过**：无烟花真机两段（模组 `no_fireworks`、宿主 `unavailable`）；耐久真机撞到并修掉「备件换不上却报已换」的宿主缺陷（§5.3），修复后换装+飞行实机通过 |
| 5 | 每个阶段取消后有界收尾 | **通过**：四个相位真机取消（prepare/release-jump/deploy/boost）都 `cancelled` 且落地、health 20、无按键残留；handoff 后取消如实报 `done/launched`；随后复飞成功（§5.2） |
| 6 | 点火不因轮询重复提交 | **通过（真机库存核对）**：三次起飞各消耗 1 枚烟花（54 → 53 → 52 → 51），宏 `fireworksUsed` 均为 1，`launchFromGround` 只提交一次点火 |
| 7 | 单程飞行与空中跟随都实际调用新起飞路径 | **单程飞行真机通过**（§5：探针断言轨迹含 `elytra launch phase=` 与 `deployed via launched`）；空中跟随同函数同路径，真机未单独跑 |

## 2. 离线部分（已跑）

新增/改动与用例：

| 文件 | 内容 |
| --- | --- |
| `movement/launch.ts`（新） | 起飞宏客户端：单次提交 + 轮询 + 类型化判定；`deployed` 与 `outcome` 分开，部署成功但点火失败不算失败重来 |
| `movement/launch.test.ts`（新，8 例） | 无宏返回 `undefined`；单次点火；无烟花传 `withFireworks: false`；`failed/not_deployed`；取消；失去租约取消；先取消则不提交；宏不回答报 `unavailable` |
| `movement/port.ts` | `ElytraLaunchTask` / `ElytraLaunchStatus` / `startLaunch?` / `launchStatus?` / `cancelLaunch?` |
| `movement/host-port.ts` | 三个工具齐全才挂载；`launchStatusOf` 映射；`host-port.test.ts` 新增「三缺一不挂载」用例 |
| `movement/elytra.ts` | 起飞分支先走宏，失败/无宏回退边缘跑；交接后重读状态（OV-D17 新鲜度） |
| `movement/air-track.ts` | 同一条宏路径；**顺带修掉本路径原有的「按住前进+冲刺直接按 jump」缺陷**（E-01 已定性的根因） |
| `flight/lifecycle.ts` | `LaunchColumnProbe`（`surface`/`void`/`unknown` 三分）、`LaunchKind`（`flat`/`edge`）、`prefer` 排序、`flatCeiling` 需求、`launch_terrain_unknown` |
| `flight/lifecycle.test.ts` | 9 例（平地合格、低顶棚拒绝、边缘合格、无净空拒绝、落差不足不再选边缘、走廊拒绝、未知不当作悬崖、未知区域报 `launch_terrain_unknown`、`prefer: 'edge'` 生效） |
| `game-host/index.ts` | `probeLaunchSite` 读高到 `flatCeiling`，返回 `LaunchPlan`；`assessHostAirLaunch` 记 warn |

命令与结果：

```powershell
pnpm -F @proj-airi/stage-tamagotchi typecheck      # 无 error TS
pnpm exec vitest run apps/stage-tamagotchi/src/main/services/airi/game-host
# Test Files 60 passed | 1 skipped (61)；Tests 862 passed | 1 skipped (863)
```

## 3. 真机部分（模组级，两次通过）

驱动脚本：`D:\mcpfabric\mcp-server\e2e-launch.mjs`（提交一次 `elytra_launch`，每 120 ms 读
`elytra_launch_status`，终态后按 `observeMs` 继续读 `get_self`，整段落盘 JSON）。

### 3.1 主测试台平地起飞（平台 y=202）

```powershell
node e2e-client.mjs 25602 teleport_player '{"player":"airitest","x":238.5,"y":202,"z":-17}'
node e2e-launch.mjs "...\platform-flat-run1.json" 200 195 -17 25600 5000
```

阶段轨迹（`phase` / `ticks` / 高度）：

| t | phase | ticks | y | vy | deployed | boost |
| --- | --- | --- | --- | --- | --- | --- |
| 171 ms | release-jump | 3 | 202.42 | 0.333 | false | false |
| 315 ms | boost | 6 | 203.14 | 0.142 | **true** | false |
| 451 ms | boost | 8 | 203.36 | 0.097 | true | false |
| 596 ms | handoff | 9 | 204.70 | **0.871** | true | **true** |

终态 `done / launched`，`ticks=9`，`fireworksUsed=1`，`climb=1.42`；随后 5 s 内滑翔爬升到
y=295、x 238→156（向西），全程 `fallFlying=true`。烟花库存 54 → 53。

### 3.2 谷底平地起飞（峡谷底 y=128）

选点：`node flat-pad.mjs -480 -458 26 42 110 150 25602 8` 找到 3×3 全平、支撑
`grass_block`、净空 ≥10 的台面 `x=-469..-467, z=36..38, y=127`；`get_blocks_region` 复核该列
y=128..170 全空（43 格净空）。

```powershell
node e2e-client.mjs 25602 teleport_player '{"player":"airitest","x":-468.5,"y":128,"z":37}'
node e2e-launch.mjs "...\valley-flat-run1.json" -468 128 28 25600 5000
```

终态 `done / launched`，`ticks=9`，`fireworksUsed=1`，`climb=1.40`；随后 5 s 爬到 y=222，
`fallFlying=true`。烟花库存 53 → 52。

两次的阶段顺序均为 `prepare → jump → release-jump → deploy/boost → handoff`，无重复点火。

### 3.3 顺带观测（不是本批判据，留给 E-02 核对）

- 单枚烟花后整段爬升约 90 格（202→295、128→222）。上升段 vy 约 1.0 格/tick 持续 35 tick，
  之后速度衰减期仍以约 32° 仰角继续换取高度（rocket boost 沿视线、目标速度 1.5 倍，
  结束前速度仍在 1.2 以上）。这与 E-01 档案的「35 tick 助推平台」一致，但**档案没有覆盖
  助推结束后的减速爬升段**，E-02 若做能量/高度预算需要把这一段计入。
- `get_self` 的 `motion` 只有水平分量时才看得出方向。谷底那次几乎不动 x（瞄准方向近南北），
  单看 x 会误判为「垂直爬升」；记录时按三维位移判断。
- 部署确实可以由「按住 jump」触发：`release-jump` 采样点（第 3 tick）已见 `deployed=true`。
  这与 `javap` 反编译一致（`LocalPlayer.aiStep` 用 `input.jumping` 电平判定 + `!jumpedThisTick`
  + `!onGround` 三个条件，不是 `consumeClick` 边沿）。宏保留「释放一 tick 再按」的循环，
  在两种语义下都成立。

## 4. 实机暴露并修掉的三个宿主缺陷（宿主级）

第一次走 AIRI 的 `game_move_to`（`vehicle: elytra`）时，回执只有
`endReason: "search_budget"`、位置一点没动。追下去发现两层问题：

**缺陷 A（宿主读不到副手）**：`host-port.ts` 的 `getInventory` 只遍历 `hotbar` 与 `main`，
副手槽不进列表。发射宏把火箭放进副手之后，带 52 枚烟花的 bot 被判定为
`no firework rockets in the inventory`，`runElytraMove` 直接 `unavailable`。
实测证据：`runElytraMove` 对真实桥返回 `{"status":"unavailable","detail":"no firework rockets in the inventory"}`。
修复：把 `offhand` 作为槽位 40 读进列表（`InventoryHandlers.toMenuSlot` 的约定是
0-8 快捷栏 / 9-35 主栏 / 36-39 护甲 / **40 副手**，其它值直接报错，所以 40 是线上唯一能命名副手的数字）。

**缺陷 B（宏把整叠火箭搬进副手）**：`equipRocketOffhand` 原本用两次 PICKUP-button-0
点击把**整叠**搬到副手（沿用弩的 B-08 写法）。巡航推进是「选中快捷栏槽 + 主手 use」，
整叠被搬走之后飞行再也没法点火，而且副手叠在旧的宿主读法里根本看不见。
修复：`containerClick` 增加 button 参数；宏改为「拿起整叠 → 右键放 1 枚进副手 → 余下放回」，
并且在主手已持火箭时直接用主手（宿主推进路径本来就把火箭选在主手）。

**缺陷 C（宿主把飞行失败吞掉）**：`fallbackToFoot` 走到步行分支后，回执只报步行自己的
`endReason`，`vehicle_unavailable` 与具体 detail 全部丢失——所以 AIRI 对被拒的起飞报告的是
「寻路搜索预算耗尽」。修复：`GameExecutorOutcome.vehicleAttempt`（`{status, failure?, detail?}`）
随回执落盘，两种结局（步行成功/失败）都带。

**顺带**：`selectBySuffix` 返回 `undefined` 不再等于「没有弹药」——
`runElytraMove` / `runAirTrackMove` 改为「既没有可选中栈、又确实一枚都没有」才拒绝；
只有副手有火箭时照常起飞，推进拿不到槽位时按 `low_supply` 如实收尾。

## 5. 宿主级单程飞行（实机通过，2026-09-18 晚）

探针：`apps/stage-tamagotchi/src/main/services/airi/game-host/movement/elytra-live.integration.test.ts`
（无 LLM：自己建生产端口 `createMcpMovementPort` + `hasTool` 发现，然后直接跑 `runElytraMove`）。

```powershell
$env:MCPFABRIC_URL = 'http://127.0.0.1:25600/mcp'
$env:OV5_GOAL = '150,120,-17'
pnpm -F @proj-airi/stage-tamagotchi exec vitest run \
  src/main/services/airi/game-host/movement/elytra-live.integration.test.ts
```

两次运行都 `status: "reached"`（约 19.5 s）。完整轨迹见 `host-path-live.log`，起飞段：

```
elytra launch phase=deploy  ticks=5 deployed=false vy=0.165 climb=1.00
elytra launch phase=handoff ticks=9 deployed=true  vy=0.516 climb=1.42
elytra launch handed over after 9 ticks, climb 1.42, 1 rocket(s)
elytra deployed via launched (launch macro done/launched at handoff)
elytra fly y=203.4 h=83.4 d=88.5 vy=0.52 pitch=0.0 fw=51   ← 巡航第一次读，fw 从 52 变 51
...
result {"status":"reached"}
```

判据落点：**平地起飞走宏**（`elytra launch phase=` 与 `deployed via launched` 都被断言）、
**单次点火**（52 → 51）、**交接巡航并完成降落**（`reached`）。
平台起飞点仍为 (238.5, 202, −17)；目标 (150, 120, −17) 在峡谷上方，实际降落在 y≈95 的地面。

### 5.1 AIRI 侧同一条路径（用户可见入口，2026-09-18 22:19）

以管理员 AfterRain 身份发一条聊天指令（`node chat-send.mjs 25599 "…game_move_to, vehicle: elytra, fallbackToFoot: false, 目标 150 120 -17…"`），
AIRI 自己调用 `game_move_to`，宿主日志（AIRI `terrain:` 前缀）逐行对上宏：

```
14:19:41 terrain: elytra launch phase=deploy  ticks=5 deployed=false vy=0.165 climb=1.00
14:19:41 terrain: elytra launch phase=handoff ticks=9 deployed=true  vy=0.746 climb=1.42
14:19:41 terrain: elytra launch handed over after 9 ticks, climb 1.42, 1 rocket(s)
14:19:41 terrain: elytra deployed via launched (launch macro done/launched at handoff)
14:19:41…14:20:01 terrain: elytra fly … fw=52→48   ← 巡航推进 4 次（跨峡谷）
```

工具回执：`endReason: "reached"`，`finalSnapshot.position = (149.18, 95, -17)`，`health: 20`，
`heldItem: minecraft:firework_rocket`。**注**：整体 `status` 是 `failed`、`postCondition.met: false`
（`actual: 25.01`），因为指令目标高度 y=120 在峡谷地面（y≈95）之上，三维距离永远满足不了 1 格阈值——
这是既有的落地后条件语义，不是飞行失败；飞行本身按 `endReason: reached` 完成。

### 5.2 逐阶段取消（真机，同晚）

驱动脚本 `D:\mcpfabric\mcp-server\e2e-launch-cancel.mjs`：提交一次 `elytra_launch`，等
`cancelAfterMs`，调 `elytra_launch_cancel`，再读状态与 1.5–2 秒后的玩家状态。相位每 tick 推进
（约 50 ms），所以延时就是相位选择器。

| 延时 | 取消时相位 | ticks | deployed | 取消结果 | 2 秒后 |
| --- | --- | --- | --- | --- | --- |
| 0 ms | prepare | 0 | false | `cancelled` / `cancelled` | 站在原平台、无位移、health 20 |
| 150 ms | release-jump | 3 | false | `cancelled` / `cancelled` | 落地、health 20 |
| 220 ms | deploy | 5 | false | `cancelled` / `cancelled` | 落地、health 20 |
| 300 ms | boost | 6 | true | `cancelled` / `cancelled` | 落地、health 20 |
| 450 ms | handoff | 9 | true | **`done` / `launched`**（宏已结束，取消是空操作） | 仍在滑翔 |

四次取消之后立刻复飞：`done/launched`、9 tick、`fireworksUsed: 1`、`climb 1.25`
（`cancel-recovery-launch.json`）——**没有卡死，按键全部释放**。
记录：`cancel-0ms.json` / `cancel-150ms.json` / `cancel-220ms.json` / `cancel-300ms.json` /
`cancel-450ms.json`。

### 5.3 无烟花与耐久不足（真机，同晚）

**无烟花**（`clear airitest minecraft:firework_rocket` 清掉 46 枚，测完 `give` 复原）：

- 模组级：宏照常跳到展开，然后在 boost 相位如实失败 —— `failed / no_fireworks`、
  `fireworksUsed: 0`、`boostPressed: false`、`deployed: true`（`nofireworks-mod.json`）。
- 宿主级：`runElytraMove` 在起飞前拒绝 —— `{"status":"unavailable","detail":"no firework
  rockets in the inventory"}`（探针因此按预期失败，locator 行即证据）。

**耐久不足**（真机暴露第四个宿主缺陷并修掉）：

1. 把 431/432 的旧鞘翅穿到胸口。**431/432 的鞘翅飞不起来**：`ElytraItem.isFlyEnabled` 要求
   `damage < maxDamage - 1`，所以展开条件永远不成立。
2. 旧代码 `equipElytra` 认为背包里的无耐久鞘翅是合格备件，调 `swapSlots(backup, 38)` 换装并
   返回“已换好”。**四个护甲位索引（36/37/38/39）实机全都不生效**：调用回 `swapped`，胸口纹丝不动
   （逐索引实测）。于是飞行以 `not_deployed` 收场，而回执说鞘翅已换。
3. 修复：新增 `wearFromHotbar` —— 把备件换进**空快捷栏**、选中、`use_item`（vanilla 会把鞘翅穿上
   身体），然后**核对胸口确实换了件**（damage 与原来不同）才算成功；最后一个分支才退回旧的护甲写。
4. 修复后实机复跑（胸 431 / 备件在手 / 快捷栏 6 空）：`elytra launch phase=deploy → boost →
   handoff`，`handed over after 9 ticks, 1 rocket`，`result {"status":"reached"}`；跑完
   **胸口 = 无耐久鞘翅、快捷栏 6 = 旧 431 件**（vanilla 换装的回流），烟花 46 → 45。
   记录：`durability-worn-with-spare.log`。

同一条 `use_item` 换装路径也是**穿护甲的唯一可用办法**（`swap_slots` 写不了护甲位）；已写进
`elytra.ts` 的 NOTICE，移除条件是桥接按真实顺序映射护甲索引。

## 6. 本轮没做的事（明确边界）

- **低顶棚 / 前方障碍 / 未知区域的真机场景未测**：判据只有离线用例。真机需要另找三处场地
  （带顶棚的平地、正前方一堵墙、未加载边界）。
- **耐久不足里「施损但可飞」的那一档（比例 0.75–0.9，只做就近降落）没有真机样本**：本世界随时
  带着无耐久备件，`equipElytra` 会直接换装，走不到那一档；离线由 `elytra.test.ts` 的
  「lands early when the elytra wears down in flight」覆盖。
- **逐阶段取消的真机测试未做**：只测了「提交前已取消」与「失去租约」两条离线路径。
- **无烟花 / 鞘翅不可用 / 耐久不足的真机路径未测**：宏侧 `no_elytra`/`no_fireworks` 只在
  离线假 port 与代码审查层面成立。
- **边缘起飞真机未复跑**：判据是「不回归」，本轮以「边缘跑代码未改 + 离线回退用例通过」举证，
  不是真机复跑。
- **空中跟随的真机起飞未单独跑**：与单程飞行共用 `launchFromGround` 与同一宏工具，判据靠同路径
  推断 + 离线用例，不是真机复跑。
- **装备/护甲槽位经桥接交换仍是坏的**（独立批次）：`InventoryHandlers.toMenuSlot` 把 36..39
  文档成「helmet..boots」，而 `Inventory` 的真实顺序是 boots/leggings/chestplate/helmet，
  所以 `swap_slots` 写护甲位会落到别的槽；OV-5 不受影响（宏不换护甲，宿主 `equipElytra`
  只在需要换备件时才调它）。
- LR-3（能量管理）与 LR-4（走廊捷径 / 绕行系数进 D2）仍未实施。

## 7. 环境与工具（本轮新增，供下一批复用）

| 工具 | 用途 |
| --- | --- |
| `D:\mcpfabric\mcp-server\e2e-launch.mjs` | 直接驱动模组宏：提交一次 `elytra_launch`，逐拍读状态并落盘 JSON |
| `D:\mcpfabric\mcp-server\bridge-rpc.mjs` | 直接对某个客户端桥（如 25599）发 RPC；`@file` 形式绕开 cmd 去引号 |
| `D:\mcpfabric\mcp-server\chat-send.mjs` | 以该客户端玩家身份发一条聊天（AIRI 指令入口；bot 无法给自己下指令） |
| `D:\mcpfabric\mcp-server\flat-pad.mjs` | 在一个盒子里找 3×3 全平且净空达标的起飞台 |
| `elytra-live.integration.test.ts` | 无 LLM 的宿主级起飞/巡航/降落探针（`MCPFABRIC_URL` 未设则跳过） |

当前环境状态（2026-09-18 晚）：服务端 25565、bot 客户端 25601（`airitest`）、bot MCP 25600、
服务端 MCP 25602、AfterRain 客户端 25599、AIRI（CDP 9222）都在线且为最新代码；
两个客户端 mods 目录都已放新 jar（`.bak-ov5` 为部署前副本）。
