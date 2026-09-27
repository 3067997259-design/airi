# R4 检查记录（R4-20260920-01）

日期：2026-09-20。

## ab-23 修复批 A（部分：A1/A2/A3/A4/A5 部分）（2026-09-21，零提交）

按 `elytra-flight-control-ab23-repair-plan-20260921.md` §2/§3/§8 执行；先写回归再改实现。本批只改证据、所有权与统计，不改飞行参数，不做真机验收。

| 项 | 交付 | 验证 |
| --- | --- | --- |
| A2 所有权与单帧 | 新增纯类 `FlightOwnership`（`routeOutcome` RUNNING/COMPLETED/FAILED/REVOKED 与 `phase` PREPARE/TRACK/HOLD/RECOVER/LAND/SETTLED/RELEASED 分离；首次失败冻结；恢复窗口是策略期限；`acceptBlockReason` 返回 `recovering`）。控制器：每 tick 只产生并提交一个 `InputFrame`（`driveSession`/`recoveryFrame` 返回帧，`applyFrame` 单次写入），删除 `driveSession` 后 `driveRecovery` 的顺序双写；`submit`/handover 在恢复期返回 `recovering` 且不触碰失败原因/窗口/冷却；`revoke` 取消恢复；`routeCompleted` 只在完成时记录、落地不改写失败 | `FlightOwnershipTest` 8/8；控制器编译与 Java 全套通过 |
| A3 主机与保护器 | `hasLiveChannel()` 覆盖恢复窗口（`ClientControlGuard` 心跳豁免随之生效）；`channel.ts`：路线 ended 与物理 `controlReleased` 分离、恢复期 `isActive()` 仍为真（不启动第二个控制器）、`recovering` 走类型化拒绝且不 revoke-retry、显式 revoke 在路线结束后仍会下发（取消恢复）；`elytra.ts`：路线 ended 但客户端未释放控制时不启动主机飞控（等待释放，硬期限仍权威）；`port.ts`/`host-port.ts` 传递 `phase`/`routeOutcome`/`recoveryReason`/`recovering` | `channel.test.ts` 新增 4 例（恢复期控制声明、释放判定、显式撤销、recovering 拒绝不撤销）；game-host 963/963；typecheck 0；lint 0 |
| A4 结束统计 | `movement/ending-stats.ts`：累计掉血 `endingObservedDamage`、最低血、首伤 tick、缺帧/重复 tick、20 tick 稳定结束、`settledGround`/`settledWater`/`unresolvedAirborne`、`damageFreeObserved` | `ending-stats.test.ts` 8/8：ab-23 完整臂重算 **6.64**（旧口径 3.64 被回血掩盖）、分腿臂 **0.69** |
| A1 夹具终态优先 | 首次路线失败冻结（tick/state/endReason/detail，不被后续 revision 或恢复改写）；失败后不再提交普通下一腿并用同一完整 schema 记录到稳定结束；按 native tick 去重；统一跨线检测器产出 `crossing`/`recoveryCrossing`；默认分段只在 `holding` 时预交接 | typecheck 0、movement 436/436 |

**仍未完成（下一轮）**：A5 的两条控制器级直接用例（"同一 tick 主会话失败+恢复开始只提交一次"、"主机见'路线失败仍在恢复'不启动飞控"的端到端用例；前者已由单 `InputFrame` 结构保证、后者已由 `elytra.ts` 释放门与通道测试覆盖，但缺直接断言）；批次 B（航路预测：随进度更新动作、绝对 0°/−12° 覆盖、全局进度与等价集合评分、终端策略可执行）；批次 C（恢复与着陆）；批次 D（冻结路线验收）。客户端 0.2.58 尚未包含 A2/A3 的 Java 改动，按方案本批不做真机验收，下次真机前需重新构建部署。

## ab-23 修复批 B 核心（2026-09-21，客户端 0.2.59，零提交）

按方案 §4 先写回归再改实现；本批不跑 E-02 真机（方案 B 允许离线验收）。

| 项 | 交付 | 验证 |
| --- | --- | --- |
| B1 候选=反馈策略 | `evaluate` 改为**每个模拟步重算参考与瞄准**（`referenceFor`）：航点到达后方向随之更新，不再冻结进入时的姿态；预测可越过时域直到完成终端检查（`horizonTicks + TERMINAL_LOOKAHEAD_TICKS`） | 与 B5-2 相关（参考随进度变化） |
| B2 动作覆盖 | 俯仰策略改为 `PitchPolicy`：`AIM` / `AIM_PULL`(瞄准−12°) / `LEVEL`(绝对 0°) / `PULL_UP`(绝对 −12°)；横向仍是 5 个 yaw 偏置；首步点火 0/1；上限 5×4×2=40，去重与限幅沿用 | 平水面反例回归（下） |
| B3 进度与选择 | 新增弧长累计 `cumulative[]`；`progressOf` 单调进度；**全局选择 `selectBest`**（最大进度 + 1 格等价带 + 总序比较：横向误差→高度偏差→控制变化→少点火→稳定 policyId），删除非传递的两两比较器；`routeLowerBound` 改用**局部参考窗口**（entryIndex..+3） | 顺序无关回归（下） |
| B4 终端可执行 | 到站快照补 `arrivedRocketTicks`（到站时刻的 boost，不再借用预测末端）；hold 验证改用同一 `PitchPolicy` 集合；时域尾部不再截断终端检查 | 既有终端回归全过 |
| C1 几何缓存 | `surfaceBelow` 改为**列缓存**：每列每 tick 一次扫描、按精确 (x,z) 键、答案 = 查询高度下最高的固体顶面，与全新扫描一致；修复"同一列不同扫描起点返回同一表面"与整数 hash 键问题 | 顺序无关回归 + 平水面回归 |

**新增回归（`FlightSessionPolicyTest`）**
- `theLevelWaterStateFindsAnUnpoweredLevelPolicy`：ab-23 几何（参考点近且低 → 旧瞄准角 ≈60°，旧候选集四角全部 ≥32° 俯冲且瞄准角俯冲必然入水）；新策略集必须存在可行候选（`applicable` 且 `feasible>0`）。
- `theWinnerDoesNotDependOnTheCandidateEnumerationOrder`：同一状态、反转 `yawOffsets` 枚举顺序，胜者 yaw/pitch/fire 必须一致（依赖 C1 的缓存修复；修复前同一候选的高度误差会因缓存首问顺序漂移）。

**汇总**：Java **52/52**（`FlightOwnership` 8、`FlightSessionStatsTest` 4、`FlightSessionPolicyTest` 2、终端回归 3、恢复 6、动力学/交接等其余）；TS 未改动（本批为纯客户端预测层）。

**仍未完成（下一轮）**：B2 的预算调度（优先上一轮基线/水平/拉起，再扩展侧向；当前按枚举顺序截断）；B3 的 routeId/revision/全局进度持久化与可选前视距离；B4 的"安全着陆需验证支撑面/落点"（当前 `land` 仍是温和接地判定）；B5 其余场景（下坡转平、弯后墙体、低顶、过站/末点、到站带 boost、未来点火、预算分布与预热计时）；批次 C（恢复与着陆）与 D（冻结路线验收）。
## ab-24 诊断对（2026-09-21，客户端 0.2.63，零提交）

D2/D3 实现：Java `FlightSessionArmComparisonTest` 2 例（同可见范围 → 首步/目标/进度必须一致；分腿端点落入预测范围 → 归因"路线可见范围/终端语义差异"）；夹具增 D3 `gates`（受控跨线/几何检查+预算耗尽计数/失败后不自动提交/稳定结束/全程与结束伤害分开/route 与 recovery 跨线分开）与 `submissionsAfterFailure`；`clientBuild` 改从 status 读取。

**第一对诊断（`cave-ab-24.jsonl`，路线哈希 71e91313 / cdf5305f，build 0.2.63+1.21.1）**
- **两臂首次同时受控跨线**：完整臂 tick 9879（-1001.4, 70.6, 19.7，速度 1.62）、分腿臂 tick 10207（-1006.9, 68.7, 19.5，速度 1.63）；恢复跨线分别记录（t9976 / t10218），未计入航路验收。
- **分腿臂六条门控全过**（几何检查 0 预算耗尽、无自动提交、稳定 23 tick 接地、全程与结束零掉血）→ 干净诊断。
- **完整臂两条门控未过**：①`budgetExhaustedTicks=5`（215 个受控 tick 的长路线，12 ms 预算不足）；②结束阶段掉血 2.72——逐 tick 定位为 **t10001 在 (-1025.7, 102.2, -48.6) 爬升中撞上方结构**（vy +0.53、`phase=RECOVER`）：恢复策略的 `clearanceAhead` 只扫描下方地形，**没有检查上方顶棚**（正是 C5"拉起遇顶棚须拒绝"在恢复段缺失的检查）。
- 两臂拒止均为 `terminal_action`（到站 hold 在 t6/t15 遇树叶/草方块），终端动作验证在真机生效；`stackedTicks=0`。

