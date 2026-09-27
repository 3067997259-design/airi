# 鞘翅飞行闭环执行文件

日期：2026-09-20。状态：R0 PASS、R1 PASS（均离线）；R2a PASS（真机门通过）；R2b PASS（真机门通过）；R3 PASS（通道模式真机闭环，落地精度留 R4，见 [R3-20260920-01](./evidence/elytra-flight-control-20260920/R3-20260920-01/verdict.md)）；R4 IN-PROGRESS（进近门与正式验收器具已实现并自检，正式批次待目标可达与碰撞清零，见 [R4-20260920-01](./evidence/elytra-flight-control-20260920/R4-20260920-01/verdict.md)）。当前批次：R4。

R0/R1 证据：[evidence/elytra-flight-control-20260920/R0-20260920-01/](./evidence/elytra-flight-control-20260920/R0-20260920-01/verdict.md)。R1 交付了 `corridor.ts` 的 `planSpaceRoute`（块尺度三维 A*）与 `low-route.ts` 的分块读取重写（`path` 有序输出、`local` 前沿标记、`search_budget` 类型化拒绝）；两个 R0 反例转绿，八场景边界测试齐备，离线套件 928/1。

R2a 离线交付（2026-09-20）：客户端 `flight/FlightController`（同 tick 观测、通道契约幂等/代次拒绝/类型化终止、烟花 opId 去重、600 tick 轨迹环）+ `FlightHandlers` 五条 RPC（flight.observe/submit/status/revoke/boost）+ tools.ts 目录 + BotController tick 接线。真机门（同日，栈拉起 + 0.2.34 部署后）通过：同 tick 观测对齐、起飞烟花交接、重复点火与旧代次拒绝、起飞宏三行为回归，记录于 [R0 verdict 的 R2a 段](./evidence/elytra-flight-control-20260920/R0-20260920-01/verdict.md)。R2b 预留：FlightController 明确零输入写入。

设计依据：[飞行闭环修订方案](./elytra-flight-control-revision.md)。领域依据：[鞘翅导航设计](./elytra-navigation-design.md)、[能力深化验收清单](./capability-deepening-acceptance-checklist.md)。本文件负责实施顺序、交付物与完成门；不改动其他能力线的排序。

本轮交付仅为执行文件。后续执行从 R0 开始，不能将本文的勾选框或目标当作已实现状态。

## 1. 目标与边界

在固定 Minecraft 1.21.1 测试实例中，让 AIRI 从真实起飞状态沿已验证通道飞行，进入指定洞口，并在目标平台真实落地。

任务必须分别证明空间连通、运动可行、输入实际执行和目标到达。仅有 A* 路线、模型预测、工具成功响应或测试进程退出码，都不能单独证明飞行成功。

首轮范围为单程飞行。跟飞消费者需要回归保护，但本轮不扩展跟飞功能。其他 Minecraft 版本、其他运动模组组合和未知烟花条件不继承本轮验收结论。

执行纪律：

- 保留用户已有修改和证据。不要运行 `reset`、`clean`、自动 `stash`，不要删除或改写旧 JSONL。
- 按仓库指令，实施期间不创建 Git 提交。交付以工作区修改、验证结果和证据为准。
- 搜索现有实现后再新增模块。复用所属领域的契约，不另建通用 A*、第二个输入仲裁器或第二套任务身份。
- 修改测试前加载 `enforce-rules-for-vitest`；修改文档、代码注释时使用 `simple-english`；执行 pnpm 命令时使用 `pnpm`。涉及 Eventa 契约时加载 `eventa`。
- 需要新增外部依赖时，先研究候选并让用户参与选择。本文不选定新增依赖。
- 不把构建产物直接覆盖进正在运行的实例。部署前结束本测试飞行会话，记录旧、新产物摘要，再重启所需测试进程。
- 权限不足时使用工具的正常提权机制，不通过其他工具绕过工作区边界。

## 2. 接手基线

以下状态于 2026-09-20 读取。开始执行时必须重新核对，发生变化则在 R0 记录差异。

