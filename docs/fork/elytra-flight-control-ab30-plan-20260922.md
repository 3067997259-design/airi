# 鞘翅飞行控制 ab-30 工作计划：闸门—板下动态可行性

输入：`elytra-flight-control-ab29-review-20260922.md` 的六项技术工作与"固定地形可行性验证"实验。
本文件把六项工作映射到文件、契约与交付顺序。零 Git 提交。A* 权重与到达半径保持冻结。

## 总原则

- A* 只负责几何连通。速度、助推、转向、下降是否来得及，由独立的**可行性层**验证。
- 可行性层复用 `FlightDynamics` 与现有限速，不新造物理模型。
- 生产算法必须自动提取通行区域。写死的坐标只允许出现在诊断夹具里。
- 每一步都产出可回放的证据：固定地形快照 + 离线回放 + 局部真机。

## 六项工作 → 交付

### ① 通行截面契约，规划器必须考虑板下通道

现状：`low-route.ts:765` 的 `requiredOpenSky: true` 只要拿到"开天"前沿候选，就不再比较带顶候选。
后果：黑曜石附近继续偏向岸顶。

交付：
- 新契约 `FlightCrossSection`：轴向、位置、可用区域（`zRange`/`yRange` 或 `xRange`/`yRange`）、机体收缩后的净空。
- 规划器输入增加 `mustPass: FlightCrossSection[]`。有 `mustPass` 时，前沿候选按"能否接入下一截面"排序，`requiredOpenSky` 不再是硬过滤。
- 诊断夹具可显式给出截面范围。生产侧从已读地形自动提取（先做"顶+底"两层扫描找连续开口，再按机体尺寸收缩）。
- 失败归因：找不到几何通路 → 报 `no_section_path`，不退回开天。

### ② 入口—内部—出口同腿规划

现状：冻结路线终点在黑曜石板之前。单纯延长会得到"进得去、下一段没读到、客户端 hold 或拉起"。

交付：
- 一腿的规划单位改为 `LegPlan { entry: FlightCrossSection, interior: Vec3[], exit: FlightCrossSection, suffix: Vec3[] }`。
- 读图提前量检查：进入截面前，`exit` 与 `suffix` 必须已读到（`requiredReadAhead = f(speed, turnRate, sinkRate)`）。
- 航点分两类：`through`（中间通行点，不触发终末 hold）与 `stop`（最终停止点，可触发 hold/land）。
- 交接点优先选宽阔区；窄处交接必须带一致可见后缀。

### ③ 入口状态可行性（最关键）

现状：入口条件只有"距离够近、航向大致正确"。`y=73 下降` 与 `y=73 仍被烟花上推` 可飞性完全不同。

交付：
- `FlightEntryState`：位置、水平速度（方向+大小）、垂直速度、俯仰/偏航、剩余助推（`rocketTicks`/`rockets`）。
- 有界束搜索 `FlightFeasibility.search(entrySection, exitSection, state, params)`：
  - 每轮展开有限策略：转向、平飞、下降、拉平、爬升（点火/不点火）。
  - 每步执行现有转向/俯仰限速与三维扫掠。
  - 保留能穿过截面且出口仍可继续飞行的状态。
  - 输出"允许进入的状态范围"。
- 当前状态不在范围内时，在障碍前提前调整（下降、减速、消耗助推）。
- 点火决策必须看到即将到来的下降段与顶棚：ab-29 剩余 22 tick 助推 ≈ 35 格影响距离。
- 束宽、轮数、时域按速度推导，不用单一常量覆盖所有情况。

### ④ 通道跟随，而不是逐个追坐标点

现状：通道协议只有 `path + entryReach`（`port.ts:214`），表达不了窄通道的允许偏差。`lateral` 指标仍是预测终点到下一航点的水平距离。

交付：
- 通道契约补：每段水平边界、允许高度范围、通行截面。
- 跟随改为沿当前路径段投影：进度用弧长，前视点随速度移动。
- 横向误差 = 到路径段的距离，替换现有 `lateral` 语义。
- 进入下一段前确认轨迹能接入，禁止隔墙切弯。
- 普通航点可用过站规则；必须通过的闸门截面必须**实际从有效区域穿过**，到达半径不得提前跳过。

### ⑤ 统一几何语义与真实余量

