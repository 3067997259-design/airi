# MC-4f 规范：生活与内容模组（阶段 6，P2）

日期：2026-09-14。状态：实施完成（代码 + 单测 + 类型检查；真机验收未做）。上游：[玩家能力缺口](./minecraft-player-capability-gaps.md) §2 阶段 6 P2 行、§2「指定位置放置与建造」行、§2「村民交易」行、§2「附魔、铁砧、酿药与其他工作站」行、§2「告示牌、书、地图与特殊界面」行、§4.4、[MC 执行计划](./minecraft-player-capability-execution-plan.md) §6.6、[MC-4b 规范](./mc-4b-spec.md)（菜单框架）、[MC-4d 规范](./mc-4d-spec.md)（类型化失败与回执模式）、[MC-2 内容模组探索](./mc-2-content-mod-exploration.md)。依赖：MC-4b ✓（`menu.open/snapshot/click/close/craft`、`containerId` 身份、槽位作用域）、MC-4a ✓（物品形状 `ItemJson`）、MC-4d ✓（类型化失败）。模组基线 0.2.5。

通过条件（缺口文档原文）：目标玩法从获取材料到产出核对的完整流程通过。

本批只交代码、单测、类型检查。真机验收（附魔台/铁砧/酿造台/石切机/织布机/信标、村民交易、书与地图正文、告示牌双面、定点放置与材料核对）属后续批次。

## 范围与已做项

- **本批新增**：
  - 模组：`menu.button`（通用按钮）、`menu.select_trade`（村民交易选择）、`menu.set_name`（铁砧命名）、`item.read`（书/地图）、`block.read_sign`（告示牌双面）；`interact.placeBlock` 的 `sneak`/`yaw`/`expectBlockId`。
  - AIRI：`menu_action`、`read_item`、`read_sign`、`place` 四个领域动作与回执；`placed` 后置条件；两个只读观察动作保持 `checked=false`。
- **不在本批新增（复用 MC-4b）**：`open_container`/`read_menu`/`move_item`/`close_menu`/`craft_table`/`smelt_*`。工作站菜单的打开、读取、受控槽位操作、关闭全部走既有框架，本批只为特殊工作站补“按钮、交易选择、命名”三类业务原语。

## D1 工作站菜单与业务规则（模组）

工作站菜单复用 MC-4b 的 `containerId` 身份：槽位号只属于某个 `containerId`，菜单变化即失效。本批新增的三条业务原语在**当前打开的菜单**上执行，并在 AIRI 侧先用 `menu.snapshot` 的 `type` 做前置校验：

| 原语 | 允许的菜单类型 | 业务规则 |
| --- | --- | --- |
| `menu.button { id }` | 任意 `AbstractContainerMenu` | 调 `clickMenuButton(player, id)`；返回 `accepted` |
| `menu.select_trade { index }` | `minecraft:merchant`（`MerchantMenu`） | `setSelectionHint(index)` + `tryMoveItems(index)`；返回选中报价摘要 |
| `menu.set_name { text }` | `minecraft:anvil`（`AnvilMenu`） | 走菜单的改名路径 `setItemName(text)`（会发 `ServerboundRenameItemPacket`）；有界长度 |

类型不匹配由 AIRI 报 `menu_not_trade` / `menu_not_anvil`；模组仅作为第二层防线。

## D2 通用按钮（模组 `menu.button`）

- `AbstractContainerMenu.clickMenuButton(Player, int)` 是原版公开入口；附魔台的等级按钮、石切机的切石配方按钮、织布机的图案按钮、信标的增益按钮都经它结算。
- 返回 `{ accepted, containerId, type }`。`accepted` 由原版返回值决定，不伪造。
- 不校验 `id` 的业务含义：按钮 id 由各家菜单自己定义。AIRI 侧用 `type` 保证“在正确的菜单上按正确的按钮 id”，但按钮 id 的合法性由原版处理。
- 在渲染线程执行（`ClientMc.call`），与 MC-4b 一致。

## D3 村民交易选择（模组 `menu.select_trade`）