| 项目 | 已知状态 |
| --- | --- |
| AIRI 工作区 | `D:\airi` |
| AIRI HEAD | `f0dc80208fa7150389ee4a5fefe456d925428c72` |
| 已提交相关成果 | `73ad7f4c7`、`0787a305b`、`f0dc80208` |
| MCPFabric 工作区 | `D:\mcpfabric` |
| MCPFabric HEAD | `274ce412a7be5767d33cbab1f45a24404736478d`，读取时工作区干净 |
| 目标游戏版本 | 1.21.1；启动器、加载器、模组组合和当前 jar 摘要仍需实读 |
| 当前构建默认版本 | Stonecutter active 为 1.21.8；必须显式构建 `:1.21.1:build` |
| 历史测试场地 | 起点 `(-1007, 74, 79)`；目标 `(-843, 65, -266)`；执行前核对世界与平台 |
| 历史 MCP 地址 | 客户端 `http://127.0.0.1:25600/mcp`；服务端 `http://127.0.0.1:25602/mcp` |
| 栈与库存 | 用户曾报告栈存活、烟花约 620；本文件未重新探测，不能当作当前事实 |
| 最近低航路单测 | 22/22 通过；另用内存场景复现薄墙漏检和扩宽窗口丢失目标层 |
| 最近桌面类型检查 | `pnpm -F @proj-airi/stage-tamagotchi typecheck` 通过 |
| 根级类型命令 | `pnpm type-check` 不存在；实际根脚本为 `pnpm typecheck` |
| 全仓 lint | 已有 9 个证据 JSON 缺末尾换行；另有警告。保留结果，不将失败标为通过 |

当前 10 个已跟踪文件有未提交修改：

- `game-host/flight/`：`live-corridor.test.ts`、`live-port.test.ts`、`low-route.test.ts`、`low-route.ts`、`profile.ts`。
- `game-host/movement/`：`air-track.test.ts`、`e02-route.integration.test.ts`、`elytra.test.ts`、`elytra.ts`。
- `apps/stage-tamagotchi/src/shared/eventa/game-host.ts`。

这里的 `game-host/` 指 `apps/stage-tamagotchi/src/main/services/airi/game-host/`。

R2b 修复批（2026-09-20）在 MCPFabric 侧新增修改：`gradle.properties`（0.2.34→0.2.35）、`src/main/java/dev/mcpfabric/bridge/RpcRouter.java`、`src/client/java/dev/mcpfabric/client/ClientControlGuard.java`、`src/client/java/dev/mcpfabric/client/BotController.java`、`src/client/java/dev/mcpfabric/client/handlers/FlightHandlers.java`、`src/client/java/dev/mcpfabric/client/flight/`（未跟踪）、`mcp-server/src/tools.ts`；证据见 [R2b-20260920-02](./evidence/elytra-flight-control-20260920/R2b-20260920-02/verdict.md)。

未跟踪内容还包括 `botclass24.txt`、修订方案，以及 `flight-venue-20260918` 下 bandhold、bandinit、emergency-sup、heuristic、lead-descent、rollout-off、unconditional-anchor 七批 JSONL。R0 保存实际清单，不只依赖本段。

处理未提交修改的原则：开关拆分保留为诊断能力；领降、带保持与紧急抑制按实验代码处理。新闭环接管后，移除被替代的旧决策，不能继续叠加多个高度或输入所有者。

## 3. 批次顺序与状态

顺序为 `R0 → R1 → R2a → R2b → R3 → R4`。批次门未通过时，修复当前批次。独立文档与离线分析可以继续，但不能提前宣称下游通过。

