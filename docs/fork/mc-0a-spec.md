# MC-0a 契约规范：Fabric 适配器连接与只读观测

日期：2026-09-11。状态：规范定稿，实施未开始。批次：MC-0a。

本文件钉死 [MC 执行计划](./minecraft-execution-plan.md) 中 MC-0a 的契约。计划管批次与验收；本规范管连接拓扑、配置形状、工具边界与退役范围。MC-0a 交付的是**连接与只读观测**；工具面注册属 MC-0c。

## 决策记录

| # | 决策 | 内容 | 理由 |
| --- | --- | --- | --- |
| M0-D1 | 直连 HTTP/SSE，不起子进程 | `game-host` 用 StreamableHTTP transport 直连 MCPFabric 自带的 MCP server 的 HTTP 端点；不 spawn 子进程、不写 stdio shim | 用户选择。审计确认现有 MCP 接线仅支持 stdio，但 SDK 1.30.0 自带 StreamableHTTP；直连省一层进程与生命周期管理 |
| M0-D2 | mcp-config 判别联合 | mcp 服务器配置从 stdio-only 改为判别联合 `kind: 'stdio' \| 'streamable-http' \| 'sse'`；类型改名去掉 Stdio | 现状是以 stdio 命名的 strict schema，多处引用；加 URL 必须整体改造，不能只加字段 |
| M0-D3 | game-host 私有 session | game-host 自持 MCP session，不走 `createMcpServersService`、不进渲染端 mcp store | MCPFabric 暴露 50+ 工具含 operator 级；通用服务会把全部工具暴露给所有窗口 |
| M0-D4 | 只读 | MC-0a 只调客户端控制组的读工具；不得调用任何写/管理工具 | 首批验收只覆盖观察；写动作与终态回执属 MC-0b |
| M0-D5 | 退役留遗产 | 删 spark 入口；`gaming-minecraft` 等保留并标 dormant | spark 广播入口与双调度冲突，必须删；minecraft 模块观察面在 MC-0c/CP-3 可能复用，不删 |
| M0-D6 | 配置进 main | 配置存 `game-host.json`（userData）+ eventa invoke，不用 localStorage + `ui:configure` | `ui:configure` 只到渲染端 peer，与 main 单一所有者冲突；仿 memory-host/coding-host |

## 连接拓扑（定稿）

```
Electron main
  └─ game-host（新服务，M0-D3 私有 session）
       │  StreamableHTTP  →  http://127.0.0.1:<mcpPort>/mcp
       ▼
  MCPFabric 自带的 Node MCP server（我们不做它的进程管理，用户自行运行）
       │  HTTP POST /rpc + GET /events(SSE)，bearer token 鉴权
       ▼
  MCPFabric Fabric 客户端 mod（Minecraft 内）
       ▼
  Minecraft 世界
```

**对计划的一处更正**：MC 计划写"拉起/附着 MCPFabric MCP server 子进程，stdio"。实际 MCPFabric 已自带一个 Node MCP server：mod 内嵌 HTTP 桥（`127.0.0.1:25599`，JSON-RPC + SSE，bearer token），Node server 在客户端与 MCP 之间做转换，并以 **stdio 或 streamable HTTP** 暴露 MCP。因此 game-host 面对的是**那个 Node server 的 HTTP 端点**，不需要我们 spawn 任何进程。本规范以直连为准。

端口与端点：以 MCPFabric 的实际配置为准（其 README 记 MCP server 默认 streamable HTTP 于 `25600` 的 `/mcp`）。规范不写死端口号，只钉：地址必须解析为 loopback，端口与 token 从 `game-host.json` 读。

## 契约定稿

### MCP 服务器配置判别联合（M0-D2）

```ts
/** One MCP server entry: stdio child, or a remote HTTP/SSE endpoint. */
export type ElectronMcpServerConfig
  = | { kind: 'stdio', command: string, args?: string[], env?: Record<string, string>, cwd?: string }
    | { kind: 'streamable-http', url: string, headers?: Record<string, string> }
    | { kind: 'sse', url: string, headers?: Record<string, string> }

/** Common optional fields shared by every transport. */
export interface ElectronMcpServerCommon {
  enabled?: boolean
  requestTimeoutMs?: number
  maxTotalTimeoutMs?: number
}

export interface ElectronMcpConfigFile {
  mcpServers: Record<string, ElectronMcpServerConfig & ElectronMcpServerCommon>
}
```

改名与影响面（审计确认，实施须逐一处理）：

