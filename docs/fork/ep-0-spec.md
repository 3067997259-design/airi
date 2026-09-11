# EP-0 契约规范：工具标识、来源、权限与撤销

日期：2026-09-11。状态：规范定稿，实施未开始。批次：EP-0。

本文件钉死 [EP 执行计划](./extension-execution-plan.md) 中 EP-0 的契约。计划管顺序与验收；本规范管契约长什么样、哪些值不可协商。EP-0 是 MC-0c 与 CP-2 的共同前置。

规范覆盖四件事：注册记录（能力以什么身份进入工具面）、证据来源（信任等级跟随什么）、完整取消链路（撤销如何终止在途）、单一所有者（重复注册如何处理）。

## 决策记录

| # | 决策 | 内容 | 理由 |
| --- | --- | --- | --- |
| E0-D1 | 注册记录进同步状态 | `ToolRegistration` 与 `tools` 并列存于 `useLlmToolsStore` 的同步状态；`executors` 继续不外同步 | 记录只含可 `structuredClone` 的标量；跨窗口的判定必须看到同一份记录，否则两窗口对同一工具的证据等级会不一致 |
| E0-D2 | 双键唯一 | `id` 唯一，且模型面 `function.name` 不得被不同 `id` 复用；违规抛 `DuplicateToolRegistrationError` | 计划同时提到"同名工具"与"toolId"，审计确认工具解析按 `function.name`、执行按 `id`，两套键都要守 |
| E0-D3 | 新增两个证据桶 + 一个核对态 | `ToolEvidenceAuthor` 增 `untrusted_plugin` 与 `game`；`game` 在证据层分原始与核对后两级 | 计划只给名字；游戏回执必须先核对来源、授权、连接代次、命令身份才能参与完成门 |
| E0-D4 | 完整取消链路 | 注册项级 `AbortController`，组合进 xsai 的 `abortSignal`；MCP 与插件走 `requestId` + 取消通道；沙箱加 `signal`；`ToolResultOutcome` 增 `revoked` | 用户选择。审计确认底座目前只有 turn 级 abort，且 Eventa 无法传 `AbortSignal` 对象 |
| E0-D5 | 未登记不落 builtin | 删除 `getToolEvidenceAuthor` 的静默 `builtin` 兜底；未登记显式归 `untrusted_plugin` | `builtin` 兜底正是计划 D1 针对的漏洞：换个包装方式就提高信任等级 |
| E0-D6 | 退役不动遗产 | MC 相关的 `gaming-minecraft` 等不在 EP-0 内删除，只登记（见 [MC-0a 规范](./mc-0a-spec.md)） | 归属 MC-0a；EP-0 只动工具注册与证据层 |

## 契约定稿

### 注册记录

```ts
/** Who owns one registered tool and how its execution is trusted. */
export interface ToolRegistration {
  /** Registration key; unique across the store. */
  toolId: string
  /** Model-facing function name; unique across the store, unlike toolId opaque. */
  toolName: string
  ownerKind: 'builtin' | 'reviewed_skill' | 'plugin' | 'game_adapter' | 'mcp'
  /** Per-tool owner: skill toolId, extension id, game-host service, MCP server name. */
  ownerId: string
  /**
   * Execution chain from the registration surface down to the executor.
   * The authority is read at the deepest entry, never at the wrapper.
   */
  execution: {
    kind: 'host' | 'coding_sandbox' | 'extension_host' | 'remote'
    chain: string[]
  }
  /** Required when ownerKind is reviewed_skill or plugin. Validated on add. */
  approvedContentHash?: string
  registeredAt: number
}
```

存放：`useLlmToolsStore`（`packages/stage-ui/src/stores/ai/chat-llm/tools.ts`）的同步状态，与 `tools` 并列的新字段。`executors` 保持不外同步（其注释已说明不跨 leader 边界）。

跨窗口提交：新增同步提交动作（暂名 `commitRegistrations`），承载体与现有 `commitToolDefinitions`/`commitToolRemovals` 一致——只有它跨 leader 边界。**不**通过扩展 `addTools` 的散参数携带元数据。

`registeredAt` 用 `Date.now()`；同一毫秒内的多个注册不要求有序。它只用于诊断，不参与任何判定。

### 单一所有者（E0-D2）

新增错误类型：

```ts
/** Raised when a registration would violate single-owner or name uniqueness. */
export class DuplicateToolRegistrationError extends Error {
  readonly toolId: string
  readonly conflicting: 'toolId' | 'toolName'
  readonly existingOwnerId: string
}
```

