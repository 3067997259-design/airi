# 能力平台兼容台账（COMPAT）

本台账由 CP-0 建立，逐条记录 fork 对上游已发布契约的实现与偏离。每条一行，五列：

| 列 | 含义 |
| --- | --- |
| 上游章节 | 上游设计文档的章节或协议符号，尽量精确到标题 |
| 实现位置 | 本 fork 的文件与符号 |
| 偏离 | 无偏离写"遵循"；有偏离写一句话说明差异 |
| 理由 | 为什么偏离（无偏离可留空） |
| 状态 | `遵循` / `已实现` / `未接线` / `暂不实现` |

后续每批在此追加；CP-0 批次本身只登记下列条目。

## 预登记条目

| 上游章节 | 实现位置 | 偏离 | 理由 | 状态 |
| --- | --- | --- | --- | --- |
| `module:compatibility:*`（`plugin-protocol/src/types/events.ts:718-730`） | 无 | 不接线 | 全仓零发射零消费；复用会破坏上游未来启用时的语义（C0-D2） | 未接线 |
| `plugin-lifecycle.md`（`multi-transport.md:194` 引用） | 无 | 引用缺失 | 上游从未写出该文档；本 fork 不代写 | 暂不实现 |
| `ui.panel` / 独立 widget 作者 kit | 无 | 未实现 | 出现消费者前不做 | 暂不实现 |
| 跨平台宿主（web/pocket） | 无 | 未实现 | 无消费者 | 暂不实现 |
| 市场 / 注册表 / 安装更新通道 | 无 | 未实现 | 个人 fork 等价物是本地目录 + 哈希批准 | 暂不实现 |

## CP-0 实施条目

| 上游章节 | 实现位置 | 偏离 | 理由 | 状态 |
| --- | --- | --- | --- | --- |
| `cp-0-spec.md` §协商算法 规则2（fork 契约） | `packages/plugin-protocol/src/fork-protocol.ts`（`negotiateForkProtocol`） | 降级判定基准由实现定 | 规范未给 `downgraded` 的可执行判定：对方仅声明单版本，无法同时满足"只支持更高版本"与"存在共同版本"；按接收侧最高支持版本判定（`agreedVersion` < 接收侧最高支持版本 → `downgraded`），使 exact / downgraded / 抛错三者互斥且可测 | 已实现 |
| `ModuleAnnounceEvent`（`module:announce`，`plugin-protocol/src/types/events.ts:749`）接收侧 | 无 | 未接线 | 本仓库无 `module:announce` 的接收注册表：server-runtime 只处理 `extension:module:announce`，plugin-sdk 无对应注册面；不发明新注册表，留待 CP-3 两半球统一时接线 | 未接线 |
| `cp-0-spec.md` §协商结果的存放（fork 契约） | `packages/server-runtime/src/index.ts`（`extension:module:announce` 分支，挂 `RegisteredExtensionModule.forkState`）+ `packages/plugin-sdk/src/plugin-host/core.ts`（`ctx.modules.register`，挂 `ExtensionModuleContext.forkState`） | 遵循 |  | 已实现 |
| `cp-0-spec.md` §两条发送路径（fork 契约） | `packages/server-sdk/src/client.ts`（`prepareProtocolConnection`）+ `packages/server-sdk/src/extension-peer.ts`（`announceModule`） | 遵循 |  | 已实现 |
| `cp-0-spec.md` §本地等价路径（fork 契约） | `packages/plugin-sdk/src/extension/shared.ts`（`RegisterExtensionModuleInput.forkProtocol`） | 遵循 |  | 已实现 |

## EP-0 实施条目

