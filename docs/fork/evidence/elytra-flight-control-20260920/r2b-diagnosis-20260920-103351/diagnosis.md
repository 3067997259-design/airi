# R2b 未起飞诊断

日期：2026-09-20。范围：检查现有实现与失败证据，读取客户端状态，离线调用已构建的纯 Java 飞行模块。

本轮没有修改 AIRI/MCPFabric 生产代码，没有提交、部署、重启、传送、补给、起飞或撤销会话。新增文件只在本目录。未重新执行原 `verify.mjs`，因为它会改变角色状态并覆盖原证据。

## 1. 结论与证据

本次直接阻断点是控制生命周期没有接通：`flight.submit` 不刷新控制心跳，旧看门狗在起飞宏第一次执行前取消了宏；飞行会话没有接收取消结果，又没有在 ACCEPTED 状态执行 deadline，因而永久等待。

原证据 `../R2b-20260920-01/r2b-simple-channel-20260920.json`：提交 accepted=true、pathPoints=3；30 次轮询均为 ACCEPTED / applyingStarted=false；位置始终为 (-1007, 74, 79)。轨迹样本不断增加，说明客户端 tick 和读取链路正常。

北京时间 10:33:51 首次只读观测：

```json
{
  "session": {
    "id": "r2b-1789870911632",
    "state": "ACCEPTED",
    "applyingStarted": false
  },
  "launch": {
    "state": "cancelled",
    "endReason": "bridge_timeout",
    "phase": "idle",
    "ticks": 0,
    "airborne": false,
    "deployed": false,
    "boostPressed": false,
    "fireworksUsed": 0
  }
}
```

同次读取确认胸甲槽为 elytra、主手为 16 发 firework_rocket、onGround=true。后续独立读取仍为同一会话与同一失败原因，完整结果保存在 [live-observation.json](./live-observation.json)。背包另有一件 damage=431/maxDamage=432 的鞘翅；它不在胸甲槽，不应据此断言本次穿戴的鞘翅已经损坏。

配置实读：`heartbeatTimeoutMs=30000`、`enablePlayerControl=true`，客户端桥端口 25601。

构建与客户端 mods 目录中的 jar SHA-256 一致：`c55fff783953f208edabb283ec3fe46c31e14e38b39af883ec2d57cbb788d02f`。部署文件时间为 10:20:47，Java 客户端候选进程启动时间为 10:20:52。`javap` 确认这个 jar 包含 equipElytraChest → startLaunch 的 R2b 驱动。哈希是磁盘产物证据，不是 JVM 内存类哈希；本次直接故障定位来自同一会话的实时状态。

## 2. 为什么起飞宏连一个 tick 都没执行

源码位置均相对 `D:/mcpfabric`，行号对应本轮读取版本。

| 环节 | 代码位置 | 当前行为 |
| --- | --- | --- |
| 控制请求分类 | `src/main/java/dev/mcpfabric/bridge/RpcRouter.java:30` | 心跳只认 control/nav/combat/movement/interact 前缀，缺少新的飞行写操作。 |
| 提交飞行 | `src/client/java/dev/mcpfabric/client/handlers/FlightHandlers.java:25` | 直接创建飞行会话，没有建立与旧控制生命周期的交接。 |
| 启动宏 | `src/client/java/dev/mcpfabric/client/flight/FlightController.java:193` | 调用 startLaunch 后把 launchRequested 置为 true。 |
| tick 顺序 | `src/client/java/dev/mcpfabric/client/McpFabricClient.java:54` | 先注册 ClientControlGuard，再注册 BotController tick。 |
| 心跳看门狗 | `src/client/java/dev/mcpfabric/client/ClientControlGuard.java:75` | 只看最后控制请求；读状态不会续期。发现 isDriving 且超时即 clearControls。 |
| 清理宏 | `src/client/java/dev/mcpfabric/client/BotController.java:1856` | 将 running 宏变成 cancelled / bridge_timeout，phase 置 idle。 |

与观测一致的事件链：

