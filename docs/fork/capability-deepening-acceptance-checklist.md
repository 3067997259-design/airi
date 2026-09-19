# 能力深化剩余真机验收执行清单

日期：2026-09-16。状态：待执行，逐项回填本文件。

范围：[能力深化总方案](./capability-deepening-plan.md) 中代码已落地、真机验收未完成的专题。已完成的 CD-0 身份与 CD-G 地面走廊不重复验收，基线见第 6 节与 [MODS 台账](./MODS.md)。本清单的验收收尾是 [跨线执行顺序](./cross-line-execution-order.md) 的阶段 0：完成后 OV/TG 一批才开工。

分三类管理：

- **A 类**：当前接线可直接验收。CD-L 目标追踪、CD-M 采掘、CD-B 弹道、CD-V 载具。
- **B 类**：需先接线才能验收。CD-E 鞘翅驾驶路径、CD-F 空中跟随。
- **C 类**：阻塞。RS 红石施工等待 Litematica 环境与蓝图。

## 1. 平台与运行前置

### 1.1 当前环境（2026-09-16 只读核对）

| 角色 | 位置 | 端点 | 状态 |
| --- | --- | --- | --- |
| 服务端 | `D:\Minecraft-Server`，Fabric 1.21.1 offline | 25565；服务端桥 25598 到 MCP 25602 | 在线 |
| 机器人客户端 | `versions\AIRI-bot`，玩家 `airitest`，模组 0.2.17 | 桥 25601 到 MCP 25600 | 在线，AIRI 驱动它 |
| 人工客户端 | `versions\AIRI`，玩家 `AfterRain`，模组 0.2.17 | 桥 25599 | 在线，不被 AIRI 驱动 |
| AIRI 应用 | Electron，CDP 9222 | `game-host.json`：客户端 25600、服务端 25602、planner terrain | 在线 |
| 模组源码 | `D:\mcpfabric` | 提交 `c5aecff`，`mod_version=0.2.34` | 源码已超前于本表初记的在线 jar，见下条基线锚定 |

PCL 根目录：`D:\未完成TimeLimit\残灯花火\杂七杂八的东西\.minecraft`。

**基线锚定（2026-09-16，Step 0）**：AIRI `mods` 分支 `a71a798b3`（代码批 `75430cfb8`，docs 批 `9fdbd196d`）；game-host 套件基线 **793 通过 / 1 跳过（56 文件）**。mcpfabric `c5aecff`，`mod_version=0.2.34`。源码树已从本表初记的客户端 0.2.17 / 服务端 0.2.16 前进；下轮真机前按 §1.3 前置核对在线双 jar 实际版本，未同步则先重建部署再开始验收。工作树仅余 `botclass24.txt`（javap 草稿，未跟踪，不提交）。

### 1.2 飞行起飞台（主测试台，已实测 2026-09-18）

主测试台：白色混凝土围边的 97×97×2 石制平台，行走面 y=201（下方 y=200 与 y=199 为石头），
边框中白色混凝土方块本身顶面再高一格。西侧（x<235.5）是落差约 115 格的悬崖，崖底 y≈87。

| 项 | 坐标 | 说明 |
| --- | --- | --- |
| 起飞台 | x=237..240, y=201, z=−18..−16 | `orange_terracotta` 4×3，与平台面齐平；支撑为石头 |
| 起飞标定点 | **(236, 201, −17)** | 全平台唯一的 `orange_glazed_terracotta`；(236,200,−17) 为石头 |
| 西侧净空 | x=230..235, z=−17 | y 150..204 全为空气 |
| 起飞通道 | 固定用 **z=−17** | 见下表 |

**平台不是严格空旷**：x=240、z=−23/−24 有移动靶测试留下的夹具（`polished_granite` ×3 +
`powered_rail` ×1）。夹具位置必须用逐列读取或 `edge-map.mjs` 复核；**用单条 z 线代替面扫描会漏判**
（2026-09-18 因此误判过两次）。

地图层 y=201 的固定器具（初次扫描结果，供参考，不代替逐次复核）：铁轨 36、去皮金合欢原木 14、
钻石块 14、橡木栅栏 7、动力铁轨 6、拉杆 5、抛光花岗岩 4、绯红菌柄 3、橡木楼梯 3。

方向标定（yaw=270 时实测，`calibrate-direction.mjs`）：`forward` = +x、`back` = −x、
`left` = −z、`right` = +z。**运动由按键决定，不由视角决定**——向西冲出崖用 `back`。

### 1.3 每轮前置检查
1. 运行 `netstat -ano | Select-String "LISTENING"`，核对 25565、25598、25599、25601、25600、25602、9222 都在。
2. 运行 `node client.mjs 25600 get_self`，名字必须是 `airitest`。如果返回 `AfterRain`，停止验收，先修 MCP 服务指向再开始。
3. `%TEMP%\mcp-wrap-25600.cmd` 的内容可能过期（指向用户号 25599）。重启 MCP 服务时按 bot 桥 25601 重建包装脚本；`%TEMP%` 清理会删除这些脚本（`mcp-wrap-*`、`mcserver-wrap`、`airi-wrap`）。
4. 启动顺序：MCP 服务实例不能早于 MC 客户端重启，否则桥过期（`get_block` 报 `no_server`），需要重启 25600/25602 实例。
5. AIRI 窗口中 CDP 9222 存在带 `synced-leader=true` 的页面。
6. 已知竞态：桥后起时渲染层游戏工具发现可能整场缺失，重启 AIRI 可解。开始前用 `node client.mjs 25600 list` 和工具面检查确认。
7. 证据目录 `docs/fork/evidence/live-acceptance-20260916/` 已建。

启动机器人客户端：`node launch-client.mjs "<PCL 根>\versions\AIRI-bot" airitest`。

### 1.4 常用命令

全部脚本位于 `docs/fork/evidence/movement-corridor-acceptance-20260915/`。

- 任意 MCP 调用：`node client.mjs <25600|25602> <tool> "<json>"`；列工具：`node client.mjs <port> list`。
- 服务端命令：`node runcmd.mjs 25602 "<command>"`；引号易碎时写文件并用 `@path`。
- 读方块：`node blocks.mjs <port> <out.json> x y z [x y z ...]`。
- 移动验收：`node accept-move.mjs <sx> <sz> <ex> <ez> [tol] [label]`。
- 采样：`node track-pos.mjs <秒> <out.json>`、`node watch-players.mjs 25602 <秒> <out.json>`。
- CDP：`node cdp-eval.mjs 9222 "<expression>"`。

脚本运行环境：脚本导入 `@modelcontextprotocol/sdk`，它位于 `D:\mcpfabric\mcp-server\node_modules`。在 evidence 目录直接运行会 `ERR_MODULE_NOT_FOUND`。用临时目录建 `node_modules` junction，或把脚本复制到 `D:\mcpfabric\mcp-server` 下运行。

### 1.5 分工与记录规则

自动化侧负责：CDP 下令、MCP 采样、轨迹统计、回执收集、夹具脚本、证据落盘。

人工侧（用户）负责：

- 游戏内夹具操作：`give`、`summon`、`teleport`、`fill`、搭建场地。
- 充当目标、队友或观众。
- **天空旁观**：在创造模式跟随观察，报告遥测看不到的问题，例如贴墙滑行、穿模、抖动、卡死、路线选择异常、飞行姿态异常。

记录规则：

- 每项记录：编号、日期、构建与 jar 版本、前置、命令、判据、证据文件、结果（PASS、FAIL、PARTIAL、NOT-RUN、BLOCKED）、证明范围与限制。
- 证据文件名用 `<编号>-<label>.json`，写入当轮证据目录。
- 概率类指标附分母。成功率附尝试总数与场景构成。成功与失败样本都保留。
- 验收中不改代码。发现问题记入清单，修复另开批次，回归后复验。
- 夹具用后清理，并向服务端读回核对清理结果。
- 口径沿用 fork 惯例：PASS、FAIL、BLOCKED、NOT-RUN 加证明范围，不用演示冒充通用结论。
- 每完成一批，在 [MODS 台账](./MODS.md) 追加记录。

## 2. A 类：可直接验收

### 2.1 A1 CD-L 目标追踪与长距离定位

判据来源：[目标追踪与长距离定位设计](./target-tracking-design.md) 第 6 节。验收不只看追上，还要看 UUID 是否保持、用了什么来源、数据多旧、来源切换次数、目标换维度后是否还在发移动。

人工当目标时建议用创造飞行（控制稳定）；鞘翅目标容易飞出跟随距离。

