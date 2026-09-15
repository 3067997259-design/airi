# MC-4b 规范：基础生存生产（阶段 2，P0）

日期：2026-09-16。状态：实施完成（代码 + 单测 + 类型检查；真机验收未做）。上游：[玩家能力缺口](./minecraft-player-capability-gaps.md) §2 阶段 2 P0 行与 §4.1、[MC 执行计划](./minecraft-player-capability-execution-plan.md) §6.2、[MC-4a 规范](./mc-4a-spec.md)。依赖：MC-4a ✓（装备、使用、观察、领域动作与回执模式）。模组基线 0.2.5。

通过条件（缺口文档原文）：从原木开始制作工具；烧出铁锭；存入箱子并取出指定数量。

本批只交代码、单测、类型检查。真机验收（容器/工作台/熔炉、定量转移、多人抢材料）属后续批次。

## D1 菜单身份与槽位寻址（模组）

- 菜单身份 = `AbstractContainerMenu.containerId`（模组对每个新开容器自增）。它是唯一稳定的菜单句柄；`type` 取 `BuiltInRegistries.MENU.getKey(menu.getType())`，`slots` 取 `menu.slots.size()`。
- 每个回执都携带 `containerId`。**槽位号只属于某个 `containerId`**：菜单一旦变化，旧槽位号失效，不得跨菜单复用（缺口 §4.1）。
- 玩家背包槽位另给 `invSlot`：约定 0-8 快捷栏、9-35 主背包、36-39 护甲、40 副手，与 `InventoryHandlers.toMenuSlot` 相反方向的映射。判定方法见 D2。
- 类型化失败码：`menu_mismatch`（点击时 `containerId` 不符）、`no_menu`（无可开/可关菜单）、`slot_empty`（源槽为空或无产物）、`destination_full`（目标槽拒收）、`menu_not_crafting`、`unknown_recipe`、`not_furnace`、`not_confirmed`。

## D2 菜单快照与熔炉进度（模组）

- `menu.snapshot` 返回 `containerId`、`type`、`carried`（光标物品）与每个 `menu.slots` 条目：`index`（菜单槽）、`container`（`slot.container` 简单类名）、`invSlot`（仅玩家背包槽）、物品 `id/count/enchantments/...`。
- 物品 JSON 复用 `D:\mcpfabric` 的 `handlers/ItemJson.java`（从 MC-4a 的 `LocalPlayerHandlers.itemJson` 抽出），保证玩家、背包、菜单三处同一形状。
- **1.21.1 偏差**：该版本 `AbstractFurnaceMenu` 只公开 `isLit()`、`getLitProgress()`、`getBurnProgress()`，`ContainerData` 原始计数是私有字段。因此熔炉载荷用可编译验证的比例：`{ lit, litProgress, cookProgress }`，不伪造 tick 计数。`litProgress` 为火焰比例，`cookProgress` 为进度箭头比例（原版 `getBurnProgress`）。
- 玩家背包槽判定用 `slot.container instanceof Inventory` 加 `Slot.getContainerSlot()`。**1.21.1 无 `InventorySlot` 类**（仅 1.21.5+ 拆分），故不采用 `instanceof InventorySlot`。

## D3 受控槽位操作与关闭（模组）

- `menu.click { containerId, slot, quickMove? }`：`player.containerMenu.containerId` 与请求不符即返回 `{ accepted:false, error:'menu_mismatch' }`，不触碰槽位。否则用 `handleInventoryMouseClick`（26.1 为 `handleContainerInput` shim）以 `PICKUP`（或 `quickMove=true` 时 `QUICK_MOVE`）点击，返回 `accepted`、该槽点击后摘要与 `carried`。
- `menu.close`：仅当 `containerMenu != inventoryMenu` 时 `player.closeContainer()`，否则返回 `{ closed:false, error:'no_menu' }`，绝不谎报关闭。
- AIRI 不在动作内自动关菜单；关闭由调用方的 `close_menu` 和连接清理负责（D5、D7）。

## D4 打开容器（模组）

