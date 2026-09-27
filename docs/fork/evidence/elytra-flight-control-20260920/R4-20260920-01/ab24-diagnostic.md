# ab-24 诊断对结果（2026-09-21，客户端 0.2.63+1.21.1）

材料：`cave-ab-24.jsonl`（两臂完整样本 + D1 遥测 + D3 门控）。路线哈希：完整臂 `71e91313`、分腿臂 `cdf5305f`。客户端 build 经探针确认为 `0.2.63+1.21.1`（`clientBuild` 字段在本轮因采集源在 status 而非样本而缺省，夹具已修正，下一轮起写入）。

## 门控（D3 六条 + 跨线分开记录）

| 门控 | 完整臂 | 分腿臂 |
| --- | --- | --- |
| controlledRouteCrossing | ✅ tick 9879 (-1001.4, 70.6, 19.7) 速度 1.62 受控 | ✅ tick 10207 (-1006.9, 68.7, 19.5) 速度 1.63 受控 |
| geometryChecked（无预算耗尽 tick） | ❌ `budgetExhaustedTicks=5` | ✅ `0` |
| noAutoSubmitAfterFailure | ✅ 0 次 | ✅ 0 次 |
| settledBeforeDeadline | ✅ 稳定 20 tick 接地 | ✅ 稳定 23 tick 接地 |
| flightDamageFree（全程最低血） | ❌ 最低 17.28（掉 2.72） | ✅ 20 |
| endingDamageFree（结束阶段可见掉血） | ❌ 2.72（首伤 t10001） | ✅ 0 |
| routeCrossing / recoveryCrossing | ✅ 跨线 t9879 / 恢复跨线 t9976 (-996.5, 92.1, -51.3) | ✅ 跨线 t10207 / 恢复跨线 t10218 (-1001.5, 71.4, 5.7) |

## 事实

- **两臂首次同时受控跨线**（此前 ab-20 分腿成功、ab-21/22/23 均早退）。完整臂随后推进到终末（`cursor 19/19`、全局进度 175.7），以 `terminal_action@t15 grass_block` 结束；分腿臂在树冠段（`terminal_action@t6 oak_leaves`）结束，两臂都由客户端恢复安全接地。
- 完整臂的 5 个预算耗尽 tick 出现在长路线（215 个受控 tick）；分腿臂 53 个受控 tick 无耗尽。B5 的耗时信号在真机上复现，`geometryChecked` 门控因此未过。
- 完整臂结束阶段掉血 2.72（最低血 17.28，首伤 t10001），落地后稳定；分腿臂零掉血。`stackedTicks=0`。
- 拒止原因均为 `terminal_action`（到站后 hold 在 t6/t15 遇到树叶/草方块），说明终端动作验证在真机上生效且不再伪装成 `land`。

## 结论（供审计）

- **分腿臂是一对干净诊断**：六条门控全过（受控跨线、几何检查、无自动提交、稳定结束、全程与结束无掉血、跨线分开记录）。
- **完整臂两条门控未过**：①5 个 tick 的搜索预算耗尽（候选 40 个、含到站候选的 26 tick 预测与 hold 验证，12 ms 不足）；②结束阶段 2.72 掉血（落地接触）。按 D3 规则，三对复现前应先解决这两项（预算调度/耗时或恢复落地质量）。
- 恢复跨线两臂都发生且被单独记录，未计入航路验收。

## 修正后重算（2026-09-22，ab-24 验收后的门控修正）

按审计第 6 节修正门控定义后用 `ab24-recompute.mjs` 重算原日志（原日志与上表保留）：

| 门控 | 完整臂 | 分腿臂 |
| --- | --- | --- |
| controlledRouteCrossing | true | true |
| **riverBandCrossing**（河道截面独立门控） | true（插值 x=-1001.40 在 [-1006,-994] 内） | **false**（插值 x=-1006.48 在带外——与审计计算一致） |
| **searchCompleted** | **false**（5 个预算耗尽 tick） | true |
| chosenTrajectoryVerified | true | true |
| recoveryTrajectoryVerified | unknown（字段晚于 ab-24 引入） | unknown |
| settledBeforeDeadline（带时钟比较） | true（settled 1790006274390 ≤ 估算期限 1790006410873） | true |
| flightDamageFree / endingDamageFree（要求完整观测） | false / false（2.72242，t10001） | true / true |
| **noUncontrolledAirborne** | **false**（1 tick） | **false**（5 tick） |
| routeCrossing / recoveryCrossing（真实穿越事件） | t9879 / **none** | t10207 / **none** |