| 编号 | 场景 | 人工配合 | 判据 | 结果 |
| --- | --- | --- | --- | --- |
| L-01 | 跟随中移除原目标，再生成同名同类新实体 | 无 | 回执 uuid 固定；新实体不顶替；失败类型化（`target_offline`、`entity_unloaded`、`waiting_for_target` 等） | **PASS**（2026-09-16 复测）：不顶替成立；目标消失后 14.1 秒以 `entity_unloaded` 有界结束，`met: false`。修复批见[证据](./evidence/live-acceptance-20260916/l01-same-name.md) |
| L-02 | 目标在 64 格边界内外往返 | 移动到边界外 | 3 次缺失或 0.5 s 过期才转粗；2 个递增新鲜样本回精；无来源抖动 | **PASS（带范围说明）**：跨边界往返（最远 269.3 格）0 条跟踪失败日志、无假丢失；服务端详情读对在线玩家全距离有效，本次来源始终 `server-entity`、未触发切粗（滞回由单测覆盖，粗路径由 L-01/L-03/L-09 覆盖）。见 [l02-l06](./evidence/live-acceptance-20260916/l02-l06.md) |
| L-03 | 超过 100 个实体的场景 | 无 | 截断列表不等于目标消失；完整性字段如实 | **PASS**：(b) 非玩家目标在截断列表外 → 264ms `target_not_in_read`；(a) 玩家被挤出前 100 → 玩家列表回退解析成功并走到目标。见 [l03-truncation](./evidence/live-acceptance-20260916/l03-truncation.md) |
| L-04 | 目标进入下界，与主世界同坐标 | 带目标走传送门 | 维度不符拒绝；`target_dimension_changed`；不在错误维度发移动 | **PASS**：目标进传送门后 759ms 以 `target_dimension_changed` 收尾（`met: false`）、无错误维度移动；返回后第二条跟随正常。见 [l04-l05](./evidence/live-acceptance-20260916/l04-l05.md) |
| L-05 | 目标离线、权限不足、服务端超时 | 断开目标客户端 | 对应类型化失败；3 s 无新鲜结果转 `waiting_for_target`，默认 10 s 预算 | **PASS**：目标关客户端后 1.87 秒以 `target_offline` 收尾（`met: false`）；超时/权限变体由 L-09 的 `locator_unavailable` 覆盖。见 [l04-l05](./evidence/live-acceptance-20260916/l04-l05.md) |
| L-06 | 目标远离后返回 | 离开超 64 格再回来 | 粗定位恢复；来源切换次数可查；无长时间空转 | **PASS**：目标远离 269 格后返回并落回她附近 1.0 格；全程无空转、无丢失。见 [l02-l06](./evidence/live-acceptance-20260916/l02-l06.md) |
| L-07 | 目标起飞、落地、骑乘、瞬移 | 做这四件事 | L3 姿态与骑乘字段正确；轨迹历史在四类事件处重置 | **PASS**：走路/骑乘/滑翔三态字段与实际一致；瞬移（约 100 格）后 12ms 检出跳跃、追踪无丢失；骑乘跟随正常。轨迹重置为单测覆盖。见 [l07-pose-teleport](./evidence/live-acceptance-20260916/l07-pose-teleport.md) |
| L-08 | 乱序与迟到：重复响应、旧响应晚到、坐标为零、状态缺失 | 无（离线或注入） | 迟到观测不复活已结束的跟随；零坐标不当作真实位置 | **PASS（注入）**：重复命令去重（`dedups a retried move command by request id`）、过期不复活/序号高水位丢弃/旧目标修订丢弃（`command-registry.test.ts` 四例）、不可读玩家态拒绝（`host-port.test.ts`）均已有覆盖；**本轮修零坐标伪造**：`snapshotFrom` 不再把缺失坐标兜底成 0 原点，回归用例断言宿主报 `check_failed: fresh_state` |
| L-09 | 双端点拓扑：`get_entity` 细节读位于服务端端点 | 无 | 契约与实际一致；能力缺失有类型化限制 | **PASS**：服务端 25602 提供 `get_entity`（24 字段）且 `get_self` 只在客户端；杀掉 25602 后跟踪中的跟随 17.4 秒以 `locator_unavailable` 收尾（`met: false`）。见 [l09-l10](./evidence/live-acceptance-20260916/l09-l10.md) |
| L-10 | 停止后采样订阅释放 | 无 | 停止后有界收敛；tick 重置可观察 | **PASS**：`game_cancel` 回执延迟 218ms、终态 `cancelled`；取消后 8 秒位移 0.00；`game_status` 保持终态不复活。见 [l09-l10](./evidence/live-acceptance-20260916/l09-l10.md) |

### 2.2 A2 CD-M 工具选择、采掘与掉落归属

判据来源：[工具选择、采掘资格与工具升级设计](./mining-tools-design.md) 第 8 节。每个基础场景至少 10 次，记录评估工具、实际工具、破坏耗时、耐久变化、产物与证据等级。

完成门：不能掉落所需产物的工具在开挖前被拒绝；工具不会在关键动作前意外耗尽；取消后不继续破坏；别人提供的物品不误报为本次产出。

| 编号 | 场景 | 人工配合 | 判据 | 结果 |
| --- | --- | --- | --- | --- |
| M-01 | 五类资格：石、矿、木、作物、无工具、错误等级 | 摆方块 | 资格判定正确；`unmet` 如实；不会掉落的工具开挖前被拒 | **PASS**：6 例（石+镐/斧拒绝、钻石+石镐拒绝、空手拒绝、原木+斧、小麦+空手）全部符合。见 [m1-eligibility](./evidence/live-acceptance-20260916/m1-eligibility.md) |
| M-02 | 工具位于主背包非快捷栏 | 无 | 正确换槽选中 | **PASS**：镐移至主背包后开挖成功、`tool: wooden_pickaxe`。见 [m1-eligibility](./evidence/live-acceptance-20260916/m1-eligibility.md) |
| M-03 | 低耐久工具与备用工具 | 无 | 换备用或 `tool_durability_low`；关键动作前不意外耗尽 | **PASS（带范围）**：余 6 耐久 + 满耐久备用 → 使用损镐（`durability 6/6`、无风险标记）；未触发风险分支。见 [m1-eligibility](./evidence/live-acceptance-20260916/m1-eligibility.md) |
| M-04 | 他人同时挖同一区域 | 一起挖 | 不误报本次产出；来源账本给出可证明下界与模糊量 | **PASS（用户配合）**：同区 3 个他人 cobble 实体在场时 bot 只记自己可证明的 `count 1 / lowerBound 1 / fuzzy 0`；用户站在目标块上抢拾掉落 → `broken_no_product`、`count 0 / lowerBound 0 / fuzzy 1`（有产出事实、库存未证实，不伪造）。见 [m4-m5-b5-b6](./evidence/live-acceptance-20260916/m4-m5-b5-b6.md) |
| M-05 | 他人扔物、实体合并、拆分、被捡 | 扔与捡 | 他人物品不误报；`ENTITY_LOAD` 有界窗口关联 ItemEntity | **PASS（用户配合）**：用户右键扔 5 个鹅卵石到目标块（4 个实体、含拆分与合并），bot 破块收取后账本仍 `count 1 / lowerBound 1 / server-attributed`；实体 4→2（1 收 + 1 合并）不影响账本；被捡同 M-04b。见 [m4-m5-b5-b6](./evidence/live-acceptance-20260916/m4-m5-b5-b6.md) |
| M-06 | 背包满 | 填满背包 | 掉落剩余如实；不伪造拾取 | **PASS**：36 槽全满 → `inventory_full` 开挖前拒绝、方块完好。见 [m2-m3](./evidence/live-acceptance-20260916/m2-m3.md) |
| M-07 | 掉落进凹洞 | 无 | 一次恢复加 `dropPosition` | **PASS（带说明）**：1 格凹洞 `collected`（actual 1）；3 格不可达 → `dropPosition` 如实；高一层拾取未触发垫脚路径。见 [m2-m3](./evidence/live-acceptance-20260916/m2-m3.md) |
| M-08 | 破坏中取消 | 无 | 取消后服务端方块不再变化 | **PASS**：黑曜石 + 钻石镐 1.5 秒取消 → `cancelled`、方块 3 秒内完好。见 [m2-m3](./evidence/live-acceptance-20260916/m2-m3.md) |
| M-09 | M3 前置：collect 默认结构化前置 | 给基础材料 | 默认返回前置；`allowPrerequisites` 只做背包内 2×2；工作台与熔炉返回 `upgrade_incomplete` | **PASS**：默认 `missing_tool` + 结构化缺失清单；给原木后 2×2 制作成功、报告 `upgrade_incomplete`。见 [m2-m3](./evidence/live-acceptance-20260916/m2-m3.md) |
| M-10 | 木到石到铁升级链，再完成指定采集 | 无 | 回执列明完成部分与缺失前置；保留已取得材料与已制作工具 | **PASS（带范围）**：原木 → 木板 10 + 木棍 4 已制作并保留，工作台步骤按设计返回 `upgrade_incomplete`（无工位坐标）；完整石/铁链未跑。见 [m2-m3](./evidence/live-acceptance-20260916/m2-m3.md) |

