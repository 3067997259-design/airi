# MC-3 Phase 1 规范：徒步地形与机动（移植 mineflayer movements）

日期：2026-09-13。状态：规范定稿，实施未开始。上游：[MC-3 立项评估](./mc-3-terrain-mobility.md)、[Phase 0 spike](./evidence/mc-3/spike-20260913.md)。路线决策（用户 2026-09-13）：移植 [mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder) 的 movements/代价模型（MIT），自研执行器；Baritone 仅作行为参照。

通过条件（行为级）：在 Phase 0 的七类夹具上达到或超过 Baritone 的参照行为且无破坏建筑；挖掘瞄准全程稳定（进度不重置）；物理无解时明确拒绝；卡死有界恢复。

## D1 执行归属与所有权

- 规划与执行都在 **main game-host**（TypeScript）：它已持有 MCP `client`，可直接调 `world.getBlocks/getBlock`、`control.setInput/look/jumpOnce`、`interact.*`、`inventory.*`，不需要渲染端往返。
- 新执行器 `TerrainMover` 挂到现有 `game_move_to` 动作之后：模型面不变，参数扩展：

```text
{
  x, y, z, tolerance?,
  allowBreak?: boolean,   // 默认 false：移动不得破坏建筑
  allowPlace?: boolean,   // 默认 true：允许垫脚/搭桥
  maxFall?: number,       // 默认 4（对齐 mineflayer maxDropDown）
}
```

- 现有 mod 侧 `nav.pathTo` 保留为配置项 `movement.planner = 'terrain' | 'legacy'` 的显式回退（默认 `terrain`）；`terrain` 不可用时返回类型化错误，**不静默退回**。
- 移动命令继续走现有单写者命令注册表：租约、取消（`game_cancel`/signal）、反射优先、世界绑定与回执核对全部复用，不新建调度。

## D2 世界快照与代价图（增量 1）

- 区域读取：`world.getBlocks`（含 air，上限 32k/次）拉取路径需要的包围盒，缓存于一次规划内；chunk 未加载 → `no_chunk` 错误。
- 代价模型（移植 mineflayer Movements，MIT）：

| 代价项 | 默认 | 说明 |
| --- | --- | --- |
| `canDig` / `digCost` | false* / 1 | *移动默认禁挖；仅 `allowBreak=true` 时启用，且拒绝"受保护方块"策略见 D5 |
| `placeCost` | 1 | 垫脚/搭桥的额外代价 |
| `maxDropDown` | 4 | 超过则视为不可通行（除非 `maxFall` 放宽） |
| `infiniteLiquidDropdownDistance` | true | 落点在水中不受 maxDropDown 限制 |
| `liquidCost` | 1 | 经过液体的额外代价（游泳可行） |
| `entityCost` | 1 | 穿过实体碰撞箱的额外代价 |
| `allow1by1towers` | true | 1×1 塔高 |
| `allowParkour` | true | 1–3 格跳跃 |
| `allowSprint` | true | 疾跑 |
| `dontCreateFlow` | true | 不破坏触液方块（防止水淹） |

- 规划器：A* + 动态重算（世界变化/定位偏移触发），失败分类：`no_path`（无解）、`no_chunk`、`cost_limit`、`cancelled`。

## D3 步行执行器与稳定瞄准（增量 2，含 G）

- 逐 waypoint 执行：look 到位 → 按键段（sprint/jump/前进）→ 到达判定（半径 ≤0.35）→ 下一段。
- **稳定瞄准（相对 Baritone 的核心改进）**：进入挖掘/放置子目标后，look 锁定目标方块直至完成；仅用 `world.getBlock` 轮询进度判定（如空气/换块），中途不因移动/跳跃改视角。回归用例：连续挖 3 个方块零重置。
- 卡死恢复（G）：连续 N=12 tick 位移 <0.1 → 退后/侧移/原地跳三选一 → 重规划同代价；累计 M=3 次仍无位移 → `stuck` 类型化失败（有界，不空转）。
- 到达后置条件沿用现有距离核对（新鲜快照）；`checked` 语义不变。

## D4 交互执行：门、垫脚、搭桥、游泳（增量 3）

- 门/栅栏门/活板门：优先 `useEntity`/`useItem` 打开；仅在 `allowBreak=true` 且无通行替代（绕行代价 > 破坏授权阈值）时才破坏。
- 垫脚/搭桥（垂直 1–2 格、1–4 格沟）：`inventory.selectHotbar` 选择可放置方块（优先圆石/泥土等廉价块）→ 对准目标面 `interact.placeBlock`；放置后校验方块存在，失败重试一次再降级重规划。
- 游泳/上岸：水中以 look+前进游向最近可站岸点（对齐 Phase 0 的"水面齐沿可游出"）；水面低于沿且无放置/破坏时 → `no_path`。
- 破坏（仅 `allowBreak=true`）：沿用已有 `interact.breakBlock` 轮询，命中 D3 的稳定瞄准。

## D5 安全与边界

