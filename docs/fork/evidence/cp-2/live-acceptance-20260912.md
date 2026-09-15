# CP-2 真机验收（2026-09-12）

结果：**deny-by-default PASS；worker 隔离 PASS；限时终止 PASS（worker 启动挂起按界终止 7s；在途调用中止路径由单测 + 接线覆盖）**。环境：CP-2 构建（`pnpm -F @proj-airi/stage-tamagotchi build` + preview，CDP 9250），leader 窗口经 devtools `#/devtools/plugin-host` 探针驱动；夹具扩展投放于 `<userData>/extensions/v1`，验收后已删除。不需要游戏客户端。

## 场景结果

| 场景 | 操作 | 实测 |
| --- | --- | --- |
| deny-by-default | 夹具 `cp2-permission-probe`（请求 `apis: kit.gamelet[invoke]` + `resources: ...kit.gamelet:bindings[write]`，setup 调 `ctx.kits.use(gameletKit)`）→ 未批准直接加载 | **拒绝**：`Kit kit.gamelet is unavailable: permission-denied.`（manifest 自授不再可能） |
| 批准后生效 | `__AIRI_PERMISSIONS_SMOKE__.approve('cp2-permission-probe')` → 再加载 | **通过**：加载成功（`loaded: true`）；批准面显示 `grant.apis = [kit.gamelet]` |
| 撤销后失效 | `revoke` → 再加载 | **拒绝**：再次 `permission-denied` |
| worker ready | `loadInWorker('cp2-worker-ready')`（`entrypoints.node`）→ unload | 加载成功；unload 后 `loaded:false`（worker dispose） |
| worker 崩溃隔离 | `loadInWorker('cp2-worker-crash')`（setup 抛错） | 以 `cp2 fixture boom` 拒绝；**宿主存活**（registry 可查） |
| worker 死循环/挂起 | `loadInWorker('cp2-worker-hang')`（setup 死循环） | 5s 启动超时后拒绝（实测 ~7s 含握手开销）；worker 被终止；**宿主存活** |
| post-ready 崩溃 | `loadInWorker('cp2-worker-late-crash')`（ready 后 100ms `process.exit(7)`） | 先 `loaded:true`，会话被崩溃回调停止（unload 后 `loaded:false`）；**宿主存活** |
| 限时终止 | 见上（挂起 7s 内终止）；在途插件工具调用的 `abortByOwner`/`abortAll` 语义由 `inflight.test.ts` 3 例覆盖，unload/disable/权限撤销与 before-quit 均已接线 | PASS（范围见下） |

## 实机中发现并修复

- **Windows 绝对路径 `import()` 失败（上游缺陷）**：`FileSystemLoader.loadExtensionFor` 直接 `import(entrypoint)`，Windows 下解析为 `C:\...`，默认 ESM loader 抛 `Only URLs with a scheme in: file, data, node, and electron are supported`——桌面上任何磁盘扩展都无法加载。已在 fork 补 `isAbsolute → pathToFileURL` 转换（带 NOTICE 与移除条件），新增 `fs.test.ts` 回归（绝对路径经 file URL 加载）。
- 夹具教训记录：PowerShell `-replace` 默认大小写不敏感，批量生成 manifest 时把 `id` 键替换坏（已用 `ConvertTo-Json` 重建）。

## 覆盖与限制

- 覆盖：权限三态（未批准拒绝/批准生效/撤销失效）、worker 四态（ready/crash/hang/late-crash）与宿主存活、worker 启动超时的有界终止。
- 未跑：端到端"慢插件工具调用 → unload/撤销中止"的真机夹具（需注册可挂起工具的扩展 + 权限批准；当前由 `inflight.test.ts`、worker-loader 的 forced-terminate 测试与接线覆盖）。如后续 EP-2b 引入真实 worker 工具消费，再补该夹具。
- 夹具已清理（`extensions/v1/cp2-*` 删除），主窗口回 `#/`。
