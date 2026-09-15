# MC-0d 生存反射真机验证记录

日期：2026-09-11/12（本地时间）。结果：**PASS（escape / preemption / auto-eat / defend 反击 / defend 脱离）**。
环境：环境 A（本地 Fabric 专用服，offline，seed `-3029234016717445527`，`gamerule doMobSpawning false`，测试期间 `difficulty easy`；和平难度下饥饿不掉，故进食夹具用 easy）；客户端 jar `mcpfabric-0.2.3+1.21.1.jar`（客户端构建 SHA-256 `5d3daf2b7dee57319f5f69db7f875fdb19d98f671c8de3360ff69b40cd2fff78`）；服务端 jar 为同一 0.2.3 的早期构建（差异仅在客户端反射代码）。

## 驱动方式

原始 RPC：客户端桥 25599（`player.getState`/`nav.*`/`events.getRecent`）+ 服务端桥 25598（`command.run` 放置危险、给物品、施加效果、生成实体）。

## 结果

| 场景 | 证据（`game:reflex` 事件摘录） |
| --- | --- |
| 火焰逃脱 | `cause=hazard, action=escaped`，`positionBefore (40.41,86,-35.70) → positionAfter (40.41,87,-36.16)`；**逃脱后 1.5s 位移 = 0**（收敛） |
| 抢占导航 | 带 `commandId=reflex-preempt-final` 的 `nav.pathTo` 在途时触发火焰 → `nav.status.endReason=reflex_preempted`；事件 `preemptedCommandId=reflex-preempt-final` |
| 自动进食 | `cause=hunger, action=ate`，`hungerBefore 13 → hungerAfter 18`（阈值 14），`itemId=minecraft:bread`；结束食品 18 |
| 防御-反击 | `cause=attacked, action=countered`，`attackerName=僵尸`、`attackerUuid`、`healthBefore 17.5 → healthAfter 15`；尸壳/僵尸被击杀（持铁剑，约 2s 掉 6 血后死亡） |
| 防御-脱离 | `cause=attacked, action=disengaged`，`healthBefore/After=3.5`，位置从 (17.5,83,-9.5) 退到 (10.2,83,-21.8)（≥ `disengageDistance=8`） |

## 验证中发现并修复的两个运行时缺陷（同一 0.2.3 内）

1. **逃脱完成后未停步**：`tickEscape` 成功分支只切状态，保留了 `fwd`，角色在逃脱后继续走（实测又走了约 7 格）。修复：成功分支 `BotController.stopAllMovement()`；复验位移 0。
2. **进食不生效**：`KeyMapping.setDown(true)` 不会产生 `consumeClick`，原实现只按住使用键导致 100 tick 超时（`failed: eat_timeout`）。修复：`startEat`/`tickEat` 显式调用 `gameMode.useItem`，并保留 use 键状态；复验 `ate`。

## 未覆盖 / 备注

- **事件合并**未单独造夹具：实现为每个事件只在结束时发一次，同 cause 在 `mergeWindowMs` 内合并、`failed` 不合并；未造"3 秒内二次触发"场景。
- **用户停止优先**由 MC-0b 取消语义覆盖；本批未重复。
- **空手反击 10 秒超时偏紧**：空手打僵尸在 200 tick 内可能只打不死（首次夹具即 `failed: defend_timeout`）；持剑可稳定 `countered`。保留该上界，是否放宽留待 MC-1a。
- **自动复活未实现**：死亡后停在死亡界面，需人工点重生（P1 只做清控与 `death` 上报）。自动复活（延时 PerformRespawn + `game:death` 事件 + 配置开关）建议随 MC-1b 的掉落物找回一起做。
- 服务端 jar 为早期 0.2.3 构建（反射是客户端逻辑，服务端无差异）；下次整批重启时同步为最终构建。
- 夹具环境留在 `difficulty easy` + `doMobSpawning false`；如需恢复和平难度请告知。