| 批次 | 目的 | 状态 | 进入条件 |
| --- | --- | --- | --- |
| R0 | 保存基线、复现缺陷、修正诊断工具 | **PASS**（R0-20260920-01，离线） | 接手基线已读取 |
| R1 | 地图覆盖与完整三维通道 | **PASS**（R0-20260920-01，离线固定地图） | R0 完成 |
| R2a | 客户端观测、推进交接、控制契约 | **PASS**（真机门 2026-09-20：tick 对齐/烟花交接/去重与旧代次拒绝/launch 宏三行为回归；限制记录于 verdict） | R1 完成，Java 构建与测试实例可用 |
| R2b | 简单通道上的逐 tick 驾驶 | **PASS**（2026-09-20 真机：`channel_complete` 终点 3.99 格、停顿样本 92、游标滞后 1、点火 2；诊断与修复见 [R2b-20260920-02](./evidence/elytra-flight-control-20260920/R2b-20260920-02/verdict.md)；遗留：交叉回放、推进剩余量补测、手写通道非 R1 生成） | R2a 完成 |
| R3 | 主进程航路与客户端驾驶闭环 | **PASS**（2026-09-20 真机：通道提交/回执/前缀校验/禁区重规划/前沿续飞/落地段全部以 ID 与 tick 串联；短目标运行 `channel_complete` + 落地 2.1 格，长河道运行 `channel_complete` + 落地 18.7 格。遗留：落地精度（R4）、客户端碰撞伤害、TS/Java 交叉回放。见 [R3-20260920-01](./evidence/elytra-flight-control-20260920/R3-20260920-01/verdict.md)） | R1、R2b 完成 |
| R4 | 洞内进近与整程验收 | **IN-PROGRESS**：进近入口门（方向/净空/速度/滑翔余量，80 格仅候选触发）与冻结验收配置 + 12 项正式断言 + 停批规则已实现并真机自检；正式 20 次/场景批次未启动（目标洞穴平台尚不可达、落点精度 2.1–18.7 格、客户端碰撞掉血未清零）。见 [R4-20260920-01](./evidence/elytra-flight-control-20260920/R4-20260920-01/verdict.md) | R3 完成，正式门槛已冻结 |

R3 批次（2026-09-20，零提交）：宿主侧新增 `flight/channel.ts` 通道执行器、`port.ts`/`host-port.ts` 通道面与状态枚举归一、`low-route.ts` 的 `exclude`、`elytra.ts` 巡航段双模式（通道模式 + 遗留模式）与 `VehicleMoveResult.channel`；客户端修复 0.2.36（拒绝不写幂等记忆）与 0.2.37（应用后落地即 `touchdown`）。真机 12 次运行按因果链暴露并修掉：状态大小写导致终局不可达、前缀比较角色错配、本地前沿完成被当到达、落地后停滞重规划再起飞、主进程未自证 glider 停止滑翔。

R2b 修复批（2026-09-20，零提交）：控制生命周期（`flight.submit` 续期心跳、看门狗跳过活动通道、`terminateIfActive` 统一终止、宏失败即结束、准备阶段 deadline、宏交接后才驱动、`control_busy` 单写入者、起飞方向取首航路点）与确定性驾驶（首航路点、yaw −90° 转换、终态不写默认姿态、推进与点火冷却交接、entryReach 采用、环内点火记录、模拟预算）。真机（部署 0.2.35 后）：两次运行，第二次全门 PASS；第一次的产品阻断已解除，FAIL 来自脚本门与手写路径。证据与遗留见 [R2b-20260920-02 verdict](./evidence/elytra-flight-control-20260920/R2b-20260920-02/verdict.md)。

状态只使用 `NOT-RUN`、`IN-PROGRESS`、`PASS`、`FAIL`、`BLOCKED`。只有外部前置缺失才记 BLOCKED。缺代码、缺测试或观察到错误属于未完成或 FAIL。

## 4. R0：基线与可重复证据

修改范围：现有测试、诊断日志、证据目录。此批不修改飞行算法。