- `menu.open { x, y, z, face? }`：记录点击前的 `containerId`，在渲染线程用 `gameMode.useItemOn` 右键目标方块（同 `InteractHandlers` 放置路径，门仍走原版开合、不开菜单），随后在 HTTP 工作线程上有界轮询（≤2s，50ms 间隔），直到 `containerMenu` 变为非玩家背包菜单且 `containerId` 改变。
- 返回菜单身份；无菜单时返回 `{ opened:false, error:'no_menu' }`。
- **title 不返回**：1.21.1 的 `AbstractContainerMenu` 不持有界面标题（标题在 Screen 上），菜单身份只用 `containerId`/`type`/`slots`。
- **不在渲染线程休眠**：打开屏包在后续 tick 到达，阻塞渲染线程会死锁；轮询在工作线程完成。

## D5 AIRI 领域动作与回执

新增动作（`GameCommandAction`）与回执（`GameCommandReceipt` / `GameDomainResult`）：

| 动作 | 参数 | 回执 | 后置条件 |
| --- | --- | --- | --- |
| `open_container` | `{ x, y, z }` | `menu { containerId, type, slots, openedAt }` | `none` |
| `read_menu` | `{}` | `menuSnapshot { containerId, type, slots, carried?, furnace?, truncated? }` | `none` |
| `move_item` | `{ from, to, count? }`（菜单槽） | `moved { containerId, from, to, requested, moved }` | `moved`（target=requested，actual=moved） |
| `close_menu` | `{}` | 无 | `none` |
| `craft_table` | `{ x, y, z, recipeId, attempts? }` | `crafted { recipeId, output, attempts, inventoryDelta, residue? }` | `crafted`（复用 MC-2d） |
| `smelt_load` | `{ x, y, z, inputItemId, fuelItemId?, count? }` | `smelt { containerId, stage:'loaded'/'cooking', inputItemId, fuelItemId?, requested, loaded, cooking }` | `none` |
| `smelt_take` | `{ x, y, z }` | `smelt { containerId, stage:'taken', inputItemId?, requested, taken, residue? }` + `moved` 计数 | `moved`（target=观测产物数，actual=库存差） |

- **快照截断规则**：`menuSnapshot.slots` 上限 100 条；超限裁剪尾部并置 `truncated:true`（一个大型箱子加玩家背包约 90 槽）。
- **move_item 语义**：模组原语是单次左键，故按整栈两步转移（取起→放下）实现，`count` 是最小目标而非精确切片，`moved` 是实测源槽减少。目标槽拒收时报 `destination_full`，并把光标物品放回源槽。
- **menu_mismatch 双层防护**：执行器在每次转移前重读快照并核对 `containerId`；模组在 `menu.click` 再核对一次。身份改变即失败且不点击。
- `craft_table`：打开工作台（类型非 `minecraft:crafting` 报 `menu_not_crafting`），先清空结果槽遗留物（记入 `residue`，不计产出），读基线库存，调 `menu.craft` 放置配方，随后有界轮询结果槽 0 非空并 `QUICK_MOVE` 领取，最后用新鲜库存差核对 `crafted`。残留不计入本次产出。
- 熔炼**不自动取货**：`smelt_load` 只投料并做有界“加工中”观察后返回，不占用玩家输入；`smelt_take` 另行取货。见 D6。

## D6 熔炼两段式的取舍

缺口要求把“已投料、加工中、已取货”分开，且等待期间不得一直占用玩家输入。把三段压进一个动作会迫使执行器在动作内长时间轮询或代持输入，两者都违反要求，因此拆成两个动作：

- `smelt_load`：开熔炉（无 `furnace` 字段报 `not_furnace`），从玩家背包把输入移入槽 0、可选燃料移入槽 1，做 ≤3s 的有界加工观察，报 `stage:'loaded'/'cooking'` 与 `cooking` 比例后返回。熔炉继续加工，动作不持有输入。
- `smelt_take`：重开同一熔炉，读输出槽 2；空则 `slot_empty`；`QUICK_MOVE` 领取并用新鲜库存差核对；把槽 0/1 的剩余输入/燃料记为 `residue`。

