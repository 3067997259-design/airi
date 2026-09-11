# AIRI 扩展与自开发能力执行计划

日期：2026-09-09。状态：计划定稿，实施未开始。批次代号 EP，沿用 [勘探文档](./extension-and-minecraft-exploration.md) 编号。

EP 线回答一个问题：**AIRI 的能力以什么身份进入工具面，证据信任跟随什么**。它是三条线的闸门与模板——EP-0 是 [MC-0c](./minecraft-execution-plan.md) 与 [CP-2](./capability-platform-plan.md) 的共同前置，EP-1 的固定适配器模式是 game-host 的模板，EP-2 是 CP-2 隔离能力的消费者。勘探文档的三阶段方向保留（固定适配器 → 受限插件包 → 外部环境能力包）；第三阶段（外部环境能力包）由 MC 与 CP 线承担，本线不重复。

## 决策记录

| # | 决策 | 内容 | 理由 |
| --- | --- | --- | --- |
| D1 | 证据信任跟随执行来源，不跟随包装 | 注册记录携带执行链；插件包装的已审阅技能，证据按执行链最深处（沙箱内已批准源码）判定，包装层只记 surface | 勘探文档接线边界 2 的原则：改变包装方式不得提升证据信任等级。判定依据从工具名前缀改为注册记录 |
| D2 | 单一所有者，迁移即换防 | 同名工具同一时间只允许一个注册；迁移 = 撤下旧注册、再登记新注册，两步之间无重叠窗口 | 勘探文档接线边界 1；避免两套同名工具并存与双调度 |
| D3 | EP-2 首批为声明式包 | manifest + 工具声明 + 参数 schema + gamelet UI 描述；执行体是已审阅技能源码、走 coding-host 沙箱；不含任意 Node 入口。worker 进程隔离试装等 CP-2 交付后再上 | 绕开 `FileSystemLoader.loadExtensionFor()` 直接 import 的信任问题（勘探边界 3）；隔离需求出现前不预付最贵的账 |
| D4 | 批准绑定内容哈希 | 单技能沿用 SG-1 原则（批准绑定用户实际查看的源码哈希）；EP-2 扩展为整包摘要（manifest + 源码 + 资源 + 依赖锁定） | 批准必须指向确定版本，不能核对"当前最新"或仅入口文件 |

## EP-0 契约（定稿）

### 注册记录

[tools store](../../apps/stage-tamagotchi/src/renderer/stores/tools/index.ts) 的注册处从名字集合升级为携带来源的记录表：

```ts
interface ToolRegistration {
  toolId: string
  ownerKind: 'builtin' | 'reviewed_skill' | 'plugin' | 'game_adapter' | 'mcp'
  ownerId: string // 技能 id、扩展 id、game-host 服务名或 MCP 服务器名
  execution: {
    kind: 'host' | 'coding_sandbox' | 'extension_host' | 'remote'
    chain?: string[] // 包装层到执行体的链，如 ['plugin:adapter-x', 'skill:skill-y']
  }
  approvedContentHash?: string // ownerKind 为 reviewed_skill/plugin 时必填
  registeredAt: number
}
```

[plugins store](../../apps/stage-tamagotchi/src/renderer/stores/tools/plugins.ts)、[MCP store](../../apps/stage-tamagotchi/src/renderer/stores/tools/mcp.ts) 与 built-in 注册各自在登记时提供 `ownerKind/ownerId/execution`；[chat.ts getToolEvidenceAuthor](../../packages/stage-ui/src/stores/chat.ts) 改为按注册记录判定，不再按前缀猜测。

### 证据作者映射

| 注册 | 证据作者 |
| --- | --- |
| `builtin` / execution `host` | `builtin` |
| `reviewed_skill`（execution `coding_sandbox` 且批准哈希有效） | `reviewed_self_authored` |
| `plugin` 包装调用已审阅技能（execution chain 指向有效批准） | 按执行链最深处判定为 `reviewed_self_authored`，journal 同时记录 surface=plugin |
| `plugin` 无有效执行链批准 | `untrusted_plugin`（新桶：指引可用，不作变更证明） |
| `mcp` | `remote_agent`（现状保留） |
| `game_adapter` | `game`（MC 计划定义的核对桶：先核对来源/授权/连接代次/命令身份，再读新鲜状态） |

映射是单向的：包装层数据不能向上游执行体注入信任，执行体批准失效时整链降级为 `untrusted_plugin`。

### 在途撤销语义

撤销一个注册 = 三件事按序生效：从 LLM tools 与 toolset prompts 撤下该工具；终止在途调用（沿 execution kind 传递取消：沙箱中止、扩展 host 停止、远端取消请求）；撤销时刻之后到达的回执一律标记 `revoked`，不进入任何完成门。撤销幂等，重复撤销无副作用。多窗口下撤销是 leader-owned action，全部窗口最终一致。

### 单一所有者执行

注册表拒绝重复 `toolId`；迁移走"撤下 → 登记"两步，中间态是工具暂时不可用而非双注册。重命名包装不改变证据判定输入（D1）。

## EP-1：固定适配器首闭环

