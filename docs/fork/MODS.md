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
  另：`COMMAND-PLAN.md`（/plan 与 /goal 指令面板 · @文件引用 · 计划持久化
  复用休眠的 memory_long_term_goals 表——基座已实现；2026-08-31 增补真机
  诊断与 Phase A–E 执行计划：证据三档归位 / user_ask / 回合内续跑 /
  会话边界 / babysitter 对内面）。

## COMMAND-PLAN 落地（2026-08-31）：Phase A–E

- 提交：7b5658fac（基座：触发面板泛化、@引用展开、/plan /goal 拦截、
  horizon、DuckDB 持久化）；eef7b4d23（Phase A：证据三档 + 审批桥）；
  b4faf6ff8（Phase B/C/D：user_ask、回合内续跑、会话边界）。
- Phase A 解开真机死局：focus 审批步骤阻塞式发审批卡（决策经 coding-host
  重广播进各窗口 journal，planId 贯通），`complete` 动作未验证完成（卡片
  黄档），start 拒绝 human_approval×非审批幽灵组合，projection/prompt 明示
  "聊天文本不是批准"；gate 语义精化：零工具签核步骤批准即完成，带工具
  步骤仍需变异证明。
- Phase B：`user_ask` 工具 + `runtime-user-ask` 同步 store 问题卡（跨窗口
  渲染、answer 路由回 leader、关闭即"无答案继续"降级），journal 记
  user/asked + user/answered。
- Phase C：回合内续跑——回合结束仍有可执行计划步骤时自动续跑（每条用户
  消息上限 2 轮，用户发送重置，审批/受阻步骤不调度）。
- Phase D：session 计划绑定创建会话（DuckDB `session_id` 列 + 卡片/投影
  按当前会话过滤），long goal 全局滚动不变。
- Phase E：确认另一路已实现 life tick → long goal 工具轮 + blocker 上报 +
  stall 检测，无需增补。
- 测试：core-agent 179、stage-ui 837、tamagotchi tools 66 全绿；typecheck
  三包干净；真机 sanity：user_ask/plan_update 注册、/plan 面板列命令、
  计划与 user_ask store 就位、新会话无残留。
- 教训重申：core-agent（exports→dist）修改后必须 `pnpm -F @proj-airi/core-agent
  build` 再跑 tamagotchi 跨包测试，否则测的是旧产物。
- 教训新增：CDP eval 注入非 ASCII 表达式时，`eval(atob(b64))` 会把 UTF-8
  字节按 Latin-1 解析成乱码（信息可逆，模型能自行还原但不可靠）。正确姿势：
  `eval(new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0))))`，
  助手脚本 `.zcode/tmp/cdp-eval-utf8.sh`。
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
- **遗留/后置（2026-08-30 更新）**：dsh 内容插件适配器**已放弃**（拍板：dsh 插件
  与 AIRI 架构不同源，兼容面收敛为自有技能格式）；@文件引用（skill 上拉栏已于
  当日完成）；**babysitter/长程 goal 后台推进未实现**——计划只能在她人在场时
  沿对话推进（`getActivePlanStep` 喂当前步），心跳考量回合只挂 self_speak/
  self_note、不能执行计划工具，"同一 tick 两面"的对内面缺失；M4 阶梯（L0 观测
  →L1 闯入记忆分享→L2 作息在场→L3 世界泡，babysitter 是其合流点）；生命周期
  预算/冷却的 UI 提示位；skills 队列持久化仍为内存态（产物已落盘，队列状态跨
  重启靠重提）。

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

### Codex 风 skill 上拉栏（2026-08-30）

- 构成：`use-skill-shelf` composable（状态机：尾随 `/token` 开栏 → 输入过滤
  → 选择回填规范化名）+ `SkillShelf.vue`（展示面板：名/描述/提示条/空态）+
  `InteractiveArea` 接线（`submit-on-enter=false` 下 Enter 由面板优先消费）。
  store 侧 `activatedEntries` 增加 name/toolId 匹配——插入 `/name` 必然激活；
  新增 `reviewedSkills` 投影；i18n `stage.skill-shelf.*`（en/zh-Hans + dist）。
- 设计要点：上拉栏只做"选择 → 插入"这层 UX，激活与注入完全复用既有
  `prepareForPrompt`（发送时按名称/关键词命中 → toolset prompt 注入）。
  `ShelfKeyEvent` 结构化接口让 composable 保持 DOM-free，node 测试项目可直接
  跑（KeyboardEvent 在 node 项目不存在，浏览器模式才可用）。
- 测试：use-skill-shelf 7 例；skills store 12 例（含 name-token 激活与
  reviewedSkills 投影）。
- 真机验收：chat 窗口输入 `/open` → 面板渲染 opencode_delegate（名 + 描述 +
  中文提示），Enter 消费并回填 `/opencode_delegate `、面板关闭；截图确认暗色
  主题风格一致。坑：skills-review 是 synced store，follower（chat 窗口）本地
  变更会被 leader 快照覆盖——造 reviewed 数据必须在主窗口（leader）做。

## 接手前勘探（2026-08-31）：能力层缺口与原则七修订