规则：

1. 同一 `toolId` 已存在且 `ownerId` 相同 → 视为刷新（替换，保持列表位置），不抛错。
2. 同一 `toolId` 已存在但 `ownerId` 不同 → 抛错，`conflicting: 'toolId'`。
3. 同一 `toolName` 已被不同 `toolId` 占用 → 抛错，`conflicting: 'toolName'`。

这替换了当前 `mergeToolDefinitions` 的静默覆盖（`tools.ts:31-35`，其测试 `tools.test.ts:54-69` 断言覆盖行为，须改写）。

迁移走"撤下 → 登记"两步：先 `removeToolById`，确认移除后再 `addTools`。两步之间工具暂时不可用，不允许双注册窗口。迁移期的中间态是"工具缺席"，不是"两个同名工具并存"。

### 四条注册路径

计划写"三条"，审计确认是**四条**（遗漏了 reviewed skills）。每条登记时提供完整记录：

| 注册路径 | 文件 | ownerKind | ownerId | execution.kind | chain |
| --- | --- | --- | --- | --- | --- |
| built-in 宿主工具 | `apps/stage-tamagotchi/src/renderer/stores/tools/built-in.ts:272` | `builtin` | `'host'` | `host` | `['builtin']` |
| built-in 内的 coding 工具 | 同上（`createCodingHostClient().listTools()`，约 231-235） | `builtin` | `'coding-host'` | `host` | `['builtin', 'coding-host']` |
| MCP 工具 | `apps/stage-tamagotchi/src/renderer/stores/tools/mcp.ts:97` | `mcp` | MCP `serverName` | `remote` | `['mcp', serverName]` |
| 插件工具 | `apps/stage-tamagotchi/src/renderer/stores/tools/plugins.ts:62` | `plugin` | `ownerExtensionId` | `extension_host` | `['plugin', extensionId]` |
| reviewed 技能 | `packages/stage-ui/src/stores/skills.ts:282` | `reviewed_skill` | 技能 `toolId` | `coding_sandbox` | `['skill', toolId]` |

执行来源的映射（`execution.kind`）最终值：宿主自带与 coding-host 工具 = `host`；技能 = `coding_sandbox`；插件 = `extension_host`；MCP 与 game = `remote`。

**MCP 的 `serverName` 提取**：审计确认 `createMcpNativeTools`（`packages/stage-ui/src/tools/mcp.ts:225-247`）在构建 Tool 时丢弃了 `descriptor.serverName`，而 `mcp.ts` 的注册循环（93 行）手里有 `descriptors`。规范要求：由 descriptors 生成一份与工具数组**索引对齐**的元数据数组，注册时按索引取 `serverName`；禁止从工具名反解析。若未来 descriptors 与工具数组不再一一对应，须在实现处改为按 `descriptor.name` 关联并加断言。

**技能路径的 `toolId` 与 `toolName`**：技能注册的 `id` 是 `self-authored:${entry.toolId}`，模型面 `function.name` 是 `entry.tool.name`（`skills.ts:267-270`）。两者都进记录：`toolId` 取注册 id，`toolName` 取 `entry.tool.name`。证据判定查的是 `toolName`（见下节）。

### 证据来源与判定

`ToolEvidenceAuthor` 扩展为：

```ts
export type ToolEvidenceAuthor
  = | 'builtin'
    | 'reviewed_self_authored'
    | 'unreviewed_self_authored'
    | 'remote_agent'
    | 'untrusted_plugin'
    | 'game'
    | 'game_checked'
```

`game` 与 `game_checked` 的区别由生产者（游戏适配器）决定：原始回执盖 `game`，完成核对后的回执盖 `game_checked`。这样所有证据都经 `resolveEvidenceAuthority` 一个入口解析，不新增绕过路径。

`PlanningAuthoritySource` 新增三条，插进 `PLANNING_AUTHORITY_ORDER`（`packages/core-agent/src/authority/contract.ts:413-505`）：

| 新 source | precedence | maySatisfyVerificationGate | maySatisfyMutationProof | 用途 |
| --- | --- | --- | --- | --- |
| `game_adapter_report` | 44 | false | false | 游戏适配器的原始回执（未核对） |
| `game_adapter_checked_result` | 41 | true | false | 游戏适配器核对来源/授权/连接代次/命令身份后的结果 |
| `untrusted_plugin_report` | 46 | false | false | 无有效执行链批准、或未登记的插件回执 |

precedence 取值语义：**数值越小权威越高**（与既有表一致，`runtime_system_rules` 为 0，记忆类为 60-90）。三个新 source 的最终相邻关系，`>` 读作"权威高于"：