| 文件 | 现状 | 变更 |
| --- | --- | --- |
| `apps/stage-tamagotchi/src/shared/eventa/index.ts:263-277` | `ElectronMcpStdioServerConfig` / `ElectronMcpStdioConfigFile` | 改名去掉 `Stdio`，改为判别联合 |
| `apps/stage-tamagotchi/src/shared/mcp-config.ts:30-56` | stdio-only 的 `.strict()` Zod schema | 改为按 `kind` 的判别 Zod schema；`.strict()` 保留 |
| `apps/stage-tamagotchi/src/main/services/airi/mcp-servers/index.ts:44,456-462,689-695` | `McpServerSession.transport` 类型为 `StdioClientTransport`；两处构造 | 类型放宽为 union；按 `kind` 分支构造 `StdioClientTransport` 或 `StreamableHTTPClientTransport` |
| `apps/stage-tamagotchi/src/renderer/pages/settings/modules/mcp-config.ts:2-3,67-68,99-100,144` 与 `mcp.vue:3,74` | 渲染端表单映射 stdio 字段 | 表单须能表达 transport 选择；至少支持 stdio 与 streamable-http |

**stdio 专有字段守卫**：`session.transport.stderr?.on(...)`（`mcp-servers/index.ts:469`）只对 stdio 有效；`closeSession`（164-172）的 `client.close()` 是通用的。分支处必须显式判 `kind === 'stdio'` 才能触碰 `stderr`。

MCP SDK 导入路径（照既有 house 风格，带 `.js` 子路径）：现有 stdio 为 `@modelcontextprotocol/sdk/client/stdio.js`；新增 `@modelcontextprotocol/sdk/client/streamableHttp.js`（`StreamableHTTPClientTransport`）。`SSEClientTransport`（`client/sse.js`）上游已标 deprecated，规范只要求 stdio 与 streamable-http 两条可用，SSE 作为判别联合的第三方以便未来，不要求 MC-0a 验证。

### 认证与边界

```ts
/** Local-only guard for the game bridge endpoint. Throws on a non-loopback host. */
export function assertLoopbackEndpoint(url: string): void {
  const host = new URL(url).hostname
  if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost')
    throw new Error(`game bridge endpoint must be loopback, got ${host}`)
}
```

规则：

1. `assertLoopbackEndpoint` 只在主机为 `127.0.0.1`、`::1` 或 `localhost` 时通过；否则抛错，连接不建立。
2. bearer token 从 `game-host.json` 读，作为 `Authorization: Bearer <token>` header 发送。token 不入库、不入日志。
3. 不做任何端口猜测或 fallback 扫描；地址必须来自配置。

### game-host 配置

```ts
/** Persisted at <userData>/game-host.json. */
export interface GameHostConfig {
  /** MCP endpoint of the MCPFabric Node server. Loopback only. */
  url: string
  /** Bearer token for the mod bridge. Optional only if the server disables auth. */
  token?: string
  /** Client control-group tools to expose; empty means "read-only default set". */
  allowedTools: string[]
}
```

存盘位置与形状仿 `memory-host.json`（`apps/stage-tamagotchi/src/main/services/airi/memory-host/index.ts:57`）与 `coding-host.json`（`coding-host/index.ts:56`）。

`allowedTools` 是白名单，不是黑名单——规范 D4 要求只读，故 MC-0a 期间该名单只含读工具（`get_status`、`get_self`、`get_inventory`、`get_blocks_region` 等）。写与管理工具即便在 MCPFabric 中存在也不得进入名单。

### 服务落点

| 落点 | 内容 |
| --- | --- |
| `apps/stage-tamagotchi/src/main/services/airi/game-host/index.ts` | `setupGameHost(context, options, userDataDir)`，仿 journal-host 结构 |
| `apps/stage-tamagotchi/src/shared/eventa/game-host.ts` | invoke 契约（连接状态、只读观测） |
| `apps/stage-tamagotchi/src/main/index.ts` | provider 注册（仿 304-309 的 `dataBackupHost`），并加入 `mainWindow` 的 `dependsOn`（319 行）以触发 eager 构建 |
| `apps/stage-tamagotchi/src/renderer/bridges/game-host.ts` | 渲染端 facade（MC-0a 可为最小：状态查询） |

MCP 客户端复用：用 `@modelcontextprotocol/sdk` 的 `Client` 自建 session（仿 `mcp-servers/index.ts` 的 `startServer` 与重连退避），**不**复用 `createMcpServersService`（它把全部工具暴露给所有窗口）。重连退避常量可参考 `mcp-servers/index.ts:84-87`。

## 旧入口退役（M0-D5）

### 删除

| 目标 | 处理 |
| --- | --- |
| `packages/stage-ui/src/tools/character/orchestrator/spark-command.ts` | 删除 |
| `packages/stage-ui/src/stores/ai/chat-llm/tool-resolver.ts` | 删 `resolveSparkCommandTools`（103-124）、`sparkCommandTools` 选项（34-39）与相关解构/合并/导入 |
| `packages/stage-ui/src/tools/character/orchestrator/index.ts:1` | 去掉 `spark-command` 的 re-export |
| `spark-command.test.ts` | 删除 |

