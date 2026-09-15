# MC-0a 环境 A 只读观测记录

日期：2026-09-11 23:18（本地时间）。结果：**PASS（客户端只读链路；服务端区域读取显式跳过）**。

## 环境

| 项 | 值 |
| --- | --- |
| 服务器 | 本地 Fabric 专用服，1.21.1 + loader 0.19.5（`fabric-server-mc.1.21.1-loader.0.19.5-launcher.1.1.2.jar`） |
| 服务器配置 | `online-mode=false`、`enforce-secure-profile=false`、`level-seed=-3029234016717445527`、`difficulty=easy`、`white-list=false`、端口 25565 |
| 服务端 mods | 仅 `fabric-api-0.116.17+1.21.1.jar`（**未装桥 mod**；MC-0a 客户端只读不需要） |
| 客户端 | AIRI 实例（桥 `127.0.0.1:25599`，token 不记录），用户名 `airitest`，23:14:49 进服 |
| MCP server | `mcpfabric-mcp-server@0.2.0`，HTTP `127.0.0.1:25600/mcp` |
| 探针 | 直接 MCP 协议（`observation.integration.test.ts`）+ 应用内 `game-host` devtools 探针 |

## 结果

直接探针（1/1 passed，报告 `capturedAt 1789139883762`）：

```json
{
  "identity": {
    "minecraftVersion": "1.21.1",
    "worldId": "connection-scoped",
    "dimension": "minecraft:overworld",
    "playerUuid": ""
  },
  "position": { "x": 23.69999998807907, "y": 85, "z": -4.459918772936465 },
  "inventoryKeys": ["selectedSlot", "hotbar", "main", "armor", "offhand"],
  "regionKeys": null,
  "regionSkipped": "world_read capability is absent (server side has no mcpfabric mod)"
}
```

应用内 `game-host`（CDP 9250）：

- `applyConfig` → `connected`；身份同上；
- `observe get_self` → 位置 (23.7, 85, -4.46)、维度 overworld、health 20、food 20；
- `observe get_inventory` → 五个结构键齐全；
- `observe get_blocks_region` → `Bridge error [no_server]`（服务端无桥，符合预期，白名单逻辑本身已放行该只读工具）。

判定：
- 位置、背包、世界绑定（版本+维度）、采集时间全部读到（工作项 5 的验收口径）；
- 区域方块读取依赖服务端侧桥，环境 A 当前形态下显式跳过并不影响本批验收；
- 零工具面泄漏此前已在应用内验证（50 → 50）；本记录不重复。

## 排障记录（供下次复用）

1. `无效会话`：服务器在 `server.properties` 修改前启动，运行进程仍用旧 `online-mode=true`；且 `enforce-secure-profile=true` 会拦离线客户端。两者已修正，重启后正常。
2. `no_client_player`：同机开了两个客户端，旧实例占着 25599 桥但没进世界，新实例进服却起不了桥（日志 `failed to start HTTP bridge`）。只保留一个客户端后恢复。
3. mod 在桥绑定失败时仍会打 `ready` 日志；可靠判据是 `HTTP bridge listening` 或 `netstat` 的 25599 属主。

## 未覆盖（NOT-RUN）

- 环境 B（LAN/自建服 + 第二客户端固定离线身份）未跑。
- 服务端装桥 mod 的能力组（`world_read`/`command`/`world_write`）未验证——MC-0b 夹具需要时装上并错开桥端口。
- 1.21.11 移植冒烟与资源测量未执行。