**下一步**：①恢复段增加上方净空扫描（爬升前检查顶棚，顶棚低时不拉起/不点火）；②按插桩分布处理完整臂的 5 个预算耗尽 tick（优先缩短 hold 验证或调度，不放宽 12 ms）；两项修完再跑**三对复现**（cave-ab-25..27），仍按六条门控逐对判定。详见 `ab24-diagnostic.md`。

## ab-23 修复批 C2 完成 + 批次 D1（2026-09-21，客户端 0.2.62，零提交）

| 项 | 交付 | 验证 |
| --- | --- | --- |
| C2 主机落点交接 | **协议**：`flight_landing_site`（sessionId/controlSessionId/入口 x,y,z/contactY/dimension）→ 回执（accepted/reason/phase/site*）。**客户端**：`FlightLandingPlan.validate`（支撑面安全 + 站立净空 + 用同一有界预测验证"当前速度能飞到"，拒绝原因 `unsafe_support`/`no_headroom`/`landing_unreachable`）；验证通过后 `ownership.enterLanding()` 进入 LAND，并把落点变成一条真实的两点通道腿（同一候选集/扫掠/终端规则）执行；LAND 仍拒绝新路线（`acceptBlockReason="landing"`），硬期限仍然权威 | Java `FlightLandingPlanTest` 5/5；`FlightOwnershipTest` 增 LAND 用例 |
| C2 主机侧 | `port.ts`/`host-port.ts` 新工具映射；`channel.ts` 增 `landingSite()`（不 revoke/不 submit/不改控制声明）；`elytra.ts` 在"路线 ended 但客户端未释放"的等待期，用主机 `findLandingSite`/`findGoalLandingSite` 找到落点后按 2 s 间隔提供，接受即停（`poll.recovering` 变假），拒绝则继续短期避险并记录原因 | `channel.test.ts` 13/13（新增"落点提供不触碰路线/控制声明"） |
| D1 证据 schema | 客户端：Decision 增 `chosenPolicy`；环样本与状态增 `controlPhase`/`routeOutcome`/`progress`/`predictedEndProgress`/`chosenPolicy`/`evaluated`/`feasible`/`budgetExhausted`/`physicsSteps`/`blockQueries`/`cacheHits`/`simMs`/`cooldownActive`/`transitionReason`，状态增 `build`（mod 版本）。主机：`FlightChannelSample` 与 `flightSampleOf` 透传全部新字段（缺字段显式缺省，不填 0/false）；夹具 run 记录增 `routeHash`（折线哈希）与 `clientBuild` | typecheck 0；game-host vitest **975/975**；lint 0 |

**批次 D 的执行计划（D2/D3，尚未跑真机）**
- **D2 两种比较**：交接等价测试固定"同一实测状态、同一可见路线前缀与预测范围内后缀、同样终端条件、boost/库存/冷却/控制期限"，只换会话 envelope；若分腿端点落在预测范围内而完整臂能看到更多后缀，结果归入"路线可见范围/终端语义差异"，不直接叫交接 bug。
- **D3 逐级放行**：先跑**一对诊断**，满足以下条件才做**三对复现**：①正常航路控制跨 z=20（当 tick 滑翔、未入水、owner 为航路控制、速度有效）；②每段运动通过几何检查（失败不得靠放宽水/树叶/碰撞体积）；③恢复期不自动提交普通下一腿、无双写或未声明抢占；④内部失败后硬期限前由明确控制者稳定结束或有可核验的原子转交；⑤全程与 ending 分别报告可见伤害，本夹具无损验收要求两者均为 0 且无关键缺帧；⑥分别记录 `routeCrossing` 与 `recoveryCrossing`（后者不能替代前者）。三对通过仅代表"早段河湾与收尾复现通过"；闸门/板下/洞内与 20 次正式批次在其后。
- 每次跑前记录：客户端 build（`flight_status.build`）、`routeHash`、配置、起飞状态、两臂完整下发路径、地形版本/快照、控制参数；`NEXT-RUN.md` 的复跑命令已含新输出文件名。

## ab-23 修复批 C 完成（2026-09-21，客户端 0.2.61，零提交）

| 项 | 交付 | 验证 |
| --- | --- | --- |
| C1 统一几何语义 | 新增 `FlightGeometry`：`isFlyableThrough`/`isAirLike`/`isWater`/`isUnsafeSupport`/`surfaceBelow`（水面是表面、未知即实心、整格保守顶面 = y+1）。`FlightSession` 与控制器恢复段共用该边界（删除控制器里重复的 `surfaceBelow`）；列缓存（B 批）保证同一列不同扫描高度返回各自正确表面 | `FlightGeometryTest` 6/6（水顶 63 非河床、未知即实心、树叶是碰撞面、水/岩浆/火/passable 永不作落点、水面不可穿越、慢下沉遇侧壁仍拉起） |
| C2 恢复的短期避险与落点 | 恢复保持 `FlightRecovery` 地形前瞻 + 单次点火制动；新增**有界落点扫描**（5 个偏置 × 至多 32 格、支撑面安全 + 站立净空 + 高度差 ≤24）作为恢复航向目标，命中即写入遥测（`landingTarget*`），无落点时不伪造 `land`（B4 已要求支撑面验证） | `FlightGeometryTest.aLateralWallWithASlowSinkStillPitchesUp`（vy 近 0 也必须避开横向危险）；B4 的水面/树叶反例 |
| C3 三个时钟分离 | 路线期限（通道 `deadlineMs`）、恢复策略窗口（6 s）、授权硬期限三者分离：`rearmRecovery` 只在硬期限内续窗、绝不延长硬期限；控制器在窗口到期时**重新选取并计数**（`recoveryReselects`）而不是释放；硬期限在空中到期 → `terminateIfActive("control_expired_airborne")`（类型化失败，不是安全结束）；`!fallFlying` 且无接地/入水 → `recoveryUnresolved`（绝不判 settled） | `FlightOwnershipTest` 10/10（含窗口续期到硬期限、硬期限类型化释放、撤销取消恢复） |
| C4 稳定结束判据 | 客户端只在**连续 20 个**接地/入水且水平与垂直速度 ≤0.5 的样本后才 `settle`；`touchdown.ts` 不再把缺失 motion 默认为 0（缺速度 = unknown，绝不判落地），并补回归 | `touchdown.test.ts` 9/9（新增"缺失 motion 不得证明落地"）；夹具侧 20 tick 稳定判据与掉血口径见 A4 |

**汇总**：Java 全绿（新增 `FlightGeometryTest` 6、`FlightOwnershipTest` 扩到 10）；game-host vitest **974/974**；typecheck 0；lint 0。

**仍未完成（下一轮）**：C2 的"主机拥有落点、客户端验证接入"完整协议（当前客户端用有界镜像；主机侧落点交接属新增 IPC 契约）；批次 D（冻结路线验收：同版客户端、路线哈希、逐 tick 全精度记录、先一对诊断再三对复现）。

## ab-23 修复批 B 完成（2026-09-21，客户端 0.2.60，零提交）

| 项 | 交付 | 验证 |
| --- | --- | --- |
| B2 预算调度与基线 | `orderedPolicies`：每个 (yaw, fire) 组合内上一轮获选策略优先（用当前状态复检），随后 LEVEL/PULL_UP 绝对策略，最后 AIM/AIM_PULL；预算截断先吃掉侧向与点火扩展，不再吃掉保命动作 | 交接重放回归 + 顺序无关回归 |
| B3 路线身份与进度 | `setRouteIdentity(routeId, revision)`（控制器两处构造会话时传入 sessionId/revision）；Decision 增 `routeId`/`routeRevision`/`progress`/`predictedEndProgress` | 编译 + 既有回归；D1 逐 tick 记录将消费 |
| B4 可验证支撑着陆 | `isSupportLanding`：接触点必须是机体正下方支撑面（1.5 格内）、支撑方块必须实心安全（水/树叶/岩浆/火/passable 不算）、接触上方有站立净空；远端接触与地板突破两条路径都须通过才判 `land` | 草地台地 -> land；新增水面接触 -> 全部拒绝、NO_VIABLE |
| B5 插桩 | Decision 增 `physicsSteps`/`blockQueries`/`cacheHits`/`simMs`（逐 tick 重置，含列缓存命中计数） | `theSearchReportsItsCost` |
| B5 其余场景 | 新增 `FlightSessionRoutePolicyTest` 6 例：过站后俯冲被下一段瞄准替换、弯道跟随且直冲被墙挡、低顶拒绝爬升、末点不被过站规则提前完成、点火门控（20/40/20 评估数）、代价上报 | 6/6 |

