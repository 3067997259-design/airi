# AIRI 插件平台野心线执行计划

日期：2026-09-09。状态：计划定稿，实施未开始。批次代号 CP。

本计划承接 [插件与 Minecraft 勘探](./extension-and-minecraft-exploration.md) 与 [Fabric 实现方向](./minecraft-fabric-implementation-direction.md)，把上游作者（Neko / moeru-ai）在插件平台设计文档中声明、但从未实现的野心，落成 fork 的探索批次。与 [MC 执行计划](./minecraft-execution-plan.md) 平行：MC 线做游戏接入，本线做平台本身。

## 定位与正当性

上游插件平台的断层不是烂尾，而是"地基层完工、图纸超前"。作者对 GitHub 上 50K star / 5K fork 的社区负责，必须谨慎，帮助者很少，因此通用化路线进展缓慢——这是责任的代价，不是能力的边界。本 fork 只对自己负责，因此有探索的资本；fork 的第一意义本来就是探索。先例：长短期记忆系统正是在她留的底子上由本 fork 实现出来的。

本线的目标：**照她已发布的契约，把她图纸上的平台做出来一部分**——每一步都带真实消费者验收。若上游未来自行实现，遵循本文件的兼容纪律，两侧插件保持可兼容（分层判断见决策记录）。

## 决策记录

| # | 决策 | 内容 | 理由 |
| --- | --- | --- | --- |
| D1 | 以已发布契约为 spec | manifest v1、作者面 API（`defineExtension`/`ctx.kits.use`/toolKit/gameletKit/setup 生命周期）、plugin-protocol 事件名、`CapabilityRecord` 字段形状、kit 命名哲学（README）。实现在契约**之下**，不在契约旁边 | 作者面 API 才是兼容契约，内部不是——她自己的设计就是"宿主管传输，插件无感"。VS Code/VSCodium 先例：内部完全分叉，扩展照样互通 |
| D2 | 加法纪律与版本协商 | fork 扩展只进自己的命名空间（manifest 新可选字段、`fork:` 前缀事件名）；CP-0 就补上她在 multi-transport Next Steps #4 欠的协议版本协商 | 语义细节（错误形状、QoS、grant 存储）是漂移所在；版本字段是唯一可控的保险。作者自己做过整体改名（2026-06 #1892 plugin→extension），绝对兼容无人能保证，目标是把兼容成本锁在低位 |
| D3 | 消费者先行 | 每个平台组件必须带一个真实 fork 消费者落地，无消费者的批次不开工 | 上游断层的成因就是"平台先行于消费者"（旗舰 chess 至今是空 package.json）。反向操作，宁可缩批次 |
| D4 | 排序按探索价值 × 锚定度 | 能力注册表 → 权限策略 + node-worker 隔离 → websocket 远程插件统一两半球 → 控制面/数据面（搁置） | 与 fork 现有工作（MC、EP、life-mode、QQ 桥）的锚定度排序，不按她文档的顺序 |

## 断层地图与作者意图（依据）

时间线（git 证据）：2026-04-21/22 kits/binding API 与 manifest 重构 → 05-15 toolset prompts → 06-12 #1892 大改名 plugin→extension → 06-26 retriable tool call → 之后仅发布维护，最后一个实质提交 2026-08-18（#2314），fork 基线 v0.12.0-beta.2（e170d454e，2026-08-26）。最后几个月的实质工作全部在加固本地 Electron 链路，没有一行推进设计文档。

三份设计文档构成野心递进：[architecture](../../packages/plugin-sdk/docs/design/architecture.md)（多节点系统、控制/数据面、三种部署模式，状态 "Active design"）→ [multi-transport](../../packages/plugin-sdk/docs/design/multi-transport.md)（每插件 context、传输透明，状态 "Planned"）→ [capability-orchestration](../../packages/plugin-sdk/docs/design/capability-orchestration.md)（能力内核、14 相位生命周期，状态 "Proposed"）。

断层分组（证据为 fork 基线内的文件位置）：

