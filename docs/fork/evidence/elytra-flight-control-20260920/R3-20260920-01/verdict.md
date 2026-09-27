# R3 通道闭环判定（R3-20260920-01）

日期：2026-09-20。判据来源：[执行计划 §8](../../elytra-flight-control-execution-plan.md)、[R3 通道闭环设计](../../elytra-flight-control-r3-channel-loop.md)。

状态：**通道模式真机闭环通过**；落地精度与客户端碰撞伤害为 R4/R2b 范围内的遗留（见文末）。本批零 Git 提交。

## 1. 交付

宿主侧（AIRI）：

- `movement/port.ts`：通道面（submit/status/revoke + 回执形状）。
- `movement/host-port.ts`：按 `flight_*` 工具挂载；**状态枚举大小写归一**（客户端发 `TERMINATED`，端口契约是小写；此前所有客户端终局原因都到不了主进程）。
- `flight/channel.ts`：通道执行器（stale_generation 用回执 expectedGeneration 重试一次并记住协商代次；session_active 撤销己方残留再试；游标轮询；撤销幂等；有效期判定）。
- `flight/low-route.ts`：`exclude` 球形禁区（客户端拒绝的区域回到规划器）。
- `movement/elytra.ts`：巡航段双模式。通道模式：规划→提交→回执循环→前缀校验→`channel_complete`/`touchdown` 后进落地段；本地前沿路线（`local: true`）完成时在主进程重规划续飞；健康/烟花守卫；glider 停止滑翔由主进程自证收尾。遗留模式逐字节保留。
- `movement/vehicle-port.ts`：`channel` 回执字段（submissions/replans/endReason）。

客户端侧（MCPFabric，本批修复）：

- `0.2.36`：被拒绝的 submit 不再写入幂等记忆（否则 stale_generation/session_active 的修复重试永远重放原拒绝）。
- `0.2.37`：会话已开始应用后落地 → `terminateIfActive("touchdown")`，不再落地后自动重新起飞。

## 2. 真机运行（栈：0.2.37 客户端 + 双桥 + 25600/25602）

| 运行 | 目标 | 结果 | 说明 |
| --- | --- | --- | --- |
| 01 | 河道终点 | unavailable（提交拒绝） | 客户端仍记着被拒提交；0.2.36 修复前的直接证据 |
| 02 | 河道终点 | unavailable（stale 重试仍被拒） | 同一根因，重试被幂等记忆吞掉 |
| 03 | 河道终点 | stuck / 落地 miss 117 | 0.2.36 后 stale 修复生效（3 次提交）；前缀比较误判（把规划起点与新航路点比） |
| 04 | 河道终点 | stuck / miss 119 | 前缀误判改为同工位比较后仍偏高（含 Y） |
| 05 | 河道终点 | low_supply / miss 143 | 前缀误判改水平后航程推进；客户端燃油守卫提前收尾 |
| 06 | 带顶棚的短目标 | landing_in_water | 目标在顶棚下（主进程正确探测 y=70 顶），弹药仅 2 发 |
| 07 | 河道终点 | stuck / miss 117 | 发现本地前沿完成被当到达（`local: true`） |
| 08 | 河道终点 | stuck / miss 107 | 前沿续飞上线；前缀仍偶发误判 |
| 09 | 河道终点 | stuck + 死亡 | 真机暴露客户端贴地碰撞伤害（健康守卫转安全降落） |
| 10 | 短目标 | cancelled / no_reachable_landing | 落地后停滞导致重规划再起飞；暴露 glider 停止滑翔主进程未自证 |
| 11 | 短目标 | **channel_complete → 落地 2.1 格**（tolerance 2，stuck） | 主进程观测到客户端 `channel_complete` 并进落地段；单次提交、无重规划 |
| 12 | 河道终点 | **channel_complete → 落地 18.7 格**，绕飞一次 | 全链路：前缀拒绝保持、前沿续飞（replan 2）、`no_viable` 禁区重规划（replan 3）、终局与落地段；飞行中掉血到 8.96（客户端碰撞） |

证据：`river-channel-01..12.jsonl`（每次运行含 meta、逐 300 ms 采样、mover 轨迹、`channel` 回执）；`probe-flight.mjs` 为只读通道探针。

## 3. 完成门核对（执行计划 §8）

| 完成门 | 判定 | 证据 |
| --- | --- | --- |
| 地图、路线与实际执行以 ID 与 tick 串联 | PASS | 运行 11/12：sessionId/revision 与轨迹 tick、通道终局一致；`channel` 回执进入结果 |
| 故障注入有界收尾 | PASS（离线 + 真机自然注入） | 拒绝转一圈重试、会话残留撤销重试、陈旧前缀保持、`no_viable` 禁区重规划、健康/低弹药守卫、取消/所有权丢失单测 |
| 无未验证空间的静默直飞 | PASS | 规划拒绝 → 类型化 `unavailable`（运行 02）；通道路径始终来自规划器 |
| 完整路径未在任何桥接层被丢弃 | PASS | 修复大小写归一后客户端终局原因全部到达（运行 11/12 的 `channel_complete`）；前缀校验按同工位水平比较 |
| 真机全程一次（桥面→河道→通道完成→落地） | PASS（短目标运行 11；长河道运行 12） | 落地精度归 R4 |

## 4. 范围与遗留

- **落地精度**：运行 12 在目的地上空绕飞一次后落在 18.7 格外；进近条件、拉平与容差是 R4 的正式范围。
- **客户端碰撞伤害**：运行 09 死亡、运行 12 掉血，指向 Java 逐 tick 扫掠对贴地/贴壁的保守性与预测误差；R2b 清单的"完整碰撞盒扫掠"未完成。
- 通道路径当前由 `planLowRoute` 输出；R4 前把 R1 `planSpaceRoute` 的完整通道与洞内进近接入。
- TS/Java 交叉回放、不同推进剩余量补测仍未做。
- 本批运行 11 前给 bot 加了 30 s 抗性以隔离"通道闭环"与"生存"；该效果的时效与影响记录在此，不用于 R4 的生存判据。