理由：两段式让调用方在 `loaded` 后去做别的事，回来再 `taken`；三段回执仍分别可见（`smelt_load` 给 loaded+cooking，`smelt_take` 给 taken）。单一动作无法在不占用输入的前提下表达“以后再来取”。

## D7 桥与工具面

- `command-registry.ts`：新写动作加入 `WRITE_ACTIONS`（`open_container`/`move_item`/`close_menu`/`craft_table`/`smelt_load`/`smelt_take`）；`read_menu` 只读。回执行段在 `settle`、`beginExecution` 与结果装配处透传。
- 期限：`open_container`/`read_menu`/`close_menu` 15s、`move_item` 30s、`craft_table` 60s、`smelt_load`/`smelt_take` 120s。
- `coding-host/game-bridge-tools.ts`：增 `game_open_container`、`game_read_menu`、`game_move_item`、`game_close_menu`、`game_craft_table`、`game_smelt_load`、`game_smelt_take`。
- mcp-server `tools.ts`：增 `menu_open`、`menu_snapshot`、`menu_click`、`menu_close`、`menu_craft`，映射 `menu.*` RPC；`menu_snapshot` 为只读，其余为写。
- 连接清理：`disconnect()` 在断开前 best-effort 调一次 `menu_close`，避免容器跨重连残留；调用方动作内不静默关菜单。

## 单测验收清单

- open → read → move → close：断言 `menu_open/menu_snapshot/menu_click/menu_click/menu_close` 工具序列，回执携带 `containerId` 身份，`moved` 后置条件 met。
- `menu_click` 身份变化：快照 `containerId` 在执行器中途改变 → `menu_mismatch`，且不发出任何 `menu_click`。
- `craft_table` 成功：开台、放置、产物出现、点结果槽、库存差核对 → `crafted` met。
- `craft_table` 失败：`unknown_recipe`、`menu_not_crafting`（且不调 `menu_craft`）、产物始终不出现 → `not_confirmed`。
- 熔炉 `smelt_load`/`smelt_take`：以熔炉快照夹具（含 progress 比例）验证 `loaded`/`cooking`/`taken` 三段；剩余输入/燃料记为 `residue` 且不计入产出；空产物槽报 `slot_empty`。
- 现有 `game-host` 用例保持通过。

## 增量拆分

1. 模组菜单框架（D1–D4）+ mcp-server 工具（D7）。
2. AIRI 契约、注册表、菜单/熔炉执行器与工具（D5、D6）。
3. 单测（本批验收清单）。
4. 真机验收（未执行，属后续批次）。

## 实现落点

- 模组：`handlers/MenuHandlers.java`（新增）、`handlers/ItemJson.java`（新增，自 `LocalPlayerHandlers.itemJson` 抽出）、`handlers/LocalPlayerHandlers.java`（改用它）、`client/McpFabricClient.java`（注册）、`mcp-server/src/tools.ts`。`gradle.properties` 保持 0.2.5。
- AIRI：`game-host/command-contract.ts`、`game-host/command-registry.ts`、`game-host/index.ts`、`game-host/index.test.ts`、`shared/eventa/game-host.ts`、`coding-host/game-bridge-tools.ts`。

## 风险与回退

- **原始熔炉计数不可得**：1.21.1 只有比例公开 API；回执给比例，不猜 tick。“烧出铁锭”的完成仍以 `smelt_take` 的库存差为准，不以比例为准。
- **整栈转移**：`move_item`/`smelt_load` 按整栈迁移，`count` 是最小目标；无法精确切片。真机验收需记录实际迁移量，不把 `requested` 当精确值。
- **菜单同步是服务端中继**：打开、点击、放置都在后续 tick 结算；执行器全部有界轮询，超时即诚实失败。
- **其他玩家移动材料**：`containerId` 变化即 `menu_mismatch`，不继续沿用旧槽位假设。
- **回退**：新动作走独立域工具与写锁，不改既有 `craft`/`use`/`equip` 语义；`game_craft`（2×2）保持原样。

## 明确不做

- 附魔台、铁砧、酿造台、村民交易、告示牌等特殊界面（MC-4f）。
- 精确定量切片、跨容器批量转移、自动整理。
- 熔炼完成的事件等待与自动取货（本批为两段式手动取货）。
- 真机验收：本批只交代码、单测、类型检查。

