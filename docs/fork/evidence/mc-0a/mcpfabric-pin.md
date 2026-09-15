# MC-0a MCPFabric 候选固定记录

日期：2026-09-11。状态：fork 已建、commit 已固定、两个构建已通过。双环境与真机观测仍为 NOT-RUN。

## 仓库与固定点

| 项 | 值 |
| --- | --- |
| 上游 | `https://github.com/Etoryx/mcpfabric`（README 徽章与 GitHub API 均确认） |
| 我们的 fork | `https://github.com/3067997259-design/mcpfabric`，本地 `D:\mcpfabric` |
| fork 关系 | GitHub API：`fork: true`，`parent/source: Etoryx/mcpfabric` |
| 固定 commit | `1881470282f2c893a6aedc06390bff5984694e04`（"chore(release): bump version to 0.2.1"，2026-07-30） |
| 分支 | `main`（origin/main 与本地一致，工作区干净） |
| 版本 | 模组 `mod_version=0.2.1`（`gradle.properties`）；MCP server `mcpfabric-mcp-server@0.2.0` |
| 许可 | MIT（`LICENSE`） |
| MC 支持范围 | Stonecutter 13 节点：1.21.1–1.21.11（Java 21）与 26.1.2/26.2（Java 25）；Fabric Loader ≥ 0.19.3；Node ≥ 20 |
| 构建日期 | 2026-09-11 |

## 构建结果

| 产物 | 命令 | 结果 | SHA-256 |
| --- | --- | --- | --- |
| 模组 jar（1.21.1，v0.2.1） | `$env:JAVA_HOME='C:\Program Files\Java\jdk-21'; .\gradlew.bat :1.21.1:build` | BUILD SUCCESSFUL（9m34s） | `9157530201c9a775fa93d77f4e5f40e516822e8e428e4ef620054715c41341bf` |
| sources jar | 同上 | 成功 | `24d9a0222cb846bd0d69a5533f8725586dfa5bd15690ea69dce197583efbd626` |
| 模组 jar（1.21.1，v0.2.2，MC-0b P1/P2） | 同上（增量 48s） | BUILD SUCCESSFUL | `79ead8bb3ef8af2ce34a16fca72510672fc88e21c3cb20cd258c7f367e5eac75` |
| 模组 jar（1.21.1，v0.2.3，MC-0d 反射） | 同上（多次增量构建） | BUILD SUCCESSFUL | 最终客户端 `5d3daf2b7dee57319f5f69db7f875fdb19d98f671c8de3360ff69b40cd2fff78`（中间构建 17d2f9d5/a3e29535/5b6cb239 已被取代） |
| MCP server（Node） | `cd mcp-server; npm ci; npm run build` | tsc 通过，`dist/index.js` | — |

产物路径：`D:\mcpfabric\versions\1.21.1\build\libs\mcpfabric-0.2.1+1.21.1.jar`。不进库，仅写本地配置。

构建环境备注：
- Gradle wrapper 需要 9.6.0；直连 `services.gradle.org` 首次超时（wave-b 计划已预告）。用腾讯镜像 `https://mirrors.cloud.tencent.com/gradle/gradle-9.6.0-bin.zip` 下载并核对 wrapper 声明的 SHA-256（`bbaeb2fe…a01`）后预置到 `~/.gradle/wrapper/dists/gradle-9.6.0-bin/<hash>/`，Gradle 直接解包，不再联网。
- 本机 `JAVA_HOME` 是 JDK 17；构建必须显式设 JDK 21。MCP server 可用系统 `node v24.14.0`。

## 源码核对（影响实现的三处）

1. 读工具名与白名单一致：`get_status`、`get_self`、`get_inventory`、`get_blocks_region` 都在 `mcp-server/src/tools.ts` 目录中，`game-host` 的默认白名单无需改。
2. `get_status`（`info.status`，`InfoHandlers.java`）只返回 `mod/modVersion/minecraftVersion/side/serverPresent/playerCount/capabilities/methods`。**没有** `worldId`、`dimension`、`playerUuid`。`worldId` 落到规范的 `connection-scoped` 回退。
3. `dimension` 在 `get_self`（`player.getState`，`LocalPlayerHandlers.java`）里；该工具是客户端专属。`playerUuid` 两个读工具都不提供，留空。`game-host` 连接后先调 `get_status`，再 best-effort 调 `get_self` 合并身份。

## 拓扑与 token 事实

- `mcp-server` 默认 stdio；对 AIRI 用 HTTP 模式：`MCPFABRIC_TRANSPORT=http`、`MCPFABRIC_HTTP_PORT=25600`，端点 `http://127.0.0.1:25600/mcp`（`mcp-server/src/index.ts` / `config.ts`）。
- Node MCP server 的 HTTP 端点本身不校验 Authorization（只绑定 127.0.0.1）。真正需要 token 的是 Node server → 模组桥（`127.0.0.1:25599`），token 经环境变量 `MCPFABRIC_TOKEN` 传给 Node server，来源是游戏目录 `config/mcpfabric.config.json`。
- `game-host.json` 的 `token` 字段仍按规范发送 `Authorization: Bearer`（对直连型端点保留契约，当前拓扑下无害）。

## 本机运行命令（环境就绪后）

MCP server：

```powershell
cd D:\mcpfabric\mcp-server
$env:MCPFABRIC_TRANSPORT = 'http'
$env:MCPFABRIC_HTTP_PORT = '25600'
$env:MCPFABRIC_TOKEN = '<config/mcpfabric.config.json 里的 token>'
node dist/index.js
```

`game-host.json`（`<userData>/game-host.json`）：

```json
{
  "url": "http://127.0.0.1:25600/mcp",
  "allowedTools": []
}
```

确定性只读观测（不经 LLM，跳过条件：未设 `MCPFABRIC_URL`）：

```powershell
$env:MCPFABRIC_URL = 'http://127.0.0.1:25600/mcp'
pnpm -F @proj-airi/stage-tamagotchi exec vitest run src/main/services/airi/game-host/observation.integration.test.ts
```

断言内容：`minecraftVersion` 非空、`dimension` 非空、位置为有限数、背包有返回；当桥报告 `world_read` 能力时另测方块区域，否则在报告中记录跳过原因。输出带 `capturedAt` 的观测报告，供验收记录引用。

## 未完成（NOT-RUN）

- 单机（integrated server）只读观测已于 2026-09-11 PASS，见 [观测记录](./observation-20260911.md)。
- 环境 A（本地 Fabric offline 专用服）已搭（seed `-3029234016717445527`），只读观测 PASS，见 [环境 A 记录](./environment-a-observation-20260911.md)；服务端桥 mod 未装。
- 环境 B（LAN/自建服关 online-mode + 第二客户端固定离线身份）未搭建。
- 设置页传输表单走查、退役/遗产真机复验、零工具面泄漏对比未执行。
- 1.21.11 移植冒烟与资源测量未执行；1.21.11 构建命令为 `.\gradlew.bat :1.21.11:build`（未跑）。
