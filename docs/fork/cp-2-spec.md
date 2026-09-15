# CP-2 规范：权限强制（deny-by-default）与 node-worker 隔离

日期：2026-09-12。状态：规范定稿，实施未开始。上游：[插件平台野心线执行计划](./capability-platform-plan.md) CP-2 行与验收表、[EP-0 规范](./ep-0-spec.md)（批准记录）、[EP-2a 规范](./ep-2a-spec.md)（受限插件包，隔离消费者）。依赖：CP-0（契约纪律/COMPAT 台账）、CP-1（能力注册表，已完成）；消费者：EP-2 受限插件包（EP-2b 的 worker 试装使用本批的隔离原语）。

通过条件（计划原文）：**manifest 自授不再可能；未批准权限的工具调用被拒且错误可解释；worker 崩溃不波及宿主；撤销/重载在限时内终止在途调用；`runtimes/node` 工厂该分支不再 throw。**

## 现状与断层（研究结论）

- `ExtensionHost` 在桌面宿主以 `new ExtensionHost({ runtime: 'electron' })` 构造，**不传 `permissionResolver`**（`apps/stage-tamagotchi/src/main/services/airi/plugins/host/index.ts:236`）→ SDK 回退 `?? manifest.permissions`（`packages/plugin-sdk/src/plugin-host/core.ts:308`），即 manifest 自授。
- 解析器契约已存在且被消费：`ExtensionHostOptions.permissionResolver`（`runtimes/shared/types.ts:392`，`core.ts:303`）；批准记录**没有任何持久化**（`core.ts:269` 仅进程内 Map）；EP-2a 的 `packages.json` 是唯一的批准存盘先例（`main/services/airi/plugins/packages/store.ts`）。
- `node-worker` 传输是 throw 桩（`runtimes/node/index.ts:30`，`runtimes/web/index.ts:31`）；Eventa 已自带 `@moeru/eventa/adapters/worker-threads`（宿主侧 `createContext(worker)`）与 `.../worker`（worker 侧 `createContext()`）。
- `FileSystemLoader.loadExtensionFor` 在主进程内 `await import(entrypoint)`（`runtimes/node/loaders/fs.ts:74`），`ExtensionHost` 直接 `new FileSystemLoader()`（`core.ts:276`）——没有加载器注入口。
- 权限拒绝已有可解释路径：`PermissionDeniedError`（`core.ts:76-88`，模块私有）与 kit 路径 `KitUnavailableError('permission-denied')`（`core.ts:502`）；无 revoke 方法、无在途调用登记（`ExtensionSessionService` 只是 id 注册表）。

## 一、权限强制（deny-by-default）

### D1 批准存盘（main）

新文件 `<userData>/extensions/permissions.json`（原子写、进程内串行，复用 `packages/store.ts` 的写法）：

```ts
interface ExtensionPermissionGrant {
  extensionId: string
  /** 用户批准的面（已按批准时请求求交），grant 与 declaration 同形。 */
  grant: ModulePermissionDeclaration
  approvedBy: 'user'
  approvedAt: number
  /** 批准绑定的 manifest 内容哈希；manifest 变化后旧批准不再覆盖新请求。 */
  manifestDigest: string
}

interface ExtensionsPermissionsFileV1 {
  version: 1
  grants: ExtensionPermissionGrant[]
}
```

- `manifestDigest` = 规范化 `extension.airi.json`（键排序、UTF-8、sha256）；写入时与批准面一起落盘，加载时重算比对。
- 损坏文件抛类型化错误，不静默重置（与 EP-2a 同一纪律）。

### D2 解析器接线（app）

`setupExtensionHost` / host 构造改为：

```text
new ExtensionHost({
  runtime: 'electron',
  permissionResolver: ({ identity, manifest, requested }) => permissionGrants.resolve(identity.id, manifest, requested),
})
```

规则（deny-by-default）：

1. **无记录 → 返回空 grant**（五个 area 全空数组），绝不回退 manifest 声明。
2. **有记录**：`grant ∩ requested`（`PermissionService.intersectGrant` 语义，SDK 已实现），请求增量未批准的部分不生效。
3. **digest 不符**：视为未批准（记录保留供审阅面展示，返回空 grant 并记原因 `manifest_changed`）。
4. 结果写入 SDK 的 `persistedPermissionGrants`（现有行为）；重启后由本 store 持久恢复。

### D3 批准面（最小可用）

