# AIRI Minecraft 接入执行计划

日期：2026-09-09。状态：计划定稿，实施未开始。

本文件把 [Fabric 实现方向](./minecraft-fabric-implementation-direction.md) 和 [勘探记录](./extension-and-minecraft-exploration.md) 落成可执行批次。方向文档负责"为什么这样设计"；本文件负责"具体做什么、契约长什么样、怎样算通过"。四项方向性决策已由用户确认，记录于下。批次代号沿用 MC-0a…MC-1c，新增 MC-0d（生存反射）。

## 决策记录

| # | 决策 | 内容 | 理由与边界 |
| --- | --- | --- | --- |
| D1 | 桥接基础 | 适配 MCPFabric：fork 固定 commit，契约补丁以最小 Java 改动实现 | 客户端工具组（get_self/get_inventory/navigate_to/navigation_status/stop_navigation/send_chat）与首个领域工具面几乎一一对应，MIT 许可，mod 内嵌 HTTP 桥已有 127.0.0.1 绑定与 bearer token。若 Java 补丁面积失控（超出下文 P1–P4 清单的量级），按方向文档退路转最小自写桥，上层领域契约不变 |
| D2 | 玩家形态 | 独立 Fabric 客户端 + 离线身份；**两种环境都要能玩**：(A) 本地 offline 专用服（验收夹具），(B) LAN 联机/自建服关正版验证（陪玩环境） | 不购第二正版账号。online-mode=true 的公网服不在首批范围。两种环境共用同一客户端与身份；验收夹具只在环境 A 执行，环境 B 做主线冒烟 |
| D3 | 生存反射 | **首批完整反射**：escape-hazard、auto-eat、defend 全部进 Fabric 执行器（MC-0d） | 用户确认：陪玩角色从第一批起就要能在野外活下来。新增 Java 反射模块 P3，验收夹具逐项覆盖。若 MC-0d 超期需降级，顺序为 escape-hazard（保命）→ auto-eat → defend（先简化为脱离战斗），降级需用户确认 |
| D4 | 版本策略 | 从 1.21.1 起步；所有 MC 版本相关改动限制在 mod 层（我们的 MCPFabric fork），TS 适配器版本无关 | 利用 MCPFabric 的 Stonecutter 多版本构建，让补丁可移植到其支持的其他版本（1.21.1–1.21.11、26.x）。TS 侧通过 `get_status` 发现版本，契约带版本字段；MC-0a 追加一次 1.21.11 只读移植冒烟 |

## 架构与所有权

架构图与所有权表沿用方向文档，不重复。本计划新增两点：

- **工具唯一所有者是 game-host 适配器**（Electron main 新服务）。适配器自己持有到 MCPFabric MCP server 的连接，不经渲染层 [MCP store](../../apps/stage-tamagotchi/src/renderer/stores/tools/mcp.ts) 注册游戏工具。理由：MCPFabric 暴露 50+ 工具，含 teleport/give/run_command 等 operator 级管理工具，必须白名单映射，不能整组进入模型工具面；同时避免 [插件 store](../../apps/stage-tamagotchi/src/renderer/stores/tools/plugins.ts) 与 MCP store 两条注册路径产生双所有者。
- **反射是执行器的内建行为，不是模型循环**。反射在游戏侧逐 tick 判定并立即执行，只上报事件；是否恢复被打断的任务由 AIRI 核心决定。反射不得发起模型调用。

## 执行契约（定稿）

方向文档的契约条款全部保留，以下为字段级定稿。适配器与执行器两侧各自实现，测试共用同一组夹具脚本。

### 命令信封

```ts
interface GameCommand {
  // 宿主绑定：由 game-host 适配器注入，模型不可指定
  sessionId: string
  taskId: string | null
  runId: string
  planVersion: number | null
  // 游戏绑定：适配器在连接建立时取得并缓存
  worldId: string // 世界标识；无法取得稳定身份时为 'connection-scoped'
  dimension: string
  playerUuid: string
  connectionGeneration: number // 每次（重）连接递增
  // 命令本体
  commandId: string // 适配器生成，UUID
  action: 'move_to' | 'collect' | 'say' | 'observe' // 领域工具全集见下文工具面
  paramsDigest: string // 规范化参数的摘要
  deadlineMs: number // 租约时长
  issuedAt: number
}
```