- 默认 `allowBreak=false`：移动不会拆房子、拆门；破坏需显式参数（Phase 2 可引入"授权清单"）。
- 夜间/危险环境不改变策略：反射（MC-0d）优先，被反射打断按既有回执语义结算。
- 不引入新的信任/证据面：移动与放置只是动作，回执仍由 main 核对；`checked` 仅来自后置条件。
- 不做"自动战斗/清怪"，遇到敌对实体按 `entityCost` 绕行或返回 `blocked_by_entity`。

## D6 验收夹具（沿用 Phase 0 测试台）

测试台保留：x 68–92，地板 y=66，z −22–2；Baritone 基线见 spike 文档。

| 夹具 | 期望（terrain 规划器） |
| --- | --- |
| 水面齐沿水坑 | 游出并到达，≤5s |
| 门房 | 开门进入；门与墙零破坏 |
| 全宽 3 格沟 | 跳跃或搭桥通过；允许放置，禁止破坏 |
| 全宽二格墙 | 垫 1 块翻越（或绕行若存在） |
| 沿高 2 水坑（`allowPlace=true`） | 垫 1 块脱困 |
| 物理无解几何（allowBreak/Place=false） | `no_path` 明确拒绝，不空转 |
| 5 格落差 | 允许坠落并按 `maxFall` 评估；落差 >4 时拒绝或寻替代 |
| 稳定瞄准回归 | 连续挖 3 个方块，进度零重置（对照 Baritone 的弱点） |
| 卡死恢复 | 封闭目标：3 次升级后 `stuck` 有界失败 |
| 用户事故回归 | 最初卡水域坐标（三面高一格）：`allowPlace=true` 下垫出；false 下 `no_path` |

## 实现落点

- `apps/stage-tamagotchi/src/main/services/airi/game-host/movement/`：`snapshot.ts`（区域读取与缓存）、`costs.ts`（代价模型）、`planner.ts`（A* + 动态重算）、`executor.ts`（TerrainMover/瞄准/卡死恢复）、`interact.ts`（门/放置/破坏/游泳）、`types.ts`。
- `game-host/index.ts`：`game_move_to` 接入 terrain 规划器与新参数、错误分类透传、租约/取消复用。
- 测试：movement 单元（代价图、A*、瞄准状态机、卡死恢复）+ 真机夹具（上表）。

## 增量拆分

1. **增量 1**：快照 + 代价图 + A*（纯函数，单测覆盖 mineflayer 默认代价与样例几何）。
2. **增量 2**：步行执行器 + 稳定瞄准 + 卡死恢复 + `game_move_to` 接线；真机跑齐沿水坑/断桥/落差。
3. **增量 3**：门/垫脚/搭桥/水；真机跑门房/二格墙/沿高 2 水坑/无解拒绝/事故回归。
4. **验收记录**：`docs/fork/evidence/mc-3/phase-1-*.md`，逐项对照 Baritone 基线。

## 风险与回退

- 规划器误判地形：以夹具矩阵 + 真实游玩抽测；必要时 `movement.planner='legacy'` 回退 mod 侧 nav。
- 放置/破坏的资源消耗：默认 `allowBreak=false`、`placeCost` 促使优先绕行；垫脚只选廉价方块。
- 性能：区域读取限包围盒 + 规划内缓存；采样频率与现有 `game_status` 轮询一致。
- 与反射竞争：反射优先不变；被反射打断的移动按既有回执结算。

## 明确不做（Phase 1）

- 骑乘/载具（船/马/矿车）与飞行（鞘翅/炽足兽）→ Phase 2/3。
- PvP、战斗机动、自动清怪。
- 远程/跨维度、服务器管理动作。
- 落地水缓冲（B2）：登记为 Phase 1 候选后续，避免与背包/水桶逻辑耦合过深。

## 本轮交付与检查

仅新增本文档并更新 MODS 索引；未改产品代码。

## 实施记录（2026-09-13，增量 1）

- 新增 `apps/stage-tamagotchi/src/main/services/airi/game-host/movement/`：`types.ts`（快照/节点/动作/配置）、`block-view.ts`（方块分类表：空气/液体/门/活板门/栅栏门/半砖/地毯/重力块/不可破坏；未知方块一律视为实体障碍）、`snapshot.ts`（区域快照与 BlockSource）、`movements.ts`（mineflayer `movements.js` 2.4.5 移植：getMoveForward/JumpUp/Diagonal/DropDown/Down/Up/ParkourForward、getLandingBlock、safeOrBreak、getNeighbors）、`planner.ts`（二叉堆 A*、octile 启发、`no_path`/`no_chunk`/`cost_limit`/`timeout` 分类）。
- 移植取舍：跳过实体索引与 exclusion areas（保留 `getNumEntitiesAt` 缝）；挖掘工时以硬度近似上游 digTime（`(1 + 15×hardness) × digCost`）；缺块默认 `no_chunk`（测试可 `stub`）；门处理从上游的栅栏门扩展到 `_door/_trapdoor` 并修复"门上半格挡住头部"的移植缺口。
- 测试 22 例：分类表 7、平地行走（步数/代价）、无路检测、墙（禁挖 `no_path` / 允许挖穿）、全宽 3 格沟（疾跑跳 / 禁跳时搭桥 3 块 / 两者皆禁 `no_path`）、干坑（禁放 `no_path` / 允许时垫塔）、落差（`maxDropDown` 拒绝 / 允许）、门（`use` 不破坏 / 禁开禁挖 `no_path`）、`no_chunk`、节点预算 `cost_limit`。
- 检查：movement 测试 22/22；stage-tamagotchi typecheck 0；eslint 0。
- 待续：增量 2（步行执行器 + 稳定瞄准 + 卡死恢复 + `game_move_to` 接线）。

