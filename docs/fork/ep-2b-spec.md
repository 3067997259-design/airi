# EP-2b 规范：worker 试装与隔离终止

日期：2026-09-12。状态：规范定稿，实施未开始。上游：[扩展与自开发能力执行计划](./extension-execution-plan.md) EP-2b 行与 Phase B、[EP-2a 规范](./ep-2a-spec.md)（声明式包生命周期，已验收）、[CP-2 规范](./cp-2-spec.md)（node-worker 隔离原语，已验收）。依赖：EP-2a、CP-2（均已交付）。

通过条件（计划原文）：**试装崩溃/超时不波及宿主；撤销限时终止。** 交付定位：Phase B 只改变试装的**执行隔离等级**；批准仍绑定整包摘要，试装语义（校验项、digest、lock）与 EP-2a 完全一致。

## 现状与边界

- EP-2a 的 `PackageStore.trial()` 在 main 进程内完成：读版本目录、`JSON.parse` 两个 JSON、valibot 校验、技能绑定校验、整包摘要与 lock 写入（`main/services/airi/plugins/packages/store.ts`）。包内容属于未受信输入；当前实现里"解析未受信内容"与宿主同进程。
- CP-2 的 node-worker 原语是**扩展 setup 专用**（worker 内导入扩展入口 + 受限 ctx + 事件协议），不适合任务型试装；但两个机制共享同一隔离纪律：启动超时、宽限后强杀、崩溃不波及宿主。
- 本 app 已有一个成熟的隔离执行先例：coding-harness PTC 沙箱（`packages/coding-harness/src/ptc/runner.ts`）用 `fork()` + Node 权限模型（`--permission`、`--allow-fs-read=<dir>`、`--experimental-transform-types`、`execArgv` 白名单）运行自包含 TS worker；app 以 `electron.vite.config.ts` 的 `emitCodingHarnessWorker` 把该 worker 源 emit 到 `out/main`。
- EP-2b 采用同一模式：**fork 一个自包含的试装 worker**，只允许读目标版本目录，负责"未受信输入"的读取与解析；宿主负责全部受信判定。

## D1 职责切分（关键决策）

worker 内（未受信内容、脆弱的解析）：

1. 按覆盖规则枚举包内文件（`extension.airi.json`、`airi-package.json`、`skills/**`、`assets/**`；排除 `data/**`、`logs/**`、派生的 lock）。
2. 逐文件 sha256（字节级）。
3. `JSON.parse` 两个 JSON 文件（不做 schema 校验——schema 是受信判定）。
4. 通过 `parentPort` 返回纯数据 `{ files: [{ path, sha256 }], manifestJson, descriptorJson }`；任何异常/崩溃/超时都被隔离在本进程。

main 内（受信判定，复用 EP-2a 实现）：

1. valibot schema 校验（`parsePackageDescriptor`、`extensionManifestV1Schema`）、`assertDeclarativeManifest`。
2. 技能绑定校验（`contentHashOf(source)`；worker 只返回文本文件字节的解析结果——技能源码文本由 worker 一并返回或 main 读取由实现定，**校验必须在 main**）。
3. digest 组装：main 用返回的 `{path, sha256}` 列表重算整包摘要（与 `computePackageDigest` 同一算法），**不信任** worker 的任何汇总值。
4. 写 `airi-package.lock.json`（main）。

不变量：**worker 只提供原始观测；所有批准相关判定在 main。** worker 崩溃、超时、返回垃圾一律视为试装失败，不产生批准材料。

## D2 worker 客户端与生命周期

- 新 main 模块 `services/airi/plugins/packages/trial-worker/{client.ts,worker.ts,protocol.ts}`：
  - `worker.ts`：自包含（仅 `node:fs`/`node:path`/`node:crypto`/`node:worker_threads`），实现 D1 的读取/哈希/解析；覆盖规则以注释指向 `descriptor.ts` 的 `DIGEST_ROOT_FILES/DIGEST_ROOT_DIRS`，并由等价测试防漂移。
  - 发射：`electron.vite.config.ts` 增 `emitPackageTrialWorker`（与 `emitCodingHarnessWorker` 同型），产物 `out/main/package-trial-worker.ts`；客户端以 `new URL('./package-trial-worker.ts', import.meta.url)` + `fork()` 定位（与 PTC runner 同型）。
  - fork 参数：`execArgv: ['--permission', '--allow-fs-read=<versionDir>', '--experimental-transform-types', '--disable-proto=throw', '--no-warnings']`、`env: {}`、`serialization: 'advanced'`、`stdio: ['ignore','ignore','pipe','ipc']`。
  - 客户端 `runPackageTrial({ directory, expectedSkills, timeoutMs? })`：
    - 启动/执行超时 `trialTimeoutMs` 默认 30s（覆盖读+哈希+解析）；到期 `kill()` 并抛 `PackageTrialWorkerError('timeout')`。
    - worker 崩溃/非零退出/协议错误 → `PackageTrialWorkerError('crash'|'protocol')`；宿主不受影响。
    - `dispose()`：先发关闭消息，宽限 `stopGraceMs`（默认 2s）后 `kill()`。
  - 客户端是**每次试装一个进程**（无复用池）；并发试装由 `PackageStore` 的串行队列保证。
