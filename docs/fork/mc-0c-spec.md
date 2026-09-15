# MC-0c 契约规范：领域工具、证据核对与完成门接线

日期：2026-09-11。状态：规范定稿，实施未开始。批次：MC-0c。

本文件钉死 [MC 执行计划](./minecraft-execution-plan.md) 中 MC-0c 的字段级契约：领域工具面、命令注册表的真实执行器、回执核对与证据等级、journal 与完成门接线、多窗口单次执行。MC-0b 的命令信封/状态机/回执形状以 [MC-0b 规范](./mc-0b-spec.md) 为准，本文件不重复。

## 决策记录

| # | 决策 | 内容 | 理由 |
| --- | --- | --- | --- |
| C1-D1 | 工具面四个领域工具 | MC-0c 只注册 `game_observe`、`game_move_to`、`game_status`、`game_cancel`；`collect`/`say` 属 MC-1a | 方向文档首批范围；写动作与采集核对留给 MC-1a，避免一次开太多写路径 |
| C1-D2 | 模型面名字带 `game_` 前缀 | 领域工具对模型暴露为 `game_<action>` | `observe`/`status`/`cancel` 过于通用，会与 builtin/插件名冲突（EP-0 双键唯一） |
| C1-D3 | 执行走 main 单所有者 | 渲染端只登记工具壳，执行经 Eventa invoke 到 main 的 game-host，由 MC-0b 注册表提交；`commandId` = 渲染端每次调用的 `requestId` | 跨窗口只产生一次命令；IPC 重试经同键去重（M1-D2）；连接代次/世界绑定只由 main 注入 |
| C1-D4 | 核对由 game-host 完成 | 回执先核对来源/授权/连接代次/命令身份，再读一次新鲜状态核对后置条件；核对通过的工具结果带 `checked: true` | 方向文档：MCP 原始报告与模型自述不作为变更证明 |
| C1-D5 | 证据按结果分级 | 同一工具，`checked: true` → `game_checked`（可满足验证门），否则 → `game`（仅指引） | EP-0 决策 E0-D3：原始回执与核对后回执必须分桶；生产者决定分级 |
| C1-D6 | 完成门只认核对结果 | `completed` 只在核对回执满足计划步骤声明的证据时成立；原始 game 回执不入门 | MC 计划通过条件；与 EP-0 权威表（41 可验证门、44 不可）一致 |
| C1-D7 | 只读命令不建流 | `game_observe`/`game_status` 只读，可并发；`game_move_to` 写动作受 MC-0b 单写者约束；`game_cancel` 终止当前写动作 | MC-0b 不变量 8（`observe`/`status`/`cancel` 可并发、写互斥） |

## 契约定稿

### 工具面（四个工具）

| 模型面名字 | 参数（provider schema） | 语义 | 回执 |
| --- | --- | --- | --- |
| `game_observe` | `{ radius?: number }`（默认 16，上限 64） | 读本玩家状态（位置/血量/饥饿/持有物）与背包；服务端桥可用时附一次区域方块读取 | `GameDomainResult`，`postCondition.kind:'observed'` |
| `game_move_to` | `{ x: number, y: number, z: number, tolerance?: number }`（默认 1.0，上限 8） | 有界移动；到达容差内为 `succeeded`，路径耗尽/不可达为 `failed` | `postCondition.kind:'distance'` |
| `game_status` | `{ commandId?: string }` | 读注册表状态；无 `commandId` 返回当前写动作与最近终态 | `postCondition.kind:'none'` |
| `game_cancel` | `{ commandId?: string }` | 取消指定命令；无 `commandId` 时取消当前写动作所有者 | `postCondition.kind:'none'` |

注册规则（EP-0 四条路径的 game 列）：

- `ownerKind: 'game_adapter'`，`ownerId: 'game-host'`。
- `execution: { kind: 'remote', chain: ['game-adapter', 'game-host'] }`。
- 工具 `id`: `game:game-host:<toolName>`；`toolName` 为 `game_<action>`。
- 注册与移除由渲染端 game-host 工具 store 完成（刷新时先撤后登，无双所有者窗口）；不注册任何 MCPFabric 原始工具（不变量 1）。

### `GameDomainResult`（工具结果信封）

```ts
/** JSON string returned by every game_* tool. */
export interface GameDomainResult {
  status: 'ok' | 'failed' | 'cancelled' | 'expired' | 'busy' | 'rejected'
  /** True only after the game-host receipt check passed. */
  checked: boolean
  commandId: string | null
  endReason: string
  finalSnapshot?: {
    position: { x: number, y: number, z: number }
    health: number
    food: number
    heldItem: string | null
  }
  postCondition: {
    kind: 'distance' | 'collected' | 'observed' | 'none'
    target: number
    actual: number
    met: boolean
  }
}
```