## 实施记录

### 代码实施（2026-09-16）

- **模组（0.2.5 保持）**：新增 `MenuHandlers`，注册 `menu.open`/`menu.snapshot`/`menu.click`/`menu.close`/`menu.craft`；`menu.open` 在工作线程有界轮询，不阻塞渲染线程。新增 `ItemJson` 并从 `LocalPlayerHandlers` 抽出共享物品形状。`McpFabricClient` 注册新处理器。
- **mcp-server**：`tools.ts` 增 `menu_open`/`menu_snapshot`/`menu_click`/`menu_close`/`menu_craft`（`menu_snapshot` 只读，其余写）。
- **AIRI**：`command-contract.ts` 增 7 个动作、`moved` 后置条件、`GameMenuReceipt`/`GameMenuSlotReceipt`/`GameMenuSnapshotReceipt`/`GameFurnaceProgress`/`GameMovedReceipt`/`GameSmeltReceipt` 与参数；`command-registry.ts` 增写动作与回执透传；`index.ts` 增 7 个域工具、参数映射、期限、菜单助手（快照/点击/转移/打开）与执行器，`disconnect()` best-effort 关菜单；`shared/eventa/game-host.ts` 同步动作、后置条件与结果形状；`game-bridge-tools.ts` 增 7 条桥工具。
- **偏离与取舍**：
  - 熔炼拆为 `smelt_load`/`smelt_take`（D6）。
  - 熔炉载荷用 `lit/litProgress/cookProgress` 比例，不用原始 tick（D2）。
  - 玩家背包槽判定用 `slot.container instanceof Inventory` + `Slot.getContainerSlot()`，因 1.21.1 无 `InventorySlot`（D2）。
  - `move_item`/`smelt_load` 按整栈转移，`count` 为最小目标（D5）。
  - MC-4a 遗留的 `coding-host/game-bridge-tools.test.ts` 工具清单仍停在 10 项（缺 `equip`/`use`），一并补到当前的 19 项。
- **检查**：
  - `pnpm -F @proj-airi/stage-tamagotchi exec vitest run src/main/services/airi/game-host` → 11 passed / 1 skipped（153 passed / 1 skipped）。
  - `pnpm -F @proj-airi/stage-tamagotchi exec vitest run src/main/services/airi/coding-host` → 4 passed（26 passed）。
  - `pnpm -F @proj-airi/stage-tamagotchi typecheck` → 退出 0。
  - `pnpm exec eslint <改动文件>` → 退出 0。
  - `D:\mcpfabric\mcp-server` `npm run build` → 成功。
  - `$env:JAVA_HOME='C:\Program Files\Java\jdk-21'; .\gradlew.bat :1.21.1:build` → BUILD SUCCESSFUL。
- **NOT-RUN**：真机验收（箱子存取指定数量、工作台 3×3、熔炉投料/加工/取货、`menu_mismatch` 真机、多人移动材料）。

### 真机验收修复（2026-09-14，模组 0.2.6）

- **现象**：无容器打开时（`containerMenu == inventoryMenu`），`menu.snapshot` 与 `menu.button` 返回 `internal: UnsupportedOperationException: Unable to construct this menu by type`（`MenuType` 的兜底构造在玩家背包菜单路径上被触发）；有容器打开时两者均正常。
- **修复**：两个 RPC 增加前置判断，玩家背包菜单直接返回 `no_menu`（与 `menu.close` 一致），不再读取背包菜单的类型/槽位。`:1.21.1:build` 成功，版本升至 0.2.6（jar SHA-256 `a560895a…da81e`）。
- **验收状态**：修复前已完成 MC-4a 全项与 MC-4b 的“打开箱子 + 快照”；修复后继续 MC-4b 余项。
- **真机验收（2026-09-14）PASS**：箱子存取的定量转移与核对、`craft_table`（木板 16→8 + 箱子 ×1）、熔炼 load/progress/take（铁锭 +3、残留煤 15）全部通过。
- 记录：[evidence/mc-4/live-acceptance-20260914.md](./evidence/mc-4/live-acceptance-20260914.md)。
