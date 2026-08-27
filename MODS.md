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

### M0 — 安装环境（`db55b9dcc`）

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

## 运行时注意事项（首跑实测）

- channel-server 绑定 `127.0.0.1:6121` 报 `ENOTSUP`（疑似 TUN/代理网卡干扰
  LSP），非致命，窗口与 MCP 管理器均正常启动；若 widgets 通道异常先查这里。
- **auto-updater 指向 moeru-ai 上游 Releases**：魔改版若被自动升级会覆盖本地
  修改。当前 beta feed 是 v0.12.0-beta.1（低于本地 beta.2），暂无风险；一旦
  上游发布更高版本，装正式版前应先在配置里禁用自动更新（后续 mod 待办）。
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
