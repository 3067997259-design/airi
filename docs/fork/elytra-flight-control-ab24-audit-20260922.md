# ab-24 实现验收与下一步

日期：2026-09-22。范围：当前源码、`cave-ab-24.jsonl`、`ab24-diagnostic.md`、相关回归。本次未修改生产代码，未部署、操作 bot 或提交。

**验收结论：有明确进展，但不接受“四批全部完成、分腿臂已是一对干净诊断”的结论。暂停三对复现，先补实现与门控缺口。** 两臂受控跨过 z=20 是真实改善；完整臂可见伤害 2.72242、分腿臂零可见伤害及最终稳定接地也有日志支持。但当前门控不足以证明完整几何检查、在期限内收尾及符合河道截面要求。

## 1. 可以确认的成果

- 正常航路候选已按预测状态刷新参考和动作，并加入绝对平飞、拉起策略。ab-23 的四种俯冲候选缺口已得到实质修正。
- 两臂真实向前跨过 z=20：完整臂 tick 9879，分腿臂 tick 10207，均为 flight-session、滑翔、未入水。
- 夹具已将终态处理放在提交下一腿之前。本次没有失败后继续自动提交的日志证据。
- 主机已区分路线结束与物理控制释放，显式取消能到达恢复阶段。
- 每 tick 拒绝计数和累计伤害已分开；完整臂掉血后回血不再抹掉 2.72242 的下降。
- 两臂最终分别有 20、23 个连续稳定接地 tick。本次样本 tick 连续；这不等于全程安全，也不能单独证明在硬期限前结束。
- D2 两个测试覆盖了“端点在预测范围内/外”的基本语义，避免将所有差异都归责交接。它们不是复杂弯道、真实交接和完整状态一致性的充分证明。

本次新跑主机 `ending-stats`、`leg-offer`、`channel`、`touchdown`：4 文件，36 用例通过。另直接编译生产 FlightOwnership/FlightDynamics，执行下述离线探针成功。未重跑完整 Java/TS 套件或真机。

## 2. P0：恢复没有执行完整三维轨迹检查

位置：`D:/mcpfabric/src/client/java/dev/mcpfabric/client/flight/FlightController.java:450-478`，以及 `FlightRecovery.java:Inputs/decide`。

目前恢复仍先向下扫描，然后直接返回启发式俯仰和点火。它没有对最终输入的未来轨迹执行机体扫掠。缺的不只是顶棚：侧壁、横向转弯、速度惯性和点火后的运动都没有同等验证。

还有两个直接可见的问题：

1. 脚下查询改成了 FlightGeometry.surfaceBelow，但 clearanceAhead 在 `:701` 仍调用 Controller 内旧 surfaceBelow。旧函数在 `:679` 继续跳过 water。水面契约没有真正统一。
2. `:457` 按旧 yaw 扫前方，`:461-478` 随后可能朝新的 landingTarget 转向。被检查的方向和实际写入的方向可以不同。

`findLandingTarget` 只检查某一列支撑、站立净空及粗略距离，不证明以当前速度能到达。它也不是主机完整落点验证规则的等价实现。

### 首次掉血不能直接定性为撞顶

| tick | x | y | vx | vy | HP |
| --- | --- | --- | --- | --- | --- |
| 10000 | -1025.31417 | 101.62291 | -0.80446 | +0.53114 | 20 |
| 10001 | -1025.70000 | 102.15380 | 0 | +0.53090 | 17.27758 |
| 10002 | -1025.70000 | 102.40000 | 0 | 0 | 17.27758 |

用生产 FlightDynamics 重放 10000 的输入，无遮挡下一步得到 x=-1026.09171、y=102.15381。实测 y 与它一致，x 却截在 -1025.7，水平速度清零。下一 tick 才出现竖直位置截断与 vy 清零。

这强烈支持“先发生水平接触，随后又有顶部接触”的解释；确切方块、接触面仍需要事故局部世界快照或原生碰撞事件。仅因为受伤时 vy>0，就归因“上方结构”，证据不足。