| 分组 | 断层 | 关键证据 |
| --- | --- | --- |
| 传输与隔离 | runtime 工厂 6 分支 5 个 throw；`createPluginContext` 零调用者；channels 与 plugin/local、plugin/remote 裸壳；引用的 plugin-lifecycle.md 从未写出 | `packages/plugin-sdk/src/plugin-host/runtimes/node/index.ts:24-38`、`runtimes/web/index.ts:23-38` |
| 生命周期 | 14 相位只实现 4 个；`waiting-deps`/`degraded` 从未被触发；DependencyService 与 `waitForCapabilities` 已实现但无模块接入 | `core.ts:97` |
| 权限 | 桌面宿主不传 `permissionResolver` → manifest 自授；无同意 UI；`allowedExposePolicies` 无执行点 | `host/index.ts:236`、`core.ts:250-255` |
| 分发 | 无市场/安装/更新；旗舰消费者 chess 为空脚手架；备份契约不含插件状态 | `plugins/airi-plugin-game-chess/` |
| 跨平台 | stage-web/stage-pocket 零插件支持 | `shouldPublishPluginHostCapabilities` 只认 tamagotchi |
| UI 贡献 | widget 无作者侧 kit；唯一真实路径是 gamelet iframe | `plugin-sdk-tamagotchi/src/widgets/` |
| 两半球 | server-runtime 模块（minecraft-bot、bilibili、homeassistant 在用）与 plugin-sdk ExtensionHost 是两条平行机制，从未统一为设计中的"同一协议本地/远程插件" | `packages/server-sdk/` vs `packages/plugin-sdk/src/plugin-host/` |

意图重建（三份文档 + README 直接引用）：AIRI 是多节点系统而非单应用；控制/数据面分离服务跨设备编排；"AIRI plugin orchestration should behave like an extensible runtime kernel"——宿主是 runtime 适配器、stage 是普通能力模块、顺序从能力解析中涌现；传输对插件透明；桥（VS Code、浏览器、Minecraft service）只提供数据与动作不做 UI；共享的是 Eventa 契约而非实现函数。deny-by-default 是她明确列入 Next Steps #3 的未做项，不是遗忘。

## 兼容纪律（定稿）

1. **跟随已发布契约**（D1 清单）。偏离处必须记入 COMPAT 台账。
2. **只做加法**：fork 扩展事件名用 `fork:` 前缀；manifest 新字段一律可选且有缺省语义（缺省 = 上游行为）；不改动既有名字的语义。
3. **第一天版本协商**：见下节契约。
4. **COMPAT 台账**：`docs/fork/capability-platform-compat.md`（CP-0 建立），逐条记录"实现了她文档的哪一节、偏离在哪、为什么"，同时作为未来 upstream 回馈的材料。
5. **rebase 健康**：新增代码放新文件/新目录；对 `core.ts` 等上游热点文件只做最小插入，降低未来 rebase 冲突面。

若上游未来自行实现且形状不同：作者面 API 相同时插件仍互通；不同时按 COMPAT 台账评估 shim，shim 范围以上述分层为界（作者面 API > 事件名 > 宿主内部，宿主内部天然无需兼容）。

## 版本协商契约（CP-0 定稿）

模块握手（`module:announce` 系）与本地等价路径增加一个可选字段，两侧都缺席时行为与上游完全一致：

```ts
interface ForkProtocolDescriptor {
  version: number // fork 协议版本，从 1 起
  extensions: string[] // 已实现的上游 Next Steps 项标识，如 ['capability-registry', 'node-worker', 'remote-plugins']
}
```

规则：读取方取双方共同支持的最高版本；不认识的 `extensions` 条目忽略（前向兼容）；版本不兼容时返回类型化错误，绝不静默降级。上游实现者将来可直接采纳同一字段名——它是纯加法。

## 批次、依赖与通过条件

| 批次 | 交付 | 依赖 | 通过条件 |
| --- | --- | --- | --- |
| CP-0 | 契约纪律落地：spec 清单钉住（fork 基线 e170d454e 内的设计文档即 spec）、COMPAT 台账建立、`fork:` 命名空间约定、握手加法字段与缺省行为 | 无 | 字段缺席时行为与上游逐项一致（对照测试）；台账链接检查通过 |
| CP-1 | 能力注册表 + 相位扩展：`setting-up → waiting-deps → ready`，加 `degraded`；快照权威、事件增量；`CapabilityRecord` 按她文档字段形状 | CP-0；消费者来自 MC-0c（game-host）与 EP-1（技能适配器） | 注册表先以**观察者**运行：两个消费者声明能力且互相可见；能力缺席时模块进入 `waiting-deps`、就绪后确定性恢复；晚到的等待者立即从快照解析（防错过就绪）；两个消费者齐全前不接管任何调度 |
| CP-2 | 权限策略 + 隔离：接线 `permissionResolver`（deny-by-default，批准记录来自 EP-0 审阅流）；填 runtime 工厂 `node-worker` 分支，插件进 worker 运行 | CP-0；EP-0；消费者 EP-2 受限插件包 | manifest 自授不再可能；未批准权限的工具调用被拒且错误可解释；worker 崩溃不波及宿主；撤销/重载在限时内终止在途调用；`runtimes/node` 工厂该分支不再 throw |
| CP-3 | websocket 远程插件：统一两半球——ExtensionHost 获得 websocket 传输，远程模块以 `module:announce` 进入同一注册表，与本地插件同协议 | CP-1、CP-2；候选消费者：QQ 桥（首选）或 Minecraft Fabric 桥（MC-1 之后） | 远程模块向 CP-1 注册表声明能力；工具注册走同一单所有者路径（EP-0 规则）；能力层视角无法区分本地/远程——同一验收在两种实例上各跑一遍 |
| CP-4 | 控制面/数据面分离 | **搁置**：出现真实高频流消费者（视觉/音频流插件）再启动 | 仅记录启动条件，不预做设计 |

