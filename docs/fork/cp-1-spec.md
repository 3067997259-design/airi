# CP-1 契约规范：能力注册表与相位扩展

日期：2026-09-11。状态：规范定稿，实施未开始。批次：CP-1。

本文件钉死 [CP 野心线计划](./capability-platform-plan.md) 中 CP-1 的字段级契约：能力注册表（快照权威 + 事件增量）、`CapabilityRecord`/`CapabilityRequirement` 形状、生命周期新相位 `waiting-deps` 与 `degraded`、消费者接入点与观察者模式边界。上游设计以 `packages/plugin-sdk/docs/design/capability-orchestration.md`（fork 基线 e170d454e 内，D1 定义的 spec）为准。

## 决策记录

| # | 决策 | 内容 | 理由 |
| --- | --- | --- | --- |
| C1-D1 | 快照权威 | 注册表快照是就绪状态的唯一权威；事件只是增量信号，晚到消费者一律先查快照 | 上游 Q&A：防"错过就绪"竞态；消费者先行原则（CP 计划 D3） |
| C1-D2 | 记录形状照上游 | `CapabilityRecord` 与 `CapabilityRequirement` 按上游 baseline 原样实现 | D1 以已发布契约为 spec；偏离必须记 COMPAT |
| C1-D3 | 先做观察者 | 两个消费者（MC-0c game-host、EP-1 技能适配器）都声明能力前，注册表不接管任何调度；宿主现有启动顺序不变 | 计划通过条件；避免平台先行于消费者 |
| C1-D4 | 相位只加两个 | 生命周期只加 `waiting-deps` 与 `degraded`；不实现 14 相位全量 | 有消费者的相位才实现（CP 计划边界） |
| C1-D5 | 事件名 `fork:` 前缀 | 若向渲染端广播能力变化，事件名 `fork:capability:changed`；现有 `electronPluginUpdateCapability` 输入通道载荷不动 | CP-0 加法纪律；上游未定义该事件名 |
| C1-D6 | 超时显式暴露 | `waitForRequirement` 超时返回 `{ ok:false, missing }`，模块维持 `waiting-deps` 并把缺失清单写进可见状态 | 禁止静默降级/静默放行（EP-0/CP-0 纪律） |
| C1-D7 | 谓词按需求值 | `predicate` 在解析时对快照逐条求值；不缓存谓词结果，不预注册谓词索引 | 上游：谓词按需；避免过度设计（CP 计划风险节） |

## 契约定稿

### 能力注册表

新模块 `packages/plugin-sdk/src/plugin-host/capability-registry.ts`，无宿主副作用，可独立测试：

```ts
/** Upstream baseline, implemented verbatim. */
export interface CapabilityRecord {
  capabilityId: string
  providerModuleId: string
  hostId: string
  instanceId?: string
  runtime: 'electron' | 'web' | 'pocket' | 'node'
  state: 'announced' | 'ready' | 'degraded' | 'withdrawn'
  version?: string
  health?: 'ok' | 'degraded' | 'unknown'
  metadata?: Record<string, unknown>
}

/** Upstream baseline, implemented verbatim. */
export interface CapabilityRequirement {
  allOf?: string[]
  anyOf?: string[]
  predicate?: (record: CapabilityRecord) => boolean
  timeoutMs?: number
}

export interface CapabilitySnapshot {
  /** Snapshot sequence; increments on every accepted transition. */
  revision: number
  /** Wall-clock time the snapshot was assembled. */
  asOf: number
  records: CapabilityRecord[]
}

export interface CapabilityResolution {
  satisfied: boolean
  /** Records that satisfy the requirement, in snapshot order. */
  matched: CapabilityRecord[]
  /** Required ids that have no ready record. */
  missing: string[]
}
```

规则：

