# CP-0 契约规范：加法纪律与版本协商

日期：2026-09-11。状态：规范定稿，实施未开始。批次：CP-0。

本文件钉死 [CP 野心线计划](./capability-platform-plan.md) 中 CP-0 的契约。计划管顺序与验收；本规范管契约长什么样、哪些值不可协商。实施时以本文件为准，与本文件冲突的计划文字以本文件为更正。

CP-0 是加法批次：它只向已发布协议添加可选字段与台账，不改任何既有名字的语义。CP-1/CP-2/CP-3 的契约都建立在本批的字段与台账之上。

## 决策记录

| # | 决策 | 内容 | 理由 |
| --- | --- | --- | --- |
| C0-D1 | 每批一份规范 | 规范与执行计划分文件：计划管顺序，规范管契约 | 用户选择。计划已很长，规范需要逐条不可协商，两者混排会让两者都变模糊 |
| C0-D2 | 不复用 `module:compatibility:*` | 协议里既有的一对兼容性事件全仓零发射零消费，本批**不接线、不修改、不扩展**，只登记为"未接线的上游面" | 加法纪律：把休眠事件改成另一套语义会破坏未来上游若启用它们的兼容性。登记比改造安全 |
| C0-D3 | 双发送路径都穿 | `ForkProtocolDescriptor` 必须同时穿透 `server-sdk` 的两条 announce 路径 | 审计发现 `extension-peer.ts` 是计划未提到的第二条发送路径；只改一条会让一半模块协商失败 |
| C0-D4 | 缺省即上游 | 字段缺席时行为与上游逐项一致；未知 `extensions` 条目忽略 | 前向兼容与可回退的上游对等，是"两侧插件可兼容"这一目标的技术基础 |
| C0-D5 | 台账先于实现 | COMPAT 台账格式在 CP-0 定稿，内容随各批追加 | 兼容成本必须始终有清单可查，否则偏离会静默累积 |

## 契约定稿

### ForkProtocolDescriptor

```ts
/**
 * Fork protocol declaration carried on a module announce. Both sides absent
 * means the connection behaves exactly like upstream. The field is additive:
 * it never changes the meaning of existing announce fields.
 */
export interface ForkProtocolDescriptor {
  /** Fork protocol version. Starts at 1. Higher means newer. */
  version: number
  /**
   * Identifiers of upstream Next Steps items this side implements, for example
   * 'capability-registry' | 'node-worker' | 'remote-plugins'. Unknown entries
   * are ignored so a newer peer can talk to an older one.
   */
  extensions: string[]
}
```

字段名与形状是最终值。上游若将来采纳同一字段名，本字段直接兼容——它是纯加法，这是 C0-D4 的直接收益。

### 挂载点

`ForkProtocolDescriptor` 作为**可选**字段挂到两个 announce 事件的载荷上，字段名 `forkProtocol`：

| 类型 | 位置 | 变更 |
| --- | --- | --- |
| `ExtensionModuleAnnounceEvent` | `packages/plugin-protocol/src/types/events.ts:693` | 增可选 `forkProtocol?: ForkProtocolDescriptor` |
| `ModuleAnnounceEvent` | `packages/plugin-protocol/src/types/events.ts:746` | 增可选 `forkProtocol?: ForkProtocolDescriptor` |

`ExtensionAnnounceEvent`（同文件 688 行）与 `ModuleAnnouncedEvent`（754 行）**不带**该字段。理由：前者是扩展级声明而非模块级传输声明；后者是 host 回显的确认事件，其载荷字段集不同（且 server-runtime 对 `extension:module:announced` 原样回显 `event.data`，无需在此重声明）。

### 两条发送路径（C0-D3）

审计确认 announce 有两条发送路径，规范要求同时穿透：

| 路径 | 文件与位置 | 变更 |
| --- | --- | --- |
| 主路径 | `packages/server-sdk/src/client.ts:439-448` 的 announce 构造 | 把 `forkProtocol` 加进发送载荷 |
| 第二路径 | `packages/server-sdk/src/extension-peer.ts:105-121` 的 `announceModule` | 同上；该路径目前额外带 `permissions`，本字段一并带 |
| 选项穿透 | `ClientOptions`（`client.ts:55-86`）与 `NormalizedClientOptions`（`client.ts:88-110`） | 增可选 `forkProtocol?: ForkProtocolDescriptor`，在规范化时保留 |
| 第二路径输入 | `extension-peer.ts` 的 `AnnounceExtensionModuleInput` | 增可选同名字段 |

缺省规则：选项未提供时，发送载荷**不含** `forkProtocol` 键（不是 `undefined` 占位、不是默认对象）——保持与上游字节级一致，C0-D4 的可对照性依赖这一点。

### 本地等价路径

