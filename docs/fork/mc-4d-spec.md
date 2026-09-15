# MC-4d 规范：基础远程战斗（阶段 4，P1）

日期：2026-09-14。状态：实施完成（代码 + 单测 + 类型检查；真机验收未做）。上游：[玩家能力缺口](./minecraft-player-capability-gaps.md) §3（3.1–3.7）与 §2 阶段 4 P1 行、[MC 执行计划](./minecraft-player-capability-execution-plan.md) §6.4、[MC-4a 规范](./mc-4a-spec.md)、[MC-4c 规范](./mc-4c-spec.md)。依赖：MC-4a ✓（使用生命周期 `start_using`/`release_using`/`stop_using`、物品状态 `charged`）、MC-4c ✓（反射抢占与命令身份）、MC-3c ✓（双端点事件轮询）。模组基线 0.2.5。

通过条件（缺口文档原文）：见[缺口文档][gaps] §3.7 的验收表。本批只交代码、单测、类型检查。真机验收（真实弓/弩/三叉戟、命中归属、多人补刀）属后续批次。

本批的硬约束来自缺口 §3.4：主进程轮询约 150–250ms，不能承担发射窗口；逐 tick 蓄力、瞄准与发射必须进客户端模组。缺口 §3.5：取消不能等同于松开右键。缺口 §3.6：`checked` 不表示命中，工具返回 `ok`、动画、库存差都不是命中证据。

## D1 武器任务契约（模组）

新增客户端逐 tick 武器任务，挂在 `BotController` 上（与导航任务同构：`start`/`status`/`stop` + `endReason`）。

- `combat.start { weapon, targetX, targetY, targetZ, targetUuid?, maxShots?, chargeTicks? }`
  - `weapon ∈ bow|crossbow|trident`；`maxShots` 默认 1、上限 16；`chargeTicks` 有界（弓默认 20，上限 200）。
  - 返回 `{ taskId, state, weapon }`，`state` 初值 `running`。
  - 开始前先做**前置检查**，任一失败即终态（不开始任何 `use`）：
    - 从主背包 9-35 或快捷栏 0-8 选武器（主背包物品按需用容器 PICKUP 点击换入空快捷栏槽再选中）。
    - 弹药：弓/弩需要背包里有箭（`minecraft:arrow`、`minecraft:tipped_arrow`、`minecraft:spectral_arrow` 之一）；三叉戟自身即武器。
    - 无武器 → 终态 `weapon_unavailable`；无弹药 → 终态 `no_ammo`。
- 逐 tick 阶段机（`BotController.onClientTick` 调用）：

| 武器 | 阶段流程 | 差异 |
| --- | --- | --- |
| 弓 | `select` → `aim` → `charge`（按住 use）→ `hold chargeTicks` → `release` → `track` | 释放产生投射物 |
| 弩 | `select` →（未 `charged` 时 `load`：一次 use + 等待 `charged`）→ `aim` → `fire`（第二次 use）→ `track` | 已装填跳过 load；load 与 fire 是两次 use |
| 三叉戟 | `select` → `aim` → `charge` → `release`（投出）→ `track` | 投出后进入回收跟踪 |

- 瞄准：面向目标点（用 `look_ahead` 式 yaw/pitch）。`targetUuid` 能解析到实体时，读取其 `getDeltaMovement()` 做**有界速度前置**（opt-in，默认关闭；`chargeTicks` 窗口内用当前速度线性外推，最多 3 格）。
- 发射后：在 `level.entitiesForRendering()` 中定位本次新生成、owner 为本玩家、type 匹配的投射物（`AbstractArrow`/`ThrownTrident`），记录 UUID 与单调递增发射序号 `shot`；达到 `maxShots` 后终态 `done`。
- 三叉戟回收：投出后跟踪投射物；物品回到背包（忠诚回返或拾取）记 `returned`；有界超时（默认 ~10s）报 `return_pending`；投射物消失且未回包报 `lost`。诚实报告，不声称已回收。

## D2 状态与回执（模组）

`combat.status` 返回 `{ state, weapon, shotsFired, projectileUuids: [], endReason, lastShot? }`：

- `state ∈ idle|running|done|cancelled`；`endReason` 为终态原因串（`done`/`cancelled`/`no_ammo`/`weapon_unavailable`/`target_lost`/`reflex_preempted`/`return_pending`/`lost`）。
- `shotsFired` 是实际发射序号计数；`projectileUuids` 是已记录投射物 UUID 列表；`lastShot` 为最近一发的 `{ shot, projectileUuid? }`。
- 任务保留在世界/连接代次内；`ClientControlGuard` 的 `clearAll` 一并终止武器任务（原因 `death`/`disconnected`/`world_exit`/`bridge_timeout`）。

