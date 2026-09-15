# game_observe 升级计划（OV 线）

日期：2026-09-14。状态：计划定稿，实施未开始。同日增补：开放问题 2 已拍板
（接受交易表"开-读-合"轻副作用）；新增 OV-6（移动障碍真实高度与 game_jump，
顺用户真机报告）。

## 背景与主诉

`game_observe` 是模型感知游戏世界的通用入口，但当前注入内容只有自身状态与背包。
ReLU 的原话主诉：周围环境的微观状态、天气/是否下雨、生物雷达、持续关注移动中的
目标（用于瞄准与近战）、准星所指及附近方块、目标状态。用户补充：需要把握宏观地形
的手段（提议真机截图）。两个被感知盲区拖垮的典型场景：

1. **村民交易**：因为看不见周围有谁，只能把 noAI 村民摆到脸上再交互。
2. **鞘翅**：`runElytraMove` 的起飞模型是"朝目标冲刺、跑过边缘掉下去再展开"，
   平地或背对悬崖时 `onGround` 永不变 false，10 秒后报
   `stuck: 'no takeoff edge reached'`——她体验为"判断不能飞"。

## 现状核查（代码证据）

- `game_observe` 实现：[index.ts](../../apps/stage-tamagotchi/src/main/services/airi/game-host/index.ts)
  约 3764–3834 行。只调用 `get_self` / `get_inventory` / `get_equipment` /
  `get_status_effects`。**5×5×5 的 `get_blocks_region` 读取结果被直接丢弃**
  （`MC-0c` 遗留，只有 best-effort 调用没有消费）；`radius` 参数被夹取 1–64 后
  仅回显 `observedRadius`，实际未参与任何读取。
- 默认白名单 `DEFAULT_ALLOWED_TOOLS`（同文件约 78 行）只有
  `get_status/get_self/get_inventory/get_blocks_region` 四个；雷达、天气、射线、
  视觉组全不在默认集合里（真机 `game-host.json` 的 `allowedTools` 可能已手工扩过）。