现状（已核对）：主机 `channelBodyClear` 允许水通过，客户端飞行扫掠拒绝水。主机验证过的通道会在客户端再次失效。

交付：
- 统一水、树叶、未知格、碰撞形状、机体范围的含义；滑翔净空与站立净空分开定义。
- 用现有预测点与逐 tick 日志测量预测误差（按速度、转向、助推分组）。
- 余量由误差分布决定。窄缝剩余空间小于模型误差时**拒绝进入**，不得缩小碰撞盒让检查通过。

### ⑥ 窄通道的可执行失败处理

- 穿越策略附带已验证的出口延伸；客户端每次重算检查能否接上。
- 入口条件不满足 → 在外面拒绝进入。
- 进入后优先沿已验证出口；其他方向也必须经过扫掠。
- 目标：提前识别并减少无法挽救的状态，不承诺恢复搜索总能找到出口。

## 先做的实验：固定地形上的闸门—板下动态可行性验证

1. 保存闸门与黑曜石板一带的地形快照（沿用 `ab20-audit/end-region.json` 的做法）。
2. 生成一条几何上贯通的路线（闸门入口 → 闸门出口 → 板前准备区 → 板下出口）。
3. 离线回放：不同进入高度、水平速度、垂直速度、助推余量的组合。工具形态参考 `ab24-audit/BudgetProbe.java`。
4. 选出通过的状态，做局部真机验证（不接桥面起飞全程）。

失败归因表：

| 结果 | 下一步工作 |
|---|---|
| 找不到几何通路 | 修地图覆盖、前沿选择或通道生成 |
| 有通路，但当前状态进不去 | 修提前下降、转向和助推管理 |
| 理想状态能过，真实进场总不满足 | 修上游准备段与交接 |
| 预测能过，真机碰撞 | 修物理模型、几何语义或执行时序 |

局部连续成立后，再接回桥面起飞的全程路线。

## 已发现的缺陷（执行中记录）

- `elytra.ts:438/1282/1530` 向 `planLowRoute` 传入 `roofY`，但 `planLowRoute` 的输入类型里没有这个字段。对象字面量经条件展开后 TS 不做多余属性检查，因此 typecheck 通过、字段被静默忽略：**客户端以为在应用顶棚约束，实际没有**。属于 §2（读图/规划提前量）与 §5（语义统一）的范畴，单独作为一项修复，不要顺手改。

## 执行记录

### 2026-09-22 第 1 批：通行截面契约（①的一部分）

- 新增导出类型 `FlightCrossSection`（轴向、平面坐标、横向范围、高度范围）与 `shrinkCrossSection`、`crossingOfSection`、`insideSection`（`low-route.ts`）。截面在传入前必须按机体尺寸与安全余量收缩；装不下的开口在提取阶段就拒绝，绝不在这里放宽。
- `planLowRoute` 新增 `mustPass?: FlightCrossSection[]`：
  - 有 `mustPass` 时不再让"开天"候选独占（原 `low-route.ts:765` 的行为），两类候选一起比较。
  - 路径实际穿过下一个截面矩形的候选获得 `SECTION_BONUS`，优先于沿航向的进度。
  - 最优候选仍未穿过截面时拒绝，返回 `status='blocked'`、`reason='no_section_path'`（不再退回岸顶路线）。
- 测试：`crossSection` 3 例（插值交点与内外判定、无交点、收缩）；`planLowRoute` 2 例（板下截面被真实穿过且 `crossing.y < 75`；不可达截面 → `no_section_path`，同墙无约束的对照仍为 `planned`）。
- 验证：`low-route.test.ts` 39/39；game-host 全部 980/980（3 skipped）；typecheck 0；定向 lint 0。

### 2026-09-22 第 2 批（② 第一片）：出口延续量（读图提前量）

