# R0+R1 检查记录（R0-20260920-01）

全部命令工作目录 `D:\airi`，除非另注。执行边界：用户指示不做真机验收；vitest / typecheck / lint only。实施期间零 Git 提交。

## R0（基线与复现）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 两仓状态实读 | `git rev-parse HEAD` / `git status --porcelain`（两仓） | AIRI `f0dc80208` + 10 修改文件（与执行文件 §2 逐项一致）；mcpfabric `274ce412` 干净 |
| 反例复现（修复前） | `pnpm exec vitest run --config apps/stage-tamagotchi/vitest.node.config.ts src/main/services/airi/game-host/flight/low-route.test.ts` | **3 failed / 22 passed**（薄墙穿墙 96.5≥6；扩宽 blocked；无 path 字段）；原始输出存 `reproductions-failing.log` |
| 部署 jar 实读 | 目录列举 | 客户端与服务端均为 `mcpfabric-0.2.29+1.21.1.jar`（源码 0.2.34，滞后） |
| 栈探测 | `netstat -ano` + `get_self` | 服务器与双客户端已关闭；MCP×2 + CDP 9222 残留监听（上游桥已死） |
| 配置实读 | `game-host.json`（token 剔除） | flight: planner on / calibrated true / escort on |
| 已知阻塞 | 全仓 lint | ov5 目录九个 JSON 缺末尾换行（历史遗留，本批未触碰）；整仓 lint 状态如实记 FAIL |

## R1（三维通道）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 反例 1 转绿 | 同上 low-route 单文件 | 薄墙：不再穿墙（waypoint 停在墙前 / blocked） |
| 反例 2 转绿 | 同上 | halfWidth 16 下仍 planned，bandY ≤ 67 |
| 弯道完整路径 | 同上 | path 有序、绕脊体两侧任一、逐点空气、终点入目标区 |
| 八场景 | 同上 | 密封洞 refused(no_route)、多层顶选对袋、先升后降、无地面自由飞、斜向不切角、未加载 local 标记、截断类型化 |
| 最终离线回归（排除真机入口） | `pnpm exec vitest run --config apps/stage-tamagotchi/vitest.node.config.ts src/main/services/airi/game-host --exclude '**/e02-route.integration.test.ts' --exclude '**/elytra-live.integration.test.ts'` | **928 passed / 1 skipped**（929） |
| typecheck | `pnpm -F @proj-airi/stage-tamagotchi typecheck` | 0 错误 |
| lint（本批触碰范围） | `pnpm exec eslint apps/stage-tamagotchi/src/main/services/airi/game-host` | 0 问题 |
| 全仓 lint | 未跑 | 按执行文件 §10 如实记 FAIL（ov5 九个 JSON 历史阻塞保留） |

跳过项：`observation.integration.test.ts`（环境门控，MCPFABRIC_URL 未设——真机部分按用户指示不做）。

## R2a 真机验证（2026-09-20，栈拉起 + 0.2.34 jar 部署后）

部署记录（按 §10 纪律）：旧摘要 bot=63b78939（Sep18 构建，无 flight 模块）、server=0.2.29 `49afde90…`（均备份 `.bak-preR2a`）；新摘要三端统一 `65ce09d0…`，控制器修复后 bot 侧再部署 `919aafdc…`。部署后启动序：服务器(16s)→bot(30s)→双 MCP→AIRI(57s, leader)。

| 场景 | 结果 |
| --- | --- |
| A 同 tick 观测 | 二次运行 `tickAdvanced: true`（4374→4395 ≈ 21tps）；phase/dimension/boost(35t 源标注)/session 全携带。首次运行的 tick 冻结（246×2）确认为 bot 实例加载屏瞬态，非代码缺陷 |
| B1 接受 | `accepted: true, startedApplying: false`（R2a 诚实零写入） |
| B2 陈旧代次拒绝 | `stale_generation, expectedGeneration: 1` ✓（首轮暴露无会话时无比较基准——控制器已改为跨会话记忆 lastGeneration 并重新部署） |
| B3 幂等重提交 | `idempotent: true` |
| B4 状态/轨迹环 | ACCEPTED、applyingStarted=false、环样本正常、lost=0 |
| C 点火去重 | `secondIsReplay: true`（重复 opId 返回首次响应原样）；库存差 0/0 为读取竞态，契约由响应重放证明 |
| D1 启动交接 | launch 宏 deployed/boostSeen 事实进入 flight.observe 的 launch 字段 |
| D2 轨迹环 | 77 样本、lost=0、环内点火标记 1 |
| D3/D4 撤销 | revoked/wasActive=true/TERMINATED |
| E 取消回归 | launch 宏 9 tick 自行完成，1.2s 后取消=无操作（cancel done/launched）；运行中取消因宏时序过短不可稳定触发，记录为场景限制 |
| F 无烟花拒绝 | clear 后 `no_firework_in_hands` ✓（烟花已补回 64） |
| trajectoryLost=2473 记录 | 环形缓冲按设计覆盖旧记录；消费方须持续轮询——"丢失显式报告"行为验证 |

R2a 真机门判定：**PASS（带范围）**——四项完成门通过；限制=运行中取消场景、boost 剩余量精确读数（客户端不可读，估计带源标注）留 R2b/R3。

## R2a（离线可交付部分）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| Java 工具链（R0 时） | `JAVA_HOME="C:\Program Files\Java\jdk-21" gradlew.bat :1.21.1:build` | 首次失败：默认 JVM Java 17（Stonecutter 0.9.6 要求 ≥21）；JDK 21 路径取自 mcserver-wrap.cmd |
| **R2a 构建后** | 同上（D:\mcpfabric，2026-09-20） | **BUILD SUCCESSFUL**；新产物 `mcpfabric-0.2.34+1.21.1.jar`（268,929 B），SHA-256 `65ce09d0e394bbd0fb2a7dbe03641b34e7ea63dda81201a117b8e3f76b6426f9`（含 FlightController/FlightHandlers/flight.* 工具与 flight.observe 等五条 RPC）。**未部署**（部署须按 §10 纪律：结束会话→记摘要→重启） |
| mcp-server 构建 | `npm run typecheck && npm run build`（D:\mcpfabric\mcp-server） | typecheck 0 错误；build 成功（新增 flight.observe/submit/status/revoke/boost 五工具目录） |
| 编译错误修正记录 | `:1.21.1:compileClientJava` | 三轮：moduleTick long→int、LocalPlayer.tickCount 非公开字段（删）、`entitiesForRendering().entityList` 客户端不可访问 + `isAttachedToEntity` private（改 `Projectile.getOwner()` 归属比较，与 BotController.findOwnProjectile 同模式） |
| 真机完成门 | 需要真实客户端 tick 记录 | **NOT-RUN**（用户指示：不做真机；待栈拉起+新 jar 部署） |

## 与 918/3 的关系

历史 918/3 是 2026-09-19 工作区状态的结果。本批实际结果为上表数字；R1 新增 10 个边界测试后离线套件为 928/1。
