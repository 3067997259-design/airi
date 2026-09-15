# MC-4e 规范：快速保命与进阶移动（阶段 5，P1/P2）

日期：2026-09-14。状态：实施完成（代码 + 单测 + 类型检查；真机验收未做）。上游：[玩家能力缺口](./minecraft-player-capability-gaps.md) §4.3、§3.2（激流属玩家移动）、§3.5（取消不等于松开）、§2 阶段 5 行、[MC 执行计划](./minecraft-player-capability-execution-plan.md) §6.5、[MC-3c 规范](./mc-3c-spec.md)（鞘翅）、[MC-4c 规范](./mc-4c-spec.md)、[MC-4d 规范](./mc-4d-spec.md)（激流暂不支持）。依赖：MC-3c ✓（鞘翅、炽足兽、载具）、MC-4a ✓（使用生命周期）、MC-4c ✓（反射抢占与命令身份）、MC-4d ✓（武器任务与 `unsupported_weapon_feature`）。模组基线 0.2.5。

通过条件（缺口文档原文）：受控高台自救；载具正常取得与起步；跨维度重新规划。

本批只交代码、单测、类型检查。真机验收（真实坠落落地水时机、水中/雨中激流、跨维度命令收敛）属后续批次。

## 范围与已做项

- **本批新增**：
  - 模组：落地水反射（坠落分支 + 一次自救）；`movement.riptide` 激流推进。
  - AIRI：维度切换按绑定变化处理；`game_riptide` 作为移动动作；`move_to` 分发文档化。
- **已由前批完成，本批不重做**：
  - 鞘翅飞行与着陆（`movement/elytra.ts`，MC-3c-2/3）。
  - 载具取得与起步（`movement/vehicle.ts` 的 boat/horse/minecart，MC-3b；炽足兽 `movement/strider.ts`，MC-3c-3）。
  - 弓/弩/普通投掷三叉戟（MC-4d）。激流三叉戟仍由 `game_shoot` 返回 `unsupported_weapon_feature` 并指向 `game_riptide`。

## D1 落地水反射（模组）

反射属于 `ReflexController`，与脱险/进食/防御共用 `game:reflex` 事件与合并窗口。新增配置 `reflex.waterLanding`（默认 `true`）与 `reflex.waterLandingMinFall`（默认 `6.0`，坠落距离下限）。

**触发条件（全部满足）**：

| 条件 | 读取 | 说明 |
| --- | --- | --- |
| 空中 | `!p.onGround()` | 已落地不给最后一次机会 |
| 未滑翔 | `!p.isFallFlying()` | 鞘翅有独立着陆契约 |
| 不在水/熔岩 | `!p.isInWater() && !p.isInLava()` | 已是安全落点，不需要放水 |
| 下落速度 | `p.getDeltaMovement().y < -0.5` | 仅上升/滞空不触发 |
| 坠落距离 | `p.fallDistance >= reflex.waterLandingMinFall` | 读取原版 `fallDistance` |
| 本次坠落未尝试 | `!waterLandingAttempted` | 一次坠落一次尝试 |

**动作**：
1. 记录 `currentNavigationCommandId()`，调用 `clearAll("reflex_preempted")` 取得输入所有权并回显 `preemptedCommandId`（与脱险/进食同款抢占）。
2. 快捷栏 0-8 找 `minecraft:water_bucket`；没有则主背包 9-35 找一份，用与自动进食相同的容器 `PICKUP` 点击移入首个空快捷栏槽；无空槽即失败 `no_water_bucket`。
3. 选中该槽，视角竖直向下（pitch 90）。
4. 在有界窗口（`WATER_LANDING_MAX_TICKS = 60`）内每 tick 调用一次 `gameMode.useItem(MAIN_HAND)`；水桶被消耗（主手不再持水桶）即视为已放置。窗口结束仍未放置记 `placement_failed`。
5. 记录 `fallDistanceBefore`（触发时）与 `fallDistanceAfter`（落地/窗口结束时），事件 `cause=hazard`、`action=water_landed`、`reason`（未成功时）、`slot`。
6. 落地（`onGround`/`isInWater`/`isInLava`）或窗口结束后退出，重置 `waterLandingAttempted` 只在“回到可站立状态”时进行。