- 新 main 服务 `permissions/host.ts` + eventa 契约 `airi:permissions:*`：`list`（发现的扩展 + 请求面 + 现有批准 + 状态）、`approve({ extensionId, requested, manifestDigest })`、`revoke({ extensionId })`。
- 批准动作由用户显式触发，绑定 `manifestDigest`（复用 EP-2a 摘要绑定纪律）。批准后扩展需重启/重载会话才生效（新版 resolver 在下一个 session 读取）。
- UI：devtools `plugin-host.vue` 增加"权限"分区（列出请求、批准/撤销按钮）作为 v1 入口形态；设置页专项后续再排。
- 工具调用拒绝：走既有 `assertExtensionPermission`/kit 路径；错误可解释（`PermissionDeniedError` 信息或 `KitUnavailableError('permission-denied')`）。宿主侧把 `permission-denied` 原因的失败转成插件工具调用的结构化错误返回（renderer 的 `revoked`/错误桶不需改）。

### D4 撤销

- `revoke(extensionId)` 删除记录并使当前会话失效：调用 `host.stop(extensionId)`（若已加载），后续新 session 解析为空 grant。
- 在途工具调用跟随现有注册撤销语义（renderer 侧 abort → main `cancelPluginTool`；见 `plugins/index.ts:117-136`）。

## 二、node-worker 隔离

### D5 传输分支（SDK）

`createPluginContext` 的 `node-worker` 分支落地（不再是 throw）：

```text
// runtimes/node/index.ts
case 'node-worker':
  return createWorkerThreadContext(transport.worker).context
```

使用 `@moeru/eventa/adapters/worker-threads` 的 `createContext(worker)`。新增 fork 文件承载（`runtimes/node/worker/context.ts`），`core.ts` 不改。

### D6 worker 启动与代理加载（SDK 增量 + app 原语）

- 新增 fork 文件 `runtimes/node/worker/bootstrap.ts`（worker 侧入口，供 `new Worker(new URL(...), { workerData })` 使用）：创建 worker 侧 Eventa context，按 `workerData.entrypoint` 导入扩展入口，执行 `setup(ctx)`，并回应宿主的 `initialize`/`dispose` 控制消息；未捕获异常与 `unhandledRejection` 上报结构化错误后退出。
- `ExtensionHostOptions` 增加可选 `loader?: ExtensionLoader`（fork 加法字段，缺省 = 现行 `FileSystemLoader`，COMPAT 台账登记）。新增 `NodeWorkerExtensionLoader`：
  - 解析入口点（复用 `FileSystemLoader.resolveEntrypointFor`）；
  - 启动 worker（`startupTimeoutMs` 默认 5s，超时判失败并终止）；
  - 宿主侧返回一个 **Extension 代理**：`setup(ctx)` 通过 worker 传输完成握手与就绪；
  - `dispose()` 终止 worker（见 D7）。
- 宿主现有会话/绑定/kit 流程保持不变；worker 是加载器实现细节。**首次交付只覆盖**：扩展 `setup` 生命周期、宿主→worker 的 initialize/dispose、崩溃探测；绑定/kits 的远程往返沿用同一 context 的 invoke 通道，按消费者实际使用面逐步补齐（EP-2b 的试装只用 initialize/结果/终止）。

### D7 生命周期与有界终止

- **崩溃隔离**：worker `exit`/`error` → 该 session 进入 `degraded`（CP-1 相位）并停止；宿主进程与其它扩展不受影响；错误进 journal/日志。
- **停止/重载/撤销**：`host.stop()`/`reload()`/`revoke` 触发 loader `dispose()`：先拒绝新 invoke，再给在途 invoke 一个 `stopGraceMs`（默认 2s）窗口；到期 `worker.terminate()`，在途调用以类型化 `WorkerTerminatedError` 返回（不悬挂）。
- **启动超时**：`startupTimeoutMs` 内未完成握手 → 终止并报 `worker_start_timeout`。
- 死循环：worker 线程 100% CPU 不影响宿主事件循环；终止路径与 D7 相同（存在性验证：宿主仍能响应并完成 terminate）。

### D8 消费者接线

- app：`setupExtensionHost` 构造 host 时按扩展清单选择加载器（本地 `extensions/v1` 目录仍默认 `FileSystemLoader`；声明 `runtime: 'node'` + `entrypoints.node` 的扩展可用 worker 加载器，开关由 devtools/设置页显式选择）。
- EP-2b：包试装进程复用同一 worker 原语（启动/超时/终止），本批只交付原语与验收，不实现 EP-2b 的试装流水线。

## 三、增量