## 实施记录（2026-09-13，增量 2）

- 新增 `movement/port.ts`（执行端口：getState/getBlocksRegion/look/setInput/stopMovement/jumpOnce）、`movement/region.ts`（按 X 切片读取，单次 ≤30k 方块；包围盒 start/goal ±8 水平、−4/+6 垂直并夹到世界高度）、`movement/executor.ts`（`runTerrainMove`）。
- 执行语义：逐 waypoint 走位；锁定瞄准（每个 tick 重瞄，偏差 >25° 才转视角）；疾跑/跳跃/水中持续跳跃；parkour 在起跳沿 0.8 格内按一次跳；卡死判定 12 tick 位移 <0.15 → 退/侧/跳恢复 → 重规划（默认 3 次升级后 `stuck`）；结果分类 `reached`/`no_path`/`no_chunk`/`cost_limit`/`timeout`/`stuck`/`unsupported_action`/`cancelled`。
- 快照边界：边界外的缺块按障碍 stub（上游行为）；**边界内**缺块才报 `no_chunk`（planner 增 `PlanSuccess.missing`）。
- 接线：`GameHostConfig.movement.planner`（`terrain`/`legacy`，读写/视图/apply 均支持）；`game_move_to` 参数扩展 `allowBreak`（默认 false）/`allowPlace`（默认 false→true 语义：显式 false 才禁）/`maxFall`（1–32）；`get_inventory` 统计垫脚方块数。**默认仍为 `legacy`**（NOTICE：增量 3 完成破/放/用后再翻默认），避免未实现动作的路径回归。
- 测试：movement 31/31（含区域切片、走位、parkour 跳、`unsupported_action`、`no_chunk`、`stuck`、取消）；game-host 78 passed（新增配置往返）。typecheck/eslint 0。
- 真机（2026-09-13，见 [evidence/mc-3/phase-1-increment-2-20260913.md](./evidence/mc-3/phase-1-increment-2-20260913.md)）：断桥 parkour PASS（1.6s、距离 0.32）；落差 `maxFall=6` PASS（5.7s）；默认落差与二格墙落在 `unsupported_action` 边界（放置/破坏未实现）；水面齐沿水坑因缺"游泳爬出"移动落在 `unsupported_action`。
- 修复：宿主端口工具名 `set_movement`（首轮误用 `set_input` 导致不动 → `stuck`）；抽出 `movement/host-port.ts` 并加映射单测。
- 待续：增量 3（破坏/放置/开门执行 + 稳定瞄准的挖掘轮询 + `swim-shore` 移动 + 默认翻到 `terrain` + 真机五夹具）。

## 实施记录（2026-09-13，增量 3）

- 交互执行：`executor.ts` 增 `breakBlockStable`（**启动一次** + 每 1.2s 重试 + 轮询间锁定瞄准）、`placeBlockStable`（选垫脚方块、选支撑面、放置后校验、柱高先跳）、`useBlockStable`、`chooseSupport`、`ensureScaffolding`；`performStepActions` 在走每个 waypoint 前按序执行 break/place/use，失败进入卡死恢复。
- `swim-shore` 移动（movements 扩展）：双脚在液体中时可移动到上方 1–2 格、下方为实体的安全岸点（代价 1+liquid+0.5/级），关闭增量 2 的水坑缺口。
- 工具名修复：**`interact.useItem` 是空气右键**（mod `gm.useItem`），开门必须走 `useItemOn`——`host-port.ts` 的 `useBlock` 改用 `place_block`（`interact.placeBlock`）并加 NOTICE；`host-port` 新增 `getBlock`/`getInventory`/`breakBlock`/`placeBlock`/`useBlock`/`selectHotbar` 映射与单测。
- 默认翻到 `terrain`（`movementPlannerOf()`）；`legacy` 保留为显式回退；registry 旧用例在测试中显式使用 `legacy`。调试轨迹由 `AIRI_TERRAIN_DEBUG` 控制。
- 真机（见 [evidence/mc-3/phase-1-increment-3-20260913.md](./evidence/mc-3/phase-1-increment-3-20260913.md)）：水坑（swim-shore）、门房（开门）、断桥（parkour）、二格墙（垫步）、封闭石室（稳定瞄准挖掘 ×3）全部 PASS；落差默认 `unreachable`、`maxFall:6` PASS。
- 测试：movement 38/38（分类/规划/执行/动作/边界/区域/端口映射）、game-host 85 passed；typecheck/eslint 0。
- 待续：Phase 2（船/马/矿车）与 Phase 3（鞘翅/炽足兽）按立项分期另行启动。
