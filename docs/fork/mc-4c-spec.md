# MC-4c 规范：生存连续性（阶段 3，P1）

日期：2026-09-14。状态：实施完成（代码 + 单测 + 类型检查；真机验收未做）。上游：[玩家能力缺口](./minecraft-player-capability-gaps.md) §2 阶段 3 的 P1 行与 §4.2、[MC 执行计划](./minecraft-player-capability-execution-plan.md) §6.3、[MC-4a 规范](./mc-4a-spec.md)、[MC-4b 规范](./mc-4b-spec.md)、[MC-3c 规范](./mc-3c-spec.md)（地形执行器契约）。依赖：MC-4b ✓（菜单/容器原语）、MC-3c ✓（地形与载具执行器）。模组基线 0.2.5。

通过条件（缺口文档原文）：跟随采集、中途补给、被打断后停止、死亡后重新规划。

本批只交代码、单测、类型检查。真机验收（真实床交互、死亡重生、多人物品归属）属后续批次。

## D1 自动进食从主背包补充（模组）

- 现状：反射 `findFoodSlot` 只扫描快捷栏 0-8，主背包有食物也不吃。
- 新行为：快捷栏无食物时，在**主背包 9-35** 找一份带 `DataComponents.FOOD` 的整栈；把它移入一个**空快捷栏槽**再选中进食。
- 迁移走容器点击：`inventoryMenu.containerId` + `handleInventoryMouseClick`/`handleContainerInput` shim，两次 `PICKUP`（拿起→放下）。1.21.1 无 `InventorySlot`，槽位号沿用 `InventoryHandlers` 的玩家槽到菜单槽映射（快捷栏 36-44、主背包 9-35）。
- 无空快捷栏槽：不换出手持物、不丢任务物资，按 `no_food` 失败。
- 反射保持有界：`eatTicks` 上限不变；迁移最多一次点击对。
- 事件数据：`hunger` 事件增 `slot`（实际选中的快捷栏槽），保留既有 `itemId`/`hungerBefore`/`hungerAfter`。
- 显式 `gameMode.useItem` 调用模式不变（只设按键不足以启动使用）。

## D2 睡眠、重生点读取与重生（模组）

新增 `handlers/PlayerLifeHandlers.java`，注册三个 RPC：

- `player.sleep { x, y, z }`：
  - 目标位置不是床（`BedBlock`）→ `{ sleeping:false, error:'no_bed' }`。
  - 否则瞄准床方块中心并走 `useItemOn` 右键路径（同 `InteractHandlers.placeBlock`，不破坏门）。
  - 交互返回失败 → `{ sleeping:false, error:'interaction_failed' }`。
  - 在 HTTP 工作线程有界轮询（≤3s，50ms）`isSleeping()`；成功返回 `{ sleeping:true, sleepTimer, bedPosition }`；超时返回 `{ sleeping:false, sleepTimer, bedPosition, error:'not_sleeping' }`。1.21.1 客户端拿不到原版失败原因，回执不伪造原因，只给状态。
- `player.getSpawn`：`getRespawnPosition()`/`getRespawnDimension()` 可空读取，返回 `{ respawning, position?, dimension?, sleeping, sleepTimer }`；未设重生点也不报错。
- `player.respawn`：仅当 `isDeadOrDying()` 时调用 `LocalPlayer.respawn()`；随后有界轮询 `!isDeadOrDying()` 与可用位置，返回 `{ respawned:true, position, dimension }`。存活时返回 `{ respawned:false, error:'not_dead' }`。
- 三者都过 `requireControl()` 门（`enablePlayerControl=false` 时不可用）。

## D3 领域动作、回执与后置条件（AIRI）

`GameCommandAction`/`GameDomainAction` 增 `'supply'`、`'sleep'`、`'respawn'`；参数 `sleep: { x, y, z }`（`supply`/`respawn` 无参）。

| 动作 | 参数 | 回执 | 后置条件 |
| --- | --- | --- | --- |
| `supply` | `{}` | `fed { itemId, foodBefore, foodAfter, slot? }` | `fed`（target=1，actual=max(0, foodAfter − foodBefore)） |
| `sleep` | `{ x, y, z }` | `slept { position, sleepTimer }` | `none`（失败即抛类型化错误，不伪造成功） |
| `respawn` | `{}` | `respawned { position }` | `none`（存活时 `not_dead`） |

- `supply` 执行器：读 `get_self`（foodBefore）+ `get_inventory`；从快捷栏、再主背包选一份 `food:true` 的整栈；主背包物品先 `swap_slots` 换入空快捷栏槽再 `select_hotbar_slot`；`start_using` → 有界 `get_self` 轮询 → `release_using`（正常释放才吃完）；以**新鲜 `get_self` food 差**核对，记 `fed`/`fedCount`。类型化失败：`no_food`（背包无食物或无可迁移空位）、`not_confirmed`（food 未增加）、`mcp_unavailable`（读失败）。
- `sleep` 执行器：调 `sleep` 工具；工具 `error` 为 `no_bed`/`not_sleeping`/其它时抛同名错误；`sleeping !== true` 抛 `not_sleeping`；成功记 `slept`。
- `respawn` 执行器：调 `respawn` 工具；`error === 'not_dead'` 抛 `not_dead`；`respawned !== true` 抛 `not_confirmed`；成功记 `respawned`。

