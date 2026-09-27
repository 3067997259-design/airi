# E-02 两臂夹具：复跑说明（2026-09-21 收尾）

本文件给下一次复跑用。客户端 0.2.58（含审计全项：源码顺序核验、终端动作、恢复策略、逐 tick 遥测）。

## 前置

1. 服务端 25565 在线；MCP 双桥可用：
   - 客户端桥 25600 → `node runcmd.mjs 25600 ...` 不需要（客户端工具走 MCP）
   - 服务端桥 25602 → `node runcmd.mjs 25602 "list"`
2. 测试客户端（`airitest`，profile `AIRI-bot`）已在服内，jar 为 `mcpfabric-0.2.58+1.21.1.jar`（部署目录 `…\.minecraft\versions\AIRI\mods`）。
3. 夹具工具目录：`docs/fork/evidence/movement-corridor-acceptance-20260915`（`runcmd.mjs`、`timeline.mjs`、`analyze-run.mjs`、`end-region-snapshot.mjs` 都在这里）。

## 复跑命令（PowerShell，工作目录 `D:\airi`）

```powershell
$env:MCPFABRIC_URL='http://127.0.0.1:25600/mcp'
$env:MCPFABRIC_SERVER_URL='http://127.0.0.1:25602/mcp'
$env:E02_MODE='route-ab'
$env:E02_AB_BUDGET_MS='150000'
$env:E02_AB_CROSS_Z='20'
$env:E02_AB_ROUTE_PLANS='6'
$env:E02_AB_ARMS='full,segmented'
$env:E02_AB_SEGMENT_MODE='default'
$env:E02_START='-1007,74,79'
$env:E02_GOAL='-843,65,-266'
$env:E02_OUT='D:\airi\docs\fork\evidence\elytra-flight-control-20260920\R4-20260920-01\cave-ab-23.jsonl'
pnpm exec vitest run --config apps/stage-tamagotchi/vitest.node.config.ts src/main/services/airi/game-host/movement/e02-route.integration.test.ts
```

分析：

```powershell
node docs/fork/evidence/movement-corridor-acceptance-20260915/analyze-run.mjs D:\airi\docs\fork\evidence\elytra-flight-control-20260920\R4-20260920-01\cave-ab-23.jsonl
```

时间线（可选）：`node timeline.mjs <run.jsonl> out.txt`（对 samples 字段有效；时间线的 ms 是 `(tick-首tick)*50` 推算，不是墙钟）。

## 四条验收（审计第 5 项）

1. 两臂都受控跨线（`crossed=true` 且 `crossing.controlled=true`）；
2. 终末动作接续（末段 `terminalAction` 为 `hold`/`land`，无 `terminal_action` 集中拒绝：末 tick `rejectTerminal` 不应持续攀高）；
3. 空中无 owner 空窗（`samples` 的 `inputOwner` 序列里 `flight-session` 结束后应接 `flight-recovery`，无成片 `none`）；
4. 无新增掉血（`damageDuringEnding` 接近 0；`ending` 为 `safe_ground`/`stable_water`）。

## 已知剩余问题（本次要看的）

- **河湾水面余量**：路线 leg2 在 z≈36..47、y≈63.5..66.5，水面约 62，只有约 2.5 格余量。进场状态低 1–2 格时，所有候选的 20 tick 预测都会切入水面 → `reject[c≈18] first=collision@t• block=minecraft:water` 早退（ab-21/22 两臂）。ab-20 同路线曾成功跨线，属执行方差。计划：给**已验证中心线**加 ≥4 格水面剖面余量后重跑；不要放宽客户端水规则、不动 A\* 权重与到达半径。
- **终端动作的陡降边界**：`verifyHold` 只在远端接触且下沉 ≤0.6 格/tick 时判为 `land`；陡降仍拒绝（杆端软着陆约束）。ab-22 河湾进场时仍有 `ta=131/tick` 的集中拒绝，因为那些到达态的下沉更陡——看 `rejectTerminal` 是否在低空水面附近爆量，若是，先改路线剖面而不是放宽该阈值。
- **树冠段**：z≈−60..−70 附近的树叶在 ab-17 曾导致拒止（现在会被正确拒绝）；用 `ab20-audit/end-region.json` 快照复核中心线与实际轨迹的偏离段后再决定是否加树冠代价。
- **推进寿命**：0.2.53 起禁叠加；`boostCount`/`boostEntityIds` 已在逐 tick 遥测里，注意 `stackedTicks` 应为 0。
- **落点**：`flight-recovery` 会地形前瞻并最多点火一次制动；如恢复段仍有掉血，看 `damageDuringEnding` 与恢复段的 `y/vy`。

## 本次已落盘的审计产物

- `ab20-audit/source-order.md`：源码/tick 顺序核验（假设 A 成立）。
- `ab20-audit/CalibrateDynamics.java` + `calibration.md`：四状态与多 tick 标定 + 裕量结论（ab-21 后可用同一探针复测）。
- `ab20-audit/end-region.json`：末端空间只读快照（x −1020..−920 / y 55..100 / z −135..−40，250,810 固体格）。
- `checks.md`：逐项交付与 ab-20/21/22 结果；`docs/fork/MODS.md`：批次记录。