## D3 取消语义（模组，缺口 §3.5）

`combat.cancel` 按状态走中止路径，绝不把取消当成松开右键：

| 取消时状态 | 中止路径 | 结果 |
| --- | --- | --- |
| 前置检查中/尚未开始 use | 只清武器任务，不装备、不发射 | `cancelled`，`shotsFired` 保留 |
| 弓/三叉戟正在蓄力 | `stopUsingItem()`（中止，不触发 release） | `cancelled`，无新增发射 |
| 弩正在装填 | 中止继续装填，随后重读实际 `charged` 状态并保留 | `cancelled`，不发射 |
| 弩已装填 | 保留实际装填状态，不发送发射操作 | `cancelled`，`shotsFired` 保留 |
| 投射物已经离开 | 停止后续射击；已发出投射物继续存在 | `cancelled`，命令不声称撤回了它 |
| 三叉戟已经投出 | 报告投出与回收状态；自动回返仍由游戏处理 | `cancelled`，`shotsFired` 保留 |

网络重试不重复发射：同一任务内发射序号 `shot` 单调递增，主进程按命令 `requestId` 去重，回执携带发射序号序列。

## D4 反射抢占（模组）

反射 `start*`（escape/eat/defend）在闸门前记录 `current*CommandId` 并调用 `BotController.clearAll("reflex_preempted")`。武器任务沿用同一模式：`clearAll` 终止武器任务并把 `endReason` 置为 `reflex_preempted`；若任务带命令身份则通过既有 `preemptedCommandId` 回显。抢占后不恢复旧蓄力或旧射击（缺口 §3.4、§3.7）。

## D5 领域动作与回执（AIRI）

新增动作 `shoot`，参数 `{ target: string, weapon?: 'auto'|'bow'|'crossbow'|'trident', maxShots?: number, chargeTicks?: number, useServerEvents?: boolean }`。

回执 `shot`：

```
{
  weapon,
  targetUuid,
  shots: Array<{ shot: number, projectileUuid?: string, hitEvidence?: string }>,
  hits?, killed?, returned?,
  endReason
}
```

- **后置条件保持 `none`**（诚实）：一次射击的“命中/击杀”取决于服务端事件与投射物物理，本批没有可由**新鲜读取**独立复核的证据源（`get_self`/`get_inventory` 读不到命中事实）。命中/击杀只在服务端事件可归因时写入 `hits`/`killed`，并保留 `hitEvidence` 字段说明归因级别；未观察到命中**不是**未命中。故不设 `hit`/`killed` 后置条件，避免把“工具返回 ok”当成成功。
- `weapon: 'auto'`：按背包可用性选弓 → 弩 → 三叉戟；都缺报 `weapon_unavailable`。
- **激流三叉戟不走此路径**：`weapon: 'trident'` 且玩家处于水中/雨中且三叉戟带 Riptide 附魔，或请求显式要求激流时，返回类型化错误 `unsupported_weapon_feature`，**不调用** `combat_start`。激流属玩家移动（缺口 §3.2），是 MC-4e 的范围。

## D6 目标固定与事件归属（AIRI）

- 执行器先用 `entities.query`（按 name/type）或直接接受 UUID 解析 `target`，取到后**固定 UUID**；整个命令期间不再按名称重解析，绝不静默改打另一只同类生物（缺口 §3.3）。目标消失报 `target_lost`。
- 调 `combat_start` 后轮询 `combat_status`；并行轮询 `poll_events`（server-first 工具）取 `entity_death`/`player_damage`：
  - `entity_death`：`uuid` 等于固定目标 UUID，且 `cause` 为 `arrow`/`trident`（弩仍报 `arrow`），且时间落在本命令窗口内 → 记 `killed` 与该发的 `hitEvidence: 'entity_death'`。
  - `player_damage`：`uuid` 为本玩家，`cause` 为 `arrow`/`trident` → 仅作受伤记录，不当作命中目标。
  - 归因不成立（uuid/cause/窗口不匹配）时，该发 `hitEvidence: 'unobserved'`。
- **`checked` 不因 `shot` 变成命中**：`check` 只认回执结构、绑定稳定与一次新鲜读取；动画、库存差、工具 `ok` 都不是命中证据（缺口 §3.6）。缺失观察是 `unobserved`，不是 miss。