1. 记录键：`hostId + ':' + (instanceId ?? '*') + ':' + capabilityId`。同键后写覆盖前写；`withdrawn` 是删除前的终态记录（保留在同键语义里，直到显式删除或重新 announce）。
2. 状态转移只允许：`announced → ready → degraded → ready`、`ready/degraded → withdrawn`、`withdrawn → announced`（重新声明）。非法转移拒绝并抛类型化错误（不静默忽略）。
3. 快照按 `revision` 单调递增；`snapshot()` 返回复制，调用方不得改注册表内部状态。
4. 解析：`resolve(requirement)` 总是先取当前快照；`allOf` 全满足、`anyOf` 至少一条满足、`predicate` 对每条 `ready` 记录求值；返回 `missing` 供可见状态使用。
5. 订阅：`subscribe(listener)` 只在状态实际变化时收到 `{ revision, record, kind: 'upsert' | 'withdrawn' }`；取消订阅幂等。

### 生命周期相位扩展

`ExtensionSession` 相位扩为：

```ts
phase: 'setting-up' | 'waiting-deps' | 'ready' | 'degraded' | 'failed' | 'stopped'
```

转移规则（上游 Lifecycle Model 的本地落点）：

| 从 | 到 | 触发 |
| --- | --- | --- |
| `setting-up` | `waiting-deps` | `requires` 未满足（解析 `satisfied:false`） |
| `waiting-deps` | `setting-up` → `ready` | 依赖满足后确定性恢复；恢复路径不跳过 setup |
| `ready` | `degraded` | 已绑定的能力被 `degraded` 或 `withdrawn` |
| `degraded` | `ready` | 绑定能力回到 `ready` |
| 任一 | `failed` / `stopped` | 现有语义不变 |

- 模块通过可选字段声明依赖：`requires?: CapabilityRequirement`（扩展/模块声明，缺省不等待）。
- `waiting-deps` 时必须可查询：`{ missing: string[], since: number }`，写入 session 摘要供设置页/日志显示。
- `degraded` 不终止模块：模块保留在册并继续可查询；写入 session 摘要 `{ capabilityId, reason }`。

### 宿主接入点

`ExtensionHost`（`core.ts`）保留现有方法签名，内部改走注册表：

| 方法 | 变化 |
| --- | --- |
| `announceCapability(key, metadata?)` | 委托注册表 `announce`（记录 `providerModuleId`、runtime、`instanceId` 取宿主默认） |
| `markCapabilityReady(key, metadata?)` | 委托 `ready`；触发等待者解析 |
| `markCapabilityDegraded(key, metadata?)` | 委托 `degrade`；已绑定该能力的模块转 `degraded` |
| `withdrawCapability(key, metadata?)` | 委托 `withdraw`；同上并触发 `degraded` |
| `isCapabilityReady(key)` | 读快照（保持布尔语义） |
| `waitForCapability(key, timeoutMs?)` | 内部改走 `waitForRequirement({ allOf: [key], timeoutMs })`，签名与成功返回不变 |

新增只读方法（加法）：

```text
getCapabilitySnapshot(): CapabilitySnapshot
resolveCapabilityRequirement(requirement: CapabilityRequirement): CapabilityResolution
waitForCapabilityRequirement(requirement: CapabilityRequirement): Promise<CapabilityResolution & { since: number }>
subscribeCapabilities(listener: (change: CapabilityChange) => void): () => void
```

### 消费者接入（观察者模式边界）

- **消费者 1（MC-0c game-host，main 进程）**：连接建立并身份缓存后，`announceCapability('game.minecraft.control', { version, metadata })` → 物理执行器可用后 `markCapabilityReady`；断开时 `withdrawCapability`。
- **消费者 2（EP-1 技能适配器，renderer）**：适配器注册成功并存在至少一个 wrapped 技能时声明 `skill.adapter.self-authored`（`announceCapability` → `markCapabilityReady`），撤销全部包装后 `withdrawCapability`。渲染端经现有 `electronPluginUpdateCapability` 通道提交（载荷不动）。
- **观察者判定**：注册表维护"已声明能力的消费者集合"。两个消费者都出现前，宿主不因 `waiting-deps` 改变任何现有调度行为（现有启动顺序照旧）；两者齐全后，`waiting-deps` 解析成为模块 `ready` 的前置。
- 消费者集合与 `observerMode` 暴露在 `getCapabilitySnapshot()` 之外的宿主查询里（`getCapabilityConsumerState(): { observed: string[], observerMode: boolean }`）。