**所有权与边界**：
- 反射在 `IDLE` 状态下、脱险之后判定；触发即抢占，因此不会与武器任务或显式命令**并发**持有输入（`clearAll` 同时终止导航与武器任务，`releaseUseRequested` 保证下一 tick 释放使用键）。
- 一次坠落只尝试一次；不承诺“已安全”，只回报观察到的落点与前后坠落距离（缺口 §4.3：不能把清空按键写成已经安全停住）。
- 收水不在本批范围；危险未结束时不得提前触发。

## D2 激流（模组 `movement.riptide`）

**归属选择**：激流是玩家移动，不是发射物（缺口 §3.2）。因此不复用 `combat.*` 武器任务，而新增独立移动任务 `BotController` 的 riptide 阶段机 + `handlers/MovementHandlers.java`。理由：武器契约以“投射物 UUID、发射序号、命中归属”为核心，激流没有投射物；把它塞进 `combat` 会强迫它伪造投射物语义。

**前置条件（客户端侧先核对，任一不满足即终态 `riptide_unavailable` 并给出 `unmet`）**：

| 条件 | 读取 | `unmet` |
| --- | --- | --- |
| 手持或背包有带 `minecraft:riptide` 的三叉戟 | `ItemStack.getEnchantments()` holder key | `no_riptide_trident` |
| 处于水中或雨中 | `p.isInWaterOrRain()` | `not_in_water_or_rain` |

`startRiptide` 选三叉戟（快捷栏→主背包移入空快捷栏槽）、瞄准目标点、记录耐久，进入 `CHARGING`。`CHARGING` 期间条件失效则走中止路径（`stopUsingItem`，**不发射**）并终态 `riptide_unavailable`；`p.getTicksUsingItem() >= 12` 时调用 `releaseUsingItem`（正常释放，产生推进），记录释放后耐久，进入 `FLYING`。`FLYING` 跟踪玩家位置，速度稳定（`|motion| < 0.05` 且落地/入水）或超时（100 tick）后终态。

**状态与回执**：

```
movement.riptide       { targetX, targetY, targetZ } -> { state, endReason, unmet?, from?, to?, displacement?, distance?, durabilityBefore?, durabilityAfter?, ticks }
movement.riptideStatus {}
movement.riptideCancel {}
```

- `state ∈ idle|running|done|cancelled`；`endReason ∈ launched|timeout|riptide_unavailable|cancelled|no_player`。
- **无投射物 UUID、无发射序号**：回执只给位移、距离、耐久与结束原因。
- 取消语义：`riptideCancel` 用 `stopUsingItem` 中止蓄力，不触发 release；`combat.cancel` 也会中止在飞的激流蓄力（AIRI 的既有停止路径），`clearAll` 在死亡/断线/世界退出/心跳超时时同样中止。

## D3 维度切换按绑定变化处理（AIRI）

世界身份缓存（`worldIdentity`，连接时由 `get_status` + `get_self` 建立）新增维度参与绑定比较。

- **绑定检查**：`GameBinding` 增可选 `dimension`；`assertCurrentBinding` 在 `binding.dimension` 存在且与信封 `dimension` 不同时抛 `StaleGameBindingError`（错误体补 `requiredDimension`/`currentDimension`）。旧维度的信封在新维度下被拒绝为 `stale_binding`。
- **在线检测**：每次新鲜 `get_self`（`readFreshSnapshot`）比较 `dimension` 与缓存值。不同即视为绑定变化：
  1. 用新维度刷新 `worldIdentity`（**不递增**连接代次：连接未变，只有世界绑定变了）；
  2. 调用注册表 `stopActive("dimension_changed")` 终止在跑写命令（执行器的 stop 路径照常释放输入），回执终态 `cancelled`/`dimension_changed`，不声称成功；
  3. 清空世界缓存 `lastReceipt`（`game_status` 不得把旧世界回执当成当前事实）；移动在飞循环经 `stopRequested` 收敛；
  4. 已终止的旧命令不回放；新命令在 `executeDomainCommand` 用刷新后的 `worldIdentity.dimension` 生成信封，绑定到新维度。
