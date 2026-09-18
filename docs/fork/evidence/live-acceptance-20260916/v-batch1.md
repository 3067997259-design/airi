# CD-V 载具真机验收（2026-09-17，第一批）

环境：客户端 0.2.19 / 服务端 0.2.16 / AIRI 构建含本轮车回执（F-11）与挂载确认重试（F-12）。
场地：自建空中平台 (120,100,-60) 周围 51×51；水道 x110..130、z −59..−57，水深 2；测试铁轨 x110..126。
夹具靶标：`NoAI` 等 NBT；载具用 `summon minecraft:boat/minecart/horse`（注意 1.21.1 船实体 id 是 `minecraft:boat`，不是 `minecraft:oak_boat`）。

## 结果

| 编号 | 场景 | 结果 | 实际 |
| --- | --- | --- | --- |
| V-01a | 船：`existing` 取得 | **PARTIAL** | 找到并登上已有船（`acquireMethod: existing`、UUID 固定、阶段到 travel/dock）→ 行程 `route_unavailable`（"the boat did not make progress"），船对模组输入无响应（F-13） |
| V-01b | 船：`prepare_owned` | **FAIL** | 放置流程报告 `asset.location=vehicle` 但 `consumed=0`、世界无新船实体 → `not_controllable`（F-14） |
| V-03 | 水中央取消 | **PASS** | `cancelled`，`dismounted: false`，阶段到 dock/finish —— 保守取消成立（设计 §4/§7） |
| V-04a | 马：已驯服+装鞍+空闲（多名候选中） | **PASS** | 选到预期 UUID、`reached`、`dismounted: true`（F-12 修复后；修复前同一场景 `not_controllable`） |
| V-04b | 马：野生、未授权驯服 | **PASS** | `not_tamed`（`allowTame` 缺省拒绝），零耗材 |
| V-10a | 船：无材料 | **PASS** | `no_materials`，未放置、未消耗 |
| V-10b | 马：附近无马 | **PARTIAL** | 返回 `not_tamed` 而非 `vehicle_not_found`（夹具残留野生马），需清水后再测 |
| V-10c | 矿车：未供电轨道 | **PASS** | `rail_not_powered`（立即类型化，未等 30 秒——与设计 §6 一致） |
| V-06 | 矿车：带动力铁路行驶 | **BLOCKED（夹具）** | 供电轨需 `powered_rail[shape=east_west]` + 底部红石块；已用 `get_block` 验证供电状态（`powered=true`），行驶夹具待重跑 |
| V-08 | 悬空轨道终点 | **未跑** | 同上夹具 |

## 新发现

- **F-11（已修，本轮交付）**：载具行程回执（`VehicleReceipt`：取得方式/UUID/里程/停靠/是否下骑/阶段）被计算后**没有进入命令结果**——`settle` 的入参表与领域结果字段都缺 `vehicle`，领域侧只能看到 `reached` 布尔与 endReason。修复：`command-registry` 的 outcome/receipt/settle 三处 + `index.ts` 领域结果 + 共享契约 `GameDomainResult.vehicle`；新增索引级集成测试（脚本化船行程，断言回执与"不重复放置"）。
- **F-12（已修，本轮交付）**：挂载确认竞态。实测 `board_vehicle` 返回 `boarded=true` 后，`get_vehicle` 仍需 ~150–400 ms（下一客户端 tick）才报告 riding；宿主立即回读 → 真实成功的挂载被判 `not_controllable`（船、马、矿车全中）。修复：`confirmControl` 在有界尝试窗口内重试（8 次 × 100 ms），仍失败才判 `not_controllable`；回归测试用"前两次读不到、之后正常"的假端口覆盖。
- **F-13（新，阻塞船）：模组按键输入不驱动已乘船。** 实测：登船后 `set_movement {forward}` / `{forward,sprint}` / `{forward,left}` / `{left}` / `{jump}` 各 2 秒，船与玩家位置完全不变（船停在 (111.69,103.11,−57.50)；玩家 yaw 90 = 东，船朝向 90）。行走输入正常，说明按键通道本身有效；船的控制需要显式的玩家输入/划桨包（设计 §4 已提示"不能假定转动视角就等于转船"）。影响：V-01a 行程、V-02 水道、V-03 的"移动中取消"都无法成立。
- **F-14（新，阻塞 prepare_owned）：船放置不计耗材、不生成实体。** `asset: {itemId: minecraft:oak_boat, consumed: 0, recovered: 0, location: vehicle}` 且世界实体数 0→0 → 后续 `not_controllable`。需查模组 `use_item`/放置路径与水域瞄准条件。

## 与目标的关系

- 已有验收成立：V-03、V-04a、V-04b、V-10a、V-10c（5 项）；V-01a/V-01b 部分；V-06/V-08/V-10b 待重跑。
- V-01b/V-02（水道）被 F-13、F-14 阻塞；这两项都是**模组侧**修复，属 CD-V1/V2 的实现缺口，而非宿主逻辑。
- 证据：[v-batch1.json](./v-batch1.json)；诊断脚本 [v-diag.mjs](./v-diag.mjs)…[v-diag6.mjs](./v-diag6.mjs)（挂载时序、船输入矩阵、供电轨状态）。
