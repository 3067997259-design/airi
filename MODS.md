# AIRI fork mods（本地魔改记录）

本分支（`mods`）是 3067997259-design 的本地魔改，不打算提交 upstream。
基于 upstream `main`（`e170d454e`，v0.12.0-beta.2）。

## 改动动机

桌面端（stage-tamagotchi）无论接哪家模型都出现两类问题：

1. **MCP 工具调用幻觉**：模型"以为"自己调用了工具。根因是 MCP 只暴露两个
   代理元工具（`builtIn_mcpListTools` / `builtIn_mcpCallTool`），参数要求
   `"<server>::<tool>"` 字符串 + JSON 字符串里再套 JSON 的双重编码，失败率极高；
   一次工具相关报错还会触发**静默永久降级**（本会话内直接移除 `tools`），而系统
   提示仍在宣传工具存在，模型只能用纯文本表演调用。
2. **跨轮遗忘**：工具调用结果不进下一轮上下文。流中途失败时整条 assistant
   消息被丢弃；transcript 只在最终消息含 tool 角色时才捕获。

## 改动清单

### M1 — MCP 工具扁平化（`23c6c5bf7`）

- `packages/stage-ui/src/tools/mcp.ts`：新增 `sanitizeMcpToolName`（
  `mcp_<server>_<tool>`，字符集 `[A-Za-z0-9_]`，≤64 字符，超长加稳定哈希）、
  `normalizeMcpInputSchema`（强制 `type:'object'` + 对象 `properties`）、
  `createMcpNativeTools`（每个 MCP 工具生成一个 `rawTool()`，执行时映射回限定名，
  主进程 IPC 零改动）。
- `apps/stage-tamagotchi/src/renderer/stores/tools/mcp.ts`：`refresh()` 先
  `listTools()`；有描述符 → 只注册原生工具；空/失败 → 回退旧元工具。
- `packages/stage-ui/src/stores/ai/chat-llm/tool-resolver.ts`：存在 `mcp_*`
  运行时工具时抑制默认元工具注入（显式 `builtInTools` 覆盖仍优先）。
- `apps/stage-tamagotchi/src/renderer/pages/settings/modules/mcp.vue`：
  apply-and-restart 成功后立即 `refresh()`（原来要等下次领导者选举）。

### M2 — 降级可见化 + transcript 防丢（`8ce05bf4e`）

- `packages/stage-ui/src/stores/ai/chat-llm/llm.ts`：命中 `isToolRelatedError`
  时弹 vue-sonner `toast.warning`；暴露 `degradedToolKeys` 与 `reEnableTools()`。
- `packages/core-agent/src/runtime/chat-orchestrator-runtime.ts`：
  - transcript 捕获条件放宽为"最终消息含 tool 角色 **或** 流式期间见过工具事件"；
  - 流中途失败时持久化部分 assistant 消息（原来整条丢弃）；
  - 传输层没交付 transcript 时，从流式 tool-call/tool-result 事件合成一份。

### M2.5 — 分层提示词注入管线（`f946642c9` + `16923b2fd` + `699b38d4e`）

系统消息拆成带标题的分节，**会话里只持久化角色身份**，其余发送时组装：

- `## Character`：卡的 systemPrompt/描述/性格/场景（持久，现状不变）。
- `## Stage Control`：ACT/DELAY/CALL 协议 + 情绪/动作表（应用所有；i18n 新键
  `base.prompt.protocol.*`，只翻 en + zh-Hans，其余语言回退英文）。存量卡
  （如 ReLU 官方卡）用 `<|ACT` 标记检测去重不重复注入；**新建空白卡从此自动
  获得协议**——顺带修复"自建卡没有协议 → 情绪系统哑掉"。
- `## Output Formatting`：代码块/数学规则（从 session-store 烘焙迁出到发送时；
  旧会话会出现一次重复，无害）。
- `## Toolset`：工具说明，**降级感知**——模型命中 `degradedToolKeys` 时替换为
  "工具本会话不可用，请勿声称已使用工具"，拆除幻觉放大器；MCP 注册的工具集
  提示会列出已连接服务器与 `mcp_<server>_<tool>` 命名约定。
- `[Reminder]`：卡的 `postHistoryInstructions`（CCv3 字段，原来只序列化从不注入）
  以文本块附到最后一条用户消息，沿用 `[Context]` 的投递形态。
- orchestrator：`getSystemPromptSupplement` 增加 `(model, chatProvider)` 参数。

附带修复（`699b38d4e`）：官方卡教的是 `<|DELAY 1|>`（空格），延迟队列正则只认
`<|DELAY:1|>`（冒号）——守规模型的延迟被静默丢弃。现在两种都接受。

**踩坑记录**：stage-ui 的测试消费的是 workspace 包的 **dist**（postinstall 时构建），
改 core-agent/i18n 源码后必须 `pnpm run build:packages`，否则 contract 测试跑的
还是旧代码（表现为"src 里明明改了却不生效"）。

### M-L — Live2D 双特性 + 云吞落地

**`feat(live2d): configurable focus parameter mapping`**
pixi `updateFocus()` 写死六条增益（AngleX/Y 30、AngleZ xy×-30、EyeBallX/Y 1、
BodyAngleX 10）且在所有插件钩子之后执行、无法事后覆盖。`Model.vue` 现按已有
monkey-patch 惯例包装 `internalModel.updateFocus`：standard 走原生；custom 走
`applyCustomFocus` 纯函数（逐参数的 axis/gain/enable，按 modelId 持久化）。
设置页 animation 区新增模式 Choose + 每参数增益滑杆/开关，可直接调低增益或
关掉某条（云吞这类贴图换瞳模型最需要）。i18n 只补 en + zh-Hans。