- 仅当 `player.containerMenu instanceof MerchantMenu` 时可用，否则返回 `{ accepted:false, error:'menu_not_trade' }`。
- 调用顺序为原版 `setSelectionHint(index)` 后 `tryMoveItems(index)`：前者把选择提示发给服务端，后者在本地把输入槽填成该报价所需材料。1.21.1 两个方法均为公开 API（已 `javap` 校验）。
- 返回选中报价摘要：`offer = { result: { id, count }, inputs: [{ id, count }, ...], outOfStock? }`。输入来自 `MerchantOffer.getCostA()`/`getCostB()`（空栈跳过）。读取不到报价时诚实返回 `accepted:false` 与 `error:'no_offer'`，不猜。
- 交易**结果**（库存/报价变化）由调用方另读 `menu.snapshot` 或 `get_inventory` 核对；本原语只负责“选中”这一步。

## D4 铁砧命名（模组 `menu.set_name`）

- 仅当 `player.containerMenu instanceof AnvilMenu` 时可用，否则返回 `{ accepted:false, error:'menu_not_anvil' }`。
- 调 `AnvilMenu.setItemName(String)`：原版实现会在文本变化时更新结果槽并发送改名包（1.21.1 返回 boolean，已 `javap` 校验）。
- 长度有界：截断到原版 `AnvilMenu.MAX_NAME_LENGTH`（并与 AIRI 侧上限一致）；空串是合法的“清除命名”。
- 返回 `{ accepted, name }`；`name` 是实际应用的字符串（截断后），不返回原始请求。

## D5 内容读取（模组 `item.read` / `block.read_sign`）

内容读取是**观察**：只回报读到的文本，不执行、不把文本当指令。AIRI 侧对应回执保持 `checked=false`。

### `item.read { slot? }`（默认主手）

| 物品 | 读取 | 回执字段 |
| --- | --- | --- |
| `minecraft:written_book` | `DataComponents.WRITTEN_BOOK_CONTENT` | `title`/`author`/`generation`/`pages[]` |
| `minecraft:filled_map` | `DataComponents.MAP_ID` + `MapItem.getSavedData(id, level)` | `map = { id, scale?, dimension? }` |
| 其他 | 无 | `unsupported:true`，`error:'unsupported_item'` |

- **书**：`title()` 是 `Filterable<String>`，取 `get(false)`；`pages()` 是有界列表，`getPages(false)` 取纯文本；页数与每页长度都有上限（见下），超限置 `truncated:true` 并截断，不做原始 NBT 转储。
- **地图**：`MAP_ID` 的 `id()` 一定可读；`scale`/`dimension` 需 `MapItem.getSavedData(...)` 命中客户端已同步的地图数据。客户端拿不到时**只给 id** 且 `unsupported:true`，不推断。
- `slot`：可选背包槽（0-8 快捷栏、9-35 主背包、36-39 护甲、40 副手）；缺省用主手。

### `block.read_sign { x, y, z }`

- `level.getBlockEntity(pos) instanceof SignBlockEntity` 才读，否则 `not_sign`。
- 返回 `lines`（正面 4 行）与 `back`（背面，仅当与正面不同或非空时给）；`SignText.getMessages(false)` 逐行 `Component.getString()`。
- 行数与每行长度有界，超限 `truncated:true`。
- 区块未加载（`getBlockEntity` 为 null 且方块非告示牌/读不到）时诚实失败，不伪造空牌。

### 上限（模组与 AIRI 两侧一致）

- 书：页数 ≤ 32，每页 ≤ 1024 字符。
- 告示牌：每个面 ≤ 4 行，每行 ≤ 256 字符。

## D6 精确放置与材料核对

### D6.1 模组 `interact.placeBlock` 扩展

保留原签名与默认行为（`face` 默认 `up`），新增三个可选参数：

- `sneak`（默认 false）：在使用前 `setShiftKeyDown(true)`，使用后恢复。这样对着箱子/熔炉/工作台等交互方块放置时不会打开界面，而是真正放置。
- `yaw`（默认不改）：在使用前 `setYRot(yaw)`（并同步 `yRotO`），使楼梯、原木、朝向类方块按请求朝向放置。
- `expectBlockId`（默认不校验）：使用后读 `pos` 与 `pos.relative(face)` 两处方块，任一等于期望 id 即 `placed:true`，否则 `placed:false` 并给出实际 id。用两处覆盖“点可替换方块（草/雪）时落在 pos 自身”的情况。