| 增量 | 内容 | 验收 |
| --- | --- | --- |
| 1 | D1–D4：批准存盘 + 解析器接线 + 最小批准面 + 撤销 | 无批准时 kit/模块 API 拒绝且错误可解释；批准后同一调用通过；manifest 改动后旧批准失效；revoke 后新会话拒绝 |
| 2 | D5–D6：node-worker 传输 + worker 加载器与代理 + 崩溃/超时 | `createPluginContext({kind:'node-worker'})` 不再 throw；worker 扩展 setup 往返成功；worker 崩溃宿主存活且会话 degraded |
| 3 | D7–D8：有界终止 + 消费者接线 | 停止/重载/撤销在 `stopGraceMs+ε` 内终止在途调用；死循环 worker 被终止；宿主保持响应 |

## 验收场景（映射计划验收表）

| 场景 | 操作 | 期望 |
| --- | --- | --- |
| deny-by-default | 加载声明权限的扩展且无批准记录 | 未批准权限不生效；kit/模块 API 拒绝；错误含 `permission-denied` 与请求 key/action |
| 批准与失效 | 审批记录 → 调用通过；改动 manifest 后重载 | 旧批准不再覆盖新请求（`manifest_changed`）；重新批准后恢复 |
| 撤销 | 已加载扩展调用中撤销 | 新调用被拒；在途调用按注册撤销语义终止（renderer abort/`revoked`） |
| worker 隔离 | 启动 worker 扩展；注入崩溃与死循环 | 宿主与其它扩展正常；崩溃 session `degraded`；死循环被限时终止 |
| 撤销/重载限时 | worker 扩展在途 invoke 时 stop/reload/revoke | 在 `stopGraceMs` 内收到 `WorkerTerminatedError`，无悬挂 promise |
| 工厂分支 | 调用 `createPluginContext({kind:'node-worker'})` | 返回 context，不 throw |

## 实现落点

- app main：`services/airi/plugins/permissions/{store.ts,host.ts,index.ts,store.test.ts}`、`shared/eventa/permissions.ts`、`plugins/index.ts`（resolver 接线）、`plugins/host/index.ts`（host 构造）、`main/index.ts`（injeca 接线、broadcast）。
- app renderer：devtools `plugin-host.vue` 权限分区、`stores/extensions-permissions.ts`（端口注入，若走设置页则同 EP-2a 模式）。
- SDK（fork 文件为主，`core.ts` 最小插入）：`runtimes/node/worker/{context.ts,bootstrap.ts}`、`runtimes/node/loaders/worker.ts`、`runtimes/node/index.ts`（node-worker 分支）、`shared/types.ts`（`loader?` 可选字段）。
- 测试：main 权限 store/host（持久化/求交/digest 失效/撤销）；SDK worker 分支（context 创建、握手、崩溃、超时、终止、在途拒绝）；app 边界（resolver 接线后加载扩展的拒绝/批准路径）。SDK dist 需重建（plugin-sdk 为工作区包）。
- 真机：devtools 探针 + 样例扩展（声明权限、故意崩溃、死循环三种变体）。

## 风险与回退

- **SDK 热点文件**：只增 fork 文件；`core.ts` 只加 loader 选项的读取（最小插入），COMPAT 台账记录 `loader?` 字段。
- **worker 绑定面**：首个交付不追求 kits/bindings 的完整远程 fidelity；若 EP-2b 需要更多通道，按消费者增量补，避免预做。
- **stopGrace 值**：默认 2s 可配；真实死循环/阻塞场景复测后再调。
- **批准面形态**：v1 用 devtools 入口；若误用频繁再升级到设置页专项（与 EP-2a 后续共享审阅模式）。

## 明确不做（本批）

- websocket 远程插件（CP-3）、控制/数据面（CP-4）。
- permission 同意 UI 的完整产品化（仅最小批准面）；`allowedExposePolicies` 的强制（无消费者）。
- 14 相位全量、市场/安装更新、跨平台宿主。

## 本轮交付与检查

本轮新增本规范并更新 MODS.md 索引；不改产品代码、不动 SDK、不跑真机。实施与真机记录在后续增量中补齐。

## 实施记录

### 增量 1（2026-09-12）：权限强制（deny-by-default）