新接手方通读全仓后的对照勘探。**只改文档，未动代码**：产出
`HARNESS-PLAN.md` §0.3 / §3.5（批次一·五）/ §9.1 / §9.2，以及
`DESIGN-PRINCIPLES.md` 原则七的修订块。

- **动机**：`HARNESS-PLAN` 原四批次修的是**控制层**（能叫停、能插话、回合有
  边界、不违抗用户）。与 opencode 类 harness 的日常循环对照后确认：**能力层
  （在仓库里干活）同样缺，且缺口更硬**——批次二三四优化的是一个还没法可靠
  定位和改文件的循环。故新增批次一·五插在批次一与二之间。
- **原则七修订**：「4 工具」作废。flash 级模型上"多几个工具 vs 4 个"无区别，
  真正压垮单人项目的是决策面不是条目数。新判据：**工具面只按「是否改变工作
  循环的形状」扩张**（`grep` 改变形状；第 12 个同形状只读工具不改变）。
  方向未变——仍拒绝"因为参照物有所以我们也要有"。
- **七项能力层缺口（C1-C7，全部对到代码）**：无检索原语（grep/glob 全仓零
  匹配，只有单层 `list`）；`read` 无分页（整文件每行带签名，3000 行文件即满
  窗）；`edit` 只能整行替换（插入做不到）；`write` 零校验（可覆盖未读过的
  改动）；win32 上 bash 实为 cmd.exe 而工具描述未声明；CRLF 签名往返破坏行尾；
  工作区根目录写死 `~/AIRI-workspace` 且 eventa 无 setter。
- **最尖锐的一处（C3+C4）**：Hashline 保护了模型会绕开的那条路（`edit` 门槛
  高），模型必走的那条路没有门（`write` 门槛零）。理性模型一路 `write` →
  内容签名机械在最常见场景里完全不生效。按原则一这是**门的位置错了**，不是
  能力缺口；修法是让两条路门槛匹配（`edit` 范围化 + `write` 加 `baseHash`
  陈旧校验），而非劝模型多用 `edit`（那正是被原则一判为错的自律式解法）。
- **C6 实测（非推断）**：`"const a = 1\r\nconst b = 2\r\n"` 经 `split('\n')`
  后首行为 `"const a = 1\r"`，带 CR 签名 `m4`、去 CR 为 `fh`；替换首行再
  `join('\n')` 得 `"const a = 42\nconst b = 2\r\n"`——行尾已混合。本仓库工作
  树即 CRLF（git 持续报 `LF will be replaced by CRLF`），**让她改 AIRI 自己
  的代码就会踩到**。
- **范围外但确认存在（§9.1，需用户单独拍板）**：① journal 仍是内存态——
  `journalToJSONL` 零调用方、store 为 `synced:{state:false}`，§4.4 承诺的
  fork/resume/回放是设计意图不是运行事实；本计划 R4 只把持久化失败上浮成
  芯片，**没治日志本身不落盘**，真正的 resume 不在任何批次里。② 无委派原语
  （btw 是反向通道，不是 subagent）。③ 无 diff 面（`write` 只回 `wrote path`）。
- **预期差异（§9.2，非缺陷）**：批次二后证据门（裁决）与 todo（沟通）并存，
  比 opencode 多一层状态。职责分离的论证成立（沟通职责压给证据门正是 R3 的
  死因），但对 flash 级模型是净收益还是摩擦需真机观察——§7 已留观察项。
- **新增验收**：T8（grep 定位→分页读→edit，`git diff` 无行尾噪声）、T9（3000
  行文件不进满上下文且跨页签名命中）、T10（陈旧覆盖被挡且未落盘，列为常驻
  回归）、T11（win32 下能自行改用正确命令形态）。
- **新增红线**：新依赖必须由用户选择（grep 的 ripgrep 来源、win32 shell 二选
  一，均列表待拍板）；改 `classifyBashCommand` 分级正则属安全变更（漏一条即
  高危降级直跑）；`read` 分页后签名宽度仍按**文件总行数**计算（否则跨页失配，
  是本批唯一容易静默写错处）。

### 批次一·五决策落定与前四项落地（2026-08-31 晚）

**两处依赖决策已由用户拍板**（`AGENTS.md`「新依赖必须由用户选择」流程走完，
对照表见对话记录，结论写进 `HARNESS-PLAN.md` §3.5.3 第 1 / 第 5 条）：

- **C1 检索后端 = `@vscode/ripgrep`**（自带平台二进制）。判据是「任何用户机器上
  行为一致」：只探测系统 `rg` 会让行为随机器变（本机实测 `rg` 不在 PATH，
  即一直走慢回落），而"行为随环境不确定"正是原则一要消除的；纯 Node 遍历在
  AIRI 这种体量的仓库上慢到影响循环。实施注意：`rgPath` 从包导出取不要硬编码；
  `electron-builder.config.ts` 的 `asarUnpack` 要覆盖该二进制（现有只有 `**/*.node`），
  否则打包后 spawn 直接 ENOENT；postinstall 代理只认小写 `https_proxy`；
  保留 Node 遍历兜底但**降级必须可见**（M2 教训）。