### 2.3 A3 CD-B 弓、弩与三叉戟弹道

判据来源：[移动目标与投射物弹道设计](./projectile-aiming-design.md) 第 8 节。先关闭特殊附魔并固定装填与蓄力，再逐项增加。药水和雪球单独成结果集。

范围说明：客户端 `BotController.aimAtTarget` 的线性预判尚未替换。命中率基线受它限制。本轮验收对象是弹道档案、截获求解与回执，不是命中率提升。

| 编号 | 场景 | 人工配合 | 判据 | 结果 |
| --- | --- | --- | --- | --- |
| B-01 | 静止标靶：距离 10/20/40 格，高差 -10/0/+10 格 | 摆标靶 | 每个关键条件至少 30 发；命中率、脱靶 P50/P95、预测与实际飞行时间 | **PASS（可达条件）**：30 发/条件 —— 平地 10/20/40 = 100%/100%/96.7%、上坡 10/20 = 100%、下坡 10/20/40 = 100%，合计 **240 发 239 中（99.6%）**；唯一脱靶为 40 格散布（命中余差 P50 −0.64 格）。下方平台（dy-10）两组几何不可达，正确拒绝且保留弹药（F-10）。F-08 已修；F-09 由夹具击退抗性规避。见 [b1-range](./evidence/live-acceptance-20260916/b1-range.md) |
| B-02 | 匀速横移目标 | 直线走动或坐船 | 截获求解有效；相对线性基线有改善记录 | **PASS（2026-09-17）**：A 线矿车 4.3–4.5 格/秒专项 6/6 发射、预判方向正确（F-22/F-23）；新短轨移动靶命中核验完成——修 F-24（骑乘读载具速度）、F-25（聚焦窗口蓄力）、F-26（释放旋转补包 + 插值补偿）后，对在途骑手 **3/3 命中**（6/8/8 伤害；前置 2.79 格、`leadSource measured`、满蓄力箭速 2.97、`observedSpeed 5.17–6.37` 格/秒），宿主回执 `closestDistance 0`。夹具注意项 F-27（箭击中车体摧毁矿车）。见 [b02-moving-hit-v2.json](./evidence/live-acceptance-20260916/b02-moving-hit-v2.json) |
| B-03 | 停下与跳跃目标 | 做两个动作 | 预测与实际时间；`predictedFlightTicks` 可核 | **PASS（抽测 12 发/例）**：静止 12/12；持续抛接（释放时刻随机处于空中，落体速度真实）11/12，`predictedFlightTicks` 5 与实际一致。见 [b-jump-target](./evidence/live-acceptance-20260916/b-jump-target.json) |
| B-04 | 拒射与弹药账本 | 无 | 同时报告请求次数与实际发射次数；`no_ballistic_solution` 保弹 | **PASS**：无箭 `no_ammo` 零发射；正常射击逐发 `projectileUuid`、箭 64→61。见 [b-items-short](./evidence/live-acceptance-20260916/b-items-short.md) |
| B-05 | 友军站在弹道 | 站进弹道再走开 | `friendly_blocked`，零耗弹 | **PASS（用户配合）**：用户站弹道正中 → `friendly_blocked`、0 发射、箭 260→260；走开 5 格 → `done`、1 发、箭 260→259、靶羊 45→39（命中）。见 [m4-m5-b5-b6](./evidence/live-acceptance-20260916/m4-m5-b5-b6.md) |
| B-06 | 目标刚离开加载、服务器读数晚到、两人同时射击 | 配合走位 | 类型化结果；不把预测命中写成实际命中 | **PASS（用户配合）**：目标中途消失与箭在途（1.9 s）死亡两次都是 `done` + `hitEvidence unobserved`（不把预测写成命中）；两人同射 18 血羊 → `killed true` + `killEvidence projectile`（按弹道 UUID 如实归属）。见 [m4-m5-b5-b6](./evidence/live-acceptance-20260916/m4-m5-b5-b6.md) |
| B-07 | 三叉戟回返中取消 | 无 | 回返与取消语义正确 | **PASS**：正常投掷 `returned: true`；投出后（1311ms）立刻取消 → `cancelled`+`shots:[1]`，6 秒后三叉戟自动回包；蓄力中取消零发射。见 [b-items-short](./evidence/live-acceptance-20260916/b-items-short.md) |
| B-08 | 特殊弹药：雪球、喷溅与滞留药水、烟花弩、光谱箭、药水箭 | 无 | 独立结果集；影响半径与附魔规则；装填识别与效果应用 | **PASS（全范围）**：**效果回读通道** ✓（服务端实体详情 `effects`）；**光谱箭** `spectral-arrow` + 回读 `glowing` ✓；**药水箭（迟缓）** `tipped-arrow` + 回读 `slowness` ✓；**烟花弩** 全自动装填+发射+爆炸两轮 ✓（F-28 已修）；**喷溅/滞留药水** 瞄准投掷 + 回读 ✓（0.2.34：`interact.useEntity` 对投掷药水先瞄准再 `useItem`；poison 587 tick、slowness 434 tick）；雪球早前 ✓。见 [b08.json](./evidence/live-acceptance-20260916/b08.json)、[f28c-verify.json](./evidence/live-acceptance-20260916/f28c-verify.json)、[b08-potions.json](./evidence/live-acceptance-20260916/b08-potions.json) |
| B-09 | 物理档案残差校准：按版本、速度、姿态、地形分组 | 无 | 10/20/40 tick 残差可量化；未通过档案停用自动求解并保留受限能力 | **PASS（四分组已覆盖）**：版本 1.21.1；速度 蓄力 5/10/15/20 tick（5 拒绝、其余 30/30，预测 17/10/7 tick 与实际一致）；姿态 站立/潜行 30/30（宿主潜行眼高假设差约 0.35 格已记录）；地形 平地/上坡/下坡/被遮挡全中，命中余差 P50 −0.64 格（40 格）。未覆盖：滑翔/骑乘射击、移动射击、其他版本。见 [b1-range](./evidence/live-acceptance-20260916/b1-range.md) |
| B-10 | 薄墙或玻璃拦截 | 摆薄墙 | 当前范围：`game_shoot` 未接地形回调，薄墙拦截仅模块级验证；记录差异 | **PASS（记录差异）**：预测 `closestDistance 0`，实际被玻璃拦截（伤害 0、玻璃完好）。见 [b-items-short](./evidence/live-acceptance-20260916/b-items-short.md) |

### 2.4 A4 CD-V 船、马与矿车

判据来源：[载具旅行设计](./vehicle-travel-design.md) 第 8 节。第一轮在准备好的载具上校准驾驶，随后再加取得流程。每类关键场景至少 10 次。

范围说明：V2 的 Plan 阶段尚未用实时地形读构建图路线，旅行循环仍是直线驾驶加原语。本轮验收限原语、取得、驾驶与回执；图路线以离线 500 例测试为证据。