- `main/services/airi/plugins/permissions/store.ts`：`extensions/permissions.json` 批准存盘（`ExtensionPermissionGrant{extensionId, grant, approvedBy:'user', approvedAt, manifestDigest}`，valibot 校验、原子替换写、进程内串行队列、损坏抛 `PermissionsFileInvalidError`）；`manifestDigestOf`（键排序规范化 + sha256）；`resolve` 三态：无记录 → 空 grant（`not_approved`）、digest 不符 → 空 grant（`manifest_changed`）、命中 → `PermissionService.intersectGrant(记录 grant, 请求)`。测试 7 例（默认拒绝、批准求交与跨实例持久、manifest 变更失效、撤销、并发批准、键序稳定哈希、损坏不重置）。
- host 接线：`setupExtensionHostServiceInternal` 用 `permissionResolver` 构造 `ExtensionHost`；**digest 绑定磁盘 manifest**（registry 条目），而非 `createManifestForLoad` 后的 cache-bust/绝对路径清单；直接 `host.start(manifest)` 的场景回退到传入 manifest。`ExtensionHostServiceInternal` 增 `listPermissionEntries/approvePermission/revokePermission`（批准/撤销后停止已加载会话）。
- IPC：`shared/eventa/permissions.ts`（`airi:permissions:list/approve/revoke` + `changed` 广播）；facade handlers；renderer `App.vue` 桥接（结构性边界 cast 一处，已注释）。
- UI：devtools `plugin-host.vue` 新增 Extension Permissions 分区（请求/批准 diff、Approve Requested、Revoke）与 `window.__AIRI_PERMISSIONS_SMOKE__` 探针；`stage-ui` 调试 store 扩展权限 state/actions。
- SDK（fork 加法）：`runtimes/node/index.ts` 补 `export * from '../shared'`。原因：`./plugin-host` 的 `node` export 条件解析到 node runtime 入口，而该入口缺 shared services 导出，`PermissionService` 在运行时不可用（类型走全量 barrel，类型检查不报）；dist 已重建。
- 测试适配：既有 host 测试改为在 `setupExtensionHost` 前按磁盘 manifest 播种批准（解析 schema 后整份批准，digest 才一致）；新增应用边界回归 `denies manifest permissions until the user approves the manifest digest (cp-2)`（未批准 `bindExtensionKitModule` 抛 `Permission denied`，批准后同一调用通过）。`plugins` 目录 60 例：58 通过，2 个 symlink EPERM 为 Windows 已知基线。
- 待续：增量 2（node-worker 传输 + 加载器）、增量 3（有界终止 + 消费者接线）、真机（devtools 批准面 + 拒绝/批准/撤销、worker 崩溃与限时终止）。

### 增量 2a（2026-09-12）：SDK worker 基座

- `ExtensionLoader` 接口（`plugin-host/shared/loader.ts`）+ `ExtensionHostOptions.loader?`（fork 加法字段，缺省 `FileSystemLoader`），`core.ts` 以 `options.loader ?? new FileSystemLoader()` 接线。
- `createPluginContext` 的 `node-worker` 分支落地：`runtimes/node/worker/context.ts` 用 Eventa `@moeru/eventa/adapters/worker-threads` 建立宿主侧 context（不再 throw）。
- Worker 协议与 bootstrap：`runtimes/node/worker/protocol.ts`（`spawned/initialize/ready/failed/dispose`，fork 命名空间）、`worker/bootstrap.ts`（worker 侧 context、按 `workerData.entrypoint` 导入扩展、以"受限 setup ctx"（宿主 API 未代理时抛可解释错误）执行 `setup`、上报 ready/failed、处理 dispose 与未捕获异常）；`coerceExtensionFromModule` 改为导出以复用。
- 打包与解析：tsdown 增 `worker/bootstrap.ts` 入口（dist 产出 `plugin-host/runtimes/node/worker/bootstrap.mjs`）；`package.json` 增 `./plugin-host/worker-bootstrap` 导出；node runtime 入口导出 `worker/context` 与 `worker/protocol`；dist 已重建。
- 测试：`runtimes/node/index.test.ts` 2 例（in-memory + node-worker 分支不再 throw；其余传输仍显式报错）；SDK 全量 91/92（1 个路径分隔符为 Windows 已知基线）。

### 增量 2b（2026-09-12）：app 侧 worker 加载器与宿主接线

