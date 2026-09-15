# MC-1b 规范：世界作用域记忆、事件压缩、预算约束

日期：2026-09-12。状态：规范定稿，实施未开始。上游：[Minecraft 执行计划](./minecraft-execution-plan.md) MC-1b 行与 12 场景中的「记忆隔离」「模型预算耗尽」、[实现方向](./minecraft-fabric-implementation-direction.md) §证据与记忆（事件只在有意义变化时进入上下文；坐标绑定世界与维度；预算耗尽时停止新规划、有界动作服从截止与取消）。依赖 MC-1a（已验收）。

通过条件（计划原文）：**旧坐标不当作当前事实；无变化不重复调用模型；预算耗尽时有界动作仍服从截止与取消。**

本批不新增领域工具、不改 MCPFabric Java、不新建记忆引擎；只把游戏身份、事件与预算接到现有记忆/consideration/life-mode 链路上。

## D1 世界绑定贯通到结果与日志（main + 契约）

- `GameDomainResult` 增可选字段：

```text
world?: {
  worldId: string        // 连接缓存；不可得时为 'connection-scoped'
  dimension: string
  connectionGeneration: number  // 每次（重）连接递增；断线/换世界后可判别旧结果
}
```

- main game-host 在每个 `game_*` 结果与终态回执（含 `game_status` 的 `finalSnapshot` 分支）填充该字段；值来自连接建立时缓存的身份与当前代次，**不回退到上一次连接**。
- 回执 JSON（journal `tool/result.summary` 中序列化的 `GameDomainResult`）因此自带世界作用域，无需新事件类型。
- 断线/重连：`connectionGeneration` 已存在于信封与命令注册表（MC-0b）；本批只把它暴露到结果面。

## D2 世界作用域记忆（memory-core + stage-ui）

- `MemorySourceContext` 增可选字段：

```text
gameWorld?: {
  worldId: string        // fork 不报世界名时为 'connection-scoped'
  connectionGeneration: number  // 作用域键：无稳定 worldId 时跨连接即历史
  dimension: string
  observedAt: number     // 最近一次游戏观察/回执的时间；不是记忆写入时间
}
```

- **作用域键**：`worldId !== 'connection-scoped'` 时用 `worldId`；否则用 `worldId#connectionGeneration`（方向文档：无法取得稳定身份时仅使用当前连接作用域并禁止跨连接自动恢复）。换世界/重连后旧事实一律标注历史。

- **写入**：聊天回合捕获记忆时（`persistExtractions` 的调用侧），若该回合内出现过来自 game-host 的 `observed`/回执（即存在最近游戏结果），把最近的 `world` 与 `observedAt` 附加到 `sourceContext.gameWorld`。非游戏回合不附加。
- **注入与标注**（本批不做向量层过滤，只在注入/考虑层标注）：
  - 新 stage-ui 状态 `stores/modules/game-world.ts`：保存最近一次游戏结果的世界与观察（`worldId/dimension/observedAt/position`），由 game-host 工具结果更新，断连清空。
  - Minecraft 上下文提供者（`chat/context-providers/minecraft.ts`）输出：当前世界身份（已有）、最近观察时间与位置、"坐标类记忆/对话仅在世界与观察时间一致时才可作为当前事实；必须重新 `game_observe` 后再移动"。
  - 检索结果与考虑候选携带 `gameWorld` 时：世界不同 → 文案前缀"历史（世界 X，dimension）"；世界相同但 `observedAt` 超过新鲜阈值（默认 30 分钟）→ 前缀"需重新观察"。模型仍可以引用，但不得当作可直达的当前坐标。
- 接受：在另一个世界问"之前的箱子在哪" → 回答标注历史世界/需重新观察；journal 中不出现以旧坐标发起的 `game_move_to`（隔离由提示层保证，并由场景断言）。

## D3 事件压缩（life-mode consideration）

游戏事件只在有意义变化时进入考虑刺激；同因事件窗口内合并。规则钉死：

| 事件 | 是否产生候选 | 合并/优先级 |
| --- | --- | --- |
| `game_observe`/`game_status` 成功（只读） | 否 | 世界/位置变化由上下文提供者表达，不打断 |
| 终态回执（`succeeded/failed/cancelled/expired`，含 `reflex_preempted`） | 异常终态产生候选；干净成功不产生（呼叫方已在自己的回合里拿到结果） | 同 `commandId` 的移动进度合并为一条；`reflex_preempted` salience 0.8 |
| `game_collect`/`game_follow` 等长动作的中途轮询 | 否 | 只在异常终态出现 |
| 反射事件（hazard/hunger/attacked） | 是（经终态的 `reflex_preempted`/死亡体现） | 同 `cause` 以 `noveltyKey`（含 worldId）30 分钟合并 |
| 玩家游戏内聊天/死亡 | 死亡：是（`finalSnapshot.health<=0`，salience 1.0）；游戏内聊天：**本批不接入**（无事件流入口，外部内容来源保留，留待后续批次） | 死亡按 worldId 合并 |

