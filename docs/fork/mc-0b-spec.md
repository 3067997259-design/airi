# MC-0b 契约规范：命令身份、租约、取消与终态回执

日期：2026-09-11。状态：规范定稿，实施未开始。批次：MC-0b。

本文件钉死 [MC 执行计划](./minecraft-execution-plan.md) 中 MC-0b 的字段级契约。计划给批次与通过条件；本规范给命令信封、状态机、租约、去重、回执与后置条件的最终形状，以及 Java 补丁 P1/P2 的确切范围。

MC-0b 横跨两侧：**Java 侧**（MCPFabric fork 补丁 P1、P2）与 **TS 侧**（game-host 的命令注册表与看门狗）。两侧各自实现，共用同一组夹具脚本。

## 决策记录

| # | 决策 | 内容 | 理由 |
| --- | --- | --- | --- |
| M1-D1 | TS 侧先于 Java 侧 | 命令注册表与状态机先用假执行器在无游戏环境下闭环，再接 Java | 去重、租约、回执形状不依赖游戏；先做能快速暴露设计错误，且不阻塞于 Java 构建 |
| M1-D2 | 去重键为连接代次 + 命令 ID | 键 `${connectionGeneration}:${commandId}`；同键同参数摘要返回已有状态，同键不同摘要拒绝 | 连接代次使旧世界的命令自动失效，无需单独的世界比对即可防重放 |
| M1-D3 | 参数摘要不含信封字段 | `paramsDigest` 只覆盖 action 与 params；deadline/issuedAt/sessionId 等不进摘要 | 重试不应因租约字段差异被当成新命令，也不应借重试延长租约 |
| M1-D4 | 租约超时记待核对 | deadline 到期或执行器无终态回执 → 状态 `expired`，核心记为待核对 | 遵循方向文档：丢失终态回执时不得推断成功或停止 |
| M1-D5 | 路径耗尽按实际距离判定 | 导航结束必须比对最终位置与目标距离；不得仅因路径节点耗尽进入 `reached`（Java P2） | 方向文档点出的坑：节点耗尽与到达是两回事 |
| M1-D6 | 断线自清理不依赖 AIRI | 桥心跳丢失、退出世界、死亡、断连时执行器自行清控（Java P1） | 断线后 AIRI 也可能不可达；清理必须在游戏侧自主完成 |

## 契约定稿

### 命令信封

计划已给字段；本规范钉语义与来源。

```ts
/** One unit of game work. Envelope identity fields are bound by game-host. */
export interface GameCommandEnvelope {
  // Host-bound: injected by game-host, never specified by the model.
  sessionId: string
  taskId: string | null
  runId: string
  planVersion: number | null
  // Game-bound: cached at connect from the mod's status.
  worldId: string
  dimension: string
  playerUuid: string
  /** Increments on every (re)connect; makes old-world commands invalid. */
  connectionGeneration: number
  // Command identity.
  /** Adapter-generated UUID; the dedup key together with the generation. */
  commandId: string
  action: 'observe' | 'move_to' | 'status' | 'cancel' | 'collect' | 'say'
  /** Digest of action + params only; see canonicalization below. */
  paramsDigest: string
  /** Lease length in ms, not an absolute time. */
  deadlineMs: number
  issuedAt: number
}

/** The action-specific payload; the digest covers exactly this plus the action. */
export interface GameCommandParams {
  moveTo?: { x: number, y: number, z: number, tolerance: number }
  collect?: { itemId: string, maxCount: number, radius: number }
  say?: { text: string }
  observe?: { radius: number }
  status?: { commandId: string }
  cancel?: { commandId: string }
}
```

`paramsDigest` 的正则化（最终值）：把 `{ action, params }` 用排序键、无空白、无浮点尾差的 JSON 序列化后取哈希。**不**包含信封的 `sessionId/taskId/runId/planVersion/worldId/dimension/playerUuid/connectionGeneration/commandId/deadlineMs/issuedAt`。浮点坐标先按固定小数位（6 位）归一再序列化，避免 `-0` 与精度尾差造成假冲突。

### 命令状态机

```ts
/** Lifecycle of one command. Terminal states never transition further. */
export type GameCommandState
  = | 'accepted'
    | 'running'
    | 'cancel_requested'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
    | 'expired'
```

转移规则：

