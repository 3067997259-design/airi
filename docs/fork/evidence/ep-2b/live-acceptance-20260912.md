# EP-2b 真机验收（2026-09-12）

结果：**PASS**。环境：EP-2b 构建（`pnpm -F @proj-airi/stage-tamagotchi build` + preview，CDP 9250）；leader 窗口经 `#/devtools/packages` 探针驱动；夹具：探针内建已审阅技能 `ep2b-live-skill`（`contentHash e650c98732d42e51`）+ 包 `demo-pack@1.0.0`（临时目录）。验收后夹具与测试技能已清理。

## 验证内容

| 项 | 实测 |
| --- | --- |
| **built emit 路径** | 构建产物 `out/main/package-trial-worker.ts` 存在；试装实际经该文件 fork（Node 权限模型 + TS 变换）完成——证明客户端 `new URL('./package-trial-worker.ts', import.meta.url)` 在打包后仍能定位 worker |
| worker 试装结果 | digest `becc329afb5b5c47f4d6c63cc2dbf30cc6e4baa1ab9d88173fad0287582f1c4a`；覆盖文件 4（manifest/descriptor/assets/data 排除正确）；技能校验 `[{ toolId: ep2b-live-skill, reason: ok }]`；工具 `ep2b_pack_echo` |
| 批准/激活回归 | 批准 → 激活 → 注册 `plugin:demo-pack@1.0.0:ep2b_pack_echo`；证据 `reviewed_self_authored` |
| 执行委托 | 沙箱执行返回 `{"echo":"ep2b-live","pack":"ep2b","at":…}` |
| 导出域 | `packages/registry.json` + 版本文件（含 `data/state.json`、`airi-package.lock.json`、技能源码），排除未批准内容 |
| 清理 | `uninstall(purge)` 后 registry 为空、`packages/` 清空；技能已 `reject` 并删除 workspace 夹具 |

## 范围与限制

- 正常路径真机通过；**崩溃/超时/取消**在 `client.test.ts` / `store.test.ts` 中以**同一个真实 fork worker**（源码路径）验证：崩溃隔离且后续试装正常、挂起 timeout 杀进程、取消宽限内 `cancelled`、取消后 uninstall 正常。built 与源码路径仅文件位置不同，本轮已由正常路径证明定位有效，因此不再单独造 UI 侧爆测夹具。
- 受信判定在 main、worker 汇总值不作权威：由 `client.test.ts` 的等价用例（worker 文件清单/digest 与 `computePackageDigest` 逐项一致）与 `store` 侧 `digestFromFileDigests` 使用锁定。
