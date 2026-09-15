# MC-1c 规范：经审阅组合技能与修订流程

日期：2026-09-13。状态：规范定稿，实施未开始。上游：[Minecraft 执行计划](./minecraft-execution-plan.md) MC-1c 行（"一个经审阅组合技能及修订流程"）与"与其他计划的关系"（复用 [SG](./skill-growth-plan.md) 的审阅与修订流程和 EP-1 的固定适配器边界）。依赖：MC-1a（已真机验收）、EP-1（2026-09-11 真机闭环 PASS）、SG-1（审阅入口与哈希绑定已落地）。

通过条件（计划原文）：**成功、缺条件、取消、撤销、内容变更五类情形可核对。**

本批让"经审阅技能"能组合游戏动作完成一件事，并把这五类情形逐项钉死。不新增领域工具、不改 MCPFabric Java、不新建执行引擎。

## 现状与缺口（研究结论）

- 技能沙箱的执行面只有 coding 工具：主进程 `createCodeModeRuntime(createCodingTools(host))`（`apps/stage-tamagotchi/src/main/services/airi/coding-host/index.ts:212-220`），`bridge(name)` 对表外名字直接抛错（`packages/coding-harness/src/ptc/code-mode.ts:86-87`）。`game_*` 是渲染端 leader 注册的 LLM 工具（`renderer/stores/tools/game-host.ts`），执行走另一个 main 服务（game-host），两者无连接。**技能当前无法调用任何 `game_*`。**
- 取消链在技能执行器断开：`SkillRuntimePort.runProgram` 不接受 `signal`（`packages/stage-ui/src/stores/skills.ts:67`）；主进程 `codingHostCodeRun` 已支持 `abortController.signal`（`coding-host/index.ts:311-320`），客户端类型已支持 `{ signal }`（`renderer/bridges/coding-host.ts:65`），只是从未传。
- 技能声明只有 `declared` 五个布尔（`renderer/stores/tools/builtin/skill-submit.ts:25-31`），没有工具 allowlist；批准绑定 `reviewedHash = contentHash`（source only）。技能不在 CP-2 权限覆盖内。
- 游戏侧在途/取消/租约已具备（命令注册表、`game_cancel`、停止宽限 2s；MC-0b/MC-1a），可被桥复用。

## D1 游戏命令桥（main coding-host ↔ game-host）

- game-host 新增窄端口并作为 `setupGameHost` 返回值导出（不改既有 eventa 契约）：

```ts
interface GameCommandPort {
  isConnected: () => boolean
  listTools: () => Array<{ name: string, description: string, parameters: unknown }>
  execute: (input: { requestId: string, action: string, params: unknown, signal?: AbortSignal }) => Promise<GameDomainResult>
  cancel: (commandId: string) => Promise<GameDomainResult>
}
```

- `setupCodingHost` 返回值增 `attachGameCommands(port: GameCommandPort): void`；`main/index.ts` 在 game-host 构建完成后调用（coding-host 先构建，采用晚绑定，避免注入顺序改造）。
- 桥工具集 = 7 个域动作：`game_observe`、`game_status`（只读）、`game_move_to`、`game_say`、`game_collect`、`game_follow`（写）、`game_cancel`。参数校验复用 game-host 域工具的描述（`gameHostListDomainTools` 同源 schema），不信任技能传入的形状。
- 回执透传 `GameDomainResult` 原字段（`commandId`、`status`、`world`、`checked`、`actual`、`endReason` 等），桥**不做成功合成**。
- 未连接返回类型化错误 `not_connected`；未 attach 时桥工具不在桥表中（调用得 `Unknown tool`）。
- `game_cancel` 只能取消**本次程序运行自己发出的** commandId：桥层按运行维护 `issued` 集合，越权取消返回 `not_allowed`。

## D2 技能工具声明与批准绑定（skill-forge + skills store）

- `meta.json` 增字段：

```text
tools: string[]                 // 默认为 []（纯计算技能）；v1 只接受 game_* 桥名
execution?: { timeoutMs?: number }  // 5_000–300_000，默认 30_000
```

- `SelfAuthoredSkill` / `ReviewQueueEntry` 增 `tools` / `reviewedTools`。批准时绑定 `reviewedTools = entry.tools`；执行前要求 `reviewedTools` 与从 meta 读取的 `tools` **集合精确相等**，不一致返回类型化 `skill_tools_changed` 并进入重审。内容哈希语义不变（仍只覆盖 source）。
- 桥层白名单：每次 bridge 调用名必须 ∈ `reviewedTools` ∩ 已注册桥表；未声明调用返回类型化 `not_allowed` 并写 journal（可见，不静默）。
- 审阅 UI（`skills.vue`）展示声明工具列表；静态分析做**辅助**一致性检查：声明含游戏工具时，source 文本应出现对应桥名（静态、不执行）。
- 存量技能没有 `tools` 字段时按 `[]` 处理——纯计算技能行为不变；这不是兼容回退，而是新字段的默认值。

