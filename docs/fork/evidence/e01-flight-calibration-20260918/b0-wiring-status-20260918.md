# B0/LR-0 接线批收尾 + E-01 就绪记录

日期：2026-09-18。状态：**离线部分完成并验证；真机部分 NOT-RUN（环境未启动）**。

## 1. 本轮范围

依[跨线执行顺序](../../cross-line-execution-order.md) §2 的飞行线 B：

1. B0 接线批次第 2 项：把 `planCorridor` 粗走廊接入跟飞驱动（前 1/3/4 项已在 `571e6364c` 落地）。
2. E-01 残差校准的离线部分：让采集与审计可重复执行。
3. 顺带修复：`571e6364c` 提交时 `typecheck` 未通过（12 处错误），已全部修掉。

## 2. 改动

| 文件 | 改动 |
| --- | --- |
| `flight/live-corridor.ts`（新） | 粗走廊的 live 调用方：一次有界区域读 + 慢节奏重规划 + 路线瞄准点 |
| `flight/live-corridor.test.ts`（新） | 11 例：lattice 对齐、可达路线、绕墙、封死窗口、窗口外目标、未读格、读失败、节流缓存、目标移动触发、到达判据 |
| `movement/air-track.ts` | 巡航腿接入走廊：路线点替换直连目标；回执新增 `corridor` |
| `movement/air-follow.ts` | 回执契约新增 `corridor?: 'planned' \| 'read_failed' \| 'no_route' \| 'not_started'` |
| `index.ts` | 跟飞调用点传世界绑定（`worldId`/`dimension`/`mapVersion`） |
| `shared/eventa/game-host.ts` | `shot.observedSpeed` 补进共享契约（原先只在宿主侧内联） |
| `eslint.config.ts` | 新增 E-01 证据目录的 ignore（与既有 harness 目录同一惯例） |
| `docs/fork/evidence/e01-flight-calibration-20260918/` | 采集脚本修正工具名、新增 `RUNBOOK.md`、新增采集链自检 |

## 3. 走廊接线的行为边界

- **读窗口对齐粗格点**：窗口按 4 格对齐（`-32..32` / `-16..16` / `-32..32`，实际约 65×9×65 ≈ 25k 单元）。
  不对齐会让规划器边缘单元"看起来被覆盖"而实际没读到。
- **未读即未知**：区域内没读到的格保持未知，绝不当作空气；A* 不穿未知格。
- **拒绝不猜**：路线没到达目标格（A* 在窗口边缘停住）时返回 `no_route`，驱动保留自己的直连目标。
  直连目标此时一定比路线末端更近，所以这是正确取舍，不是降级。
- **失败是缺事实，不是永久结论**：读失败只影响本轮区间，下一拍会重试。
- **不抢输入**：走廊只改目标点，输入所有权仍按 CD-0 走；规划在策略拍运行，不在客户端 tick 内搜索。

## 4. 证据：离线验证

命令：

```powershell
pnpm exec vitest run --config apps/stage-tamagotchi/vitest.node.config.ts src/main/services/airi/game-host
pnpm -F @proj-airi/stage-tamagotchi typecheck
pnpm lint
```

| 项 | 结果 |
| --- | --- |
| game-host 套件 | **830 通过 / 1 跳过（60 文件）**；本轮起点 817 通过（58 文件），净增 13 例 |
| B0 回归门槛 | flight 77 / air-follow 33 / 移动 338 全部包含在套件内，无回退 |
| typecheck | 干净（修复前 12 处错误：`live-port.test.ts` 2、`index.test.ts` 3、`air-track.test.ts` 7） |
| lint | 干净 |
| E-01 采集链自检 | **通过**（模型自生成录像 → 审计报 10/20/40 三点、误差 0、notes 空） |

### 范围说明（不要超出）

- "830 通过"证明的是**离线行为**：走廊在脚本化地形上的选路与拒绝语义、驱动的回执字段、
  契约与类型边界。它不证明真机选路质量，也不证明残差。
- 粗格点把高度量化到 ±2 格（格边长 4）。路线瞄准点取格中心，rollout 的扫掠负责精确路径。
  这一点**需要真机确认**：E-02 的第一批场景要专门看走廊指示的爬升是否引起高度振荡。
- E-01 的三个 tick 标记按墙钟映射到最近样本，误差随 `sampleJitterMs` 报告。严格逐 tick 对齐
  需要模组增补客户端 tick 字段，另开批次。

## 5. 真机部分：NOT-RUN

本轮开始时连接前置全部不满足（清单 §1.2）：25565、25598、25599、25600、25601、25602、9222
均无监听。因此 E-01 的采集、E-02..E-10、FS-01..FS-09、OV-5 全部未执行。

已就绪、等环境的部分：

1. `capture-glide.mjs`：修正了工具名（`set_movement` / `jump` / `stop_movement` / `look`），
   全部退出路径都释放输入。
2. `RUNBOOK.md`：前置核对、人工准备、采集命令、审计命令、判定顺序、已知限制。
3. `residuals.e01.test.ts`：接 `E01_RECORDING` 即出报告。

恢复环境后的第一步：按 RUNBOOK §4 跑离线段，再按 §5 采三次 -3 pitch。

## 6. 台账

- 本批次不改变任何默认行为：`movement.flight.planner` 默认 `off`，走廊只在开关打开且世界绑定
  存在时创建。开关关闭时与 `571e6364c` 行为一致。
- 清单 §3.1 的 B0 状态与 [MODS.md](../../MODS.md) 已同步。
