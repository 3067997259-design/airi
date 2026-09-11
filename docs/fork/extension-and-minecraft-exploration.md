# 自开发能力、插件与 Minecraft 接入勘探

日期：2026-09-09。状态：勘探完成，实施未开始。

后续研究：[Minecraft Fabric 实现方向与分批验证](./minecraft-fabric-implementation-direction.md) 对照开源项目，细化 MC-0/MC-1、执行契约和组件候选。该文件仍是待选型方案。

本轮核对本地源码、SDK 内设计文档和 Fabric 官方资料。用户已接受任务 UI 的方向；本文件把它记录为下一实施批。没有安装插件、编写 Fabric 模组、改变主实例或运行真实模型。此前验收仍独立进行。

## 结论

现有 fork 与桌面插件系统具备较好的工具声明兼容性，但尚不具备完整的执行信任、任务归属和恢复兼容性。适合先做一个由我们维护的插件适配器，再逐步让 AIRI 生成插件包。无需先完成上游的市场、跨平台分发或通用远端插件宿主。

自开发技能负责“怎样完成一个动作”；插件负责“将哪些能力、界面、资源和生命周期接入 AIRI”。两者可以组合，不必相互替代。记忆事实、任务所有权和完成门继续由核心模块持有；插件通过有作用域的 API 使用它们，不直接修改 Pinia 或数据库。

## 已确认的兼容点和缺口

| 范围 | 已有依据 | 下一步边界 |
| --- | --- | --- |
| 工具定义 | [skill-forge/types.ts](../../packages/skill-forge/src/types.ts) 明确说明形状对应插件 SDK 的工具、激活和提示声明 | 在接线层映射，不让纯领域包依赖 Electron SDK |
| 模型工具入口 | 自开发技能与 [插件工具 store](../../apps/stage-tamagotchi/src/renderer/stores/tools/plugins.ts) 都接入 LLM tools/toolset prompts | 同一能力只能有一个注册所有者；避免两套同名工具并存 |
| 插件生命周期 | [ExtensionHost](../../packages/plugin-sdk/src/plugin-host/core.ts) 和桌面宿主已有 start/stop、注册清理、自动重载 | 技能撤销必须同时撤下工具、提示和关联 UI；处理在途调用 |
| 界面 | 桌面 SDK 提供 tool、widget、gamelet | 可以给自开发能力增加设置、状态和结果界面，不必改核心聊天组件 |
| 授权 | 宿主已有 requested/granted 权限结构 | 不能把 manifest 自报权限当作我们的人工审阅凭据 |
| 执行 | 技能通过 coding-host 沙箱运行核对过的源码；本地插件由文件加载器 import | 两条执行路径信任等级不同；首批适配器保留技能执行边界 |
| 证据 | fork 已有 journal、任务 ID、来源和完成门 | 插件结果必须保留实际所有者和来源，不能因注册到工具表就自动变成 builtin |
| 持久化 | 业务备份包含技能注册表与产物 | 任意插件包、插件启用状态和私有数据没有完整纳入当前备份契约 |
| 跨运行环境 | SDK 设计覆盖 Electron、Web、Pocket 和远端服务 | 当前通用 runtime 工厂仍有未实现分支；先限定本机 Electron |

### 三个不能跳过的接线边界

1. 桌面宿主当前创建 `new ExtensionHost({ runtime: 'electron' })`，没有提供自定义 `permissionResolver`。核心宿主在 resolver 缺省时采用 manifest permissions。它适合现有受信任本地扩展的使用方式，不足以直接承接自动生成插件的批准策略。
2. `chat.ts/getToolEvidenceAuthor()` 对 MCP 和自开发技能作了区分，其他工具默认归为 `builtin`。自开发插件接入前，需要按注册记录携带来源，而非仅按工具名字判断。否则改变包装方式会提高同一段代码的证据信任等级。
3. `FileSystemLoader.loadExtensionFor()` 在宿主加载入口模块。JS 顶层代码可以在 `setup()` 之前执行；限制 kit 权限不等于隔离 Node 代码。自动生成的任意入口不能直接沿用这个路径并被当成沙箱技能。

这些是结合两套机制时的产品契约缺口，本轮不把它们算作已验证的攻击或上游故障。

## AIRI 如何给自己开发插件

### 第一阶段：用固定插件适配器承载自开发工具

适配器由我们维护。AIRI 继续生成现有技能源码、自测、参数声明和提示；审核通过后，由适配器将能力暴露给插件工具面。执行仍回到现有 leader-owned 技能 action 和 coding-host 沙箱，不导入任意生成代码到主进程。

这样可以先共用插件的展示和生命周期，而保留现有技能审批语义。需要决定使用哪一条工具注册路径；迁移时撤下旧注册，再登记新注册，禁止双重工具名。