**`feat(live2d): per-model custom parameter panel`**
模型自带的发型/瞳孔/服装/耳朵开关此前从未暴露。zip-loader 已把 cdi3 DisplayInfo
解析进 `settings._cdiData` 却无人消费；`coreModel.getModel().parameters` 提供权威
参数 id/范围表。新增 `discoverCustomParameters`（合并 cdi 显示名+分组与 core 范围，
剔除系统托管参数与物理摆锤）+ final 插件 `useMotionUpdatePluginCustomParameters`
（每帧重断言启用的覆盖值，动作/表情也抢不走）——复用 expression-controller 的
任意参数直写模式。设置页新增"自定义参数"Section，按 cdi3 分组折叠展示，启用
Checkbox + 范围滑杆（档位参数如 HairBList 天然变整数滑杆），每模型持久化/可重置。

**落地**：修好 `D:\airi\云吞kumo\云吞kumo\云吞kumo.model3.json`（补齐 Expressions
12 项 + Idle/TapBody motions；VTubeube 导出模型通病——热键在 .vtube.json，
model3.json 是残缺骨架），重打成 `D:\airi\云吞kumo.zip`（已保留中文文件名）。
注意：AIRI 导入的是 zip 进 IndexedDB+OPFS 缓存，改磁盘文件夹无效，必须重打包
导入新 zip（新 id → 新缓存键，无需清缓存）。

### M-L2 — 表情写入跨窗口修复 + 外观工具接入 LLM

**表情开关无效（根因）**：`registerExpressions` 把目录镜像进 localStorage 让设置
窗口能"列出"表情，但 `toggle` 只改本渲染进程内存里的 `expressions` Map。设置窗口
和舞台窗口是两个 Electron 渲染进程、两套 Pinia，所以设置页勾选只改了自己那份副本，
真正持有模型、每帧读自己 Map 的舞台窗口从未收到 → 勾了没反应。自定义参数没这问题，
因为它的覆盖值本来就存在 localStorage-backed ref 里、插件每帧重读。

修法：把运行时值从 `expressions` 里抽出来，改成 localStorage-backed 的
`live2d/expression-values`（按 modelId → 参数名 → 数值），两个窗口都读写它；
`expressions` 变成 `catalog`（静态元数据）+ 值的 computed 合并，对外形状不变，
所以 expression-controller / 设置页 / 工具都不用改调用方式。定时自动复位的
timer 仍是渲染进程本地的（handle 不可序列化，谁排的谁负责）。`llmMode` /
`llmExposed` 同理跨窗口化——否则设置页选了"全部"，跑工具的舞台窗口也看不到。

回归测试 `expression-store.test.ts`：两个 Pinia 实例 + 手动派发 `storage` 事件
（jsdom 不会为同文档写入自动发），断言设置窗口的 toggle/resetAll 能到达舞台窗口。

**"公开给 LLM"此前确实是 WIP**：`expressionTools` 写好了但从没被任何地方注册，
`isExposedToLlm` 也没有任何调用方——选"全部"只会弹提示。现在：
- `built-in.ts` 把 `expressionTools()` + 新增的 `live2dParameterTools()` 一起注册，
  并加进 `artistryToolReferences`（主聊天路径）。
- 每个工具都按 `llmExposedGroups` 过滤；`expression_get` 不传名字时只列已公开的组，
  不泄露用户设为私有的表情。删掉 `expression_save_defaults` 的暴露——那是改用户
  持久化默认外观的设置项，不该由模型代劳。
- **更复杂的参数也暴露了**：`parameter-tools.ts` 三个工具
  （`live2d_parameter_list` / `_set` / `_release`）把自定义参数面板那 200+ 个
  模型原生参数开给 LLM，值按 min/max 夹取，一次调用可设多个参数（组合外观算一次
  视觉变化）。云吞有 212 参数 / 24 分组，全开会淹掉工具描述，所以设置页同样给了
  无/全部/自定义三档 + 逐参数勾选。
- toolset prompt 告诉模型两层怎么选：命名表情优先（那是绑定师调好的组合），
  参数只用于表情做不到的细节（发型/瞳孔/耳朵/挂件）。用户没公开任何东西时
  整段 prompt 不注入，不浪费 token。

顺带清掉了上一轮排查留下的 `TEMP-DIAG` 日志。

### M-D — 设计文档集（六份，尚未实现）

勘探后产出的设计稿，全部**未写实现代码**。总纲 `DESIGN-PRINCIPLES.md`
说明分歧时的裁决原则，一句话是：**让她的能力可以增长，但让她的错误
无法伪装成成功。**

| 文档 | 回答 | 核心发现 |
|---|---|---|
| `DESIGN-PRINCIPLES.md` | 按什么原则裁决 | 七条原则，第一条是"结构优先于自律" |
| `ATTENTION-DESIGN.md` | 什么进上下文 | 注意力调度器**已在跑**，只是没接 UI |
| `WORKSPACE-DESIGN.md` | 什么算真的 | 权威表**已写完**在 computer-use-mcp，桌面端零 gate |
| `SELF-AUTHORED-TOOLS-DESIGN.md` | 能力如何增长 | 自证循环：她写的工具产出她要用的证据 |
| `CODING-HARNESS-DESIGN.md` | 如何可靠改代码 | Hashline 是 M1 的同类问题（+15pp） |
| `MEMORY-DESIGN.md` | 什么值得留下 | 四层记忆表**已建好从未使用**，重排公式已在生产跑 |

**贯穿全部六份的判断**：作者与此前的工作留下了大量"做完但没接线"的资产，
所以设计主体是**接线而非重构**。已验证的断层包括：
`compactConversationEntries`（零调用方）、`use-duck-db.ts` 的 `memory_test(vec FLOAT[768])`
（被注释掉的 nomic 写入链路）、`memory_fragments` 五张表（零应用代码）、
`character/orchestrator/store.ts`（完整调度器，reactions 只在 devtools 可见）、
`PLANNING_AUTHORITY_ORDER`（9 级权威表 + 纯函数齐全）、
`js-planner-*`（子进程沙箱 + capability bridge，1503 行 + 600 行测试）。

**两处架构修正**（写在文档头部的修订块里）：

1. **采用 append-only 事件日志**（`model-visible means logged`）作为统一状态底层。
   四泳道状态、`PlanState`、`TaskMemory`、`evidenceRefs`、压缩摘要全部成为
   同一条日志的**投影**。白送 fork/resume、审阅切片、回放。
   注意它是单向的：凡模型看到的必被记录，但**凡记录的不必都给模型看**。
