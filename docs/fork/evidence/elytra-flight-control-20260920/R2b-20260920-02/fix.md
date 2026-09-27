# R2b 修复批（R2b-20260920-02）

日期：2026-09-20。范围：按 [R2b 诊断](../r2b-diagnosis-20260920-103351/diagnosis.md) 的修复顺序实现控制生命周期与确定性驾驶修复。

状态：离线修复完成；真机 R2b 门已通过（2026-09-20，jar 0.2.35）。本轮没有 Git 提交；旧证据（`R2b-20260920-01`、诊断 replay）未改写。

## 1. 控制生命周期（诊断第一步）

| 修复 | 位置 | 内容 |
| --- | --- | --- |
| 心跳分类 | `src/main/java/dev/mcpfabric/bridge/RpcRouter.java` | `flight.submit/boost/revoke` 进入控制方法集合（续期心跳）；`flight.observe/status` 不续期。没有给 `flight.` 前缀整体放行。 |
| 有限自主窗口 | `FlightController.hasLiveChannel()`、`client/ClientControlGuard.java` | 心跳看门狗跳过活动通道：通道有效期内客户端按 deadline 自行驱动；死亡、断线、换维度、撤销仍是终止条件。控制器在看门狗之后同一 tick 处理过期 deadline，结束原因保持 `deadline`。 |
| 统一终止 | `FlightController.terminateIfActive()`、`externalStop()` | 一个入口完成：置终态、取消起飞宏、清 session 引用。`revokeChannel` 与看门狗清理都走它；`applyingStarted` 保留为"曾写过输入"的事实。 |
| 宏失败即结束 | `FlightController.driveSession()` | 宏 `failed/cancelled` 时不再每 tick 重启宏，按 `launch_<原因>` 结束会话；宏交接后落地记 `touchdown`。 |
| 准备阶段 deadline | `FlightController.onClientTick()` | deadline 在 `ACCEPTED` 与 `RUNNING` 都生效（原来只在 `RUNNING`）。 |
| 交接等待 | `FlightController.driveSession()` | 宏运行期间不写姿态；等 `done/launched` 交接后才开始驱动。修复"刚开始滑翔就接管"。 |
| 唯一写入者 | `FlightController.submitChannel()`、`BotController.hasActiveInputTask()` | 旧驱动运行中提交返回 `control_busy`；`ControlOwnership.accept` 复用，撤销或陈旧序列返回 `stale_control_session`。 |
| 控制开关 | `client/handlers/FlightHandlers.java` | submit/boost/revoke 与既有 movement 驱动一致检查 `enablePlayerControl`。 |
| 起飞方向 | `FlightController.driveSession()` | `startLaunch` 改用首个未到达航路点，不再传自身位置（自身位置没有方向）。 |

## 2. 确定性驾驶修复（诊断第二步）

| 修复 | 位置 | 内容 |
| --- | --- | --- |
| 首航路点 | `FlightSession.currentTarget()`、`advanceEntries()` | `entryIndex` 表示"正在飞的航路点"，首个未达航路点不再被跳过。 |
| yaw 转换 | `FlightSession.bearingTo()` | 使用 `atan2(dz, dx) - 90°`，与 `BotController.steer/aimForClimb` 一致。正东目标由 -15° 修为 -90°。 |
| 终态不写默认姿态 | `FlightSession.Decision.applicable` | done、deadline、channel_complete、no_viable 的决策不再可应用；控制器只在 `applicable` 时写 yaw/pitch/fire。预算耗尽且零候选时不判死，下一拍重试。 |
| 推进交接 | `FlightController.driveSession()`、`FlightSession.tick()` | 预测初始 `rocketTicksRemaining` 使用实测剩余量；点火冷却按宏点火时刻回填，不在交接时归零。 |
| entryReach 消费 | `FlightController.paramsFromChannel()` | `channel.entryReach`（1..64）进入 `FlightSession.Params`；submit 响应与 status 回显实际采用值。 |
| 点火记录 | `FlightController.trackLaunchIgnition()`、`recordTick()` | 宏点火按 `launchFireworksUsed` 增量进入环样本；驱动点火直接标记。`inputOwner` 如实为 none / launch-macro / flight-session。 |
| 模拟预算 | `FlightSession.tick()` | `simBudgetMs` 生效；预算内选优，超预算保留已有最优，零候选不判死。 |

## 3. 离线验证

- 五项反例断言全部转绿：`replay-fixed.java` → `replay-fixed.log`（首航路点、正东 yaw、entryReach 采用、终态不应用、推进交接）。
- Java 构建：`:1.21.1:build` BUILD SUCCESSFUL；jar `0.2.35`，SHA-256 `AAEB0280B3B0083B5EF5FD5F3CA10F16F9D577737131C870093F416E26DFBA0D`（未部署）。
- mcp-server：typecheck 与 build 通过。
- AIRI game-host 套件：927 通过 / 1 跳过 + 1 计时抖动失败；定向重跑该用例通过。本批未改 AIRI TS 代码，详见 [checks.md](./checks.md)。
- 真机（0.2.35 部署 + 客户端重启）：R2b 门 PASS。`channel_complete`、终点距离 3.99 格（entryReach 12）、3.5 s MCP 停顿后 92 个新样本、游标滞后最大 1 tick、2 次点火记录、撤销后无驱动。第一次运行的脚本门缺陷与出河道路径单独记录在 [verdict.md](./verdict.md)。

## 4. 范围与遗留

- 通道为 `probe-surface.mjs` 地表扫描得出的手写诊断路径，不是 R1 规划器输出；`channelSource: hand-written-diagnostic`，R3 接入 R1 通道时另测。
- 碰撞检查仍以"格 id 是否 air-like"实现姿态盒扫掠，不是完整 VoxelShape 扫掠。
- TS/Java 交叉回放与不同推进剩余量的补测未做。
- 胸甲鞘翅耐久客户端不可读；本批只按"胸甲已穿鞘翅或存在健康备件"做前置门。
- 宏 boost 阶段的精确推进剩余量仍为估计（客户端不可读）；交接时传递该估计与点火事实。