去重规则：相同 `commandId + connectionGeneration` 的重复请求返回已有状态，不再执行；相同 `commandId` 不同 `paramsDigest` 必须拒绝。切换世界或重连后 `connectionGeneration` 递增，旧命令自动失效，新世界角色不动。

### 状态机

`accepted → running → succeeded | failed | cancelled | expired`，外加过渡态 `cancel_requested`（仅表示取消请求已送达）。丢失终态回执时核心记为待核对（unverified），不得推断成功或停止。

终态回执字段：`commandId`、`finalSnapshot`（位置/血量/饥饿/持有物）、`endReason`、`postCondition`（类型 + 实测结果）。移动核对最终距离；采集区分"本次新采集数量"（采集事件 + 前后数量差）与"最终持有数量"，别人丢给她的物品不算采集。

### 优先级

用户停止 > 生存反射 > 任务命令。取消不等待模型返回，不排在长动作后面。每个玩家同一时间只有一个写动作所有者；`status`/`observe` 只读命令可并发。

### MCPFabric 能力映射

| 领域工具 | MCPFabric 底层 | 需要的补丁 |
| --- | --- | --- |
| observe | get_status, get_self, get_inventory, get_blocks_region | 无 |
| move_to | navigate_to + navigation_status | P2（租约、终态位置、路径耗尽≠到达） |
| status | 适配器本地状态表 + navigation_status | 无 |
| cancel | stop_navigation + stop_movement | P1（停止确认） |
| say | send_chat | 无（注意自身消息回流过滤） |
| collect | break_block + 等待拾取 + get_inventory | P4 采集事件；MC-1a 实施 |

## 生存反射契约（MC-0d）

三条反射均为客户端 mod 内、逐 tick 判定的确定性逻辑，置于 `enableReflex` 配置组之下（默认开），各自可独立关闭用于对照测试。

| 反射 | 触发 | 立即行为 | 上报事件 |
| --- | --- | --- | --- |
| escape-hazard | 处于/濒临岩浆、火焰、溺水、窒息（方块内） | 覆盖当前移动意图，沿脱离向量移动至安全位置；清除导航与挖掘 | `game:reflex` cause=hazard, 位置前后 |
| auto-eat | 饥饿值低于阈值（默认 14，可配） | 从背包选择最优食物（不消耗未来任务声明的物资清单，首批简化为任意安全食物）→ 装备并食用完成 | `game:reflex` cause=hunger, 食用前后饥饿值 |
| defend | 被实体攻击 | 血量高于阈值→近身反击；低于阈值→脱离战斗并保持距离；不影响其他玩家（PvP 关闭） | `game:reflex` cause=attacked, 攻击者与血量 |

共同规则：

- 反射打断任务命令时，该命令转为 `failed`，endReason=`reflex_preempted`，回执附反射事件。恢复由核心重新规划，反射不自动重放旧命令。
- 反射执行期间租约照常计时；反射本身不受 deadline 限制但必须收敛（脱离无路可走时停止并上报 `failed`）。
- 反射事件经 SSE 事件流上报，适配器转入 journal；无变化不重复上报（同一 cause 在 N 秒内合并）。

## MCPFabric fork 补丁清单与版本策略

我们的 fork 固定 MCPFabric 某 commit（MC-0a 选定后登记 commit 哈希、构建摘要、许可）。补丁全部在客户端侧，编号：

- **P1 断线与退出清理**：桥接心跳丢失、退出世界、玩家死亡、断开连接时，清除控制意图、停止导航与挖掘、使所有租约失效。停止确认以两个游戏 tick 内清除控制意图为验收线。
- **P2 导航租约与终态**：每次导航带截止时间；`navigation_status` 返回最终位置与结束原因；路径节点耗尽时必须按实际距离判定，不得直接进入 `reached`。
- **P3 反射模块**（MC-0d）：见上节，独立 client-only 模块。
- **P4 事件流补充**：反射事件；核对现有 `poll_events`（damage/deaths/chat）是否满足采集事件与回执快照需求，缺则补。

版本可移植规则：补丁源码放在 Stonecutter 共享源集，版本特定代码隔离到独立适配类；MC-0a 完成后在 1.21.11 做一次构建 + 只读 observe + 单次移动的移植冒烟（不做全量验收）。TS 适配器不出现任何版本分支。