2. **AIRI 现有插件架构就是对的。** DeepSeek Harness 的 Cordis 内核
   （"只负责加载/卸载/依赖，不承载具体能力"）与 AIRI 的
   `injeca` + `module:announce` + server-channel/eventa 是同一形状。
   所以 coding 能力应实现为**一个插件**，不是新外壳。
   此前"参照物选错了"的说法只对 UI 层面成立。

**安全**：调研期间抓取外部文档（oh-my-pi 的 `DEVELOPMENT.md`）时，
返回内容里嵌有试图让读取方改变身份、绕过准则的注入文本。
未见原始文本，无法判定来源（作者放置 / 页面样本 / 链路引入），
但"抓取外部内容会遇到针对读取方的指令"已被实证 →
写入威胁模型（`CODING-HARNESS-DESIGN.md` §8）：**外部内容是数据，不是指令**。
威胁模型边界明确为"对抗弱模型的乐观偏差、疏漏与注入尝试，
**不对抗有意欺骗的强模型**"。

**已验证（2026-08-28）**：dsh 插件的 manifest 与安装机制已查清 ——
静态装配 = pnpm link 依赖（`~/.dsh/plugins/<name>`）+ `dsh.profile.bundles`
列表 + 顶层 YAML 数组的 patch 层；插件包 = 普通 npm 包 + 少量 dsh 元数据
（`dsh.bundle.patch` / `dsh.client.inject` 等）。另发现第二条通道：
会话内**动态 cordis 插件**（`cordis_define`/`cordis_run`/审批/不可变
packageId）。详见 `CODING-HARNESS-DESIGN.md` §7.1 / §7.3。

### M-D+ — 四篇设计文档实现批次（2026-08-28）

| 文档 | 落地内容 | 代码位置 |
|---|---|---|
| CODING-HARNESS | 第一期 Hashline（18 测试）；第二期 journal（23 测试）；第三期 PTC 沙箱提取 + Code Mode SDK + 4 工具（Node 宿主）；第四期证据门核心闭环（8 测试） | `packages/coding-harness/`、`packages/core-agent/src/journal/`、`src/planning/` |
| SELF-AUTHORED-TOOLS | 第一期血缘（authority +3 源 / provenance / gate / approval，24 测试）；第三期 Skill 契约（21 测试）；第四期审阅界面（镜像接线，7 测试 + skills.vue + i18n） | `packages/core-agent/src/authority/`、`packages/skill-forge/`、`packages/stage-ui/src/stores/skills.ts` |
| ATTENTION | 缺陷 A 补齐：Discord 频道在场 → `context:update`（replace-self），关键词 → `spark:notify`（`DISCORD_ATTENTION_KEYWORDS` 环境变量） | `integrations/discord-bot/src/adapters/airi-adapter.ts` |
| MEMORY | §11.2 人工确认流程：新抽取默认 `pending`，晋升要求 `approved`，拒绝不召回；设置页"待确认"队列 | `packages/memory-core/`、`packages/memory-pgvector/`、`packages/stage-ui/src/stores/modules/memory.ts` |

**交叉加固**：并行会话对我交付件的兼容性增强均已合入并全绿 ——
`authority/gate.ts`（"至少一条可证变更"语义）、`journal/store.ts`
（structuredClone 防御）、`skill-forge/lifecycle.ts`（审阅/隔离输入校验）。

**测试面**：core-agent 155/155、memory-core 15/15、skill-forge 21/21、
coding-harness hashline 18/18（ptc/tools 的 fork 套件在升权壳下 26/26 验证过，
本机受限 shell 无法跑子进程测试）、stage-ui skills 7/7。

**当时的剩余接线期任务**：全部列入 `WIRING-BACKLOG.md`；其中 pnpm install 收录
新包、四工具 Electron IPC 宿主与注册、桌面审批卡和防双轨扩展已在 M-D+1 收尾。
MC 侧沙箱 import 切换仍明确等待真机验证。

### M-D+1 — 接线层与桌面 UI 收尾（2026-08-29）

本批次把 M-D 的纯逻辑地基接入 Electron 舞台和设置窗口：

- `coding-host` 通过 Eventa 挂载到 Electron 主进程，提供 workspace read/write、
  Hashline edit、分级 bash 和 Code Mode；高风险命令等待审批卡，超时拒绝。
- 聊天运行时将 user/assistant/tool/context/approval/review/task/reaction 写入 core
  journal；计划卡由 journal evidence gate 投影，模型的 `completed` 声明不能单独完成步骤。
- 每轮 system supplement 注入有界的 `buildTurnProjection`，包含当前步骤、最近证据和
  上一工具结果；Code Mode 面板显示每次 bridge trace。
- reviewed self-authored skill 才进入动态工具表。opencode 适配器在调用前执行版本探测，
  失配自动 quarantine；批准的触发模式同时进入 prompt 和 muscle memory。
- Attention 设置页提供 focused mode 开关；新增 `docs/ai/context/integration-channels.md`
  固化集成事件的泳道选择。
- Minecraft 设置页复用 `GamingModuleSettings`，将 enabled/host/port/username 通过
  `ui:configure` 发送给既有 `minecraft-bot` runtime；状态、context:update 和 spark 流量
  仍保持只读可观测边界。MC 沙箱尚未切换，等待真机验证。
- Memory 设置页增加受限 dreaming pass：idea 写入既有
  `memory_short_term_ideas` 表，独立于事实记忆，支持去重、审阅和 lifecycle 更新；
  `MemoryDreamAgent` 可由后续模型适配器注入。

验证：core-agent、coding-harness、memory-core、memory-pgvector、stage-ui 和
stage-pages 类型检查通过；核心计划/工具/记忆测试通过。permission-frozen Code Mode
worker 的测试启动故障已修为 worker 内部错误提取，不再为读取 workspace 依赖扩大白名单。

### M-M — 维护批次一（2026-08-29）

把 M-D+1 收尾后的接线断层与风险项清掉，全部记录见 `MAINTENANCE-PLAN.md`：