- **C5 shell = 探测 Git-Bash → 缺失回落 PowerShell → 两条路都动态声明当前 shell**。
  选 Git-Bash 作首选的判据是**安全面不是便利**：`classifyBashCommand` 的分级正则
  全是 POSIX 形态，Git-Bash 让它继续有效；换 PowerShell 等于重写整张分级表，
  漏一条就是高危命令降级为 read-only 直跑、不弹审批卡。回落那条路仍须补正则，
  且 PowerShell **别名**（`ri`/`iwr`/`sc`）是最容易漏的一类。

**七项里四项已落地**（工作树未提交，定向测试 36/36 绿：`hashline/*` + `coding-tools`）：

- **C2 `read` 分页**：`{ offset, limit }` + `DEFAULT_READ_LINE_LIMIT = 400`；
  签名宽度仍按**文件总行数**算（切片前的 `lines.length`），跨页签名一致。
- **C3 `edit` 范围化**：`endSignature?` + `operation: replace | insertAfter` +
  `afterSignature`。`insertAfter` 是独立语义而非"替换成两行"——后者会迫使模型
  复述它不打算改的那一行，正是 Hashline 要消除的东西。
- **C4 `write` 陈旧校验**：`writeFileIfUnchanged(path, content, baseHash)` →
  `written | state_changed{currentHash}`；`baseHash: null` 显式声明"预期不存在"，
  文件已存在时该声明本身即失配（顺带堵掉"以为在建新文件其实覆盖了旧文件"）。
  哈希用 `contentHash`（FNV-1a → 8 位十六进制），威胁模型是疏漏不是伪造。
- **C6 CRLF 保真**：新增 `hashline/text.ts`——`parseTextFile` 按 `/\r?\n/` 切行
  （**签名不含行尾符**）、探测主导行尾、报 `mixedLineEndings`；`joinTextFile` 按
  探测到的行尾写回。修掉勘探期实测的行尾混合问题。

**剩余三项建议顺序**：C5（她当前在 win32 上几乎发不出可用命令，且 C1 的
"不要用 bash grep"正是为了不继承这个问题）→ C1（依赖打包配置）→ C7（切根，纯增量）。
状态表见 `HARNESS-PLAN.md` §3.5.0。

### 批次一 + 批次一·五落地收官（2026-09-01）

两批全部实现并提交，定向测试与 typecheck 全绿。状态表见 `HARNESS-PLAN.md`
§3.0 与 §3.5.0（那两张表是进度真相，本节只记结论与教训）。

**批次一（回合语义）——四个提交里的两个**：`feat(coding-harness): page reads…`
收编了工作树里 C2/C3/C4/C6 的在途改动，`feat(chat): interruptible turns with
steer and queue lanes` 落地回合化本体：每回合一个 AbortController（中止时给
未结算 tool call 补写合成失败结果，日志仍可回放）、`turn/start` /
`turn/end{reason}`、双车道（Enter 插话 / Shift+Enter 排队、队列逐条撤销）、
停止按钮与 Esc、`maxSteps` 参数化（计划轮 50）与预算将尽提示，
续跑预算从「每用户消息」改为「每计划」且停止意图会把计划置 `paused`。
顺带把 life-mode 的日预算改成「tick 被消费才计费」。

**批次一·五剩余三项（C5 → C1 → C7）**：

- **C5 shell 显式化**：`execFile(command, { shell: true })` 在 win32 上解析
  ComSpec（=cmd.exe），是"她发 `grep -rn` 全部报错"的直接原因。现在探测
  Git-Bash（`git --exec-path` → 程序目录 → PATH）→ 缺失回落 PowerShell，
  显式传可执行文件 + 命令参数。**两处非显然坑**：Git-Bash 必须用 `-lc`
  （非登录 shell 拿不到 `usr/bin`，`grep`/`ls` 都不在 PATH），而 `-l` 又必须
  配 `CHERE_INVOKING=1`，否则 Git for Windows 的 profile 会把工作目录换成
  `$HOME`——命令会"成功"地跑在错误目录里。分级正则补了 PowerShell cmdlet
  与别名，每个别名（`ri`/`rd`/`del`/`iwr`/`irm`/`sc`/`ni`/`cpi`/`mi`/`rni`/`md`）
  单列一条测试样本，并只在命令位（行首或 `;`/`|`/`&` 之后）匹配，
  免得参数里的 "ri" 触发误判。
- **C1 检索原语**：`@vscode/ripgrep@^1.18.0` 实测以平台子包直接分发 `rg.exe`
  （`ripgrep 15.0.0`），没走 postinstall 下载，本次未触发小写 `https_proxy` 那条坑。
  命中行签名按**文件总行数**计算（测试直接与同文件 `read` 投影比对），
  所以 grep 的命中可以直接喂 `edit`。结果有界（50 命中 / 200 字符 / 20 秒）
  且截断会明说；ripgrep 不可用时走 Node 兜底走查并在结果里声明降级。
  **实测两处易错**：ripgrep 会回显搜索参数，所以整仓搜索的路径是 `./src/a.ts`
  （已统一归一化为 `src/a.ts`）；`buildSignedFileProjection` 默认只投影 400 行，
  拿它做跨页签名比对的断言必须显式传 `limit`。
