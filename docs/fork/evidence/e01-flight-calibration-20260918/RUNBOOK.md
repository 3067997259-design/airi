# E-01 残差校准运行手册

日期：2026-09-18。状态：**离线部分就绪，真机部分 NOT-RUN**。

本手册是[验收清单](../../capability-deepening-acceptance-checklist.md) §3.2 中 E-01 的执行步骤。
E-01 是飞行线的硬闸门：校准不通过，不启用 E2、E3 与 CD-F（清单 §3.1 顺序）。

## 1. 本批次已就绪的部分（离线）

| 项 | 位置 | 状态 |
| --- | --- | --- |
| 物理档案解析 | `flight/profile.ts` | 就绪；1.21.1 常数逐条取自 `javap` |
| 逐 tick 模拟与轨迹 | `flight/simulation.ts` | 就绪 |
| 残差计算 | `flight/calibration.ts` | 就绪；10/20/40 tick 标记，最近样本映射 |
| 残差计算单测 | `flight/calibration.test.ts` | 就绪（3 例） |
| 真机采集脚本 | `capture-glide.mjs` | 就绪，未运行 |
| 残差审计测试 | `residuals.e01.test.ts` | 就绪，未接真机录像 |
| 采集链自检 | `make-synthetic-recording.test.ts` | **已跑通**（见 §5） |

## 2. 起跳场地（已实测，2026-09-18）

**主测试台的飞行起飞台**，由用户搭建，坐标已核对：

| 项 | 值 |
| --- | --- |
| 起飞台 | `orange_terracotta`，x=237..240, y=201, z=−18..−16（4×3），与平台面齐平 |
| 标定点 | `orange_glazed_terracotta` **(236, 201, −17)**，全平台唯一（其余橙色带釉陶瓦不存在） |
| 支撑 | (236,200,−17)、(238,200,−17)、(240,200,−17) 均为石头 |
| 西侧净空 | x=230..235、z=−17：**y 150..204 全为空气**，向西 6 格即完全净空 |
| 崖底 | y≈87（bot 曾无鞘翅坠落于此） |

**起跳方式**（2026-09-18 实测通过）：

1. 把 bot 放到起飞台：`node client.mjs 25602 teleport_player '{"player":"airitest","x":238,"y":202,"z":-17}'`
2. 脚本 `look(yaw=270, pitch=0)`，按住 `back` + `sprint` + `jump` 向西冲出。
3. 实测轨迹：`x=235.82 y=203.17`（越边）→ `x=232.45 y=193.63` → `x=230.93 y=90`（落地）。
   水平位移 7 格、落差 111 格，冲刺速度完整带出。

标定点与平台面齐平，起跳本身没有台阶问题；持续按 jump 是为了不被沿途地面凸起卡住。

**坠落代价**：无鞘翅坠落会摔死（bot 曾于崖底 y≈87 阵亡）。重开流程 =
`node client.mjs 25600 respawn` → 再 `teleport_player` 送回起飞台。**鞘翅不丢**（装备栏随复活保留，实测 damage 2/432）。

**注意**：平台西侧通道**不是严格空旷**。x=240、z=−23/−24 有移动靶测试留下的夹具
（`polished_granite` ×3 + `powered_rail` ×1）。起飞通道固定用 **z=−17**（起飞台所在行），
不要走 z=−22 邻近行。夹具位置用 `edge-map.mjs` 或逐列 `get_block` 复核，
**不要用单条 z 线代替面扫描**（本批次因此误判过两次）。

## 3. 前置（每轮照清单 §1.2 核对）

1. 服务端 25565、客户端桥 25601、MCP 25600/25602、CDP 9222 都在监听。
2. `node client.mjs 25600 get_self` 返回 `airitest`。
3. 机器人客户端在创造或生存模式下持有鞘翅，且快捷栏有烟花（本项校准不用烟花，但保留应急）。
4. 采集脚本能解析 `@modelcontextprotocol/sdk`（清单 §1.3 的 junction 办法）。

## 4. 人工准备（用户）

把 bot 放到**起飞台的标定点 (236, 201, −17)**（§2）。朝向由脚本用 `look` 设定，不需要人工对准。

场地要求：

- 前方没有山体、树冠、水域或建筑。本次测的是**无障碍滑翔**。
- 不在下界或末地；维度用主世界。
- 采集期间不要 TP、不要给效果、不要打她。**尤其不要在采集途中传送**：那会把一次滑翔切成两段。
- 平台西侧有移动靶夹具（见 §2），起飞行固定用 z=−17。

## 5. 离线段：自检采集链