测试稳定性修正：`FlightHandoverReplayTest` 与点火门控测试改为宽裕 sim 预算（比较固定候选集的决策，不应受墙钟预算截断影响；此前 12 ms 只评估 14/40）。

实测性能信号：默认 12 ms 下 40 个候选只评估约 14 个（含到站候选的 26 tick 预测与 hold 验证）。插桩已就绪；按方案 B5 先记录分布、优先基线检查，再决定缩短 hold 验证或调预算。

汇总：Java 59/59；game-host vitest 973/973；本批 TS 未改动。

## ab-23 修复批 A5（统计与交付规则）（2026-09-21，零提交）

| 项 | 交付 | 验证 |
| --- | --- | --- |
| 逐 tick 统计清零 | `FlightSession.tick()` 现在重置 `rejectTerminal` 与首拒明细（tick/坐标/方块/形状）；新增独立命名的累计量 `cumulativeRejects/Collisions/Floor/Speed/Terminal`；Decision 增 `evaluated/feasible/rejected/unevaluated/budgetExhausted` 与累计量；note 增 `ok=` | `FlightSessionStatsTest` 4/4：首拒分类之和 == 被拒候选数、逐 tick 清零且累计累加、候选上限触发 `budgetExhausted` 且 `unevaluated>0`、可行 tick 报 `feasible>0`。ab-23 的 `ta=139` 因此不再可能是"一个 tick 的拒绝数" |
| 终态携带未完成下一腿不提交 | 新增纯规则 `movement/leg-offer.ts`（`shouldOfferNextLeg`：无下一腿/路线失败冻结/终态优先，默认模式只在 holding 时提交，early/late/timeout 语义保留）；夹具改为调用该规则 | `leg-offer.test.ts` 6/6（terminated/revoked/routeFailed 全部拒绝、默认仅 holding、扰动模式保留、无下一腿拒绝） |
| 通道恢复语义 | （前一轮）`channel.test.ts` 4 例：恢复期控制声明、释放判定、显式撤销、recovering 拒绝不撤销 | 12/12 |
| ab-23 伤害重算 | （前一轮）`ending-stats.test.ts` 8/8：完整臂 6.64、分腿臂 0.69 | 通过 |

汇总：Java 50/50；game-host vitest **973/973**；typecheck 0；lint 0。

## ab-23 修复批 A（部分：A1/A4/A5 伤害口径）（2026-09-21，零提交）

按 `elytra-flight-control-ab23-repair-plan-20260921.md` §2/§3/§8 执行；先写回归再改实现。本批只改证据与统计，不改飞行参数，不做真机验收。

| 项 | 交付 | 验证 |
| --- | --- | --- |
| A4 结束统计 | 新增纯模块 `movement/ending-stats.ts`：`endingMinHealth`、`endingHealthDropFromStart`、`endingObservedDamage`（累计掉血，回血不抹除）、`firstDamageTick`、掉血事件、tick 缺帧区间、重复 tick 计数、`stableTicks`（20 个连续 native tick，速度阈值 0.5）、`settledGround`/`settledWater`/`unresolvedAirborne`、`fullyObserved`、`damageFreeObserved`（仅完整观测+稳定结束+无可见掉血） | `ending-stats.test.ts` 8/8：ab-23 完整臂重算 **6.64**（报告值 3.64 因回血）、分腿臂 **0.69**；缺帧/缺速度/重复 tick/水面/空中分别断言 |
| A1 夹具终态优先 | `e02-route.integration.test.ts`：先保存样本与终态再决定下一腿；首次路线失败冻结（tick/state/endReason/detail，不被后续 revision 或恢复改写）；失败后进入结束观测、不再提交普通下一腿；结束阶段使用**同一套完整遥测 schema**（删除删减字段的 post-end 对象）；按 native tick 去重；统一跨线检测器同时产出 `crossing` 与 `recoveryCrossing`；默认分段模式只在 `holding` 时预交接（删除 `state !== 'running'` 的泛化判定） | 项目 typecheck 0、movement 套件 436/436（夹具用例在无 `MCPFABRIC_URL` 时跳过）、lint 0 |

**未完成（后续批）**：A2 控制器 `routeOutcome`/`flightPhase` 与单 InputFrame 提交、`recovering` 拒绝；A3 主机与保护器（`hasLiveChannel`、`ClientControlGuard`、`channel.ts` poll/submit/revoke、`elytra.ts` 移交、port 契约）；A5 其余回归（ta 逐 tick 清零与累计、RECOVER 中 revision、单 tick 单提交、主机不自动 revoke 重试）；B 航路预测；C 恢复与着陆；D 冻结路线验收。

## 审计全项批（2026-09-21，客户端 0.2.58）

| 审计项 | 交付 | 验证 |
| --- | --- | --- |
| 1 源码/回调顺序 | `ab20-audit/source-order.md`：无源码 jar，用 Mojang 映射类 + `javap -LineNumberTable` 核验；烟花在被附着实体自己的 tick 里写速度（`FireworkRocketEntity.java:132`，公式 `v + 0.1·look + (1.5·look − v)·0.5` 与模型一致），玩家 `travel` 先位移（`LivingEntity.java:2256` 读速度 → `:2302` move），实体列表为插入序（玩家先于烟花）→ 假设 (A) 成立 | 引文 + 行号 + 字节码；保留意见（插入序非硬编码） |
| 1 四状态 + 多 tick 裕量 | `ab20-audit/CalibrateDynamics.java` + `calibration.md`：free/single/ignite/stacked/boost_end 分类；单 tick P95 `2e-5`（single）/`0.137`（free）；多 tick 开环 5/10/20 tick P95 `0.42/1.80/5.55`（single），主因是 ab-17 的推进估计失效（已由禁叠加 + 35 tick 平台修复）与接触地面样本 | 结论写入 `calibration.md`：硬净空只保证首段扫掠，ab-21 后用同一探针复测 |
| 2 到站/末端动作 | 预测虚拟游标 + 终末 6 tick 前瞻 + **`verifyHold` 终端动作**（近端 8 tick 必须净空；远端地形接触且下沉温和 → `land`；否则 `terminal_action` 拒绝）；完整全项遥测（cursor/target/预测终点与长度/1-3-5 tick 预览/首个拒绝的坐标与形状/墙钟与单调钟） | 回归：`full,19220` 与 `segmented,19478` 的实测状态 + 终末墙 → 拒绝且拒绝点低于到达高度；清空场景 → `hold`；"hold 只能落地" → `land`。ab-21 曾因远端接触误拒（ta=131/tick）导致低空撞水，已修 |
| 3 失败收尾 | `FlightRecovery` 纯策略（地形前瞻 + 单次点火制动，禁叠加）+ 6 个单测；控制器接线；夹具记录到 20 个稳定接地样本并带 `damageDuringEnding`/`residualSpeed` | ab-21/22 两臂恢复分别掉血 `3.62`/`4.09`/`0`（ab-18 为 10.4）；`flight-recovery` owner 可见 |
| 4 末端空间 | `ab20-audit/end-region.json`：服务器端只读快照 x −1020..−920 / y 55..100 / z −135..−40 = 250,810 固体格（46 次读取）；`legPaths` 已在 run 记录中，供弦段/轨迹对比 | 快照 + 计划一致（ab-20/21/22 的 `legPaths` 完全相同） |
| 5 两臂重跑 | ab-20（0.2.56）：分腿跨线、z≈−120.7、零掉血；ab-21（0.2.57）与 ab-22（0.2.58）：两臂均在河湾 `reject[c=18] first=collision@t11 block=minecraft:water` 早退，恢复安全接地（掉血 4.09/0） | **未达四条验收**：见下 |