## D7 去重与取消（AIRI）

- 去重：命令注册表按 `connectionGeneration:commandId` 去重；同一 `requestId` 重试返回同一回执，不重发（缺口 §3.5）。发射序号 `shot` 由模组单调分配并写入回执，证明一发一序号。
- 取消：注册表 `stop` → 执行器调 `combat_cancel`；回执保留 `shotsFired` 与已观察到的投射物事实（`shots`、`projectileUuid`），不声称撤回了已发出的投射物。
- 类型化错误：`target_lost`、`no_ammo`、`weapon_unavailable`、`not_confirmed`、`mcp_unavailable`、`unsupported_weapon_feature`。

## D8 工具面与期限

- `command-registry.ts`：`shoot` 进 `WRITE_ACTIONS`；回执行段在 `settle`、`beginExecution` 与结果装配处透传。
- 期限：`shoot` 60s。
- `DOMAIN_TOOLS` 增 `game_shoot`；`toGameCommandParams` 增 `shoot` 映射；`coding-host/game-bridge-tools.ts` 增 `game_shoot`；`shared/eventa/game-host.ts` 同步动作、结果形状与后置条件说明。
- mcp-server `tools.ts`：增 `combat_start`（写）、`combat_status`（读）、`combat_cancel`（写），映射 `combat.*` RPC。

## 单测验收清单

- 弓单发：`combat_start` → status `running` → status `done`（一发投射物）；回执区分已射出与 `hitEvidence: 'unobserved'`。
- 无弹药 / 武器缺失 / 目标消失：类型化失败（`no_ammo`/`weapon_unavailable`/`target_lost`），无幻觉发射。
- 蓄力取消：调用 `combat_cancel`，回执不声称 release/发射。
- 弩先装填后发射：status 反映装填态与一发子弹。
- 三叉戟：投出被记录；`returned` 与回收超时（`return_pending`/`lost`）分别报告。
- 反射抢占：status `cancelled`/`reflex_preempted`，`shotsFired` 保留。
- 激流请求：返回 `unsupported_weapon_feature` 且不调用 `combat_start`。
- 现有 `game-host` 与 `coding-host` 用例保持通过（桥工具清单同步）。

## 增量拆分

1. 模组武器任务与状态/取消（D1–D4）+ mcp-server 工具（D8）。
2. AIRI 契约、注册表、`shoot` 执行器与工具（D5–D8）。
3. 单测（本批验收清单）。
4. 真机验收（未执行，属后续批次）。

## 实现落点

- 模组：`client/BotController.java`（武器任务阶段机与逐 tick）、`client/ClientControlGuard.java`（`clearAll` 终止）、`client/handlers/CombatHandlers.java`（新增，注册 `combat.start/status/cancel`）、`client/McpFabricClient.java`（注册）、`mcp-server/src/tools.ts`。`gradle.properties` 保持 0.2.5。
- AIRI：`game-host/command-contract.ts`、`game-host/command-registry.ts`、`game-host/index.ts`、`game-host/index.test.ts`、`shared/eventa/game-host.ts`、`coding-host/game-bridge-tools.ts`、`coding-host/game-bridge-tools.test.ts`。

## 风险与回退

- **实时窗口在模组**：蓄力、瞄准、发射逐 tick 在客户端完成；主进程只发 `start` 与轮询 `status`，不承担发射时机（缺口 §3.4）。
- **取消不等于松键**：中止走 `stopUsingItem`；弩装填中止后重读实际 `charged`；已发出的投射物不回滚（缺口 §3.5）。
- **命中归属弱证据**：只有服务端事件可归因时才写 `hits`/`killed`；客户端单边观察记 `unobserved`。`checked` 不表示命中。
- **1.21.1 映射**：投射物类型判定用 Mojang 名 `AbstractArrow`/`ThrownTrident`；owner 判定用 `getOwner()`；速度外推用 `getDeltaMovement()`。跨版本需单独验证。
- **回退**：`shoot` 走独立域工具与写锁，不改 `use`/`equip` 语义；`game_use` 的 `mode: 'item'` 仍可单次使用。

## 明确不做

- 激流三叉戟的玩家移动（MC-4e）。
- 引雷、多重射击、烟花弩等附魔组合的专门归类（首批只保证普通箭与普通投掷三叉戟；未支持组合返回 `unsupported_weapon_feature`）。
- 命中率的真机统计与移动目标/高差弹道标定（缺口 §3.7 属后续验收）。
- 真机验收：本批只交代码、单测、类型检查。

## 实施记录