- **固化**：未提交的 M-D+/M-D+1/时序修复按逻辑分 12 个 commit 入库；
  `.gitignore` 补 `云吞kumo/`、`.pnpm-store/`、`.mimosa/`（模型资产 46MB×2
  不进 git）。设计文档的伪代码块从 ```ts 改标 ```text 让 moeru-lint 通过。
- **auto-updater fork 政策**：`resolveAutoUpdaterEnabled()` 默认关闭上游
  更新检查（feed 硬编码指向 moeru-ai/airi Releases，自动升级会覆盖魔改），
  `AIRI_ENABLE_UPSTREAM_UPDATES=1` 可临时开启。原来只对 steam 分发禁用。
- **记忆设置导航**：短期/长期记忆页顶部加 `memory-scope-nav` 切换（长期页
  此前只能手输 URL 到达）；长期页加 Callout 明示"长期持久化尚未接线"。
- **MC 配置投递状态**：表单字段本就是 localStorage-backed（修正"重启丢失"
  的误判），真缺口是 `ui:configure` 无回执。store 增加 `deliveryState`
  （idle/pending/sent），保存时服务离线记 pending，bot registry 上线时自动
  重发；删除与手动起服务指引矛盾的 setup 块。
- **四工具单一来源**：`coding-harness/tools/coding-tool-meta.ts` 导出
  `CODING_TOOL_META`（无副作用子模块，renderer 不拖 node:fs 进 bundle），
  xsAI 工具声明与 Code Mode bridge 标签共用一份描述。
- **plan_update 工具**：激活休眠的计划机器——此前 `plans.start` 生产零调用
  方，证据门/白名单/plan-card 全部空转。orchestrator 新增
  `getActivePlanStep` dep：tool/call+result 仅当工具在当前步骤白名单内才
  打 `planId`/`stepId` 标（无关工具结果无法满足验证门，结构优先于自律）；
  工具支持 start（自动 supersede 旧计划）/focus/cancel，永远无法宣称完成。
- **code_mode 工具**：把 PTC 沙箱暴露给模型（此前只有设置页人工入口）。
  模型写一段程序 `bridge()` 派发四工具，一次调用替代 N 次单工具调用；结果
  展平为有界文本（返回值+日志+每 bridge 一行 trace），超时钳位 1-60s；宿主
  listTools 单独报告 code_mode 可用性。

验证：core-agent 172/172、coding-harness hashline+tools 28/28、stage-ui
plans 1/1、tamagotchi built-in 3/3 + plan 5/5 + coding 2/2 + coding-host
policy 5/5；coding-harness/core-agent/stage-ui/stage-pages/stage-tamagotchi
typecheck 全过（stage-ui 消费 core-agent dist，改源码后需 `build:packages`）。
**真机冒烟通过（2026-08-29）**：构建版 electron.exe + 独立
`APP_USER_DATA_PATH` + CDP，连续三次冷启动 `llm-tools` 均注册
`plan_update` + 四工具（defaultActive）+ `code_mode`——时序修复真机确认，
且注册可用性门同时证明了 coding-host bridge 端到端可达。CDP 调研用
`D:\.airi-smoke\cdp-eval.cjs`（原生 eval，agent-browser 激活式切换在主窗
口忙时会挂）。

### M-M2 — 第二轮：乒乓根修 + 控制台 + pgvector（2026-08-29）

- **ENOTSUP 热循环根修（`14657e2a0`）**：冒烟发现渲染进程周期性冻结后，
  真凶不是主进程无退避，而是 channel-config watcher 的**回滚乒乓**——失败
  回滚恢复"上一次 flush 的值"（与已接受快照不同），回滚本身再次触发
  watcher，apply → fail → rollback → apply 永续循环（每秒 ~13 次失败绑
  定，6908 条日志/3 分钟，Eventa IPC 打满 → 所有渲染进程间歇冻结）。修复：
  watcher 以 `appliedConfig` 去重（启动同步已接受的配置不再触发 apply）+
  回滚恢复快照本身。回归测试 `server-channel.test.ts` 3/3。分析见
  `docs/solutions/runtime/server-channel-enotsup.md`，CDP 冒烟配方见
  `docs/solutions/debugging/electron-cdp-smoke.md`（该目录按 AGENTS.md
  体例新建）。
- **devtools coding 控制台（`140b32d19`）**：`devtools/coding-console` 页：
  计划验证门投影、手工 PlanSpec 测试台（无模型即可检验白名单/证据门）、
  journal 事件流过滤（tool/plan/approval）、coding host 状态芯片。
- **pgvector 主进程 memory-host（`6c8d623f6`）**：`memory-pgvector` 新增
  `ensureMemorySchema`（此前全仓库无 DDL——表从未被创建过；幂等建表 +
  hnsw 索引）与 `./repository` 子路径导出（根 index 顶层 `void main()`
  会启动 standalone client，主进程必须绕开）。主进程 `memory-host` 服务
  （coding-host 同款模式）持有 Postgres 连接；stage-ui 记忆 store 暴露
  `MemoryHostPort` 注入端口；`promoteEligible` 晋升后把片段连同 renderer
  端计算的 768 维 embedding 镜像进 Postgres（尽力而为，不阻塞本地层）；
  长期记忆设置页提供连接串配置/连接/断开/状态。已知边界：检索浏览器仍读
  本地库；真库走查待本机 Docker 起 `server/docker-compose.yaml` 的 db
  服务（`127.0.0.1:5435`）。

验证（第二轮）：core-agent 172/172、memory-core 15/15、skill-forge
23/23、memory-pgvector 2/2、tamagotchi 四套件 13/13；memory-pgvector/
stage-ui/stage-pages/stage-tamagotchi typecheck 全过。



- `pnpm-workspace.yaml`：移除 `minimumReleaseAge`（npmmirror 元数据缺发布时间，
  误报供应链违规）；`stockfish` 钉到 `17.1.0`（镜像没有 18.x）。
