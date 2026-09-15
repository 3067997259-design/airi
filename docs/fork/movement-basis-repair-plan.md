# 移动基础修复计划（复审 R1–R9 落地）

日期：2026-09-14。状态：**计划，未实施**。上游：[能力复审与移动改进建议](./minecraft-capability-review-20260914.md)（R1–R9）、[执行计划 §9](./minecraft-player-capability-execution-plan.md)、[MC-4 真机记录](./evidence/mc-4/live-acceptance-20260914.md)。

验收基线：game-host 定向 204 passed / 1 skipped；复审证据测试 `docs/fork/evidence/movement-review-20260914/movement-review.test.ts` 7 项 `it.fails`（修复后应移入模块测试并改为普通断言）。

## 0. 原则

- 顺序：先正确性（坐标 / 状态 / 停止所有权），再控制质量（连续跟随），最后规划策略（失败边 / 区域目标 / 粗路线）。
- 不引入新依赖。参考已安装的 `mineflayer-pathfinder@2.4.5`（`postProcessPath` 的站位投影；捷径保持关闭）与 Nav2 纯追踪思路（仅控制参考）。
- 每个修复把复审对应复现转成模块测试；真机按复审 §8 场景表逐项核对。

## 批 1：坐标、状态与停止所有权

### 1.1 统一坐标契约（R1、R4）

- 新增 `movement/coordinates.ts`：
  - `cellOf(pos)`：整数格（floor）。
  - `standPointOf(cell, below: BlockInfo)`：脚部站位 `{x: cell.x + 0.5, y: below.height, z: cell.z + 0.5}`。Y 直接取支撑块碰撞顶——`block-view.ts` 已按全块 / 半砖 / 门 / 地毯给出 `height`，不再统一 `+1`。
  - `type MovementGoal = { kind: 'cell', cell: Vec3 } | { kind: 'region', cells: Vec3[] }`；`goalReached(pos, goal, tolerance)`、`goalCells(goal)`。
- `executor.ts` `walkStep`（L268 起）：
  - 目标由整数角点改为**下一格站位点** `standPointOf`；
  - yaw 用新站位点计算；转向容差由 25° 收到 ~5°；
  - 到达判定：到下一格中心水平距离 < 0.45 且 |dy| ≤ 1（保持不变）；
  - **非动作边界不 `stopMovement`**（L293 的每次停输入只在跳跃 / 放置 / 破坏 / 开门 / 终点 / 取消前做）；
  - 转弯（下一格方向与当前朝向夹角 > 30°）与接近终点（< 1.5 格）时提前关闭疾跑。
- `index.ts` `executeTerrainMoveTo`：目标入口先 `Math.floor`（与 `runTerrainLeg` 一致）；`planner.ts` 支持 `region` 目标留到批 3 启用。
- 测试（转正复审用例）：`(0.5,1,0.5)` → 下一格 `(1,1,0)` 的 yaw 为 `-90°`（当前 `-135°` 是缺陷）；小数目标 `(4.5,1,0.5)` 可规划；跨零坐标；半砖 / 楼梯 / 门下的 Y 取碰撞顶。

### 1.2 快照不可变（R2）

- `snapshot.ts`：`createSnapshot` 产出的 `BlockInfo` 冻结（`Object.freeze` 或只读包装）。
- `movements.ts`：删除 `blockC.height += 1`（`getMoveJumpUp` L216 等）；假设放置后的支撑高度用局部变量传入选民（`const assumed = { ...blockC, height: blockC.height + 1 }`）。
- 测试：连续枚举邻居两次，快照 `height` 不变；同一输入两次规划的成本与路径一致。

### 1.3 材料记账（R3）