- 新增 `suffixLengthPastSection(path, section)`：从截面穿越点到路径末端的已验证长度；不穿越返回 `undefined`。
- 新增 `requiredSuffixBlocks(speed, seconds = 2.5)`：要求**按时间推导**而非固定格数——巡航约 1.6 格/tick，出口后必须留出下一次重规划（读取+规划+交接）所需的秒数。
- `planLowRoute` 新增 `speed?`（默认 `FLIGHT_CRUISE_SPEED = 1.6`）；`mustPass` 命中截面后，出口延续量不足则拒绝，`reason='section_suffix_short'`（区别于"根本没穿过去"的 `no_section_path`）。这条直接对应"进入板下前已有完整板下通道与出口延伸段"。
- 测试：同一截面同一路线，巡航速度下 `planned`、速度 200 时 `section_suffix_short`——证明该要求由速度推导而非几何写死。
- 验证：`low-route.test.ts` **35/35**；typecheck 0；定向 lint 0。
- ② 仍未做：`LegPlan { entry, interior, exit, suffix }` 的显式类型与规划输出；`through`/`stop` 航点分类贯通到客户端通道（需要通道契约 + Java 侧配合，避免中间通行点触发终末 hold）；`roofY` 顶棚封顶语义（现仅契约）。



- ② 仍未做：`LegPlan { entry, interior, exit, suffix }` 的显式类型与规划输出；`through`/`stop` 航点分类贯通到客户端通道（需要通道契约 + Java 侧配合，避免中间通行点触发终末 hold）；`roofY` 顶棚封顶语义（现仅契约）。

### 2026-09-22 第 2 批（② 第二片）：腿分解与航点语义

- 新增 `FlightLegPlan { entry, approach, interior, exit?, suffix }`：一腿被截面切成"接近段 / 开口内部 / 出口之后"。`planLowRoute` 在 `mustPass` 存在时输出 `leg`；`exit` 由 `mustPass[1]` 给出，缺省时 `interior` 与 `suffix` 同为穿越点之后的部分（只有一个已知开口时无法再区分，注释已说明）。
- 新增 `splitPathAtSection`：在截面平面处**插入交点**再切分，因此两点直连的弦也能得到非空的"出口之后"——第一版只按顶点切分，直连腿的 `suffix` 为 0，测试直接暴露（`LEGDEBUG` 显示通道路径就是 `[self, z=102.5]` 两点）。
- `LowRoutePlan.waypointKind: 'through' | 'stop'`：目标已被读到 → `stop`（结束行程）；前沿腿 → `through`（交接点，下一次重规划继续，客户端不得在此触发终末 hold）。
- 测试：`leg.entry/exit/approach/interior/suffix` 与两个平面的关系、前沿腿为 `through`、覆盖目标为 `stop`。
- 验证：`low-route.test.ts` **36/36**；typecheck 0；定向 lint 0。

### 2026-09-22 第 2 批（② 第三片）：航点种类贯通到通道契约（主机侧）

- `FlightChannelSubmitRequest.channel.kind?: 'through' | 'stop'`（`movement/port.ts`）：`stop` 表示路径末端结束行程、可进入终末 hold；`through` 表示这是下一次 revision 接续的交接点，**客户端必须继续飞而不是 hold**；字段缺省时保持客户端当前终末行为（旧客户端忽略新字段也安全）。
- `FlightChannelSubmitInput.kind`（`flight/channel.ts`）透传进请求。
- `movement/elytra.ts`：初始腿与前沿腿规划后记录 `activeWaypointKind = plan.waypointKind`，在 `runner.submit` 中按"仅非 undefined 时传"送出。
- 验证：typecheck 0；game-host **977 通过 / 3 skipped**；三文件定向 lint 0。
- 仍未做（下一片）：**Java 客户端消费 `kind`** —— 通道提交解析该字段，`through` 时跳过终末 hold/着陆相位并等待下一 revision；`roofY` 顶棚封顶语义。

### 2026-09-22 第 2 批（② 第四片）：Java 客户端消费 `kind`（`through` 不再触发终末下降）

- `FlightSession.Params.throughWaypoint`（默认 false）：`stop`/缺省保持原行为。
- `beginHold(...)` 增加 `level` 重载：`level=true` 时 hold 目标高度**锁定当前高度**，不再执行"用高度换时间"的下降；原因写在注释里——窄开口内的交接点若下降，可能撞顶棚或地板。
- 路径完成处：`beginHold(..., params.throughWaypoint)`，即 `through` 腿进入**平飞等待**（仍受 grace 有界、仍可被下一 revision 替换），`stop` 腿保持下降式 hold。
- `FlightController.paramsFromChannel` 解析 `channel.kind`：仅 `"through"` 置位，未知值/缺省/`stop` 一律保持旧行为（旧主机不发该字段时完全不变）。
- 测试 `FlightSessionThroughWaitTest` 2 例：`through` 等待保持 90 高度不下降；`stop` 腿仍会下降换时间。
- 验证：Java **94/94**（含新增 2 例）；`mcpfabric-0.2.71+1.21.1.jar` 已构建，**未部署**。
- 仍未做：真机验证 `through` 腿不 hold（需部署 0.2.71 跑一对诊断，核对通道路径末端行为与 `waypointKind` 遥测）；`roofY` 顶棚封顶语义。