本地（非 websocket）模块注册走 `packages/plugin-sdk/src/plugin-host/core.ts` 的 `RegisterExtensionModuleInput`（约 285-289 行的 `ctx.modules.register`）。

规范决定：**本地路径带同名字段** `forkProtocol?: ForkProtocolDescriptor`，语义与远程一致（出席即参与协商，缺席即缺省行为）。理由：CP-1 的能力注册表同时服务本地与远程模块，若本地路径没有该字段，同一模块在两种传输下的协商结果会不一致，直接违背 CP 计划 D1 的"宿主内部无需兼容、作者面必须一致"分层。

不改 `ctx.modules.register` 的既有必填字段，只增可选字段。

### 协商算法

```ts
/** Result of one announce-time negotiation, stored per module. */
export interface ForkNegotiationResult {
  /** Highest version both sides support, or null when incompatible. */
  agreedVersion: number | null
  /** Extensions present in both sides' lists. */
  agreedExtensions: string[]
  /** Adopted only when agreedVersion is not null. */
  mode: 'exact' | 'downgraded' | 'absent'
}
```

规则，按序求值：

1. 对方未带 `forkProtocol` → `mode: 'absent'`，`agreedVersion: null`，`agreedExtensions: []`；连接按上游行为继续，**不报错**。
2. 双方都带 → `agreedVersion` 取双方共同支持的最高版本。本 fork 首批只实现 `version: 1`，故共同集合是 `{1}` 时 `mode: 'exact'`；对方只支持更高版本而本侧不支持时 `mode: 'downgraded'` 且 `agreedVersion` 为双方交集最高值；交集为空 → 见规则 3。
3. 交集为空 → 抛类型化错误 `ProtocolVersionIncompatibleError`（下节），连接不建立。
4. `agreedExtensions` = 双方列表交集；**未知条目忽略**（对方列表里本侧不认识的标识直接丢弃，不报错）。本侧不认识的条目不写进结果，也不影响 `agreedVersion`。

### 类型化错误

```ts
/** Raised at the announce boundary when no common fork protocol version exists. */
export class ProtocolVersionIncompatibleError extends Error {
  readonly localVersion: number
  readonly remoteVersion: number
  readonly localSupported: number[]
  readonly remoteSupported: number[]
}
```

抛出层：announce 的**接收侧**（协商在哪一侧求值，就在哪一侧抛）。发送侧不抛——发送侧只声明自身能力。错误必须携带双方版本与各自支持集，便于日志定位是哪一侧缺哪个版本。抛错后连接不建立，且**不静默降级**（AGENTS.md 禁止静默兼容回退）。

### 协商结果的存放

结果存放在协商接收侧的 per-module 记录里，与模块身份同生命周期：

```ts
export interface ModuleForkState {
  moduleId: string
  /** Present only after a successful negotiation. */
  negotiation?: ForkNegotiationResult
}
```

`mode: 'absent'` 时该记录仍写入（表示"已检查、对方是上游"），以便后续批次区分"未检查"与"检查过但对方是上游"。存放载体由实现决定（内存 Map 或 eventa 同步 state），规范只钉字段与生命周期：模块 de-announce 时记录一并移除。

## 加法纪律（条目化）

1. 新事件名一律带 `fork:` 前缀，例如 `fork:capability:snapshot`；不得复用无前缀名。
2. 新字段一律**可选**，且缺省值等于上游行为。缺省时发送载荷不含该键。
3. 不得修改既有字段的名字、类型或语义。需要不同语义时新增字段。
4. manifest 的新增字段同理可选，缺省等于上游行为（见 [EP 规范](./ep-0-spec.md) 对 manifest 的引用）。
5. 偏离上游已发布契约的每一处，必须登记进 COMPAT 台账。

## COMPAT 台账格式

台账文件 `docs/fork/capability-platform-compat.md` 由 CP-0 建立（本规范定义格式，文件在实施批次创建）。每条一行，五列：

| 列 | 含义 |
| --- | --- |
| 上游章节 | 上游设计文档的章节或协议符号，尽量精确到标题 |
| 实现位置 | 本 fork 的文件与符号 |
| 偏离 | 无偏离写"遵循"；有偏离写一句话说明差异 |
| 理由 | 为什么偏离（无偏离可留空） |
| 状态 | `遵循` / `已实现` / `未接线` / `暂不实现` |

预登记条目（CP-0 首次填写时写入）：

