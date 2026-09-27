# R2b 修复批检查记录（R2b-20260920-02）

日期：2026-09-20。

## 命令与结果

| 命令 | 工作目录 | 结果 |
| --- | --- | --- |
| `.\gradlew.bat :1.21.1:build`（默认 JDK 17） | `D:\mcpfabric` | FAIL——Stonecutter 0.9.6 要求 JVM ≥ 21。环境事实，不是代码缺陷。 |
| `$env:JAVA_HOME='C:\Program Files\Java\jdk-21'; .\gradlew.bat :1.21.1:build` | `D:\mcpfabric` | BUILD SUCCESSFUL（16 s，增量）。首次编译错误为 `FlightHandlers.requireControl` 未声明 `throws RpcException`，修正后通过。 |
| `java -version` | `C:\Program Files\Java\jdk-21\bin\java.exe` | 21.0.8。 |
| `java --class-path versions/1.21.1/build/libs/mcpfabric-0.2.35+1.21.1.jar replay-fixed.java` | `D:\airi` | 退出码 0；五项 PASS，另 9 条 Fabric 注解类加载警告（既有现象）。 |
| `npm run typecheck` | `D:\mcpfabric\mcp-server` | 0。 |
| `npm run build` | `D:\mcpfabric\mcp-server` | 0。 |
| `node --check verify.mjs` | `D:\airi` | 0（语法检查；脚本本身未运行）。 |
| `pnpm exec vitest run --config apps/stage-tamagotchi/vitest.node.config.ts src/main/services/airi/game-host --exclude '**/e02-route.integration.test.ts' --exclude '**/elytra-live.integration.test.ts'` | `D:\airi` | 1 failed / 62 passed / 1 skipped（64 文件）；1 failed / 927 passed / 1 skipped（929 用例）。失败为 `flight/low-route.test.ts > r1 scenario boundaries > sealed cave: a pocket at the goal altitude with no connection is refused`，`Test timed out in 5000ms`（实测 5462 ms），全量并行负载下的计时抖动。 |
| `pnpm exec vitest run ... low-route.test.ts -t "sealed cave"` | `D:\airi` | 1 passed（4.64 s），定向重跑通过。 |

## 真机运行（2026-09-20）

| 步骤 | 结果 |
| --- | --- |
| 备份 0.2.34（`c55fff78…`）→ `.jar.bak-r2b`；部署 0.2.35（`AAEB0280…`）到 `versions\AIRI-bot\mods` | 哈希核对一致。 |
| `node launch-client.mjs "<PCL 根>\versions\AIRI-bot" airitest` | 客户端 PID 31092；桥 25601 在 ~100 s 内监听。 |
| 在客户端之后重启 25600 实例（原进程 33356/cmd 8032 → 新 PID 14204） | 预检 `get_self` 返回 `airitest`、(-1007,74,79)。 |
| `node probe-surface.mjs`（读 25602，84 个切片） | 河面 y=62，河道自桥位向北偏东；据此重写手写诊断通道。 |
| 第一次 `verify.mjs`（`live-verdict-20260920-01.json`） | FAIL：stall 未触发（飞行 5 s 内结束）、环形覆盖门误判、手写路径出河道后 `no_viable_trajectory`。产品阻断项全部转绿。 |
| 修脚本门 + 换河道通道后第二次 `verify.mjs`（`live-verdict-20260920-02.json`） | **PASS**：`channel_complete`、终点 3.99 格、停顿样本 92、游标滞后 1、点火 2。 |
| 收尾 | `flight_revoke` 确认 `TERMINATED`；bot 传送回桥面 (-1007,74,79) 并恢复生命。 |

## 说明

- 本批没有修改 AIRI 的 TypeScript 代码；全量套件里的 sealed-cave 超时在 R1 交付时为 928 通过 / 1 跳过，本轮两次全量运行均在负载下超过 5 秒默认超时，定向重跑通过。按验收纪律记录为计时抖动，不修改测试、不记为代码回归。
- 仓库 lint 状态与 R0 相同：既有阻塞位于 `docs/fork/evidence/ov5-elytra-launch-20260918/` 的九个 JSON 与其他既有脚本。本批新增文件定向 `moeru-lint` 0 错误（`verify.mjs` 经格式化修正后干净）。
- 真机已完成（见上表）；部署摘要：备份 0.2.34，部署 0.2.35，客户端 PID 31092，25600 实例 PID 14204，运行后 bot 已传送回桥面并恢复生命。