**ab-22 结论**：终端动作误拒大幅收敛（远端温和接地下沉 ≤0.6 格/tick 判为 `land`；ab-21 的 131/次误拒不再见于末段），但河湾进场仍出现 `ta≈131/tick` 的集中拒绝——那些到达态的下沉更陡（>0.6），属有意的软着陆约束。两臂仍因河湾水规则早退：路线 leg2 在 z≈36.5 的航点 y=64.5（水面 ~62），只有约 2.5 格余量，进场状态低 1–2 格时所有候选的预测都会切入水面而被拒。三条 run 的 `legPaths` 完全相同 → 属执行状态方差 → 需要按审计第 4/5 项，在规划器的**已验证中心线**上给水面留出 ≥4 格剖面余量（而不是放宽客户端水规则或 A* 权重），再重跑两臂。

## 审计批：模型边界、终点接续与安全收尾（2026-09-21，客户端 0.2.56）

按 `elytra-flight-control-ab17-audit-20260921.md` 的顺序执行前 3 项。

| 项 | 交付 | 验证 |
| --- | --- | --- |
| 1 动力学时序 | `FlightDynamics.step`（Java）与 `stepFlight`（TS）改为**先用当前速度完成滑翔与位移、再把火箭推力加到速度**；TS/Java 同步 | 用审计 `samples.csv` 的 142 个受控 boost tick 复算：**posP95 0.0000187 格**（旧序 0.5386，审计诊断假设 ≈0.00002）；新增 `FlightDynamicsOrderTest` 2 例 |
| 1 叠加点火 | 控制约束：`rocketTicksRemaining > 0` 时不评估点火；烟花遥测改为**实体级**（`boostCount`/`boostEntityIds`/每实体首见 tick 的寿命估计，observe 同步输出） | `doesNotFireWhileABoostIsStillActive`；ab-18..20 环样本带 `boostCount`/`boostEntityIds` |
| 2 终点接续 | 预测改为**虚拟游标**推进：中间航路点不再截断；到达终末后仍做 `TERMINAL_LOOKAHEAD_TICKS=6` 的扫掠；到站检查（净空/末速）取**到达态**而非前瞻末端 | 新增 `theTerminalLookaheadSeesAnObstacleJustPastTheTerminus`（终末后 8 格处的墙现在会拒绝候选） |
| 3 空中失败收尾 | 客户端：`no_viable` 且仍在飞 → **有界恢复**（保持航向、近地拉起 10 格内 -18°、6 s 窗口、所有者 `flight-recovery`）；夹具：结束后继续记录到 20 个稳定接地/入水样本或有界超时，分类带 `damageDuringEnding`/`residualSpeed` | ab-20：**分腿臂 z≈−120.7、零掉血、`safe_ground`（HP 20、残余速度 0）**；恢复 owner 在环中可见（28/111 tick） |

**ab-20 其余结果**：完整臂因 0.2.53 的水规则在 entry 3/19 处 `reject[c=19,f=1] first=collision@t10(…,63.0,40.9)block=minecraft:water`（俯冲到水面的候选被拒），随后恢复落地**掉血 9.97**——恢复会保持航向下降，在上升河岸前撞地；分腿臂跨线后连续 7 次提交推进至 z≈−120.7（越过羊毛闸门带下沿 z≈−101）后失败收尾。

**下一步（审计第 4 项起）**：①保存 z≈−50..−125 末段地形快照，用同一视图比较规划弦段与实际轨迹（含恢复轨迹），再决定树冠/河岸处理；②恢复增加**地形跟随/点火制动**（完整臂恢复仍撞上升河岸）；③重跑两臂验收：受控跨线、终端动作接续、无空中 owner 空窗、无新增掉血。

## 介质判定批：预测中水即障碍（2026-09-21，客户端 0.2.53）

- 修复：预测扫掠此前把水当可穿越格，加上继续性下界读的是"预测终点以下"（入水后读到河床），于是"俯冲入水"的候选一直合法——这正是 cave-ab-13 完整臂 1 次点火、一路俯冲入水的原因。现预测中水为障碍（机体盒触水即否决），glider 仍可贴水面上飞（63+ 时机体盒不采样水面格）；新增回归 `aPredictedDiveIntoWaterIsRejectedEvenWithRocketsInHand`、`flyingJustAboveTheWaterIsStillValid`。客户端单测 **25/25**。
- 夹具修复：长飞磨损 elytra（431/432 无法展开 → `launch_not_deployed`），重置时 `clear`+`give` 更换；客户端 world 需重启 quickPlay 回服。
- **cave-ab-15/16（0.2.53）**：
  - 完整臂：**受控跨线**（tick 3261、(−999.7,63.4,19.3)、速度 1.62、rev 1），不再入水；随后在河湾后爬升段失败——`reject[c=0,f=0,s=20]`，20/20 候选全因"末速 <0.25"被拒（位置 (−991.5,82.1,−13.3)、目标 (−981.5,89.5,−24.5) 爬升 7 格）。
  - 分腿臂：7 次提交、**受控跨线**（tick 5857、速度 1.67、rev 3），跨线后爬到 **y≈95、z≈−34**（比 ab-12 更远），撞 `jungle_leaves`（t0 起姿盒已在树冠内）收尾，HP 17.3。
- 下一步（两处）：①爬升段的末速判据——带推进的爬升候选不应被恒定 0.25 末速一刀切（复核："点火预测还要考虑持续推进的加速与转弯"）；②规划器在河湾后应读到树冠高度/避开丛林（当前路线爬向 y≈90，撞进未读或高处的树叶）。

## 组 4：腿界扫描与完整臂归因（2026-09-21，客户端 0.2.52）

**同路线 A/B（cave-ab-13，两臂都跑）**

| 臂 | 跨线 | 备注 |
| --- | --- | --- |
| 完整下发 | **受控跨线**（tick 23550、(−998.4,63.3,18.8)、速度 1.64、rev 1） | 旧失败（ab-10/11 的 40/40 拒绝）已被 0.2.48–0.52 的到站/比较/俯仰修复关闭 |
| 分腿交接 | **受控跨线**（tick 23730、(−998.8,63.9,19.7)、速度 1.67、rev 3） | 跨线后推进到 z≈−67、y≈83，最终 `oak_leaves` t3 碰撞（entry 4/4） |

**腿界扫描（`cave-bnd-z{35,20,5}`，分腿臂）**

| 腿界 | 跨线 | 交接点 |
| --- | --- | --- |
| z=35（转弯前） | **受控**（tick 24986、速度 1.68、rev 3） | rev3 在 z=27.3、rev4 在 z=7.5 采纳 |
| z=20（转弯中） | **受控**（tick 25718、速度 1.66、rev 1） | 首腿在截面附近完成；rev3 z=9.7、rev4 z=−5 采纳 |
| z=5（转弯后） | **未受控**（入水，rev 1） | 首腿过长（到 z=5），无接力支持下先行下沉入水 |

**完整臂跨线后的失败链（样本）**：发射交接到 y=75.9（boost 33），此后 **无点火** 一路下沉：75.9 → 62.8（40 tick，−0.32/tick），而路线剖面是 74.5→63.5（约 −0.1/tick）——**实际下沉速率约为剖面 3 倍**，到 z≈20 时只剩 1.5 格余量，随即入水；`routeLowerBound−6` 与 `surface+4` 构成的继续性下界在多数 tick 仍放行了轻微下沉的无火候选，累积漂移后失守。结论：完整臂的下一处修复是**剖面/能量下界**（把继续性下界绑到路线局部高度并留更厚的贴水余量，或让候选在预测中就体现累积下沉），不是交接、也不是 A*。

## 空中平台固定通道与 hold 直线化（2026-09-21，客户端 0.2.52）

- 场地确认（只读扫描 `get_blocks_region`）：平台石面 y=200（行走面 201），西缘 x=240，红色混凝土 3×3 (299..301,201,−1..1)，起飞柱 x=240、z=−18..−16；西侧 x −60..239、y 168..206、z −24..−10 **全净空**（0 非空气格）。固定直线通道 `cave-lane-route-01.json`（(245,201,−17) → 每 40 格降 4 → (−60,171,−17)），`E02_AB_CROSS_X=−40` 越线判定。
- hold 直线化修复：旧 hold 的目标在 `beginHold` 固定，滑翔机飞到后绕它转圈并点火保高（`lane-pert-timeout` 样本：直飞 20 tick 后 yaw 92→−88→−170→119→47… 整圈，5 秒宽限共 2 次点火）。现改为**航向保持**（目标每 tick 取当前位置沿当前速度前方 48 格），新增回归 `theHoldFollowsTheHeadingInsteadOfOrbitingAFixedPoint`。
- 复测 `lane-pert-timeout-2`：hold 全程 **yaw 恒 90、x 200→39 直线**，8 次点火保高度，宽限到点仍以 typed `handover_timeout` 结束——语义与视觉都对。
- 迟到正例 `lane-pert-late-3`（`E02_AB_REANCHOR`：每腿按实测位置重锚 60 格，等价生产预规划）：6 次提交全部采纳，**受控越线**（tick 12389、x≤−40、速度 1.65、rev 3），连续推进到 x≈−357 才进入通道外的自然地形（`orange_terracotta` t3 碰撞，HP 14.5）——越界属夹具范围外，非客户端缺陷；后续给重锚模式加西界（x≥−60）。