## D3 取消贯通（沙箱 + 游戏命令级联）

- 链路（逐跳新增接线，不带向后兼容分支）：EP-0 executor 的 AbortController（`packages/stage-ui/src/stores/ai/chat-llm/tools.ts:362-376`）→ `execute` 的 options.signal → `executeSkill(entry, input, { signal })` → `runProgram({ signal })` → `coder-host-install` → `codingHostCodeRun`（客户端已支持）→ main `codeRuntime.run(..., { signal })` → worker SIGKILL（`packages/coding-harness/src/ptc/runner.ts:149-159`）。
- 桥侧级联：main 桥按运行记录 `issued` commandIds；signal abort 时对每个在途 commandId 调 `port.cancel`，并等待游戏侧停止宽限结束。晚到回执标 `cancelled`/`revoked`，不入完成门。
- 用户取消与撤销（`removeToolsByIds` 的 abort）走同一路径；重复取消幂等。
- 超时：meta `execution.timeoutMs` 传给 `runProgram`（技能沙箱整体上限）；桥调用超时从同一值派生并设上限（code-mode 载荷增 `bridgeTimeoutMs`，默认仍 15s），使 `collect`（租约 180s）/`follow`（300s）不会先于租约被桥掐断。

## D4 证据与信任（嵌套）

- 技能外层 journal 记 `tool/call` / `tool/result`，provenance `reviewed_self_authored` 不变。
- 桥内层游戏活动经 game-host 已有回执路径记录（`game_adapter` owner、`game` 桶）；`checked` 证据只能由 game-host 产出，技能返回值中出现的同名字段一律忽略/剥离。
- 完成门消费内层回执时按 game-host 判定作者与信任；"包装不提升信任"沿用 EP-0 验收。

## D5 缺条件与错误模型

- 桥返回类型化错误码：`not_connected`、`unknown_command`、`invalid_params`、`unreachable`、`target_lost`、`cancelled`、`timeout`、`not_allowed`。
- 技能收到错误必须如实失败（返回 `{ ok: false, reason }` 或抛出）；验收断言：缺条件时无 `checked` 证据、无假成功。
- 前置判定：技能可用 `game_observe` / `game_status`（只读，含连接与世界代次）自行判定条件。

## 验收场景（五类）

固定夹具技能 `mc1c-sand-supply`：`game_observe` → `game_move_to(目标点)` → `game_collect(sand, maxCount=1)` → `game_say(汇报)`，声明工具 = 这四个。

| 情形 | 操作 | 期望与证据 |
| --- | --- | --- |
| 成功 | 真聊天/探针触发执行 | 库存增量正确、say 聊天可见、journal 链完整（外层技能 + 内层游戏回执）；内层 `checked` 由 game-host 产出 |
| 缺条件 | 同技能改查不存在的方块类型；或断开游戏后执行 | 类型化错误（`unreachable` / `not_connected`）、无 `checked`、无假成功、无残留动作 |
| 取消 | 运行中（collect 挖掘阶段）用户停止 | 沙箱被 SIGKILL、游戏命令 `cancelled`、玩家无残留移动；晚到回执 `revoked` |
| 撤销 | 运行中在 `#/devtools/skills-adapter` unwrap 审阅技能 | 工具面消失、在途终止、迟到回执 `revoked` 不入完成门（EP-0 语义）、重复撤销幂等 |
| 内容变更 | 批准后编辑 source；或改 `tools` 声明 | 执行被拒（`hash_mismatch` / `skill_tools_changed`）；重审后可执行；在途执行按 D3 终止 |

## 实现落点

- `apps/stage-tamagotchi/src/main/services/airi/game-host/index.ts`：导出 `GameCommandPort`（连接状态、域工具描述、execute、cancel）。
- `apps/stage-tamagotchi/src/main/services/airi/coding-host/index.ts`：桥工具集、`attachGameCommands`、运行级 `issued`/取消级联、journal。
- `apps/stage-tamagotchi/src/main/index.ts`：晚绑定（coding-host 构建返回值 + game-host 返回值）。
- `packages/coding-harness/src/ptc/{code-mode.ts,protocol.ts,worker.ts}`：载荷/选项扩展 `bridgeTimeoutMs`（worker 无需新能力）。
- `packages/skill-forge/src/types.ts`：声明字段与类型化错误。
- `apps/stage-tamagotchi/src/renderer/stores/tools/builtin/skill-submit.ts`：meta 序列化/校验（tools、execution）。
- `packages/stage-ui/src/stores/skills.ts`：`signal` 传递、`reviewedTools` 绑定与执行前校验、`execute` options 透传。
- `packages/stage-pages/src/pages/settings/modules/skills.vue`：声明工具展示与重审提示。
- `apps/stage-tamagotchi/src/renderer/bridges/coding-host-install.ts` / `coding-host.ts`：signal 接线（客户端类型已有）。
- 测试：coding-host 桥派发/白名单/取消级联、game port、`skills.test.ts`、`skill-submit.test.ts`、`packages-registration.test.ts`。

