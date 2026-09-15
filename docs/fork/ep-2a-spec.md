# EP-2a 规范：声明式插件包（打包 / 整包批准 / 隔离试装 / 激活 / 回退 / 备份）

日期：2026-09-12。状态：规范定稿，实施未开始。上游：[扩展与自开发能力执行计划](./extension-execution-plan.md) 的 D3/D4 与 EP-2a 行、[勘探文档](./extension-and-minecraft-exploration.md) 接线边界、[ep-0-spec](./ep-0-spec.md) 注册记录与在途撤销、[SG-1](./skill-growth-plan.md) 内容哈希批准、[MD-2](./maintainability-and-data-plan.md) 备份契约。

EP-2a 让 AIRI 的"能力包"成为**可批准、可回退、可备份**的持久对象。首批只支持声明式包：无任意 Node 入口；包内的可执行体是**已审阅技能源码**，执行仍走 coding-host 沙箱。worker 隔离（EP-2b）与权限强制（CP-2）不在本批。

## 包格式

一个包 = 目录（或 ZIP 解包后的目录），每个版本一个目录：

```text
<UserData>/extensions/packages/<packageId>/<version>/
  extension.airi.json        # 上游 manifest v1：仅身份。entrypoints 必须为空/缺省
  airi-package.json          # fork 包描述（本规范新增；manifest schema 会剥离未知字段，故独立文件）
  skills/<toolId>/           # 已审阅技能产物副本：source.mjs、meta.json、selftest.mjs
  assets/                    # UI 资源（gamelet/widget 的 html/json），白名单挂载
  data/                      # 插件私有数据（不参与摘要；随备份导出）
```

`airi-package.json`（v1）字段：

```ts
interface AiriPackageDescriptorV1 {
  packageVersion: 1
  id: string
  version: string
  tools: Array<{
    name: string // 模型面工具名；不得与现役注册重名
    description: string
    parameters: Record<string, unknown> // provider 兼容 JSON Schema
    skill: { toolId: string, contentHash: string } // 执行体 = 该技能源码
  }>
  ui?: {
    gamelets?: Array<{ moduleId: string, kitId: string, entryAsset: string, config?: Record<string, unknown> }>
    widgets?: Array<{ moduleId: string, kitId: string, entryAsset: string, config?: Record<string, unknown> }>
  }
  dependencies?: {
    skills?: Array<{ toolId: string, contentHash: string }> // 锁定包内技能的实际哈希
  }
}
```

- **禁止任意 Node 入口**：包目录内 `extension.airi.json` 的 `entrypoints` 若含任何路径，试装以 `PackageEntrypointForbiddenError` 拒绝；文件加载器（`FileSystemLoader.loadExtensionFor`）不参与包加载。
- **manifest permissions 只是声明**：不得当作人工审批凭据；强制由 CP-2 的 `permissionResolver` 完成。
- **技能来源**：包内技能必须与已审阅技能一致（`reviewedHash === contentHash`，且与 `dependencies.skills` 锁定一致），否则试装失败并给可解释原因。

## 整包摘要与批准

- **摘要（digest）**：`sha256` over 按路径排序的 `{ path, sha256 }` 列表，覆盖 `extension.airi.json`、`airi-package.json`、`skills/**`、`assets/**`；排除 `data/**` 与日志。摘要写入包内 `airi-package.lock.json`（含文件清单），试装时重算比对。
- **批准记录**：`PackageApprovalRecord { packageId, version, digest, approvedBy: 'user', approvedAt, fileDigests }`，持久化于 `<UserData>/extensions/packages.json`（独立文件，不改 `ExtensionConfig` 语义）。
- **绑定规则**：批准只对 `(version, digest)` 生效；文件被替换后摘要变化，激活被拒（`PackageDigestMismatchError`），必须重新审阅。
- **审阅面**：审阅动作必须由用户执行，内容至少包含：描述符、工具与参数 schema、包内技能源码（复用技能审阅的源码查看）、与上一已批准版本的差异。v1 允许先做设置页内的最小审阅块（`机体模块 → 自造工具` 的"扩展包"分区）或 devtools 探针 + 用户点击；无论哪种，批准都必须绑定摘要（证据记录说明入口形态）。