- `MoveAction` 拆分 `toPlace`（真正放置）与 `toUse`（开门等交互）；`remainingPlaceables` 只减 `toPlace.length`（开门不再 `-1`）。
- 预算不足时**不生成**该候选（在所有 `getMove*` 里先判 `node.remainingPlaceables - toPlace.length >= 0`）。
- `planner.ts` 状态合并改为支配关系：同一坐标保留「成本更低且材料不少」的状态；材料更少的状态不得覆盖材料更多者。
- `executor.ts` 材料选择：主背包与快捷栏合并统计（当前放置只从快捷栏取）；需要时先把材料移入空快捷栏槽；`SCAFFOLDING_ITEMS` 移除 `minecraft:sand`（不受支撑会掉落）。
- 每个动作（破块 / 放置 / 开门）完成后刷新一次库存计数。
- 测试：开门不扣预算；预算 0 时不开门不放置并返回结构化失败；主背包材料可被选中。

### 1.4 停止所有权与输入清理（R7 的 AIRI 侧）

- 用**每命令令牌**替换共享 `stopRequested`（`index.ts` L1119 / L1780 / L3457）：

  ```ts
  interface ExecutionToken { active: boolean, reason?: string }
  ```

  每个 `executeGameAction` 创建自己的 token；`registry.requestStop` / `stopActive` 失效对应 token（而不是置全局标志）。读命令不再清除写命令的 token（当前 L1780 无条件清零）。
- 所有控制调用（`port.setInput` / `jumpOnce` / `breakBlock` / `placeBlock` / `use`）发送前检查 token，失效即拒绝发送。
- `elytra.ts`：起飞 → 巡航 → 降落全程包在 `try/finally`；`finally` 无条件释放前进 / 疾跑 / 使用键（复审复现：起飞中状态读取抛错后输入未释放）。
- 测试：起飞中读取抛错后输入被释放；旧 token 的新输入被拒绝；读命令不影响运行中写命令的停止标志。

## 批 2：连续路径跟随（R1 后半、R5 前半）

- 新增 `movement/follow.ts`：把 `plan.steps` 后处理为段：
  - **walk 段**（连续、无 `toBreak/toPlace/toUse/parkour`）：前瞻点跟随，前瞻距离 `0.8 + 0.4 * speed`（上限 1.5 格），yaw 朝前瞻点；
  - **action 边界**（跳 / 放 / 破 / 开门 / 水）：到格中心、停输入、执行动作、再继续；
  - 游标推进：把当前位置投影到路径折线，只前进不回退；已越过 ≥ 1 格的节点直接跳过。
- 参考 `node_modules/.pnpm/mineflayer-pathfinder@2.4.5…/lib/pathfinder.js` 的 `postProcessPath`（站位投影；捷径保持关闭）。
- 测试：直线 6 格无中间停顿（输入序列中无多余 stop）；直角转弯以格中心通过（横向误差 < 0.35）；到达后输入归零。

## 批 3：重规划原因与失败边（R5 后半）

- `MovementPath` 增加执行游标与失败边记录 `{reason, worldVersion, materials, at}`；重规划时把未失效的失败边作为额外成本 / 禁用边传入 `planPath`。
- 失效条件：世界变化（方块变更计数或区块读哈希）、材料增加、TTL（约 30s）。
- `follow`：目标移动 > 1.5 格或路径失效才重规划；连续 3 次不可达 → 有界 `waiting` 并结构化返回 `target_unreachable`。
- `collect`：`walkNear` 的固定方向回退改为**区域目标**（目标方块的 4 邻 + 上下可站格），一次搜索取路径成本最低站位。
- 长距离：粗路线 + 局部窗口；窗口外保持未知（不作空气）；读取量继续受 `MAX_REGION_BLOCKS` 限制。
- 测试：失败边不无条件重试；region goal 选最便宜站位；窗口读取体积上限。

## 鞘翅（R6、R7 飞行侧，独立批）

- **扫描修正（先做）**：`scanTerrainAhead` 增加横向距离筛选（走廊半宽 1.5 格）、垂直厚度 ≥ 2 层、未知方块保守语义。
- **起飞**：候选起飞位（前方 ≥ 8 格空间、落差 ≥ 5）失败即换点；起飞进入清理边界。
- **进近 / 复飞 / 紧急降落**：进近独立截止时间；取消时先撤销旧目标，再从当前位置选可达落点（按剩余高度与烟花预算）；飞过目标进入一次有界复飞。
- **补给**：烟花多组自动换槽；飞行中刷新鞘翅耐久。
- **收尾**：落地核对 `onGround` / 位置 / 残余速度，释放输入并归还控制权。
- 测试：横向 18 格处障碍不触发爬升；取消后旧任务不再发输入；低补给降落到可达点。