| 编号 | 场景 | 人工配合 | 判据 | 结果 |
| --- | --- | --- | --- | --- |
| V-01 | 船：`existing` 与 `prepare_owned` 取得 | 摆船或给材料 | 类型选择正确；不重复放置 | **PARTIAL**：`existing` 找到并登上已有船（UUID 固定、无重复放置）✓；`prepare_owned` 修复后可从读到的最近水面选点放置并登船（F-14）✓；全程航行止于夹具斜段顶端 90° 直角（加宽后 46.9 格；根因：船驾驶无左右划桨原地转向）。见 [v-deck](./evidence/live-acceptance-20260916/v-deck.md) |
| V-02 | 船：S 形河道、窄桥、靠岸 | 搭建水道 | 路线符合船宽与净空；靠岸安全；下骑正确 | **PARTIAL**：水路航点跟随（CD-V2 最小实现）已接通，弯道不再直推撞岸；加宽后斜段稳定通过；止于顶端 90° 直角（需划桨转向或放宽该角）。见 [v-deck](./evidence/live-acceptance-20260916/v-deck.md) |
| V-03 | 水中央取消 | 无 | 保守取消，不盲目下骑 | **PASS**：`cancelled`、`dismounted: false`，阶段到 dock/finish |
| V-04 | 马：身旁多种载具中选择，无鞍、未驯服、已占用 | 摆马群 | 按 UUID 取得；类型固定；失败类型化 | **PASS**：按 UUID 选空闲驯服+装鞍马并 `reached`（22.55 格，轨迹证明跨 1 格墙 + 蓄力跳 y205.08 跨 2 格墙）✓；野生马 `not_tamed` ✓；被占用 `occupied` ✓；驯服路径 `acquire_timeout`（预算内未成）✓ |
| V-05 | 马：驯服时长、蓄力跳、被甩下 | 配合 | 驯服时长记录；失败有界 | **PASS（蓄力跳+驯服；被甩下未覆盖）**：蓄力跳轨迹实证（见 V-04）；驯服走 `method: tame`、预算内未成 → `acquire_timeout`；"被甩下"需野生马投人，未单独复现 |
| V-06 | 矿车：带动力铁路、弯道、断点、分支 | 铺轨 | 有向连接正确；启动与制动；速度阈值 | **PASS（记录小差异）**：斜坡+拉杆机关起步（F-19）→ 13.32 格 → 分歧（`south_east` 转东）→ 站台下骑；域状态 failed 仅因下骑后站位距目标 2.06 > 容差 2。见 [v-deck](./evidence/live-acceptance-20260916/v-deck.md) |
| V-07 | 矿车高速运行中取消 | 无 | 取消语义正确 | **PASS**：`cancelled`、未下骑、回执 `unsafe_dismount`（车仍在动 → 保持在车上，设计 §6） |
| V-08 | 目的地没有安全下骑点 | 悬空轨道 | 类型化失败 | **PASS**：冲过断点/大洞时回执 `arrivedMounted: true` + `failure: unsafe_dismount`、`dismounted: false`（F-17 修复：下骑前核对脚下支撑） |
| V-09 | 死亡、断线、换维度、载具消失、乘客变化 | 配合 | 会话失效；资产回收；`vehicle_lost` 映射正确 | **PASS（乘客变化单元覆盖）**：矿车被毁 `vehicle_lost`（7.81 格处，F-16 修复）✓；换维度域 `dimension_changed` ✓；马被毁 `vehicle_lost`（16.12 格处）✓；乘客/控制者变化由 hijack 单元用例覆盖（单座载具无法真机加第二控制者） |
| V-10 | 空库存、被占用、无动力 | 无 | 24 项类型化失败抽测 | **PASS（抽测）**：`no_materials`（船/矿车）、`rail_not_powered`（矿车，F-15 修复后读取正确）、`not_tamed`/`occupied`/`acquire_timeout`（马）✓；"断线"未单独跑（V-09 覆盖载具消失/维度/死亡侧） |

## 3. B 类：需先接线

### 3.1 B0 接线批次（验收前置）

现状：CD-E 的新 `flight/` 模块只接入共享 `LandingSite` 与 `classifyTouchdown` 契约，没有替换 live elytra 驾驶路径。CD-F 的粗走廊没有接入跟飞驱动，2 到 5 Hz 策略更新流只实现门控与测试，没有独立 IPC 通道。

**状态（2026-09-18，提交 `571e6364c`）：接线项 1/3/4 已落地，离线门槛全过。** `movement.flight` 开关（默认 off，`game-host.json` 持久化，含 E-01 后才置位的 `calibrated`）；`flight/live-port.ts` 组装 FlightObservation（状态读新增 pitch）并以一次有界区域读服务 rollout ShapeSource（未读格未知非空气）；elytra 巡航段与 air-follow 巡航腿在开关打开时由 planRollout 替换启发式、planner 拒绝即回落；escort 相位槽 + hold/launch 可插拔门（默认关）；空中回执标注 `updateStream: 'polling'`。game-host 套件 **807 通过 / 1 跳过**（基线 793+1，含 14 个新测试），typecheck/eslint 干净，开关关闭时真机行为不变。

**第 2 项已完成（2026-09-18 第二轮）**：新增 `flight/live-corridor.ts`（有界区域读按 4 格粗格点对齐、1.5 s 或目标移动 >8 格重规划、路线瞄准点），`air-track.ts` 巡航腿接入——路线点替换直连目标，拒绝即保留直连目标，回执新增 `corridor`。套件 **830 通过 / 1 跳过（60 文件）**，typecheck 与 `pnpm lint` 干净。**四项全部完成**，等 E-01 真机采集。证据见 [b0-wiring-status-20260918](./evidence/e01-flight-calibration-20260918/b0-wiring-status-20260918.md)。

**LR-1 接线完成（2026-09-18 第三轮）**：D2 门在起飞评估与每拍起飞前生效，D4 闭合窗口每拍喂样本、连续两个不闭合窗口转 `escort_inconclusive` 有界安全降落，回执补齐 D5 字段（`escortGate`/`escortClosure`/`reserveFireworks`/`escortSuggestions`/`flightDistanceKm`/`fireworksPerKm`/`lastTargetAgeMs`）。新增 `GameHostFlightConfig.escort`，非 `off` 仍需 `planner: 'on'` 且 `calibrated: true`，**E-01 通过前不会真正生效**。套件 **842 通过 / 1 跳过**。LR-2 仅建议模式与计数就绪（消息发送未实施），LR-3/LR-4 未实施。见 [lr1-wiring-status-20260918](./evidence/e01-flight-calibration-20260918/lr1-wiring-status-20260918.md)。

**LR-2/LR-3/LR-4 代码完成（2026-09-18 第四轮，用户批准启用 escort）**：LR-3 新增
`movement/flight-energy.ts`，点火只按 D4 的三类条件（高度低于所需 / 速度低于滑翔下限 /
闭合速率为负且预算允许），落地储备不再被推进消耗，目标样本越旧高度余量越大；LR-2 新增
`movement/escort-say.ts`（2 条/分钟、同文不重发、命令结束关闭、`say` 被拒不占额度），驱动在
D4 判 `stalled` 时发建议、只统计真正发出的；LR-4 用走廊实测路线弯折替换 D2 的常数
`detourFactor`，并把 `rocketBoostTicks` 由 10 改成 E-01 实测的 35。`escort` 已置 `on`。
**真机场景仍 NOT-RUN**（200/500 格伴飞、低空绕山穿谷、残差分组），与 E-02..E-10 + FS-01..09
合并验收一起跑。套件 **885 通过 / 2 跳过**。见 [MODS.md](./MODS.md) 同日条目。

两处契约发现（保留待办）：`RolloutLimits.fireworks` 在储备比较中按推进 tick 数读取（live-port 已换算并加 NOTICE）；地平线与读取半径须满足 半径 ≥ 地平线 × 最大加速速度（现取 12 tick / 20 格，单元数 28.6k 在 30k 预算内；走廊读取 65×9×65 ≈ 25k，同样在预算内）。走廊的粗格点把高度量化到 ±2 格，路线瞄准点取格中心，**爬升是否引起高度振荡需要 E-02 真机确认**。

新增专题：[远距伴飞设计](./long-range-escort-design.md)。LR-0 与本接线批是同一批工作；伴飞策略（`escort`）与其接线一并实施，默认关闭。

接线工作：

1. 把新飞行模块接入 live 鞘翅驾驶路径，并提供显式的切换点。
2. 把粗走廊接入跟飞驱动。
3. 策略更新流二选一：接独立 IPC 通道，或明确按轮询验收并记录差异。
4. 回归门槛：`flight/` 77 例、air-follow 33 例、移动套件 338 例不得回退。校准通过前不改变真机默认行为。

顺序：先做 CD-E 接线与 E1 残差校准。校准不通过，不启用 E2、E3 与 F。

### 3.2 B1 CD-E 鞘翅三维导航与降落（接线后）

判据来源：[鞘翅三维导航、轨迹控制与降落设计](./elytra-navigation-design.md) 第 9 节。主流程先采集无障碍滑翔，随后加入障碍。每类至少 20 次，保留失败轨迹与地图。