- [ ] 保存两仓 HEAD、已跟踪补丁及未跟踪文件清单；保存将要替换文件的原始版本。补丁和副本不得包含凭据。
- [ ] 建立本轮独立证据目录：`docs/fork/evidence/elytra-flight-control-<实际日期>/<唯一批次号>/`。拒绝复用已存在的批次号。
- [ ] 记录游戏版本、加载器、模组组合、实际 jar 与 MCP 构建摘要、世界标识、角色 UUID、维度、配置开关及物理档案版本。未实读字段标为未知。
- [ ] 在 `low-route.test.ts` 通过生产 `planLowRoute` 边界新增失败复现：完整 `z=6` 薄墙、采样点 `z=4/8`；斜向平地从半宽 4 扩为 16 后目标层丢失。先保存失败结果，再进行 R1 修复。
- [ ] 固定完整路径消费的回归场景：弯道存在，起点直连末端穿墙，控制方必须保留路径顺序。R0 保存输入与期望，R1 验证路径本身，R3 接入实际控制断言；不要只断言规划器返回了若干点。
- [ ] 区分扫描候选高度、实际选定输入与实际应用时刻。不能再用 `cruise band raised` 推断调用方采用了抬带。
- [ ] 修正 `e02-route.integration.test.ts` 的证据生命周期：唯一输出、拒绝覆盖、异常时仍保存已有记录，采样器与会话在 `finally` 收尾。
- [ ] 将诊断模式和正式验收模式分开。现有 `expect(result.status).toBeTruthy()` 只证明返回结果；正式模式必须断言真实到达条件。模式与配置写入输出，不能靠文件名猜测。
- [ ] 记录已知检查失败、实际通过数和被跳过项目。历史 `918/3` 不能替代本批运行结果。

完成门：两个已确认反例可重复失败；旧证据未改写；新诊断运行不会覆盖证据；完整路径断言有明确失败原因。R0 不要求已经具备客户端逐 tick 记录，该能力由 R2a 交付。

交付：`manifest.json`、`baseline.md`、失败复现日志、改动清单。人工可读报告可以使用 Markdown；运行记录使用 JSON/JSONL。

## 5. R1：地图覆盖与三维通道

修改边界：`movement/observation.ts`、`region.ts`、`host-port.ts`、`snapshot.ts`，以及 `flight/corridor.ts`、`contracts.ts`、`low-route.ts` 和对应测试。只改实际需要的拥有者。

- [ ] 统一保留六态覆盖、世界绑定、时间来源、碰撞形状及精确性。缺失形状不等于空碰撞盒。
- [ ] 使用有界三维分块读取与缓存。请求闭区间体积逐次核对；总格数、请求数、缓存和耗时另有预算。
- [ ] 扩大横向时保留必要高度。预算不足返回具体原因；不裁掉目标高度后报告无路。
- [ ] 从目标所在空气区域选择终点。未加载目标只允许规划已知空间中的局部前沿，不能声称已连通终点。
- [ ] 支持同一水平位置上的多个空气区域，允许途中爬升、下降。自由飞行区域不要求附近存在地面。
- [ ] 在已有走廊搜索职责内实现有界三维搜索。遇到窄通道细化；保留节点、时间和读取上限。
- [ ] 检查每条连接的全部空间、身体净空和起点接入。斜向切角、简化折线、区域合并均重新验证。
- [ ] 输出有序区域、入口、地图版本、覆盖范围和终端条件。禁止将结果缩为最远一个坐标与全程 `bandY`。
- [ ] 将目标空气槽选择整合进通道规划；明确旧低航路在迁移中的调用方，避免两个规划器互相覆盖结论。

完成门：R0 两个反例转绿；密封洞、弯河、多层屋顶、先升后降、开阔无地面空间、斜向窄缝、未加载与截断场景均有生产边界测试。完整通道逐边检查通过，局部路线与全程路线可区分。

交付：固定地图夹具、可重复的规划结果、搜索规模与耗时记录、覆盖/预算报告。此批用固定地图完成，不消耗飞行烟花。

## 6. R2a：客户端观测与控制交接

修改边界：MCPFabric 客户端飞行模块、`BotController` 接线、客户端 handler 与 `mcp-server/src/tools.ts`；AIRI 的领域契约与端口。模块命名遵循各仓已有语言惯例，避免继续把所有逻辑塞进 `BotController`。