- `busy`/`rejected` 不产生命令（单写者拒绝、白名单/参数拒绝），`commandId: null`、`checked: false`。
- 核对失败（来源/授权/代次/命令身份任一不符，或新鲜状态与后置条件矛盾）时返回 `status:'failed'`、`checked: false`、`endReason:'check_failed: <原因>`。

### main 侧执行链

```
渲染端工具 execute(input)
  → eventa invoke gameHostExecuteCommand { requestId, action, params, task }
  → main game-host：
     1. 绑定校验（连接存在；否则 rejected）
     2. 组装信封：requestId → commandId；connectionGeneration/worldId/dimension/playerUuid 取自身缓存；
        sessionId/taskId/runId/planVersion 由渲染端 task 字段透传（模型不可指定）
     3. registry.submit({ envelope, params })，deadlineMs 取每动作默认表：
        observe 8000 / status 5000 / cancel 5000 / move_to 120000
     4. 真执行器按动作映射 MCP 调用（下表）
     5. 终态后核对 → GameDomainResult
```

主进程执行器映射（只读段；写动作仅 `move_to`）：

| 动作 | MCPFabric 调用 | 注意 |
| --- | --- | --- |
| `observe` | `get_self` + `get_inventory`（+ 服务端可用时 `get_blocks_region`） | 观察半径写入 `observedRadius`；`get_status` 只用于能力探测，不参与证据 |
| `move_to` | `nav.pathTo` → 轮询 `nav.status` 至终态 | 终态位置用于距离后置条件；`deadline`/`path_exhausted` 映射为 `failed` |
| `status` | 注册表状态 + 活动写动作时读一次 `nav.status` | 不产生新命令时 `commandId:null` |
| `cancel` | `nav.stop`（+ 注册表 `cancel`） | 停止确认沿用 MC-0b 宽限窗口 |

### 回执核对（C1-D4）

核对项与失败映射，按序：

1. **来源**：回执来自 game-host 私有 session（不是渲染端 mcp store、不是其它进程）→ 否则 `check_failed: source`。
2. **授权**：命令由本注册表签发，`commandId + connectionGeneration` 匹配；取消类命令的 `requestId` 存在 → 否则 `check_failed: command_identity`。
3. **连接代次**：终态时 `connectionGeneration` 未变（重连/切世界 → 命令作废）→ 否则 `check_failed: stale_binding`。
4. **新鲜状态**：MCP 返回终态后，额外读一次 `get_self`；距离类后置条件用这次读数计算，`met` 为该次核对的结论 → 不一致记 `check_failed: postcondition`。

只有四项全过才 `checked: true`。核对结果（原始回执摘要 + 核对结论）随 `tool/result` 进入 journal；`provenance` 由运行时按结果分级写入。

### 证据分级与完成门（C1-D5/C1-D6）

- 运行时证据解析扩展为：`getToolEvidenceAuthor(toolName, result?)`。game_adapter 注册项在结果为 `checked: true` 时返回 `game_checked`，否则 `game`。
- 该签名变更是加法：现有 `getToolEvidenceAuthor(toolName)` 调用方保持可用。
- 完成门语义沿用 EP-0 权威表：`game_adapter_checked_result` (41) 可满足验证门、不可作变更证明；`game_adapter_report` (44) 仅指引。原始 game 回执不得使 `completed` 成立。

### 多窗口单次执行（C1-D3）

- 命令身份在渲染端每次调用生成一次（`requestId`）；main 以其为 `commandId`，同键重试走 MC-0b 去重（不重复执行）。
- LLM 回合只在 leader 渲染端运行；follower 窗口只读注册表状态与任务投影，不另行执行。
- 跨窗口验收：两个窗口观察同一活动任务，命令计数为 1；`game_status` 在两窗口返回同一 `commandId` 终态。

## 底座现状与目标差异（审计 2026-09-11）