返回 `{ result, placed?, blockId?, position? }`。**默认调用（无新参数）与今天完全一致**：`face` 默认 up、不潜行、不改朝向、不校验。既有移动端口 `host-port.placeBlock` 与 AIRI `use mode block` 的调用不变。

### D6.2 AIRI `place` 动作

`place { x, y, z, face?, itemId?, sneak?, yaw?, count?, attempts? }`。

- **坐标语义**：`x,y,z` 是要放置的**目标格**。执行器按 `face` 反推支撑格 `support = target - face`，调 `place_block(support, face, sneak?, yaw?, expectBlockId)`。
- **批量**：`count` 默认 1、上限 16。第 i 块目标为 `target + face * i`（沿 `face` 方向逐格），每块都单独选择物品、放置、核对。`attempts` 是每块的最大尝试次数（默认 3、上限 10）。
- **物品选择**：`itemId` 缺省用当前手持物；否则按热键栏→主背包（主背包需换入空热键栏槽，无空槽即 `not_in_inventory`）选择。每块前重选一次，以覆盖“整栈用完、同物品还在别的槽”的情况。
- **材料统计**：每块前后读同一物品的背包总数，必须减少 ≥1；未减少即该块 `ok:false`，原因 `not_in_inventory`（耗尽）或 `not_confirmed`（放置请求被拒/未确认）。
- **世界核对**：每块后新鲜 `get_block(target)`，id 等于期望方块 id（`itemId` 的恒等映射；别名类如红石粉→红石线属已知限制）才算 `ok`。目标格非空气/不可替换时记 `blocked`，不点击。
- **回执**：`placed { itemId, requested, placed, blocks: [{ x, y, z, ok, reason? }] }`，其中 `placed` 是逐块核对通过的块数。`sneak`/`yaw` 原样透传给 `place_block`。
- **后置条件**：取 `placed`（`target = requested`，`actual = 逐块核对通过数`，`met = actual >= target`）。理由：放置有可由**新鲜世界读取 + 背包差**独立复核的产物，和 `crafted`/`moved` 同类；给 `none` 会把“报告了逐块结果”误当成成功。
- **类型化失败**：`not_in_inventory`（无料/料尽）、`blocked`（目标格被占）、`not_confirmed`（放置请求未产生方块）。

## D7 AIRI 领域动作与回执

新增动作、参数与回执：

| 动作 | 参数 | 回执 | 后置条件 |
| --- | --- | --- | --- |
| `menu_action` | `{ action:'button'\|'select_trade'\|'set_name', id?, index?, text? }` | `menuAction { containerId, action, accepted?, offer?, name? }` | `none` |
| `read_item` | `{ slot? }` | `itemContent { itemId, title?, author?, pages?, map?, truncated?, unsupported? }` | `none`（观察） |
| `read_sign` | `{ x, y, z }` | `signContent { lines, back?, truncated? }` | `none`（观察） |
| `place` | `{ x, y, z, face?, itemId?, sneak?, yaw?, count?, attempts? }` | `placed { itemId, requested, placed, blocks[] }` | `placed` |

- `menu_action` 执行器：先 `menu_snapshot` 取 `containerId`/`type`（无菜单 → `no_menu`），按 `action` 校验类型后调对应原语；把模组返回的 `accepted`/`offer`/`name` 透传。模组报 `menu_mismatch` 时失败且不继续。
- 类型化错误：`menu_not_trade`、`menu_not_anvil`、`menu_mismatch`、`no_menu`、`not_in_inventory`、`blocked`、`not_confirmed`。
- **观察纪律**：`read_item`/`read_sign`/`menu_action` 的回执行段写 `kind:'none'`，因此 `executeDomainCommand` 的 `checked` 恒为 false；书/牌文本只出现在回执里，绝不进入任何 `checked` 成功路径。文本是不可信输入，调用方不得把它当指令执行。

