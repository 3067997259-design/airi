# R2b 修复批判定（R2b-20260920-02）

日期：2026-09-20。判据来源：[R2b 诊断 §5](../r2b-diagnosis-20260920-103351/diagnosis.md)、[执行计划 §7](../../elytra-flight-control-execution-plan.md)。

## 真机 · PASS（2026-09-20，jar 0.2.35）

部署与环境：0.2.34（`c55fff78…`）备份为 `mcpfabric-0.2.34+1.21.1.jar.bak-r2b`；0.2.35（`AAEB0280…`）放入 `versions\AIRI-bot\mods`；客户端经 `launch-client.mjs` 重启（PID 31092）；25600 实例在客户端之后重启（PID 14204）。两次运行：

| 运行 | 结果文件 | 结论 |
| --- | --- | --- |
| live-01 | [live-verdict-20260920-01.json](./live-verdict-20260920-01.json) | 产品阻断已解除：提交接受、entryReach=12 采用、起飞宏 `done`、驱动写入 96 样本、点火记录 1、诚实 `no_viable_trajectory`。FAIL 来自脚本两条门（stall 排程晚于短飞行、把环形覆盖当成消费者漏读）与手写路径出河道。 |
| live-02 | [live-verdict-20260920-02.json](./live-verdict-20260920-02.json) | **全部门 PASS**：`channel_complete`，终点距离 3.99 格（entryReach 12）；驱动 164 样本；3.5 s MCP 停顿后仍返回 92 个样本；游标滞后最大 1 tick；2 次点火记录；撤销后无驱动。 |

### live-02 门表

| 门 | 结果 | 证据 |
| --- | --- | --- |
| 前置（空闲、生命、鞘翅、烟花） | PASS | health 20、胸甲鞘翅、16 火箭、无占用 |
| submit 幂等字段与 entryReach 采用 | PASS | `accepted: true`、`entryReach: 12` 回显 |
| 驱动接管（applyingStarted + 唯一所有者） | PASS | 164 个 `flight-session` 样本；宏 9 样本后交接 |
| 实际点火进入轨迹环 | PASS | `rocketFiredThisTick` 2 |
| MCP 停顿不延长执行前缀 | PASS | 停顿 3.5 s → 92 样本；游标滞后 ≤ 1 |
| 终止类型化 | PASS | `channel_complete` |
| 航路推进按入口次序 | PASS | 4 个航路点，终点 3.99 格内完成 |
| 撤销与收尾 | PASS | `revoked: true`、`TERMINATED`、无后续驱动 |

控制生命周期（诊断第一步）与确定性驾驶（诊断第二步）的离线门同样通过，见 [fix.md](./fix.md) 与 [replay-fixed.log](./replay-fixed.log)。

## 范围与遗留

- 通道为 `probe-surface.mjs` 地表扫描得出的手写诊断路径，不是 R1 规划器输出；`channelSource: hand-written-diagnostic`。地图是同一简单河段（河面 y=62），R3 接入 R1 通道时另测。
- 碰撞检查仍以"格 id 是否 air-like"实现姿态盒扫掠，不是完整 VoxelShape 扫掠（执行计划 §7 原目标）；未知格按硬拒绝处理。
- TS/Java 交叉回放、不同推进剩余量的补测未做。
- 胸甲鞘翅耐久客户端不可读（脚本记录为限制）；本轮飞行约 8 s、2 次点火。
- live-01 的脚本门缺陷已修：stall 在驱动接管后触发；覆盖判定改为游标滞后，`trajectoryLost` 只作原始记录（环形满后必然增长）。