任何一次真机采集之前先跑这一步。它证明"读文件 → 解析档案 → 映射 tick → 报残差"这条链是通的，
这样真机上的 NOT-RUN 或坏录像不会被当成校准结果。

```powershell
pnpm exec vitest run --config docs/fork/evidence/e01-flight-calibration-20260918/vitest.config.ts
$env:E01_RECORDING = (Resolve-Path docs/fork/evidence/e01-flight-calibration-20260918/synthetic-glide.json).Path
pnpm exec vitest run --config docs/fork/evidence/e01-flight-calibration-20260918/vitest.config.ts
```

第二条命令必须输出 10/20/40 三个点、`errorBlocks` 为 0、`notes` 为空。
本手册成稿时两条命令都通过（模型自生成录像，误差为 0 是定义上的结果，不是物理结论）。

## 6. 真机段：采集一次滑翔

`<pitch>` 取 -3（设计 §9 的基准姿态）。同一个 pitch 至少采 3 次，用于区分随机抖动与系统性残差。

```powershell
node capture-glide.mjs glide-p-3-run1.json 0 -3 25600
```

脚本行为：

1. 读起飞前状态；已在滑翔则直接退出。
2. `look(yaw, 0)` → `set_movement{forward,sprint}` 冲下边缘。
3. 离地后若未展开，按一次 `jump`。
4. `look(yaw, pitch)` 后逐次轮询 `get_self`，每轮重设一次朝向，**不使用烟花**。
5. 观察不到 `fallFlying` 后再采 8 个样本，停止输入，写 JSON。

脚本结束会打印样本数与实际采样间隔。间隔必须明显小于 100 ms，否则 tick 标记附近的样本太少，
审计会用 `no recorded sample near tick N` 拒绝该录像——这是正确行为，不是缺陷。

## 7. 真机段：计算残差

```powershell
$env:E01_RECORDING = (Resolve-Path docs/fork/evidence/e01-flight-calibration-20260918/glide-p-3-run1.json).Path
pnpm exec vitest run --config docs/fork/evidence/e01-flight-calibration-20260918/vitest.config.ts
```

输出即证据：每个标记 tick 的预测位置、实际位置、`errorBlocks` 与 `sampleJitterMs`。
把输出贴进本目录的 `e01-residuals.md`，并登记到清单 §6 与 [MODS.md](../../MODS.md)。

## 8. 判定（用户裁定，不由自动化定）

本批次**不预设通过阈值**。清单与设计都写明"阈值均为首轮工程建议，正式启用前由基线调整"。
采集完成后按下列顺序定：

1. 三个标记 tick 的 `errorBlocks` 是否随 tick 增长而系统性变大。若是，说明模型缺一项持续作用
   （阻力或重力项），先修档案再谈阈值。
2. 同一 pitch 的三次运行离散度。离散度大于 tick 间差值时，先修采集（提高采样率、缩短单次滑翔）
   再谈阈值。
3. 不同 pitch（-3、-15、-30）之间残差是否同量级。若只有某个姿态差，说明升力项系数错。

判定通过后，才把 `movement.flight.calibrated` 置为 `true`；它同时是 escort 策略与低空捷径的开关
（escort 设计 D6）。

## 9. 已知限制（写进证据，不要省略）

- `get_self` 不返回客户端 tick，只有服务端 `sourceTick`。因此 tick 标记按**墙钟**映射到最近样本，
  映射误差随 `sampleJitterMs` 一并报告。本项是首轮口径；要做严格逐 tick 对齐，需要模组增补
  客户端 tick 字段（另开批次，不在本项内）。
- 采集脚本用 `set_movement` 的旧式无会话调用（不给 `controlSessionId`）。校准期间不要同时下发
  AIRI 的飞行命令：两个写者会互相覆盖输入。
- 滑翔时长受地形限制。低于 40 tick 的滑翔无法给出 40 tick 残差，审计会如实报 `no recorded sample`。

## 10. 顺带要测的项（同一次真机窗口，属于 E-02 前置）

B0 第 2 项接入了粗走廊，它的开销还没有真机数字。采集时顺手记两项：

1. **走廊区域读耗时**：`live-corridor` 每 1.5 s 读 65×9×65 ≈ 25k 单元，rollout 每拍另读
   41×17×41 ≈ 28.6k 单元。策略拍的实际周期必须记下来；若明显超过 200 ms，先降重规划频率
   （`LIVE_CORRIDOR_REPLAN_MS`）再谈选路质量。
2. **走廊指示的爬升是否振荡**：粗格点把高度量化到 ±2 格，路线瞄准点取格中心。开关打开飞行时
   观察高度曲线是否出现周期性上下抖动；这是 E-02 第一批场景的重点。
