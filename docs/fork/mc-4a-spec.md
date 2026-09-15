# MC-4a 规范：观察与物品使用（阶段 1，P0）

日期：2026-09-13。状态：实施完成（代码 + 单测 + 类型检查；真机验收未做）。上游：[玩家能力缺口](./minecraft-player-capability-gaps.md) §2 阶段 1 P0 行与 §4.1、[MC 执行计划](./minecraft-player-capability-execution-plan.md) §6.1、[MC-3c 规范](./mc-3c-spec.md)。依赖：MC-3c-1 ✓（命令/回执/聊天）；X-03（使用生命周期）与本批共用切片。

通过条件（缺口文档原文）：能从主背包装备物品；读取真实状态；开始与中止使用；中止不产生副作用。

## D1 使用生命周期（模组）

- `control.startUsing`：设 `BotController.setUseHeld(true)`、按下 `keyUse`，并显式调用一次 `ClientMc.gameMode().useItem(player, MAIN_HAND)`。只设按键不足以触发 `consumeClick`，显式 use 与进食反射同款。返回实际使用态。
- 新增 `control.releaseUsing`：`gameMode.releaseUsingItem(player)`，走原版正常释放，会触发射出/完成（弓、弩、三叉戟、食物）；同时松键并清 use-held。
- `control.stopUsing` 保留为中止路径：`player.stopUsingItem()` 加松键、清 use-held，不触发射出。
- 三条路径返回同一 `usingState`：`using`、`usingTicks`、`usingHand`（小写枚举名）、`usingItemId`（空则空串）。

## D2 真实状态读取（模组）

- `player.getState` 增 `usingTicks`（`getTicksUsingItem()`）、`usingHand`（`getUsedItemHand().name()` 小写）、`usingItemId`（`getUseItem()` 的注册表 id，空则空串）。
- `itemJson` 增：
  - `enchantments`：`{"minecraft:sharpness": 3, ...}`，键取附魔 holder 的 `unwrapKey().location()`（附魔是数据驱动注册表，`BuiltInRegistries` 无 `ENCHANTMENT`）。
  - `food: true`：`stack.get(DataComponents.FOOD) != null`。
  - 弩已装填：`charged: true` 与 `chargedProjectiles: [itemIds]`，来自 `DataComponents.CHARGED_PROJECTILES` 的 `getItems()`；已装填与空弩必须可区分，避免误装填丢弃已上膛弹丸。

## D3 领域动作：装备与使用（AIRI）

- `command-contract.ts` 增动作 `'equip'`、`'use'` 与参数：
  - `equip: { itemId, target }`，`target ∈ main_hand|off_hand|head|chest|legs|feet`。
  - `use: { mode: item|block|entity, holdTicks, abort, x?, y?, z?, uuid? }`。
- 后置条件新增 `'equipped'`。`equipped` 以「布局请求」对「新鲜 `get_equipment` 读数」比对：`target`（槽）、`expectedItemId`（请求）、`actualItemId`（实读，空为 null）；`postCondition.target/actual` 记 1/0 匹配标记，`met` 为真仅当实读 id 等于请求 id。
- `use` 的后置条件保持 `'none'`（诚实原因见下）：一次使用的可核对副作用取决于物品与服务器（箭是否射出、方块是否变化、实体是否响应），本批未建可复用证据源；回执携带 `used { itemId?, mode, heldTicks, released, aborted }` 而不伪造成功。
- 新增领域工具 `game_equip`、`game_use`（provider 合规 schema，`additionalProperties: false`），期限 15s / 30s，写入命令注册表 `WRITE_ACTIONS`。

## D4 装备执行器

- 参数 `{ itemId, target }`。用 `get_inventory` 定位物品（快捷栏 0-8 或主背包 9-35）。
- 目标槽位映射：主手走 `select_hotbar_slot`；副手 40、头盔 36、胸甲 37、护腿 38、靴子 39 走 `swap_slots`。主背包物品装备到主手时先换入一个空快捷栏槽（无空位则用当前选中槽），再选中。
- 换槽后用新鲜 `get_equipment` 核对目标槽 id。类型化失败：`not_in_inventory`、`equipment_read_failed`、`not_confirmed`。回执 `equipped { itemId, target }`，后置条件 `equipped`。

## D5 使用执行器

- `mode: item`：`start_using` → `get_self` 轮询（至少一次；`holdTicks` 默认 0，上限 200，按 50ms 有界）→ 正常 `release_using`；`abort: true` 或收到停止请求时改走 `stop_using`。回执 `used { itemId?, mode: 'item', heldTicks, released, aborted }`。
- `mode: block`：`place_block { x, y, z }`（`useItemOn` 路径）。回执 `used { mode: 'block', heldTicks: 0, released: false, aborted: false }`。
- `mode: entity`：`use_entity { uuid }`。回执同上，`mode: 'entity'`。
- `start/release/stop` 的 MCP 工具名与模组 RPC 对齐。

## D6 观察回执扩展

- `observe` 执行器在 `get_self` 之后，逐一 best-effort 读取 `get_inventory`、`get_equipment`、`get_status_effects`；任一失败只把名字记入 `observed.missing`，不影响观察成功。
- `observed?: { inventory?, equipment?, effects?, missing?, truncated? }` 挂到执行器结果、终态回执与 `GameDomainResult`。
- 截断规则：`hotbar ≤ 9`、`main ≤ 27`、`armor ≤ 4`（原版容量）。任一列表超出即裁剪尾部并置 `truncated: true`。