## 生命周期

| 阶段 | 行为 | 不变量 |
| --- | --- | --- |
| 导入 | ZIP/目录落到 `packages/<id>/<version>/` 之外的 staging 目录，校验 schema 与文件清单 | 未校验内容不得进入正式目录 |
| 试装（隔离） | 解析描述符、校验技能哈希与依赖锁定、计算摘要；**不注册工具、不挂载 UI** | 试装失败不改动现役注册 |
| 批准 | 用户在审阅面确认，写入批准记录 | 批准 = 摘要绑定，不指向"当前最新" |
| 激活 | 校验摘要与批准一致 → 按 EP-0 登记工具（`ownerKind:'plugin'`，注册哈希 = 整包摘要）→ 白名单挂载 UI → 持久化启用状态 | 单写者：先撤旧注册再登记新注册，无重叠窗口 |
| 回退 | 切回上一已批准版本：撤下现役注册 → 登记旧版本 → 更新启用指针 | 回退后已知良好版本的工具立即可用 |
| 升级 | 新版本走完试装+批准后执行同样的撤/登两步 | 旧批准不被覆盖；新摘要未批准前不可激活 |
| 卸载 | 撤注册、卸 UI、删版本目录；默认保留 `data/`（用户可显式清除） | 撤销语义沿用 EP-0（在途终止、迟到回执 `revoked`） |
| 自动重载 | 仅开发态可用，不作为发布/更新机制 | 生产路径的更新只走上表 |

## 与 EP-0/EP-1 的接线

- 注册记录：`ownerKind: 'plugin'`，`ownerId: <packageId>@<version>`，`execution.chain: ['plugin:<packageId>@<digest>', 'skill:<toolId>@<skillHash>']`，`approvedContentHash = digest`。
- 证据判定：沿执行链最深处判定，包工具包装已审阅技能 → `reviewed_self_authored`（journal 记 `surface=plugin:<packageId>`）；链上哈希失效 → `untrusted_plugin`，新调用被拒，已入门的证据不追溯篡改。
- 重命名/换包装不改变证据输入（EP-0 D1）。

## 备份扩展（MD-2）

业务备份新增域 `packages`：

- 内容：**已批准版本**的完整目录、`packages.json` 批准记录、启用/激活指针、插件私有数据 `data/**`；未批准/试装中的版本不导出。
- 恢复语义：
  - 恢复后包默认 **未启用**（不自动注册工具、不挂载 UI、不自动启动外部副作用）；
  - 恢复时对每个包重算摘要并核对批准记录，摘要不符的版本降级为待审阅（不可直接启用）；
  - 启用操作是显式的用户动作。
- `data-backup` 的 `coverage` 列表增加 `packages`，导出/导入往返测试覆盖。

## 验收场景

| 场景 | 操作 | 期望 |
| --- | --- | --- |
| 整包批准 | 试装示例包 → 审阅 → 批准 → 激活 | 工具出现在工具面并绑定整包摘要；journal 记录 `surface` |
| 批准后替换 | 批准后替换包内任一文件再激活 | `PackageDigestMismatchError`；必须重新审阅 |
| 禁止 Node 入口 | 包 manifest 含 `entrypoints.electron` | 试装拒绝；工具面不受影响 |
| 技能哈希失效 | 包内技能源码与已审阅哈希不一致 | 试装失败（`dependency_mismatch`）；激活不可达 |
| 升级与回退 | v1 激活 → v2 试装+批准激活 → 回退 v1 | 两次切换均无重叠注册；回退后 v1 工具可用 |
| 备份恢复 | 导出 → 清空 → 导入 | 包目录/批准记录/启用状态恢复；默认未启用；摘要不符者降为待审阅 |
| 包装不提升信任 | 包工具调用已审阅技能 | 证据作者 `reviewed_self_authored`；skill 哈希破坏 → `untrusted_plugin` + 新调用被拒 |
| 卸载清理 | 卸载已激活包 | 工具消失、UI 卸载、在途终止、迟到回执 `revoked` |