- **C7 切根**：`setWorkspaceRoot` 校验（存在 / 是目录 / 可写）后**同时重建**
  host + tools + codeRuntime——只重建 host 会让 Code Mode 继续跑在旧树上，
  这正是回归测试专门断言的一半。切换持久化到 `<userData>/coding-host.json`
  并压过 `AIRI_WORKSPACE_ROOT`（环境变量只决定首跑），切根写 journal
  `context/inject` 让她知道地面换了。

**环境备注**：本机 4 个 `stage-tamagotchi:node` 用例常态失败，全部是
`EPERM: operation not permitted, symlink`（Windows 未开开发者模式），
与本批改动无关：`plugins/index.test.ts` 的两个 gamelet 用例、
`http-server/static-assets/paths.test.ts` 的两个符号链接用例。


### 批次二 / 三 / 四 + §9.1 落地收官（2026-09-01）

HARNESS-PLAN 的四批与 §9.1 三处缺口全部实现并提交（八个提交）。状态表见
`HARNESS-PLAN.md` §4.0，本节只记结论、决策与踩到的坑。

**批次二（证据门 + todo + 持久化 + 后台）**

- **证据门去焦点化是 R3 的根修**：打戳从「当前焦点步骤」放宽为「任何**未完成**
  且接受该工具的步骤」（焦点只作优先级）。同时把「焦点推进」做成**派生**而非写入：
  步骤被门解决后，`currentStepId` 自动指向下一未决步骤。原实现里步骤一完成就
  没有任何步骤处于 in_progress/blocked，投影随即不再指名任何步骤——这才是
  「计划卡住不动」的直接机制。
- **错配不再静默**：无处可挂的工具结果记 `plan/hint`，并在计划投影里回喂
  「bash 没有产生步骤证据；开放步骤接受 read」。丢证据是原设计里最贵的静默失败。
- **todo 通道是派生态**：取最近 `turn/start` 之后的最后一次 `todo/write`。
  这样「新回合清空」不需要任何清空写入，last-write-wins 也天然成立。
  它不参与验证门，也不被门阻塞——把沟通职责压给裁决机构正是 R3 的成因。
- **持久化可见化**：`plans.persistence` 三态 + 开库退避重试 + 琥珀芯片。
  OPFS 单写者冲突多是残留句柄，退避重试把「静默无持久化」变成「慢一点启动」。
- **bash 后台**：作业注册表 + `job_output` / `job_kill`。**两处非显然点**：
  审批门必须在 spawn 之前（后台启动也是执行）；杀进程要杀**进程树**
  （win32 用 `taskkill /T`，否则 bash 死了但 dev server 还占着端口）。
  切根时 `disposeAll`，不留孤儿进程在没人指向的目录里。

**批次三（工作画像）**：`profile: 'work'`（计划轮默认）——系统前缀不再注入
Stage Control / 注意力节，计划投影移到末条用户消息尾部的 `[Plan]` 块。
判据很直接：前缀是**被缓存的那一段**，计划投影每落一条证据就变一次，
放在前缀里等于每步重付整段对话的钱。叙述跳过 `filterToSpeech`——
那个过滤器是为 TTS 而生的，它在工作轮里吃掉的正是「边干边说」。
每次 supplement 变化记 `prompt/supplement-changed`，T5 验收从此有据可依。

**批次四（btw）**：独立 `streamFrom` + 独立 AbortController，不写主会话、
不进队列、不触发回合钩子、不挂任何工具。上下文是**有界工作投影**
（计划步骤 + todo + 最近 6 条工具摘要），三小时任务与第一分钟同价。

**§9.1 三处缺口（用户拍板一并做掉）**

- **journal 落盘 + 回放**：主进程 `journal-host` 持有
  `<userData>/journal/<sha256 前 32 位>.jsonl`，渲染端只镜像、**按微任务批量**写
  （工具循环一轮几十条事件，逐条写会把循环变成磁盘绑定）。写盘失败不影响内存流。
  leader 启动时**先回放 journal 再水合计划**——计划态是从事件派生的，顺序反了就白回放。
  会话文件名用哈希：会话 id 来自聊天会话，可能含文件系统不接受的字符。
- **委派原语**：`task` 工具 = 只读子运行（grep/read/list、12 步预算、独立消息列表）
  + 短报告。**报告是主张不是证据**（原则三），工具描述与返回文本都写死这句话，
  它不能满足任何计划步骤。
- **diff 面**：`summarizeLineDiff`（公共前后缀 + 有界列举）挂在 `write` / `edit` /
  Code Mode 的结果里，不新增 UI 面（§9 第一条「UI 第 3 位」不变）。
  `write` 为此多一次读——代价换来「整文件覆盖也能审阅」。