1. 最近一次旧控制请求已经超过 30 秒；`flight.submit` 没有更新这个时间。
2. FlightController 在 BotController 的 tick 后段请求 startLaunch。宏进入 running，ticks=0，等待下一 tick。
3. 下一 tick，先执行的 ClientControlGuard 发现旧心跳超时，把宏取消。
4. BotController 因宏不再 running，跳过 tickLaunch，因此 ticks 仍为 0。
5. FlightController 已记 launchRequested=true，不会再次发起宏，也不读取宏的取消结果。

这是源码与实时观测共同支持的因果链。没有对原失败过程做额外控制调用或重放。

## 3. 为什么失败一直显示 ACCEPTED

`FlightController.java:149` 只在 RUNNING 检查 deadline。`driveSession` 在未滑翔时仅检查装备和是否需要首次启动宏，不处理 failed/cancelled。

此外，`ClientControlGuard.clearControls` 只清 BotController 和 ControlOwnership，没有结束 FlightController。因此旧宏已取消，新会话仍在等待。原测试总时长 60 秒短于提交的 90 秒 deadline；后来同一个会话超过 deadline 仍为 ACCEPTED，已由只读观测确认。

继续运行原脚本还可能遇到第二个假象：新 sessionId 被 `session_active` 拒绝。脚本不检查 accepted，也不核对返回 sessionId，随后会继续观察旧会话。

## 4. 修好起飞后仍需处理的缺陷

下列问题与本次 0 tick 阻断分开记录，不将它们冒充当前未起飞的原因。

| 优先级 | 发现 | 证据与影响 |
| --- | --- | --- |
| P0 | 撤销未停止驱动 | `FlightController.java:473` 的 revoke 只改状态，没有清除 session；`:167` 驱动只检查 session 非空且未完成。撤销后仍可写姿态/点火，首次滑翔甚至可重新置 RUNNING。需保证终态不能再进入驱动。 |
| P0 | 宏和驾驶器同时写输入 | `BotController.java:1985` 先执行宏，`FlightController.java:199` 只要 gliding 就接管。此时宏可能还在 boost 阶段，尚未完成点火与爬升；同 tick 后执行的驾驶器能覆盖宏的爬升姿态。必须按宏成功交接事实切换所有者。 |
| P1 | yaw 坐标少了 90° 转换 | `FlightSession.java:143` 直接把 atan2(dz, dx) 当 Minecraft yaw；同仓 `BotController.aimForClimb` 有减 90°。离线调用当前 jar：目标正东，期望 yaw=-90，实际选 -15，偏差 75°。 |
| P1 | 跳过首个未到达航路点 | `FlightSession.java:109` 返回 path[entryIndex+1]，推进索引却检查 path[entryIndex]。离线调用当前 jar：首点 (100,80,0)，返回目标 (200,80,0)。脚本首点距起点约 49.5 格，不能默认已接入。 |
| P1 | 起飞推进状态仍未交接 | `FlightSession.java:202` 每次预测都以 rocketTicksRemaining=0 开始；控制器没有传入真实剩余推进。起飞宏消耗的烟花也没有更新驾驶器的点火冷却。 |
| P1 | 默认终止结果仍被应用 | FlightSession 在无候选、完成、deadline 分支返回默认 yaw=0/pitch=0；`FlightController.java:213` 后无条件写入。终止结果必须与可执行控制结果分开。 |
| P1 | 轨迹点火记录不覆盖实际驱动 | 驾驶器和起飞宏直接 useItem；rocketFiredThisTick 只在显式 flight.boost 路径写 true。即使真实起飞，原脚本 fireSamples 也可能仍为零。 |
| P2 | entryReach 参数没有消费 | 脚本传 12；submit 创建默认 Params，实际仍为 6。回显参数不等于采用参数。 |

两项纯 Java 反例见 [replay.java](./replay.java) 与 [replay.log](./replay.log)。它们直接加载当前构建 jar 中的 FlightSession/FlightDynamics，没有复制算法或连接游戏。退出码 1 是预期复现失败；Fabric 注解缺失警告没有阻止类加载，两项断言均实际执行。