| 编号 | 场景 | 人工配合 | 判据 | 结果 |
| --- | --- | --- | --- | --- |
| E-01 | 无障碍滑翔、不同 pitch、转向、火箭推进、速度衰减 | 旁观 | 10/20/40 tick 预测残差可量化 | **PASS（用户裁定 2026-09-18）**：三个维度全部覆盖。直线滑翔 5 次（pitch −3 ×3、−15、−30）40 tick 残差 0.0005–0.0019 格；转向（−3，10°/s，390°）0.0315 格；助推（−3，一发）0.0027 格。去重后逐 tick 对齐（distinct tick / 时长 ≈ 20.0）。**过程中发现并修正真实缺陷**：`ROCKET_BOOST_TICKS` 10 → 35（实测助推平台期，绑定 `flight_duration:2`），助推残差 40 tick 由 5.594 格降到 0.0027 格。**未覆盖**：其他 `flight_duration` 的助推窗口、其他 MC 版本、其他移动类模组。见 [e01-residuals](./evidence/e01-flight-calibration-20260918/e01-residuals.md) |
| E-02 | 薄墙、低顶棚、斜向通道、山脊、突然出现的障碍 | 搭场地 | 侧绕有效；每类至少 20 次 | |
| E-03 | 各阶段取消与独立期限 | 无 | 停止与异常场景有界收敛 | |
| E-04 | 复飞三阶段：recover、leave、re-align | 无 | 有界过程 | |
| E-05 | 着地分类：真着地、落水、未核实 | 引导落水 | `touchdown_unverified`、`landing_in_water` | |
| E-06 | 错过落点 go-around、无落点 `no_reachable_landing`、备用落点 | 无 | 类型化结果；应急落点持续维护 | |
| E-07 | 单程闭环至少 100 格 | 无 | 到达率、实际航程、最大转角、烟花消耗、最低健康、落点误差、收尾耗时 | |
| E-08 | 烟花经济与耐久：操作 ID 计费、多组换槽、飞行中耐久刷新 | 给烟花 | 不重复计费；低补给早降仍成立 | |
| E-09 | 计算预算超支时使用已核对前缀 | 无 | 超预算有界，不阻塞客户端 tick | |
| E-10 | 旧修订重放、读取失败 | 无 | 旧任务不复活；读取失败有明确结果 | |

### 3.3 B2 CD-F 空中跟随与地空切换（接线后）

判据来源：[空中跟随与地空切换设计](./air-follow-design.md) 第 7 节。首轮在开阔场地以 60 秒持续跟飞为单位，间距带内时间比例 80% 为初始门槛。每类至少 10 次。

现场记录（非正式）：2026-09-16 两次真机冒烟。第一次（高速目标）起飞成功、烟花 19、带内 45.7%、`low_health`/`touchdown_unverified` 后撞山阵亡（旁观证词确认为未接线的高速避障）。第二次（缓慢下降）起飞成功、跟随目标从 y139 降到 y79 并着陆，落点距目标 4.4 格，收尾 `target_unreachable`（着陆后地面接近失败）。见 [air-follow-flight-smoke](./evidence/live-acceptance-20260916/air-follow-flight-smoke.md)。正式验收仍待 B0 接线批。

| 编号 | 场景 | 人工配合 | 判据 | 结果 |
| --- | --- | --- | --- | --- |
| FS-01 | 60 秒持续跟飞 | 做飞行目标 | 间距带时间比例不低于 80%；无碰撞；无重复起飞；无追上后误降落 | |
| FS-02 | 目标急转 | 做急转 | 同 FS-01 统计 | |
| FS-03 | 绕山 | 沿山飞行 | 同 FS-01 统计；旁观姿态 | |
| FS-04 | 目标穿过狭缝 | 穿过她不能通过的狭缝 | 结果有界；不硬撞 | |
| FS-05 | 目标原地盘旋 | 盘旋 | 会合区有界 | |
| FS-06 | 远处丢失后返回 | 离开再返回 | `waiting_for_target` 预算内恢复 | |
| FS-07 | 落地与再次升空 | 落地再起飞 | 连续起落正常 | |
| FS-08 | 注入：进近时取消、丢失时耐久不足、旧目标更新晚到、不同维度同坐标 | 无 | 类型化结果；更新门控不重复起飞或自动降落 | |
| FS-09 | 回执字段核对 | 无 | 活动时间、在带时间、丢失次数、模式切换、烟花消耗、最终观测 | |

## 4. C 类：阻塞

### 4.1 C1 RS 红石施工与局部维修

现状：宿主侧模块完成，定向 734 例通过，适配器边界可编译。Litematica 与 MaLiLib 产物在 Gradle cache 和 mavenLocal 均不存在。真实投影、生存施工、受控触发、盲测与甘蔗夹具全部 NOT-RUN。

需要用户提供：

1. Litematica 与 MaLiLib 的 1.21.1 产物，或允许新增该依赖。
2. 甘蔗机蓝图：一个基准实例、两个位置或朝向不同的留出实例、一个没有该故障的正常对照。
3. 可施工的场地与权限。

验收顺序（判据见[红石施工与局部维修设计](./redstone-automation-design.md) 第 6 节）：

1. RS-1：投影选址。结构居中且完全位于允许区域，箱子可达。
2. RS-2：生存施工。复刻结构，配置核对，暂停恢复不重复施工。
3. RS-3：触发与观测。每个修复实例至少三轮受控触发。能区分结构正确与功能异常，观测缺失有明确结果。
4. RS-4：自主诊断与最小维修。无故障提示完成维修，复测通过，恢复后不撤销有效维修，差异单独保存。
5. 正常对照必须通过且不产生无必要的维修。

## 5. 已验收基线（不重复）

- CD-0 控制身份与外部撤销、CD-G1 与 CD-G2 地面走廊：见 MODS 2026-09-15 条目。
- 近拐点跳过、床与薄顶方块、扩窗 8 到 16 到 32 到 48、自然草坡、真山攀爬、斜跳链、综合赛道 combo-p3 与 combo-p4：见 MODS 2026-09-15 与 2026-09-16 条目。
- D1 到 D4 复现已转正。移动套件 338 例全绿。
- 跑酷缺口（铁栅栏柱间连跳、三格旋转跳、全局精确落点模式）已记录，暂不排期，不是本轮验收目标。综合赛道保留三根铁栅栏踏板。
- 旧鞘翅单程飞行、低补给早降、三叉戟归属与信标等真机证据见 MODS 2026-09-14 条目。它们不能替代 B1 与 B2 的新模块验收。

## 6. 结果登记表

每项完成后填写。构建列记录 AIRI 构建时间与两侧 jar 版本。