## 组 2/3：分段语义与时序扰动（2026-09-21，客户端 0.2.51）

- `FlightHandover` 升级为**有状态**状态机（pending/修订/年龄/交接计数 + `offer`/`decide`/`adopt`/`completeAdoption`/`dropPending`）；控制器不再持有 pending 字段，全部委托。新增 `offer` 排序规则：重复 id、修订不新于 pending、修订不新于在飞会话一律拒绝。
- 组 2 规则测试：提前就绪（入口在 2×reach 内且当前未完成 → 立即 ADOPT，不落入 waiting）；交接后目标不回退（既有用例）；首点已过站跳过（既有用例）。
- 组 3 规则测试：迟到但可接（当前完成 + 可连 → ADOPT）；完成时不可连 → DROP；超龄 → DROP；重复投递/乱序旧修订不覆盖新路线；新修订覆盖；≤在飞修订拒绝；入水不可连。客户端单测 **22/22**。

**真机时序扰动（cave-pert-*，仅分腿臂）**

| 场景 | 结果 |
| --- | --- |
| `early`（下一腿立即提前提交） | 连续 4 次交接，**受控跨线**（tick 8736、(−998.6,63,19)、速度 1.68、rev 3）；后段 `oak_leaves` t1 碰撞转有界收尾 |
| `late`（hold 后 1.5–3 s 提交） | 首腿在 z≈53.8 进入 hold；hold 仅存活 22 tick（~1.1 s）后候选全被拒（`no_viable`，入口 4/4），**明确失败**，迟到腿尚未到达；未发生静默挂起 |
| `timeout`（不再提交） | 同上：hold 的候选先行失败（typed `no_viable`），未走到 `handover_timeout` 宽限到期 |
| `duplicate`（同 id 重投） | 第二次投递被幂等应答（`accepted=true` 但未二次接管，交接计数只加一次）；随后连续交接，**受控跨线**（rev 2）并推进到 **z≈−38.5**（y≈91.6），最终 `damage`（HP 17.3） |

结论：提前交接与重复投递的行为符合判据；`late`/`timeout` 因**等待（hold）本身在开阔河道上仅存活 ~1.1 s** 而提前以 typed `no_viable` 收尾——需要一段净空滑翔窗口才能测到"稍晚但有等待余量"与真正的 `handover_timeout`，这属于夹具场景的下一个修正（把首腿终点放到净空更长的河段）。

## 交接规则抽取与控制器级回放（2026-09-21，客户端 0.2.50）

复核组 1 的第一项：把 `acceptHandover/adoptPendingIfReady` 的判定抽成纯逻辑，做"同状态、同路线、只换会话"回放。

- 新增 `FlightHandover`（无 Minecraft 依赖）：`PilotState`（位置/速度/滑翔/介质）、`canConnect`（滑翔、非入水、入口不高于滑翔包线、按速度的可达距离）、`decide`（KEEP/DROP/ADOPT，含"当前路线完成后不可接则丢弃"）、`adopt`（移交未完成的点火冷却）。
- 控制器改为委托：`pilotStateOf(p)` + `FlightHandover.decide/adopt`，字段更新不变（`handoverCount`、`sessionStartTick`、`applyingStarted` 与原逻辑一致）。
- 新增控制器级回放用例 `controllerLevelReplayMatchesDecisionsAcrossAHandover`：同一状态序列喂两臂，A 臂继续原会话，B 臂在第 5 tick 起通过真实规则接入"剩余路线"；逐 tick 断言 applicability/fire/yaw/pitch/目标距离一致（会话身份与交接计数除外）。另含冷却继承、首点跳过、终末不提前完成等用例。
- 客户端单测 **13/13**。

## 到站检查与首点判定批（2026-09-21，客户端 0.2.49）

复核跟进（用户核对）：①预测进入航路点半径后跳过了高度/速度检查；②新会话的第一个点无法触发"已过站"判定。ab-11 证据同时证实：holding 期确有额外点火（tick 1702），rev4/rev5 采纳后分别出现 174.7°→10.5°、170°→−20.9° 的反向追点。

| 修复 | 内容 |
| --- | --- |
| 到站仍查继续性 | 到达航路点的候选也要过"水面净空 + 末速"检查（到站净空 0.5 格，因路线自身可能贴水飞；非到站维持 4 格与下界）。拒绝原因标记为 `arrival_floor`/`arrival_speed` |
| 新会话首点 | 首个航路点改用首段方向（`path[1]−path[0]`）做平面投影判定，已被飞过的首点直接跳过，不再回头 |
| 回归 | 新增 `aNewSessionsFirstPointIsSkippedWhenAlreadyBehind`；客户端 12/12 |

**A/B（cave-route-ab-12，0.2.49，同一 19 点冻结路线）**

| 臂 | 跨线（z=20） | 后续 |
| --- | --- | --- |
| 完整下发 | **受控跨线**：tick 1776、( −999.9, 63.25, 19.95 )、速度 0.87、`controlled=true`、revision 1 | 越线后 z≈13 入水（全程 1 次点火） |
| 分腿交接 | **受控跨线**：tick 1966、( −997.83, 66.10, 18.95 )、速度 1.67、boost=32、revision 3 | 7 次提交连续推进到 **z≈−65.8**（y=84.5，羊毛闸门方向）；最后 `reject[c=40,f=0,s=0] first=collision@t3(-956.4,83.3,-67.9)block=grass_block`（entry 4/4）转有界收尾 |

航向反转扫描：仅剩发射段（−45°→−173°）的正常转向；采纳后的反向追点已消失。

## 查询契约与归因批（2026-09-21，客户端 0.2.48）

按 `docs/fork/elytra-flight-control-client-review-20260921.md` 的四点与建议顺序执行。

| 项 | 交付 | 验证 |
| --- | --- | --- |
| 1 查询契约 | 生产 `flightBlockQuery` 保留水/流体为 `minecraft:water`（其余空碰撞仍 `passable`）；`FlightSession` 分离三种语义：碰撞可穿越（`isFlyableThrough`，水可穿）、水面扫描（水是表面，停在水平面而非河床）、介质切换（控制器 `p.isInWater()` → `water` 终态） | `FlightSessionHoldTest` 水面净空 = 69；新增连续低空飞行用例 |
| 2 拒绝分类 | 每个候选记录首个拒绝原因（collision/floor/speed，含计数与预测 tick/点/方块），随 `endDetail` 落盘；`endDetail` 形如 `reject[c=22,f=18,s=0] first=collision@t17(-992.5,55.6,32.0)block=dirt` | ab-10 定位到"预测在目标之后钻地" |
| 3 显式比较顺序 | 移除 +50 加权罚分，改为 `better()`：可行性 → 进度/跟随质量（1 格等价带）→ 烟花消耗；新增用例（可行且进度不差 → 不点火） | `FlightSessionContinuationTest` |
| 4 交接状态继承 | 交接不再重置点火冷却：`inheritFireCooldown`/`fireCooldownRemaining`/`fireCooldownTicks`，控制器采纳时从旧会话继承；冷却是会话属性（发射机 boost 交接也写入会话） | `FlightHandoverReplayTest`（同状态、同路线、只换会话：目标/决策/冷却一致） |
| 已过站判定 | `advanceEntries` 增加**平面投影**判定（范围 24 格内、越过航路点平面 >1 格即视为已过；终末点仍只认到达半径），修复"已飞过的入口重新成为追逐目标" | 新增 3 例（不回头追、终末不提前完成） |
| 预测到站终止 | 预测在到达当前航路点时结束，不再把"过站后的固定姿态飞行"当作碰撞：ab-10 两臂 40 候选中 22 个因 `t17` 钻地（目标之后 15 格）被拒、18 个被高度下界拒 | ab-11 复测 |
| 复盘材料 | A/B 记录补齐完整 19 航路点与每臂每腿路径；环样本含 yaw/pitch/boost/介质/烟花 | `cave-route-ab-10/11.jsonl` |