## 风险与回退

- **技能 blast radius 扩大**：白名单 + 声明精确绑定 + 只读/写分离 + 运行内取消四层约束；回退 = 不 attach 游戏桥（技能回纯计算）；再回退 = 声明层禁用 `game_*`。
- **长桥调用**：受 meta 超时、命令租约、停止宽限三重约束；桥超不得不短于租约。
- **信任提升**：D4 嵌套规则；完成门不消费技能自造 `checked`；回归沿用 EP-0 场景。
- **静态分析漂移**：声明与实现不一致只影响审阅提示，不改变执行安全（白名单在桥层强制）。

## 明确不做（本批）

- 通用"渲染端工具面转发"桥（main→renderer RPC 与 leader 路由）：重，后续按需。
- CP-2 权限扩展到技能：v1 以声明 allowlist 为闸门，权限模型另立。
- 新增游戏域工具（战斗/投喂/繁殖/复杂合成仍属 MC-2 或后续批次）。
- 技能包分发：MC-1c 走 SG 审阅 + EP-1 适配器；EP-2a 打包非必需。
- 多技能编排/技能嵌套调用。

## 本轮交付与检查

仅新增本文档并更新 MODS.md 索引；未改产品代码、未跑游戏。实施前需按本规范逐增量提交，并按五类情形做真机验收。

## 实施记录（2026-09-13）

- **增量 1（D1）**：game-host 抽取 `executeDomainCommand` 并导出 `GameCommandPort`（`isConnected`/`listTools`/`execute`(signal)/`cancel`）；coding-host 新增 7 个桥工具（`requiresDeclaration`、参数必填校验、`not_attached`/`not_connected`/`invalid_params`/`not_allowed` 类型化错误、自身命令取消白名单）、`attachGameCommands` 晚绑定与工具表重建；`main/index.ts` 在 game-host 构建后接线。
- **增量 2（D2）**：`skill-forge` 增 `tools`/`execution` 与 `GAME_BRIDGE_TOOL_NAMES`；`skill_submit` 校验声明（未知工具拒绝、声明名未出现在源码拒绝）并写入 meta/队列；批准绑定 `reviewedTools`；执行前读磁盘 meta 精确比对（`skill_tools_changed`）；`activeEntries` 同步过滤；审阅卡展示声明工具。
- **增量 3（D3）**：`runProgram` 接受 `signal`/`timeoutMs`/`allowedTools`；`executeSkill` 传声明白名单与执行上限（默认 30s，声明优先）；eventa 0.3.0 不投递渲染端取消 → 显式 `codingHostCodeCancel({ runId })` + 主进程 `activeRuns` 映射，桥调用随运行 signal 级联 `port.cancel`；桥超时随程序超时派生（不短于命令租约）。
- **D4 内层证据**：`SkillRuntimeProgramResult` 携带桥 traces；`game_*` traces 写入 journal（`checked:true` → `game_checked`，否则 `game`），非游戏桥调用保持私有；技能返回值不能制造 `checked`。
- **修复**：`allowedTools` 直接传响应式数组导致 eventa 结构化克隆失败 → 执行时改为普通数组拷贝。
- 测试：coding-harness 83、coding-host（桥工具 11、挂载、端口 3）、stage-ui skills 28、skill-submit 11；相关包 typecheck/eslint 0。

## 真机验收（2026-09-13，五类 PASS）

记录见 [evidence/mc-1c/live-acceptance-20260913.md](./evidence/mc-1c/live-acceptance-20260913.md)。

- 成功：`game_collect checked actual:1` + say，journal 内层 `game_checked`、外层 `reviewed_self_authored`。
- 缺条件：不存在方块 → `failed/no_target/actual 0`，无假成功；`checked` 按既有判定表示"回执已验证"。
- 取消：follow 运行中 turn abort → 沙箱 `Sandbox worker aborted`，按 commandId 查回执 `cancelled`，停止后水平漂移 0。
- 撤销：运行中 `unwrapReviewedSkill` → `status:revoked`，工具面移除且幂等。
- 内容变更：改源码 → 执行被拒（`Skill source changed…`）并可重审恢复；仅改 meta `tools` → `The declared tools changed…`。
- 补充：水域卡位环境背景、类型目标跟随的死亡重定向与原生拾取行为已记录。
- 清理：四个夹具移除、工作区目录删除、适配器模式键清除、路由复位。