**结论修正**：分腿臂**不是**一对干净诊断——河道截面门控为假（跨线点在带外）且存在 5 个无输入空中 tick；完整臂另有搜索未完成与结束掉血。审计的五项发现在重算后全部成立。原"六条全过"结论作废，`safe_ground` 更名为 `settled_ground`。

## 第一批修复（门控与所有权，2026-09-22，客户端源码）

- **软期限所有权**（审计 §3）：`recoveryWindowOpen/hasLiveControl/acceptBlockReason` 改为只依赖 **phase + 硬期限**；`recoveryPolicyExpired()` 仅表示需要重新决策。新增审计复现用例：`phase=RECOVER/LAND at=7001 hard=30000` 时 `live=true`、`acceptBlock="recovering"/"landing"`（旧用例曾把泄漏写成期望，已一并改正）。
- **LAND 失败转移**：`driveLanding` 在会话结束且仍在空中时调用 `returnToRecovery()`（保留所有权、重选），不再直接 `release`；新增回归。
- **恢复完整三维扫掠**（审计 §2）：新增 `FlightSession.verifyFrame(...)`（与航路候选同一物理与机体扫掠），恢复段对**最终 yaw 决定后**的动作做 6 tick 全轨迹验证，失败时依次回退到"平飞不点火"与"保持当前航向"；`clearanceAhead` 改用最终航向并统一 `FlightGeometry` 水面语义（删除控制器旧 `surfaceBelow`）；`recoveryFrameVerified` 进入遥测。
- **夹具门控**（审计 §6）：跨线改为**几何穿越事件 + 事件时所有者分类**（`recoveryCrossing` 不再要求布尔为真，重算确认两臂均为 none）；`riverBandCrossing` 独立门控；`searchCompleted`/`chosenTrajectoryVerified`/`recoveryTrajectoryVerified` 拆分；`settledBeforeDeadline` 带时钟比较；`endingDamageFree` 要求 `fullyObserved`；`settled_ground` 命名；`noUncontrolledAirborne` 计数；`flight-landing` owner 进入环记录；`searchCompleted` 客户端字段落地。
- **验证**：Java 全绿（Ownership 12、其余既有）；game-host movement 442/442；typecheck 0；lint 0。客户端 0.2.63 已部署（本批为源码修复，未再跑真机）。

**仍未完成（第二批/第三批）**：终端预测与真实 hold 的统一策略（共享过站规则、verifyHold 用真实候选评分、boost/库存/冷却完整推进、land 的水平撞击与法向检查）；预算归因（条件化 horizon+6、上一赢家全局优先、搜索未完成返回"未验证"、单调时钟、冷启动/预热分离）。两项完成后再跑一对新诊断，门控全过才进入三对复现。

## 第二、三批修复（2026-09-22，客户端源码 0.2.64）

按审计第 5、4 节实现，全部为代码层修复与离线回归（未再跑真机）。

**第二批：终端一致性与恢复扫掠**
- **共享过站规则**：抽出 `passedPlane(index, x, y, z)`，真实游标（`advanceEntries`）与预测虚拟游标使用同一规则（含"末点不参与平面过站"与 24 格范围保护）。
- **hold 验证 = 真实 hold 的策略**：`verifyHold` 每步遍历与航路相同的候选集（5 个 yaw 偏置 × 4 个 `PitchPolicy`，必要时才点火），并用与真实选择相同的 `selectBest`（进度→横向→高度→控制变化→少点火→policyId）选动作；hold 参考统一为 `beginHold` 写入的高度（三种参考合一）。
- **资源完整推进**：boost 剩余量取自推进后的状态（不再本地递减）、点火扣库存并启动冷却、冷却按步递减；外层首步已点火时传入扣除后的库存。
- **land 判据**：除支撑面/净空/温和下沉外，新增**必须为下降接触（vy ≤ 0）且水平撞击速度 ≤ 0.5**；以滑翔速度撞上升地形不再判 `land`（原"台地可着陆"用例按新规则改为拒绝，保留旧结论来源）。
- **恢复段最终动作验证**（第一批已落）：`verifyFrame` 全轨迹三维扫掠 + 回退链；控制器删除旧"跳过水体"的 `surfaceBelow`。