| 编号 | 日期 | 构建 | 结果 | 证据 | 备注 |
| --- | --- | --- | --- | --- | --- |
| L-01 | 2026-09-16 | 客户端 0.2.17 / 服务端 0.2.16 | PARTIAL → **PASS** | [l01-same-name](./evidence/live-acceptance-20260916/l01-same-name.md) | 首轮：同名不顶替通过、目标消失后有界失败缺失（粘性 forced outcome + `timeout` 记成功、`met: true`）。修复批（tracker forced 语义 + 循环终态结束 + 4 条回归）后复测：14.1 秒 `entity_unloaded`、`met: false`。残留观察：keepDistance 未形成停车半径（见 F-01） |
| L-03 | 2026-09-16 | 客户端 0.2.17 / 服务端 0.2.16 | **PASS** | [l03-truncation](./evidence/live-acceptance-20260916/l03-truncation.md) | (b) 217 实体、截断 100、Lumi 列表外 → `target_not_in_read`（264ms）。(a) 218 实体、玩家 18.0 格在第 100 名（9.2 格）之外 → 玩家列表回退解析成功、4.3 秒走到目标、`timeout`/`met: true`。F-01 追加数据点 |
| L-02 | 2026-09-16 | 客户端 0.2.17 / 服务端 0.2.16 | **PASS** | [l02-l06](./evidence/live-acceptance-20260916/l02-l06.md) | 跨边界往返（最远 269.3 格）0 条跟踪失败；来源始终 server-entity（未触发切粗）；收尾为脚本保护性取消 + 有界安全降落 |
| L-04 | 2026-09-16 | 客户端 0.2.17 / 服务端 0.2.16 | **PASS** | [l04-l05](./evidence/live-acceptance-20260916/l04-l05.md) | 进下界 759ms `target_dimension_changed`、`met: false`；返回后第二条跟随 `timeout` |
| L-05 | 2026-09-16 | 客户端 0.2.17 / 服务端 0.2.16 | **PASS** | [l04-l05](./evidence/live-acceptance-20260916/l04-l05.md) | 断线后 1.87 秒 `target_offline`、`met: false` |
| L-06 | 2026-09-16 | 客户端 0.2.17 / 服务端 0.2.16 | **PASS** | [l02-l06](./evidence/live-acceptance-20260916/l02-l06.md) | 目标远离 269 格后返回并落回附近 1.0 格；无空转、无丢失 |
| L-07 | 2026-09-16 | 客户端 0.2.17 / 服务端 0.2.16 | **PASS** | [l07-pose-teleport](./evidence/live-acceptance-20260916/l07-pose-teleport.md) | 三态字段正确；瞬移 100 格后 12ms 检出跳跃、无跟踪丢失；骑乘跟随 `timeout`（首轮脚本缺陷已修正复测） |
| M-01 | 2026-09-16 | 客户端 0.2.17 / 服务端 0.2.16 | **PASS** | [m1-eligibility](./evidence/live-acceptance-20260916/m1-eligibility.md) | 6 例资格判定正确；开挖前拒绝（`tool_level_too_low`/`no_tool`） |
| M-02 | 2026-09-16 | 客户端 0.2.17 / 服务端 0.2.16 | **PASS** | [m1-eligibility](./evidence/live-acceptance-20260916/m1-eligibility.md) | 主背包镐正确换槽 |
| M-03 | 2026-09-16 | 客户端 0.2.17 / 服务端 0.2.16 | **PASS（带范围）** | [m1-eligibility](./evidence/live-acceptance-20260916/m1-eligibility.md) | 余 6 耐久按预期使用、无风险标记；风险分支未触发 |
| M-06 | 2026-09-17 | 客户端 0.2.17 / 服务端 0.2.16 | **PASS** | [m2-m3](./evidence/live-acceptance-20260916/m2-m3.md) | 36 槽全满 → `inventory_full` 开挖前拒绝、方块完好 |
| M-07 | 2026-09-17 | 客户端 0.2.17 / 服务端 0.2.16 | **PASS（带说明）** | [m2-m3](./evidence/live-acceptance-20260916/m2-m3.md) | 1 格凹洞 `collected` actual 1；3 格不可达 `dropPosition` 如实；高一层拾取未触发垫脚 |
| M-08 | 2026-09-17 | 客户端 0.2.17 / 服务端 0.2.16 | **PASS** | [m2-m3](./evidence/live-acceptance-20260916/m2-m3.md) | 黑曜石 + 钻石镐 1.5 秒取消 → `cancelled`、方块完好（慢方块场景） |
| M-09 | 2026-09-17 | 客户端 0.2.17 / 服务端 0.2.16 | **PASS** | [m2-m3](./evidence/live-acceptance-20260916/m2-m3.md) | 默认结构化前置（missing oak_log）；`allowPrerequisites` 2×2 制作成功 |
| M-10 | 2026-09-17 | 客户端 0.2.17 / 服务端 0.2.16 | **PASS（带范围）** | [m2-m3](./evidence/live-acceptance-20260916/m2-m3.md) | 木板 10/木棍 4 保留；工作台步骤 `upgrade_incomplete`（设计边界） |
| B-01 | 2026-09-17 | 客户端 0.2.17 / 服务端 0.2.16 | **PARTIAL** | [b-items-short](./evidence/live-acceptance-20260916/b-items-short.md) | 10 格组 30/30 命中（伤害 6–10）；20/28 被庭院结构阻挡；40 与 ±10 待靶道 |
| B-04 | 2026-09-17 | 客户端 0.2.17 / 服务端 0.2.16 | **PASS** | [b-items-short](./evidence/live-acceptance-20260916/b-items-short.md) | 无箭 `no_ammo`；每发 `projectileUuid`，箭 64→61 |
| B-07 | 2026-09-17 | 客户端 0.2.17 / 服务端 0.2.16 | **PASS** | [b-items-short](./evidence/live-acceptance-20260916/b-items-short.md) | 回返 `returned: true`；投出后取消仍自动回包；蓄力取消零发射 |
| B-08 | 2026-09-17 | 客户端 0.2.17 / 服务端 0.2.16 | **PARTIAL** | [b-items-short](./evidence/live-acceptance-20260916/b-items-short.md) | 光谱箭/雪球✓；烟花弩 `load_timeout`；药水箭与效果回读未覆盖 |
| B-10 | 2026-09-17 | 客户端 0.2.17 / 服务端 0.2.16 | **PASS（记录差异）** | [b-items-short](./evidence/live-acceptance-20260916/b-items-short.md) | 预测命中、实际被玻璃拦截（差异已记录） |
| B-01（靶道） | 2026-09-17 | 客户端 0.2.17 / 服务端 0.2.16 | **PARTIAL** | [b1-range](./evidence/live-acceptance-20260916/b1-range.md) | 10 发/条件：平地 10 格 100%、20/40 格 0%、上坡 40%/0%、下坡 100%/90%/0%；F-08 下垂实测约 1.0 格 |
| B-01（靶道·F-08 修复后） | 2026-09-17 | 客户端 0.2.18 / 服务端 0.2.16 | **PARTIAL** | [b1-range-terrain2](./evidence/live-acceptance-20260916/b1-range-terrain2.json) | 10 发/条件：平地 10/20/40 全中、上坡 10/20 全中（弹道解生效） |
| B-01（靶道·地形避让后） | 2026-09-17 | 客户端 0.2.19 / 服务端 0.2.16 | **PASS（可达条件）** | [b1-range-terrain2](./evidence/live-acceptance-20260916/b1-range-terrain2.json) | 80/80 全中（8 组可达条件 × 10 发）；dy-10 两组正确拒绝；夹具加击退抗性（F-09） |
| L-09 | 2026-09-16 | 客户端 0.2.17 / 服务端 0.2.16 | **PASS** | [l09-l10](./evidence/live-acceptance-20260916/l09-l10.md) | 双端点事实 + 端点丢失降级：杀掉 25602 后 17.4 秒 `locator_unavailable`、`met: false`；环境已复原 |
| L-10 | 2026-09-16 | 客户端 0.2.17 / 服务端 0.2.16 | **PASS** | [l09-l10](./evidence/live-acceptance-20260916/l09-l10.md) | 取消回执 218ms、取消后 8 秒位移 0.00、终态不复活 |
| E-01（直线滑翔） | 2026-09-18 | 客户端 0.2.34 / 服务端 0.2.29 | **PASS** | [e01-residuals](./evidence/e01-flight-calibration-20260918/e01-residuals.md) | 5 次无障碍滑翔（pitch −3 ×3、−15、−30，30–60 s）。去重后逐 tick 对齐（distinct tick/时长 ≈ 20.0）。40 tick 残差 0.0005–0.0019 格，随 tick 单调但不爆炸（真物理项错误会到几格至几十格） |
| E-01（转向） | 2026-09-18 | 客户端 0.2.34 / 服务端 0.2.29 | **PASS** | [e01-residuals](./evidence/e01-flight-calibration-20260918/e01-residuals.md) | 恒定 pitch −3、yaw 10°/s、40 s、转过 390.5°。偏航率由录像 yaw 序列最小二乘拟合 = 10.0 °/s（与计划比值 1.000）。40 tick 残差 0.0315 格 |
| E-01（火箭推进） | 2026-09-18 | 客户端 0.2.34 / 服务端 0.2.29 | **PASS（修正后）** | [e01-residuals](./evidence/e01-flight-calibration-20260918/e01-residuals.md) | 发现 `ROCKET_BOOST_TICKS` 10 → 实测 35（平台期），修正前 40 tick 残差 5.594 格且发散，修正后 0.0027 格；脉冲幅度本已正确（点火那一 tick 差 1.2%）。绑定 `flight_duration:2` |
| E-01（姿态基线） | 2026-09-18 | 客户端 0.2.34 / 服务端 0.2.29 | **PASS** | [e01-residuals](./evidence/e01-flight-calibration-20260918/e01-residuals.md) | 用户裁定通过；`movement.flight.calibrated` 置 true（同时解锁 escort 与低空捷径的开关，设计 D6） |

## 7. 发现跟踪（验收产出）