## 实现落点与测试

- main `services/airi/plugins`：包服务（导入/试装/摘要/批准/激活/回退/卸载）、`packages.json` 持久化、eventa invoke 契约（`packages:*`）。
- `packages/plugin-sdk`：不新增代码路径；包加载**绕过** `FileSystemLoader`，仅复用 manifest schema 校验身份字段。
- 渲染端：`stores/packages.ts`（列表/审阅/批准/激活/回退动作，leader-owned）、设置页"自造工具"的扩展包分区 + i18n（en/zh-Hans）。
- `data-backup`：`packages` 域导出/导入与恢复默认禁用。
- 测试：摘要算法（排序/排除规则）、试装拒绝矩阵（entrypoints/哈希/摘要）、激活注册链与证据作者、回退无重叠、备份往返（含默认未启用）、`packages.json` 冲突保护。
- 真机：在 `example_models` 之外新建示例包与篡改变体，走完上表。

## 实施记录

### 增量 1（2026-09-12）：描述符 + 整包摘要 + 声明式校验

- `main/services/airi/plugins/packages/descriptor.ts`：`airi-package.json` 的 valibot schema（`AiriPackageDescriptorV1`，tools/skill 绑定/UI/依赖锁定）；摘要覆盖 `extension.airi.json`、`airi-package.json`、`skills/**`、`assets/**`，排除 `data/**`、日志与派生的 lock；`computePackageDigest`/`verifyPackageDigest`（路径排序 + 文件 sha256 列表再 sha256，结果与 mtime/写入顺序无关）；`assertDeclarativeManifest` 拒绝含 `entrypoints` 的 manifest；类型化错误（entrypoint 禁止 / 描述符非法 / 摘要不符）。
- 测试：`descriptor.test.ts` 4 例（覆盖面与顺序稳定、私有数据变更不影响摘要而受批面变更触发 `PackageDigestMismatchError`、entrypoints 拒绝、描述符解析/拒绝）；typecheck 与 eslint 0。

### 增量 2（2026-09-12）：包生命周期存储（导入/试装/批准/激活/回退/卸载）

- `main/services/airi/plugins/packages/types.ts`：`PackageApprovalRecord`（`(version, digest)` 绑定 + `fileDigests`）、`PackageActivation`（`enabled` 与版本选择分离）、`PackagesFileV1` + valibot schema、`PackageTrialResult`、`PackageListEntry`/`PackageVersionStatus`。
- `main/services/airi/plugins/packages/store.ts`：`PackageStore` 拥有 `<extensionsDir>/packages` 目录布局与 `<extensionsDir>/packages.json`。
  - 导入：`importFromDirectory` 复制到 `packages/.staging/<id>/<version>`（先校验 manifest v1 身份 + `airi-package.json` + 路径安全段）；`importFromArchive` 用 JSZip 解包（64 MiB / 1 万条目上限、拒绝非规范路径与逃逸路径）后走同一导入。
  - 试装：`trial` 校验 manifest 声明式（entrypoints 拒绝）+ 每个技能 `skills/<toolId>/source.mjs` 的 sha256 == 描述符绑定 == `dependencies.skills` 锁定 == 渲染端传入的已审阅哈希；计算整包摘要并写派生 `airi-package.lock.json`（算法标识 `sha256-of-sorted-file-digests-v1`）。不注册、不挂载。
  - 批准：`approve` 先重跑试装校验，再按 `(packageId, version)` upsert 批准记录并原子替换 `packages.json`。
  - 激活：先查批准记录，再对版本目录重算摘要比对；staging 版本 promote 到 installed 后**最后**提交 `active[packageId] = { version, digest, enabled: true }`；任何失败现役指针不变。
  - 回退：`rollback` 在“除现役外的已批准版本”中取最近（或显式 `toVersion`）且目录存在、摘要校验通过者；全部失败抛 `PackageRollbackUnavailableError` 且现役不变。
  - 卸载：删版本文件（默认保留 `data/**`，`purgeData` 才全删），随后撤销批准记录与激活指针；`deactivate` 只置 `enabled:false` 保留版本选择。
  - 持久化：`packages.json` 临时文件 + rename 原子替换；进程内串行队列保证并发批准不丢记录；文件损坏抛 `PackagesFileInvalidError`，不静默重置。