## D7 桥与工具面

- `coding-host/game-bridge-tools.ts` 增 `game_equip`、`game_use`，复用既有 `GameCommandPort` 路径。
- mcp-server `tools.ts`：`control.startUsing` 工具改名 `start_using`（返回使用态）、`control.stopUsing` 改名 `stop_using`（描述为中止、不发射），新增 `release_using`（正常释放、触发射出）。`poll` 说明见下。

## 单测验收清单

- 装备：主背包物品换入护甲槽并经 `get_equipment` 核对成功；物品缺失时报 `not_in_inventory`。
- 使用：`item` 模式工具序列为 `start_using` → `get_self` 轮询 → `release_using`；`abort` 时改走 `stop_using`；`block`/`entity` 模式分别调用 `place_block`/`use_entity`。
- 观察：包含 inventory/equipment/effects；读失败记入 `missing` 且不失败；超长列表被截断并置 `truncated`。
- 现有 `game-host` 用例保持通过。

## 增量拆分

1. 模组使用生命周期与状态读取（D1、D2）+ mcp-server 工具（D7）。
2. AIRI 契约、注册表、装备/使用执行器与工具（D3–D5）。
3. 观察回执扩展（D6）。
4. 真机验收（未执行，属后续批次）。

## 实现落点

- 模组：`ControlHandlers.java`、`LocalPlayerHandlers.java`、`mcp-server/src/tools.ts`、`gradle.properties`（0.2.4 → 0.2.5）。
- AIRI：`command-contract.ts`、`command-registry.ts`、`game-host/index.ts`、`shared/eventa/game-host.ts`、`coding-host/game-bridge-tools.ts`、`game-host/index.test.ts`。

## 风险与回退

- 原版使用是中继到服务端的行为，释放是否发射取决于物品与服务端。回执只报「已调用 release/stop」与实读使用态，不声称发射或命中。
- `holdTicks` 是主进程按 50ms 近似，不是服务端 tick；实时蓄力窗口仍属 MC-4d。
- 装备换槽依赖 `get_equipment` 的新鲜读数；读失败即 `equipment_read_failed`，不回退到「已换过就算成功」。
- 回退：新动作走独立域工具与写锁，不改变既有动作语义。

## 明确不做

- 弓/弩/三叉戟的瞄准、弹道、发射序号、命中与回收（MC-4d）。
- 容器/工作台菜单、定量转移（MC-4b）。
- 逐 tick 使用所有权与抢占（MC-4d、MC-4c）。
- 真机验收：本批只交代码、单测、类型检查。

## 实施记录

### 代码实施（2026-09-13）

- **模组 0.2.5**：`control.startUsing` 改为真实开始使用（`useHeld` + 键 + 首次 `gameMode.useItem`），新增 `control.releaseUsing`（正常释放），`control.stopUsing` 保留为中中止且不发射；`player.getState` 增 `usingTicks`/`usingHand`/`usingItemId`；`itemJson` 增 `enchantments`/`food`/`charged`/`chargedProjectiles`。附魔 id 用 `Holder.unwrapKey().location()`（数据驱动注册表，无 `BuiltInRegistries.ENCHANTMENT`），已用 1.21.1 编译验证。
- **mcp-server**：`start_using_item`/`stop_using_item` 改名为 `start_using`/`stop_using`，新增 `release_using`；`start_using` 描述为开始真实使用并返回状态，`stop_using` 描述为中中止不发射。README 控制组列表同步。
- **AIRI**：`command-contract.ts` 增 `equip`/`use` 动作、`equipped` 后置条件与 `equipped`/`used`/`observed` 回执类型；`command-registry.ts` 增两个写动作与回执透传；`index.ts` 增 `game_equip`/`game_use` 工具与执行器（装备新鲜 `get_equipment` 核对；使用 item/block/entity 三模式；使用后置条件诚实取 `none`）；`observe` 执行器扩 `get_inventory`/`get_equipment`/`get_status_effects` best-effort 并做 9/27/4 截断；`shared/eventa/game-host.ts` 同步动作、后置条件与结果形状；`game-bridge-tools.ts` 增两条桥工具。
- **偏离与取舍**：
  - 工具改名而非新增（`start_using`/`stop_using` 精确名此前不存在，只有 `*_item`），以匹配执行器调用名；本仓内部无其他引用。
  - `equipped` 后置条件的 `target/actual` 记 1/0 匹配标记，另附 `equipped { target, expectedItemId, actualItemId }` 详情；`use` 无可靠证据源，保持 `none`。
- **检查**：`pnpm -F @proj-airi/stage-tamagotchi exec vitest run src/main/services/airi/game-host` → 11 passed / 1 skipped，145 passed / 1 skipped；`typecheck` 退出 0；改动文件 `eslint` 退出 0。模组 `:1.21.1:build` BUILD SUCCESSFUL；`mcp-server npm run build` 成功。
- **NOT-RUN**：真机验收（装备/使用/中止副作用、观察回执真机形状）。

### 真机验收（2026-09-14）— PASS

- 装备（剑/盾/头盔，`equipped` + 新鲜装备读）、use item 正常释放/中止、use block（火把）、use entity（村民开店）、观察回执真机形状全部通过。
- 记录：[evidence/mc-4/live-acceptance-20260914.md](./evidence/mc-4/live-acceptance-20260914.md)。