**第三批：预算归因与调度**
- **条件化时域**：普通候选只跑 `horizonTicks`，仅到站候选延长终端前瞻（旧实现无条件 +6，浪费约 1/5 物理步）。
- **全局优先序**：`candidateOrder()` 把上一获选策略放在**全局第一位**（不再受 yaw 分组割裂），随后 LEVEL/PULL_UP、AIM/AIM_PULL、最后点火变体；候选上限/时间预算的截断不再吃掉保命动作。
- **未完成搜索 ≠ 无路**：时间或候选上限中断且无任何完整验证的候选时返回 `search_incomplete`（含 `budgetReason`/已评估数），保持会话存活并在下一 tick 重选；只有完整搜索仍无可行候选才判 `NO_VIABLE_TRAJECTORY`。
- **单调时钟**：预算与 `simMs` 改用 `System.nanoTime()`（并修正 note 中的负耗时显示）；候选上限与时间预算分开上报（`budgetReason=time|candidate_cap`）。

**新增回归（`FlightSessionBudgetTest` 4 例 + 终端回归调整）**：普通候选恰好跑满时域；预测与真实游标共享平面过站（侧偏入口，球内永不到达）；`maxCandidates=1` 时被评估的必须是上一轮赢家；上限中断 → `search_incomplete` 且 `isDone()=false`，完整搜索后同一状态才判 `NO_VIABLE`；滑翔速度撞台地不再判 `land`。

**验证**：Java **81/81**；game-host vitest **975/975**；typecheck 0；lint 0；客户端 0.2.64 已构建（未部署）。

**下一步**：冷启动/预热预算归因（离线回放 + 交换两臂顺序，用逐 tick `simMs`/`physicsSteps`/`blockQueries` 分布定位首次 29 ms 的来源；不裁剪安全检查、不放宽 12 ms），随后按 D3 跑**一对新诊断**，门控全过再进入三对复现。

## 预算归因与两阶段验证（2026-09-22，客户端 0.2.65/0.2.66）

**离线归因**（`ab24-audit/BudgetProbe.java` + `budget-probe.txt`，生产类直接回放）：
- 冷启动首 tick（JVM 未预热）**78 ms、0 候选被评估**（时间截断）；预热会话 p50 1–2 ms / p95 3–5 ms。世界读取 26,672 次/tick。
- 两项修复：①`ColumnKey` 改为整数列 + 新增每 tick 的**方块格缓存**（`cellAt`），查询降到 ~1,650 次/tick、缓存命中 ~25k；②会话构造时**一次性 JIT 预热**（构造发生在通道接收期，不在飞行循环）：冷启动首 tick 从 0 提升到 11 个候选、预热会话首 tick 4 ms 完成全搜索。

**两阶段终端验证**（ab-24 审计 §4 的"先排序再完整验证"）：廉价相先做碰撞/地板/速度筛选，随后按进度降序（质量为次序）**只对前 6 个候选**运行完整 `verifyHold`；前排除尽、后继未检查时报 `terminal_unverified`（保持会话存活），全部候选都检查过仍失败才判 `NO_VIABLE`。

**ab-26 诊断对（0.2.66，`cave-ab-26.jsonl`）**
- **预算**：完整臂耗尽 tick **92→6**、分腿臂 **63→0**；`recoveryTrajectoryVerified` 两臂均为 **true**。
- **跨线**：两臂受控跨线；插值截面完整臂在带内（-1001.16）、分腿臂 -1005.81 也在带内（重算脚本用插值判定；夹具的门控仍用离散样本 x，需对齐——见下）。
- **未过项**：完整臂结束阶段掉血 **4.92**（最低血 15.08）；分腿臂本次**未稳定结束**（`ending=unknown`、stableTicks=1、9 个无输入空中 tick）。

**下一步**：①夹具的 `riverBandCrossing` 改用与重算脚本相同的插值；②分腿臂的未稳定结束（9 个无输入空中 tick）与完整臂结束阶段掉血需继续定位；③修完后重跑一对诊断。

## ab-27..29：转向平滑修复与复跑（2026-09-22，0.2.67→0.2.69）

用户观测到"剧烈视角移动、频繁撞右侧墙甚至反向飞"。定位到三处我方回归并修复（0.2.67）：
1. 两阶段终端验证把候选按**原始进度**排序，让"多飞一点但大幅偏航"的候选压过平滑候选 → 恢复为**进度等价带优先、带内按横向→高度→控制变化**排序，验证在质量顺序内进行。
2. `policyId` 字符串（`"+30:…"` 的 `'+'` < `'-'`）使平局**系统性偏右** → 改为中性裁决（|offset| → 数值 → 策略序 → policyId）。
3. 到站后低速时 hold 参考点退化（`atan2(0,0)` 使航向变为正东）→ 无有效航向时改用**最后一段航线方向**。
另补 B2 遗漏的**转向速率约束**（`yawRateLimitDegrees=25°/tick`，预测与执行同一限制；0.2.68）。

