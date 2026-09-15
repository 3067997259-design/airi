# MC-0a 真实环境只读观测记录（单机首跑）

日期：2026-09-11 21:04（本地时间）。结果：**PASS（单机/本地世界，部分覆盖 MC-0a 工作项 5）**。

## 环境

| 项 | 值 |
| --- | --- |
| 启动器/实例 | PCL，版本隔离目录 `...\.minecraft\versions\AIRI` |
| 游戏 | Minecraft 1.21.1，单人世界（integrated server） |
| 模组 | 我们的构建 `mcpfabric-0.2.1+1.21.1.jar`（SHA-256 `9157530201c9a7…41bf`） |
| 桥 | `http://127.0.0.1:25599`，`requireAuth: true`（token 不记录，不进库） |
| MCP server | 我们的构建 `mcpfabric-mcp-server@0.2.0`，HTTP 模式，`http://127.0.0.1:25600/mcp` |
| 探针 | `game-host/observation.integration.test.ts`（直接 MCP 协议，不经 LLM） |

## 命令

```powershell
# 1) MCP server（后台）
cd D:\mcpfabric\mcp-server
$env:MCPFABRIC_URL='http://127.0.0.1:25599'
$env:MCPFABRIC_TOKEN='<redacted>'
$env:MCPFABRIC_TRANSPORT='http'
$env:MCPFABRIC_HTTP_PORT='25600'
node dist/index.js

# 2) 探针
$env:MCPFABRIC_URL='http://127.0.0.1:25600/mcp'
$env:MCPFABRIC_REPORT_PATH="$env:TEMP\mc0a-observation.json"
pnpm -F @proj-airi/stage-tamagotchi exec vitest run src/main/services/airi/game-host/observation.integration.test.ts
```

结果：1 file / 1 test passed（1.57s）。

## 观测报告（节选）

```json
{
  "capturedAt": 1789131877440,
  "identity": {
    "minecraftVersion": "1.21.1",
    "worldId": "connection-scoped",
    "dimension": "minecraft:overworld",
    "playerUuid": ""
  },
  "position": { "x": 6.5, "y": 75, "z": -1.5 },
  "inventoryKeys": ["selectedSlot", "hotbar", "main", "armor", "offhand"],
  "regionKeys": ["dimension", "volume", "count", "truncated", "blocks"],
  "regionSample": {
    "dimension": "minecraft:overworld",
    "volume": 75,
    "count": 39,
    "truncated": false,
    "blocks": [
      { "x": 6, "y": 74, "z": -1, "id": "minecraft:grass_block" },
      { "x": 5, "y": 75, "z": -1, "id": "minecraft:grass_block" },
      { "x": 5, "y": 75, "z": -4, "id": "minecraft:short_grass" },
      { "x": 8, "y": 75, "z": -2, "id": "minecraft:tall_grass" }
    ]
  }
}
```

判定：
- 版本与维度：`minecraftVersion` 非空；`dimension` 来自 `get_self`，与画面一致。
- 位置：有限数值，与可见地形一致；采集时间已记录。
- 背包：`get_inventory` 返回完整结构（hotbar/main/armor/offhand）。
- 区域读取：`get_blocks_region` 返回 75 体积、39 非空气方块（dirt/grass/short_grass/tall_grass），与截图地形吻合。
- 只读：全程只调 `get_status`/`get_self`/`get_inventory`/`get_blocks_region`（不变量 2）。
- `worldId` 按规范回退 `connection-scoped`，`playerUuid` 留空（fork 读工具不暴露，见固定记录）。

## 未覆盖 / NOT-RUN

- 环境 A（本地 Fabric offline 专用服）与环境 B（LAN/自建服关 online-mode）未搭建；本记录是单机（integrated server）首跑。
- 未走 AIRI `game-host` 服务的应用内 invoke（需重建并重启 Electron 后验证）。
- 设置页传输表单走查、退役/遗产真机复验、零工具面泄漏对比未执行。
- 1.21.11 移植冒烟与资源测量未执行。