- [ ] 在游戏线程采集同一 tick、同一更新阶段的位置、速度、姿态、滑翔状态、碰撞盒、装备及推进状态。
- [ ] 明确“观测前/后、输入应用前/后、物理更新前/后”的阶段关系，保存真实 tick 编号。
- [ ] 起飞交给巡航时保留当前速度与推进剩余状态。不能用主进程首次观测时间冒充烟花点火时间。
- [ ] 精确推进状态不可读时，记录经源码与实测支持的范围。对未知烟花种类明确拒绝或使用已验证的保守模型，不能静默套用固定 35 tick。
- [ ] 定义通道提交、状态读取与撤销契约，复用命令身份、输入会话、代次与目标修订。区分“已接受”和“已开始应用”。
- [ ] 为烟花操作去重。重复请求、超时重试、旧序列和旧会话均不能再次点火。
- [ ] 实现有界的客户端轨迹记录缓冲，批量读取；记录丢失时显式报告，不把不完整记录标为完整。
- [ ] 覆盖暂停恢复、死亡、切维度、断线、租约过期和控制权转移。旧结果不能重新启动飞行。

完成门：真实客户端输出可对齐的 tick 记录；起飞烟花交接可追溯；重复点火与旧会话拒绝验证通过；原起飞宏的成功、取消和无烟花行为没有回归。

交付：字段契约、客户端构建摘要、真实观测样本、交接/去重/撤销报告。Java 构建通过只证明编译；行为通过真实客户端记录及 Vitest 回放核对，不用空测试任务充当验证。

## 7. R2b：简单通道上的逐 tick 驾驶

前置：只使用 R1 验证过的简单地图与通道。先做直线、下降和宽转弯，再进入复杂场地。

- [ ] 客户端飞行会话拥有唯一 yaw、pitch、烟花写入权。主进程及旧驱动不得同时写相同输入。
- [ ] 复用现有 Minecraft 动力学语义生成有限候选，验证实际速度向量和推进持续状态。
- [ ] 采用完整碰撞盒扫掠。未知空间、碰撞与资源不足为硬拒绝条件，不能被接近目标的奖励抵消。
- [ ] 沿通道入口次序推进。前视点只能跨过已验证可直达的路径段，不能隔墙切弯。
- [ ] 在客户端落实每段 1–2 tick 的实际执行期限，按实测状态更新。限制候选数、模拟步数和耗时。
- [ ] 后台计算只读不可变快照；应用前检查绑定、版本、年龄与起始状态偏差。客户端 tick 不等待网络。
- [ ] TS 与 Java 使用同一批输入和物理档案做交叉回放，再与真实游戏记录对照。
- [ ] 补测陡降、连续转向、起飞瞬态和不同推进剩余量。原 E-01 小残差不自动覆盖新增动作范围。
- [ ] 验证主进程读取延迟和 MCP 中断不会延长输入前缀或重复点火。记录执行间隔与客户端计算耗时。

完成门：简单通道的轨迹跟随通过；执行 tick 与日志声明一致；候选失败有明确结局；没有主进程逐次 RPC 驾驶的隐藏路径。模型误差与可用范围有实测记录。

## 8. R3：通道与驾驶闭环

修改边界：`movement/elytra.ts`、`flight/live-port.ts`、`live-corridor.ts`、生命周期及必要的主机接线；客户端通道接收与后备轨迹。

- [ ] 将主进程收敛为任务编排、地图更新、通道交换与回执核对。旧 `look/useItem` 巡航写入退出新模式。
- [ ] 异步规划绑定任务与地图版本；晚到结果不能覆盖新结果。新通道只有在客户端确认可接入后才生效。
- [ ] 在每个被执行前缀末端验证后续路径。维护能接入恢复或落地终端的轨迹与资源预算。
- [ ] 对地图失效、计算超时、读失败采用明确策略。只能使用仍有效的剩余前缀；不能持有旧 pitch 无限等待，也不能直飞未知终点。
- [ ] 去掉用 `lowRouteUsed` 历史布尔值决定当前安全响应的分支。当前有效性由通道、状态、版本与期限共同决定。
- [ ] 客户端新鲜碰撞信息可以拒绝服务端旧地图；拒绝返回主机后使对应区域失效并重新规划。
- [ ] 覆盖主路径和后备同时失效的结果。诚实报告无法验证安全收尾，不冒充目标成功。
- [ ] 用绕岸、先升后降、低顶棚和局部目标未加载四类夹具验证集成。
- [ ] 回归共享消费者：跟飞、取消、单写入者、世界隔离和命令回执。不要为修复单程飞行改变这些外部语义。