**A/B（cave-route-ab-11，同一 19 点冻结路线，0.2.48）**

| 臂 | 结果 | 截面 z=20 |
| --- | --- | --- |
| 完整下发 | 跨线样本 `inWater=true`、`owner=none`、`controlled=false`（恰在入水瞬间越线），`water` 终态；全程 1 次点火 | **未受控跨线** |
| 分腿交接 | 跨线样本 (−998.15, 66.28, **19.15**) 水平速度 1.67、boost=32、gliding、owner=flight-session、revision 3、`controlled=true`、`inRiverBand=true`；继续飞到 z≈2.2（y=71.7）后因起始姿态盒与 `oak_leaves` 重叠（`reject[c=20,f=0,s=0] first=collision@t0`）转有界收尾 | **受控跨线并通过截面后继续** |

分腿臂的 leg4/5/6 均被接受，交接后目标/进度未再回退；完整臂仍少点火（1 次）导致下滑入水。按复核决策树：完整失败 + 分腿通过 → 继续查驱动/推进策略（完整臂的候选集/点火时机），下一批按"同状态、同路线、只换会话"的控制器级回放定位首个决策差异（当前已有会话级回放用例，控制器级需要抽出交接状态机）。

## 客户端执行批：归责实验（2026-09-21，客户端 0.2.46）

按 `docs/fork/elytra-flight-control-client-review-20260921.md` 的顺序执行：先修确定的实现错误，再修夹具与遥测，最后改判定顺序并重跑同路线 A/B。

| 项 | 交付 | 验证 |
| --- | --- | --- |
| `holdY` 遮蔽 | `beginHold` 的局部变量改为 `targetY`，字段 `holdY` 正确写入；新增 `holdTarget()` 供探针/测试 | `FlightSessionHoldTest` 3 例（含"目标不为 0"回归） |
| 判定顺序（复核裁定 2） | 候选先过碰撞/介质/通道下界/预测后可继续（下界 = 路线剩余最低点−6 与预测终点地面+4 取高；末速 ≥0.25）；再比进度；烟花 +50 罚分为**最后**比较；取消"仅低速/需爬升才评估点火"的门 | `FlightSessionContinuationTest` 2 例（低空必点火、宽裕不点火） |
| 俯仰基准 | 候选俯仰改为相对**瞄准线**（到当前航路点），不再相对当前姿态——发射后 -35° 鼻上会锁死候选集（ab-05 冲高至 y≈296、7 次点火） | 同上单测 + ab-09（点火 1 次，剖面 74→69） |
| 入水/介质 | 客户端 `p.isInWater()` 时立即以 `water` 结束（空气模型无水态）；环样本新增 `inWater`/`rocketsInHands`/`rocketsInInventory`；主机把 `water` 归为 `landing_in_water` 终态且 `airborneAtReturn=false` | ab-09 环样本、主机 `channel.failure` |
| 烟花供应 | `equipRocketOffhand` 返回布尔并公开；驱动每 tick 双手为空时补弹；主机/状态/环记录补弹计数与库存 | ab-09 环内 `rocketsInHands=63`、`rocketResupplies>0` |
| 截面夹具 | 冻结路线改为链接多段**已验证**通道，直到终点满足"整个完成半径都在截面之后"（`z ≤ crossZ − entryReach − 2`）；ab-09 路线 19 点、终点 z=−67.5 | `cave-route-ab-09.jsonl` |
| 夹具健壮性 | 每臂唯一 sessionId（客户端幂等记忆会回放旧接受）、按当前会话撤销、死亡先重生、抗性+饱食+落地确认（反射控制器曾以 `reflex_preempted` 掐掉起飞） | ab-04/05 故障 → ab-09 正常 |

**A/B 结果（cave-route-ab-09，同一条 19 点冻结路线，同起点）**

| 臂 | 提交 | 结果 | 截面 z=20 |
| --- | --- | --- | --- |
| 完整下发 | 1 | `no_viable_trajectory`（entry 5/19，位置 (−1000.3,69.2,37.0)，目标 (−996.5,63.5,31.5)，`eval=40 sim=9ms` 全拒） | **未跨** |
| 分腿交接 | 5 | 受控跨线后继续到 z=8.3 入水（`water`），零掉血 | **受控跨过**：tick 7727、(−1001.38,67.38,19.13)、水平速度 1.48、gliding、inputOwner=flight-session、revision 3、`controlled=true`、`inRiverBand=true` |

按复核第 6 节决策树：**完整下发失败而分腿通过 → 下一步修驱动/模型**（完整臂在 z≈37 处 40 候选全被扫掠拒绝，需诊断姿态/地形/sweep），不是交接、也不是 A*。跨线后的稳定收尾分类需 ≥20 连续同介质样本，ab-09 结束时样本不足，`ending=airborne` 为如实记录。

## 河湾批：验证缺口 + 覆盖/前沿选择（2026-09-20 深夜第三段）

目标：稳定通过首个河湾；下发段全部验证、交接连续、失败可确认接地。按复核顺序执行。

| 项 | 交付 | 验证 |
| --- | --- | --- |
| 验证缺口（复核 3） | `channelPathOfVerified` 返回 `Vec3[] \| undefined`：两点路径也过机体盒扫掠；找不到任何通过检查的回退点时不再输出相邻 A* 点，而是 `blocked: channel_unverified`；终止点强制校验 | `low-route.test.ts` 34 通过 |
| 覆盖 vs 选择（复核 1） | 新增覆盖分析模式（`E02_MODE=analysis`，可用 `E02_SNAPSHOT_FILE` 离线重放）：一次读取峡谷快照，再对 `halfWidth 4/8/12/16/24` 跑真实规划器 + 整幅直连 A* | `cave-coverage-01/02/03/04.jsonl` 与 `.snapshot.json` |
| 多前沿比较 | 前沿由"沿方位进度最大单点"改为候选集合：开天优先、8 格去重、最多 8 个候选、最多 4 次有界搜索；评分 = 进度 − 肩环墙代价 − 3×爬升，**不再把航段长度当成本**；直接可连候选与搜索路线同币比较 | 快照 hw=4：reached 47.6、climb 0、river 0.83（旧选择：reached 78.6、climb 0.74 岸顶） |
| 前缀校验误判 | 机体离提交路线 >24 格时跳过前缀校验（发射助推可把滑翔机抬到首个航路点上方 50 格，R4 cave-diag-14 在桥面就烧掉重规划预算） | cave-diag-15 轨迹 `prefix verification skipped; 46 blocks off the route` |

**快照结论（cave-coverage-01/02/03/04）**：整幅直连 A* 存在 70 点、`maxClimbSlope=0`、`minY=65.5` 的河道路线 → 此前失败是**"读到了却选错路"**，不是覆盖不足。改正选择后同一快照所有窗宽都给出 level 河道路线。

**真机 cave-diag-13/15/16**（诊断模式，零掉血）：河道内推进到 z≈27–31（此前 z≈35 即被拒），连续交接 2–3 次（客户端计数最高 10）。`cave-diag-16` leg 3 的计划已**越过首个河湾**（z 19.5 → −4.5 平飞，再沿东岸爬升到 −81.5 朝羊毛闸门）。剩余阻塞：采纳该腿后客户端停在 (−996.6, 60, 30) 水面附近，环样本 `inputOwner=none`、速度 0（客户端驱动未出输入），主机看门狗 30 s 后在原地收尾；`airborneAtReturn=true`，尚未证明失败后稳定接地。

## 路径可飞性批（2026-09-20 深夜第二段，TS-only）

按复核"再下一批：让路径保持可飞"交付：

| 项 | 交付 | 验证 |
| --- | --- | --- |
| 简化段重扫 | 通道抽稀移入规划器（`low-route.ts` 的 `channelPathOfVerified`）：每个直连段用机体盒（半宽 0.45 + 0.2 余量、高 1.8）逐 0.5 格复检；被挡的段回退到更细的 A* 点，回退段同样复检；终止点保留。主机不再自行抽稀 | 新单测 `thins the channel path only where the body box fits along the chord`（弯道不穿墙） |
| 身体净空硬约束 | `corridor.ts` 的 `bodyFootprintClear`：节点及其 ±1 水平邻格在机体高度内必须是空气；空间搜索改惰性 memo 判定（大窗口不再在预计算上耗尽时限） | 平地图 `halfWidth 16` 用例由 `blocked: time_cap` 恢复为 planned |
| 靠壁代价 | `wallCost`（肩环 16 格，0.25/格）+ 爬升代价（1.2/格）+ 禁止原地垂直爬升（无水平进度的 dy>0）；启发权重 1.2→1.5、主机规划时限 2 s→4 s | 全套 flight 157 通过 |
| 前沿垂直带 | `goal.y ± 2` → `goal.y − 8 .. + 16`，同进度时优先贴近目标层 | 峡谷早段前沿不再被 ±2 卡死 |
| 走廊航向 | 主机把实测速度方向（与目标方位差 ≤75° 时）作为读取窗与前沿方位；直线目标方位在峡谷里只覆盖岸壁 | cave-diag-12 早段由 z≈35 推进到 z≈28 |
| 读取窗边缘 | 读取沿航向多覆盖 2 格，机体盒在窗边的假拒绝消失；前沿扫描改为按层索引（不再解析全部键） | 同上 |