### 事件（如广播）

- 向渲染端广播时使用 `fork:capability:changed`，载荷 `{ revision, kind, record }`；不新增无前缀事件名。
- 现有 `electronPluginUpdateCapability` 仍是消费者写入口，不改名、不改载荷。

## 工作项与通过条件

| # | 交付 | 依赖 | 通过条件 |
| --- | --- | --- | --- |
| 1 | `CapabilityRecord`/`Requirement`/注册表（快照 + 解析 + 订阅） | 无 | 单测：announced/ready/degraded/withdrawn 重放；快照复制不可变；非法转移抛错 |
| 2 | 相位扩展 `waiting-deps`/`degraded` + 转移规则 | 1 | 单测：`setting-up → waiting-deps → ready` 确定性；`ready → degraded → ready`；`missing/since` 可见 |
| 3 | 晚到等待者 | 1 | 先 ready 后等待 → 立即解析，不挂起 |
| 4 | 超时显式暴露 | 1 | 超时返回 `{ ok:false, missing }`；模块停留 `waiting-deps`；无静默放行 |
| 5 | 宿主接入（现有五个方法委托 + 查询方法） | 1,2 | 既有 capability 测试（core.test.ts 相关断言）不改写通过 |
| 6 | 两个消费者接入 + 观察者模式 | 5；MC-0c/EP-1 | 两消费者声明且互相可见；`observerMode` 在两消费者齐全前为 true |
| 7 | 事件广播（如有） | 5 | `fork:capability:changed` 增量与快照 revision 一致；无遗漏、无重复 |

## 设计不变量

1. **快照权威**：任何消费者只凭快照即可得到完整就绪状态；事件丢失不改变结论。
2. **确定性恢复**：依赖满足后模块以同一路径恢复，重复信号不产生重复副作用。
3. **晚到不挂起**：就绪先于等待时，等待立即完成。
4. **降级可见**：绑定能力降级/撤回时模块转 `degraded` 且原因可查；不静默继续 `ready`。
5. **超时不放行**：超时是显式未满足，模块不进入 `ready`。
6. **观察者边界**：两消费者齐全前，注册表不改现有调度；齐全后才成为 `ready` 前置。
7. **加法纪律**：现有方法签名/返回语义不变；新增事件名带 `fork:` 前缀；偏离上游 baseline 记 COMPAT。

## 验收场景

| 场景 | 期望与证据 |
| --- | --- |
| 能力缺席与恢复 | 消费者声明缺失能力 → `waiting-deps`；ready 后确定性恢复（不变量 2） |
| 晚到等待者 | 能力先 ready、模块后等待：立即解析（不变量 3） |
| 能力撤销 | ready → degraded（原因可见）→ 恢复或停止（不变量 4） |
| 超时 | 未满足且超时：显式 `missing`，停留 `waiting-deps`（不变量 5） |
| 两消费者可见 | game-host 与技能适配器各声明能力，双方快照可见对方；`observerMode:false`（不变量 6） |
| 既有回归 | 现有 capability 相关单测不改写通过（不变量 7） |

结果记录沿用 fork 惯例：PASS/FAIL/BLOCKED/NOT-RUN 加证明范围。

## 明确不做

- 14 相位全量（`authenticating`/`configuration-needed` 等无消费者相位）。
- 优先级/配额/公平性策略引擎。
- 跨 runtime 传输联邦（`web`/`pocket` 接入）。
- `ui.panel`/widget 作者 kit（无消费者）。
- 用注册表驱动现有模块启动顺序（观察者边界，C1-D3）。

## 实施记录（2026-09-11）