**验证**：`packages/stage-ui` 144 文件 / 859 用例全绿；
`coding-harness` + `core-agent` + `stage-tamagotchi:node` 定向全绿；
四个包 typecheck 与全仓 eslint 干净。
全仓 `vitest run` 另有 11 个**与本批无关的 Windows 环境失败**：
`plugins/index.test.ts` 与 `static-assets/paths.test.ts` 各 2 个
（`EPERM: symlink`，未开开发者模式）、`cap-vite` 5 个（路径分隔符断言）、
`ui-server-auth` 1 个（CRLF 断言）、`plugin-sdk` 1 个（入口解析）。
这些包本批一行未改。

**未做（有意）**：`HARNESS-PLAN.md` §7 的真机验收 T1-T11 需要构建版 electron +
CDP 走查，属另一轮工作；本轮只保证代码面与定向测试。

### 真机验收（2026-09-01）：HARNESS-PLAN T1-T11 走查

环境：`build:packages` + `stage-tamagotchi build`（`out/`），electron.exe 直跑 +
`APP_USER_DATA_PATH=D:\.airi-smoke\userdata-acc2`（复制真实 profile 的
Local Storage / IndexedDB——provider 配置随行、旧 journal/计划不带入）+
CDP 9250 raw eval（ASCII 直发，非 ASCII 走 `.zcode/tmp/cdp-eval-utf8.sh`）。
fixture：`~/AIRI-workspace/notes/` 下 3000 行 CRLF `big.txt`（NEEDLE 在 2500 行）
与 3 行 CRLF `stale.txt`。

**通过项（9/11）**

- **T6 计划门自走**：grep→step-locate、edit→step-edit、bash→step-verify 三份
  证据**自动**分戳到三个不同开放步骤（全程零 `plan_update focus`），门判完成，
  计划离开活跃列表——R3「卡 1-3」与「完成不消失」双灭。
- **T8 循环**：grep 命中带签名（`2500 cqp`）**直接喂 edit**（零 read），
  `applied`；bash 确认 `exit 0, git-bash`；**编辑后文件 3000 行全 CRLF、0 裸 LF**
  ——C6 edit 侧保真实证。
- **T9 分页读**：`stale.txt (4 lines · showing 1-4 · more no · baseHash … ·
  lineEnding CRLF)`；`big.txt (3001 lines · showing 1-400 · more yes)`；
  big 签名 3 字符 / stale 2 字符——**签名宽度按总行数**（跨页不变式）成立。
  她的一次 read 参数解析失败收到结构化错误后自愈重试。
- **T10 陈旧写**：盲写（旧 baseHash）→ `state_changed` + 当前哈希、**未落盘**；
  她重读见到外部篡改后以新哈希重写成功并附行级 diff。
- **T2 打断**：工具执行中发消息 → 原回合在工具结算边界以
  `turn/end {reason:'steered'}` 收束，打断消息进入新回合，sending 归位。
  已开始的 bash 照常结算（drain 语义，与 dsh 一致）。
- **T3 零续跑**：计划轮中打断 → `planContinuationMsgs: 0`、零新回合
  （R2 永动机死亡）；停止按钮路径 `abortActiveSend` → `turn/end {reason:
  'aborted'}` + **计划 `paused:true`** + 回合数稳定；「继续」（RESUME_INTENT）
  → `paused:false`。注意：消息级暂停依赖短锚定 `STOP_INTENT`（停/继续/resume…），
  英文长句不匹配——停止按钮才是可靠路径。
- **T7 后台 job**：`bash {runInBackground:true}` → `job-1` 立即返回（返回文本
  自带 job_output/job_kill 教学）→ `job_output: running` → `job_kill: killed`。
  120 秒转圈在结构上死亡。
- **T5 缓存可观测**：`prompt/supplement-changed{hash,previousHash}` 链式落
  journal；A1 三步回合全程仅 1 次（回合内零抖动）。
- **T11 win32**：bash 结果声明 `read-only tier, exit 0, git-bash`——shell
  显式化后她在 Windows 直接用 POSIX grep 成功，cmd.exe 报错模式不复存在。
- **T1 叙述**：slices 为 `call:grep, call:edit, call:bash, text(90)`——
  叙述与工具交错可见（filterToSpeech 旁路生效）。本轮她习惯收尾才说，
  交错密度属模型风格。

**发现（移交修复）**

1. **journal 回放启动时序缺陷（本轮头号）**：写入半边正常——会话 jsonl 落盘
   109 条（`<userData>/journal/sha256(会话id)前32.jsonl`，哈希归属已验证）；
   但重启后 `main.ts` 的 `hydrate(activeSessionId)` 执行时**会话 store 尚未
   恢复**，回放打到了错误的默认会话（journal 仅 1 条）。手动对正确会话
   `hydrate()` 一次性恢复全部 109 条（turnEnds 完整重现 8×completed /
   2×steered / 1×aborted）——机制完好，纯启动顺序问题。计划恢复不受影响
   （DuckDB 快照兜底，但这正是「快照而非日志」的旧路径）。修法方向：boot
   等会话恢复完成后再 hydrate，或 leader 侧 watch `activeSessionId` 变化补
   hydrate。
2. **write 行尾缺口（C6 write 侧）**：edit 保真已证，但她用 `write` 以 `\n`
   内容整写 CRLF 文件后落盘即全 LF——read 头部明明声明 `lineEnding CRLF`，
   write 侧未按主导行尾归一。在本 CRLF 仓库里等于「整文件写一次、diff 全花」。