### 代码实施（2026-09-14）

- **模组（0.2.5 保持）**：
  - `BotController` 增武器任务阶段机：`startCombat`/`stopCombat`/`combatStatusJson` 与逐 tick `tickCombat`；阶段 `select → aim → charge/hold → release → track`（弩多一步 `load`）。前置检查选武器（主背包 PICKUP 点击换入空快捷栏槽）与弹药；发射后在 `entitiesForRendering()` 定位本次新生成、owner 为本地玩家、type 匹配的投射物并记录 UUID 与单调 `shot`；三叉戟投出后跟踪回返/超时（`returned`/`return_pending`/`lost`）。取消按状态走 `stopUsingItem`（不触发 release）；`clearAll` 终止武器任务并置 `reflex_preempted`。
  - 新增 `handlers/CombatHandlers.java`，注册 `combat.start`（写）、`combat.status`（读）、`combat.cancel`（写）；`McpFabricClient` 注册。
  - mcp-server `tools.ts` 增 `combat_start`（写）、`combat_status`（读）、`combat_cancel`（写）。
- **AIRI**：`command-contract.ts` 增 `shoot` 动作、参数与 `GameShotReceipt`（后置条件保持 `none`，原因见 D5）；`command-registry.ts` 增写动作与回执透传；`index.ts` 增 `game_shoot` 工具与执行器（固定目标 UUID、轮询 `combat_status`、并行 `poll_events` 归因 `entity_death`/`player_damage`、激流 `unsupported_weapon_feature`、`combat_cancel`），期限 60s；`shared/eventa/game-host.ts` 同步动作与结果形状；`game-bridge-tools.ts` 增 `game_shoot`。
- **偏离与取舍**：
  - `shoot` 后置条件取 `none`：本批无可由新鲜读取独立复核的命中/击杀证据源，`hits`/`killed` 只在服务端事件可归因时填写，未观察记 `unobserved`（D5、D6）。
  - 影响物理（速度前置）默认关闭且外推有界，只对可解析的 `targetUuid` 生效。
  - 激流三叉戟显式返回 `unsupported_weapon_feature` 且不调 `combat_start`（D5）。
- **检查**（见下方实施记录补记）。
- **NOT-RUN**：真机验收（真实弓/弩/三叉戟发射与命中、三叉戟回返、取消不发射、多人补刀归属、移动目标弹道）。

### 实施记录补记（2026-09-14）

- **检查**：
  - `pnpm -F @proj-airi/stage-tamagotchi exec vitest run src/main/services/airi/game-host` → 11 passed / 1 skipped（175 passed / 1 skipped；基线 165 / 1）。
  - `pnpm -F @proj-airi/stage-tamagotchi exec vitest run src/main/services/airi/coding-host` → 4 passed（26 passed）。
  - `pnpm -F @proj-airi/stage-tamagotchi typecheck` → 退出 0。
  - `pnpm exec eslint <改动文件>` → 退出 0。
  - `D:\mcpfabric\mcp-server` `npm run build` → 成功。
  - `$env:JAVA_HOME='C:\Program Files\Java\jdk-21'; .\gradlew.bat :1.21.1:build` → BUILD SUCCESSFUL。
- **模组编译修正**：`entitiesForRendering()` 是 `ClientLevel` 方法，`aimAtTarget`/`findOwnProjectile`/`projectileStillPresent` 改用 `mc.level`；投射物 owner 用 `Projectile.getOwner()`（`Entity` 无此方法）。
- **NOT-RUN**：真机验收（真实弓/弩/三叉戟发射与命中、三叉戟回返、取消不发射、多人补刀归属、移动目标弹道）。

### 真机验收（2026-09-14）— PASS

- 弓单发击杀（投射物 UUID 归属 + `entity_death`）、弩装填/发射/击杀、忠诚回返（`returned:true`）、普通投掷（`returned:false`）、蓄力取消、发射后取消保留已发事实、无箭 `no_ammo`、friendly_blocked（玩家在弹道 → 拒绝射击零耗箭；离弹道 → 正常击杀）全部通过。
- **验收中修复（模组 0.2.7–0.2.10）**：射击计数（弹药兜底、`maxShots` 守卫、每发 `shotVerifiedBy`）；弩装填清除核对与 2 tick 瞄准稳定；预存投射物排除与 `friendlyInLine` 误伤守卫。
- 记录：[evidence/mc-4/live-acceptance-20260914.md](./evidence/mc-4/live-acceptance-20260914.md)。

[gaps]: ./minecraft-player-capability-gaps.md