`spark-notify` 是另一条路径，**不退役**。`spark-command-shared.ts` 若仅被 `spark-command.ts` 消费，随之删除。

### 必须修的测试（否则删除会连带失败）

两个 provider 测试**直接 import `createSparkCommandTool` 当 schema 夹具**（测嵌套可空 schema 的转换）：

- `packages/stage-ui/src/libs/providers/providers/openrouter-ai/index.test.ts:8,53,86`
- `packages/stage-ui/src/libs/providers/providers/azure-openai/index.test.ts:5,38,72`

处理：改为一个等价的本地夹具工具（保留嵌套可空 schema 形状），或直接引用仍保留的 `spark-command-shared.ts` 的 schema。不得为了省事保留 `spark-command.ts`。

其余测试（`tool-resolver.test.ts` 的 `sparkCommandTools: []`、`llm.test.ts:12-27,49-58` 的 mock）随选项移除同步调整。

### 保留并标 dormant（加 `// NOTICE:`）

| 目标 | 理由 |
| --- | --- |
| `packages/stage-ui/src/stores/modules/gaming-minecraft.ts` | 观察面在 MC-0c/CP-3 可能复用 |
| `packages/stage-ui/src/stores/chat/context-providers/minecraft.ts` | 同上 |
| `packages/stage-ui/src/components/modules/GamingMinecraft.vue` | 设置页入口 |
| 设置路由页 `packages/stage-pages/src/pages/settings/modules/gaming-minecraft.vue` | 路由 |
| `packages/stage-ui/src/composables/use-modules-list.ts:197-204` | 模块网格条目 |
| `packages/stage-ui/src/composables/use-data-maintenance.ts:70` | reset hook |

dormant 语义：无 announcer 时 `servicePresent` 为 false、`configured` 为 false、`createMinecraftContext` 返回 null、设置页显示 offline。`// NOTICE:` 注释须写清：来源（MC-0a 退役 spark 入口）、为何保留（MC-0c/CP-3 复用观察面）、移除条件（MC-0c 决定是否重建该面）。

`integrations/minecraft`（mineflayer 服务）不删，README 已有 Deprecation Notice；MC-0a 只确保它不被任何流程启动。

## 环境与夹具

| 环境 | 定义 | 用途 |
| --- | --- | --- |
| A（验收） | 本地 Fabric offline-mode 专用服，固定种子，模组仅我们的 fork，op 命令仅此环境开 | 确定性验收 |
| B（陪玩） | LAN 世界或自建服关 online-mode，同一客户端 + 固定离线身份 | 主线冒烟 |

夹具（岩浆坑、饥饿、僵尸、封闭目标、标记点）**归属 MC-0b**；MC-0a 只需能连上并读到正确状态，不建夹具。

资源测量：记录第二客户端 CPU、内存、帧率与最低可用画质；方法为在环境 A 静止与移动各观察一段，记录数值。不作性能结论，只留数据。

## 版本发现

`get_status` 返回世界与版本字段。game-host 在连接建立后调一次并缓存：

```ts
/** Cached at connect; feeds the version-transplantation smoke and later contracts. */
export interface GameWorldIdentity {
  /** Minecraft version string reported by the mod, e.g. '1.21.1'. */
  minecraftVersion: string
  /** World identifier; falls back to a connection-scoped id when unavailable. */
  worldId: string
  dimension: string
  playerUuid: string
}
```

缓存位置：game-host 闭包状态（仿 memory-host 的 `connection`/`lastError`）。不作为 MC-0a 的验收重点，只要求能读出 `minecraftVersion` 且非空。

## 工作项与通过条件

| # | 交付 | 通过条件 |
| --- | --- | --- |
| 1 | mcp-config 判别联合 + 类型改名 + Zod schema | 现有 stdio 配置仍可解析；streamable-http 条目可解析；`.strict()` 生效；相关包 typecheck 通过 |
| 2 | 传输分支构造 + stderr 守卫 | stdio 与 streamable-http 各能建立 session；stdio 之外不触碰 `stderr` |
| 3 | game-host 服务 + 配置 + provider 注册 | 服务随主窗口 eager 构建；`game-host.json` 读写；只读观测 invoke 可用 |
| 4 | loopback 守卫 + token | 非 loopback 地址被拒；token 作为 header 发送；token 不进日志 |
| 5 | 只读观测链路（确定协议脚本，不经 LLM） | 双环境下读到位置、背包、世界绑定与采集时间 |
| 6 | 旧入口退役 + 两个 provider 测试修复 | spark 工具不在工具面；两个 provider 测试以新夹具通过；minecraft 遗产标 dormant |
| 7 | 1.21.11 移植冒烟 + 资源测量 | 同补丁在 1.21.11 构建并跑只读观测；资源数值记录 |

