# LR-1 接线 + LR-2 建议模式（2026-09-18）

状态：**离线完成并验证；真机部分 NOT-RUN（环境未启动）**。

## 1. 本批次范围与判据

批次定义见[远距伴飞设计](../../long-range-escort-design.md) §3。

| 批次 | 完成门 | 本批次结果 |
| --- | --- | --- |
| LR-1 估计器与门控 | 乐观需求、闭合速率、`cannot_catch_up` 判定有单测 | **接线完成**：单测已在上一批次就绪，本批次把门控与闭合窗口接进 live 路径 |
| LR-2 协同建议协议 | 真机：消息频率与内容正确；配合与不配合两组对照 | **部分**：`escort: 'suggest'` 配置与计数就绪；消息发送链路未实施（真机验收仍为 NOT-RUN） |
| LR-3 伴飞控制 | 200 格与 500 格两组：闭合速率、每公里烟花、终止原因齐全 | **未实施**（能量管理未接线；回执字段已就位，等 LR-3 填值） |
| LR-4 走廊捷径与残差标定 | 低空绕山与穿谷通过；残差按版本、姿态、地形分组 | **未实施**（走廊绕行系数尚未进 D2 估算器） |

## 2. 改动

| 文件 | 改动 |
| --- | --- |
| `movement/escort.ts` | 新增 `createEscortPolicy`（一条跟随命令一个策略）、`escortSampleFromObservation`（观测→估计器输入）、`EscortMode`/`EscortPermission`/`EscortClosureRecord`；`DEFAULT_ESCORT_GATE`/`DEFAULT_CLOSURE_WINDOW` 由 `as const` 改为显式接口，便于调用方覆盖 |
| `movement/air-follow.ts` | escort 接线点由 `gate: () => 'launch' \| 'hold'` 改为 `approve: () => 'assess' \| 'launch' \| 'hold'`；`escort?` 阶段语义修正；新增终态 `cannot_catch_up`、`escort_inconclusive`；回执新增 D5 字段 |
| `movement/air-track.ts` | D2 起飞门（起飞前 + 起飞评估时各判一次）、D4 闭合窗口（每拍喂样本，连续两个不闭合窗口转安全降落）、D5 回执字段（闭合序列、每公里烟花、剩余储备、观测年龄、建议次数、飞行距离） |
| `index.ts` | `assessHostAirLaunch` 增 D2 门；新增 `escortModeOf()`（配置 ∧ 档案可解析 ∧ 已校准）；跟飞调用点传 escort 模式、闭合窗口、观测年龄读取器；配置解析新增 `flight.escort` |
| `shared/eventa/game-host.ts` | `GameHostFlightConfig.escort?: 'off' \| 'suggest' \| 'on'` |
| `index.test.ts` | 配置往返测试覆盖 escort（含未知值只丢该字段） |

## 3. 接线语义（可核对的判据）

**D2 门**（`escortGate`）在两处生效：

1. **起飞评估时**（宿主 `assessHostAirLaunch`）：资源检查通过后，若乐观追击需求超出可支配烟花，返回
   `cannot_catch_up`；宿主把该原因落到命令结果，不做起飞。
2. **每拍起飞前**（驱动 `approve`）：读最新观测重算。目标会转向、落地或消失，一次性的许可会在
   两拍之间过期（设计 D2）。

`approve` 的三态与理由：

| 返回 | 含义 | 控制器行为 |
| --- | --- | --- |
| `'assess'` | 策略还没有依据（目标位置读不到） | 停在 `escort` 相位反复询问，**不消耗起飞尝试** |
| `'launch'` | 值得追 | 走原有起飞评估 |
| `'hold'` | 拒绝 | 保持地面跟随（继续走，不空转） |

**D4 闭合窗口**：每拍用"自身到目标"的水平距离喂 `createClosureEvaluator`。连续两个不闭合窗口
→ `inconclusive` → 控制器转 `escort_inconclusive` 有界安全降落，不再烧烟花。整套闭合序列进回执。

**开关纪律**（设计 D6/D8）：`escort` 非 `off` 时，仍需 `planner: 'on'` **且** `calibrated: true`。
理由：D2 的预算按助推巡航速度估算，未校准的物理档案不能支撑这个估算；D6 明确校准前不启用
escort 与低空捷径。请求了但跑不起来时宿主 `log.warn`，不静默。

**默认行为不变**：`escort` 缺省为 `off`，控制器拿不到 `escort` 选项，状态机与回执字段与接线前
一致（有测试断言三个 escort 字段均为 `undefined`）。

## 4. 证据：离线验证

```powershell
pnpm exec vitest run --config apps/stage-tamagotchi/vitest.node.config.ts src/main/services/airi/game-host
pnpm -F @proj-airi/stage-tamagotchi typecheck
pnpm lint
```

| 项 | 结果 |
| --- | --- |
| game-host 套件 | **842 通过 / 1 跳过（60 文件）**；上一批次起点 830，净增 12 例 |
| typecheck | 干净 |
| `pnpm lint` | 干净（保留既有 30 条 warning） |

新增测试覆盖的行为：

- 估计器输入：每 tick 速度→格/秒、朝向归一、静止目标不带朝向、无位置返回 `undefined`。
- 策略：可负担的追击放行、超预算拒绝并给出所需烟花数、无位置时不作判断、闭合序列保留且
  `escort_inconclusive` 只判一次、建议计数。
- 控制器：`assess` 停在 escort 相位、`launch` 进入起飞评估、`hold` 保持地面跟随、`off` 回到原流程。
- 驱动：门控拒绝时**不起飞**（零烟花、零跳跃）且回执记 `cannot_catch_up`；两个不闭合窗口后
  终态 `escort_inconclusive` 且回执保留闭合序列与储备；`escort` 关闭时回执无 escort 字段。
- 配置：`flight.escort` 往返；未知值只丢该字段，保留 planner 与 calibrated。

### 范围说明（不要超出）

- 以上全部是**离线行为**：脚本化地形、假端口、注入时钟。它证明接线与拒绝语义正确，不证明
  真机追击质量。
- **每公里烟花是下界**：飞行距离按相邻 `get_self` 读的直线距离累加，不是弧长。LR-3 重定阈值时
  必须知道这一点。
- **LR-2 的"建议次数"目前恒为 0**：字段就位但发送链路未实施，不要把它当成"已实现仅发建议"。
- D2 的 `detourFactor` 仍是常数 1.3，未接入走廊实测绕行系数（LR-4）。

## 5. 真机部分：NOT-RUN

前置仍不满足（清单 §1.2）：25565/25598/25599/25600/25601/25602/9222 全部无监听。

解锁顺序：E-01 校准 → 置 `calibrated: true` → escort 才会真正生效。**E-01 通过前，即便把
`escort` 设为 `on`，宿主也会记一条 warn 并保持关闭**，所以本批次不会在未校准的档案上运行。

## 6. 台账

- 证据：本文件。
- 已同步：`MODS.md`、验收清单 §3.1、[远距伴飞设计](../../long-range-escort-design.md) §3 状态列、
  [跨线执行顺序](../../cross-line-execution-order.md) §2 进度行。