适配器由我们维护：把一个**已审阅技能**暴露到插件工具面，注册为 `plugin`（execution chain 指向该技能），执行委托 [executeSkill](../../packages/stage-ui/src/stores/skills.ts) 与 coding-host 沙箱（[createCodeModeRuntime](../../packages/coding-harness/src/ptc/code-mode.ts) 边界），适配器自身不新增执行信任。

闭环（勘探文档定义，逐项验收）：生成 → 自测 → 查看源码并批准（绑定哈希）→ 插件入口调用 → 查看执行日志 → 撤销 → 确认工具消失且在途调用终止。

- 软前置：SG-1 审阅入口修复（源码查看 + 哈希绑定批准），见 [技能成长计划](./skill-growth-plan.md)。
- CP-1 接口：适配器向能力注册表声明能力，是 CP-1 观察者模式的第一个消费者。
- 工具声明形状沿用 [skill-forge types](../../packages/skill-forge/src/types.ts) 与插件 SDK 的对应关系，接线层映射，不让纯领域包依赖 Electron SDK。

## EP-2：受限插件包

**Phase A（声明式，不依赖 CP-2）**：包 = manifest + 工具声明 + 参数 schema + gamelet UI 描述 + 已审阅技能源码 + 依赖锁定信息 + 整包摘要。隔离试装 = 装入隔离目录、白名单挂载工具与 UI、执行全部走沙箱；激活 = 进入正常注册；回退 = 保留上一已知良好版本可切换。备份契约扩展（关联 [MD-2](./maintainability-and-data-plan.md)）：包内容、启用状态、插件私有数据纳入业务备份。

**Phase B（worker 试装，依赖 CP-2）**：试装进程跑在 node-worker，崩溃与超时被隔离；auto-reload 仅限开发态，不作为发布机制（勘探文档原则）。批准仍然绑定整包摘要，Phase B 只改变执行隔离等级。

## 批次、依赖与通过条件

| 批次 | 交付 | 依赖 | 通过条件 |
| --- | --- | --- | --- |
| EP-0 | 注册记录表、证据作者映射、在途撤销语义、单一所有者执行 | 无 | 下节验收场景全绿；现有 builtin/技能/MCP 工具迁移到记录表后行为与现状等价（回归基线） |
| EP-1 | 固定适配器 + 一个已审阅技能的全闭环 + CP-1 能力声明 | EP-0；SG-1（软前置） | 闭环七步逐项有据；无双重注册；撤销后 in-flight 终止且回执标记 revoked |
| EP-2a | 声明式包：打包、整包摘要批准、隔离试装、激活、回退、备份扩展 | EP-1 | 批准绑定整包摘要；内容变更即失效需再审核；回退后已知版本可用；恢复后默认不自动启动外部副作用 |
| EP-2b | worker 试装与隔离终止 | EP-2a；CP-2 | 试装崩溃/超时不波及宿主；撤销限时终止 |

## 验收场景

| 场景 | 批次 | 期望与证据 |
| --- | --- | --- |
| 包装不提升信任 | EP-0 | 同一技能经插件包装后证据作者不变；journal 记录 surface |
| 批准失效降级 | EP-0 | 执行链上的批准哈希失效（源码被替换）→ 整链降级 `untrusted_plugin`，已进入完成门的证据不被追溯篡改，但新调用被拒 |
| 双重注册被拒 | EP-0 | 同名工具第二次注册被类型化错误拒绝；迁移中间态无重叠 |
| 撤销语义 | EP-0/1 | 撤销后工具从工具面消失；在途调用终止；迟到回执标记 `revoked` 不入完成门 |
| 多窗口一致 | EP-0 | leader 撤销/迁移后全部窗口一致；重复撤销幂等 |
| 首闭环 | EP-1 | 生成→批准→调用→日志→撤销全程留痕；撤销后不能再执行 |
| 整包批准与替换 | EP-2a | 查看后被替换的包不激活；变更后旧批准失效 |
| 回退与恢复 | EP-2a | 回退到已知良好版本；重启恢复后默认不自动启动外部副作用 |

## 明确不做（本线边界）

- 任意 Node 入口插件（EP-2b 之前不存在该路径；之后也须满足 CP-2 隔离与撤销契约）。
- 市场、跨平台分发、远程插件宿主（CP 线边界同样排除）。
- 外部环境能力包（游戏、编辑器、家居）：由 MC 与 CP 线承担，本线只提供注册与证据地基。

## 与其他计划的关系

- MC 线：MC-0c 的游戏工具注册与 `game` 证据桶直接消费 EP-0 契约；game-host 是 `game_adapter` ownerKind 的定义来源。
- CP 线：EP-0 批准记录是 CP-2 deny-by-default resolver 的数据源；EP-1 是 CP-1 首消费者；EP-2b 是 CP-2 消费者。
- SG 线：SG-1 审阅入口是 EP-1 软前置；技能生成与自测流程完全沿用，不重复建设。
- MD 线：EP-2a 扩展备份契约（MD-2 关联项）。

## 本轮交付与检查

本轮只新增本计划文档并更新 MODS.md 索引。未改动产品代码。契约中 `untrusted_plugin` 证据桶与注册记录形状为首创定义，实施 EP-0 时若与现有 journal/authority 结构冲突，以最小偏离调整并记入本文件修订，不静默改语义。