首个闭环可以是一项已有的纯数据处理技能：生成 → 自测 → 查看源码并批准 → 插件入口调用 → 查看执行日志 → 撤销 → 确认工具消失且不能继续执行。

### 第二阶段：生成包含工具和界面的插件包

插件可以包含多个工具、说明、设置界面与状态组件。AIRI 负责生成草稿和测试，固定宿主负责隔离试装、验证及激活。

审核对象从单个 source/selftest 扩展为整个可执行包：manifest、源码、构建输出、依赖锁定信息、静态资源和声明的权限。批准必须指向确定的包版本与摘要，不能只核对入口文件。更新采用新版本试装后切换，保留可回退的已知版本；不要将开发用 auto-reload 当作自动发布机制。

首批不提供任意 Node 入口。先支持固定模板的工具插件和受限制的界面贡献。需要任意宿主代码时再补进程隔离、取消和资源释放契约。

### 第三阶段：面向外部环境的能力包

游戏、编辑器和家庭设备适合作为插件/桥接能力。AIRI 可为这些环境编写高级行为脚本，例如“整理箱子”“补充食物”“总结本次建造”。底层动作和环境连接由固定适配器提供。

同一个插件可暴露 `inspect`、`act`、`cancel` 等动作能力，同时提供状态界面。记忆记录必须引用真实事件、任务和世界身份；目标调度器仍决定何时工作。插件不能另建一个不受现有预算、暂停和完成门控制的无限模型循环。

## Fabric 迁移：依据与推测

### 已知事实

- [Minecraft README](../../integrations/minecraft/README.md) 明确说 Mineflayer runtime 预计被 Fabric mod runtime 取代。
- 现有 [AiriBridge](../../integrations/minecraft/src/airi/airi-bridge.ts) 已通过 `spark:command`、`context:update` 和模块公告与 AIRI 通信。游戏认知层并非直接嵌在桌面聊天组件里。
- [插件平台设计](../../packages/plugin-sdk/docs/design/architecture.md) 将 Minecraft service 列为 bridge 的例子。它设想桥接提供环境数据和动作，界面由 viewer 呈现。
- 本次未在已跟踪源码中找到 Minecraft 的 `fabric.mod.json` 或对应 Fabric Gradle 工程。不能据此排除作者在其他仓库或分支已有实现。

### 最可能的迁移形态

推测：保留 AIRI 与游戏侧的消息边界，将 Mineflayer 感知/动作适配层替换为游戏内的 Fabric mod。认知规划可以继续留在外部进程；并没有依据认为所有 LLM 逻辑都要改写成 Java。

```mermaid
flowchart LR
  A[AIRI 人格、记忆与长期目标] <--> B[游戏插件：工具、上下文和状态界面]
  B <--> C[本机桥接：会话身份、命令与回执]
  C <--> D[Fabric 模组：感知、动作执行与取消]
  D <--> E[Minecraft 游戏世界]
```

这是建议的 fork 形态，也符合现有方向；不是作者已公布的完整架构。

如果采用该方案，需要有一个 Fabric 模组，可自行编写或在找到符合契约的现成模组后适配。Fabric Loader 本身不会理解 AIRI 的命令，也不会自动提供完整的代理控制接口。

### 客户端还是服务端

| 方式 | 能做什么 | 对我们意味着什么 |
| --- | --- | --- |
| 客户端模组 | 从玩家视角读取世界、界面和物品栏，控制对应客户端动作 | 若希望 AIRI 作为伙伴角色一起玩，优先探索此路；通常需要独立客户端与对应身份 |
| 服务端模组 | 处理服务端世界状态、自定义实体和服务端规则 | 需要控制服务器；不会自动产生一个完整的玩家客户端体验 |
| 两端配合 | 客户端交互与服务端定制能力组合 | 能力更广，部署范围也更大，不作为首批前置 |