## D4 工具面与期限

- `command-registry.ts`：`supply`/`sleep`/`respawn` 进 `WRITE_ACTIONS`；回执行段在 `settle`、`beginExecution` 与结果装配处透传。
- 期限：`supply` 30s、`sleep` 30s、`respawn` 20s。
- `coding-host/game-bridge-tools.ts`：增 `game_supply`、`game_sleep`、`game_respawn`。
- mcp-server `tools.ts`：增 `sleep`、`get_spawn`、`respawn`，分别映射 `player.sleep`（写）、`player.getSpawn`（读）、`player.respawn`（写）。

## D5 跟随与采集统一到地形执行器

- `index.ts` 增内部助手 `runTerrainLeg(goal, tolerance)`：用 `createTerrainPort()`、`DEFAULT_MOVEMENT_CONFIG`、`remainingPlaceables = countScaffolding()`、`shouldStop: () => stopRequested`，返回 `runTerrainMove` 结果。`follow` 与 `collect` 的一腿都走它，不再调 `navigate_to`/`navigation_status`。
- `movement.planner === 'legacy'` 只保留给 `move_to`；`follow`/`collect` 永远走地形执行器（文档化：这两个动作没有旧实现回退）。
- `follow`：
  - 首次按 name/uuid/type 解析目标，取到后**固定 UUID**；之后每腿按 UUID 重新读位置。
  - 目标消失 → `target_lost`；腿跑完/超时后重读目标位置继续。
  - 总时长受租约与 `timeoutSeconds` 约束。
  - `reflex_preempted` 处理不变（循环内轮询 `reflexPreemptedFor`）。
- `collect`：
  - `find_blocks` → 对每个候选（候选上限与 `slice(0,3)` 不变）远端先地形移动、近端直接破坏。
  - 破坏用稳定瞄准的 `break_block` survival + 有界轮询方块变空。
  - **归属**：每次破坏前读一次 `get_inventory` 基线，破坏后在**有界窗口**内轮询该物品计数，`attributed = max(0, after − beforeBreak)` 累加；不以整段动作的库存增长计数，因此别的玩家丢物/拾取（无破坏）不会计入。
  - `collected` 后置条件取累加的归属数；`executeDomainCommand` 不再用整段 fresh delta 覆盖 collect 后置条件。

## 单测验收清单

- 补给：快捷栏进食达成 food 差；主背包换入空快捷栏后进食；无食物 `no_food`。
- 睡眠：成功；超时 `not_sleeping`；非床 `no_bed`。
- 重生：成功；存活 `not_dead`。
- 跟随：首腿解析目标，次腿按固定 UUID 重读；目标消失 `target_lost`；走地形端口（断言工具名，除 `move_to` + `planner='legacy'` 外不出现 `navigate_to`）。
- 采集：只计破坏窗口内的归属拾取；无破坏的库存增长不计（他人丢物夹具）。
- 现有 `game-host` 用例保持通过（`coding-host/game-bridge-tools.test.ts` 工具清单同步）。

## 增量拆分

1. 模组：反射主背包进食（D1）+ 睡眠/重生点/重生 RPC（D2）+ mcp-server 工具（D4）。
2. AIRI：契约、注册表、三个执行器与工具（D3、D4）。
3. 跟随/采集统一地形执行器与采集归属（D5）。
4. 单测（本批验收清单）。
5. 真机验收（未执行，属后续批次）。

## 实现落点

- 模组：`client/reflex/ReflexController.java`、`client/handlers/PlayerLifeHandlers.java`（新增）、`client/McpFabricClient.java`（注册）、`mcp-server/src/tools.ts`。`gradle.properties` 保持 0.2.5。
- AIRI：`game-host/command-contract.ts`、`game-host/command-registry.ts`、`game-host/index.ts`、`game-host/index.test.ts`、`shared/eventa/game-host.ts`、`coding-host/game-bridge-tools.ts`、`coding-host/game-bridge-tools.test.ts`。

## 风险与回退

- **床与重生是服务端中继**：客户端 `isSleeping`/`respawn` 依赖后续 tick；全部有界轮询，超时诚实失败。
- **主背包进食会动快捷栏**：只换入空槽，不动已有物品；无空槽即失败，避免丢任务物资。
- **采集归属仍有窗口**：归属以“破坏后窗口内的目标物品增量”为准，窗口外的迟到拾取不计；别的玩家在同一窗口丢同名物品仍可能被计入，真机验收需记录此边界。
- **地形腿不设单腿 deadline**：租约到期会经 `stopRequested` 中止；`follow`/`collect` 无 legacy 回退。
- **回退**：`supply`/`sleep`/`respawn` 走独立域工具与写锁；`move_to` 的 `planner='legacy'` 保留。