完成门：地图、路线与实际执行能以 ID 和 tick 串联；故障注入能有界收尾；无未验证空间的静默直飞；完整路径未在任何桥接层被丢弃。

## 9. R4：洞内进近与正式验收

- [ ] 将进近入口定义为有方向、净空与速度条件的区域。距离终点 80 格只可作为候选触发，不构成切换许可。
- [ ] 将洞口转向、下降、拉平和接地接入同一通道约束。复飞同样需要经过验证的空间与资源。
- [ ] 正式模式断言目标平台、三维位置、实际接地、残余速度及正确世界绑定。洞顶、应急平台和落水不得报告目标成功。
- [ ] 在正式运行前保存不可变的验收配置，包含平台区域、位置/速度容差、稳定接地时长、健康要求、时限和资源上限。
- [ ] 首轮位置容差沿用现有水平 2 格，补充垂直与实际支撑面验证。其余数值由 R2/R3 诊断数据确定，写入配置后再开始正式批次，禁止用缺失值或宽松默认值执行。
- [ ] 普通目标到达用例要求无死亡、无错误成功和无地形碰撞伤害；故障注入用例按预先声明的拒绝或收尾结果判定，不要求到达原目标。
- [ ] 每类正式场景至少 20 次，起始位置、速度、朝向和推进状态按预定清单变化。保留每次结果与完整分母。
- [ ] 同一构建发生碰撞、死亡、假成功或会话隔离失败时，停止该正式批次并保存失败，不继续刷成功次数。修复后使用新批次号重新验收。
- [ ] 对迟到更新、重复消息、读取截断、网络中断、服务器纠正、进近取消和暂停恢复分别执行故障用例。

完成门：每项正式场景的所有有效运行满足冻结判据；失败和无效运行单列，不能删去。无效运行必须有环境证据；碰撞或不可达不能改记为无效。目标洞内接地证据与回执一致。

交付：逐次结果、汇总表、失败轨迹、适用范围与剩余限制。只报告固定版本与场景的验收结果。

## 10. 命令与运行边界

下面是执行时使用的命令，不表示本文件编写期间运行过这些实施批次。

### AIRI 离线验证

工作目录 `D:\airi`。使用明确的 node 配置，避免重复跑 browser 项目。

```powershell
pnpm exec vitest run --config apps/stage-tamagotchi/vitest.node.config.ts src/main/services/airi/game-host/flight/low-route.test.ts
```

R1–R4 的离线回归扩大到 game-host，并显式排除两个现有真机入口。新增真机测试必须同步更新排除清单，不能只依赖环境变量为空。

```powershell
pnpm exec vitest run --config apps/stage-tamagotchi/vitest.node.config.ts src/main/services/airi/game-host --exclude '**/e02-route.integration.test.ts' --exclude '**/elytra-live.integration.test.ts'
pnpm -F @proj-airi/stage-tamagotchi typecheck
pnpm lint
```

按仓库要求记录 `pnpm type-check` 的结果；当前仓库该命令缺失，使用现有 `typecheck` 脚本完成实际验证，不改脚本或 tsconfig 来隐藏问题。跨包类型契约变更时再运行根级 `pnpm typecheck`。

现有 lint 阻塞位于 `docs/fork/evidence/ov5-elytra-launch-20260918/` 的九个 JSON。新改动必须没有新增 lint 问题；整仓状态继续如实记为 FAIL，直到这些阻塞实际消除。

### MCPFabric 构建

工作目录 `D:\mcpfabric`。不要使用默认 active 版本构建目标夹具。

```powershell
.\gradlew.bat :1.21.1:build
```

工作目录 `D:\mcpfabric\mcp-server`。