| 能力 | 现状 | 目标 |
| --- | --- | --- |
| 领域工具面 | 无；`game-host` 只有 main 服务与最小 renderer facade | 四工具注册进 `useLlmToolsStore`，证据为 `game_adapter` |
| 命令执行 | MC-0b 注册表无真实执行器 | `nav.pathTo`/`nav.status`/`nav.stop`/玩家读工具的真实映射 |
| 回执核对 | 无 | 来源/授权/代次/新鲜状态四项核对 → `checked` |
| 证据分级 | `getToolEvidenceAuthor` 只按注册表固定返回 `game` | 按结果 `checked` 分级 |
| 完成门 | 无游戏回执通路 | checked 回执入 journal，经证据门参与步骤判定 |
| 多窗口 | 无命令面 | requestId 幂等 + leader 单执行 |

## 工作项与通过条件

| # | 交付 | 依赖 | 通过条件 |
| --- | --- | --- | --- |
| 1 | `GameDomainResult` + 工具参数 schema + main `gameHostExecuteCommand`/`gameHostListDomainTools` 契约 | MC-0b | 类型导出；invoke 契约双端编译通过 |
| 2 | main 真实执行器（observe/move_to/status/cancel 映射） | 1 | 无 LLM 的确定性脚本：四动作各一次，move_to 距离后置条件有实测值 |
| 3 | 回执核对四项 | 2 | 四类失败各有一个可注入用例；全过才 `checked:true` |
| 4 | 渲染端工具 store + 注册/撤销 | 1 | 工具面只增四个 `game_*`；撤下后消失且无残留注册 |
| 5 | 证据分级 `getToolEvidenceAuthor(toolName, result?)` | EP-0 | 同一工具 checked/raw 分别映射 `game_checked`/`game`；现有调用不破 |
| 6 | 完成门接线 | 5 | 计划步骤声明 `tool_result` 期望时，只有 checked 回执可完成；raw 回执留下 blocked |
| 7 | 真聊天下令 + 多窗口单次执行 | 4,6 | 聊天中 `game_*` 可调用并有回执；两窗口观察同一任务命令计数为 1 |

## 设计不变量

1. **零 MCP 泄漏**：工具面只含 `game_*` 四工具，MCPFabric 其余工具永不注册。
2. **核对分级**：`checked` 只由四项核对全过产生；原始回执永远是 `game`。
3. **完成门诚实**：raw game 回执不使任何步骤 `completed`；`completed` 必须可由 journal 中 checked 回执复算。
4. **单写者**：并发写命令被 `busy` 拒绝（`game_move_to` 互斥），读命令可并发。
5. **旧世界拒绝**：重连/切世界后旧命令不再产生任何动作（代次核对）。
6. **幂等重试**：同 `requestId` 的 IPC 重试不产生第二次游戏动作。
7. **leader 单执行**：任一 LLM 回合的命令只由 leader 执行一次；follower 不执行。

## 验收场景

| 场景 | 期望与证据 |
| --- | --- |
| 只读观察 | 聊天/脚本 `game_observe` 返回位置、背包、维度与采集时间；`checked:true`（不变量 2） |
| 有界移动 | `game_move_to` 到达 → `succeeded` + 距离后置条件实测；不可达 → `failed` + 位置（MC-0b 回执形状） |
| 重复重试 | 同 `requestId` 第二次 invoke → 返回同一终态，游戏侧只动一次（不变量 6） |
| 写互斥 | 移动中再发 `game_move_to` → `busy`，不产生第二条命令（不变量 4） |
| 重连失效 | 移动中断连重连 → 旧命令 `failed: check_failed: stale_binding`，新世界不动（不变量 5） |
| 完成门 | 计划步骤声明 game 证据：raw 回执 → 步骤 blocked；checked 回执 → completed（不变量 3） |
| 多窗口 | 两个窗口观察同一任务 → `game_status` 同 `commandId`，命令计数 1（不变量 7） |
| 真聊天 | 聊天里"你走到我前面那块石头"→ 模型调用 `game_move_to` 并回报 checked 回执 |

结果记录沿用 fork 惯例：PASS/FAIL/BLOCKED/NOT-RUN 加证明范围。

## 明确不做

- `collect`/`say` 工具（属 MC-1a）。
- 世界作用域记忆与事件压缩（属 MC-1b）。
- 反射（属 MC-0d）。
- 技能经适配器调用游戏工具（属 MC-1c 与 EP-1 组合）。
- 状态 UI（可留到后续批次；`game_status` 已覆盖模型面需求）。

## 实施记录（2026-09-11）