## 明确不做

- 弓/弩/三叉戟（MC-4d）。
- 找回死亡装备的规划（本批只做重生本身）。
- 掉落物实体级归属（按破坏窗口近似，不追踪实体所有者）。
- 反射关联补全命令身份（缺口 §3.4 的实时所有权仍留待后续）。
- 真机验收：本批只交代码、单测、类型检查。

## 实施记录

### 代码实施（2026-09-14）

- **模组（0.2.5 保持）**：
  - `ReflexController`：`findFoodSlot` 拆为 `findHotbarFoodSlot`/`findFoodSlot`（快捷栏 0-8 → 主背包 9-35）。快捷栏无食物时 `moveFoodToHotbar` 用 `inventoryMenu.containerId` + `handleInventoryMouseClick`/`handleContainerInput` shim 两次 PICKUP 把一份主背包食物移入首个空快捷栏槽；无空槽即 `no_food`，不换出手持物。`tickEat` 只在快捷栏食物耗尽时停止。`hunger` 事件增 `slot`。
  - 新增 `handlers/PlayerLifeHandlers.java`，注册 `player.sleep`、`player.getSpawn`、`player.respawn`；`McpFabricClient` 注册。
  - mcp-server `tools.ts` 增 `sleep`（写）、`get_spawn`（读）、`respawn`（写）。
- **AIRI**：`command-contract.ts` 增 `supply`/`sleep`/`respawn` 动作、`fed` 后置条件与 `GameFedReceipt`/`GameSleptReceipt`/`GameRespawnedReceipt`；`command-registry.ts` 增三个写动作与回执透传；`index.ts` 增 `game_supply`/`game_sleep`/`game_respawn` 工具与执行器、期限，新增 `runTerrainLeg` 共享助手，`follow`/`collect` 改走地形执行器（不再用 `navigate_to`/`navigation_status`），`follow` 首腿固定 UUID、次腿按 UUID 重读，`collect` 按破坏窗口归属拾取并移除整段库存差覆盖；`shared/eventa/game-host.ts` 同步动作、后置条件与结果形状；`game-bridge-tools.ts` 增三条桥工具。
- **偏离与取舍**：
  - **`get_spawn` 客户端读不到重生点（1.21.1）**：`getRespawnPosition()`/`getRespawnDimension()` 只存在于 `ServerPlayer`，`LocalPlayer` 没有。实现改为：有集成服务器时读取本地 `ServerPlayer`；专用服务器时返回 `unsupported: 'dedicated_server'`（不谎报“无重生点”），并照常给 `sleeping`/`sleepTimer`。真机在专用服务器下该工具只提供睡眠状态，重生点需服务端桥补充，属后续批次。
  - **采集归属口径变更**：`executeDomainCommand` 不再用整段命令的 fresh 库存差覆盖 collect 后置条件；归属完全由执行器的每次破坏窗口累加，故“无破坏的库存增长”不计入（原 MC-1a 规则被本批收窄，符合缺口 §4.2）。
  - `follow`/`collect` 无 `planner='legacy'` 回退；该开关只对 `move_to` 生效（已文档化）。
  - 删除不再使用的 `navigateAndWait`/`NavWaitResult`。
- **检查**：
  - `pnpm -F @proj-airi/stage-tamagotchi exec vitest run src/main/services/airi/game-host` → 11 passed / 1 skipped（165 passed / 1 skipped；基线 153）。
  - `pnpm -F @proj-airi/stage-tamagotchi exec vitest run src/main/services/airi/coding-host` → 4 passed（26 passed）。
  - `pnpm -F @proj-airi/stage-tamagotchi typecheck` → 退出 0。
  - `pnpm exec eslint <改动文件>` → 退出 0。
  - `D:\mcpfabric\mcp-server` `npm run build` → 成功。
  - `$env:JAVA_HOME='C:\Program Files\Java\jdk-21'; .\gradlew.bat :1.21.1:build` → BUILD SUCCESSFUL。
- **NOT-RUN**：真机验收（真实床睡眠、死亡重生、反射主背包进食、跟随/采集地形腿、多人采集归属）。

### 真机验收（2026-09-14）— PASS（follow 修复后）

- supply（食物 14→19）、sleep、respawn（床点 + keepInventory）、collect（逐块破坏 + 走到掉落拾取，后条件 1/1）全部通过；落入凹洞的掉落 `no_path` 诚实报告。
- **follow 修复（真机发现）**：`runTerrainLeg` 目标取整——实体的**小数坐标**永远匹配不上整数规划节点，导致每腿 `no_path`、一步未走；日志里的 `missing …` 只是探查越界的诊断旁注。加固：落点扫描按 `maxDropDown` 封顶、移动读区域下界扩为 `2*maxDropDown+1`。复测 11 格 → 1 格并保持，`timeout` 收尾；回归用例覆盖小数目标。
- 记录：[evidence/mc-4/live-acceptance-20260914.md](./evidence/mc-4/live-acceptance-20260914.md)。