**ab-27（0.2.67）**：跨线均在带内、均稳定接地；但大偏航仍在（>40° 共 9/18 次，最大 136°，多与游标推进/切换腿同时发生），伤害仍高（完整臂最低血 14.5、分腿臂 7.35）。

**ab-29（0.2.69，含用户修复）**：
- **转向平滑**：两臂 `maxJump` 恰为 **25°**、>40° 跳跃 **0 次**（视角剧烈移动消除）。
- **完整臂**：受控跨线在带内（-1000.36, 74.0）、稳定 24 tick 接地、**全程零伤害**（最低血 20、结束掉血 0）、`recoveryTrajectoryVerified=true`；仅 1 个预算耗尽 tick 与 1 个无输入空中 tick。
- **分腿臂**：受控跨线在带内（-1004.17, 68.1）、稳定 20 tick 接地；但**掉血 5.1**（最低血 14.89，结束阶段 5.11）且 `recoveryTrajectoryVerified=false`（恢复动作未过全轨迹验证）。

**下一步**：分腿臂的 5.1 掉血与恢复验证失败（含那 1 个无输入空中 tick）定位；夹具 `riverBandCrossing` 对齐插值；随后按 D3 复跑一对。

## ab-29 复核后的第一批：门控/未决接管 + 恢复搜索（2026-09-22）

按 `elytra-flight-control-ab29-review-20260922.md` 的顺序执行前两项（③末端下降与④延长路线留下一批）。

**① 门控与同 tick 接管**
- `recoveryTrajectoryVerified` 改为**全称判定**：夹具对每个"空中且 owner=flight-recovery"的样本要求 `recoveryFrameVerified === true`，并单独记录缺失数（`recoveryVerifiedMissing`）；一次通过不再算通过。
- 无主空中统计补全：新增 `airborneNoInputTicks`（所有空中且 owner=none 的样本，**含仍在滑翔**的；原统计只看 `!gliding`）。
- `riverBandCrossing` 改用**跨线段插值**到 z=20 的 x（要求相邻样本同 owner，跨度不足或换主则不算），与重算脚本一致。
- **未决 tick 同 tick 接管**：`driveSession` 在 `!decision.applicable` 且会话仍存活、仍在滑翔时，调用新的 `FlightSession.safeFrame(...)` 取一个**受验证**的安全动作，以新 owner `flight-undecided` 写入（环记录允许该 owner）；不再静默继承俯冲。真正终止/落地/非滑翔仍返回空动作。

**② 有界对称安全搜索（`FlightSession.safeFrame`）**
- 候选：偏置 `{0, ±12, ±25}` × 策略 `{LEVEL, PULL_UP, AIM, AIM_PULL}` × 点火 0/1（仅库存/无叠加允许时），全部经**转向与俯仰限速**后去重；候选即动作（首步与执行完全一致）。
- 时域 `RECOVERY_SEARCH_TICKS=14`（原 6 tick 仅 0.3 s，分腿臂 t6678→t6688 相差 10 tick）。
- **末态检查**：除全轨迹三维扫掠外，要求预测末态仍有前方净空或可验证支撑着陆；短前缀无碰撞不算通过。
- **诚实降级**：无候选通过时返回应急动作（预测接触最晚、撞击最轻）并标 `verified=0`、`emergency=true`、`contactTicks`；调用方按"无法保证安全"上报，绝不把保持姿态算作验证通过。
- 遥测：逐 tick 记录 `safeCandidates`/`safeVerified`/`safeEmergency`/`safeContactTicks`（客户端环 → 端口 → 夹具）。

**新增回归（`FlightSessionSafeFrameTest` 4 例）**：直行被墙挡、侧向出口可用 → 选到受验证的转向且首步在限速内；整个空域被顶棚封死 → `verified=0` 且走应急；全阻挡 → 应急动作给出预测接触 tick；开阔空域 → 零偏置优先。

**验证**：Java **92/92**；movement vitest **442/442**；typecheck 0；lint 0。客户端 0.2.70 待构建部署（下一批一起）。

**仍未完成（下一批）**：③末端下降与能量控制（完整臂停止时仍有 22 tick boost、首拒 `terminal_missed` 预测高约 16 格）；④延长已验证路线攻羊毛闸门与黑曜石板下（冻结 19 点路线只到 z=−67.5，距板约 54.6 格）。