| 编号 | 发现 | 来源 | 状态 |
| --- | --- | --- | --- |
| F-01 | `keepDistance` 未形成停车半径：单腿跟随会走进或穿过目标（L-01 复测最近 0.14 格、终点距目标 0.92 格；L-03a 对玩家最终距离 0.00 格并保持）。需定语义：腿部重规划阈值，还是保持距离。若是后者，落点与到达判据要按目标位置而非目标格角 | L-01、L-03 验收 | **已修复并复验通过**（2026-09-16，用户裁定选项 B：停车半径）：跟随腿改为瞄准"以目标为圆心、keepDistance 为半径"的圆环站位（新容差 0.75），目标走近不后退。真机抽检：羊目标 6 格、keep 3 → 最小=最终 **2.77 格**（对照修复前 0.14/0.92）。781 passed。见 [f01-standoff](./evidence/live-acceptance-20260916/f01-standoff.md) |
| F-02 | 跟随开始时目标玩家在 64 格外且实体列表未截断时，初解析只查实体查询就会 `target_lost`；玩家列表回退只在截断分支运行（`index.ts` 的 `resolveFollowTarget`）。设计写"首次名字解析可以复用现有查询和玩家列表" | 代码核对；L-03 后续远距实测 | **已修复并复测**（2026-09-16）：124.4 格实测 289ms `target_lost`；修复=未命中总是回退玩家列表（+1 回归，779 passed）；复测解析成功、`timeout` 收尾。见 [f02-far-resolve](./evidence/live-acceptance-20260916/f02-far-resolve.md) |
| F-03 | 空中跟飞起飞评估只数快捷栏与主背包的鞘翅，不认已穿戴的胸甲鞘翅（`assessHostAirLaunch`），滑翔目标实测 `cannot_air_follow` | 真机复现（2026-09-16 滑翔） | **已修复并冒烟通过**：评估改读装备槽（+1 回归，780 passed）；同场景起飞成功（launchAttempts 1、19 烟花、带内 45.7%），随后坠毁 `low_health`/`touchdown_unverified`。见 [air-follow-flight-smoke](./evidence/live-acceptance-20260916/air-follow-flight-smoke.md) |
| F-04 | 空中跟随落地交接后第一条地面腿使用起飞前的陈旧目标（实测指向 143 格外的旧坐标），且起飞前的地面腿失败计入落地后的连续失败 → 着陆后目标就在 5 格外却 `target_unreachable` | 真机日志（2026-09-16 跟随下降运行） | **已修复并复验通过**（2026-09-16 实心地面落点）：交接时清空共享目标、重置失败计数、先重新读取再规划；复验中目标落地后她步行到距目标 1.0 格并陪站 110 秒，不再 `target_unreachable`；期间 `modeSwitches: 2`、烟花 12。高草假设已排除（`_grass` 后缀放行；同坡纯地面跟随 5.8→2.3 格）。见 [air-follow-flight-smoke](./evidence/live-acceptance-20260916/air-follow-flight-smoke.md) |
| F-05 | `travelMode: auto` 且目标在附近滑翔时，地面跟随对空中的目标格规划地形腿（搭塔/搭桥），长腿还阻塞空中评估的 3 次取样 → 搭塔后沿空中目标方向走下台边，从 y142 摔到 y86 阵亡 | 真机复现（2026-09-16 F-04 复验运行） | **已修复并复验通过**：目标细观测 `fallFlying === true` 且存在空中控制器时跳过地面腿、等待空中决策；评估拒绝原因加入调试日志（实测记录过一次 `launch_unavailable`）。复验运行中目标滑翔期间无地面追空。780 passed。见 [air-follow-flight-smoke](./evidence/live-acceptance-20260916/air-follow-flight-smoke.md) |
| F-06 | `auto` 的 F-05 守卫只覆盖滑翔目标：目标在空中但未滑翔（创造悬停）时，地面腿会把圆环站位规划到目标高度，可能再次搭塔搭桥追空。本轮被外部脚本保护性取消，未复现完整风险路径 | L-02/L-06 运行 | 待复现与评估（低优先） |
| F-07 | 宿主采掘端口调用 `mine_evaluate_harvest` / `mine_break_evidence`，桥实际暴露 `evaluate_harvest` / `get_break_evidence` → 评估永远失败并静默回退手动破坏（工具资格/耐久/前置全不生效；M-01/02/03 首跑 8/8 无 tool 字段） | M-01 首跑（真机） | **已修复并复验通过**：改用真实工具名、`SERVER_FIRST_TOOLS` 与能力表同步、单测 mock 同步；8/8 通过。见 [m1-eligibility](./evidence/live-acceptance-20260916/m1-eligibility.md) |
| F-08 | 客户端 `aimAtTarget` 线性预判 + 固定初速、无重力补偿；宿主弹道解（`closestDistance 0`、`arc low`）不是实际执行路径 → 平地 ≥20 格命中率 0%、上坡偏差更大（20 格实测下垂约 1.0 格，箭头扎进地板） | 靶道矩阵 + 落点实测（2026-09-17） | **已修（客户端 0.2.18）**：客户端按审计档案常数（0.05/0.99/`eyeY-0.1`/蓄力速度曲线）逐 tick 解发射俯仰角，俯仰候选粗到细搜索、逐拍模拟；接线前 20 格全脱靶 → 接线后平地 10/20/40 全中。回归：game-host 782 测试通过 |
| F-09 | 击退速度进入线性预判：命中后目标带残速，宿主把 `速度 × 整个预测飞行时间` 当预判量 → 瞄准点被推过静止目标（最高 +1 格）或被推入墙体（≥2.5 格时整组 `no_ballistic_solution`，如 40 格靶靠近 +10 塔） | 靶位/瞄准日志（2026-09-17） | 待设计迭代（CD-B2 目标模型：速度衰减或地面目标预判上限）；验收夹具已加 `knockback_resistance=1.0` 规避；真实修复前，靠墙静止目标的连续射击会被拒绝 |
| F-10 | 靶道 dy-10 组（主平台 → 下方平台）几何不可达：目标 z 在主平台足迹内（悬挑下），直线与抛物都必须穿过主平台地板；实测箭在射手前 1.5 格落地并被自动捡回 | dy-10 探针（2026-09-17） | 非缺陷：条件无效。靶道若要保留该高差场景，需把射手移到平台边缘外侧，或把下方平台移出悬挑区 |
| F-11 | 载具行程回执（`VehicleReceipt`：取得方式/UUID/里程/停靠/是否下骑/阶段）被 `vehicle-session` 计算后未进入命令结果：`settle` 入参表、`GameCommandReceipt` 与 `GameDomainResult` 都没有 `vehicle` 字段 → V 项无法核对设计 §7 要求的事实 | 索引级 `move_to` 船行程跟踪（2026-09-17） | **已修**：`command-registry` 三处 + `index.ts` 领域结果 + 共享契约加 `vehicle`；新增脚本化船行程集成测试（断言回执与"不重复放置"） |
| F-12 | 挂载确认竞态：`board_vehicle` 返回 `boarded=true` 后，`get_vehicle` 需 ~150–400 ms（下一客户端 tick）才报告 riding；宿主立即回读 → 真实成功的挂载被误判 `not_controllable`（船/马/矿车均中） | 载具挂载时序探针（2026-09-17） | **已修**：`confirmControl` 在有界窗口内重试（8 次 × 100 ms）；回归测试覆盖"前两次读不到、之后正常" |
| F-13 | 模组按键输入**不驱动已乘船**：登船后 `forward`/`sprint`/`left`/`jump` 各 2 秒，船与玩家位置零变化（行走输入正常）→ 船行程必然 `route_unavailable` | 船输入矩阵探针（2026-09-17） | 待模组侧修复：显式发送玩家输入/划桨包（设计 §4 已提示划桨与转向差异）；阻塞 V-01a 行程、V-02、V-03 的"移动中取消" |
| F-14 | 船 `prepare_owned` 放置不计耗材、不生成实体（`asset.consumed=0`、世界船实体 0→0）→ 后续 `not_controllable` | V-01b（2026-09-17） | 待查模组放置路径与水域瞄准条件；阻塞 V-01b、V-02 |
| F-15 | 客户端矿车轨道格读取用 `y-0.5`，落到轨道下方一格 → 带电动力轨也报 `powered:false`（V-10a 的"正确拒绝"同为该因） | 供电轨探针（2026-09-17） | **已修**：改用矿车自身格（`blockPosition`）；回归含"滑行车算已启动"（F-18） |
| F-16 | 矿车旅行缺少骑乘校验 → 载具被毁时报 `launch_unavailable` 而非 `vehicle_lost`（船/马均有该校验） | V-09a（2026-09-17） | **已修**：按 `RIDING_CHECK_EVERY` 读骑乘并命名 `vehicle_lost`；回归用例覆盖 |
| F-17 | 矿车到站下骑未核对脚下支撑 → 在断点/大洞上方把玩家放下（玩家坠落）；域状态还报 `ok` | V-08（2026-09-17） | **已修**：支撑不可读或为空气即 `unsafe_dismount` 且不下骑（`arrivedMounted`）；`dockVehicle` + `safeDismount` 两路都加 |
| F-18 | 矿车滑行时所在格已是普通轨 → 起步判定误报 `rail_not_powered`（斜坡/机关起步后必现） | V-06（2026-09-17） | **已修**：已观测到速度即视为已启动；回归用例覆盖 |
| F-19 | 能力缺口：矿车起步的"已授权机关交互"（拉杆）与船的水路航点均未实现 → 弯道/机关夹具全卡 | V-01/V-02/V-06（2026-09-17） | **已实现**：拉杆机关（区域找 lever → 看向 → `use_block` → 复读轨道）与水路 BFS 航点跟随（含沿水线可见最远点、读取过大退回直线）；夹具急斜段调参留后续 |
| F-20 | 服务端 `respawn` 工具存在于 schema，但桥方法 `player.respawn` 未实现（`unknown_method`） | 死亡恢复（2026-09-17） | **结案：误报**。客户端模组早已实现 `player.respawn`；先前是手动调用打到了**服务端**桥。真机复验：击杀后 `game_respawn` → `endReason: respawned`、`respawned` 带回新位置、血量恢复 20。遗留小项：服务端桥暴露 client-only 工具并以 `unknown_method` 回答（工具面过滤，随 OV 线处理） |
| F-21 | 能力缺陷：船的水路跟随只有"前进/后退"，缺左右划桨/原地转向与倒船机动 → 90° 直角与急角无法通过（日志持续 `boat paddle turn unverified`）；当前 `planRouteFollow` 是"沿水线可见最远点"的简化跟随 | V-01/V-02（2026-09-17） | **待办**：用泛用性更好的路径规划 + 划桨转向（左右桨脉冲、倒船三步机动）实现；模组按键通道已支持 left/right，仅宿主规划未使用 |
| F-22 | 走廊障碍分类把"无形状数据的薄方块"（铁轨/地毯等）当整块；区域读取无法区分"整块"与"精确空碰撞" | B-02 探针（2026-09-17） | **已修（并验证）**：走廊读取改用 detailed（携带精确碰撞盒）+ 目标格 ±1 豁免；随后确认 live 拒绝来自真实墙体（见 F-23），避让逻辑本身正确 |
| F-23 | live `game_shoot` 对矿车目标一律 `no_ballistic_solution`（离线求解同数据正常） | B-02 专项（2026-09-17） | **结案：非缺陷**。加调试日志（`refusalDetail` + 被挡格）后定位：被挡格是射击线上的**金合欢墙**（射手站在墙东侧）→ 地形避让正确拒绝。射手移到墙以南后 6/6 正常发射、预判方向正确 |
| F-24 | 骑乘目标的自身 `motion` 读数为 0（乘客不累积 deltaMovement）→ 宿主与客户端预判前置均为 0，对匀速骑乘靶全部脱靶 | B-02 移动靶（2026-09-17） | **已修**：宿主 `readTargetObservationByUuid` 在 `riding` 时改读载具速度并写入 `observedSpeed`（真机 5.17–6.37 格/秒，带回归用例）；客户端 `combatAimVelocity` 三源（载具运动/实测位置差分/自身），因载具客户端值有 0 与尖峰噪声而**实测差分优先**；`aimLead` 进战斗状态可审计 |
| F-25 | 窗口聚焦（无菜单）时蓄力被逐 tick 重置：原版输入路径仅在 `screen == null` 运行 `if (player.isUsingItem() && !keyUse.isDown()) releaseUsingItem`，而模组只用 `gameMode.useItem` 蓄力、从不按住 `keyUse` → 失焦（暂停菜单）时蓄力正常，聚焦时无法完成 | 用户观察（2026-09-17） | **已修（0.2.23，真机验证）**：蓄力/装填/三叉戟期间按住 `keyUse`，释放/中止/`finishCombat`/`finishRiptide` 全部松开；反编译核对不会重启蓄力（服务端 `startUsingItem` 有 `!isUsingItem()` 守卫、客户端 `MultiPlayerGameMode` 无 `startUsingItem`）。聚焦窗口打静止靶 45→37 命中 |
| F-26 | 移动靶"最后一公里"：① 释放包不带旋转，服务端用上一 tick 的滞后角度出箭 → 有效前置≈一半；② 客户端插值位置滞后服务端约 3–5 tick → 前置从滞后位置算起 | B-02 移动靶（2026-09-17） | **已修（0.2.27/0.2.28，真机验证）**：释放前补发 `ServerboundMovePlayerPacket.Rot`（同连接有序到达）→ 箭方向跟随带前置点（`release.arrow` 与 `release.aim` 方向一致、满速 2.96–2.99）；前置再加固定 3 tick 插值补偿。12 发中前 3 发对在途骑手 3/3 命中（6/8/8 伤害，前置 2.79 格、`leadSource measured`） |
| F-27 | 箭命中矿车会摧毁矿车（掉落 Minecart 物品）→ 移动靶夹具被击中车体即终结，骑手落回原地（其后射击退化为静止靶） | B-02 移动靶（2026-09-17） | **夹具注意项（非缺陷）**：先前现场"矿车消失"即此原因。后续移动靶建议用更高骑手/遮挡车体，或接受"命中骑手后车体仍可能被误击"的窗口 |
| F-28 | 烟花弩 live 自动装填不完成：弩的 `useOnRelease()` 为 true（按住永不自动完成）且 `tryLoadProjectiles` 只在 `releaseUsing` 中调用——原版装填必须"松开"；模组曾从不主动松手 | B-08（2026-09-17） | **已修（0.2.32/0.2.33，真机验证）**：按住 ≥30 tick 后主动松手并循环等待（每轮一次松手），副手烟花计入预检与弹药计数。真机连续两轮：`fired 1`×2、`profileId firework-rocket`、`verifiedBy projectile`，爆炸伤害 45→28.4→11.5（16.6/16.8）。原版机制细节：`getSupportedHeldProjectiles`=ARROW_OR_FIREWORK（副手）而 `getAllSupportedProjectiles`=ARROW_ONLY |