### 2026-09-22 第 1 批（续）：截面自动提取与 roofY 契约

- 新增 `extractCrossSection`：在给定平面内从已读地形提取**最大全通行矩形**，再按 `margin` 收缩；收缩后为空则返回 `undefined`（装不下就拒绝，不放宽）。关键语义：**未读格不是空气**——第一版把未读格当作可通过，结果在读取区域之外"发明"了开口（回归测试覆盖）。
- 新增 `parseCrossSections`：解析诊断用 `E02_MUST_PASS` 规格（`axis:at:lateralMin:lateralMax:yMin:yMax;...`），非法项丢弃。
- `roofY` 进入输入契约：该字段此前**不存在**于输入类型，客户端经条件展开传入时被 TS 静默丢弃。窗口封顶实验（`yMax = roofY - 1`）在合成用例上导致 `blocked`，故只保留契约、不改变规划行为，并在字段上以 `NOTICE:` 记录；顶棚语义留待 §2 的读图/提前量设计统一处理。
- 测试新增 6 例（插值/无交点/收缩/提取+未读格/小于余量/解析+非法项）与 3 例规划器（板下截面穿越、`no_section_path`、`roofY` 契约）。
- 验证：`low-route.test.ts` **31/31**；typecheck 0；定向 lint 0。
- 未完成（下一步）：`mustPass` 从 MCP 工具/飞行请求端到端接线（现有 `exclude` 是 elytra 内部累积量，没有请求级透传通道）；生产侧自动提取的调用点选择。

#### `mustPass` 端到端接线（已完成，主机侧）

1. **类型归属**：`FlightCrossSection` 移到 `movement/port.ts`（通用通道契约），`flight/low-route.ts` 改为 `import type` 并 `export type` 再导出，避免通用车辆契约反向依赖 `flight/`。
2. **命令契约**：`command-contract.ts` 的 `moveTo` 增加 `mustPass?: FlightCrossSection[]`（诊断由此显式给出；生产侧自动提取前，这是"必须从哪过"的唯一入口）。
3. **请求选项**：`VehicleMoveOptions`（`movement/vehicle-port.ts`）增加 `mustPass?`，文档写明"未设置时规划行为不变"。
4. **透传**：`game-host/index.ts` 的 `runVehicleMove` 调用处与 `movement/elytra.ts` 的两处 `planLowRoute` 调用（`planFrom` 与巡航低速重规划）都按"仅在非空时传字段"透传。
5. **验证**：typecheck 0；game-host 975 通过 / 3 skipped；定向 lint 0（6 个文件）。
6. **待办**：夹具侧把 `E02_MUST_PASS`（`parseCrossSections` 已就绪）放进工具参数，并按验收三条跑一对诊断：(a) 板下截面被真实穿过（插值点在矩形内），(b) 不可达截面返回 `no_section_path` 而非岸顶路线，(c) 未设置时与对照臂一致。

### 事故记录：`low-route.test.ts` 未提交测试丢失

- 经过：用 PowerShell 批量替换写入 TS 测试内容时，模板字符串 `${y}`/`${z}` 被 PowerShell 当作变量插值，文件被写成含 NUL 字节的损坏内容；清理后文件变空，只能 `git checkout --` 恢复。
- 后果：恢复的是**已提交版本（22 例）**，本次会话新加的 9 例已重建；但上一个会话在 `low-route.test.ts` 里**未提交的约 12 例**测试丢失（代码未丢，`low-route.ts` 的未提交改动完好，全量测试 972 通过 / 3 skipped）。
- 教训与后续：TS/Vue 文件内容一律用编辑工具写入，不用 PowerShell 字符串替换。丢失的回归可从 `git diff HEAD -- low-route.ts`（未提交行为）反推重建，作为 ① 的收尾项。