- `PackageStore` 接入：新增注入点 `trialRunner?: PackageTrialRunner`（缺省 = 真 worker；单元测试注入 in-process runner）。`trial()` 仍然：调用 runner → main 完成 D1 的受信判定 → 写 lock → 返回 `PackageTrialResult`（与 EP-2a 形状一致）。
- 工作区期：`PackageStore` 增 `cancelTrial(packageId, version)`；`uninstall` 在删除前取消该版本的进行中试装。试装与生命周期写操作都在同一串行队列中，取消经客户端 `dispose()` 实现，**有界**（宽限 + kill）。

## D3 与 CP-2 / EP-2a 的边界

- 权限强制（`permissionResolver`）不适用于试装 worker：worker 不注册扩展、不解析 manifest 权限、不进入工具面；它只做只读解析。
- 批准绑定不变：摘要仍来自 main 的受信组装；worker 替换/调包不会改变 digest 输入（等价测试覆盖）。
- EP-2b 不引入远程/加载任意包代码；包仍必须是无入口的声明式包（EP-2a 的 `entrypoints` 拒绝不变）。
- CP-2 的 node-worker 原语继续服务扩展运行；两个 worker 机制共享纪律但协议独立（任务型 vs 会话型），在 COMPAT/文档中说明。

## 验收场景

| 场景 | 操作 | 期望 |
| --- | --- | --- |
| 正常等价 | 对同一夹具包跑 worker 试装 | 结果与 EP-2a 的 in-process 试装逐字段一致（digest、fileDigests、descriptor、skillChecks、lock 文件内容） |
| 崩溃隔离 | 夹具触发 worker 崩溃（调试模式 `debug: 'crash'`） | 试装以 `PackageTrialWorkerError('crash')` 失败；宿主/其他试装正常 |
| 超时隔离 | 夹具触发挂起（`debug: 'hang'`，`trialTimeoutMs` 调小） | 到期失败 `timeout`，进程被杀；宿主正常 |
| 撤销限时终止 | 挂起试装进行中调用 `uninstall`/`cancelTrial` | 宽限内终止（`stopGraceMs + ε`），无悬挂；后续试装正常 |
| 批准不变 | worker 试装 → 批准 → 激活 | 与 EP-2a 相同：激活校验摘要；篡改仍 `PackageDigestMismatchError` |
| 受信判定在 main | 篡改 worker 覆盖规则或注入假 digest（测试钩子） | 以 main 重算的 digest 为准；假值不进入批准材料 |

## 实现落点

- `apps/stage-tamagotchi/src/main/services/airi/plugins/packages/trial-worker/{protocol.ts,worker.ts,client.ts}`（新增）。
- `packages/trial.ts`（可选重构）：把 `descriptor.ts` 的覆盖规则常量/摘要算法提取为可在 main 复用的纯函数；worker 保持自包含副本 + 等价测试。
- `store.ts`：`trialRunner` 注入点、`cancelTrial`、串行队列内的取消接线。
- `electron.vite.config.ts`：`emitPackageTrialWorker`。
- devtools `packages` 探针：`trialDebug` 参数（`crash`/`hang`，仅验收用，默认不可达）与 `cancelTrial` 动作。
- 测试：客户端生命周期（正常/崩溃/超时/取消、fake fork 夹具）、等价（worker vs in-process 同夹具）、store 集成（trial 走 runner、取消时 uninstall 有界、批准/激活回归不变）。
- 真机：devtools 探针 + 真实包夹具（正常、篡改、debug crash/hang、取消）。

## 风险与回退

- **fork + `--experimental-transform-types` 的平台支持**：app 已有同型先例（PTC 沙箱）在 Electron 43 上运行；若 preview/打包下不可用，回退为 `worker_threads` + CP-2 的句柄纪律（协议自包含，切换成本限于 client）。
- **两处覆盖规则漂移**：以等价测试锁定；若实现中发现需要更复杂共享，才做 `packages/trial.ts` 提取。
- **30s 试装预算**：大包/慢盘可能偏紧；实测后调默认并记录（不改为无限）。
- **调试模式泄漏**：`debug` 仅 devtools 探针传入；生产调用不暴露该字段，文档标注为验收夹具。

