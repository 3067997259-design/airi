# MC-0d 契约规范：生存反射

日期：2026-09-11。状态：规范定稿，实施未开始。批次：MC-0d。

本文件钉死 [MC 执行计划](./minecraft-execution-plan.md) 中 MC-0d 的字段级契约：三条反射的触发/行为/上报形状、配置默认值、抢占语义、夹具与补丁 P3/P4 范围。指令优先序与命令终态沿用 [MC-0b 规范](./mc-0b-spec.md)。

## 决策记录

| # | 决策 | 内容 | 理由 |
| --- | --- | --- | --- |
| D0-D1 | 反射在游戏侧逐 tick 判定 | 三条反射全部实现于客户端 mod（补丁 P3），不发起任何模型调用 | 计划：逐 tick、低延迟；模型循环不参与保命 |
| D0-D2 | 反射组默认开、各自可关 | `config/mcpfabric.config.json` 新增 `reflex` 组：总开关 + 三条独立开关；默认全开 | 计划：默认开，独立关闭用于对照测试 |
| D0-D3 | 抢占转失败回执 | 反射打断任务命令时该命令 `failed`、`endReason=reflex_preempted`，回执附反射事件摘要 | 计划：恢复由核心重新规划，反射不自动重放 |
| D0-D4 | 事件字段定稿 | `game:reflex` 事件载荷见下表；经 SSE 事件流上报，重复同因在窗口内合并 | 计划 P4：反射事件入事件流；无变化不重复上报 |
| D0-D5 | 反射收敛性 | escape 必须收敛：无有界路径时停止并上报 `failed`，不无限尝试；eat 达到阈值或无可食即止；defend 脱离到安全距离或反击结束即止 | 计划：反射本身不受 deadline 限制但必须收敛 |
| D0-D6 | 优先级定稿 | 用户停止 > 生存反射 > 任务命令；取消不等待模型、不排长动作后面 | 计划优先级表；与 MC-0b 取消语义一致 |

## 契约定稿

### 配置

```jsonc
{
  "reflex": {
    "enabled": true,
    "escapeHazard": true,
    "autoEat": true,
    "defend": true,
    "hungerThreshold": 14,
    "defendHealthThreshold": 8,
    "attackBack": true,
    "disengageDistance": 8,
    "mergeWindowMs": 3000
  }
}
```

- `hungerThreshold`：饥饿值低于该值触发进食；范围 1–20，默认 14。
- `defendHealthThreshold`：血量低于该值改为脱离战斗（不反击）；默认 8（半血以下）。
- `attackBack`：血量高于阈值时是否近身反击；默认 true。PvP 恒关（只对敌对生物生效）。
- `mergeWindowMs`：同一 cause 事件的合并窗口，默认 3000；窗口内同因不重复上报。

### 三条反射

| 反射 | 触发 | 立即行为 | 上报字段 |
| --- | --- | --- | --- |
| escape-hazard | 处于/濒临岩浆、火焰、溺水、窒息（方块内） | 覆盖当前移动意图，沿脱离向量移动到安全位置；清除导航与挖掘 | `positionBefore/After` |
| auto-eat | 饥饿值 < `hungerThreshold` | 从背包选择安全食物（首批：任意可食且非任务预留），装备并食用至阈值以上或无可食 | `hungerBefore/After`、`itemId` |
| defend | 被实体攻击（每击一次触发） | 血量 > 阈值且 `attackBack` → 近身反击；否则脱离至 `disengageDistance` 并保持距离 | `attackerUuid/Name`、`healthBefore/After` |

### `game:reflex` 事件

```ts
/** One reflex action, emitted on the SSE event stream. */
export interface GameReflexEvent {
  cause: 'hazard' | 'hunger' | 'attacked'
  /** Tick time and wall-clock at decision. */
  gameTick: number
  at: number
  action: 'escaped' | 'ate' | 'countered' | 'disengaged' | 'failed'
  reason?: string
  positionBefore?: { x: number, y: number, z: number }
  positionAfter?: { x: number, y: number, z: number }
  hungerBefore?: number
  hungerAfter?: number
  healthBefore?: number
  healthAfter?: number
  itemId?: string
  attackerUuid?: string
  attackerName?: string
  /** Command id this reflex preempted, when one was active. */
  preemptedCommandId?: string
}
```