**修复要求：** 将恢复实际输入送入与正常飞行一致的物理推进和三维机体扫掠；最终 yaw 确定后再验证。顶棚扫描可作为提前筛选，但不能替代整段检查。统一删除旧表面查询语义。加入高速侧撞、转向后遇墙、低顶拉起、低顶点火、水面和未知区块用例。保留同 tick 单一所有者。

## 3. P0：恢复软期限仍泄漏控制权

位置：`FlightOwnership.java:recoveryWindowOpen/hasLiveControl/acceptBlockReason`；`FlightController.java:1453`；`ClientControlGuard.java`。

代码把自主控制保护和拒绝新会话的条件，仍绑定在 recoveryUntilMs 上。Controller 要到稍后的 recoveryFrame 才重设软窗口。保护器先于 Controller 执行，软窗口刚过期时就存在先失去保护、后重设的顺序缺口。

直接调用生产状态类的结果：

```text
phase=RECOVER at=7001 hard=30000 live=false acceptBlock=null
phase=LAND    at=7001 hard=30000 live=false acceptBlock=null
```

这两个状态都还在硬期限内，却不再被认为持有控制权，也不再拒绝普通新路线。LAND 没有 recoveryFrame 的周期重设，因此问题不只是一瞬间。

另有独立释放路径：`FlightController.driveLanding:597-603` 在 landingSession.isDone() 时直接 release。即使原因是 NO_VIABLE、且机体仍在空中，也没有回到受控恢复。下一次真正使用主机着陆接口时可能重现空中放手。

**修复要求：** 控制权和新路线互斥取决于 phase 与硬期限，软期限只触发策略重算。LAND 失败且仍在空中时保留所有权，回到受控恢复或重新选择着陆方案；只有稳定结束、原子转交、显式撤销及硬期限等明确条件才能释放。增加控制器级软期限边界与 LAND 失败回归。

## 4. P1：预算归因错误，不能先缩短 hold 验证

原始数据中的 5 次耗尽如下：

| tick | 实际 cursor | 已评估/可行 | simMs | physicsSteps | terminalAction / terminal 拒绝 |
| --- | --- | --- | --- | --- | --- |
| 9761 | 1 | 4 / 3 | 29 | 104 | none / 0 |
| 9762 | 1 | 18 / 14 | 13 | 468 | none / 0 |
| 9765 | 1 | 16 / 11 | 13 | 413 | none / 0 |
| 9766 | 2 | 16 / 11 | 15 | 412 | none / 0 |
| 9771 | 2 | 17 / 9 | 13 | 434 | none / 0 |

它们全部发生在完整臂前 11 个受控 tick。首次仅评估 4 个候选就用 29 ms；之后完整臂中位耗时 2 ms、P95 7 ms。分腿臂在完整臂之后运行。

这是启动、类加载/JIT、临时分配、世界查询或调度开销的调查入口，不是“长路线末端 hold 太贵”的证据。冷启动只是待验证解释，不能凭一次顺序实验确定。

源码还有三个具体缺口：

- `FlightSession.evaluate:778` 无条件循环 horizon+6；没有到终端的普通候选也跑 26 tick。若契约是常规 20、到站后补足 6，应按条件延长，不能无条件加 6。
- `:569-571` 最外层是 yaw，所谓“上一获选策略优先”只在轮到同 yaw 分组后生效。上次赢家属于后面的 yaw 时，仍可能被预算截断遗漏。
- `:664-684` 只把 evaluated=0 的耗尽留作预算问题。若前几个候选失败、其余尚未评估就耗尽，仍报告 NO_VIABLE_TRAJECTORY。搜索未完成不能证明无路。

时间预算仅在候选之间检查，单个候选可跨过期限；使用 System.currentTimeMillis 也不适合精细耗时预算。当前字段还把候选数量上限与时间上限混为 budgetExhausted。

**修复顺序：**

