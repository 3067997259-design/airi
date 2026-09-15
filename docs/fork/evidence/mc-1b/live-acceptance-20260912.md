# MC-1b 真机验收（2026-09-12）

结果：**① 无变化不重复 PASS；② 有变化一次 PASS；③ 预算耗尽 PASS；④ 记忆隔离 PARTIAL（捕获/作用域/断连重连/不以旧坐标移动 PASS，回答级标注未观测到，原因见下）。** 环境：MC-1b 构建（`pnpm -F @proj-airi/stage-tamagotchi build` + preview，CDP 9250），NeoForge 夹具客户端（MCPFabric 桥 25599 / MCP server 25600，7 个领域工具在脸），世界身份 `connection-scoped`（fork 不报世界名），life-mode autonomous（验收时临时把 `cooldownMinutes` 调 0、`dailyBudget` 按场景设定，验后恢复 0/30）。

## 场景结果

| 场景 | 操作 | 实测 |
| --- | --- | --- |
| ① 无变化不重复 | 连续两次手动心跳（无新游戏事件） | 两条 `life/heartbeat` 均 `outcome=no-stimulus`、`gate=no-stimulus`；无 `life/decision`、无 `self_decide`、无 `chat.send` |
| ② 有变化一次 | 真实回合强制 `game_move_to` 至世界边界外（不可达）→ 产生 `tool/result`（`status=failed`、`endReason=unreachable`、`checked=true`、快照 `health:0`）→ 心跳 ×2 | 第 1 次心跳 `emitted` → 恰好 1 次考虑回合（`self_decide` → `life/decision action=note`）；第 2 次心跳 `no-stimulus`，无新决策 |
| ④ 记忆隔离 | 连接 A 记录观察 + 聊天写入"箱子在 100 64 100" → 断开重连（连接 B）→ 提问"之前的箱子在哪里？" | 捕获 PASS：新事实带 `sourceContext.gameWorld{worldId: connection-scoped, connectionId: <A 的 uuid>, observedAt: 观察时间}`（读取解析修复后）；断连→重连 PASS（连接 B 的 `connectionId` 不同）；两次提问均**没有**发出指向旧坐标的 `game_move_to`（工具调用分别为：无 / `game_observe`）。回答级"历史标注"未观测到：`memory/retrieved` 的 `memoryIds` 为空，该 profile 的 embedding 检索无命中（`embeddingSource=api`, `model=voyage-4-large`，检索返回 0 条），标注没有机会进入提示。标注逻辑由单测覆盖，并与考虑刺激共用同一函数。 |
| ③ 预算耗尽 | 复活角色（和平模式）→ 强制不可达 `game_move_to` 制造新事件 → `dailyBudget` 设为 `budgetUsed=5` → 运行中 `game_collect`（sand, maxCount 16, r=12）→ 心跳 → `game_status` → `game_cancel` | 心跳 `outcome=gated, gate=budget`，无 `life/decision`、无工具调用（不发起新规划）；`game_status` 期间为 `running`（commandId `80d0fc72…`）；`game_cancel` → `status=cancelled/endReason=cancelled`；collect 回执 `cancelled, checked:true, actual:0, met:false`，带世界绑定 `connectionId e4d3e7fc…`；命令由 main 注册表独立执行，未因预算耗尽被取消或旁路 |

## 实机中发现并修复的缺陷（均有回归测试）

1. **跨进程作用域碰撞**：`connectionGeneration` 每次启动从 1 重计，旧连接的记忆会被当当前。D1 增 `connectionId`（每次成功连接 `randomUUID()`，随回执/结果贯通），记忆作用域键在 `connection-scoped` 时使用 `connectionId`。
2. **读取丢弃 `gameWorld`**：`parseMemorySourceContext` 只重建已知字段，持久化的 `gameWorld` 在读回时丢失。已补解析（缺必要字段则丢弃）并加测试。
3. **断连重连被 CP-1 状态机拒绝**：`connect()` 每次先 `disconnect()`，空 URL 断开已 withdraw，二次 withdraw 抛 `withdrawn -> withdrawn`，重连失败。`disconnect()` 改为仅在存在旧连接时 withdraw，加回归测试。
4. **普通对话检索未标注世界**：历史标注原先只在考虑刺激里。已把 `labelGameFact`/`worldScopeKey` 提取到 `stores/modules/game-world.ts`，并接到 `chat.ts` 的记忆检索映射（注入前加 "Historical (world …)"/"Needs re-observation" 前缀）。

## 记录与限制

- ① 的心跳数：首轮心跳曾消费会话中遗留的历史事件（产生 1 次 `silence` 决策），随后进入干净状态再验证 `no-stimulus`；这与"无变化不重复"定义一致（新变化才唤醒）。
- ② 的事件同时是死亡候选（快照 `health:0`，角色在验收前已死亡，与 MC-1b 无关）；投影按死亡 salience 1.0 处理。
- ④ 的应用级"检索→回答"缺口属 MQ-2 的语义召回阈值问题，不是 MC-1b 标注逻辑失败：同批已批准事实（向量 `active`、指纹 `api:...:voyage-4-large` 一致）中，词面重合查询可召回（`R06 测试植物` → similarity 0.593；`L07C-TOKEN` 精确查询 → 0.517，均 > `DEFAULT_MEMORY_SIMILARITY_THRESHOLD=0.5`），语义改写查询（`那个被重命名的植物叫什么名字`、`之前改过名的那个植物是什么`）全部低于阈值返回 0 条。`embeddingMigration total:0` 是无需回填的正常状态（新事实入库自带 active 向量）；`memory.list({reviewStatus})` 报错属调用方误用（该接口只接受 `memoryType` 字符串，已澄清）。阈值/召回校准留待 MQ-2 完整闸门（MC-2 前）。标注已在单测中覆盖（跨世界、跨连接、过期、无 gameWorld 直通）。
- 工具：`game_move_to` 不可达 → `unreachable`（有界失败，符合 MC-0b）。