- `cause` 与 `action` 为最终枚举值；新增值只能加法。
- 合并：同 `cause` 在 `mergeWindowMs` 内只保留一条事件（取最新状态）；`failed` 不合并。
- 抢占：反射发生时若存在活动写命令，置 `preemptedCommandId`，命令回执 `endReason=reflex_preempted`。

### 补丁与落点（P3、P4）

- **P3 反射模块**：`src/client/java/dev/mcpfabric/client/reflex/` 新包；`ReflexController` 由 `ClientTickEvents.END_CLIENT_TICK` 驱动，先于 `BotController` 的输入应用（或在其中前置判定）执行；检测与决策纯客户端状态；动作复用 `BotController` 的输入/挖掘/使用清理接口（`clearAll` 与导航停止）。事件经 `McpFabric.events()` 发出。
- **P4 事件流补充**：核对现有 `poll_events`（damage/deaths/chat）是否覆盖反射事件与夹具所需（受击、死亡、进食结果）；缺则补，命名 `game:reflex`（本 fork 扩展事件）。
- 租约：反射执行期间既有租约照常计时（不暂停、不延长）。

## 工作项与通过条件

| # | 交付 | 依赖 | 通过条件 |
| --- | --- | --- | --- |
| 1 | 配置组 + 开关 + 默认值 | 无 | 配置可读写；三条独立关闭时对应反射不触发 |
| 2 | escape-hazard | 1 | 岩浆/火焰/溺水/窒息四类各一夹具通过；事件附位置前后；收敛（无路时 failed） |
| 3 | auto-eat | 1 | 饥饿 10 夹具：进食至阈值以上；事件附饥饿前后与物品；无可食时 failed |
| 4 | defend | 1 | 僵尸攻击夹具：高血量反击、低血量脱离；事件附攻击者与血量；PvP 不触发 |
| 5 | 抢占回执 | 2,3,4 | 反射打断的任务命令 `failed` + `reflex_preempted` + `preemptedCommandId` |
| 6 | 用户停止优先 | MC-0b | 反射进行中用户停止：停止生效且反射不重开动作 |
| 7 | 事件合并与上报 | 4 | 同因窗口内合并；无变化不重复；SSE 可收到 `game:reflex` |

## 设计不变量

1. **逐 tick 与零模型**：反射不含任何模型调用（补丁 P3 代码不引用 LLM 通路）。
2. **必须收敛**：三类反射都有界终止；无可行动作时 `failed` 上报，不静默反复尝试。
3. **抢占留痕**：被反射打断的命令回执带 `reflex_preempted`，恢复决策留给核心。
4. **用户优先**：用户停止 > 反射 > 任务命令；停止后反射不自动重开被停动作。
5. **租约不变**：反射不暂停、不延长任务租约。
6. **事件有界**：合并窗口内同因不重复；事件载荷只含上表字段。
7. **PvP 关闭**：defend 不攻击玩家实体。

## 验收场景

| 场景 | 操作 | 期望与证据 |
| --- | --- | --- |
| 反射-逃脱 | 移动中脚下换岩浆 | 脱离向量即时覆盖；`game:reflex cause=hazard` 附位置前后；被打断命令 `reflex_preempted` |
| 反射-进食 | 设饥饿 10 | 自动进食至阈值上；事件附饥饿前后；任务恢复不被吞 |
| 反射-防御 | 生成僵尸攻击 | 高血量反击 / 低血量脱离；事件附攻击者；用户"停下"优先 |
| 收敛 | 封闭岩浆包围 | 有界失败并上报 `failed`，不无限重试 |
| 合并 | 连续同类伤害 | 窗口内合并为一条事件 |

结果记录沿用 fork 惯例：PASS/FAIL/BLOCKED/NOT-RUN 加证明范围；夹具重复用同一固定种子。

## 明确不做

- 复杂食物优选、任务预留物资清单（MC-1a 起再讨论）。
- 反击武器选择策略（用当前手持）。
- 玩家间 PvP 与团队协作。
- 反射的模型侧解释/恢复自动化（属核心重新规划）。