```
trusted_current_run_tool_evidence (40)
  > game_adapter_checked_result (41)
  > reviewed_self_authored_tool_result (42)
  > game_adapter_report (44)
  > remote_agent_report (45)
  > untrusted_plugin_report (46)
  > unreviewed_self_authored_tool_result (47)
```

40-47 之间除 43 已全部占用；43 留空以备将来插入。

取值理由，各一句：

- `game_adapter_checked_result` 取 41（仅次于宿主自证）：它的权威来自宿主侧对**本地受控实例**的确定性核对（来源、授权、连接代次、命令身份、新鲜状态），不是模型声称。因此它高过 reviewed 技能的自报结果。该范围限定为本地受控游戏实例，不得扩展到任意远端报告。
- `game_adapter_report` 取 44（低于 reviewed 技能、高于远端报告）：未核对的原始游戏回执只是外部数据，作指引不作证明。
- `untrusted_plugin_report` 取 46（低于远端报告）：无有效执行链批准的插件回执，其来源比受信 MCP 服务器更弱。

两个游戏 source 的 `maySatisfyMutationProof` 均为 false——游戏动作不构成对工作区文件的变更证明；只有核对后的游戏回执可满足验证门（`maySatisfyVerificationGate: true`），因为核对的产物正是一个可核验的目标条件结论。

`resolveEvidenceAuthority`（`provenance.ts:42-67`）内层 switch 必须补三个 case，**否则函数在内层 switch 后 `break`、外层无返回，隐式返回 `undefined` 而声明返回类型是 `PlanningAuthorityRule`**——审计确认当前无 `default`。补 case 的映射：

| author | → source |
| --- | --- |
| `untrusted_plugin` | `untrusted_plugin_report` |
| `game` | `game_adapter_report` |
| `game_checked` | `game_adapter_checked_result` |

`game_checked` 只应由游戏适配器的核对流程写入，且只在核对通过时写入；核对未通过时保持 `game`。

### Journal 扩展

```ts
/** Widened: 'revoked' marks a receipt that arrived after its registration was revoked. */
export type ToolResultOutcome = 'ok' | 'failed' | 'denied' | 'timeout' | 'revoked'
```

`ToolResultEvent`（`packages/core-agent/src/journal/types.ts:137-161`）字段不变，`outcome` 取值域扩大。

需审计的消费者（加入 `revoked` 后逐一确认不误判为成功）：`packages/core-agent/src/journal/projection.ts:135`、`journal/task-run.ts:282`、`planning/evidence-gate.ts:70`、`runtime/chat-orchestrator-runtime.ts`（`isMutationSuccess`/`recordFlowFailure` 等按字面比较处）、`packages/stage-ui/src/stores/chat.ts:984`、`stores/coding.ts:173`。判定原则：`revoked` 等同于"非成功"，且**不得进入任何完成门**（与 `failed` 同级，但语义是"无效回执"，不记为失败证据）。

### 完整取消链路（E0-D4）

分四段，每段给出契约与落点。

**1. 注册项级取消句柄。** 每个 `ToolRegistration` 关联一个 `AbortController`，存活于 `useLlmToolsStore`（不进入同步状态、不跨进程）。工具 `execute` 收到的 xsai `executeOptions.abortSignal` 与该注册项的 signal 用 `AbortSignal.any` 组合（`packages/stage-ui/src/tools/fetch.ts:195` 与 `web-search.ts:224` 已是仓库既有模式）：

```ts
/** Combines the turn abort with the registration abort; either aborts the call. */
function toolSignal(registration: ToolRegistration, turnSignal?: AbortSignal): AbortSignal {
  const own = registrationAbortSignal(registration)
  return turnSignal ? AbortSignal.any([turnSignal, own]) : own
}
```

`registrationAbortSignal` 的句柄存放由实现决定；规范只钉：撤销注册项时 `abort()` 该控制器，且该控制器对所有在途调用可见。

**2. MCP 调用。** Eventa 不能传 `AbortSignal` 对象。契约改为 requestId + 独立取消 invoke：

```ts
/** MCP call payload: adds a correlation id so a cancel can target one call. */
export interface ElectronMcpCallToolPayload {
  requestId: string
  name: string
  arguments?: Record<string, unknown>
}

/** Cancels one in-flight MCP call by correlation id. Idempotent. */
export const electronMcpCancelTool = defineInvokeEventa<{ cancelled: boolean }, { requestId: string }>(
  'eventa:invoke:electron:mcp:cancel-tool',
)
```