- 测试：`store.test.ts` 11 例（试装/批准/激活/列表、entrypoints 拒绝、`hash_mismatch`、`review_hash_mismatch`、批准后替换触发 `PackageDigestMismatchError` 且现役不变、升级+回退+篡改回退拒绝、未批准激活拒绝、回滚无候选拒绝、卸载默认保 `data/` 与 purge、并发批准不丢记录、ZIP 导入、坏 `packages.json`）；typecheck 与 eslint 0。

### 增量 3（2026-09-12）：eventa 契约、设置页审阅面、激活注册与证据链

- **契约与主进程接线**：`shared/eventa/packages.ts`（`airi:packages:*`：`list`/`active`/`pick-archive`/`pick-directory`/`import`/`trial`/`approve`/`activate`/`deactivate`/`rollback`/`uninstall` + `changed` 广播）；`main/services/airi/plugins/packages/host.ts`（`setupPackageHost`，原生文件选择 + 记录到渲染端摘要的映射），在 `main/index.ts` 以 injeca provider `modules:packages-host` 接线并注入 `eventaBroadcast`。每次生命周期变更广播 `extensionPackagesChanged`，followers 设置窗口操作后 leader 窗口据此刷新（包状态**不进同步 store**，避免整店提案抖动）。
- **试装/批准的信任输入**：`expectedSkills` 由渲染端以其当前 `reviewedSkills`（含 contentHash）随 invoke 传入，主进程只做字节校验；`PackageStore.activePackages()` 只返回启用中且摘要仍匹配批准的版本（被篡改的现役版本不会注册工具）。
- **渲染端**：`packages/stage-ui/src/stores/modules/packages.ts`（端口注入 `installPackageRuntimePort`/`hasPackageRuntimePort`，与 game-host 同模式；web 显示 desktop-only）；`apps/stage-tamagotchi/src/renderer/bridges/packages-install.ts`（Eventa 端口 + `extensionPackagesChanged` 订阅刷新）；`renderer/stores/packages-registration.ts`（仅 leader 注册；replace-first：同版本摘要变化或版本切换先撤旧工具再登记；工具 id `plugin:<pkg>@<version>:<name>`，`ownerKind:'plugin'`，执行链 `['plugin:<pkg>@<digest>', 'skill:<toolId>@<skillHash>']`，`approvedContentHash = 包摘要`，执行委托 `useSkillsReviewStore().executeReviewedSkill`）；leader boot 在技能队列恢复后 `refresh()` 并武装注册同步。
- **审阅面**：`packages/stage-ui/src/components/scenarios/settings/package-review-section.vue`（导入 ZIP/目录、逐版本试装/批准/启用/停用/回退/卸载 + purge 选项；试装块展示整包摘要、每个工具的 JSON Schema、技能绑定校验结果与文件数，并可内联查看已审阅技能源码）；挂在 `设置 → 机体模块 → 自造工具` 页底部；i18n en/zh-Hans。
- **证据链（包装不提升信任）**：`tools.ts` 的 `resolveEvidenceAuthor` 的 plugin 分支同时支持 `skill:<toolId>`（用注册哈希）与 EP-2a 的 `skill:<toolId>@<hash>`（用链上哈希）两种形式，最深处判定；技能源码与已审阅哈希不一致 → `untrusted_plugin`（执行时技能商店再验源码哈希并拒绝）。
- 测试：`store.test.ts` +1（`activePackages` 排除停用与被篡改版本，共 16 例）；`packages-registration.test.ts` 4 例（注册链与参数、同版本摘要变化替换、停用撤工具、follower 不注册）；`tools.test.ts` +1（包链哈希判定，共 15 例）。
- 待续（增量 4）：备份 `packages` 域与恢复默认禁用、真机走完验收表（示例包 + 篡改变体）。

### 增量 4（2026-09-12）：备份 `packages` 域与恢复语义