- 终态回执继续携带**签发时**的 `dimension`（既有行为），因此旧世界的事实不会被读成新世界的事实。

## D4 AIRI 领域动作与回执

新增动作 `riptide`，参数 `{ x, y, z, tolerance? }`（默认 2，范围 0.5–8）。

回执 `riptide`：

```
{
  from?, to?, displacement?, distance?,
  durabilityBefore?, durabilityAfter?,
  endReason
}
```

执行器：调 `riptide` 工具（写）→ 前置失败直接返回 `riptide_unavailable`；否则轮询 `riptide_status` 至终态或租约结束；`stopRequested` 时调 `riptide_cancel`（既有的 `combat_cancel` 亦会中止蓄力），回执 `cancelled`。结束用新鲜 `get_self` 距离核对（与 `move_to` 相同的 `distance` 后置条件）：在 `tolerance` 内记成功，否则 `not_confirmed`。

类型化失败：`riptide_unavailable`、`not_confirmed`、`cancelled`。**不产生任何投射物或射击声明**。

## D5 工具面与期限

- `command-registry.ts`：`riptide` 进 `WRITE_ACTIONS`；回执行段在 `settle`、`beginExecution` 与结果装配处透传；新增 `stopActive(endReason)` 用于绑定变化终止。
- 期限：`riptide` 30s。
- `command-contract.ts`：`riptide` 动作/参数、`GameRiptideReceipt`、`evaluateGamePostCondition('riptide')` 的 `distance`。
- `DOMAIN_TOOLS` 增 `game_riptide`；`toGameCommandParams` 增 `riptide` 映射；`coding-host/game-bridge-tools.ts` 增 `game_riptide`；`shared/eventa/game-host.ts` 同步动作、结果形状与后置条件说明。
- mcp-server `tools.ts`：增 `riptide`（写，映射 `movement.riptide`）、`riptide_status`（读）、`riptide_cancel`（写）。

## D6 移动模式注册表

`move_to` 的分发保持现状并文档化：`runVehicleMove` 本身即载具注册表（`boat|horse|minecart|elytra|strider` 的 switch），`executeTerrainMoveTo` 负责“载具 vs 徒步”选择与 `fallbackToFoot`。目标形状统一为 `{x,y,z,tolerance}`，再包一层按 mover 命名的注册表只会包住同一个 switch，属于浅模块；因此本批只补注释、不新增抽象。激流不是 `move_to` 的一种，走独立 `riptide` 动作，不塞进该 switch。

## 单测验收清单

- 维度切换：在跑写命令因维度变化终止为 `dimension_changed`，不声称成功；切换后新命令绑定新维度并成功；旧维度信封被 `StaleGameBindingError` 拒绝。
- 绑定：`getBinding().dimension` 与信封维度不一致即拒；一致或未设置维度时不受影响。
- 激流：成功路径用新鲜读取核对距离并回执位移/耐久；条件不满足 `riptide_unavailable` 且不调用 `riptide`；取消走 `riptide_cancel`（`combat_cancel` 同样中止蓄力），无“幻影发射”。
- 现有 `game-host`、`coding-host` 用例保持通过（桥工具清单同步）。
- 模组 `:1.21.1:build` 与 mcp-server `npm run build` 通过；`gradle.properties` 保持 0.2.5。

## 增量拆分