## 明确不做（本批）

- 包内容的**执行**（声明式包无入口；不允许任意 Node 入口）。
- worker 池化/并发试装、远程分发、auto-reload 作为更新机制。
- 权限模型在试装期的强制（不适用，见 D3）；CP-2 扩展会话语义不变。

## 本轮交付与检查

本轮新增本规范并更新 MODS.md 索引；不改产品代码。实施与真机记录在后续增量中补齐。

## 实施记录

### 增量 1（2026-09-12）：试装 worker、客户端与等价锁定

- `packages/trial-worker/protocol.ts`：父↔子消息（`run/dispose`；`observation/error`）。
- `packages/trial-worker/package-trial-worker.ts`：自包含子进程入口（仅 `node:crypto/fs/path/process`）：按覆盖规则枚举、逐文件 sha256、`JSON.parse` 两个 JSON、收集 `skills/<toolId>/source.mjs` 文本；`debug: 'crash'|'hang'` 为验收专用缝（生产调用不传）。文件命名与 emit 名一致，源码与产物同路径。
- `packages/trial-worker/client.ts`：`PackageTrialWorkerClient implements PackageTrialRunner`——`fork` + `--permission --allow-fs-read=<包目录> --allow-fs-read=<worker 目录> --experimental-transform-types --disable-proto=throw`、`env: {}`、`serialization: advanced`；超时 30s（到期 kill + `timeout` 失败）、崩溃/协议/worker 错误类型化 `PackageTrialWorkerError`；`dispose()` 有界终止（dispose 请求 → 宽限 2s → kill），在途 `run` 以 `cancelled` 结算。
- `store.ts`：`PackageStoreOptions.trialRunner` 注入（缺省真 worker）；`trialInternal` 改为"worker 观测 → main 受信判定"——`identityFromJsons`（manifest schema + descriptor + 身份/路径安全）、`verifySkillBindingsFromSources`（`contentHashOf` + reviewed hash + lock 校验）、`digestFromFileDigests`（与 `computePackageDigest` 共用，worker 汇总值不作权威）、lock 写入仍在 main。
- `descriptor.ts`：抽出 `digestFromFileDigests` 供两条路径共用。
- 构建：`electron.vite.config.ts` 增 `emitPackageTrialWorker`（与 `emitCodingHarnessWorker` 同型，产物 `out/main/package-trial-worker.ts`）。
- 测试（真实 fork worker，25 例全绿）：`client.test.ts` 5 例——**等价**（`observation.files` 与 in-process `computePackageDigest` 逐项一致、digest 相同、data/lock 排除、技能源码文本）、崩溃隔离且后续试装正常、挂起按 timeout 杀进程且后续正常、坏包 `worker-error`、**取消**（dispose 宽限内结算 `cancelled`、重复 dispose 返回 false）；`store.test.ts` 16 例（含"取消进行中试装后 uninstall 不被阻塞"）。

### 增量 2（2026-09-12）：撤销限时终止

- `PackageTrialRunner.dispose?`；`PackageStore.cancelTrial()`（不排队，可抢占目标试装）；`uninstall` 在改动版本文件前先 `cancelTrial()`（有界）。
- 测试：client 取消用例（实测 < 2s 内完成终止）；store 用 hanging runner 证明取消后 `trial()` 以 `cancelled` 拒绝、随后 `uninstall` 正常完成。
- 验证：`packages` 目录 25/25；app typecheck 与 eslint 0。
- 待跑（真机）：built 产物的 emit 路径（fork 定位 `out/main/package-trial-worker.ts`）与设置页正常试装/批准/激活回归；崩溃/超时/取消的 UI 侧夹具（机制与单测同一实现）。

### 真机验收（2026-09-12，PASS）

- built 产物 `out/main/package-trial-worker.ts` 存在且被实际 fork；正常路径全链路通过：worker 试装（digest `becc329a…`、4 个覆盖文件、技能校验 `ok`）→ 批准 → 激活（注册 `plugin:demo-pack@1.0.0:ep2b_pack_echo`、证据 `reviewed_self_authored`）→ 沙箱执行回显 → 导出域正确。
- 崩溃/超时/取消由 `client.test.ts`/`store.test.ts` 以**同一真实 fork worker** 验证（built 与源码仅路径不同，本轮正常路径已证明定位有效）。
- 夹具与测试技能已清理；记录见 [evidence/ep-2b/live-acceptance-20260912.md](./evidence/ep-2b/live-acceptance-20260912.md)。