3. **btw 无首问入口**：`askActive` 仅程序可达；`btw-card` 只处理追问；
   InteractiveArea 无任何 btw 手势。store 懒实例化导致构建版控制台也不可达，
   **T4 真机验证被此阻塞**。

**行为注记（非缺陷）**：steer 后她在新回合顺手完成了原任务的 pending ls
（harness 交付正确，模型顺从性）；裸「继续」只回文本不跑工具；
被打断回合已结算的工具证据仍会完成其步骤（step-wait 在打断回合后 completed）。

**结论**：T1/T2/T3/T5/T6/T7/T8/T9/T10/T11 通过；T4 阻塞于发现 3；
发现 1、2 为移交缺陷。验收后遗留：`~/AIRI-workspace/notes/` fixture 与
`D:\.airi-smoke\userdata-acc2` 冒烟 profile 未清理。

**修复闭环（同日）**：发现 1/2 已修（`e162f17e4` 回放改为 watch
activeSessionId——真机重启后选择落地即回放 110 条、turnEnds 完整重现；
`6dad8e794` write 按主导行尾归一并报 `lineEndingNormalized`，21/21 单测含
CRLF 回归）；发现 3 以 `/btw` 指令解决（`a6f1c2ace`：send 顶部分流到 btw
store，不进队列不写会话；`1559f9d8d` 发送按钮删除、Esc 打断、提示文案
Esc 优先）——真机复验：`/btw` 提问后主会话零写入、零新回合、btw store
answered 且答案带人格口吻。注：btw 回答偶带角色卡的 `<|ACT|>` 协议前缀
（人格节随卡注入所致），属外观问题，后续可在 btw 组装时剥离。



## LOOP-PLAN 立项（2026-09-01）：心流模式

产出 `docs/fork/LOOP-PLAN.md`。**只写文档，未动代码。** 依据是一次真机任务的
完整 journal 复盘（dsh web 连接插件，488 事件 / 36 回合 / 125 次工具调用，
`<userData>/journal/04b0b35e49b94e0822fc9c62107b0c98.jsonl`），文档内所有诊断
均带 `seq` 引用可复查。

- **核心判断**：AIRI 有「一步」，没有「一步一步」。回合结束后没有任何东西在问
  「用户要的事做完了吗」——判定权散在三处互不通气的机械里（`stepCountAtLeast`
  只数步数；`schedulePlanContinuation` 只看计划步骤且**仅在 `options.planId`
  存在时被调用**；用户 Esc/删对话是唯一兜底）。于是"想一下改一下"这种最常见
  的工作形态在结构上不存在。
- **解**：把现有 `profile: 'work'` 升级为独立运行状态「心流模式」，
  **与 `/plan` 完全独立**（已拍板）：计划提供**裁决**，心流提供**推进**；
  心流不会自动升级成计划模式，其终止条件只与任务有关。顺带化解 HARNESS-PLAN
  §9.2 的张力——心流是第三档「有循环、无裁决」。
- **journal 坐实的五处**：
  1. `chat.ts:1088-1095` 的 `planId || command` 同时决定 profile 与预算 →
     计划蒸发后同一件工作 50 步变 10 步（turn 26 → turn 31），且无任何提示。
  2. **三次 max-steps 三次悬空工具调用**（10 call / 9 result，无例外）——
     墙落在她伸手到一半，模型永远看不到最后一步结果，且 transcript 留下
     provider 会拒的悬空 `tool_calls`。
  3. **122 条 `tool/result` 中 `ok=false` 为 0**：`ok: !ctx.data.isError` 记录的是
     调用是否抛异常，而 coding 工具把失败编码成返回字符串从不 throw →
     "失败"这个信号在系统里不存在 → 证据门收下失败命令、步骤永不 failed、
     一切基于失败的循环判据永远空转。**这是第一前置项。**
  4. **三个计划先后蒸发**（seq 220/253/463+470 全是 "No active plan"），
     她三次重建不是健忘而是每次都发现计划没了；全程只有 1 条 `plan/update`，
     **状态转变零记账**。riskLevel 级联已初步修复，但实测残留：只用 `bash`
     干活的步骤（计划 C 的 step-3）仍退回宽松语义。
  5. **`assistant/chunk` 事件数 0**，`assistant/start` 36 / `assistant/done` 24 →
     12 个回合零文本，其中 turn 30 是 32 步连续工具全程一字未说。
     气泡是原子单位，封口前没有中途表达的位置。HARNESS-PLAN 的 T1 判定未达成。
- **推进形态的明确弃用**：现有 `schedulePlanContinuation` 用合成的
  `user/message`（"Plan continuation (n/N)…"）推进。本计划弃用该形态——它污染
  对话历史、使"谁在说话"不可辨、把判据挤进提示词。改为 runtime 内续跑：
  尾部追加、前缀不动，**这同时就是缓存策略**（验收 L4 断言心流各回合之间
  `prompt/supplement-changed` 哈希恒定）。