主进程侧：`runMcpRequest`（`apps/stage-tamagotchi/src/main/services/airi/mcp-servers/index.ts:101-130`）自持 AbortController，收到 cancel invoke 时按 requestId 找到对应 controller 并 abort。渲染侧 `McpToolRuntime.callTool`（`packages/stage-ui/src/tools/mcp.ts:78`）与两个 execute 包装（112、239 行）目前丢弃了 `ToolExecuteOptions`，须改为接收并把 requestId 传出、在 abort 时发 cancel invoke。

**3. 插件调用。** 同形。`electronPluginInvokeTool`（`apps/stage-tamagotchi/src/shared/eventa/plugin/tools.ts:102-106`）载荷增 `requestId`，新增取消 invoke。穿透：`plugins/index.ts:111-113` 处理器 → `TamagotchiToolRegistry.invoke`（`packages/plugin-sdk-tamagotchi/src/tools/registry.ts:229-237`）→ `record.execute`（registry.ts:83 的类型加可选取消参数）。渲染侧 `plugins.ts:52-56` 目前不转发 `ToolExecuteOptions`，须补。

**4. PTC 沙箱。** `SandboxRunnerOptions`（`packages/coding-harness/src/ptc/runner.ts:40-44`）增 `signal?: AbortSignal`；`CodeModeRuntimeOptions`/`run`（`ptc/code-mode.ts:44-65`）透传。当前仅在超时时 `child.kill('SIGKILL')`（runner.ts:133-139）；须增一条：signal abort 时按 handle 立即 SIGKILL。coding-host 的 exec/code 处理器（`apps/stage-tamagotchi/src/main/services/airi/coding-host/index.ts:285,304-309`）须把请求侧 signal 接入。

### 撤销语义

撤销一个注册 = 三件事按序生效：

1. **撤工具面与提示**：从 `tools` 与 toolset prompts 移除；对应 `ToolRegistration` 移除。
2. **终止在途**：`abort()` 该注册项的控制器；MCP/插件另发取消 invoke；沙箱 SIGKILL。
3. **迟到回执标 `revoked`**：撤销时刻之后到达的回执写 `outcome: 'revoked'`，不入完成门。

撤销是 leader-owned、幂等的 action；重复撤销无副作用。多窗口下撤销后全部窗口最终一致（记录随同步状态传播）。

## 底座现状与目标差异

实施时逐条对照。审计日期 2026-09-11。

| 能力 | 现状 | 目标 | 位置 |
| --- | --- | --- | --- |
| 注册记录 | 无；`tools` 是 `ExecutableTool[]`，`executors` 是 Map | `ToolRegistration` + 同步提交动作 | `tools.ts:61-62` |
| 重复拒绝 | 静默覆盖，测试断言覆盖 | 抛 `DuplicateToolRegistrationError` | `tools.ts:31-35`、`tools.test.ts:54-69` |
| 证据桶 | 四值，`resolveEvidenceAuthority` 无 default | 七值 + 三 source | `provenance.ts:14,42` |
| 未登记兜底 | 静默归 `builtin` | 显式归 `untrusted_plugin` | `chat.ts:927-936` |
| 注册项级取消 | 无；只有 turn 级 AbortController | 每注册项一个，`AbortSignal.any` 组合 | `chat-orchestrator-runtime.ts:2158` |
| MCP 取消 | payload 无 requestId，无 cancel 通道 | requestId + cancel invoke | `eventa/index.ts:311-314` |
| 插件取消 | payload 仅 `{ownerExtensionId,name,input}` | 加 requestId + cancel 通道 | `plugin/tools.ts:102-106` |
| 沙箱取消 | 仅超时 SIGKILL | 增 signal → SIGKILL | `ptc/runner.ts:133-139` |
| `revoked` 结果 | 不存在 | `ToolResultOutcome` 增成员 | `journal/types.ts:60` |

## 工作项与通过条件