- 本机用 pnpm 11.24.0（npm -g 安装）+ node v24.14.0；安装走 npmmirror +
  `ELECTRON_MIRROR`/`ELECTRON_BUILDER_BINARIES_MIRROR`，下载失败时挂
  `127.0.0.1:7890` 代理。

## 桌面版构建配方（本机实测）

electron-builder 这版不认 `ELECTRON_MIRROR`，直连 GitHub 下 Electron zip 会被
TLS 重置。绕行：手动从 npmmirror 拉 Electron 并用 `electronDist` 指过去：

```powershell
# 一次性：下载并解压 Electron 到仓库外缓存
curl -L -o D:\.airi-build-cache\electron-v43.4.1-win32-x64.zip https://npmmirror.com/mirrors/electron/43.4.1/electron-v43.4.1-win32-x64.zip
# 解压到 D:\.airi-build-cache\electron-43.4.1-win32-x64\

cd D:\airi\apps\stage-tamagotchi
# 注意：electron-builder 的代理层只认小写 https_proxy（大写会被忽略，
# nsis-resources 等附加包会直连 GitHub 被 TLS 重置）
$env:https_proxy='http://127.0.0.1:7890'
$env:http_proxy='http://127.0.0.1:7890'
# 免安装版：
npx electron-builder --dir --config.electronDist='D:\.airi-build-cache\electron-43.4.1-win32-x64'
# NSIS 安装包（绝不带 --publish）：
npx electron-builder --win nsis --publish never --config.electronDist='D:\.airi-build-cache\electron-43.4.1-win32-x64'
```

- godot 引擎产物（`engines/stage-tamagotchi-godot/out/win`）缺失只是警告，
  extraResources 跳过，不影响构建（我们不用 godot stage）。
- 产物：`apps/stage-tamagotchi/dist/win-unpacked/airi.exe`（免安装）与
  `dist/AIRI-<version>-windows-x64-setup.exe`。

### 运行时注意事项（第二轮补充）

- **双 userData 目录**：源码构建（electron.exe 直跑）用
  `%APPDATA%\@proj-airi\stage-tamagotchi`，官方安装版用
  `%APPDATA%\ai.moeru.airi`——第一印象"数据全丢"其实是换目录。已用
  robocopy /MIR 把旧版 832MB 迁入源码构建目录；旧目录保留未动。
- **主进程新 workspace 包白名单**：electron.vite.config.ts 的
  `externalizeDeps.exclude` + `resolve.alias` 是主进程消费 TS-only
  workspace 包的硬前提（Node ESM 读到无扩展名源码导入就炸）。
  memory-host 链（memory-pgvector/repository → memory-core）曾漏配，
  症状是启动即 `ERR_MODULE_NOT_FOUND`、进程停在 3 个不进渲染。
  新增主进程依赖的 workspace 包时两处都要加。
- **vue-i18n 消息里的 `@`**：locale 值含 URL/邮箱时 `@` 是 linked-message
  前缀，tokenizer 直接抛错并令整页空白（`{'@'}` 转义）。
  见 `docs/solutions/debugging/vue-i18n-special-chars.md`。

## 运行时注意事项（首跑实测）

- channel-server 绑定 `127.0.0.1:6121` 报 `ENOTSUP`（疑似 TUN/代理网卡干扰
  LSP），非致命，窗口与 MCP 管理器均正常启动；若 widgets 通道异常先查这里。
- **auto-updater 指向 moeru-ai 上游 Releases**：魔改版若被自动升级会覆盖本地
  修改。已于 M-M 批次默认关闭上游更新检查（`AIRI_ENABLE_UPSTREAM_UPDATES=1`
  可临时开启）；如需恢复自动更新，先把 feed 指向 fork 自己的 Releases。
- NSIS 卸载配置 `deleteAppDataOnUninstall: true`：卸载会连
  `%APPDATA%\ai.moeru.airi`（含旧角色数据）一起删，卸载前先备份。

## 验证状态

- vitest：core-agent 21/21、stage-ui 49/49、tamagotchi renderer 3/3 全过
  （含新增：sanitizer/normalizer、原生注册与回退、resolver 抑制、降级 toast
  与恢复、失败流工具轮回放）。
- `vue-tsc`/`tsc` typecheck 全过。
- 手动 E2E：用 student-hub MCP（只读工具 `get_dashboard`/`integrity_check`）
  验证原生工具直调；**不要**用 `scan_school_updates` 做测试（安全边界）。

## 注意事项

- 测试中 Mimosa 钩子对 `tool-resolver.test.ts` 里既有的假 `apiKey` 字面量误报
  过"硬编码凭据"，对动态 DDL 误报过 SQL 注入；绕行方式见提交记录。
- 后续计划：M3（后台长任务 babysitting）、M4（Codex 式长期记忆）未开始。
  两份已审定的前端设计计划已落档：`LIFE-PLAN.md`（Neuro 式自主节拍——考量回合 + 生命模式矩阵 + mirror 工具 + 外观 journal 化）
  与 `CAPABILITY-PLAN.md`（能力扩展——fetch/SSRF、审批模式三档、dsh 插件兼容通道、自造工具闭环 skill_submit/沙箱自测/审阅通知）。
  注意 M3（babysitter）在 LIFE-PLAN 里与自主节拍 tick 合流，不再独立。
  另：`MIRROR-PLAN.md`（让模型真正"看到"自己——vision 读图 + livespace；真机确诊 mirror 生成像素但图不进对话输入）。

## 第三轮实施（2026-08-29）：CAPABILITY-PLAN + LIFE-PLAN 落地

- **fetch 工具**：`packages/stage-ui/src/tools/fetch.ts` + `fetch-ssrf.ts`（纯函数
  SSRF 守卫：http(s) 白名单、内网/环回/IP 整数与十六进制形式、DNS 解析变体在
  主进程 `web-fetch` 服务里）。桌面端经 `installFetchTextPort` 走主进程
  `eventa:invoke:electron:web-fetch:fetch`——node:dns 解析 + 手动重定向逐跳复检；
  web 端回落浏览器启发式（初始 URL 守卫）。大小上限 512KB 原始 / 8K 字符默认，
  抓取内容一律 `<untrusted_content>` 标注来源。tool-resolver 无条件挂载
  fetch，配套 `FETCH_TOOLSET_PROMPT`（chat store 预实例化 module store）。