1. 拆出单调时钟耗时、搜索是否完成、获选候选是否完成全套安全检查、预算中断原因。
2. 从冷启动与预热状态分别离线回放，交换两臂顺序；再定位物理、世界查询、终端验证及分配成本。
3. 全局优先复检上一获选策略，再公平覆盖水平、拉起、横向及可用点火候选。
4. 修正无条件延长时域；世界读取可在 tick 内按真实格坐标共享，不能跨地图新鲜度边界缓存。
5. 用内部截止/工作量检查使候选超时返回“未验证”，不得把中断候选当可行或确定碰撞。已有完整验证赢家可继续执行；没有赢家时进入受控恢复。

不要优先缩短安全检查的物理时间。必要时可以先排序，再对候选做完整终端验证；前排失败须继续检查后排，不能把未检查者当作不安全。

## 5. P1：终端预测与真实 hold 仍不是同一策略

位置：`FlightSession.java:828-846、918-933、1086-1163、1302`。

目前进步是补齐了到站 boost 快照，并加强了支撑方块检查。但以下差异仍存在：

- 真实 advanceEntries 支持平面过站，预测推进仍只检查到达球。
- verifyHold 每步选第一个单步安全俯仰；真实 HOLD 运行主候选搜索与评分，动作选择规则不同。
- referenceFor 在预测里每步重算 hold 高度；verifyHold 固定到站时高度；真实 hold 使用 beginHold 写入的高度。这是三种不同参考。
- verifyHold 的局部 rocketTicks 仍只递减；点火后未采用 stepped.rocketTicksRemaining，未扣库存，未传入冷却。外层首步已消耗烟花时也仍把原 rockets 传入。
- land 判据未核对水平撞击速度和真实接触法向；terminalAction 仍不能单独证明实际进入并完成 LAND。

因此，本次 terminal_action 的拒绝确实挡住了某些候选，但不能由此宣称“终端验证和执行已一致”。两臂本次碰巧拒绝，不证明所有可接受候选的终端都可执行。

**修复要求：** 共用过站规则、完整模拟状态和可实际执行的终端策略；同时推进库存、boost 与冷却。至少补相同状态/相同策略首步一致、未来点火资源、侧向高速接触、带 boost 到站及预测平面过站回归。不要靠修改日志标签完成这一项。

## 6. P1：D3 门控给了过强的通过结论

位置：主机 `movement/e02-route.integration.test.ts:404-447、556-564、689-718`。

### 6.1 河道范围没有参与通过判定

分腿臂 tick 10207 的 x=-1006.9276，原始 crossing.inRiverBand=false。夹具仍把 controlledRouteCrossing 设为 true，因为它只检查 owner、gliding 和非水。

即使在前后两个位置之间插值求 z=20 的真实截面位置，x 约为 -1006.4765，仍在当前 [-1006,-994] 条件之外。不能用 tick 采样离散误差解释它已经满足原条件。

保留“受控越线”这一事实，同时把“河道截面通过”作为更强的独立门控。若当前范围已经不适用，应先根据夹具几何重定并版本化验收规则，再跑新证据，不能事后把范围删掉让旧数据过关。

### 6.2 recoveryCrossing 不是跨线事件

当前条件只是“owner=recovery 且 z<=20”。完整臂标记于 z=-51.28，分腿臂于 z=5.67；此时都早已越过截面。

按相邻样本 `previousZ>20 && currentZ<=20` 重算，本次每臂只有一次向前跨线，均属于 flight-session。没有新的向前 recoveryCrossing。

应先检测几何穿越，再按事件发生时的所有者分类；无恢复跨线是正常事实，不应要求这个布尔量为 true。

### 6.3 geometryChecked 不等于零预算耗尽

它目前等于 `budgetExhaustedTicks===0`，且只看 flight-session。一个搜索只完成一部分候选，也可能已经有完整检查的赢家；反过来，没有预算耗尽的恢复动作目前根本没有扫掠。

拆为 `searchCompleted`、`chosenTrajectoryVerified`、`recoveryTrajectoryVerified` 和期限指标。候选完整性与已执行动作安全性分别验收。不能用一个布尔值替代它们。

### 6.4 稳定接地没有检查期限与观测完整性