复现命令（PowerShell）：

```powershell
& 'C:\Program Files\Java\jdk-21\bin\java.exe' --class-path 'D:\mcpfabric\versions\1.21.1\build\libs\mcpfabric-0.2.34+1.21.1.jar' 'D:\airi\docs\fork\evidence\elytra-flight-control-20260920\r2b-diagnosis-20260920-103351\replay.java'
```

## 5. 建议的修复顺序与完成门

### 第一步：完成飞行会话的控制生命周期

1. 在通过权限、会话与代次校验后，让接受的飞行写操作建立有效控制授权。区分 submit/boost/revoke 与 observe/status，读请求保持不续期。
2. 明确有限自主通道与旧桥心跳的关系：通道有效期内由客户端按 deadline 驱动，并保留断线/死亡/撤销等终止条件；若选择显式租约，则定义租约期限和耗尽后的后备行为。仅给前缀补上 flight. 不能完成这项设计，因为它会让观测续期，也不能证明断 MCP 时的执行期限。
3. 统一终止入口：取消宏、阻止后续姿态和点火写入、清理待执行 session、记录准确 endReason。ACCEPTED/准备/起飞阶段也执行 deadline。
4. 宏 failed/cancelled 时及时结束飞行会话；不要用每 tick 重启宏来掩盖看门狗冲突。
5. 飞行驾驶接管必须发生在宏成功交接后，继承实测位置、速度、推进剩余量及点火事实。起飞目标使用可接入的首段方向，当前 startLaunch 传玩家自身位置不会提供航路方向。

完成门：空闲超过 30 秒后提交仍可进入起飞；宏失败或被撤销时会话及时终止；准备阶段超时也终止；撤销确认后没有驾驶输入再写入。旧控制停止规则与新有限自主通道规则均需覆盖。

### 第二步：修复局部驾驶的确定性错误

先让本目录两个纯 Java 反例转绿；再验证 waypoint 推进顺序、终止时不应用默认姿态、推进交接、唯一输入所有者和 entryReach 的实际消费。不要通过加密主机轮询来修复 Java 内部的问题。

### 第三步：让真机脚本能判定失败

原脚本主要问题：

- 不检查工具 isError、accepted、sessionId，也不读取 launch 状态。
- 只用 get_self 检查起点，缺少装备耐久、生命值、宏/会话占用与通道可接入检查。本次实读 health 约 5.69，后续场景应恢复并记录有效前置状态。
- `flight_status {}` 总从 sinceTick=0 读取，newSamples 实际是重叠样本。应推进游标，并区分缓冲区覆盖与消费者真正漏读。
- fireSamples 来源不覆盖实际点火路径；须先修生产观测，再据此判定。
- 注释称有断言和 MCP stall 验证，实际只计算距离趋势，没有输入应用期限断言或明确的中断场景。
- 60 秒结束时不清理自己拥有的会话，失败仍 process.exit(0)，重复运行覆盖同名证据。
- 路径未经 R1 通道验证，不应把这份手写路径称为已验证通道。

修改脚本时记录原始逐 tick 轨迹、launch 转移、会话 ID、构建摘要和断言结果；失败返回非零，输出用唯一文件名。清理只作用于脚本自己创建的会话，并核对终止确认。

## 6. 验证边界

已完成：原证据核对、两次只读 MCP 观测、配置限定字段读取、磁盘 jar 哈希比对、jar 字节码接线检查、两项纯 Java 失败复现。

仓库检查：`git diff --check` 通过；`pnpm type-check` 失败，因为根 package.json 没有此命令（实际名称为 typecheck，本次未运行完整工作区类型检查）；`pnpm lint` 报 72 项错误，包含既有 R2a/R2b 验证脚本及 OV-5 JSON 文件。没有替实现模型修改这些文件，也不将工作区检查记录为通过。

未完成：应用修复、重新部署、真实起飞回归、撤销后零输入的真机验证，以及完整 R2b 验收。本报告不能作为 R2b PASS 证据。