- **契约与 main 执行**：`shared/eventa/game-host.ts` 增 `GameDomainAction`/`GameDomainTask`/`GameDomainResult`/`GameHostDomainToolDescriptor` 与 `gameHostListDomainTools`/`gameHostExecuteCommand`；`main/services/airi/game-host/index.ts` 增 `GameHostCapabilityPort`、`connectionGeneration`（每次连接递增）、四工具描述表与动作默认租约（observe 8s / move_to 120s / status 5s / cancel 5s）、真实执行器（`observe` = `get_self`+`get_inventory`+尽力区域读；`move_to` = `nav.pathTo` → 轮询 `nav.status` 至终态；`stop` = `nav.stop`）、四项核对（来源/授权为结构性；代次不变 + 新鲜 `get_self`/`get_inventory` 读数）与 `checked` 分级（status/cancel 恒 false；expired 不 checked）。
- **渲染端**：新增 `renderer/stores/tools/game-host.ts`（`game:game-host:` 前缀、`game_adapter` 注册、requestId 幂等、execute 走 invoke）并入 App.vue 的 leader 刷新；`stores/tools/index.ts` 导出。
- **证据分级**：`resolveEvidenceAuthor(registration, reviewedSkills, result?)`；game_adapter 结果为 `checked:true` 时 `game_checked`，否则 `game`；core-agent 运行时 `getToolEvidenceAuthor(toolName, result?)` 加法签名并传入 `ctx.data.result`。
- **完成门**：`authority/gate.ts` 的 evidence 匹配排除 `game_adapter_report`（原始 game 回执只作指引），`game_adapter_checked_result` 可满足步骤声明的 `tool_result`；其余桶行为不变（`maySatisfyVerificationGate` 此前未被消费，本批只对 game 桶落地）。
- **两处实现性解释**：① 渲染端当前未透传 `task.sessionId`（避免工具 store 引入会话 store 的整条依赖；main 以空串兜底），会话归属接线留给 MC-1b；② `readFreshSnapshot` 连带读一次背包，使核对后的 `finalSnapshot.heldItem` 有效。
- 验证：core-agent 315、stage-ui node 146 files / 982、stage-tamagotchi 全量 568（4 例既有 Windows 基线失败）、game-host main 21 + renderer 2；typecheck 与改动文件 eslint 0。

**真机验证（2026-09-12，应用内）**：工具面 54 = 50 + 四个 `game_*`（`game_adapter` 链、MCP 原始工具零泄漏）；`game_observe` 与 `game_move_to` 经完整注册表链路执行，回执含 `checked`、`unreachable`/`path_exhausted`/`reached` 与距离后置条件；`game_status` 回退最近终态；CP-1 两消费者（`game.minecraft.control` + `skill.adapter.self-authored`）同时 ready。验证中发现并修复：① main 执行器误用桥方法名（`nav.*`）而非 MCP 工具名（`navigate_to`/`navigation_status`/`stop_navigation`），导致所有主会话导航被拒；② `game_status` 补 `lastReceipt` 最近终态回退；③ 多窗口覆盖：follower 的未门控 watcher 会把内置工具全量回推覆盖 leader 工具面，已加 leader 门控与发现重试（详见 [多窗口工具面覆盖修复](./evidence/mc-0c/multi-window-tool-face-20260912.md)）。多窗口单执行（工具面级）已验证：follower 无执行器、leader 全程 54。真聊天下令与完成门真机核对已通过（真实 provider 工作回合：`plan_update(start)` → `game_observe` → `plan_update(complete)`，步骤完成且 `unverifiedSteps: []`，证据为 checked 游戏回执），记录见 [real-chat-gate-20260912.md](./evidence/mc-0c/real-chat-gate-20260912.md) 与 [应用内验证记录](./evidence/mc-0c/in-app-verification-20260912.md)。未跑：raw 回执真机拒绝（单测覆盖）。

## 与执行计划的关系

- [minecraft-execution-plan.md](./minecraft-execution-plan.md)：MC-0c 的批次与通过条件在本规范细化。
- [mc-0b-spec.md](./mc-0b-spec.md)：命令信封、注册表、回执形状由其拥有；本规范只加执行器与核对层。
- [ep-0-spec.md](./ep-0-spec.md)：`game_adapter` 注册列与 `game`/`game_checked` 桶由其钉死；本规范加结果分级规则。
- [capability-platform-plan.md](./capability-platform-plan.md)：game-host 是 CP-1 的第一个能力消费者。

## 本轮交付与检查

本轮只新增本规范文档并更新 MODS.md 索引。未改动产品代码、未注册工具、未执行游戏命令。文中字段名（`GameDomainResult`、`checked`、动作默认表）为最终值；实施时若与 MC-0b 注册表或 MCPFabric 实际接口冲突，以最小偏离调整并在本文件记录。