## 旧入口退役（MC-0a 内完成）

- 停止注册 [spark-command 工具](../../packages/stage-ui/src/tools/character/orchestrator/spark-command.ts)（[tool-resolver 接线](../../packages/stage-ui/src/stores/ai/chat-llm/tool-resolver.ts) 一并撤下），广播命令不再驱动任何游戏行为。
- `integrations/minecraft`（mineflayer 服务）不再随任何流程启动，README 标注 deprecated；代码与 [AiriBridge](../../integrations/minecraft/src/airi/airi-bridge.ts) 消息边界保留作参考，不删。
- 退役本身是一个验收项：确认桌面聊天里游戏命令只剩 game-host 领域工具一条路径。

## 代码落点（TS 侧）

| 位置 | 职责 |
| --- | --- |
| `apps/stage-tamagotchi/src/main/services/airi/game-host/`（新增） | 连接生命周期（拉起/附着 MCPFabric MCP server 子进程，stdio）、命令注册表与租约看门狗、命令信封注入、回执核对、领域工具面、journal 事件产出 |
| `apps/stage-tamagotchi/src/renderer/bridges/game-host.ts`（新增） | 渲染层桥：连接状态、活动任务、停止入口；只显示核心投影，不自建任务状态 |
| [chat.ts getToolEvidenceAuthor](../../packages/stage-ui/src/stores/chat.ts)（扩展） | 游戏工具归入新证据桶（如 `game_adapter`）：回执先核对来源、授权、连接代次、命令身份，再读新鲜状态核对目标条件；MCP 原始报告与技能自述文字不作为变更证明 |
| [executeSkill](../../packages/stage-ui/src/stores/skills.ts) / [createCodeModeRuntime](../../packages/coding-harness/src/ptc/code-mode.ts)（复用） | 组合技能经固定执行器调用领域工具，子命令继承任务身份；不新建脚本引擎 |

stdio 子进程监管沿用近期 MCP stdio 会话生命周期的模式（提交 e3da04e36）。

## 环境与夹具

- **环境 A（验收夹具）**：本地 Fabric offline-mode 专用服，固定种子世界，模组列表固定（仅我们的 fork），测试用 op 命令（tp/give/effect）只在环境 A 开启。夹具脚本：岩浆坑、饥饿设定、僵尸生成、封闭目标点、指定标记点。
- **环境 B（陪玩）**：LAN 世界（宿主开局域网联机）或自建服关 online-mode。AIRI 用同一客户端与固定离线身份加入；主线场景（身份/观察/移动/取消）在 B 各跑一遍冒烟。玩家名取 persona 名，冲突时加固定后缀。
- 两环境共用的确定性协议脚本：不经 LLM，直接对适配器发命令、断言回执。先脚本后聊天，与方向文档一致。

## 批次、依赖与通过条件

| 批次 | 交付 | 依赖 | 通过条件 |
| --- | --- | --- | --- |
| MC-0a | MCPFabric commit 固定与 fork 构建；环境 A/B 就绪；只读 observe 链路；旧入口退役；1.21.11 移植冒烟；资源占用测量记录 | 无 | 双环境下身份、位置、背包读取正确且附世界绑定；旧 spark 入口确认失效；退出码与构建摘要登记 |
| MC-0b | 执行契约全套：命令身份、去重、租约、取消确认、断线停止、有界移动、终态回执与后置条件（补丁 P1、P2） | MC-0a | 确定性协议脚本全绿：取消两 tick 清控、桥进程被杀后租约失效自清理、回执丢失不重复执行、旧世界命令拒绝、不可达有界失败 |
| MC-0d | 完整生存反射（补丁 P3、P4） | MC-0b | 岩浆/饥饿/僵尸三个夹具逐项通过；反射打断命令的回执带 `reflex_preempted`；用户停止优先于反射 |
| MC-0c | 领域工具注册、证据桶与回执核对、journal 与完成门接线、真聊天下令、多窗口单次执行 | MC-0b；**EP-0**（工具标识、来源、在途撤销） | 真聊天可下令并得到回执核对；跨窗口只产生一次命令；`completed` 只在核对通过后成立 |
| MC-1a | collect/say 上线；跟随、少量采集、补给与聊天 | MC-0c、MC-0d | 采集数量用采集事件核对；新指令可打断跟随；反射与任务行为整合无死锁 |
| MC-1b | 世界作用域记忆、事件压缩、预算约束 | MC-1a | 旧坐标不当作当前事实；无变化不重复调用模型；预算耗尽时有界动作仍服从截止与取消 |
| MC-1c | 一个经审阅组合技能及修订流程 | MC-1a、EP-1 | 成功、缺条件、取消、撤销、内容变更五类情形可核对 |