- **导出**：`PackageStore.exportApprovedFiles()` 只导出「已批准且摘要仍校验通过」的版本目录（含 `data/**`，排除 `logs/`）与批准注册表，路径直接用域布局 `packages/registry.json`、`packages/versions/<id>/<version>/...`；未批准/试装中/被篡改版本不进入备份。渲染端 `DataBackupPort` 新增可选 `readPackageEntries`（经新 invoke `airi:packages:export`），`exportSnapshot` 追加 `packages` 条目并把 `packages` 加入 `coverage`（端口缺席时不声明该域）。
- **服务与校验**：`data-backup.ts` 的域枚举与路径正则加入 `packages`；`compareDataBackups` 的域统计包含 `packages`；`data-restore.ts` 的 `checkRestoreData` 只接受 `packages/registry.json` 与 `packages/versions/<id>/<version>/<file>` 两种形状，其余包路径仍拒绝。
- **恢复**：`prepareRestoreProfile` 把包文件落到新 profile 的 `extensions/`（registry → `extensions/packages.json`，版本文件 → `extensions/packages/<id>/<version>/...`），随后调用 `PackageStore.prepareRestoredProfile()`：所有激活指针保留版本但置 `enabled:false`；逐条重算摘要核对批准，缺目录或摘要不符的版本**降级为待审阅**（移除批准记录，不可直接启用）；损坏的 registry 重命名为 `packages.json.corrupt-<ts>` 保留取证并以空注册表继续，损坏记录不会卡死整次恢复。
- 测试：`store.test.ts` +3（导出只含已批准且可校验版本、registry+data 齐备、篡改后该版本不再导出；恢复归一化置停用并保留可校验批准、篡改降级；损坏 registry 保留取证并重置）；`profiles.test.ts` +2（备份 ZIP 往返后 `extensions/` 布局正确、默认未启用、批准保留；字节不匹配时批准被降级）；`data-backup.test.ts` 既有用例全绿。typecheck/eslint 0。

### 真机验收（2026-09-12）

- 构建后以 preview 启动（CDP 9250），leader 窗口驱动。入口形态：设置页 `自造工具 → 扩展包` 分区 + `#/devtools/packages` 探针（原生对话框无法 headless 驱动，符合规范允许的 v1 二选一）。
- 通过场景：整包批准/激活与工具面注册（链、`approvedContentHash`、`reviewed_self_authored`）、执行委托沙箱回显、批准后替换触发 `PackageDigestMismatchError` 且现役不变、`entrypoints.electron` 拒绝、`hash_mismatch` 拒绝、升级无重叠、回退、卸载默认保留 `data/`、导出域路径与排除规则、技能源码破坏 → 执行被拒 + `untrusted_plugin`、源码还原后重审可恢复。
- **试装前修复**：技能绑定改用审阅哈希 `contentHashOf`（16 位 FNV）而非文件 sha256；否则真实已审阅技能必被 `hash_mismatch` 拒绝。
- 未覆盖：完整「导出 → 清空 → 隔离 profile 导入」应用级往返（需 relaunch）；导出/恢复语义由单测覆盖。夹具已全部清理。
- 记录：[evidence/ep-2a/live-acceptance-20260912.md](./evidence/ep-2a/live-acceptance-20260912.md)。

## 风险与回退

- **摘要口径**：文件排序/换行/权限位差异会导致摘要漂移；统一"路径排序 + 文件字节 sha256"，摘要算法与清单格式写入 `airi-package.lock.json` 版本号。
- **批准面成本**：审阅 UI 可先最小实现，但不得跳过"用户动作 + 摘要绑定"。
- **与 CP-2 的边界**：本批不强制权限；manifest 权限字段默认不生效，文档与 UI 明示，EP-2b/CP-2 接上。
- **回退失败**：上一版本目录或批准缺失时拒绝回退并保留现役版本，不留半切换状态。

## 明确不做（本批）

- 任意 Node 入口、worker 隔离（EP-2b）、权限强制（CP-2）、远程/市场分发。
- 自动更新（生产路径必须走人工批准）。

## 本轮交付与检查

本轮仅新增本规范文档并更新 MODS.md 索引。未改动产品代码、未创建示例包。