## D8 与 MC-2 知识的衔接

- 学习过程归现有 MC-2 探索运行器与知识分级（`lead`/`candidate`/`verified`，见 `packages`/`shared/mc2` 与 `mc-2-content-mod-exploration.md`）。**本批不新建桥、不改 MC-2 运行器**。
- 当某个动作需要未知的机器/工作站规则、当前原语无法执行时，按 `unsupported_station` 返回，并在回执里带上菜单 `type`。它只说明“这条路径目前没有可执行原语”，不会把读懂配方记成实测成功。
- 知识可信度的提升仍由 MC-2 用游戏结果驱动；本批只**诚实报告能力上限**。

## D9 工具面与期限

- `command-registry.ts`：`menu_action`、`place` 进 `WRITE_ACTIONS`；`read_item`、`read_sign` 为只读；新回执在 `settle`、`beginExecution`、结果装配处透传。
- 期限：`menu_action` 20s、`read_item` 10s、`read_sign` 10s、`place` 60s。
- `DOMAIN_TOOLS` 增 `game_menu_action`、`game_read_item`、`game_read_sign`、`game_place`；`toGameCommandParams` 增四条映射；`coding-host/game-bridge-tools.ts` 增四个桥工具；`shared/eventa/game-host.ts` 同步动作、回执形状与后置条件。
- mcp-server `tools.ts`：增 `menu_button`（写）、`menu_select_trade`（写）、`menu_set_name`（写）、`read_item`（读）、`read_sign`（读）；`place_block` 增 `sneak`/`yaw`/`expectBlockId` 可选字段。

## 单测验收清单

- `menu_action`：按钮成功、`select_trade` 返回选中报价、`set_name` 返回应用名；`menu_not_trade`/`menu_not_anvil`/`no_menu` 类型化失败且不发出对应原语调用。
- `read_item`：成书返回有界页数与 `truncated` 标记；不可读物品 `unsupported_item`；未支持物不产生成功后置条件。
- `read_sign`：成功读取正面/背面行；非告示牌 `not_sign`。
- `place`：单块成功（世界核对 + 背包差）、缺料 `not_in_inventory`、目标格被占 `blocked`、批量逐块结果与有界 `attempts`；`sneak`/`yaw` 透传到 `place_block`。
- 不可信内容纪律：书/牌文本不出现在任何 `checked=true` 的成功路径。
- 现有 `game-host`、`coding-host` 用例保持通过（桥工具清单同步）。
- 模组 `:1.21.1:build` 与 mcp-server `npm run build` 通过；`gradle.properties` 保持 0.2.5。

## 增量拆分

1. 模组：按钮/交易/命名（D1–D4）、内容读取（D5）、`placeBlock` 扩展（D6.1）+ mcp-server 工具（D9）。
2. AIRI：契约、注册表、四个动作与执行器（D6.2、D7、D8、D9）。
3. 单测（本批验收清单）。
4. 真机验收（未执行，属后续批次）。

## 实现落点

- 模组：`client/handlers/MenuHandlers.java`（增 `menu.button`/`menu.select_trade`/`menu.set_name`）、`client/handlers/ContentHandlers.java`（新增，`item.read`/`block.read_sign`）、`client/handlers/InteractHandlers.java`（`placeBlock` 扩展）、`client/McpFabricClient.java`（注册）、`mcp-server/src/tools.ts`。`gradle.properties` 保持 0.2.5。
- AIRI：`game-host/command-contract.ts`、`game-host/command-registry.ts`、`game-host/index.ts`、`game-host/index.test.ts`、`shared/eventa/game-host.ts`、`coding-host/game-bridge-tools.ts`、`coding-host/game-bridge-tools.test.ts`。

## 风险与回退