1. 模组：落地水反射（D1）+ 激流任务与 RPC（D2）+ mcp-server 工具（D5）。
2. AIRI：维度绑定与 `stopActive`（D3）、`riptide` 动作与执行器（D4/D5）、`move_to` 分发注释（D6）。
3. 单测（本批验收清单）。
4. 真机验收（未执行，属后续批次）。

## 实现落点

- 模组：`config/McpConfig.java`、`client/reflex/ReflexController.java`、`client/BotController.java`、`client/handlers/MovementHandlers.java`（新增）、`client/McpFabricClient.java`、`mcp-server/src/tools.ts`。`gradle.properties` 保持 0.2.5。
- AIRI：`game-host/command-contract.ts`、`game-host/command-registry.ts`、`game-host/index.ts`、`game-host/index.test.ts`、`game-host/command-registry.test.ts`、`shared/eventa/game-host.ts`、`coding-host/game-bridge-tools.ts`、`coding-host/game-bridge-tools.test.ts`。

## 风险与回退

- **落地水时机**：主进程不参与；窗口在模组逐 tick 内。坠落速度很快时水桶可能始终超出交互距离，届时记 `placement_failed`，不谎报已放水。
- **主背包水桶会动快捷栏**：只换入空槽；无空槽即失败，不丢任务物资（同 MC-4c 进食）。
- **激流条件客户端判定**：`isInWaterOrRain()` 与附魔读取都在客户端；条件在蓄力中失效改走中止，不发射。
- **维度切换不递增代次**：老命令靠维度绑定与 `stopActive` 收敛，回执保留签发维度；不重放、不迁移。
- **回退**：`riptide` 走独立域工具与写锁，不改 `move_to`/`shoot` 语义；`waterLanding` 可配置关闭。

## 明确不做

- 收水与后续保命编排（本批只做落地放水）。
- 下界顶棚高速航线（MC-3c 增量 4，默认关闭）。
- 载具取得与起步、鞘翅飞行（已在 MC-3b/MC-3c 完成）。
- 真机验收：本批只交代码、单测、类型检查。

## 实施记录

### 代码实施（2026-09-14）

- **模组（0.2.5 保持）**：
  - `McpConfig.ReflexConfig` 增 `waterLanding`（默认 true）与 `waterLandingMinFall`（默认 6.0）。
  - `ReflexController` 增 `WATER_LANDING` 模式与脱险/进食同款抢占：空中、未滑翔、不在水/熔岩、`motion.y < -0.5`、`fallDistance >= waterLandingMinFall` 且本次坠落未尝试时触发；快捷栏→主背包找水桶（主背包用容器 `PICKUP` 点击移入空快捷栏槽，方法泛化为 `moveMainStackToHotbar`），竖直向下，在有界窗口内逐 tick `gameMode.useItem` 直到水桶离手；落地或窗口结束发 `game:reflex` `cause=hazard`、`action=water_landed|failed`、`fallDistanceBefore`/`fallDistanceAfter`/`slot`；落地重置尝试标志。
  - `BotController` 增激流任务（`RiptidePhase`：`CHARGING`→`FLYING`）、`startRiptide`/`cancelRiptide`/`riptideStatusJson`/`isRiptideActive`；前置客户端条件（`isInWaterOrRain()` + 主手/背包 riptide 三叉戟附魔）失败即 `riptide_unavailable` 并给 `unmet`；蓄力中条件失效走 `stopUsingItem` 中止；`releaseUsingItem` 正常释放推进；飞行跟踪速度稳定或 100 tick 超时；记录释放前后耐久。`combat.cancel` 与 `clearAll` 一并中止在飞蓄力；`startCombat` 与 `startRiptide` 互斥。
  - 新增 `handlers/MovementHandlers.java`（`movement.riptide`/`riptideStatus`/`riptideCancel`）；`McpFabricClient` 注册。
  - mcp-server `tools.ts` 增 `riptide`（写）、`riptide_status`（读）、`riptide_cancel`（写）；`combat_cancel` 描述补“亦中止在飞激流”。
