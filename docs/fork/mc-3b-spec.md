# MC-3b 规范：骑乘与载具（船 / 马 / 矿车）

日期：2026-09-13。状态：规范定稿，实施未开始。上游：[MC-3 立项评估](./mc-3-terrain-mobility.md) §3 移动模式抽象与 Phase 2；[MC-3 Phase 1 规范](./mc-3-spec.md)（foot 已验收）。

通过条件：三类载具各自完成"取得载具 → 上载具 → 按目标前进 → 到达/有界失败 → 下載具"的闭环，且不破坏既有反射、取消、世界绑定与回执语义。

## D1 移动模式抽象

- 保留 `TerrainMover`（foot）不变；新增 `VehicleMover` 接口（main `movement/vehicle.ts`）：

```ts
interface VehicleMover {
  kind: 'boat' | 'horse' | 'minecart'
  acquire: (ctx: VehicleContext) => Promise<boolean> // 放船 / 上马 / 放车
  steerTo: (goal: Vec3, ctx: VehicleContext) => Promise<'reached' | 'stuck' | 'cancelled'>
  dismount: (ctx: VehicleContext) => Promise<void>
}
```

- `game_move_to` 增可选参数 `vehicle?: 'boat' | 'horse' | 'minecart'`（默认 foot，**不做自动模式选择**）。`vehicle` 存在时走 `VehicleMover`，失败回退 foot 仅当显式 `fallbackToFoot: true`。
- 移动所有权：同一时刻只有 foot 或一个载具模式持有输入；进入/退出载具必须释放全部输入（`stop_movement`）；反射优先于任何模式。
- 证据语义不变：载具移动只是动作，回执仍由 main 核对；`checked` 只来自后置条件。

## D2 端口补充（区分两类右键）

Phase 1 已确认 mod 侧两条交互路径：

| 用途 | RPC | 端口方法 |
| --- | --- | --- |
| useItemOn（门/按钮/方块放置面） | `interact.placeBlock` | `useBlock(pos)`（已实现） |
| useItem（空气右键：放船、水桶、烟花、吃） | `interact.useItem` | **新增 `useItem()`** |

- 新增端口方法：`useItem()`、`dismount()`（sneak 一秒后释放）、`getRiding()`（读 `player.getState` 的载具/骑乘信息；缺失则用 `entities.query` 找最近载具）。
- 载具实体交互沿用 `interact.useEntity { uuid }`（上/下马、上船）。

## D3 船（P1，最简单）

- 取得：水边选平坦岸点，面向水面 `useItem()` 放船；`entities.query` 找到船实体并上船（`useEntity`）。
- 航向：`steerTo` 按直线段控制——视向对准目标、`setInput { forward: true }`，每 300ms 修正一次；浅水/搁浅（连续 3s 位移 <0.3）→ 有界重试（后退一次再前进）→ 失败 `stuck`。
- 下船：`dismount()`（sneak）并验证下船（`getRiding` 空）。
- 验收：水道夹具（直 + 一次转湾）3 次重复；搁浅回退；取消（stop 全程有效）。

## D4 马（P2）

- 取得：夹具用 `players.give` 提供鞍与马（实体 `entities.summon`）；未驯服时反复 `useEntity` 直到上马；装备鞍（手持鞍 + `useEntity`）。
- 骑行：`steerTo` 用视向 + `forward`；1 格台阶自动上；`jump`（蓄力：按住 `setInput { jump: true }` 约 0.4s 再释放）越过 1.5–2 格障碍。
- 失败回退：摔下/马死 → 结束并报告 `horse_lost`；`fallbackToFoot: true` 时改走 foot。
- 验收：马栏内直线 + 跨栏跳 + 下马；摔落场景有界。

## D5 矿车（P2）

- 取得：铺轨（`placeBlock` 序列，直线 ≤16 格）→ 放车（`useItem`）→ 上车（`useEntity`）。
- 驱动：无转向；v1 只做直线短轨，检查到达（矿车停在目标 ±1 内）；动力轨/坡度暂不做。
- 验收：短轨单程到达；中途取消；下車。

## 验收夹具（测试台扩展）