- **bash 审批三档**：`require`（中危+高危都卡）/ `substitute`（仅高危，原默认）/
  `full`（全部放行）。主进程 coding-host 的 `codingHostSetApprovalMode` 切策略
  （coding-tools 的 `mediumBashApprovalRequired` 支持函数形式按次求值）；
  renderer 侧 `useCodingToolsStore.approvalMode`（localStorage 持久化 +
  refreshStatus 时回推主进程）。UI：设置 → 编码 → Bash 审批三键 +
  InteractiveArea 输入区盾牌循环按钮（默认 substitute 高亮不变色）。
- **自造工具闭环三齿**：
  1. `skill_submit`（tamagotchi builtin）：`analyzeSkillSource`（skill-forge 新增
     确定性静态分析，findings 首次由规则而非模型自报）+ `validateDeclaration`
     诚实声明门；落盘 `workspace/skills/<id>/{source.mjs,selftest.mjs,meta.json}`；
     自测失败不提交、声明确认与源码矛盾直接拒；风险分层后进 probation。
  2. 沙箱自测：selftest 程序经 code-mode 沙箱（`codingHostCodeRun`）实跑，
     失败返回 trace 日志给模型重写。
  3. 审阅通知：`stores/reviews.ts` 普通单例（非 pinia，卡片渲染不依赖活跃
     pinia）+ skills store 在 review 事件点 `ingestReviewEvent` 喂数据；
     聊天时间线新增 `ReviewCard`（镜像 approval-card，蓝系）。
- **LIFE M1 mirror**：`stage-ui-live2d/src/tools/mirror-tools.ts`——激活表情 +
    持有的装扮参数（group 显示名）+ 心情（mood 走端口注入，live2d 包不依赖
    stage-ui），返回自然语言快照 + 精确 JSON；注册进 built-in（appearance 组）。
- **LIFE M2 外观 journal 化**：core-agent `JOURNAL_EVENT_TYPES` 新增
  `appearance/changed`（含 `life/tick`）；custom-parameters / expression-store
  的变更写点在 `installAppearanceJournalPort`/`installExpressionJournalPort`
  注入后向 journal 追加——LLM 工具与设置面板都叙事化。
- **LIFE M3 考量回合 + 生命模式**：
  - core-agent：`ChatSendSource = 'text' | 'voice' | 'self-initiative'`、
    `ChatOrchestratorSendOptions.source`、correlation 钩子联合类型同步、
    `getSelfInitiativePrompt` 系统补注钩子（仅自主轮注入 `## Self-Initiative` 节）。
  - stage-ui：`ChatSendPayload.source`；自主轮只挂 self_speak/self_note 两工具；
    `## Self-Initiative` 节含集中模式合成（focused 只报工作不社交）；
    `tools/life/self-tools.ts`；chat store 在回合完成后按工具调用审计
    `life/tick`（spoke/noted/considered-silent——沉默也入册）。
  - 生命周期：主进程 `life-mode` 服务（`<userData>/life-mode.json` 持久化，
    同 memory-host 模式）+ 纯函数门控 `evaluateLifeTickGate`
    （mode→静默时段→每日预算→冷却，逐项可测）→ `lifeTick` 事件 → leader
    renderer `useLifeModeStore`（busy 互斥门 + 刺激物构建：真实 journal 事实）→
    `chatStore.send({ source: 'self-initiative' })`。
  - 三档：off（=现状）/ respond（照常入册不开口）/ autonomous（考察回合启用）；
    设置页 `settings/modules/life-mode.vue` + modules 列表入口 + i18n。
  - 注册联动：built-in tools store watch 生命模式，≠off 才注册 self 工具。

### 验收记录（第三轮）

- typecheck 全过：stage-ui / stage-tamagotchi / stage-ui-live2d / core-agent /
  coding-harness / skill-forge / i18n。
- lint 全过（changed 文件 52 个，eslint --fix + 手工修 7 处残留）。
- vitest 定向回归全绿：fetch 13、mirror 5、skill-forge 静态分析 14、
  orchestrator 31（含自主轮注入/普通轮跳过）、coding-tools 11、skills 11、
  history browser 11、journal 3、life-mode brief 3、skill-submit 8、
  life-mode gates 9、built-in 3。
- tamagotchi 生产构建：electron-vite 主进程/preload/renderer 输出 + typecheck
  全绿（web-fetch 与 life-mode 主服务打包路径验证）。
- **遗留/后置**：dsh 内容插件适配器（样本插件解剖需先拍板，GitHub 直连限制）；
  @文件引用与 skill 上拉栏 UI；M4 阶梯（L0 观测→L1 闯入记忆分享→L2 作息在场→
  L3 世界泡，与 babysitter 合流）；生命周期预算/冷却的 UI 提示位；
  skills 队列持久化仍为内存态（产物已落盘，队列状态跨重启靠重提）。

## 第三轮验收（含 agent-browser 真机走查，2026-08-30）

真机环境：build 后的 electron + CDP 9250 + agent-browser（raw CDP eval 直连
leader 渲染进程）。API key 解禁、余额充足。**真机走查逼出 7 个仅靠单测发现不了的 bug**：

1. **主进程打包 fetch 工具外部化**：electron.vite externalizeDeps.exclude
   只匹配整包名，`@proj-airi/stage-ui/tools/fetch` 子路径条目不生效 → 启动即
   `ERR_MODULE_NOT_FOUND`。改为整包 `@proj-airi/stage-ui`（配合 alias 只真正
   打包两个工具文件）。
2. **渲染进程整体挂载失败**：renderer main.ts 在 `app.use(pinia)` 前调用
   `installCodingHostBridge`，而 `installLifeModePort` 立即 `useLifeModeStore()`
   → 抛异常，`#app` 空、白屏。修法：life-mode port 安装改为微任务延迟 sync，
   onTick 惰性解析 store。
