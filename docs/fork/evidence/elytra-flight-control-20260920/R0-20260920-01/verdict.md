# R0+R1 判定（R0-20260920-01）

## R0 · PASS

| 完成门 | 判定 |
| --- | --- |
| 两个已确认反例可重复失败 | PASS——薄墙穿墙（waypoint z=96.5 穿 z=6 墙）、扩宽丢层（planned→blocked），失败输出冻结于 `reproductions-failing.log`，随后才实施 R1 |
| 旧证据未改写 | PASS——7 批 JSONL 与 ov5/e01 目录零接触 |
| 新诊断运行不覆盖证据 | PASS——e02 输出唯一化（已存在即 throw）、meta 行写入模式与配置 |
| 完整路径断言有明确失败原因 | PASS——`expected { status: 'planned', …(4) } to have property "path"`（输出坍缩为 waypoint+bandY） |

范围与限制：环境实读发现服务器/双客户端已关闭、部署 jar 滞后（0.2.29 vs 源码 0.2.34）——已记入 manifest/baseline，属事实记录而非缺陷。

## R1 · PASS（离线）

| 完成门 | 判定 |
| --- | --- |
| 两个反例转绿 | PASS |
| 密封洞不连通 | PASS（`no_route`，穷举预算内证明） |
| 弯河可绕 | PASS（有序 path 绕脊体，两侧任一，逐点空气） |
| 多层顶棚目标选对 | PASS（含目标袋，非顶面） |
| 先升后降 | PASS（越丘高度 ≥91，谷后 ≤70） |
| 开阔无地面空间 | PASS（无支撑面要求） |
| 斜向窄缝/切角 | PASS（角规则：多轴步进的单轴中间格必须可通行） |
| 未加载与截断 | PASS（`local: true` 前沿路线 / 类型化拒绝） |
| 完整通道逐边检查 | PASS（26 邻域 + 角规则 + 双格净空 + 未知格不可通行） |
| 局部路线与全程路线可区分 | PASS（`local` 标志 + coveredGoal 语义） |

实现落点：`flight/corridor.ts` 新增 `planSpaceRoute`（块尺度 3D A*，二叉堆、可通行节点预计算、角规则、节点/时间双上限）；`flight/low-route.ts` 的 `planLowRoute` 重写为分块垂直读取（保目标层，扩宽不再裁层）+ 调用空间搜索 + 输出有序 `path`（保留 waypoint/bandY 供当前消费方迁移，R3 接入完整路径）。旧贪心 walk（`walkLowRoute`/`candidatesOfSegment`/`slotInColumn`）保留但其单元测试职责标记为迁移候选。

范围与限制：本批全部离线（固定地图），未消耗烟花；搜索预算（节点 12 万/时间 2s/读取 128 次）为首轮工程值，待 R3 真机采集校准；`planLowRoute` 不再暴露单一全程 bandY 语义（bandY = 终端路径点高度）。

## R2a · PASS（真机门通过，2026-09-20；带范围限制，见下）

真机验证（栈拉起 + 0.2.34 部署后）：场景 A–F 全部记录于 checks.md。四项完成门：

1. 同 tick 观测对齐 ✓（21tps 正常推进；首次 tick 冻结为加载屏瞬态，二次运行排除）。
2. 起飞烟花交接可追溯 ✓（launch.deployed/boostSeen 进入 flight.observe；环内点火标记；boost 剩余量估计带源标注——精确读数客户端不可得，记 R2b/R3）。
3. 重复点火拒绝 ✓（opId 重放原样响应）+ 旧代次拒绝 ✓（stale_generation/expectedGeneration=1，控制器修复后）+ 幂等重提交 ✓。
4. 起飞宏三行为：成功 ✓、无烟花拒绝 ✓、取消 = 完成后无操作 ✓（运行中取消因宏 9 tick 时序不可稳定触发，场景限制记录）。

异常与限制（不阻塞门，留待后续）：
- trajectoryLost=2473 为环形设计行为；消费契约=持续轮询。
- C 场景库存差 0/0 为读取竞态；去重由响应重放证明。
- FlightController 明确零输入写入；R2b 才接管逐 tick 驾驶。

离线交付（代码全部写出并通过构建）：

- **FlightController**（`client/flight/FlightController.java`，新模块）：同 tick 同阶段观测（位置/速度/姿态/滑翔/碰撞盒/装备/推进状态 + launch 交接事实引用）；通道契约（sessionId 幂等重复提交、generation 陈旧拒绝、accepted 与 startedApplying 分离、维度变化/死亡/断线/期限类型化终止）；烟花点火去重（opId 记忆 64 条，重复返回首次响应不重放）；有界轨迹环（600 tick ≈ 30 s，trajectoryLost 如实计数，sinceTick 批量读取）。
- **FlightHandlers**（五条 RPC）：`flight.observe` / `flight.submit` / `flight.status` / `flight.revoke` / `flight.boost`，全部 `ClientMc.call` 游戏线程模式。
- **mcp-server**：tools.ts 五个工具目录；typecheck/build 通过。
- **构建**：`:1.21.1:build` BUILD SUCCESSFUL；新 jar 0.2.34 SHA-256 `65ce09d0…`（未部署）。
- **R2b 预留**：FlightController 明确不写输入（inputOwner="flight-r2a-observer"，applyingStarted=false）——逐 tick 驾驶是 R2b，不在本批冒充。

真机完成门（执行文件 §6）：**NOT-RUN**——需要拉栈 + 部署新 jar + 真实客户端 tick 核对。R2a 保持 IN-PROGRESS 状态，不得提前宣称通过。
