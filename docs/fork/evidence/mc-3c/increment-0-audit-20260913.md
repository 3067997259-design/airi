# MC-3c 增量 0 审计：未记录代码与基线（2026-09-13）

状态：完成。本轮只对照磁盘代码与测试，未跑游戏真机。上游：[MC-3c 规范](../../mc-3c-spec.md)、[执行计划](../../minecraft-player-capability-execution-plan.md) 5.1。

## 1. 已落盘但未记录的实现

| 项 | 位置 | 审计结论 |
| --- | --- | --- |
| 双端点 `serverUrl` | `shared/eventa/game-host.ts:59`、`game-host/index.ts:201-225`、`1592-1610`、`1628`、`1660-1662` | 配置读写、连接、失败降级（`no_server`）完整。服务端连接不发送 Bearer 头。Node MCP server 不校验该头，模组令牌经 `MCPFABRIC_TOKEN` 环境变量传递。记录为有意行为。 |
| 聊天指令摄取 | `game-host/chat-commands.ts`、`game-host/index.ts:1399-1505`、`renderer/bridges/game-host-install.ts:46-88`、`shared/eventa/game-host.ts:209` | 轮询、游标播种、去重、限频（1 条/2s）、白名单加提及过滤、leader 回合、取消打断完整。未经真机验收。 |
| `game_drop` | `command-contract.ts:33`、`command-registry.ts:79`、`game-host/index.ts:1182-1253` | 执行器完整：快捷栏查找、主背包换槽、逐次投掷、库存差与槽位空双重核对（`verifiedBy`）。 |
| `game_locate` | `command-contract.ts:35`、`command-registry.ts:81`、`game-host/index.ts:1255-1279` | 读取服务端玩家列表；失败分类 `player_not_online` 与无位置。 |
| 设置页配置面 | `GamingMinecraft.vue`、`stores/modules/game-host.ts` | 原缺 `serverUrl` 与 `movement.planner`。本轮已补。`chatCommands` 字段随 X-10 新配置形态添加。 |

## 2. 审计发现（供 X-10 与 MC-3c-1 处理）

1. **两种 chat 事件形状不一致**：客户端事件只有 `text`（含 `<sender>` 前缀）与 `sender`（`ClientEvents.java:19-29`）；服务端事件用 `player`、`uuid`、`text`（无前缀，`GameEvents.java:20-26`）。`chat-commands.ts` 只认 `sender`。当前 `poll_events` 不在 `SERVER_FIRST_TOOLS`，走客户端桥，所以链路可用。X-10 必须归一两种形状。
2. **自身回声过滤不完整**：`isChatCommandEvent` 按 `senderUuid` 过滤自身消息，但客户端事件不带 uuid。当前靠管理员白名单间接兜底。X-10 需要自身玩家名或 uuid；可能要在模组侧补 `player.getState` 的 `name`/`uuid`，或给客户端 chat 事件补 uuid。
3. **`poll_events` 描述与发射源不符**：工具描述宣称方块破坏/放置与维度变化事件，模组没有发射源。X-04 修正描述，不加假事件。
4. **`serverUrl` 无授权头**：见第 1 节，按有意行为记录。
5. **规范头部不一致**：`mc-2c-spec.md`、`mc-2d-spec.md` 已修正为“已完成（见文末实施记录）”。

## 3. 基线（2026-09-13 20:51–20:57）

| 检查 | 结果 |
| --- | --- |
| 全量单测 `pnpm -F @proj-airi/stage-tamagotchi exec vitest run` | 760 passed / 4 failed / 2 skipped（106 文件）。失败集中在 `plugins/index.test.ts`（gamelet 注入与停止，确定性，2 项）与 `http-server/static-assets/paths.test.ts`（Windows 路径断言与 symlink EPERM，2 项）。一次运行另含 `controls-island/index.test.ts` 1 项，二次未复现（闪烁）。均与 MC 无关。 |
| MC 区域定向 `vitest run src/main/services/airi/game-host src/shared/mc2` | 150 passed / 1 skipped |
| `pnpm -F @proj-airi/stage-tamagotchi typecheck` | 0 |
| `pnpm -F @proj-airi/stage-ui typecheck` | 0 |
| eslint（本轮改动文件） | 0 |

## 4. 本轮改动

- 修正 `mc-2c-spec.md`、`mc-2d-spec.md` 头部状态。
- 修订 `mc-3c-spec.md` D4：三层触发（`admins` / `blocked` / 概率采样）、`\` 前缀跳过、上下文、可沉默；D5 夹具行与增量 1 描述同步。
- 设置页新增 `serverUrl` 与 `movement.planner`（`GamingMinecraft.vue`、`stores/modules/game-host.ts`、i18n en 与 zh-Hans）。

## 5. 未完成项（转入后续）

- `game_drop` / `game_locate` 真机验收（X-07）：等游戏客户端在线，随 MC-3c-1 一起。
- `chatCommands` 设置页字段：随 X-10 新配置形态实现。
- 服务端能力组验证与聊天端到端：MC-3c-1。