3. **主进程 main→renderer 推送盲区**：eventa `createContext(ipcMain)` 无 sender
   时 emit 不投递任何窗口 → 审批卡/生命 tick 永远到不了渲染层。新增
   `eventa-window-broadcast`：每个 BrowserWindow 绑一个 window context，emit
   时广播到所有窗口；invoke handler 仍留在 plain context。
4. **ui 包 Collapsible prop 名错**：是 `default`/`label`，不是 `default-open`；
   且 content slot 在 Transition 内需**单根**。审批卡/审阅卡此前完全折叠且只
   渲染首个子节点。
5. **i18n 键路径缺 `stage.` 前缀 + dist 未重建**：卡组件用 `chat.*` 而非
   `stage.chat.*`；且 renderer 消费 i18n 的 `dist`（boot 文档已有此教训）。
6. **workspace writeFile 不建父目录**：skill_submit 落盘 `skills/<id>/` 时
   realpath 对不存在的中间目录抛 ENOENT → 她被迫发起 mkdir 审批。修法：
   writeFile 先递归建父链；且 skill 执行器改用 `readRaw`（read 返回带行号
   签名的投影，不是纯源码，导致 `export default` 剥离后残留字符串语法错）。
7. **生命模式 setConfig 传 reactive 代理**：`setConfigPatch` 把 vue proxy 直接
   送 eventa invoke，`structuredClone` 失败 → disk 永不更新、main 一直按 off
   运行。修法：port 边界 `toPlainConfig` 深拷贝。

真机验证通过的验收项：
- **fetch**：抓 example.com 正常并标注来源；`http://127.0.0.1:9250` 与
  `http://localhost:6221` 均被 SSRF 守卫拒绝；她尝试用 bash curl 绕过被高危
  闸门拦下（`bash denied`）。
- **web_search**：Tavily 实搜出结果并引用链接。
- **审批三档**：设置页三档切换 + 输入区盾牌循环按钮实时改 aria + localStorage
  持久化 + 跨窗口同步；`require` 下中危 bash 触发审批卡（琥珀系，中文标题/
  按钮，含命令 subject、risk badge），点批准 → 目录真实创建，超时 → denied。
- **skill_submit 完整闭环**：她提交 reverse_text/flip_text → 落盘
  `workspace/skills/<id>/{source.mjs,meta.json,selftest.mjs}`（staticAnalysis 全
  clean、contentHash 绑定）→ 沙箱自测通过 → 聊天审阅卡（天空系）→ 审阅并启用
  → trust=reviewed → 真机执行 `flip_text({text:"self-authored loop complete"})`
  返回 `"etelpmoc pool derohtua-fles"`（成功反转）。剩余缺口：技能队列为内存态，
  跨重启需重提（已列后置）；激活机制支持关键词/默认可用（defaultActive 已改
  true 使审阅即用）。
- **mirror**：返回她的真实外观快照（云吞模型、现行发型档位 `HairBList=2`、
  心情 neutral/calm + 精确 JSON）。
- **M2 外观 journal**：`setValue` 改 `HairBList` 后 journal 追加
  `appearance/changed {source:parameter, target:HairBList, value:2}`。
- **生命模式**：`respond` 模式每 1 分钟心跳，renderer 记
  `life/tick {outcome:gated, gate:respond}`（入册不开口、零 token），符合不变量 #2；
  `autonomous` + 静默时段 0-23 下主进程 economic 门在 emit 前拦截，无新 tick。

额外发现并确认：LLM provider 在真机下偶发 `Failed to fetch`（网络抖动），文本回
踢 + 错误条机制正常（此前修复的失败发送提示在真机复现并兜底）。

## 第四轮：mirror 增强为"真·照镜子"（图进对话）

需求确认：用户面前就是实时 Live2D 皮套，不需要工具看图；真实需求是**让对话
模型真正看到当前外观**（B 路径）。经调查确认关键架构事实：

- **mirror 工具与 Live2D 画布在同一渲染进程**（main 窗口 `synced-leader:true`、
  `stage-runtime:full`），不存在跨窗口取帧问题。
- 对话多模态通道已存在：`ChatSendPayload.attachments` → orchestrator 组
  `image_url` content part → `sanitizeMessages` 对支持 content array 的 provider
  保留（视觉模型看到，非视觉模型降级丢图留文本）。
- **工具结果不会自动变下一轮多模态输入**——需在 chat store 加"工具图→attachments"
  注入。

实现（两案并行，均走端口注入、不破坏 `stage-ui-live2d` → `stage-ui` 边界）：

1. **Stage capture 端口**（`stores/stage-capture.ts`）：Stage.vue onMounted 注册
   `captureFrame`，onUnmounted 注销；mirror 工具经端口取帧（与
   `installLifeModePort`/`installFetchTextPort` 同模式）。
2. **mirror 工具增强**：取帧后返回 **content 数组** `[{type:text},{type:image_url}]`
   （方案 A 尽力而为，视觉 provider 透传）；同时把帧存为 backgroundStore
   `selfie` 条目（`BackgroundEntry.type` 本就预留了 `'selfie'`）。
3. **方案 B 列队注入**：`mirror-snapshot.ts` 存 `lastMirrorAttachment` 暂存；
   chat store `onChatTurnComplete` 检测本轮调 mirror → `takeLastMirrorAttachment`
   入 `pendingSelfieAttachments` → 下轮 `executeSend` 合并进 `attachments`。
4. **方案 A**：镜拍后返回数组 content，当前 tool loop 内视觉模型尽力而为看到图，
   可靠兜底交给方案 B。非视觉模型由 `sanitizeMessages` 自动降级（留 `text` part）。

验收：
- typecheck 全过（stage-ui / stage-ui-live2d / stage-tamagotchi）；build 全过。
- mirror-tools.test.ts 新增 2 例：有帧返回 content 数组（含 image_url）、无帧
  返回纯文本 → 7/7 全绿。
- stage-ui 回归 34/34（tool-resolver / history.browser / fetch）、lint 干净（eslint
  在 Git Bash 下偶发 segfault，非代码问题，复跑确认 clean）。
