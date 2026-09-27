# R3 检查记录（R3-20260920-01）

日期：2026-09-20。

## 离线

| 命令 | 结果 |
| --- | --- |
| `pnpm exec vitest run --config apps/stage-tamagotchi/vitest.node.config.ts src/main/services/airi/game-host --exclude '**/e02-route.integration.test.ts' --exclude '**/elytra-live.integration.test.ts'` | **943 通过 / 1 跳过（65 文件）**。R3 新增：`channel.test.ts` 8 例、`elytra.test.ts` 通道模式 6 例、`host-port.test.ts` 通道映射 1 例。 |
| `pnpm -F @proj-airi/stage-tamagotchi typecheck`（`NODE_OPTIONS=--max-old-space-size=6144`） | 0 错误。默认堆在客户端 + 服务端同时运行时 OOM，属环境内存压力。 |
| `pnpm exec moeru-lint <touched files>` | 0 错误。 |
| `low-route.test.ts` 密封洞用例 | 8 s 穷举预算在带载机器上返回 `blocked/time_cap`。用例预算提升到 30 s（断言不变），并加 45 s 测试超时；属测试预算修正，见代码内 ROOT CAUSE 注释。 |

离线期间修正的两个产品缺陷（由真机暴露）：

1. `host-port.ts` 状态枚举大小写：客户端发 `TERMINATED`，端口/执行器按小写匹配 → 客户端终局原因永远不可达。
2. `elytra.ts` 前缀校验：先把规划起点与航路点对比（角色错配），后含 Y 轴差异 → 起飞爬升段反复误判"偏离"并重规划。最终按同工位水平距离比较；单次规划拒绝不再作废仍有效的前缀。

## 真机

栈：0.2.37 客户端（PID 36800）+ 服务端桥 + 25600/25602。运行命令（每次唯一输出，不覆盖）：

```powershell
$env:MCPFABRIC_URL='http://127.0.0.1:25600/mcp'; $env:MCPFABRIC_SERVER_URL='http://127.0.0.1:25602/mcp'
$env:E02_RUNS='1'; $env:E02_MODE='diagnostic'; $env:E02_CALIBRATED='true'
$env:E02_START='-1007,74,79'; $env:E02_GOAL='-955,66,-115'   # 或 '-997,67,-8'
$env:E02_OUT='D:\airi\docs\fork\evidence\elytra-flight-control-20260920\R3-20260920-01\river-channel-<n>.jsonl'
pnpm exec vitest run --config apps/stage-tamagotchi/vitest.node.config.ts src/main/services/airi/game-host/movement/e02-route.integration.test.ts
```

12 次运行均为有界收尾（每次 < 110 s）；结果与根因链见 [verdict.md](./verdict.md)。

## 客户端版本与修复

| 版本 | 修复 |
| --- | --- |
| 0.2.35 | R2b 修复批（控制生命周期、确定性驾驶）。 |
| 0.2.36 | 被拒绝的 submit 不写入幂等记忆：stale_generation/session_active 的修复重试此前永远重放原拒绝。 |
| 0.2.37 | 会话开始应用后落地 → `touchdown` 终止；落地后不再自动重新起飞。 |

`flight_submit` 工具描述同步（接受的会话才幂等）。mcp-server 已重建。