- mod 侧已有但未被 observe 聚合的能力（`D:\mcpfabric\mcp-server\src\tools.ts`）：
  - `entities.query`：球心+半径（≤256）、类型过滤、living-only、含玩家；
    每实体返回 position/type/name/health/flags/**motion 速度向量**
    （[EntityHandlers.java](file:///D:/mcpfabric/src/main/java/dev/mcpfabric/handlers/EntityHandlers.java) 135–139 行）。
  - `world.getTimeAndWeather`：每维度 day-time 与下雨/雷暴（全局标志）。
  - `vision.describeScene`：准星所指方块/实体 + 跨视野射线网格 + 附近可见实体，
    自述为"非视觉模型的廉价截图替代"。
  - `vision.screenshot`：PNG base64，mcp-server 已映射为 MCP image content。
  - SSE 事件环（容量 2000，`sinceId` 续读）：`player_join/leave/damage/death`、
    `entity_death`、`game:reflex`、`chat`。
- 鞘翅起飞：[elytra.ts](../../apps/stage-tamagotchi/src/main/services/airi/game-host/movement/elytra.ts)
  81–113 行，`while (state.onGround)` 等待跑过边缘；没有跳跃起飞分支。
- 事件轮询通路已存在（X-10 `chat-commands.ts`），关注集可以挂在同一条通路上。

结论：**主因是聚合层缺位，不是 mod 能力缺位**。Java 侧真正的缺口只有三处：
本地环境（生物群系/光照/局部降雨）、村民富化、地形剖面；外加鞘翅起飞宏。

## 设计原则

- **分层感知 + 注意力控制**：observe 是聚合器，不是更大的转储。输出按层组织，
  用 `focus` 参数控制每层详略；默认输出受 token 预算约束（沿 MC-1b 事件压缩与
  life-mode 预算门的先例），超预算裁剪远场与低相关条目并在 `truncated` 里点名。
- **只读语义不变**：全部新层是读取，不改变 MC-0c 的 `checked` 评级与证据桶
  （观察走 `game_adapter_report`，不产生 `checked` 收据）。
- **失败逐层隔离**：沿用现有 `missing[]` 约定，任何一层失败只点名该层，
  不拖垮整个观察。
- **不碰移动内部感知**：地形剖面、雷达为模型面向；planner 的内部快照边界保持
  （能力审查 R2 的教训：候选不得污染共享快照）。地形剖面走独立的
  `get_blocks_region`/heightmap 读取路径，不复用 planner 快照对象。

## 观察分层结构

| 层 | 内容 | 数据来源 | Java 改动 |
|---|---|---|---|
| L0 自身 | 位置/朝向/运动/生命/饥饿/氧气/模式/载具 + 背包/装备/效果 | 现有调用 | 无 |
| L1 环境 | 维度、生物群系、局部降雨与雷暴、天光/方块光、day-time | 新 `player.getEnvironment`（客户端）+ `world.getTimeAndWeather` | 有 |
| L2 准星与微观 | 准星命中（方块状态+坐标+面+距离，或实体+血量）、命中点邻域、脚下/头顶方块 | 新 `player.getCrosshairTarget`（用游戏自身 pick）+ `get_blocks_region` | 有（轻） |
| L3 实体雷达 | 分桶（敌对/被动/玩家/村民/其他）+ 每桶最近 N 条目（type/name/uuid/相对方位与距离/motion/速度/血量），远场仅计数 | `entities.query`（已含 motion） | 村民富化一处 |
| L4 关注集 | 显式 watch 的实体全量状态 + 相对上次观察的增量（位置差/血量差）+ 丢失/死亡标注 | main 侧状态 + SSE 事件联动 | 无 |
| L5 宏观地形 | 表面高度剖面（多环多向采样 + 俯视高度网格）+ 前方落差摘要；可选截图 | 新 `terrain.surfaceProfile`（服务端 heightmap）+ `vision.screenshot` | 有 |

## 批次划分

### OV-1 · 零 Java 聚合层（环境 + 雷达 + 准星 + 修复丢弃读取）

范围：不碰 Java，把 mod 已有能力接进 `game_observe`，立刻消除"只有背包"主诉。

决策：

- **OV-D1 输出重组**：`observed` 改为 `{ self, environment, crosshair, radar,
  blocks?, missing, truncated }` 分层结构；`finalSnapshot` 保持原样（收据契约不动）。
  现在丢弃的 5×5×5 读取改为真正的 `blocks` 微观层（脚下/头顶/前方 3 格摘要，
  非 air 清单，超限截断），或显式删除该调用——在 spec 阶段二选一，不留"调用了
  但不消费"的状态。
- **OV-D2 雷达压缩规则**：默认半径取 `radius`（默认 32，上限 64）；每桶上限
  敌对 8 / 被动 8 / 玩家全部 / 村民全部 / 其他仅计数；条目含相对方位
  （yaw 差与象限）+ 水平距离 + motion 向量与速度；超出上限的同类远场合并为
  计数行。排序稳定（距离升序），两次观察间条目可按 uuid 对齐。
- **OV-D3 准星层用 `vision.describeScene` 的准星部分**（OV-1 阶段先整调用、
  低 `rayColumns`；OV-2 换成专用 `player.getCrosshairTarget`）。描述里写明这是
  便宜近似，精确命中以 OV-2 为准。
- **OV-D4 天气先全局后局部**：OV-1 用 `world.getTimeAndWeather`（维度级），
  `environment.localRain` 留 `undefined` 并进 `missing`，OV-2 补局部值。沙漠里
  "全局在下雨"与"我这里没雨"的差异必须能表达，不能静默合并。
- **OV-D5 白名单与默认值**：`DEFAULT_ALLOWED_TOOLS` 扩入
  `get_time_and_weather`、`query_entities`、`describe_scene`；真机
  `game-host.json` 如已手工扩过，连接时以配置为准（现有语义）。
- **OV-D6 参数面**：`game_observe({ radius?, focus?, watch? })`。
  `focus: 'surroundings' | 'combat' | 'trade' | 'terrain' | 'full'` 控制各层
  详略与半径默认值（combat→雷达全量+关注集；trade→村民桶详化；terrain→L5）。
  默认 `surroundings`。

验收：真机观察一次含天气、雷达（含 motion）、准星、微观方块；一个桶超限时
`truncated` 正确点名；任一 RPC 失败仅进 `missing`；token 估算默认输出不超
约 1.5k（超限裁剪远场）。

### OV-2 · Java 增补（本地环境 + 村民富化 + 地形剖面）

决策：

- **OV-D7 `player.getEnvironment`（客户端）**：生物群系 id、`localRain`
  （全局 raining ∧ 群系降水，客户端近似）、雷暴、sky/block 光、day-time 快照。
  放客户端侧因为离线单人也要在无独立服桥时可用。
- **OV-D8 村民富化**：`entities.query` 对 villager 附带职业、等级、群系变体
  （VillagerData 已随实体数据同步，只读即可）。交易表不进雷达：读取要开菜单，
  属于有副作用动作，保持"观察=纯读"边界。交易决策链 = 雷达选人（职业/等级）
  → 现有 MC-4 `menu.open/snapshot/select_trade` 流（R8 修复后通路已验证）。
  spec 阶段核对 `menu.snapshot` 对 MerchantScreen 的 offers 字段覆盖，缺则
  Java 补只读 offers 列表。
- **OV-D9 `terrain.surfaceProfile`（common，服务端优先）**：输入 center/size/
  spacing/方向数；服务端用 heightmap `WORLD_SURFACE` O(1) 列查；无服务端桥时
  降级为客户端小半径列扫描或整层 `missing`。输出两种形态：
  ① 环带射线摘要（8 向 × 4/8/16/32/64 m：表面高度与前方落差）；
  ② 9×9（spacing 4 m）俯视相对高度网格，紧凑编码。
  用途直连决策："前方 3 m 有 40 m 落差"这类数字是截图给不了的。
- **OV-D10 截图暂不接**：截图通道留给 OV-4，OV-2 的宏观地形以结构化剖面为准。

验收：沙漠与雨林两种群系下 `localRain` 差异正确；雷达里村民带职业与等级；
高度网格与真实地物对齐（抽样 5 点核对）；无服务端桥时表现符合降级规则。

### OV-3 · 关注集与增量

决策：

- **OV-D11 关注集归 main 进程**：`watching: Map<uuid, lastSeen>`，
  生命周期绑定 `connectionGeneration`（断线清空，沿 M1-D2 语义）；
  `game_observe({ watch: [{ type? | uuid? | name?, maxAge? }] })` 增删，
  空数组清空。关注集里的实体每次观察返回全量条目 + 相对上次的位置差向量、
  血量差、速度；SSE `entity_death`/`player_leave` 事件将条目标记
  `dead`/`left` 而非静默消失；超 `maxAge`（默认 5 min）未被任何 observe 刷新
  则降级回普通雷达条目。事件挂现有轮询通路（X-10 `chat-commands.ts` 同源）。
- **OV-D12 增量不替代全量**：关注条目始终带全量状态，增量字段是附加，
  避免模型拼图出错。远场压缩与关注集互不影响。

验收：watch 一个移动实体两次观察，位置差与速度非零且方向一致；目标死亡后
条目标 `dead` 且不再更新；断线重连后关注集为空。

### OV-4 · 截图通道（可选，视觉模型）

决策：

- **OV-D13 显式 opt-in**：`game_observe({ image: true })` → `vision.screenshot`
  → image content 透传。默认关闭；节流（同 connection 最小间隔，默认 10 s）；
  工具描述写明"需要视觉能力的中继，纯文本中继会拿到空层并进 `missing`"。
- **OV-D14 先验证端到端**：实施前先在真机确认 game-host `callTool` 的 image
  content 能穿过收据序列化与渲染层工具面、且当前中继接受 image 输入；
  不通则本批降级为"仅 devtools 可用"，不阻塞 OV-1..3。

### OV-5 · 鞘翅地面起飞宏（Java）

决策：

- **OV-D15 起飞宏归 mod 侧**：新 `movement.elytraLaunch`（BotController 内
  tick 级状态机）：确认鞘翅已穿 + 烟花已选中 → 冲刺跳 → 空中按跳跃展开 →
  2–3 tick 内 `useItem` 点燃烟花 → 返回 `{launched, state, reason}`。
  时序窗口（跳起至落地约 12 tick）不允许主进程往返延迟参与，与 MC-4d
  远程战斗、P2 导航租约同一先例：时序敏感动作住在 mod 里。
- **OV-D16 主进程起飞分支改造**：`runElytraMove` 起飞阶段先尝试
  `elytraLaunch`（平地可用）；失败原因带 `reason`，再回落现有"跑过边缘"路径
  （悬崖仍是最优起飞）。装备/耐久/烟花存量检查逻辑不动。
- **OV-D17 边界**：起飞后巡航/降落/生命周期问题（R6/R7）归
  [movement-basis-repair-plan.md](./movement-basis-repair-plan.md)，本批只换
  起飞，不重叠。

验收：平地无坡成功起飞并入巡航；悬崖路径行为不回退；烟花耗尽/鞘翅近损时
`unavailable` 原因正确；真机录一次完整平地起飞→巡航→降落。

### OV-6 · 移动障碍真实高度与 game_jump（2026-09-14 增补）

背景：用户报告寻路被一格高的织布机挡住并报错阻断，且 `game_*` 工具面没有
独立的"跳"。核查结论：

- [block-view.ts](../../apps/stage-tamagotchi/src/main/services/airi/game-host/movement/block-view.ts)
  刻意保守：未知方块默认满格实心障碍（`physical: true, height: y+1,
  safe: false`）。织布机不在 replaceable/skipped/climbable/carpet/openable/
  partial 任何表里；箱子、切石机等非满格功能方块同样中招。
- planner 的 jump-up 动作存在（[movements.ts](../../apps/stage-tamagotchi/src/main/services/airi/game-host/movement/movements.ts)
  `getMoveJumpUp`），executor 也真的执行跳（`executor.ts` 约 304 行
  `jumpingUp && state.onGround → jump`），但 jump-up 要求目标上方两层净空
  （blockA/blockH）；室内两格净空时跳不起，前进分支则把织布机按默认硬度 1.5
  挖掉（`safeOrBreak` 成本约 23.5×digCost），canDig 关闭时该方向无路——
  表现为"被阻断"。具体某次真机阻断走了哪条链尚无轨迹记录（与能力审查
  R1–R9 的取证口径一致），但分类缺口本身是确定事实。

决策：

- **OV-D18 障碍高度来自游戏，不靠枚举表**：Java 侧 `world.getBlock`/
  `get_blocks_region` 增加 `collisionHeight`（`getCollisionShape` 最大 Y）；
  TS 侧 block-view 按真实高度消费：≤0.6 记为可踩（地毯语义），0.6–1.2 记为
  "跳上"而非"墙"，落地高度用真值。这是原则性修复，取代逐方块进表；分类表
  仅保留 id 语义（可燃/可爬/可开/液体）。
- **OV-D19 `game_jump` 微操工具**：新写类短租约工具，封装 `control.jumpOnce`
  与按住跳，用于一格障碍的微操与逃生。它不承担寻路职责：规划路线仍走
  planner，`game_jump` 是模型层面的手动兜底。
- **OV-D20 边界**：`getMoveJumpUp` 内 `blockC.height += 1` 的共享快照污染
  （审查 R2）归 [movement-basis-repair-plan.md](./movement-basis-repair-plan.md)；
  OV-6 只改高度来源与工具面，两批不重叠。

验收：真机织布机/箱子/切石机等非满格方块可被跳上或自动踩上；两格净空场景
报告 `headroom_blocked` 而非含混的 `blocked`；`game_jump` 能越过一格障碍。

## 与现有线的交叉

- R2（快照污染）：L5 地形剖面严禁复用 planner 快照对象（OV 计划已在原则层约束）。
- R6/R7（鞘翅扫描与生命周期）：OV-5 只改起飞段；其余归 movement-basis-repair。
- R9（远程目标归属）：L4 关注集为 R9 的预判射击提供持续坐标流，但归属修复
  本身不在本计划。
- MC-1b 预算纪律：observe 输出预算是新面，spec 阶段定义每层 token 上限与
  裁剪顺序（远场→非关注桶→网格降采样）。

## 风险与开放问题

1. `radius` 上限 64 对雷达是否够（她可能想 128 预警）；`entities.query` 上限
   256，预算约束是真正限制，spec 阶段定数。
2. ~~村民交易表读取依赖菜单开合~~ 已拍板（2026-09-14）：接受"开-读-合"轻
   副作用。OV-D8 定稿为复合动作 `game_inspect_trades`（开村民菜单 →
   `menu.snapshot` 读 offers → 立即 close），收据记录"曾打开菜单"这一事实，
   不伪装成纯观察。
3. 截图通道依赖中继的视觉能力与序列化通路（OV-D14 前置验证）。
4. `terrain.surfaceProfile` 客户端降级路径的精确度与成本未测，spec 阶段
   以服务端 heightmap 为准、客户端降级仅小半径。