- `main/services/airi/plugins/host/worker-loader.ts`：`NodeWorkerExtensionLoader`（实现 `ExtensionLoader`）——`runtime: 'node'` 时 spawn SDK bootstrap 并握手（`ready`/`failed`/`error`/`exit`/启动超时 5s），其余 runtime 委托 `FileSystemLoader`；`disposeExtension` 先发 `dispose`，宽限 2s 后 `terminate()`；post-ready 崩溃经 `onCrash` 上报且宿主继续运行。测试 7 例（ready+dispose、failed、pre-ready 崩溃、挂起超时、忽略 dispose 的强制终止、post-ready 崩溃上报、非 node runtime 委托）。实现中修两处：`exit` 先删会话导致崩溃被守卫吞掉；worker-threads 适配器以信封投递（payload 在 `event.body`）。
- 宿主接线：`host/index.ts` 以 `createRequire.resolve('@proj-airi/plugin-sdk/plugin-host/worker-bootstrap')` 定位 bootstrap，`new ExtensionHost({ loader })`；新增内部 `loadInWorker(extensionId)`（`host.start(..., { runtime: 'node' })`）、`stopLoadedExtensionById` 调 `disposeExtension`、`dispose()` 调 `disposeAll()`、`onCrash` 停止会话；`index.test.ts` 新增 worker 宿主集成测试（写 `.mjs` 扩展夹具 → `loadInWorker` → loaded；`unload` → 复位）。
- SDK 导出/打包补齐：新增 `./plugin-host/worker` 子路径（types+default，指向 `runtimes/node/worker/index`）与 `runtimes/node/worker/index.ts`；tsdown 增入口；node 入口补 `capability-registry` 导出与 barrel 对齐；`createManifestForLoad` 的 options 改为可选。原因：`bundler` 解析不应用嵌套 `node` 条件，worker 专用导出需要显式子路径；否则 app 侧类型找不到 `Extension`/协议/工厂。
- 验证：host 目录 68 例（66 通过，2 个 symlink EPERM 为 Windows 基线）；typecheck/eslint 0；SDK dist 已重建。
- 待续（增量 3）：撤销/重载限时终止在途调用（插件工具调用的 revoke-by-extension + worker terminate）；devtools "Load in worker" 入口与探针；真机三场景。

### 增量 3（2026-09-12）：在途调用限时终止与 worker 入口

- `main/services/airi/plugins/inflight.ts`：`InFlightCallRegistry`（按 requestId 登记 AbortController、按 owner 建索引；`get/settle/abortByOwner/abortAll/size`）+ 3 例单测（登记与 settle、owner 级限时中止且不影响他人、关机全中止）。
- 接线：`electronPluginInvokeTool` 用 registry 登记/结算；`electronPluginCancelTool` 按 requestId 取控制器；`electronPluginUnload`、`electronPluginSetEnabled(false)`、`extensionPermissionsRevoke` 调 `abortByOwner`（在途调用立即以既有 `revoked`/abort 语义收敛）；`before-quit` 调 `abortAll`。worker 路径的终止复用增量 2 的 `disposeExtension`（dispose 请求 + 2s 宽限 + `terminate()`）。
- devtools worker 入口：契约 `electronPluginLoadInWorker` + facade handler（load + toolsChanged 广播）；`App.vue` 桥；调试 store 增 `loadInWorker`；`plugin-host.vue` 每个含 `entrypoints.node` 的扩展显示 "Load in Worker" 按钮；新增 `window.__AIRI_PLUGIN_SMOKE__`（`registry/load/loadInWorker/unload`）。
- 验证：插件目录 69/71（2 个 symlink EPERM 为 Windows 基线）；typecheck（app/stage-ui/stage-pages）与 eslint 0。
- 待跑（真机）：deny-by-default（无批准拒绝 → 批准后通过）、worker 崩溃隔离（宿主存活、会话停止）、限时终止（unload 中断在途调用 / 强制 terminate 死循环 worker）。需 `build` + 重启 + 夹具扩展（含 `entrypoints.node`）。

## 真机验收（2026-09-12）

结果：**deny-by-default PASS、worker 隔离 PASS、限时终止 PASS**。记录见 [evidence/cp-2/live-acceptance-20260912.md](./evidence/cp-2/live-acceptance-20260912.md)。

- 夹具 `cp2-permission-probe`：未批准加载 → `Kit kit.gamelet is unavailable: permission-denied.`；批准后加载成功；撤销后再次拒绝。
- worker 夹具四态：ready 加载/卸载正常；setup 抛错 → 拒绝且宿主存活；死循环 → 5s 启动超时（实测 ~7s）后拒绝且宿主存活；ready 后崩溃 → 会话被停止、宿主存活。
- **实机发现并修复上游缺陷**：`FileSystemLoader.loadExtensionFor` 直接 `import()` Windows 绝对路径（`C:\...`）被默认 ESM loader 拒绝（`Only URLs with a scheme in: file, data, node, and electron are supported`），桌面上任何磁盘扩展都无法加载；fork 补 `isAbsolute → pathToFileURL` 转换（NOTICE + 移除条件）并加 `fs.test.ts` 回归。已记 COMPAT。
- 限制：端到端"慢插件工具调用 → unload/撤销中止"的真机夹具未跑（由 `inflight.test.ts` 3 例、worker-loader forced-terminate 测试与接线覆盖）；等 EP-2b 的真实 worker 工具消费再补。