- `packages/plugin-sdk/src/plugin-host/capability-registry.ts`：`CapabilityRecord`/`CapabilityRequirement` 照上游 baseline；`CapabilityRegistry` 的 announce/ready/degrade/withdraw、修订号单调快照、`resolve()`（allOf/anyOf/predicate 立即求值）、`subscribe()`（仅真实变化、退订幂等）、记录键与非法转移类型化错误；修复一处输入元数据引用泄漏（现存储克隆）。
- `core.ts`：相位加 `waiting-deps`/`degraded`，`requires` 可选，`setting-up → waiting-deps → ready` 与 `ready → degraded → ready`；旧五个 capability 方法委托注册表；新增 `getCapabilitySnapshot`/`resolveCapabilityRequirement`/`waitForCapabilityRequirement`（超时 `{ satisfied:false, missing, since }`）/`subscribeCapabilities`/`getCapabilityConsumerState`；观察者模式以 `game-host` 与 `skill-adapter` 两个消费者 id 判定。
- 解释：恢复从 `waiting-deps` 直接到 `ready`（上游 `waiting-deps → prepared`），不重跑 setup——重跑会重复注册模块并违反"无重复副作用"。`DependencyService` 因切换注册表而暂成孤立导出，保持不动以免改动导出面。
- 验证：plugin-sdk typecheck 0；`capability-registry.test.ts` 9 例 + `core.test.ts` 新 capability 块全绿（49 passed，1 例为既有 Windows 路径分隔符失败）；改动文件 eslint 0。
- 未接线：真实消费者（game-host 由 MC-0c 接线、技能适配器由 EP-1 接线）留给各自批次。

## 接管边界真机验证（2026-09-12）

应用内真机（重建重启，双消费者齐全）证明不变量 6：

- 修复前：两个消费者都只传 `metadata.source`，而注册表的作用域解析读的是 `metadata.providerModuleId`，缺省落到 `plugin-host`——观察者集合永远收不到 `game-host`/`skill-adapter`，`observerMode` 永真。修复：`main/index.ts` 的 game-host capability 端口与 `renderer/stores/skill-adapter-capability.ts` 的三处声明都补 `providerModuleId`。
- 可观测性：inspect 快照新增 `consumerState: { observed, observerMode }`（`shared/eventa/plugin/host.ts` + `host/debug.ts`），devtools 技能适配器探针新增 `capabilityConsumerState()`。
- 边界类型：`electronPluginUpdateCapability` 的 main 处理器新增 `CapabilityRecord → PluginCapabilityState` 显式映射（注册表返回的记录含 capabilityId/providerModuleId/revision，契约是 key/state/metadata/updatedAt）；plugin-sdk dist 重建后此不一致才暴露。相关 app 测试的 `announced → degraded` 用例改为规范合法序列（`announced → ready → degraded → withdrawn`）。
- 真机结果：启动后 `observed: ['game-host','plugin-host']`、`observerMode: true`；`wrap('acc-20260909-dedupe')` 后 `observed: ['game-host','plugin-host','skill-adapter']`、**`observerMode: false`**，`skill.adapter.self-authored: ready`、包装工具在工具面；`unwrap` 后能力 `withdrawn`（观察集合按设计保留，模式保持 false）。
- 验证命令：`pnpm -F @proj-airi/plugin-sdk build`（dist 同步）、stage-tamagotchi typecheck/eslint 0；`plugins/index.test.ts` 27 例中 2 例为既有 Windows symlink EPERM 基线。

## 与执行计划的关系

- [capability-platform-plan.md](./capability-platform-plan.md)：CP-1 的批次与通过条件在本规范细化；"注册表先以观察者运行"即 C1-D3。
- [cp-0-spec.md](./cp-0-spec.md)：加法纪律、COMPAT 台账与 `fork:` 命名约定由其钉死。
- [ep-0-spec.md](./ep-0-spec.md)：EP-1 技能适配器是其消费者，其能力声明由本规范消费者 2 定义。
- [mc-0c-spec.md](./mc-0c-spec.md)：game-host 是其第一个消费者。

## 本轮交付与检查

本轮只新增本规范文档并更新 MODS.md 索引。未改动产品代码、未接线任何消费者。`CapabilityRecord`/`CapabilityRequirement` 形状取自上游 `capability-orchestration.md`；若实施时发现上游字段与现有类型冲突，以最小偏离调整并记 COMPAT 与本文件修正节。