- **1.21.1 映射差异**：`clickMenuButton`、`MerchantMenu.setSelectionHint`/`tryMoveItems`/`getOffers`、`AnvilMenu.setItemName`、`WrittenBookContent.title()/getPages(boolean)`、`SignBlockEntity.getFrontText()/getBackText()` 均以 `javap` 在 1.21.1 named 映射上校验后再用；跨版本需单独验证。
- **地图数据客户端可得性**：`scale`/`dimension` 依赖 `MapItemSavedData` 已同步；拿不到只给 id 并标 `unsupported`，不推断。
- **朝向方块的映射**：`expectBlockId` 用物品 id 的恒等映射；红石粉→红石线等别名会报 `not_confirmed`，属已知限制，绝不改报成功。
- **整栈与批量**：`place` 不做精确切片；每块消费一个物品，材料不足即停并逐块报告。
- **回退**：新动作走独立域工具与写锁，不改 `move_to`/`craft`/`use` 语义；`place_block` 的默认参数不变，既有移动端口不受影响。

## 明确不做

- 附魔台/酿造台/石切机/织布机/信标的**站位摆放**与产出核对（本批只到按钮原语，完整玩法组合属后续）。
- 交易的结果核对与补货轮询（本批只到“选中报价”）。
- 收水、红石自动化设施（阶段 6 的后半，另批）。
- MC-2 运行器与知识分级改动。
- 真机验收：本批只交代码、单测、类型检查。

## 实施记录

### 代码实施（2026-09-14）

- **模组（0.2.5 保持）**：
  - `MenuHandlers` 增 `menu.button`（`AbstractContainerMenu.clickMenuButton`，返回 `accepted/containerId/type`）、`menu.select_trade`（仅 `MerchantMenu`，`setSelectionHint` + `tryMoveItems`，返回 `offer` 摘要；非交易菜单 `menu_not_trade`，越界 `no_offer`）、`menu.set_name`（仅 `AnvilMenu`，`setItemName` 按原版上限截断，返回 `accepted/changed/name`；非铁砧 `menu_not_anvil`）。
  - 新增 `handlers/ContentHandlers.java`：`item.read`（成书 `WRITTEN_BOOK_CONTENT` 的 title/author/generation/pages；填图 `MAP_ID` + `MapItem.getSavedData` 的 scale/dimension，拿不到只给 id 并标 `unsupported`；其他物品 `unsupported_item`；页 32/1024 与标题 256 上限）与 `block.read_sign`（`SignBlockEntity` 正面/背面各 4 行 × 256，超限 `truncated`；非告示牌/未加载 `not_sign`）；`McpFabricClient` 注册。
  - `InteractHandlers.interact.placeBlock` 增可选 `sneak`（`setShiftKeyDown` + `input.shiftKeyDown` + `options.keyShift`，用后恢复）、`yaw`（`setYRot`/`yRotO`/`setYHeadRot`，用后恢复）、`expectBlockId`（核对 `pos.relative(face)` 与 `pos` 两处）。默认参数不变。
  - mcp-server `tools.ts`：`place_block` 增 `sneak/yaw/expectBlockId`；新增 `menu_button`/`menu_select_trade`/`menu_set_name`（写）、`read_item`/`read_sign`（读）。
- **AIRI**：`command-contract.ts` 增 4 动作、4 组参数、`GameMenuActionReceipt`/`GameTradeOfferReceipt`/`GameItemContentReceipt`/`GameSignContentReceipt`/`GamePlacedBlock`/`GamePlacedReceipt` 与 `placed` 后置条件；`command-registry.ts` 增 `menu_action`/`place` 写动作与四类回执透传；`index.ts` 增期限（20/10/10/60s）、4 个域工具、`toGameCommandParams` 映射、执行器（`readMenuSnapshot` 类型前置、`get_block` 新鲜核对、背包差、`ensurePlaceItemSelected`、`parseTradeOffer`）与结果装配；`shared/eventa/game-host.ts` 同步动作、`placed` 后置条件与四类结果；`game-bridge-tools.ts` 增 4 桥工具；桥工具清单测试同步到 28 项。
- **偏离与取舍**：
  - `place` 后置条件取 `placed`（`target=requested`，`actual=新鲜 `get_block` + 背包差核对通过数`）：产物可由新鲜读取独立复核，与 `crafted`/`moved` 同类。
  - 批量语义：`x/y/z` 为目标格，支撑格 = 目标 − `face` 单位向量；第 i 块沿 `face` 逐格，逐块选择/放置/核对；`attempts` 为每块上限。
  - `sneak` 同时设实体标志、输入标志与键位映射（`// NOTICE:` 说明服务端 GUI 抑制读同步输入，真机时序待验）。
  - 地图 `scale`/`dimension` 客户端不可得时只回 `id` 并标 `unsupported`，不推断。
  - `expectBlockId` 用物品 id 的恒等映射；红石粉→红石线等别名会报 `not_confirmed`（已知限制，不改报成功）。
  - `menu_action` 的 `accepted=false` 报 `not_confirmed`，不把被拒按钮当成功。