CP-0 无前置可立即开工；CP-1 的消费者由 MC/EP 线自然送达，两线互不阻塞；CP-2 是 EP-2 的前置；CP-3 在 QQ 桥具备桥接条件时启动。

## 明确不做（本线边界）

- web/pocket 宿主与跨平台分发（上游野心，fork 无消费者）。
- 市场/注册表/安装更新通道（个人 fork 的等价物是本地目录 + 哈希绑定批准，见 [MC 计划](./minecraft-execution-plan.md) 与 EP-2）。
- 14 相位全量 fidelity：只实现有消费者的相位（CP-1 的 6 个），其余留在她的文档里。
- `ui.panel`/独立 widget 作者 kit、UrlLoader、`plugin-lifecycle.md` 代写：出现消费者前不动；台账记录引用缺失即可。
- 数据面（CP-4 搁置项）。

## 验收场景

| 场景 | 批次 | 期望与证据 |
| --- | --- | --- |
| 加法字段缺席 | CP-0 | 与上游行为的对照测试逐项一致；字段在场且被识别时版本协商生效 |
| 能力缺席与恢复 | CP-1 | 消费者声明的能力缺席 → `waiting-deps`；能力 ready → 确定性恢复；全程有快照可查 |
| 能力撤销 | CP-1 | ready → degraded → （恢复或停止），life-mode 等订阅方收到状态 |
| 晚到等待者 | CP-1 | 能力先 ready、模块后等待：立即解析，不挂起 |
| deny-by-default | CP-2 | 未批准的 manifest 权限不生效；批准记录变更后旧授权失效 |
| worker 隔离 | CP-2 | 插件进程崩溃/死循环只影响自身；撤销在限时内终止在途调用 |
| 远程=本地 | CP-3 | 同一插件作者面 API，本地与远程实例产出相同的工具注册与能力声明；断线重连后快照正确 |

记录规则沿用 fork 惯例：PASS/FAIL/BLOCKED/NOT-RUN 加证明范围；禁止用演示冒充通用结论。

## 风险与回退

- **上游重构**（如再次整体改名）：COMPAT 台账 + 有界 shim；rebase 纪律压低冲突面。
- **平台工作漂向无消费者**：批次门直接拦截——没有消费者的批次不开工，已有批次发现消费者流失时收缩为维护态并记录。
- **注册表过度设计**：只实现她文档声明的语义（快照权威、谓词按需、instanceId 作用域在有第二个实例消费者时再做）。
- **worker 传输复杂度**：Eventa 已有 node-worker 适配器思路（她 Q&A 明示），先跑通 invoke 往返，流式与背压后置。
- **CP-3 协议缝合风险**：server-runtime 事件名与 plugin-protocol 本就同源，若实际载荷有漂移，以两侧运行时代码为准逐字段核对后记入台账，不假设类型目录正确。

## 与其他计划的关系

- MC 线：game-host 是 CP-1 的第一个消费者（MC-0c 交付注册，CP-1 交付注册表，顺序上先 MC 后 CP 亦可，注册表做观察者即可衔接）。
- EP 线：EP-0 的批准记录是 CP-2 权限策略的数据源；EP-1 技能适配器是 CP-1 第二消费者；EP-2 是 CP-2 的隔离消费者。
- life-mode：`degraded` 相位的天然订阅者（能力降级 → 生活状态影响），可选验收路径。
- QQ 桥：CP-3 首选消费者，把已选型的人群行为设计从"独立桥"升级为"第一个远程插件"。
- 记忆线：本计划不直接触碰记忆；能力声明与就绪状态作为事件可被 journal 记录，接线由各消费者自行决定。

## 本轮交付与检查

本轮只新增本计划文档并更新 MODS.md 索引。未改动产品代码、未实现任何 CP 批次。作者意图与断层地图的证据限于 fork 基线内的设计文档、README 与 git 历史；上游仓库的后续进展不在本轮核对范围。