## 远程武器（R9，独立批）

- **瞄准**：每 tick 用目标 uuid 读当前坐标，按预计飞行时间做线性预判；友军检测沿同一预测线。
- **击杀归属**：记录 `{commandId, shotAt, projectileUuid, shooterUuid}`；服务端死亡事件带攻击者 / 投射物时精确关联，否则保留「目标死亡、击杀未观察」。
- **忠诚返回**：用已发投射物 UUID 或发射前后库存差判断，禁止「背包里任意三叉戟」。
- 测试：目标移动后坐标准确；他人击杀不误归属；两把三叉戟不误判回返。

### 鞘翅实施进度（2026-09-14）

- **扫描修正（R6）— 完成**：新增导出纯函数 `isObstacleInCorridor`；走廊半宽 `CORRIDOR_HALF_WIDTH = 1.5`（横向偏移筛选）、垂直检查 `y..y+1` 两层、走廊内不可读方块按障碍处理；区域读取 X/Z 留 1 格余量覆盖近轴航向。测试：横向 18 格障碍不爬升（复审复现）、侧向 1 格与上一层障碍仍爬升、走廊内不可读按障碍。
- **进近独立截止（R7 部分）— 完成**：`APPROACH_TIMEOUT_MS = 40_000`，进近超时转 `timeout` 并继续既有降落。
- **烟花多组换槽 — 完成**：当前槽耗尽时重新 `selectBySuffix` 换下一组并重新统计，找不到时走 `low_supply`。
- **仍待**：就近落点选择（取消/低补给/低血仍朝原目标）、一次有界复飞、飞行中耐久刷新、巡航/进近输入清理的合并 `try/finally`、真机飞行验收。

## 验收与顺序

- 每批：复审对应 `it.fails` 转正 + 模块测试；`pnpm -F @proj-airi/stage-tamagotchi exec vitest run src/main/services/airi/game-host` 全绿；typecheck / eslint 0。
- 真机按复审 §8 场景表（平地八方向与旋转镜像、小数目标与目标实体、门 / 半砖 / 楼梯 / 桥面与一次性材料、U 形障碍与动态堵路、斜向飞行与薄墙、起飞异常与接管、多人射击）。
- 依赖：R8 已完成（模组 0.2.13）。鞘翅与远程批可并行，但都依赖批 1 的停止所有权，先落批 1。

## 实施进度（2026-09-14）

定向 game-host **222 passed / 1 skipped**；typecheck 0；eslint 0。

- **1.1 坐标契约 — 完成**：新增 `movement/coordinates.ts`（`cellOf`/`standPointOf`）；`walkStep` 瞄准站位中心、转向容差 25°→7°、`turnAhead` 收疾跑；`move_to` 目标取整（R4）。停止策略：纯平走保持输入连续，parkour/动作步骤及其前一步到点停（连续跟随留给批 2）。测试：`coordinates.test.ts` + 平直步瞄准 -90° 用例。
- **1.2 快照不可变 — 完成**：`createSnapshot` 冻结 `BlockInfo`；`getMoveJumpUp` 的 `blockC.height += 1` 改为局部 `blockCHeight`。测试：`movements.test.ts`（枚举后快照不变 + 冻结写入抛错）。
- **1.3 材料记账 — 完成（库存刷新待补）**：`remainingAfter` 只对 `place` 扣预算（开门不再 -1）；规划器状态合并加支配规则（更便宜且材料不更少才无需替换）；`ensureScaffolding` 支持主背包材料换入空快捷栏槽；`SCAFFOLDING_ITEMS` 去掉沙子。测试：开门预算 0、主背包脚手架换槽、沙子排除。
- **1.4 停止所有权 — 完成（AIRI 侧）**：新增 `StopScope` + `nextStopScope`（注册表拥有写动作分类）：只有写命令开新作用域，读命令不再清写命令的停止标志；`stopGameAction` 只停当前作用域；`elytra` 起飞段包 `try/finally` 无条件释放输入（复审复现二）。测试：`nextStopScope` 策略两例。
  - **仍待**：模组边界的每命令代次校验（控制调用携带并核对 commandId/连接代次/维度）与执行器退出状态核对（复审 R7 的完整形态）。
