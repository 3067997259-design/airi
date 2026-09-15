# 1.21.1 菜单数据包核对

日期：2026-09-14。只读核对，没有修改外置模组，没有操作运行中的游戏。

核对对象为 `D:/mcpfabric/.gradle/loom-cache/minecraftMaven/net/minecraft/` 下的 `minecraft-common-48f5f74c97` 和 `minecraft-clientOnly-48f5f74c97`。

版本目录为 `1.21.1-loom.mappings.1_21_1.layered+hash.2198-v2`。使用本机 `javap -c -p -classpath <对应 jar> <类名>` 读取方法调用。

| 类与方法 | 字节码中的调用关系 |
| --- | --- |
| `net.minecraft.world.inventory.AnvilMenu.setItemName` | 校验名字，修改本地 `itemName` 和结果槽组件，调用 `createResult`，返回布尔值。方法内没有发送数据包 |
| `net.minecraft.client.gui.screens.inventory.AnvilScreen.onNameChanged` | 调用菜单的 `setItemName`，随后构造 `ServerboundRenameItemPacket` 并调用连接的 `send` |
| `net.minecraft.client.gui.screens.inventory.MerchantScreen.postButtonClick` | 调用 `setSelectionHint` 和 `tryMoveItems`，随后构造 `ServerboundSelectTradePacket` 并调用连接的 `send` |

模组 `src/client/java/dev/mcpfabric/client/handlers/MenuHandlers.java` 259 行和 282 行只调用菜单方法。对应原语未发送上述数据包。

这些调用关系表明服务器同步步骤缺失。实际用户结果仍应通过“取出产物、关闭菜单、重读背包和消耗”补做真机核对。当前结果槽的本地变化不能单独证明服务器已结算。