MC-0a/b/d 不依赖 EP-0，可与 EP-0 并行；MC-0c 是自主行动门，必须等 EP-0 落地。MC-0d 与 MC-0c 可并行（前者游戏侧、后者接线侧）。

## 验收场景

方向文档的 12 个场景全部保留（身份与观察、正常移动、中途取消、桥接退出、回执丢失、旧世界命令、多窗口、不可到达、数量条件、预算耗尽、记忆隔离、技能撤销）。本计划新增：

| 场景 | 操作 | 期望与证据 |
| --- | --- | --- |
| 反射-逃脱 | 移动中把脚下换为岩浆 | 脱离向量即时覆盖；`game:reflex` cause=hazard 附位置前后；被打断命令 `reflex_preempted` |
| 反射-进食 | 测试服设定饥饿值为 10 | 自动选食物并食用完成；事件附饥饿值前后；不被静默吞掉任务恢复决策 |
| 反射-防御 | 生成僵尸并攻击她 | 反击或按血量脱离；事件附攻击者；用户"停下"优先于反射 |
| 双环境主线 | 环境 B（LAN）跑身份/观察/移动/取消 | 与环境 A 同样通过；世界绑定与连接代次正确 |
| 版本移植 | 同补丁在 1.21.11 构建并跑只读 observe + 单次移动 | 构建/运行通过即记 PASS，不推断全量兼容 |
| 旧入口退役 | 聊天中尝试游戏命令路径 | `builtIn_emitSparkCommand` 不在工具面；广播 spark:command 无游戏副作用 |

记录规则沿用方向文档：PASS/FAIL/BLOCKED/NOT-RUN 加证明范围；停止测试同时记录控制意图与实际位移；采集与导航用至少三个固定种子重复。

## 风险与回退

- **MCPFabric 上游很小**（约 21 commits）：固定 commit、自维护 fork，升级按需 cherry-pick。补丁若超出 P1–P4 量级，触发 D1 退路评估（转最小自写桥，领域契约不变）。
- **反射工作量**（D3 全量）：MC-0d 若超期按 escape-hazard → auto-eat → defend 顺序降级，降级需用户确认，验收记录保留已做部分。
- **第二客户端资源**：MC-0a 实测 CPU/内存/帧率并记录最低可用画质配置；若单机双客户端不可行，备选是 AIRI 客户端跑在另一台机器/窗口最小化渲染（记录后再决策）。
- **离线身份限制**：online-mode=true 公网服进不去，属 D2 边界而非缺陷；LAN 环境宿主需开联机或装自定义联机模组，操作步骤写进夹具文档。
- **物理惯性与判定**：停止与到达判定都以控制意图 + 实际位移双记录，防止把惯性滑行当作仍在按键（方向文档已列）。

## 与其他计划的关系

- [EP-0](./extension-and-minecraft-exploration.md)（工具标识、来源、权限、在途撤销）是 MC-0c 前置；MC-0a/b/d 可先行。
- MC-1c 复用 [SG](./skill-growth-plan.md) 的审阅与修订流程和 EP-1 的固定适配器边界。
- MC-1b 关联 [MQ](./memory-quality-plan.md) 与 [SP](./social-presence-plan.md)；持久化与恢复关联 [MD](./maintainability-and-data-plan.md)；长期目标关联 [LG](./long-horizon-goals-plan.md)。
- 方向文档的研究结论（六项目取舍、源码证据）继续作为本计划的依据层，不在此重复。

## 本轮交付与检查

本轮只新增本计划文档并更新 MODS.md 索引。未安装外部依赖、未编写 Java、未改动产品代码、未运行游戏。外部项目的事实性陈述以方向文档的源码阅读和本轮 MCPFabric README/仓库核查为准，实施前仍需在 MC-0a 固定 commit 后复核。