- **批 2（连续路径跟随）— 完成（核心）**：新增 `movement/follow.ts`——`walkRunLength`/`runCells` + `runWalkRun`（前瞻点 1.0–1.5 栅格按速度缩放、投影游标只前进不回退、转过 30° 提前收疾跑、按节点推进的期限与卡住窗口）；`runTerrainMove` 对 ≥2 格纯平走一次性走完（动作/parkour 边界仍走单步逻辑）。测试：直线 6 格运行中停输入次数 ≤2（旧实现每节点停）。**仍待**：直角转弯以格中心通过的横向误差断言（假端口步长粗，留真机核对）、捷径处理保持关闭。
- **批 3（失败边与区域目标）— 完成**：
  - **失败边**：`planPath` 支持 `disabled`；`runTerrainMove` 支持 `failedEdges`，每次 `stuck` 记录 `{to, at, materials}`，重规划时把未失效边转成禁用格（失效：TTL 30s、材料变多；首轮不预禁用；**世界方块变化未覆盖**，已注释说明）。
  - **区域目标**：`planPath`/`runTerrainMove` 支持 `goalCells`（任一命中、启发式取最近、区域读取盒覆盖全部目标）；collect 的 `walkNear` 改为一次区域目标搜索（目标 + 四邻 + 上下共 7 格），A* 自然选最便宜站位。
  - **follow 等待态**：目标在 `keepDistance` 内不跑腿（只轮询）；目标相对锚点移动 > 1.5 格或上腿未到达才跑腿；连续 3 腿失败 → `target_unreachable`（`command-contract` 计为失败）。
- **批 3 测试与结果**：新增 8 例（禁用绕行、最便宜目标格、唯一可达格、无可行目标、失败边跨重规划、失效过滤、follow 等待态、keepDistance 内不规划）；定向 **233 passed / 1 skipped**、typecheck 0、eslint 0。

## 批 4：R5 尾项与长距离（2026-09-14）

- **失败边跨腿共享**：每次写命令（move_to/collect/follow/attack）各建一份 `Map<string, FailedEdge>`，命令内所有 `runTerrainLeg`/`runTerrainMove` 共享，命令结束丢弃；`disabled` 改为 map 非空即生效（新腿首规划就会跳过失败边）。
- **世界变化失效**：`FailedEdge` 增 `id`（记录时快照方块 id）；新增 `validatedFailedEdges(port, entries, ctx)`——先纯规则（TTL 30s、材料变多），再对每条候选 `getBlock(to)` 比对 id，读取失败或 id 不同即丢弃（异步、读取量受 map 大小约束）。
- **长距离粗路线 + 局部窗口**：新增 `movement/route.ts`（`splitRoute(start, goal, maxHop)` 纯函数）与 `runTerrainRoute`——水平距离 > 32 格时按 16 格一跳逐段 `runTerrainMove`（同一 failedEdges、每段局部读区、每段刷新玩家位置），最后一段保留调用方 tolerance/goalCells。
- **测试与结果**：新增 8 例（长目标拆分、跨腿共享失败边、id 不变保留、方块变化丢弃、`splitRoute` 4 例等）；定向 **241 passed / 1 skipped**、typecheck 0、eslint 0。
- **偏差**：index 层的“后续腿不再尝试失败边”依托 `runTerrainMove` 集成测试观测（index 的静态 mock 不含玩家移动）；路由各段沿用命令开始时的 `remainingPlaceables`（不随路点递减）。
