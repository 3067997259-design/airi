# R3 批次设计：主进程航路与客户端驾驶闭环

日期：2026-09-20。上游：[执行计划 §8](./elytra-flight-control-execution-plan.md)。前置：R1 PASS（三维通道）、R2b PASS（客户端逐 tick 驾驶真机门）。

## 1. 目标

把主进程从「逐 poll 用 `look`/`useItem` 远程驾驶」收敛为「任务编排 + 地图更新 + 通道交换 + 回执核对」：巡航段的每 tick 控制写入移交客户端 `FlightSession`（R2b 已真机验证），主进程只提交通道、读回执、在类型化结局上做恢复或收尾。旧写入路径只在模式关闭或桥无通道工具时保留。

## 2. 模块边界

| 模块 | 职责变化 |
| --- | --- |
| `movement/port.ts` | 新增可选通道面：`flightSubmit` / `flightStatus` / `flightRevoke` + 类型化回执形状。可选性沿用 `startJump`/`startLaunch` 的降级纪律。 |
| `movement/host-port.ts` | 按 `hasTool('flight_submit'/'flight_status'/'flight_revoke')` 挂载，映射 MCP 工具名。 |
| `flight/channel.ts`（新） | 主进程侧通道执行器：提交（含 stale_generation 用回执 `expectedGeneration` 重试一次）、游标化回执轮询、撤销、有效性判定（提交过 ∧ 已接受 ∧ 未终结 ∧ 未过期限 ∧ 修订号一致）。 |
| `flight/low-route.ts` | `planLowRoute` 增加可选 `exclude`（球形禁区）：客户端拒绝的区域回到规划器时按实体处理，通道绕开重规划。 |
| `movement/elytra.ts` | 巡航段双模式：通道模式（规划→提交→回执循环→前缀校验→落地段）与遗留模式（planner 关或桥无通道工具，行为逐字节保留）。 |
| `movement/vehicle-port.ts` | `VehicleMoveResult` 增加通道回执字段（提交数、修订数、客户端终局）。 |

## 3. 通道模式控制流（`runElytraMove`）

1. 装备与烟花预检（类型化 `unavailable`，不起飞）。
2. 目标柱顶探测（沿用覆盖语义：空读 ≠ 无顶）。
3. `planLowRoute` 全程规划（planSpaceRoute 三维 A* 输出即通道 `path`；降采样到 ~12 格间距，`entryReach` 8）。规划拒绝 = 类型化 `unavailable`，**不静默直飞**。
4. `flight_submit`（sessionId 每次新配，generation 取命令信封，revision 从 1 递增，dimension 取世界绑定，deadline = 巡航预算）。提交被拒按原因表处理。
5. 回执循环（500 ms，`flight_status` 游标推进；`observe`/`status` 不续心跳，靠客户端自身期限与看门狗豁免）：
   - 所有权丢失 → 撤销 + `unverified_stop`；取消 → 撤销 + 安全落地（cancelled）。
   - 航路点推进检测 → 每 48 格做一次前缀校验：从当前位置重规划，剩余前缀若拒绝或新路径首点偏离已提交前缀超阈值 → 撤销 + 重规划（修订 +1）。
   - 火箭耗尽且远离终点 → 撤销 + 安全落地（low_supply）。
   - 应用中位置停滞超时 → 撤销 + 重规划或安全落地。
   - 终局映射见 §4。
6. 落地段：`channel_complete` 时若仍在滑翔，以 `phase='approach'` 种子进既有落地状态机（flare/go-around/safety 全复用，R4 再把进近接进通道约束）；已接地则直接分类。

## 4. 客户端终局映射

| 客户端 endReason | 主进程处理 |
| --- | --- |
| `channel_complete` | 落地段（上）。终点判定仍由主机用位置 + 洞顶规则核实，不信任客户端宣称。 |
| `no_viable_trajectory` | 以最后轨迹样本为失败点，记录禁区（半径 24），撤销后 `exclude` 重规划一次（修订 +1）；重规划预算耗尽 → 类型化失败。 |
| `deadline` | `timeout` 收尾（安全落地）。 |
| `launch_*` / `no_elytra` 族 | `unavailable` 族类型化失败。 |
| `touchdown` | 直接进落地分类。 |
| `death` / `dimension_changed` / `disconnect` | `unknown` + 对应 failure。 |
| 提交拒绝 `session_active` / `control_busy` / `stale_generation` / `stale_control_session` | 分别：先撤销己方残留再试一次 / 等待 1 s 重试一次 / 用回执 `expectedGeneration` 重试一次 / 类型化失败。 |

MCP 停顿不延长任何前缀：游标单调，样本自带 tick；客户端期限自 enforce。

## 5. `lowRouteUsed` 移除

历史布尔（「曾经有过航路」永久为真）删除，替换为有界有效性：

- 通道模式：`channel.isActive()` = 提交 ∧ 接受 ∧ 未终结 ∧ 未过期限 ∧ 修订一致 —— 有效性来自通道、状态与期限。
- 遗留模式（planner 开、无通道工具）：最后航路带保留 `LOW_ROUTE_HOLD_MS`（3×TTL，18 s）的有限窗口，过期回落到前向扫描。历史事实不再永久改变当前安全响应。

## 6. 夹具（离线脚本世界）

| 夹具 | 布景 | 断言 |
| --- | --- | --- |
| 绕岸 | 直连带被水体/墙体封死，沿岸有连续气带 | 通道路径离开直连线绕行；终点为沿岸前沿点或目标 |
| 先升后降 | 中段山脊高于起终点带 | 路径先升后降（planSpaceRoute 可表达）；飞行完成 |
| 低顶棚 | 目标上方延伸顶棚，入口在棚下 | 路径全程棚下；不入顶棚上方 |
| 局部目标未加载 | 目标柱无读数（local 路线） | 规划 `local: true` 仍成通道；飞抵前沿后重规划；结果诚实 |

## 7. 回归共享消费者

- `elytra.test.ts` 既有用例全绿（遗留模式逐字节）。
- escort / air-follow 只共享装备与所有权助手，不触巡航段；其测试不动。
- 单写入者：通道应用期间主机零 `look`/`useItem` 写入（用例断言）。
- 世界隔离与命令回执：端口维度校验与 control 会话语义不变。

## 8. 验收

离线：`vitest`（新增 channel 单测 + 通道模式集成 + 四夹具）、`typecheck`、`lint`（新增文件零新增问题）。真机：栈在位（0.2.35 客户端 + 双桥），跑通道模式全程一次（桥面 → 河道 → 通道完成 → 落地），记录 `R3-20260920-01/`。遗留如实记录：进近段仍为主机启发式（R4）、VoxelShape 扫掠近似、TS/Java 交叉回放。
