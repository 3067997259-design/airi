# EP-2a 声明式插件包真机验收（2026-09-12）

结果：**验收表核心场景全部 PASS**（整包批准/激活、批准后替换、禁止 Node 入口、技能哈希失效、升级与回退、卸载清理、包装不提升信任；备份导出域实测，完整恢复流程由单测覆盖）。环境：`pnpm -F @proj-airi/stage-tamagotchi build` 后以 `electron-vite preview` 启动，`APP_REMOTE_DEBUG=true APP_REMOTE_DEBUG_PORT=9250`；leader 窗口经 CDP 驱动，用户数据目录 `C:\Users\86130\AppData\Roaming\@proj-airi\stage-tamagotchi`。

入口形态（规范允许的 v1 二选一）：设置页 `机体模块 → 自造工具 → 扩展包` 分区（产品面，已随 build 存在）\+ `#/devtools/packages` 探针（`window.__AIRI_PACKAGES_SMOKE__`，用于按路径导入与脚本化生命周期，因为原生导入对话框无法 headless 驱动）。

## 夹具

- 已审阅技能：`ep2a-live-skill`（`source.mjs` 写于 coding workspace `D:/airi/skills/`，经 `submit → readForReview → approve` 走完整审阅链），reviewed hash `7b44da1ea7571264`。
- 包 `demo-pack`：v1.0.0 / v1.1.0（同技能绑定，描述与资产不同）；`evil-pack`（manifest 含 `entrypoints.electron`）；`bad-hash-pack`（描述符绑定 `0000000000000000`）。夹具位于 `%TEMP%\airi-ep2a\`。

## 结果

| 场景 | 操作与实测 |
| --- | --- |
| 整包批准 | `demo-pack@1.0.0` 导入 staging → 试装 `skillChecks:[{reason:'ok'}]`、digest `d5d63a22…` → 批准 → 激活：`staged:false/installed:true/approved:true/active:true/enabled:true` |
| 工具面与证据 | 注册 `plugin:demo-pack@1.0.0:ep2a_pack_echo`，链 `['plugin:demo-pack@d5d63a22…','skill:ep2a-live-skill@7b44da1e…']`，`approvedContentHash = 包摘要`；`resolveEvidenceAuthor → reviewed_self_authored` |
| 执行委托 | `executeTool('ep2a_pack_echo',{echo:'hello-ep2a'})` → `{"echo":"hello-ep2a","pack":"live","at":…}`（技能沙箱执行） |
| 批准后替换 | 篡改已激活版本 `assets/panel.html` 后 `activate` → **`PackageDigestMismatchError`**（approved `d5d63a22…`, actual `7d67be29…`），现役指针未变 |
| 禁止 Node 入口 | `evil-pack` 试装 → `Package manifests must not declare runtime entrypoints; packages are declarative (EP-2a).` |
| 技能哈希失效 | `bad-hash-pack` 试装 → `failed trial: hash_mismatch` |
| 升级与回退 | v1.1.0 试装/批准/激活 → 注册只剩 `plugin:demo-pack@1.1.0:…`（无重叠）；`rollback` → 注册切回 `plugin:demo-pack@1.0.0:…` |
| 卸载清理 | 卸载 `1.0.0` → `registrations:[]`；版本目录只剩 `data/state.json`（默认保留私有数据）；`1.1.0` 保持已批准未激活 |
| 备份导出域 | `extensionPackagesExport` → `packages/registry.json` + `packages/versions/demo-pack/1.1.0/{extension.airi.json,airi-package.json,airi-package.lock.json,assets/panel.html,data/state.json,skills/…}`；已卸载的 v1.0.0 不导出 |
| 包装不提升信任 | 破坏工作区技能源码后执行包工具 → `Skill "ep2a-live-skill" is blocked: Skill source changed. Submit the new source for review.`；`evidenceAuthor → untrusted_plugin`，直接技能工具被撤下（包工具留着但不可信）|
| 恢复可恢复 | 还原源码后 `readForReview + approve` → reviewed 列表恢复、`evidenceAuthor → reviewed_self_authored` |

## 修复与偏差

- **试装前修复（重要）**：包内技能绑定原先按文件 sha256 比对，而真实契约是审阅绑定哈希 `contentHashOf`（16 位 FNV）。已改为 `contentHashOf(source)`，并同步单测夹具；否则任何真实已审阅技能都会 `hash_mismatch`。
- **UI 新鲜度**：失败的 `activate`（摘要不符）走 `run` 的 catch，不刷新本地账本、不广播；被篡改版本会在下一次成功操作或广播后的 `refresh()` 中从工具面移除（`activePackages()` 已在主进程过滤摘要不符者）。注册的旧工具仍以**批准摘要**为证据输入，安全语义不受影响。
- **未覆盖**：完整「导出 → 清空 → 隔离 profile 导入」应用级往返未在本轮真机执行（需要 `stageRestore` + relaunch）；导出域与恢复语义（默认 `enabled:false`、摘要不符降级、损坏 registry 保留取证）由 `store.test.ts` / `profiles.test.ts` 的 5 个用例覆盖（含 ZIP 往返）。若需要应用级证据，可在下一次数据备份专项验收中补跑。
- 夹具已清理：测试包全部卸载（`packages/` 空、`.staging` 清空、`packages.json` 为空注册表）、`D:\airi\skills` 测试技能删除、技能队列 `reject` 复位（仅保留既有 `acc-20260909-dedupe`）、主窗口回到 `#/`。