- **无变化不重复**：沿用既有 `noveltyKey` + `consumedRefs` + 30 分钟窗口机制（本批把 worldId 纳入游戏事件 noveltyKey，跨世界不合并），不新增版本键；干净只读结果不进入候选即"无变化不调用模型"。无候选且无其他候选时沿用现有 `no-stimulus` 心跳门，不新增 gate 类型。

## D4 预算约束（复用 life-mode）

- 游戏事件驱动的考虑回合必须走现有 `claimDecision`（每日预算 + 冷却闸门）；预算用尽 → 心跳记 `budget` gate 的 `gated`，**不发起任何模型调用**。
- **有界动作不受预算影响**：预算/闸门只阻断新的规划回合；已提交的 game 命令由 main registry 按租约与 deadline 继续运行，用户取消优先（MC-0b/0c 语义不变）。预算耗尽不隐式取消命令、不自动开启旁路模型。
- 新增配置显示：设置页 life-mode 区块注明"游戏事件计入同一每日预算"（i18n en/zh-Hans，不改默认值）。

## 验收场景

| 场景 | 操作 | 期望 |
| --- | --- | --- |
| 记忆隔离 | 世界 A 记录箱子坐标 → 切世界 B 问"之前的箱子在哪" | 回答标注历史世界（或需重新观察）；不出现以旧坐标直发的 `game_move_to` |
| 无变化不重复 | 连接后连续触发心跳、游戏状态无变化 | 全部 `no-stimulus`（或既有非游戏 gate）；无新增模型调用与 `life/decision` 行动 |
| 有变化一次 | 产生一次死亡或一次采集终态，再触发两次心跳 | 恰好一次考虑回合消费该事件；重复心跳回到 `no-stimulus` |
| 预算耗尽 | `dailyBudget` 用尽后令心跳触发；同时有运行中的 `game_collect` | 心跳 `budget` gate；无新 `chat.send`；命令继续到完成/取消/到期后停止 |
| 旧世界结果不冒充当前 | 世界 A 的迟到回执在世界 B 送达 | 结果的 `connectionGeneration` 与当前不符；上下文与考虑不把它当当前事实（D1 字段可见） |

## 实现落点

- main：`services/airi/game-host/index.ts`（结果/回执/status 填 `world`）。
- 契约：`shared/eventa/game-host.ts`（`GameDomainResult.world`）。
- memory：`packages/memory-core/src/types.ts`（`sourceContext.gameWorld`）、`packages/stage-ui/src/stores/modules/memory.ts`（拷贝/展示/注入，捕获侧附加）。
- stage-ui：`stores/modules/game-world.ts`（新，最近观察）、`stores/chat/context-providers/minecraft.ts`（历史标注与新鲜度规则）、`stores/modules/life-mode.ts`（游戏事件投影与版本键）、设置页文案。
- 测试：main（world 字段与代次、断连缺省）、memory（捕获附加与拷贝）、life-mode（投影/合并/版本键矩阵）、上下文提供者（文案与新鲜度）、真机三夹具。

## 风险与回退

- **新鲜阈值**（30 分钟）是提示层规则，不是硬阻断；若真实使用中误报多，调整常量并记录，不改语义。
- **记忆写入附加**依赖回合内游戏结果；纯背景知识回合不附加，属预期。
- **事件压缩可能吞掉轻量变化**：只读 observe 不进候选是刻意取舍；如需要"看到新地形"类主动发言，留待 SP/LIFE 后续批次显式建模。
- 真机夹具需要双世界：环境 A 已有固定种子；第二个世界复用同一专用服的另一个世界存档（本地新建），只验证标注与命令隔离。

## 明确不做（本批）

- 记忆向量层按世界过滤、跨世界事实合并/迁移。
- 新领域工具、MCPFabric 改动、MC-2 知识入库与配方学习。
- 反射策略调整（MC-0d 已完成）与技能固化（MC-1c）。

## 本轮交付与检查

本轮新增本规范并更新 MODS.md 索引；不改产品代码、不建编辑器工程、不跑真机。实施与真机记录在后续增量中补齐。