离线：`flight` 12 文件 157 通过；`elytra.test.ts` 48 通过；typecheck/lint 0。

真机 cave-diag-08..12（诊断模式，零掉血）：航向修复后早段推进到 z≈28（此前 z≈35 即被拒），但仍在东岸壁面被拒。`endDetail` = `entry=4/8 target=-992.5,79.5,36.5 at=-995.3,71.4,37.5 pitch=-40`——航线第 4 个航路点在岸顶上方 8 格，滑翔机从河谷 62 一路爬到 71 后无法在候选视界内贴壁再爬 8 格，20 个候选全被扫掠拒绝。

**根因（下一批）**：读取窗/前沿仍沿"一条方位带"延伸（半宽 4 格）。峡谷在早段偏离目标方位约 25°，窗带只覆盖东岸壁，A* 只能在窗内爬岸；需要让窗带跟随开阔空间（如走廊规划器那样按空间展开，或多方位候选取最优进度），并给航线做"提前爬升"的垂直剖面整形（把必需爬升摊到障碍前足够长的水平距离）。

## 连续交接与失效收尾批（2026-09-20 深夜，0.2.43）

按 `docs/fork/elytra-flight-control-progress-review.md` 的一至五项交付。

| 项 | 交付 | 证据 |
| --- | --- | --- |
| 1 夹具/证据 | 环游标用当前 tick 预热（不再读入上一轮）；环样本带 `sessionId`/`revision`/`holding`（Java 原生字段 + 采集器兜底）；每条腿记录 `plannedFrom`/`planMs`/`rawPath`/`sentPath`/`submittedAtMs`/`endedReason`/`positionAtEnd`；结果带 `airborneAtReturn` | `cave-diag-07.jsonl` 的 `channel.legs`、`ringSamples` |
| 2 提前规划 | 距前沿 64 格开始预规划、32 格内提前提交；前沿续接与失败重试分开计数（`continuations` vs `replans`，上限 12 vs 3） | 轨迹 `channel prefetching the next leg 58 blocks out`、`channel handover leg ready 8 blocks out; submitting early` |
| 3 客户端交接 | 同一飞行任务接受待接入路线（身份/代次/维度/在飞/入口距离校验），tick 边界切换，唯一输入所有者；`handoverCapable`/`pendingSessionId`/`handoverCount` 遥测 | `channel handover adopted by the client (1)(2)`；leg1/leg2 `endedReason=handover` |
| 4 无新路线的确定行为 | 路线耗尽后进入有界保持（沿航向缓降，5 秒宽限），新路线到达即接入，超时 `handover_timeout` 交主机收尾；不再保持旧姿态等待 | `FlightSession.beginHold`/`HANDOVER_TIMEOUT`；单测 `continues the flight when the client holds after its path` |
| 5 统一空中收尾 | 读失败、`route_unavailable`、`handover_timeout` 等空中失败全部进入有界安全落地；`channel.failure` + `airborneAtReturn` 分开记录"函数返回"与"安全接地" | cave-diag-07：`failure=landing_in_water`、`airborneAtReturn=true`、health 20 |

离线：`elytra.test.ts` 48 通过（新增提前交接、保持续飞、保持超时收尾 3 例）；game-host 套件 954 通过 / 1 跳过；typecheck、lint 0。

真机 cave-diag-07（0.2.43，SHA256 `A768B214764012D074A9BF76B0C688E0DB3E6E9F1352DA25A34D5877A476446A`）：两次交接成功、零掉血；早段推进到 (-997.3, 64.4, 19.1) 后两条腿都在同一处 `no_viable_trajectory`（`eval=20 sim=0ms`），双拒守卫转有界落地，落在河面（`landing_in_water`，非安全接地但零伤害）。

**根因（新，供下一批）**：该点 `execute if block -997 65 19 minecraft:air` 为假——机体盒（±0.45）已与岸壁方块重叠，客户端"起始姿态已碰撞"故 20 个候选全部立即被拒；航线 x≈-997.5 贴岸，缺少横向净空。属复核"再下一批：让路径保持可飞"的规划器净空与简化段重扫问题，不是交接问题。

## 离线

| 命令 | 结果 |
| --- | --- |
| `pnpm exec vitest run --config apps/stage-tamagotchi/vitest.node.config.ts src/main/services/airi/game-host/movement/elytra.test.ts` | 41 通过（含 3 例 `evaluateApproachEntry` 门测试：五种拒绝原因、正常进入、短进近豁免）。 |
| `pnpm -F @proj-airi/stage-tamagotchi typecheck` | 0 错误。 |
| `pnpm exec moeru-lint <touched files>` | 0 错误。 |

## 真机（器具自检，非验收）

```powershell
$env:E02_MODE='formal'
$env:E02_CONFIG='D:\airi\docs\fork\evidence\elytra-flight-control-20260920\R4-20260920-01\validation-config.json'
$env:E02_START='-1007,74,79'; $env:E02_GOAL='-997,67,-8'
$env:E02_OUT='D:\airi\docs\fork\evidence\elytra-flight-control-20260920\R4-20260920-01\harness-validation.jsonl'
pnpm exec vitest run --config apps/stage-tamagotchi/vitest.node.config.ts src/main/services/airi/game-host/movement/e02-route.integration.test.ts
```

结果：正式模式停批并保留记录。12 项检查中仅 `status` 违反（主机 `tolerance: 2`，落点 3.7 格 → `stuck`）；`horizontal/vertical/onGround/touchdownSpeed/stableGround/support/dimension/health/healthLoss/rockets` 均通过；`channel.endReason=channel_complete`。证明断言与停批路径工作，不构成 R4 验收。

## 碰撞诊断与修复（0.2.38/0.2.39 + 主机落地守卫）

| 运行 | 构建 | 结果 |
| --- | --- | --- |
| collision-diag-01 | 0.2.38（段扫掠 + 环生命 + 应用期受伤即终止） | 客户端在河道低带连续 `no_viable`（水面被当墙）；主机 3 次禁区重规划耗尽 → `route_unavailable`；落地段掉血 20→12.56 |
| collision-diag-02 | 0.2.39（水面可通行）+ 环采集 | 通道 4 次提交 / 3 次重规划后 `channel_complete`；**客户端驱动段零伤害**；掉血 20→17.96 出现在主机落地段（`owner=none`、`gliding=true`、y≈63） |
| collision-diag-03 | 同上 + 主机贴地拉平守卫 | **全程零伤害（minHealth 20）**；通道在河湾处 `no_viable` 预算耗尽 → `route_unavailable`（航路可行性抖动，不是伤害） |
| collision-diag-04 | 0.2.40（真实碰撞形状判定可通行） | **全程零伤害**；航程推进到距目标 21.5 格；最后一段前沿续飞被客户端拒绝（4 点路径 `no_viable`）→ `route_unavailable`。可行走判定改为读 `getCollisionShape`：水/草/甘蔗/铁轨等无碰撞方块可通行，岩浆/火/甜浆果丛仍按障碍。 |
| approach-diag-01 | 主机进近通道 + 近终点回退 | 通道飞完整条河道（revision 2，11 点）；最后一段仍被客户端拒绝，主机按新回退规则接手落地；落水并掉血 20→11.24（伤害仍在**主机回退落地段**，`owner=none`、`gliding=true`）。进近通道机制未被触发（需要通道在终点非本地完成）。 |

## 进近通道（R4，主机侧）