| 从 | 到 | 触发 |
| --- | --- | --- |
| — | `accepted` | 注册表接受一条新命令 |
| `accepted` | `running` | 执行器开始动作 |
| `running` | `succeeded` | 后置条件满足 |
| `running` | `failed` | 执行器明确失败（不可达、游戏侧拒绝） |
| `running` / `accepted` | `cancel_requested` | 收到取消（用户停止或核心取消） |
| `cancel_requested` | `cancelled` | 执行器确认停止 |
| `accepted` / `running` | `expired` | 租约到期且无终态回执 |

终态为 `succeeded`/`failed`/`cancelled`/`expired`。`cancel_requested` 是过渡态，仅表示取消请求已送达，**不等于**已停止。

### 去重与单一写者

去重表键为 `${connectionGeneration}:${commandId}`，值为状态与摘要。规则：

1. 键已存在且摘要相同 → 返回已有状态，**不**再次执行（不发新动作）。
2. 键已存在但摘要不同 → 拒绝，抛类型化错误 `GameCommandConflictError`（下节）。
3. 键不存在 → 新命令，入状态机。

`connectionGeneration` 在每次（重）连接时递增，因此旧世界的命令天然落入"键不存在"，但因其 generation 与当前不符，必须显式拒绝而非执行——见不变量 4。

每个玩家同一时间只有一个写动作所有者（`move_to`/`collect`/`say` 互斥）；`observe`/`status`/`cancel` 只读，可并发。写动作在途时收到新写命令 → 拒绝或按优先级排队（首批取拒绝并提示，避免隐式抢占）。

### 类型化错误

```ts
/** Raised when a command id is reused with different params. */
export class GameCommandConflictError extends Error {
  readonly commandId: string
  readonly connectionGeneration: number
}

/** Raised when a command targets a world or connection the adapter no longer owns. */
export class StaleGameBindingError extends Error {
  readonly requiredGeneration: number
  readonly currentGeneration: number
  readonly requiredWorldId: string
  readonly currentWorldId: string
}

/** Raised when a write action is requested while another holds the player. */
export class GameWriteBusyError extends Error {
  readonly holderCommandId: string
}
```

### 租约与看门狗

租约不是绝对时间，而是时长（`deadlineMs`）。看门狗在 `running` 期间计时：

1. 到期 → 转 `cancel_requested`，向执行器发停止。
2. 执行器在宽限窗口内确认停止 → `cancelled`。
3. 宽限窗口内无确认 → `expired`，核心记为待核对（M1-D4），不推断成功。

停止确认的验收线沿用计划：**执行器收到取消后两个游戏 tick 内清除控制意图**。停止判定同时记录控制意图与实际位移，防止把惯性滑行误读为仍在按键。

### 终态回执

```ts
/** Final snapshot of the controlled player at command end. */
export interface GameFinalSnapshot {
  position: { x: number, y: number, z: number }
  health: number
  food: number
  heldItem: string | null
}

/** A postcondition check: what the command promised, and what actually happened. */
export interface GamePostCondition {
  kind: 'distance' | 'collected' | 'observed' | 'none'
  /** Expected value: a distance budget, a count, or a radius. */
  target: number
  /** Measured value from the game, never from the model. */
  actual: number
  met: boolean
}

export interface GameCommandReceipt {
  commandId: string
  connectionGeneration: number
  state: GameCommandState
  finalSnapshot: GameFinalSnapshot
  /** Machine-readable end reason, for example 'reached' | 'path_exhausted' | 'deadline' | 'cancelled' | 'reflex_preempted'. */
  endReason: string
  postCondition: GamePostCondition
  issuedAt: number
  endedAt: number
}
```

后置条件的判定规则：

- `move_to`：`kind: 'distance'`，`target` 为容差，`actual` 为终态到目标的实测距离，`met = actual <= target`。
- `collect`：`kind: 'collected'`，`target` 为本次要求数量，`actual` 为**本次新采集数量**（采集事件 + 前后数量差），`met = actual >= target`。别人丢给她的物品不计入。
- `observe`：`kind: 'observed'`，`actual` 为观察范围。
- `say`/`status`/`cancel`：`kind: 'none'`，`met` 恒真。

**回执丢失**：终态回执未到达时，核心不得推断终态；该命令保持非终态并记入待核对，可凭 `status` 命令按 `commandId` 查询最新已知状态。回执丢失后**不得重发同一命令的身体动作**（去重规则保证）。

## Java 侧补丁（P1、P2）

### P1 断线与退出清理（字段级）

触发条件（任一）：桥接心跳丢失、退出世界、玩家死亡、连接断开。

必须清理的控制状态，逐项：