## 实施记录（2026-09-12）

- **D1 世界绑定贯通**：`GameCommandReceipt` 增 `worldId`/`dimension`（`settle` 从命令信封填充，世界切换后迟到回执仍可归因）；`GameDomainResult.world?: { worldId, dimension, connectionGeneration }`；main 每个返回点填充——回执类用回执自身世界、status/idle 类用当前连接、断线两者皆空（不回退旧值）。
- **D2 世界作用域记忆**：`MemorySourceContext.gameWorld`（memory-core，含 `connectionGeneration`）；`copyMemorySourceContext` 拷贝；新 `stage-ui/stores/modules/game-world.ts` 保存最近观察（由 game-host 工具结果写入、桥检测到非 connected 时清空）；`chat.ts` 回合记忆 `sourceContext` 附加 gameWorld；minecraft 上下文提供者输出最近观察时间/位置与"历史坐标需重新观察"规则；考虑刺激对跨世界/跨连接/过期记忆加 `Historical (world …)` / `Needs re-observation (… minutes ago)` 前缀。实现中发现 fork 不报世界名，按方向文档把 `connectionGeneration` 纳入作用域键（`connection-scoped#<gen>`），跨连接事实一律历史。
- **D3 事件压缩**：`life-mode.ts` 新增游戏结果投影矩阵——`game_observe`/`game_status` 干净结果不产生候选；异常终态（含 `reflex_preempted`）0.5/0.8 salience；`finalSnapshot.health<=0` 死亡 salience 1.0；noveltyKey 含 worldId；游戏工具不再落入通用 `tool:` 桶。
- **D4 预算约束**：游戏事件走既有 `claimDecision`；心跳在预算耗尽时记 `budget` gate 且不调用模型；测试证明有刺激时也不发起 `chat.send`（有界命令由 main 注册表独立运行，不受影响）。
- **测试**：main game-host 42 例（新增回执世界字段、世界切换后迟到回执归因、结果 `world` 断言）；stage-ui life-mode 21 例 + game-world 1 例（只读不唤醒、异常终态与跨世界、死亡、记忆标注、预算耗尽不建模）；memory-core/stage-ui/stage-tamagotchi typecheck 0；eslint 0。
- **待跑（真机）**：记忆隔离（世界 A 记箱子 → 世界 B 询问）、无变化不重复（连续心跳）、有变化一次、预算耗尽（运行中 `game_collect`）、旧世界迟到回执；需 `build` + 重启 + 第二世界夹具。

## 真机验收（2026-09-12）

结果：**① 无变化不重复 PASS、② 有变化一次 PASS、③ 预算耗尽 PASS、④ 记忆隔离 PARTIAL**（捕获/作用域/断连重连/无自动移动 PASS；回答级历史标注未观测到，因该 profile 的 embedding 检索零命中，标注无机会进入提示；标注逻辑单测覆盖并与考虑刺激共用）。记录见 [evidence/mc-1b/live-acceptance-20260912.md](./evidence/mc-1b/live-acceptance-20260912.md)。

实机中发现并修复的缺陷（均有回归测试）：

1. **跨进程作用域碰撞**：`connectionGeneration` 每次启动重计，旧连接记忆会被当当前。D1 增 `connectionId`（连接成功时 `randomUUID()`，随结果/回执贯通），世界作用域键在 `connection-scoped` 时使用 `connectionId`。
2. **读取丢失 `gameWorld`**：`parseMemorySourceContext` 读回时只重建已知字段，`gameWorld` 被丢弃；已补解析（缺必要字段则丢弃该字段）。
3. **断连重连被 CP-1 拒绝**：`connect()` 先 `disconnect()`，空 URL 断开已 withdraw，二次 withdraw 抛 `withdrawn -> withdrawn`；`disconnect()` 改为仅在存在旧连接时 withdraw。
4. **普通对话检索未标注世界**：标注原仅存在于考虑刺激；`labelGameFact`/`worldScopeKey` 提取到 `stores/modules/game-world.ts` 并接入 `chat.ts` 记忆检索映射（注入前加历史/需重新观察前缀）。

限制：④ 的"检索→回答"缺口属 **MQ-2 的语义召回阈值问题**（默认 `DEFAULT_MEMORY_SIMILARITY_THRESHOLD=0.5`，voyage-4-large 对语义改写常给 0.4x；词面重合查询可正常召回）。新事实入库自带 active 向量、`embeddingMigration total:0` 为正常；标注逻辑单测覆盖。阈值/召回校准留待 MQ-2 完整闸门（MC-2 前）。