```powershell
npm run typecheck
npm run build
```

保存所选运行 jar 的 SHA-256 与路径；不要把 sources jar 或其他游戏版本产物部署到夹具。核对实际进程加载的新构建后，才能记录真机结果。

### 峡谷真机运行

只有 R3 通过、R0 诊断工具修复完成、会话/实例检查完成后，才使用该入口运行新闭环。必须先更新 harness 使其调用新客户端驾驶，不能让旧 `runElytraMove` 的内部路径冒充新实现。

历史入口及环境变量如下。客户端/服务端地址、角色与世界均需先实读核对。凭据使用已有本地配置，不写进文档或证据。

```powershell
$env:MCPFABRIC_URL = 'http://127.0.0.1:25600/mcp'
$env:MCPFABRIC_SERVER_URL = 'http://127.0.0.1:25602/mcp'
$env:E02_RUNS = '1'
$env:E02_START = '-1007,74,79'
$env:E02_GOAL = '-843,65,-266'
$env:E02_BUDGET_MS = '150000'
$flightBatchStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$flightEvidenceFile = Join-Path 'docs/fork/evidence' "elytra-flight-control-$flightBatchStamp/diagnostic.jsonl"
if (Test-Path -LiteralPath $flightEvidenceFile) { throw 'Evidence file already exists' }
$env:E02_OUT = [System.IO.Path]::GetFullPath($flightEvidenceFile)
pnpm exec vitest run --config apps/stage-tamagotchi/vitest.node.config.ts src/main/services/airi/game-host/movement/e02-route.integration.test.ts
```

以上命令只演示一次诊断运行。R0/R3 新增的模式、驱动选择与验收配置入口由实现更新到本节，并写入每次 manifest。正式模式不能依赖旧 `E02_CALIBRATED` 的默认真值，必须匹配实测档案。

运行前核对真实健康、装备和库存；不要依据旧清单补给。记录补给动作，飞行开始后不自动治疗或补充烟花。诊断和正式运行均记录消耗，不设置无限自动重试。

## 11. 最小证据集合

每批目录至少包含：

| 文件 | 内容 |
| --- | --- |
| `manifest.json` | 两仓 HEAD 与工作区摘要、构建摘要、版本/模组、世界/角色、配置、模式、模型范围、时间 |
| `checks.md` | 实际命令、工作目录、退出码、测试数量、跳过项与已知阻塞 |
| `map.json` 或分块文件 | 读取边界、覆盖、形状、来源与各块时间；保留未知状态 |
| `routes.jsonl` | 路线 ID、版本、起止区域、入口、拒绝原因、预算使用 |
| `ticks.jsonl` | 客户端 tick 与阶段、真实状态、推进状态、选中输入、应用 tick、期限、通道及后备 ID |
| `runs.jsonl` | 每次起始条件、实际行为、终态、健康、耗时、资源、三维误差与证据引用 |
| `verdict.md` | 每项 PASS/FAIL/BLOCKED/NOT-RUN、证明范围、未满足项和下一步 |

R0/R1 尚无客户端 tick 记录时，明确记为 NOT-RUN，不制造空文件假装采集成功。报告的高度、速度、健康必须区分候选、预测与实际观测。

## 12. 收尾与交接模板

每批完成后更新本文件状态表和 [MODS.md](./MODS.md) 的批次记录。记录实际实现与证据，未实施计划不标为已交付能力。保留历史失败，移除被当前批次替代的临时旁路与失效注释。

交接必须回答：

1. 当前批次与状态，哪些完成门已经满足。
2. 两仓实际修改和构建摘要，运行实例是否已更新。
3. 测试、类型检查、lint、真机分别是什么结果。
4. 失败能否复现，证据放在哪里，是否有数据缺失。
5. 当前是否还有控制会话、后台采样器或部署操作未收尾。
6. 下一条具体工作及前置条件，不写笼统的“继续调参”。

接手者的第一条工作：读取本文件和实际 Git 状态，完成 R0 的基线保存与两个失败复现。不要直接开始完整峡谷飞行。