| 上游章节 | 实现位置 | 偏离 | 理由 | 状态 |
| --- | --- | --- | --- | --- |
| `module:compatibility:*`（`plugin-protocol/src/types/events.ts:715-727`） | 无 | 不接线 | 全仓零发射零消费；复用会破坏上游未来启用时的语义（C0-D2） | 未接线 |
| `plugin-lifecycle.md`（`multi-transport.md:194` 引用） | 无 | 引用缺失 | 上游从未写出该文档；本 fork 不代写 | 暂不实现 |
| `ui.panel` / 独立 widget 作者 kit | 无 | 未实现 | 出现消费者前不做 | 暂不实现 |
| 跨平台宿主（web/pocket） | 无 | 未实现 | 无消费者 | 暂不实现 |
| 市场 / 注册表 / 安装更新通道 | 无 | 未实现 | 个人 fork 等价物是本地目录 + 哈希批准 | 暂不实现 |

## 工作项与通过条件

| # | 交付 | 通过条件 |
| --- | --- | --- |
| 1 | `ForkProtocolDescriptor` 类型 + 两个 announce 字段 | 类型导出；两处 announce 事件可携带该字段；`pnpm -F @proj-airi/plugin-protocol typecheck` 通过 |
| 2 | 两条发送路径 + 选项穿透 | `client.ts` 与 `extension-peer.ts` 都能发送；选项缺席时载荷不含该键（对照测试断言键缺席） |
| 3 | 本地等价路径字段 | `RegisterExtensionModuleInput` 带同名字段；本地与远程协商对同一模块给出一致结果 |
| 4 | 协商算法 + 类型化错误 | 四类规则各有单测：absent / exact / downgraded / 交集为空抛错；未知 `extensions` 条目被忽略 |
| 5 | COMPAT 台账建立 | 文件存在、格式合规、预登记条目齐全 |

## 设计不变量

每条都是可检验的，实施后逐条写成回归。

1. **缺省即上游**：`forkProtocol` 缺席时，announce 载荷与上游逐项一致（字节级对照测试）；连接行为不变。
2. **纯加法**：任何新增不改变既有 announce 字段的名字、类型与语义；既有 announce 测试不改写即通过。
3. **未知条目忽略**：对方 `extensions` 含本侧不认识的标识时，协商成功且结果只含交集；不因未知条目报错。
4. **不静默降级**：交集为空时抛 `ProtocolVersionIncompatibleError` 且连接不建立；不得返回一个"降级后的可用"结果。
5. **两路径一致**：同一模块经 `client.ts` 或 `extension-peer.ts` 发送，协商结果相同。
6. **本地远程一致**：同一模块经本地 `RegisterExtensionModuleInput` 与远程 announce 注册，`ForkNegotiationResult` 相同。
7. **登记完整**：每一处偏离上游已发布契约的实现，都能在 COMPAT 台账找到一行。

## 验收场景

| 场景 | 操作 | 期望与证据 |
| --- | --- | --- |
| 双方都是上游 | 不带 `forkProtocol` 连接 | `mode: 'absent'`；载荷无该键；连接正常 |
| 双方都是 fork v1 | 都带 `version: 1` | `mode: 'exact'`，`agreedVersion: 1` |
| 对方只有更高版本 | 对方带 `version: 2`（本侧仅 1） | 交集为空 → 抛 `ProtocolVersionIncompatibleError`，含双方版本与支持集 |
| 未知扩展 | 对方 `extensions: ['future-thing']` | 协商成功，`agreedExtensions` 不含该条目，不报错 |
| 第二条路径 | 经 `extension-peer.ts` 发 announce | 与主路径同结果（不变量 5） |
| 本地路径 | 经 `ctx.modules.register` 注册 | 与远程同结果（不变量 6） |
| 台账 | 检查预登记条目 | 五列齐全、上游位置可核（不变量 7） |

结果记录沿用 fork 惯例：PASS/FAIL/BLOCKED/NOT-RUN 加证明范围。

## 明确不做

- 不接线 `module:compatibility:*`（C0-D2）。
- 不实现 CP-1 的能力注册表、CP-2 的权限 resolver、CP-3 的远程插件——本批只立字段与台账。
- 不代写上游缺失的 `plugin-lifecycle.md`。
- 不做 `versions` 数组形式的版本协商（单 `version` 数字 + 交集足够；多版本数组留给真有需求时以加法方式扩展）。

## 与执行计划的关系

- [capability-platform-plan.md](./capability-platform-plan.md)：CP-0 的批次定义、通过条件与验收在本规范细化；计划的"版本协商契约"节以本文件为最终值。
- 更正一处：计划称本地等价路径未定（"未实现分支"），本规范定为带同名字段（决定见"本地等价路径"节）。
- [wave-b-execution-plan.md](./wave-b-execution-plan.md)：CP-0 在 B 波次的切入口为工作项 1–2。

## 本轮交付与检查

本轮只新增本规范文档并更新 MODS.md 索引。未改动产品代码、未创建 COMPAT 台账文件（格式已定，文件待实施批次建立）、未安装外部依赖。文中代码锚点为 2026-09-11 工作区实际位置，实施时若行号漂移以符号名为准。