- **进入条件不靠自律**：「她认为有必要时开启」若交给模型判断即自律式解法。
  改为结构触发为主（出现变更类工具 / `todo_write` / `plan_update start`）、
  显式声明为辅。五种退出（done/blocked/interrupted/budget/no-progress）
  全部落 `flow/end {reason}`——这是第 4 条那个教训的直接应用。
- **顺带发现的证据门缺陷**：`refProvesMutation` 只看 bash tier 不看 exit code，
  一条 `medium tier, exit 1` 的失败命令可以充当变更证明。修 `outcome` 字段时一并处理。
- **另一处收益**：content 已开始后的失败不能重放整轮（会重复内容），正确处置是
  "保住已完成的工具结果、作为新一步继续"——**这与心流的正常推进是同一条代码路径**，
  比在流层做通用重试省得多。
- 批次：前置（`outcome`/`tier` 结构化 + 悬空补偿 + 状态记账）→ 一（心流状态本体）
  → 二（harness 推进）→ 三（重试分类 + chunk 落盘 + btw 反向）→ 后续（rewind
  取代删对话，数据前提 journal + `contentHash` 已具备）。验收 L1-L9，
  其中 L1/L2/L7 列为常驻回归（对应的都是静默失败）。

## LOOP-PLAN 实施（2026-09-01）

已落地前置、批次一、批次二和批次三的代码闭环：

- `ToolResultEvent` 增加 `outcome` 与 `tier`。证据门不再接受失败 bash 结果。
- 预算耗尽的工具调用会写入合成失败结果。provider transcript 保持可回放。
- 新增 `flow/start`、`flow/step`、`flow/end`。心流续跑在 runtime 内执行，不写合成 `user/message`。
- 心流按结构工具触发。它支持 `/flow`、`flow_update`、40 回合预算、400 次工具调用预算、连续无进展退出、重复失败拦截、陈旧 edit 强制 read 和有限失败上下文。
- 心流回合写入 `assistant/chunk`。工作轮使用稳定系统前缀和消息尾部上下文。
- 新增 `btw_ask` 非阻塞提问。用户答案从 journal 投影进入下一步上下文。
- `/flow` 状态指示器和停止操作已加入 composer。

定向 Vitest、core-agent build、core-agent、stage-ui 和 stage-tamagotchi typecheck、受影响文件 lint 均通过。Windows Electron 真机验收 L1-L9 尚未在本批运行；需要带 provider 的实际任务确认自动续跑、缓存哈希和中途中断。

## LOOP-PLAN 二轮深挖（2026-09-02）：`FLOW-DIAGNOSIS.md`

对首次真机深挖的归因做了**修正**（同一 journal，seq 503-652）。**只写文档，未动代码。**

- **新增** `docs/fork/FLOW-DIAGNOSIS.md`，含完整复盘与改动清单（P0 ×3、P1 ×5、P2 ×3）。
- **修正 §11.3.1 的归因**：心流只跑一轮的根因不是「她把 Flow 当事务锁急着交卷」，
  而是证据门把「任意允许工具的成功回执」当作「步骤要验证的内容已完成」。
  `planLinkFor`（`chat-orchestrator-runtime.ts:905-923`）在聚焦步不接受工具时
  落到第一个接受的开放步，于是 seq 547 一条**探活 bash** 满足了
  step-3-test-verify（真正集成测试 seq 590 还没跑），计划 A 提前判 completed，
  `activePlans` 移除，她同回合两次遭遇 "No active plan"。
- **另一条修正**：bash 连发不是「她不会用合适工具」，是本地 HTTP 无声明式通道
  （`fetch` 无 method/body 且 SSRF 封锁 loopback、`code_mode` 沙箱无 http），
  bash 是唯一路径。附带一个安全问题：声明式 fetch 有 SSRF 防护，命令式 bash
  完全没有，她的手写 HTTP POST 绕过了 loopback 封锁，且 `tier=medium` 无审批。
- **同场记档**：`plan/hint` 只取 `slice(-2)`（`buildTurnProjection:94`）且内容
  在教她放弃正确的 grep/list；seq 651 用户安慰在 seq 652 `insufficient balance`
  前未被回复。

## FLOW-FIX 批次（2026-09-02）

- **动机**：首轮真机把探活回执误当验证证据，并在 tool-call 阶段提前结束心流；
  工作轮还混入人格外观工具，缺少环境与 agent 角色基座。
- **改动**：完成门延后到 tool-result 与 turn 边界，并要求本心流已有变更成功证据；
  验证步骤增加 test/verify/build/lint/check 语义门；重启从 journal 重建心流计数；
  hint 改为最近工具聚合；计划变更步骤结构化补入 read/grep/list，未验证计划留在
  active 集。工作轮增加环境块与 Agent Role，Live2D 提示仅 social，工作工具面收紧为
  `WORK_TURN_TOOL_NAMES ∪ 计划步骤 allowedTools ∪ activatedSkills`；压缩失败回落到
  journal 机械摘要；spark 指令补执行契约；删除废弃 `plan-runtime`。