## 实施记录（2026-09-11，fork 0.2.3）

- **配置**：`McpConfig.ReflexConfig`（8 个字段，默认与规范一致）；旧配置文件读入后自动补默认并回写。
- **P3 模块**：`src/client/java/dev/mcpfabric/client/reflex/ReflexController.java` 状态机（IDLE/ESCAPING/EATING/COUNTERING/DISENGAGING），由 `ClientControlGuard` 的 tick 在 `BotController` 应用输入前调用。
  - escape：检测岩浆/着火/溺水（空气 < 150）/窒息（`isInWall`）；每 tick 扫四方向选首个可站方块（下方实心、无流体、非火/岩浆），转向并用前进来移动，必要时跳；60 tick 无解 → `failed: escape_timeout`。
  - auto-eat：仅扫快捷栏的可食用物品（`DataComponents.FOOD`）；选中后用 `BotController.setUseHeld(true)` 保持使用键（优先于常规释放路径），阈值达成/超时/无食物收尾；100 tick 上限。
  - defend：以 `hurtTime` 上升沿触发，攻击者取 `getLastDamageSource().getEntity()`；玩家实体忽略（PvP 关）；血量高于阈值且 `attackBack` → 追击反击（10 tick 间隔），低于阈值或途中跌破 → 脱离至 `disengageDistance`。
  - 抢占：进入任一反射前记录 `currentNavigationCommandId()` 并 `clearAll("reflex_preempted")`；事件带 `preemptedCommandId`；导航回执经既有链路显示 `reflex_preempted`。
  - 事件：`McpFabric.events().emit("game:reflex", payload)`；同 cause 在 `mergeWindowMs` 内合并，`failed` 不合并。
- **信道**：`nav.pathTo` 增可选 `commandId`（mcp-server schema + `NavHandlers` + `BotController` 存储）；game-host 的 `move_to` 传 `envelope.commandId`。
- **P4 核对**：现有事件总线已覆盖 `player_damage`/`chat`/`player_join`/`player_leave`，反射事件走同一 SSE；无需补通道。
- **构建**：`mod_version` 0.2.2 → 0.2.3；jar SHA-256 `17d2f9d5e2db6b0c820e445a1567637f62245382cad1871716682b70520b75d2`（151,650 B）。旧 0.2.2 jar 仍被运行中的进程锁定，部署待两侧重启。
- **实现窄化（记录在案）**：auto-eat 首批只扫快捷栏（背包交换留给后续）；escape 只做水平四方向、60 tick 上界。

**真机验证（2026-09-12，环境 A）**：五场景 PASS——火焰逃脱（事件 + 逃脱后位移 0）、抢占导航（`reflex_preempted` + `preemptedCommandId`）、自动进食（13→18、`itemId` bread）、防御反击（`countered` + 攻击者字段）、低血量脱离（`disengaged`，退距 ≥8）。验证中修复两个运行时缺陷：① 逃脱成功分支未停步（补 `stopAllMovement`，复验位移 0）；② 按使用键不产生 `consumeClick` 导致进食超时（改为显式 `gameMode.useItem`）。最终客户端构建 SHA-256 `5d3daf2b7dee57319f5f69db7f875fdb19d98f671c8de3360ff69b40cd2fff78`；记录见 [反射验证记录](../evidence/mc-0d/reflex-verification-20260911.md)。未单独造"窗口内二次触发合并"夹具；自动复活未实现（建议随 MC-1b）。

## 与执行计划的关系

- [minecraft-execution-plan.md](./minecraft-execution-plan.md)：MC-0d 的批次、反射契约与 P3/P4 清单在本规范细化。
- [mc-0b-spec.md](./mc-0b-spec.md)：命令终态、取消确认与优先级由其拥有。
- [mc-0c-spec.md](./mc-0c-spec.md)：反射事件的 journal/证据接线经 game-host（观察类），反射本身不产出证据。

## 本轮交付与检查

本轮只新增本规范文档并更新 MODS.md 索引。未编写 Java、未运行游戏。字段名（`GameReflexEvent`、配置键、枚举值）为最终值；实施时若 MCPFabric 实际接口冲突，以最小偏离调整并在本文件记录。