Fabric 官方说明客户端和服务端可以分别装载模组；世界状态仍遵守游戏的逻辑侧与网络规则。[Fabric 侧的概念](https://wiki.fabricmc.net/tutorial:side)、[Fabric 网络文档](https://docs.fabricmc.net/develop/networking)。

客户端方案是否支持某个模组、菜单或服务器，需要逐项验证。迁移到 Fabric 不等于天然兼容所有 mod，也不等于拥有服务端权限。

### 游戏中的快速控制应留在哪里

移动、转向、动作取消、断线停止和危险事件响应应在游戏侧低延迟执行。模型给出有界动作或短计划，不能逐 tick 等模型。是否采用现成寻路组件、具体 Java 库和 Minecraft 版本，本轮不作技术选型。

首个演示只需：连接一个本地测试世界 → 报告位置和物品栏 → 执行一次短移动 → 主动取消 → 回传最终状态。每个请求带运行实例、世界、玩家、命令和任务身份；重连时旧命令不能在新世界自动重放。

## 已确认的 UI 方向

> 本节已独立成篇：[UI-SURFACE-PLAN](./UI-SURFACE-PLAN.md)（2026-09-11）。那份文档把这里的职责划分扩展为
> 可检验的表面与反馈契约，并补上实际验收中观察到的 UI 缺陷（侧通道吃输入、静默空操作、控制岛展开失效等）。
> 后续 UI 工作以那份文档为准，本节保留为历史记录。

适用文件：[InteractiveArea.vue](../../apps/stage-tamagotchi/src/renderer/components/InteractiveArea.vue)、[history.vue](../../packages/stage-ui/src/components/scenarios/chat/components/history.vue)、[plan-lanes.vue](../../packages/stage-ui/src/components/scenarios/chat/components/plan-lanes.vue)。

显示职责：

- 聊天正文只展示当前会话的活动任务与计划。已结束任务保留少量折叠结果，不固定占据输入框上方。
- 任务入口默认收起，展开后区分活动、待处理、历史；可进入来源会话。
- 其他会话的长期目标保留全局可见入口，不把所有卡片注入当前聊天时间线。
- 没有 sessionId 的历史计划和 attention task 进入未归属区域；不伪造来源会话。
- 完成、取消只改变显示位置，不删除记录。失败、阻塞、未验证结果继续可查；`completed` 但仍有未验证证据的计划不能被当作成功归档。
- 展开状态与筛选属于窗口局部 UI；不改变 Pinia 同步和调度所有权。

组件边界：InteractiveArea 按当前窗口选择会话；ChatHistory 负责会话时间线；一个任务面板负责跨会话浏览和归档筛选，复用现有卡片和来源导航。不要让各处各自维护另一份任务状态。

本轮用临时隔离浏览器回归确认：向同步快照放入 session A 的运行任务，在 session B 中仍可看到它。`not.toBeVisible()` 因实际可见而失败，与截图吻合；同时出现 ResizeObserver 警告。临时测试已撤下，避免在仅勘探批留下红色测试。本轮没有修复或重启 UI。

实施时还需验证数据来源：现有 leader 发布的是 journal 当前投影。只按 sessionId 过滤可以消除串台，但要保证切到另一会话后能取得那个会话的任务投影，而非过滤成永久空列表。应在两个真实隔离 renderer 中验证切换、刷新和恢复后的可见性。

## 后续批次及原计划关系

以下为规划，不表示已经实现。

| 批次 | 工作 | 原计划 | 通过条件 |
| --- | --- | --- | --- |
| UI-1 | 会话显示隔离、任务入口、历史归档视图 | [TASK-RUN-AND-UI-PLAN](./TASK-RUN-AND-UI-PLAN.md) | 两窗口不串台；切换可找回来源任务；旧证据不丢失 |
| EP-0 | 工具标识、来源、权限和在途撤销契约 | [SG](./skill-growth-plan.md)、[DR-1](./daily-reliability-plan.md) | 换成插件包装不提升证据信任，也不增加隐式权限 |
| EP-1 | 一个固定适配器承载一个已审阅技能 | SG-1 | 从生成到批准、调用、撤销形成真实闭环；无重复注册 |
| EP-2 | 受限插件包的隔离试装、激活和回退 | SG、[MD-2](./maintainability-and-data-plan.md) | 批准绑定整包；变更需再审核；恢复后默认不自动启动外部副作用 |
| MC-0 | 本地 Fabric 感知与有界动作验证 | EP-1、[LG](./long-horizon-goals-plan.md) | 一次观察、移动、取消和回执可关联；断线不遗留动作 |
| MC-1 | 将游戏能力接入目标、经历记忆和技能增长 | [MQ](./memory-quality-plan.md)、[PC](./persona-continuity-plan.md) | 任务完成有游戏回执；记忆绑定真实活动与世界；跨世界不误召回为当前事实 |

对个人 fork，可以固定操作系统、Minecraft 版本、本地服务器和包模板；无需市场、自动更新平台或多租户体系。应保持少数稳定接口，避免依赖未完成的通用 transport 工厂。先证明一项能力闭环，再扩展插件生成自由度。

## 本轮检查

本轮产品代码无最终改动。按根脚本同范围串行检查 56 个工作区项目，类型检查退出码 0；`corepack pnpm lint` 退出码 0，保留既有警告。文档相对链接与 MODS 差异检查通过。架构推测未作为已完成实现或产品验收 PASS 登记。