## 设计不变量

1. **零工具面泄漏**：MC-0a 期间 MCPFabric 的任何工具都不进入模型工具面（`useLlmToolsStore` 与 toolset prompts 均无变化）。
2. **只读**：MC-0a 期间不调用任何写或管理工具；`allowedTools` 只含读工具。
3. **仅 loopback**：非 `127.0.0.1`/`::1`/`localhost` 的地址一律拒绝，不建立连接。
4. **旧路径零副作用**：`spark:command` 广播不再驱动任何游戏行为；工具面中无 `builtIn_emitSparkCommand`。
5. **私有 session**：game-host 的连接不暴露给渲染端 mcp store，也不经 `createMcpServersService`。
6. **token 不外泄**：token 不出现在日志、journal 或任何 IPC 返回中。
7. **遗产不删除**：minecraft 观察面代码保留且带 `// NOTICE:`；无 announcer 时保持 offline 而非报错。

## 验收场景

| 场景 | 期望与证据 |
| --- | --- |
| 环境 A 只读观测 | 位置、背包、世界绑定正确，附采集时间（不变量 2） |
| 环境 B 主线冒烟 | 身份/观察通过，与环境 A 同形（不变量 2） |
| 非 loopback 拒绝 | 配一个非 loopback url → 连接不建立、错误可解释（不变量 3） |
| stdio 回归 | 既有 stdio MCP 服务器仍能连接与列出工具（工作项 1、2） |
| 退役生效 | 聊天中无 spark 工具；广播 spark:command 无游戏副作用（不变量 4） |
| 零工具面变化 | 对比 MC-0a 前后工具面清单一致（不变量 1） |
| 移植冒烟 | 1.21.11 构建 + 只读观测通过，不推断全量兼容（工作项 7） |
| 遗产 dormant | 设置页显示 offline 而非崩溃；无报错（不变量 7） |

结果记录沿用 fork 惯例：PASS/FAIL/BLOCKED/NOT-RUN 加证明范围；「禁止用演示冒充通用结论」。

## 明确不做

- 不做工具面注册（属 MC-0c）。
- 不做有界移动、取消、租约、终态回执（属 MC-0b）。
- 不做生存反射（属 MC-0d）。
- 不管理 MCPFabric Node server 的进程（用户自行运行）。
- 不验证 `sse` 传输（上游已 deprecated；联合中保留但不强制）。
- 不删除 `integrations/minecraft` 与 minecraft 观察面。
- 不做 UI（状态页可留到 MC-0c）。

## 与执行计划的关系

- [minecraft-execution-plan.md](./minecraft-execution-plan.md)：MC-0a 的批次与验收在本规范细化。更正一处：拓扑改为直连 MCPFabric 的 MCP server HTTP 端点，无子进程（见"连接拓扑"）。
- [wave-b-execution-plan.md](./wave-b-execution-plan.md)：MC-0a 在 B 波次的切入口为工作项 1–3（环境搭建最长，越早开跑越好）。
- [ep-0-spec.md](./ep-0-spec.md)：`game_adapter` ownerKind 与 `game` 证据桶供 MC-0c；MC-0a 不注册工具面故不触及。
- [cp-0-spec.md](./cp-0-spec.md)：无关；MC-0a 不经插件协议。

## 实施修正记录（2026-09-11）

固定 fork commit 后按源码核对，两处与规范文字有最小偏离：

1. **`get_status` 不返回世界字段**。实际只返回 `minecraftVersion` 与 side/capabilities 等。`worldId` 按规范回退为 `connection-scoped`；`dimension` 改从 `get_self`（`player.getState`，客户端专属）读取；`playerUuid` 两个读工具都不提供，留空。`game-host` 连接后调 `get_status`，再 best-effort 调 `get_self` 合并缓存，验收要求的"能读出 `minecraftVersion` 且非空"不变。
2. **token 拓扑澄清**。game-host 直连的 Node MCP server 的 HTTP 端点只绑定 loopback、不校验 Authorization；真正需要 token 的是 Node server 到模组桥（`127.0.0.1:25599`），token 经 `MCPFABRIC_TOKEN` 环境变量传入。`game-host.json` 的 token 仍按规范作为 `Authorization: Bearer` 发送（直连型端点保留契约）。

细节与构建指纹见 [固定记录](./evidence/mc-0a/mcpfabric-pin.md)。

## 本轮交付与检查

本轮只新增本规范文档并更新 MODS.md 索引。未安装 MCPFabric、未建 fork、未编写 Java、未运行游戏、未改动产品代码。MCPFabric 的端口与端点以其实际配置为准；规范只钉 loopback 约束与配置来源。文中代码锚点为 2026-09-11 工作区实际位置，行号漂移以符号名为准。
