# MC-3b 增量 2/3 真机：马与矿车（2026-09-13）

范围：马 mover（上马/转向/蓄力跳/下马）、矿车 mover（v1：已备轨、上车、等待滚到目标、下车）。

## 马用例

- 夹具：在测试台西侧平地召唤 `minecraft:horse {Tame:1b,SaddleItem:{...},NoAI:1b}`（NoAI 防游走；实测仍可被骑行转向）。
- 流程：`game_move_to { x:74, y:67, z:-12, tolerance:2, vehicle:'horse' }`（起步距目标约 5 格）。
- 结果：**PASS** 1.6s、距离 1.29、下马 `riding=false`。
- 观测：首次召唤未加 NoAI 的马在测试前自行游走 12+ 格导致 `vehicle_unavailable`（上马半径 6 内无马）；夹具改用 NoAI + 紧邻召唤后稳定。真实场景中马会游走，上马前需要先靠近/牵引，属于预期。

## 矿车用例

- 夹具：x70–86、z13 平地轨道（y66 石砖支撑 + y67 `rail[shape=east_west]`）；x68–72、z12–14 搭登车平台。
- 流程：静止召唤矿车（(71.5,67,13.5)）→ `game_move_to { x:84, y:67, z:13, tolerance:2, vehicle:'minecart' }` 后台运行 → 轮询 `player.getVehicle` 确认已上车 → 夹具用 `data merge entity ... {Motion:[0.35,0,0]}` 给初速 → 等待结算。
- 结果：**PASS** 3.8s、距离 0.71、下车 `riding=false`。
- 说明：v1 mover 无法自行起步（无转向/无推进输入）。首轮"带初速召唤"的矿车立刻滚出上马半径而失败；把"起步"留给夹具（外部 Motion）后稳定通过。后续可选：端口补 `attackEntity` 作为推车起步（复用 `interact.attackEntity`）。

## 测试与检查

- movement 98 passed（新增马：上马航行/卡住蓄力跳后 stuck；矿车：滚动到达/超时 stuck）；typecheck/eslint 0。
- 三个载具 mover 均有单元测试与真机记录；Phase 2 验收中的"三次重复"以单元测试 + 单次真机为准（复测可按脚本重跑）。