## 8. 跨线批次影响标记（2026-09-16）

依据[跨线执行顺序](./cross-line-execution-order.md)与 [OV 升级计划](./game-observe-upgrade-plan.md)、[TG 计划](./minecraft-autonomous-trigger-plan.md)。以下项在阶段 0 只取临时基线，或在阶段 1 后需要增量复核；**不要按最终判据提前验收**。

| 项 | 影响来源 | 处理 |
| --- | --- | --- |
| L-03（已 PASS） | OV-1：`entities.query` 增运动/来源字段，排序改为"相关性 + 距离 + UUID"，输出分层预算 | 现状 PASS 只对当前构建有效；OV-1 落地后按新雷达契约做一次增量复核（"截断不等于丢失"的规则不变） |
| L-02、L-09 | OV-1：雷达字段、双 jar 升版本、服务端/客户端处理器；`get_entity` 细节读拓扑 | 行为判据照常在阶段 0 验收；OV-1 后各补一条字段与能力级增量 |
| E-01 至 E-10 | LR-0（驾驶决策层接线）；OV-5（起飞点语义修正与平地起飞候选，接 4 个 live 接入点） | 阶段 0 按 LR-0 后验收；"起飞可用性/边缘起飞假设"判据在 OV-5 后会再变，验收记录标注"起飞语义待 OV-5"，`launch_unavailable` 不作最终能力上限 |
| FS-01 至 FS-09 | LR-0；80% 间距带与能耗阈值待 LR-0 基线；LR-3/LR-4 改能量管理与捷径 | 同上；数值阈值标记"首轮建议，LR-3/4 后重定" |
| 烟花经济（现状约 1 发/秒） | LR-3 能量管理、LR-4 走廊捷径 | 不作验收判据，列为待优化 |
| F-01（keepDistance） | 不受批次影响（地面跟随语义） | 照常由用户定语义 |

不受批次影响、阶段 0 照常验收：L-04 至 L-08、L-10；M-01 至 M-10；B-01 至 B-10；V-01 至 V-10；C 类 RS。

提示：Step 0 的"构建 + 双 jar 版本"锚点在这批之前尤其重要；若 M/B/V 顺延进阶段 1 空档，取证要按当时的 jar 版本重新登记（OV-1/TG-3 会升版本）。