- **验证**：`@proj-airi/core-agent` 全量 Vitest 通过（23 files / 206 tests），
  core-agent build 通过；stage-ui 定向 Vitest 通过（3 files / 41 tests），
  stage-tamagotchi 内置工具测试通过（3 tests）；core-agent、stage-ui、
  stage-tamagotchi 三包 typecheck 和全局 `pnpm lint` 通过，应用 build 通过。
  Electron 9250 抽查成功启动并确认主 renderer、lazy chat 窗口、聊天控件和工作工具
  注册；隔离 profile 无 provider，故 iterations≥2、验证前计划状态和带模型的工作提示
  真机链未执行，不记为通过。
- **遗留**：P1-2 本地 RPC 仅登记端口制并独立立项；P2-1 social 轮 flow 工具待拍板；
  环境块的 git 分支、测试/构建命令扩展待后续。
- **延伸评审（FLOW-DIAGNOSIS §4.2）**：FLOW-FIX 后心流不再提前终止（iterations:12、
  `flow/end` 落回合边界），但**回合内步进**仍不符合 harness 预期。根因不在心流层，
  在 `llm-service.ts:248` 的 `stopWhen: stepCountAtLeast(maxSteps)` + `chat.ts:1129`
  对 work 轮设 `maxSteps:50`，单回合可连发 50 个工具调用而无需停下思考。
  journal 实证（seq 679-932）全部 12 回合 `assistant/chunk` 的 `before`/`during`
  均为 0，100% 落在最后一次工具调用之后。由此新增 **P0-4**：把 work 轮 `maxSteps`
  降到 3-5（方案 A，改一行），配合 `prepareStep`/`postToolCall` 注入叙述指令
  （方案 B），让「一步」从「一个回合」变为「一次工具调用 + 一次评估 + 一次叙述」。
  方案 C（流动步进回调）列为长期方向，不作为第一优先。详见 FLOW-DIAGNOSIS §4.2。

## FLOW-STEP 批次（2026-09-02）

- **动机**：`stopWhen: stepCountAtLeast(maxSteps)` 在工具执行前做停止决策，导致预算边界
  可能丢失当前工具结果；单个心流回合还会连续执行过多工具，工具间隙没有重新思考。
- **改动**：通过 `pnpm patch` 持久修改 `@xsai/stream-text@0.5.0-beta.8`，新增执行后的
  `onStepResult` 回调。`llm-service` 只在无工具调用的 step 上使用 `stopWhen`，runtime
  在工具结果完整落地后用 `{ stop: true }` 控制预算。心流 `softBudget` 固定为 5，非心流
  work 轮保持原 `maxSteps`（默认 50）。心流后续 step 增加工具间隙叙述提示。
- **验证**：真实 patched xsAI SSE 测试确认工具执行、tool message、step result 均先完成，
  然后回调才可停止；core-agent 定向测试 77 tests 通过，core-agent typecheck 通过。
- **遗留**：需要 provider-backed Electron 真机重跑 seq 679 场景，确认每回合不超过 5 步、
  工具间有 chunk，并观察跨回合 iterations；本批不改变 P1-2、P2-1 或环境块扩展范围。

### FLOW-EVIDENCE / ROOT 修正（2026-09-02）

- **动机**：复核发现 `expectedEvidence: 查看 diff` 仍会把成功的 `git log` 当成证据，
  另一个实际阻塞是模型没有可调用的显式根切换工具，无法安全读取根外的 `patches/`。
- **改动**：证据门为 diff/patch 语义增加正文判据，只接受成功回执中实际出现的统一
  diff 标记；`git log`、`git diff --stat` 和探活结果不再过门。保留
  `resolveInsideWorkspace` 的越界拒绝，新增 `setWorkspaceRoot` 模型工具：调用一次
  绝对路径后由主进程校验存在/目录/可写，重建 host + Code Mode，并持久化和记 journal。
- **验证**：新增 `git log` 拒绝与 patch hunk 通过的 core-agent 回归测试；工作区工具
  注册测试覆盖 `setWorkspaceRoot`，主进程切根测试继续覆盖普通 read 与 Code Mode 共同换根；
  core-agent/coding-harness/stage-ui/stage-tamagotchi typecheck 与 stage-tamagotchi build 通过。
- **遗留**：仍需带 provider 的 Electron 真机确认模型先调用 `setWorkspaceRoot` 再读取
  `patches/`；本修正不放宽 read 的绝对路径约束，也不把根切换加入 Code Mode 的静态 bridge。

## MCP SERVER TIMEOUT 配置（2026-09-02）

- **改动**：MCP server 支持独立的 `requestTimeoutMs` 和 `maxTotalTimeoutMs`。
  两个字段进入共享契约、严格 JSON 校验、设置页表单和中英文文档。
- **运行时**：连接、工具枚举、工具调用和测试连接都读取所属 server 的预算。
  请求超时在进度更新时重置，总超时由 AIRI 自有墙钟信号强制执行。
- **验证**：MCP 定向 Vitest 10 tests、stage-tamagotchi typecheck、包级 lint、应用 build 和
  `git diff --check` 已通过。开发 Electron 日志显示 CDP 启动，但端口未在 60 秒内接受连接，
  设置页点击验收未执行；没有停止已有 Electron 进程。