| 上游章节 | 实现位置 | 偏离 | 理由 | 状态 |
| --- | --- | --- | --- | --- |
| SELF-AUTHORED-TOOLS-DESIGN §1.3（证据 provenance） | `packages/core-agent/src/authority/provenance.ts` + `contract.ts`（`ToolEvidenceAuthor`、三新 source 41/44/46） | 加法扩展：7 个证据桶、`game_checked` 与 `untrusted_plugin` 新桶 | EP-0 spec E0-D3；游戏回执与未批准插件回执必须有不同的权威级别，且 `game_adapter_checked_result` 可满足验证门 | 已实现 |
| journal `ToolResultOutcome`（`core-agent/src/journal/types.ts`） | 同上 | 加法成员 `revoked` | EP-0 spec E0-D4；撤销后的迟到回执无效，不得当成功也不得记为失败证据 | 已实现 |
| journal `ToolResultEvent`（`core-agent/src/journal/types.ts`） | `surface` 可选字段 + runtime `deps.getToolSurface` | 加法字段 | EP-0 spec 不变量 1；包装来源随回执可见，证据作者不变 | 已实现 |
| `chat.ts getToolEvidenceAuthor`（按工具名前缀猜） | `packages/stage-ui/src/stores/chat.ts`（按 `ToolRegistration` 判定，包装链最深处取权威） | 未登记工具由 `builtin` 兜底改为 `untrusted_plugin` | EP-0 spec D5；改变包装方式不得提升信任等级 | 已实现 |
## CP-2 实施条目

| 上游章节 | 实现位置 | 偏离 | 理由 | 状态 |
| --- | --- | --- | --- | --- |
| `multi-transport.md` Next Steps #3（deny-by-default grant/revoke） | `apps/stage-tamagotchi/src/main/services/airi/plugins/permissions/store.ts` + `host/index.ts`（`permissionResolver`） | 遵循；批准持久化（`extensions/permissions.json`）为 fork 加法 | 上游只有 resolver 契约、无持久化；CP-2 用哈希绑定批准补上"用户批准后才生效"的缺省拒绝 | 已实现 |
| `multi-transport.md:139`（unauthorized invoke / revoke 测试） | 同上 + `plugins/index.test.ts`（`denies manifest permissions until the user approves the manifest digest`） | 遵循 | 覆盖未批准拒绝与批准后放行 | 已实现 |
| `runtimes/node` 工厂 `node-worker` 分支 | `runtimes/node/index.ts`（`createNodeWorkerContext`）+ `runtimes/node/worker/{context,bootstrap,protocol}.ts` + app `NodeWorkerExtensionLoader` | 遵循 | 用 Eventa worker-threads 适配器填充分支；worker 侧 bootstrap 为 fork 文件；setup 期间宿主 API 未代理（增量 2 范围） | 已实现 |
| `runtimes/node/index.ts` 导出面 | `packages/plugin-sdk/src/plugin-host/runtimes/node/index.ts`（`export * from '../shared'`） | 加法导出 | `./plugin-host` 的 `node` export 条件指向该入口，缺 shared services 时 `PermissionService` 仅类型可见；补导出以复用 SDK 求交语义 | 已实现 |
| ExtensionHostOptions（宿主构造选项） | packages/plugin-sdk/src/plugin-host/shared/{loader.ts,types.ts} + core.ts | 加法字段 loader?（缺省 FileSystemLoader） | CP-2 需要在宿主级替换加载策略以支持 worker 隔离，避免改 host 核心 | 已实现 |
| plugin-sdk 包导出面 | packages/plugin-sdk/package.json（./plugin-host/worker、./plugin-host/worker-bootstrap）+ tsdown 入口 | 加法子路径导出 | undler 类型解析不应用嵌套
ode 条件；worker 专用导出需要显式子路径（types+default） | 已实现 |
| 本地插件加载（`FileSystemLoader.loadExtensionFor`） | `packages/plugin-sdk/src/plugin-host/runtimes/node/loaders/fs.ts`（isAbsolute → pathToFileURL + NOTICE） | 缺陷修复（fork） | Windows 绝对路径直接被 `import()` 时被默认 ESM loader 拒绝（`Only URLs with a scheme in: file, data, node, and electron are supported`），桌面上磁盘扩展无法加载；上游未处理。真机 CP-2 发现 | 已实现 |