| 状态 | 清理动作 |
| --- | --- |
| 移动输入 | 清除所有方向键与跳跃的按住状态 |
| 导航 | 停止 A* 导航，清空路径与目标 |
| 挖掘 | 停止当前破坏方块的动作 |
| 使用物品 | 停止使用/进食动作（`stop_using_item`） |
| 攻击 | 停止攻击目标 |
| 租约 | 使所有在途租约失效，后续命令一律拒绝直到重连 |

验收线：清理在触发后**两个游戏 tick 内**完成；清理不依赖 AIRI 侧再发任何请求（M1-D6）。

心跳丢失的判定阈值与重连退避不在本规范（属实现配置），但必须可配置且默认值记录在案。

### P2 导航租约与终态（字段级）

1. `navigate_to` 请求携带截止时间；超时后停止导航并返回终态。
2. `navigation_status` 返回：当前是否在导航、最终位置（结束时）、结束原因。
3. 结束原因必须区分 `reached` 与 `path_exhausted`；**路径节点耗尽不得直接判为 `reached`**——必须比对最终位置与目标距离，超出容差即 `path_exhausted` 或 `unreachable`（M1-D5）。
4. 不可达目标必须有界失败：给出最终位置与原因，不无限重试。

### MCPFabric 能力映射（回填 P1/P2）

| 领域动作 | MCPFabric 底层 | 依赖补丁 |
| --- | --- | --- |
| `observe` | `get_status`、`get_self`、`get_inventory`、`get_blocks_region` | 无 |
| `move_to` | `navigate_to` + `navigation_status` | P2 |
| `status` | 适配器本地状态表 + `navigation_status` | 无 |
| `cancel` | `stop_navigation` + `stop_movement` | P1（停止确认） |

## 工作项与通过条件

| # | 交付 | 依赖 | 通过条件 |
| --- | --- | --- | --- |
| 1 | TS 命令注册表 + 状态机 + 去重（假执行器） | 无 | 无游戏环境下脚本全绿：去重、冲突拒绝、状态转移、租约超时 |
| 2 | 租约看门狗 + 待核对语义 | 1 | 超时无回执 → `expired` 且记待核对；有确认 → `cancelled` |
| 3 | 终态回执 + 后置条件 | 1 | 三类可计算后置条件（距离/采集/观察）各自断言 |
| 4 | Java P1 断线清理 | MC-0a | 四个触发条件下两 tick 内清控；不依赖 AIRI |
| 5 | Java P2 导航租约与终态 | 4 | 截止时间生效；路径耗尽 ≠ 到达 |
| 6 | 旧世界命令拒绝 + 单一写者 | 1,4 | `StaleGameBindingError`、`GameWriteBusyError` 各一场景 |

工作项 1–3 不依赖 MC-0a 的 Java 环境（M1-D1），可与 EP-1 并行；4–6 需环境 A。

## 设计不变量

1. **去重不重复执行**：同键同摘要的重复请求返回已有状态，不再次移动或采集。
2. **冲突拒绝**：同 `commandId` 不同 `paramsDigest` 被 `GameCommandConflictError` 拒绝。
3. **租约失效即待核对**：无终态回执记 `expired`，不得推断成功或停止。
4. **旧绑定拒绝**：`connectionGeneration` 或 `worldId` 与当前不符时拒绝，新世界角色不动。
5. **路径耗尽 ≠ 到达**：不可达目标有界失败，回执含最终位置与原因。
6. **取消确认**：`cancel` 后两个游戏 tick 内清除控制意图；`cancel_requested` 不等于已停止。
7. **断线自清理**：桥进程结束或租约失效后，执行器自行清控，不需要 AIRI 再发停止。
8. **写动作互斥**：同一玩家同时只有一个写动作所有者；只读命令可并发。

## 验收场景

沿用计划所列 MC-0b 场景，逐条落到不变量：

| 场景 | 操作 | 期望与证据 |
| --- | --- | --- |
| 取消两 tick 清控 | 移动中发取消 | 不启动后续动作；两 tick 内清控；记录控制意图与实际位移（不变量 6） |
| 桥接退出 | 移动中结束桥进程 | 租约失效后两 tick 内自清理；不依赖 AIRI 再发停止（不变量 7） |
| 回执丢失 | 丢弃终态响应后同 ID 再请求 | 不重复执行；可按 ID 查原状态；未知则明确待核对（不变量 1、3） |
| 旧世界命令 | 切换世界后送旧命令 | 以连接代次/世界绑定不符拒绝，新世界角色不动（不变量 4） |
| 不可到达 | 指定封闭目标 | 有界失败，报原因与最终位置，不把路径耗尽当到达（不变量 5） |
| 参数冲突 | 同 ID 换参数重发 | `GameCommandConflictError`（不变量 2） |
| 写动作互斥 | 移动中发第二个写命令 | `GameWriteBusyError`（不变量 8） |
| 双环境 | 环境 B 跑移动/取消/status | 与环境 A 同形；世界绑定与连接代次正确 |