- 遗留：方案 A 的"tool result 内 image_url 是否被视觉 provider 当真"取决于 provider
  实现，AIRI 侧无法保证——因此以方案 B（下轮 attachments）作为可靠兜底。

后续可做：把 mirror 自拍作为共享媒体暴露给模型主动引用（backgroundStore
`selfie` 条目已可被 image_journal apply 检索），以及 M4 阶梯里"镜子"进阶。

## 第四轮梳理（2026-08-30）：记忆层 / life-mode / 上拉栏 状态核查

- 修复：
  1. life-mode i18n：`life-mode.vue` 模式键误写为 `life-mode.modes.${mode}`，
     locale 实际在 `sections.mode.*`（en/zh-Hans 源本就齐全）→ 改为
     `sections.mode.${mode}`。症状即"标题描述正常、三个模式名显示原始键"。
  2. i18n dist 未重建：上一轮 mirror-visual 键只改了 src，dist 里没有 →
     `pnpm -F @proj-airi/i18n build` 重建（教训重申：渲染层吃 dist）。
  3. OPFS 单写者结构性加固：`useDuckDb.getDb` 自己检查 `resolveMemoryWriteAccess`，
     follower 直接抛错——守卫不再只靠 memory store 自觉；`Stage.vue` 移除
     `await getDb() // stub for future update`（每挂一个 Stage 就无条件开一次库，
     白白扩大锁冲突窗口）。
  4. `memory-long-term.vue` 类型错误：Callout theme 传 `'red'` 不存在 →
     `packages/ui` Callout 补 `red` 变体 + ui-components 文档同步。
- 诊断结论：
  - `createSyncAccessHandle` = OPFS 同文件第二个同步句柄冲突。当前代码只有
    主窗口（leader）会开库（WidgetStage 仅 index.vue 挂载，chat 窗口不挂
    Stage；其余窗口全被守卫拦住），嫌疑指向**另一个同源渲染进程持有文件**：
    双开应用实例 / 僵尸进程（dev 模式 HMR 重求值 use-duck-db 也会留旧 worker
    句柄）。复现时的处置：杀干净全部实例再点初始化。
  - 短期与长期记忆在存储层零关系：短期=DuckDB-WASM OPFS（渲染进程本地），
    长期=Postgres/pgvector（主进程 eventa 桥，需 docker pgvector 栈在跑）。
    唯一连接点是 `promoteEligible` 晋升后镜像进长期库。
  - 梦境整理"没作用"= 同一失败链：`dream()` 需 master `enabled` +
    `dreamingEnabled` + DB 初始化成功；DB 失败时静默返回 `[]`，且失败无
    toast（错误只显示在压缩区状态行）。
  - 短期抽提为零 = `captureEnabled` 默认 false + `captureTurn` 同样先过
    DB 初始化 + extractor 的 provider/model 缺省回落当前聊天 provider。
- 核对设计文档未完成项（确认重申）：CAPABILITY-PLAN 的 @文件引用与 skill
  上拉栏 UI（当时即标"后置"）、dsh 适配器（需样本插件解剖）；LIFE-PLAN 的
  M4 阶梯（L0-L3）与预算/冷却 UI 提示位；skills 队列内存态持久化缺口；
  毕业考（真实小工具全流程）未跑。
- 验证：stage-ui / stage-pages / ui typecheck 全过；eslint changed 文件干净；
  i18n dist 重建后 en/zh-Hans 均含 mirror-visual。

### 真机验收（2026-08-30）：记忆链修复复验 + 途中五连修

环境：杀干净残留实例（1 主 + 8 子 electron，即 OPFS 句柄持有者）→ build +
`electron-vite preview` + CDP 9250 raw eval 直连 leader 渲染进程。

复验途中发现并修复（每项先复现后修）：
1. **NaN 拼进 SQL**（抽提为零真凶之一）：`local-memory.ts insert()` 把
   `Math.max(-1, Math.min(1, input.valence))` 原样拼进 INSERT，抽取缺心情
   字段时 DuckDB 报 `Referenced column "NaN" not found`。修：`numberValue()`
   边界归一化（importance 缺省 5、valence/arousal 缺省 0），SQL 与返回值
   共用归一化结果。
2. **抽取 prompt 缺 schema**（抽提为零主因）：`extractMemoryTurn` 的 system
   prompt 没要求模型返回 importance/valence/arousal/tags，而过滤器硬性要求
   它们是 number → 模型输出全被静默过滤。修：prompt 补全字段 schema；过滤
   放宽为结构校验，数值与 tags 在 map 时归一化兜底。
3. **tags 不可迭代**：`insert()` 的 `for (const tag of input.tags)` 对缺
   tags 输入在主行已入库后抛错——调用方收到错误但碎片实际已持久化。修：
   `input.tags ?? []`。
4. **use-duck-db 守卫误伤**：单写者守卫初版在 Node/测试上下文（无 location）
   误判 follower。修：仅浏览器上下文强制；新增 follower 拒绝测试
   （vi.stubGlobal location）。
5. **llm.test.ts 陈旧 mock**：fetch 上线时没把 `createFetchTools` 加进 tools
   barrel 的 vi.mock → 全量 6 失败（第三轮只跑了定向测试的欠账）。修：mock
   补导出。

真机复验结果：
- `initialize()` → `databaseStatus: 'ready'`，createSyncAccessHandle 消失。
- 缺 mood/tags 的抽取完整入库、返回正确、待审阅区可见；`dream()` 产出
  ideas 且去重正常。
- life-mode 页三模式渲染"关闭/只回应/自主"；意识页 mirror-visual 正常。
- 长期记忆：docker daemon 未运行 → 启动 Docker Desktop → 启动
  `proj-airi-backend-db-1`（vchord-postgres pg18，127.0.0.1:5435）→
  `configureRemoteHost` 后 status 'ready'。两个注意点：容器 restart 策略
  原为 no（已改 `unless-stopped`，与 memory-host 注释对齐）；主进程缓存的
  连接失败要靠 configure 触发重连，getStatus 不做活探测。
- stage-ui 全量 818/818 绿；typecheck / lint 干净。