| # | 交付 | 依赖 | 通过条件 |
| --- | --- | --- | --- |
| 1 | `ToolRegistration` 类型 + store 字段 + 同步提交动作 | 无 | 类型导出；跨窗口记录一致；`pnpm -F @proj-airi/stage-ui typecheck` 通过 |
| 2 | 双键唯一 + `DuplicateToolRegistrationError` | 1 | 三类场景各单测（同 owner 刷新 / 同 id 异 owner 抛错 / 同 name 异 id 抛错） |
| 3 | 四条路径迁移登记元数据 | 1 | 四条路径各自登记完整记录；迁移前后现有工具测试等价 |
| 4 | 证据桶扩展 + switch 补 case | 无 | 七值；三个新 source 进权威表；权威表严格升序测试通过；`resolveEvidenceAuthority` 不再有隐式 undefined 路径 |
| 5 | `getToolEvidenceAuthor` 按记录判定 | 1,4 | 包装不改变等级；未登记归 `untrusted_plugin`；技能查 `toolName` |
| 6 | 完整取消链路四段 | 1 | 每段有可跑取消回归；撤销后 in-flight 被终止 |
| 7 | `revoked` 结果 + 撤销语义 | 6 | 迟到回执标 revoked 且不入完成门；撤销幂等；多窗口一致 |

## 设计不变量

1. **包装不提升信任**：同一技能经插件包装后，`getToolEvidenceAuthor` 返回值不变；journal 同时记录包装来源。
2. **未登记不落 builtin**：任何未在注册记录中的工具，证据等级为 `untrusted_plugin`，永不 `builtin`。
3. **单一所有者**：同 `toolId` 或同 `toolName` 的不同所有者注册被拒；同所有者重复注册为幂等刷新。
4. **撤销三步齐全**：撤销后（a）工具不在工具面、（b）在途调用被终止、（c）迟到回执 `outcome: 'revoked'` 且不进完成门。
5. **批准失效即降级**：执行链上的 `approvedContentHash` 失效时，整链降级为 `untrusted_plugin`；已入门的旧证据不被追溯篡改，新调用被拒。
6. **取消断言可用**：任一注册项的取消都能终止其 MCP、插件、沙箱三类在途调用中的对应一类。
7. **权威表严格升序**：`PLANNING_AUTHORITY_ORDER` 的 precedence 严格递增；新增三条不破坏该断言。

## 验收场景

| 场景 | 期望与证据 |
| --- | --- |
| 包装不提升信任 | 技能经插件包装调用后证据作者与直调相同；journal 有 surface 记录（不变量 1） |
| 未登记兜底 | 注册一个不在记录中的工具名调用 → 证据等级 `untrusted_plugin`（不变量 2） |
| 双重注册被拒 | 同名工具第二次注册抛 `DuplicateToolRegistrationError`；迁移中间态无重叠（不变量 3） |
| 撤销三步 | 撤销后工具消失、在途终止、迟到回执 `revoked` 不入完成门（不变量 4） |
| 批准失效 | 替换技能源码使哈希失效 → 整链降级；旧证据不追溯（不变量 5） |
| 三类取消 | 分别对 MCP、插件、沙箱在途调用执行撤销，各自被终止（不变量 6） |
| 权威表升序 | 跑 `contract.test.ts` 的升序断言（不变量 7） |
| 多窗口一致 | leader 撤销后全部窗口记录一致；重复撤销幂等 |

结果记录沿用 fork 惯例：PASS/FAIL/BLOCKED/NOT-RUN 加证明范围。

## 明确不做

- 不做任意 Node 入口插件的信任（属 EP-2）。
- 不做失败后的模型重试策略（属其它批次）。
- 不改 `executors` 的外同步状态。
- 不删除 MC 遗产（`gaming-minecraft` 等，属 MC-0a 规范）。
- 不引入新的通用取消框架；只用 `AbortController` + `AbortSignal.any` 与 requestId 通道。

## 与执行计划的关系

- [extension-execution-plan.md](./extension-execution-plan.md)：EP-0 的批次定义与验收在本规范细化。更正三处：注册路径是**四条**（含 reviewed skills，计划写三条）；LLM tools store 的实体在 `packages/stage-ui/src/stores/ai/chat-llm/tools.ts`（计划的 `apps/.../tools/index.ts` 只是 re-export barrel）；`getToolEvidenceAuthor` 在 `chat.ts:927`（计划写 921，行漂移）。
- [cp-0-spec.md](./cp-0-spec.md)：manifest 新增字段的加法纪律见该文件"加法纪律"节。
- [mc-0a-spec.md](./mc-0a-spec.md)：`game_adapter` ownerKind 与 `game` 证据桶供 MC-0c 使用；MC-0a 本身不注册工具面。

## 本轮交付与检查

本轮只新增本规范文档并更新 MODS.md 索引。未改动产品代码、未实现取消链路或注册记录。文中 precedence 数值、字段名与错误类型名为最终值；实施时若发现与现有断言冲突，以本文件为准并记录偏离原因。代码锚点为 2026-09-11 工作区实际位置，行号漂移以符号名为准。