- **AIRI**：`command-contract.ts` 增 `riptide` 动作/参数、`GameRiptideReceipt` 与 `distance` 后置条件；`command-registry.ts` 增写动作、回执透传、`GameBinding.dimension` 绑定比较、`StaleGameBindingError` 维度字段与 `stopActive(endReason)`；`index.ts` 增 `game_riptide` 工具与执行器（调 `riptide`、轮询 `riptide_status`、取消走 `riptide_cancel`/`combat_cancel`、新鲜读取核对距离、`riptide_unavailable`/`not_confirmed`/`cancelled`）、`noteLiveDimension` 维度切换收敛、`move_to` 分发注释；`shared/eventa/game-host.ts` 同步动作与 `riptide` 结果形状；`game-bridge-tools.ts` 增 `game_riptide`。
- **偏离与取舍**：
  - **激流放独立 `movement.*`**：武器契约以投射物 UUID/发射序号/命中归属为核心，激流没有投射物；塞进 `combat` 会强迫它伪造投射物语义（D2）。
  - **落地水窗口内重试 useItem**：坠落很快时单次点击常超出交互距离；窗口内逐 tick 尝试直到水桶离手，属“一次坠落一次反射事件”；仍不承诺已安全（D1）。
  - **`combat.cancel` 兼作激流中止**：AIRI 既有停止路径只调 `combat_cancel`，故让它同时中止在飞激流蓄力；另提供 `riptide_cancel`。
  - **维度切换不递增代次**：连接未变，仅世界绑定变化；老命令靠维度绑定与 `stopActive` 收敛，回执保留签发维度，不清除命令身份（D3）。
  - **移动目录**：`move_to` 分发保持 `runVehicleMove` switch + 徒步分支，仅补注释（D6），不新增浅注册表。
- **检查**：
  - `pnpm -F @proj-airi/stage-tamagotchi exec vitest run src/main/services/airi/game-host` → 181 passed / 1 skipped（基线 175 passed / 1 skipped；新增 6 项：维度切换、激流三项、绑定拒斥、`stopActive`）。
  - `pnpm -F @proj-airi/stage-tamagotchi exec vitest run src/main/services/airi/coding-host` → 26 passed（4 files）。
  - `pnpm -F @proj-airi/stage-tamagotchi typecheck` → 退出 0。
  - `pnpm exec eslint <改动文件>` → 退出 0。
  - `D:\mcpfabric\mcp-server` `npm run build` → 成功。
  - `$env:JAVA_HOME='C:\Program Files\Java\jdk-21'; .\gradlew.bat :1.21.1:build` → BUILD SUCCESSFUL。
- **NOT-RUN**：真机验收（真实坠落落地水时机、水中/雨中激流与耐久、跨维度命令收敛、反射与武器任务抢占）。

### 真机验收（2026-09-14）— PASS

- 落地水：y88 自由落体 → 落点自动放水（85..87,75,-21..-23），无摔伤。
- 激流：水中（深水 y58 释放，位移 14.85 格）与雨中（客户端重连同步天气后，位移 14.66 格）；条件失败 `riptide_unavailable`（0 蓄力、不发射）。
- 维度切换：运行中 `move_to` 途中传入下界 → `cancelled / dimension_changed`，回执保留签发维度；绑定刷新、新维度命令可用、旧信封终止、回主世界后新命令成功。
- **验收中修复**：`stopActive` 在记录上保留类型化原因（快速返回的执行器不再把 `dimension_changed` 改写成 `cancelled`）。
- **限制**：客户端漏收天气事件时雨中判定失败（重连恢复）；反射与武器任务抢占未单独复测。
- 记录：[evidence/mc-4/live-acceptance-20260914.md](./evidence/mc-4/live-acceptance-20260914.md)。