`settledBeforeDeadline` 只等于 stableSettled，没有比较硬期限。`endingDamageFree` 只看 damageEvents.length，不使用已经计算好的 fullyObserved/damageFreeObserved。缺字段或缺帧可能变成“没有观测到伤害，所以通过”。

保存原始硬期限与稳定结束时刻，明确时钟关系。伤害门控必须要求观测完整。将 `ending='safe_ground'` 改成物理事实 `settled_ground`；完整臂本次受伤后仍输出 safe_ground，名称仍误导。

### 6.5 无输入阶段仍存在，失败边界也延迟

完整臂 t10012、分腿臂 t10391-10395，均为 phase=RECOVER，但 inputOwner=none、非水、未接地、gliding=false。它们发生在首次地面接触后又离地，不是 ab-23 那种超时继续滑翔；两者应分开记录。

这说明“逻辑拥有恢复阶段”仍不等于当 tick 有实际控制。定义失去滑翔后的处置和观测，不要只填一个 owner 掩盖无动作。补“接触后弹起/滑落、尚未稳定”的回归。

夹具冻结失败 tick 使用 poll 读完后的 cursor。本次完整臂恢复从 9976 开始，endingStats 却从 9979 开始；分腿臂恢复从 10218 开始，统计从 10228 开始。应从原生路线失败事件/首次 FAILED 转换开始，并带上前一 HP 样本以捕获转换当 tick 的损伤。

另需补 LAND 遥测：Controller.recordTick 当前在会话已终止时只保留 flight-recovery owner，flight-landing 会被遗漏。AB 本次没有 LAND，不能验收生产主机着陆接口的端到端控制链。

## 7. 下一步只做三个收口批

**第一批：修门控与所有权。** 修软期限窗口、LAND 失败空中释放、失败原生 tick、LAND owner、真实跨线和 deadline/完整观测门控。用 ab-24 重算出正确报告。旧诊断结论保留来源，不覆盖原始日志。

**第二批：补恢复轨迹验证与终端一致性。** 恢复采用最终动作的完整三维扫掠，统一水面查询；同一状态/策略同时用于预测与执行。离线重现 t10000 附近的侧壁/顶部组合，补失去滑翔后未稳定的处置。客户端纯恢复与主机提供落点进入 LAND 两条路径都要验收。

**第三批：处理真实预算来源，然后做一对诊断。** 保留 12 ms 目标，先修调度、计时和工作量问题；分别测冷启动和预热，不能把预热后的好结果当成冷启动也通过。终端检查完整性不因优化缩水。

这三批通过后先跑一对新的诊断，不直接把 ab-25..27 都当正式三对。两臂在修正后的门控下均通过，才进入三对复现。出现失败即保留证据停止扩批。

目前仍不需要继续修改 A*。卡点已经有客户端执行、恢复所有权和验收定义的直接源码证据。先证明这层正确，再判断河湾高度区间、闸门与树冠的规划约束。

## 8. 本次新增证据与限制

目录：`docs/fork/evidence/elytra-flight-control-20260920/R4-20260920-01/ab24-audit/`。

- `summarize.mjs` / `summary.jsonl`：从原日志重算预算位置、真实截面事件、掉血、空中无输入 tick 和时域耗时。
- `audit-probe.java` / `probe-result.txt`：直接运行生产 FlightOwnership 和 FlightDynamics，复现软期限缺口、比较受伤附近的无遮挡运动。
- `source-hashes.json`：本次审计对应的源码与日志哈希。

回归命令：

```powershell
pnpm exec vitest run --config apps/stage-tamagotchi/vitest.node.config.ts apps/stage-tamagotchi/src/main/services/airi/game-host/movement/ending-stats.test.ts apps/stage-tamagotchi/src/main/services/airi/game-host/movement/leg-offer.test.ts apps/stage-tamagotchi/src/main/services/airi/game-host/flight/channel.test.ts apps/stage-tamagotchi/src/main/services/airi/game-host/flight/touchdown.test.ts
```

结果：4 文件、36 用例通过。现有测试通过与上述未覆盖分支缺陷同时成立。未验证事故点具体方块/接触法向，未重新执行真机，没有新的正式验收通过声明。