- `channel_complete` 且距目标 ≤80 格且存在**已验证落点**时，把最后一段作为新通道提交：**3–5 点递降剖面**（`CHANNEL_APPROACH_PROFILE_STEP` 14 格、受顶棚约束、末点必须是已验证落点）、`entryReach 4`；客户端驱动到 ≤4 格后主机拉平分类。落点与 `aim` 随切换种子传给主机，避免主机重新选点。
- 客户端拒绝剖面时用直连两点重试一次；再拒绝时**只在距落点 ≤8 格且高于落点 ≤6 格**时让主机拉平，否则走有界安全落地——不再做长距离主机启发式飞行。
- **无已验证落点时不复飞**（`enterGoAround` 直接转安全落地）：approach-diag-03 中未核实瞄准点 + 复飞导致死亡。
- 单测：剖面提交（≥3 点）、拒绝重试、客户端拒绝后回退、无落点不复飞。

## 补充真机诊断

| 运行 | 结果 |
| --- | --- |
| approach-diag-02 | 全程零伤害；航线推进到距目标 24.2 格；末端仍被客户端拒绝 → 主机回退软着陆。 |
| approach-diag-03 | 河道终点**没有可降落支撑**：`findLandingSite` 为空 → 主机按未核实点飞行 + 复飞 → 死亡（`touchdown_unverified`、health 0）。结论：河道终点不适合做验收目标；已加"无落点不复飞"策略。 |
| cave-diag-01（0.2.41） | 换回 R4 真目标洞穴平台 (-843,65,-266)：初始规划只有 8 点（目标区块未加载，本地前沿），客户端在 (-987,24) 连续拒绝 → `route_unavailable`，距目标 324 格。客户端驱动在峡谷低航路上的航路可行性是下一阻塞。 |
| cave-diag-02/03（0.2.41/0.2.42 遥测） | 客户端仍在 (-988,28) 附近拒绝；`endDetail`（0.2.42）：**`eval=24 sim=0ms entry=1/2 target=-979.5,63.5,20.5 at=-987.6,63.1,27.2 pitch=60`** —— 24 个候选全部被扫掠拒绝、**不是预算问题**；目标航路点 (-979.5,63.5,20.5) 位于东侧山体内部（该列地表顶约 y=88），是主机本地前沿规划选出的**洞穴内空气槽**；客户端拒绝正确。结论：峡谷早段阻塞在**主机本地前沿航路点选进山体内部**，不是客户端驾驶性能。 |

0.2.41：客户端 `flight.status` 增加 `endDetail`（终局时的候选数/耗时/拒绝原因），用于定位末端拒绝。

修复：

- Java **0.2.38**：逐 tick 点采样扫掠 → **段扫掠**（0.5 格步长，防切角与薄墙；`simBudgetMs` 8→12 ms）；轨迹环记录每 tick 生命；应用期生命下降即 `terminateIfActive("damage")`。
- Java **0.2.39**：水面按可通行处理（溅落是类型化落水结局，不是碰撞；此前低带候选全被水面拒绝 → `no_viable`）。
- Java **0.2.40**：可通行判定改读 `BlockState.getCollisionShape`——水、草、甘蔗、铁轨、火把等**无碰撞形状**的方块标为 `passable`（不再按 id 猜测）；岩浆、火、甜浆果丛仍为障碍（伤害类）；未知/未加载仍为 `null`。
- 主机：进近/落地段前方 `TERRAIN_GUARD_DISTANCE` 内的地形一律拉平（原来只在低于巡航带 4 格时才拉）；客户端 `damage` 终局映射为安全落地；`FlightChannelSample.health` 进入端口与记录。
- 证据：`collision-diag-01..04.jsonl`（含 `ringSamples` 逐 tick 生命与输入所有者）。

## 自建验证平台与链路验收（2026-09-20 晚）

夹具（自建，服务端控制台 + `forceload` 绕开未加载区块）：9×9 石台 `y=70..71`（台面 y=72），`x -994..-986, z 36..44`，河道东岸。配置：`pad-validation-config.json`（水平/垂直容差 2、接地速度 ≤0.5、稳定接地 1s、允许掉血 0、烟花 ≥4）。

| 运行 | 模式 | 结果 |
| --- | --- | --- |
| pad-diag-01 | diagnostic | 进近链路首次触发：通道 → 禁区重规划 → 终段 `channel_complete` → 主机拉平；**落点在台面下 2.4 格、差 2.5 格**（瞄准点在台面高度，客户端下滑低于台缘） |
| pad-diag-02 | diagnostic | 平台过小，落点搜索选中旁边河岸；客户端两次拒绝进近，主机短拉平从瞄准点下方 5 格爬升 → **死亡**。修复：瞄准点抬高 2.5 格（受顶棚约束）、短拉平要求位于瞄准点上方、平台扩到 9×9 |
| pad-diag-03 | diagnostic | **`reached`：水平差 0.64 格、垂直 0、零伤害、满血、单次重规划**。整条链路（通道 → 禁区重规划 → 3–5 点递降剖面 → 主机拉平 → 台面接地）跑通 |
| pad-formal-01 | formal | 同一夹具第二次运行未达标：差 7.8 格、低 10.3 格、落水、`onGround=false`；12 项断言正确列出 5 项违反并停批。**链路可达但重复性不足**，正式 20 次批次前需要稳定进近/交接点 |
| pad-runs-01（5 次诊断） | diagnostic | 1/5 reached；失败模式：落点搜索沿航向先选到旁边河岸（y≈80 或水中），进近/回退落到错误平台 |
| pad-runs-02（5 次诊断，目标锚定落点） | diagnostic | **4/5 reached**（差 0.5–1.3 格、零伤害）；1 次通道 `no_viable` 预算耗尽后回退落偏（差 10 格、掉血 10.8） |
| pad-formal-02（3 次正式） | formal | **3/3 全过**：差 0.05/0.35/0.36 格、垂直 0、零掉血、支撑 `minecraft:stone`、接地速度 ≈0、稳定接地通过、0 项违反 |

新增修复（重复性）：**目标锚定落点搜索** `findGoalLandingSite`——在目标 ±8 格范围内读取并评估平台，选离目标最近的可用面；进近段与主机回退都优先用它，航向前扫降级为后备。修复前落点总被旁边河岸/水面抢走。

结论：夹具搭建与器具验收可以自动化完成；平台上正式断言已 3/3 通过。剩余：偶发通道 `no_viable`（1/5）、峡谷低航路（cave-diag-01）。

## 峡谷修复批次（2026-09-20 晚，遥测驱动）

| 运行 | 结果 |
| --- | --- |
| cave-diag-04（前沿开天前） | 客户端不再撞山洞穴航路点，但主机只检测"没移动"，客户端原地绕圈 165 秒未被发现 → 主机 deadline 收尾 |
| cave-diag-05（重复拒绝 + 原地点下降前） | 前沿续飞被拒 → 禁区重规划 → 再次被拒 → **同一地点两次拒绝守卫生效**（停止重规划）；但主机仍飞向未核实点并死亡 |
| cave-diag-06（全部修复后） | **零死亡**（health 20）；通道第二段仍被客户端拒绝：`endDetail` = `eval=20 sim=0ms entry=1/3 target=-997.5,67.5,18.5 at=-989.8,62.7,21.3 pitch=-35`——20 个候选全被拒、非预算；滑翔机距东岸约 4 格、需从 62.7 爬到 67.5，客户端判定无法安全转出（正确拒绝） |

本批修复：

1. **本地前沿开天优先**（`low-route.ts`）：前沿扫描先只考虑开天候选（列在读取窗口内无顶棚/山体），找不到才回退到顶棚下走廊。修掉"前沿选进山体洞穴"。
2. **盘旋检测**（`elytra.ts`）：除"没移动"外，新增"目标距离 30 秒无改善即盘旋"→ 重规划一次，预算耗尽转有界收尾。修掉原地绕圈 165 秒。
3. **同一地点两次拒绝停止重规划**（`elytra.ts`）：转有界收尾，不再烧预算与两分钟。
4. **无落点收尾改为原地最小风险下降**（`elytra.ts`）：不再飞向未核实点（cave-diag-05 的死亡路径）。

单测：前沿开天 1 例、盘旋 1 例、重复拒绝 1 例、原地下降 2 例更新。离线套件 **951 通过 / 1 跳过**。

剩余（下一批）：峡谷低航路贴着东岸飞行，客户端在距岸 4 格处拒绝转弯/爬升——需要规划器保持横向净空（航线走河道中心）或客户端增加"脱离地形"原语。

## 备注

- 验收目标配置为 `acceptance-config.json`（洞穴平台），正式批次未启动：目标尚不可达且碰撞掉血未清零。
- 器具自检使用了单独的 `validation-config.json`（短河段垫、宽容差、允许 20 掉血），与验收配置分离，避免污染冻结判据。