结果记录沿用 fork 惯例：PASS/FAIL/BLOCKED/NOT-RUN 加证明范围；停止测试同时记录控制意图与实际位移；导航用至少三个固定种子重复。

## 明确不做

- 不做采集的写路径（属 MC-1a；本批只钉 `collect` 的信封与后置条件形状）。
- 不做生存反射（属 MC-0d）。
- 不做工具面注册与证据接线（属 MC-0c）。
- 不做跨世界记忆（属 MC-1b）。
- 不做多写动作的排队抢占策略（首批拒绝并提示）。

## 实施修正记录（2026-09-11，fork 0.2.2）

Java 侧 P1/P2 已按上述字段契约实现于 `D:\mcpfabric`，两处实现性澄清：

1. **命令拒绝在 TS 注册表层**。规范 P1 写"租约失效，后续命令一律拒绝直到重连"；mod 侧每次工具调用无状态，无法区分调用者。实现为：mod 侧只做物理清理（输入/导航/挖掘/使用/攻击）并清除导航租约；旧世界/旧连接的命令拒绝对应 MC-0b TS 注册表的 `StaleGameBindingError`（M1-D2 连接代次），不在 mod 层重复。
2. **心跳来源**。桥没有独立心跳帧；`RpcRouter.dispatch` 记录 `lastRequestAt`，客户端 `ClientControlGuard` 在"有控制占用且静默超过 `heartbeatTimeoutMs`（默认 30000，0 关闭）"时清理。触发条件与默认值记录在案。

实现落点：
- `BotController.clearAll(reason)`（输入/挖掘/物品使用清理 + 导航终态捕获）、`isDriving()`、终态字段 `endReason/endedAt/finalDistance/finalPosition`；`statusJson` 输出这些字段与 `deadline`。
- `ClientControlGuard`：`ClientPlayConnectionEvents.JOIN/DISCONNECT` + 每 tick 检查世界退出、死亡、心跳；清理在触发后一个 tick 内应用（两 tick 验收线内）。
- P2：路径耗尽先比对最终距离再判定 `reached`，否则 `path_exhausted`；`nav.pathTo` 无路径时抛 `unreachable` 错误并携带 `position` 数据；截止原因由 `timeout` 改为 `deadline`；`nav.stop` 原因由 `stopped` 改为 `cancelled`。
- 新配置项：`heartbeatTimeoutMs`（默认 30000）。
- 版本：`mod_version` 0.2.1 → 0.2.2；构建 SHA-256 `79ead8bb3ef8af2ce34a16fca72510672fc88e21c3cb20cd258c7f367e5eac75`。

**真机验证（2026-09-11，环境 A）**：P2 五场景（`reached`/`cancel`/`deadline`/`unreachable`/`path_exhausted`）与 P1 三触发（心跳超时、断连、死亡）全部 PASS；`world_exit` 兜底因退出到标题先触发网络 `DISCONNECT`（记录为 `disconnected`）未单独观察。测试脚本 `apps/stage-tamagotchi/scripts/mc-0b-protocol-smoke.ts`（原始 RPC，不经 LLM）；记录见 [P1/P2 验证记录](../evidence/mc-0b/p1-p2-verification-20260911.md)。

## 与执行计划的关系

- [minecraft-execution-plan.md](./minecraft-execution-plan.md)：MC-0b 的批次、通过条件与验收在本规范细化。计划已有的命令信封与终态字段以本文件为最终值。
- [mc-0a-spec.md](./mc-0a-spec.md)：MC-0a 交付连接与只读观测；本规范在其之上加命令注册表与 Java 补丁 P1/P2。
- [wave-c-execution-plan.md](./wave-c-execution-plan.md)：本批在 wave C 的实施顺序与切入口。

## 本轮交付与检查

本轮只新增本规范文档并更新 MODS.md 索引。未编写 Java、未改动产品代码、未运行游戏。文中字段名、错误类型名与状态机为最终值；实施时若与 MCPFabric 实际控制接口冲突，以最小偏离调整并在本文件记录，不静默改语义。代码锚点为 2026-09-11 工作区状态。