- **检查**：
  - `pnpm -F @proj-airi/stage-tamagotchi exec vitest run src/main/services/airi/game-host` → 197 passed / 1 skipped（基线 181 / 1；新增 16 项）。
  - `pnpm -F @proj-airi/stage-tamagotchi exec vitest run src/main/services/airi/coding-host` → 26 passed（4 files）。
  - `pnpm -F @proj-airi/stage-tamagotchi typecheck` → 退出 0。
  - `pnpm exec eslint <改动文件>` → 退出 0。
  - `D:\mcpfabric\mcp-server` `npm run build` → 成功。
  - `$env:JAVA_HOME='C:\Program Files\Java\jdk-21'; .\gradlew.bat :1.21.1:build` → BUILD SUCCESSFUL。
- **NOT-RUN**：真机验收（附魔台/铁砧/酿造台/石切机/织布机/信标按钮、村民交易与补货、书与地图正文、告示牌双面、定点放置与材料核对、`sneak` 服务端时序）。

### 真机验收（2026-09-14）— PASS

- `place` 火把（新鲜世界读 + 库存核对）、`read_sign`（正面两行）、`read_item` 成书（title/author/pages）、铁砧 `set_name`、村民 `select_trade`（输入槽 3 绿宝石、产物 2 面包）、附魔台 `button`（服务端结算：青金石 3→2、剑 +unbreaking 1，`button_applied`）。
- **验收中修复（模组 0.2.11/0.2.12 + AIRI）**：`menu.button` 改发原版按钮点击包（原实现只改客户端本地副本，返回 accepted 但服务端零结算），并修掉嵌套 `ClientMc.call` 造成的 8 秒死锁；`game_place` 增 `menu_open` 预检；`button` 回执改为 `sent` + `applied`（有界菜单重读）。
- **补测（同日，服务端升级后）**：石切机按钮（结果槽 `chiseled_stone_bricks`）、织布机按钮（结果槽出现成品旗）、酿造台（配料/燃料消耗、酿造完成）、`sneak` 放置不打开菜单、告示牌双面（正/背）、服务端 `world.findBlocks` 近优先 + collect 近→远候选全部 PASS。
- **信标按钮（规范修正）**：D2 原假设“信标按钮经 `clickMenuButton` 结算”不成立——`BeaconMenu` 不实现 `clickMenuButton`，原版信标用独立的 `ServerboundSetBeaconPacket`。真机：按钮点击包发出（`button_sent`）但无结算（`applied:false`、无效果），行为诚实；支持信标需新增专用原语（不在本批）。
- **R8 修复（模组 0.2.13）**：`menu.select_trade` 增发 `ServerboundSelectTradePacket`、`menu.set_name` 增发 `ServerboundRenameItemPacket`（原实现只改客户端本地菜单）。复测：交易结算（背包 3→2 绿宝石、0→2 面包）、补货（`uses` 归零、`outOfStock:false`）、铁砧改名服务器侧（服务端 `custom_name`）全部 PASS。
- **地图正文（0.2.12）**：空地图生成后首次读 `unsupported`（同步前），重读得到 `map {id, scale, dimension}`；服务端 `data get` 复核 `map_id`。
- **限制**：`sneak` 后的服务端潜行状态可能滞后（普通放置也未弹菜单，待观察）；信标需专用原语（同 D2 修正）。
- 记录：[evidence/mc-4/live-acceptance-20260914.md](./evidence/mc-4/live-acceptance-20260914.md)。