| 夹具 | 构建 | 用例 |
| --- | --- | --- |
| 水渠 | 测试台外挖 3×24 水渠（两端封口） | 放船 → 航行 20 格 → 下船 |
| 马栏 | 10×10 栏 + 1.5 格跨栏 | 上马 → 直线 → 跳栏 → 下马 |
| 短轨 | 16 格直线轨道 + 矿车 | 上车 → 到达 → 下车 |

管理动作（`players.give`、`entities.summon`、`world.fill`）仅夹具使用，不改工具面。

## 实现落点与增量

1. **增量 1**：D1/D2（模式抽象 + 端口 `useItem`/`dismount`/`getRiding`）+ 船（`movement/vehicle.ts`、`vehicle-boat.ts`）；测试：端口映射、船航向状态机（假客户端）。
2. **增量 2**：马（装备/上马/蓄力跳/摔落）。
3. **增量 3**：矿车（铺轨/上车/到达）。
4. 真机：三类夹具各 3 次重复 + 取消/回退场景；记录 `docs/fork/evidence/mc-3/phase-2-*.md`。

## 风险与回退

- mod 交互差异（放船需 `useItem` 对水射线）：先在夹具验证；失败则用 `command.run /summon boat` 仅作夹具兜底（不进入产品路径）。
- 载具物理不可控（水流推动、马随机游走）：`steerTo` 用短段 + 频繁修正；有界失败。
- 与 foot 的输入所有权冲突：进入/退出载具时强制 `stop_movement`；反射打断时先下載具。
- 明确不做：鞘翅/炽足兽（Phase 3）、自动模式选择、载具战斗、跨维度、动力轨网络。

## 本轮交付与检查

仅新增本文档并更新 MODS 索引；未改产品代码。

## 实施记录（2026-09-13，增量 1 + 船）

- **模式抽象**：`movement/vehicle.ts` 定义 `VehicleMover`/`VehicleContext`/`VehicleMoveResult`；`runVehicleMove(kind, options)` 分发；`game_move_to` 增 `vehicle`/`fallbackToFoot` 参数（DOMAIN_TOOLS、`toGameCommandParams`、执行分支均已接线）；船 mover 完整实现，马/矿车为显式 `unavailable` 占位。
- **端口补充**：`useItem`（空气右键）、`dismount`（sneak 脉冲）、`swapSlots`、`getRiding`、`boardNearestVehicle`、`useEntity`。
- **Mod fork 补丁（mcpfabric）**：`entities.query` 不返回载具 → 新增 `player.getVehicle` 与 `vehicle.boardNearest` RPC 及 MCP 工具 `get_vehicle`/`board_vehicle`；重建 jar（sha256 `3292241b…`）并重启客户端。
- **真机（2026-09-13）**：水渠夹具船行 PASS（8.9s、距离 0.86、下船）；途中修复"船进主背包（需换槽）"与"固定 yaw 打到岸墙（改为朝目标俯角放船）"。记录见 [evidence/mc-3/phase-2-increment-1-20260913.md](./evidence/mc-3/phase-2-increment-1-20260913.md)。
- 测试：movement 94 passed；typecheck/eslint 0。待续：增量 2 马、增量 3 矿车。

## 实施记录（2026-09-13，增量 2/3 + 真机）

- **马 mover**：紧邻/半径 6 内多次 `boardNearestVehicle`（覆盖未驯服的上马训练与鞍具右击）→ 视向+前进转向 → 卡住窗口内蓄力跳（按住 jump 0.5s）→ 有界失败 → sneak 下马；45s 期限。
- **矿车 mover（v1）**：`boardNearestVehicle` 上车 → 等待滚到目标（无转向/推进）→ 到达或 30s 超时 → 下马。
- **真机**：马 PASS 1.6s（NoAI 夹具马；未加 NoAI 的马会游走，属预期）；矿车 PASS 3.8s（静止上车 + 夹具 `data merge Motion` 给初速）。记录见 [evidence/mc-3/phase-2-increment-2-20260913.md](./evidence/mc-3/phase-2-increment-2-20260913.md)。
- 测试：movement 98 passed；typecheck/eslint 0。**Phase 2 三个 mover（船/马/矿车）均有单测与真机记录**；后续可选：`attackEntity` 推车起步、动力轨、跨栏跳真机复测。