### 待恢复测试清单（暂不恢复，先做新项目）

决定：原文抢救已失败、按行为重建成本不低，**暂停恢复**，只记录丢失方向；先把 ① 剩余接线与 ② 做完，再回头按此清单补测。判据不变：每条新测试必须断言 HEAD 版本没有的符号/字段。

| 方向 | 断言目标（HEAD 缺失面） | 状态 |
|---|---|---|
| 细化通道路径的拐角安全 | 墙+缺口几何下，细化弦在墙平面处必须穿过缺口 | 未恢复（需先扩假端口夹具） |
| 通道路径子序列契约 | `channelPath` 只删原始点、首尾一致 | 已重建 |
| 排除球反馈 | `exclude` 使路线失去可达距离（不再重投同一走廊） | 已重建 |
| 走廊方向读取窗口 | `bearing` 让窗口沿走廊方向而非目标方位展开 | 已重建 |
| 爬升斜率/总爬升上报 | `maxClimbSlope`/`climbTotal` 数值随路线变化（银行爬升拒飞信号） | 未恢复 |
| 搜索预算耗尽 | `search_budget` 状态与 `reason` | 未恢复 |
| 读取预算耗尽 | `readBudget` 耗尽时的 `read_failed` 与已读部分的关系 | 未恢复 |
| 本地路线标志 | `local` 在目标未被读到时为真 | 未恢复 |
| 保持窗口常量 | `LOW_ROUTE_HOLD_MS = LOW_ROUTE_TTL_MS * 3` 契约 | 未恢复 |



恢复途径先按"能否拿回原文"排查，再按"行为"重建：

1. 原文抢救（均失败）：VS Code Local History（3913 个文件，无 `candidatesOfSegment`）；JetBrains LocalHistory（`changes.storageData` 为压缩格式，grep 不到）；Vitest 缓存（`apps/stage-tamagotchi/node_modules/.vite/vitest/*/results.json` 不含测试名，且无转换模块缓存）。
2. 行为清单：`git diff HEAD -- low-route.ts` 列出未提交新增面（`channelPath`/`channelBodyClear`/`channelChordClear`/`channelPathOfVerified`/`openToSky`/`collectFrontierCandidates`/`maxClimbSlopeOf`/`climbTotalOf`/`exclude`/`bearing`/`readBudget`/`search_budget`/`LOW_ROUTE_HOLD_MS`）。
3. 去重：对现存测试文件 grep 这些符号，确认基本零覆盖（`channelPath` 仅 1 次，其余 0 次）——说明丢失的正是这一批。
4. 重建判据：每条测试必须断言 HEAD 版本**没有**的符号或字段（`channelPath`、`exclude`、`bearing`、`maxClimbSlope`…），否则它就不是回归测试。
5. 已重建 3 例：`channelPath` 只删原始点且首尾一致（子序列契约）、`exclude` 使路线失去可达距离、`bearing` 让读取窗口沿走廊方向展开。
6. 未重建：窄通道拐角不得被细化弦切角的测试——现有假端口表达不出"墙+缺口"几何（3 格缺口过不了机体检查，7 格缺口路线不到墙），需要先扩夹具；已在测试内以 `NOTICE:` 记录，列入 ① 收尾。
7. 其余可能丢失项（`maxClimbSlope`/`climbTotal` 数值、`search_budget` 状态、读取预算耗尽、`LOW_ROUTE_HOLD_MS`）尚未重建，同样列入 ① 收尾。

## 顺序

1. ①②的契约与夹具截面（先让"必须从哪过"可表达）。
2. ③可行性束搜索（离线工具 + Java 单测）。
3. 固定地形回放实验，产出"可通过的入口状态范围"。
4. ④跟随改造，⑤语义统一与余量标定，⑥失败处理。
5. 局部真机 → 全程路线 → 冻结配置正式批次。


1. ①②的契约与夹具截面（先让"必须从哪过"可表达）。
2. ③可行性束搜索（离线工具 + Java 单测）。
3. 固定地形回放实验，产出"可通过的入口状态范围"。
4. ④跟随改造，⑤语义统一与余量标定，⑥失败处理。
5. 局部真机 → 全程路线 → 冻结配置正式批次。



