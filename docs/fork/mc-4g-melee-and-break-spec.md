# MC-4g 近战攻击与单块破坏

日期：2026-09-14。状态：实施完成（代码 + 单测 + 类型检查）；真机验收待做。
上游：[能力缺口](./minecraft-player-capability-gaps.md) §2「挖矿与工具升级」「近战、自卫与保护玩家」（均 P1）、[能力复审](./minecraft-capability-review-20260914.md) R9（近战/击杀归属纪律）。

## D1 单块破坏 `game_break`（action `break`）

- 参数：`x/y/z`（必需）、`mode?: 'survival' | 'instant'`（默认 `survival`）。
- 流程：新鲜读方块 → 已是空气则 `already_air`；距离 > 4.5 格 `out_of_reach`（**不自动走路**，调用方先 `game_move_to`）→ `break_block` → 有界轮询（默认 10s，受信封期限限制）直到方块不再是原方块 → 确认 `broken`。
- 回执：`broken { x, y, z, blockId, mode, lastBlockId? }`；后置条件 `kind: 'broken'`（`met` 仅在新鲜读确认之后）。
- 不做拾取：掉落物留给 `game_collect` 或后续批次。

## D2 近战攻击 `game_attack`（action `attack`）

- 参数：`target`（名称 / uuid / 类型）、`maxSwings?: 1..8`（默认 1）、`weapon?: 'auto' | 'hand' | 'sword' | 'axe' | 'trident'`（默认 `auto`）。
- 武器选择：`auto` 按偏好取可用的最好近战武器（下界合金剑 > 钻石剑 > 铁剑 > 石剑 > 金剑 > 木剑 > 各材质斧 > 三叉戟 > 空手）；显式类别不可用 → `weapon_unavailable`。
- 流程：解析目标并**固定 uuid**；超出 3.5 格但在 12 格内时用至多 2 条地形腿接近；`look` 看向目标后 `attack_entity` 挥击（间隔 ≥ 700ms，遵守攻击冷却）；每次挥击后用新鲜查询核对证据。
- 回执：`attacked { targetUuid, swings, weapon, damageDealt?, healthBefore?, healthAfter?, hitEvidence?, killed? }`；`hitEvidence ∈ 'health_delta' | 'entity_death' | 'unobserved'`；后置条件 `kind: 'hit'`（`actual` = 观察到的命中次数）。
- 诚实性：只有观察到血量下降或实体消失才算命中/击杀；未观察不报 miss，也不做服务端杀伤归因（对齐 `game_shoot` 的纪律）。

## 验收

- 单测：game-host 定向 **213 passed / 1 skipped**；`typecheck` 0；改动文件 `eslint` 0。
- 真机（待做）：`game_break` 破坏放置原木（新鲜读确认空气、后置 met）；`game_attack` 击杀锚定尸壳（`killed` + `entity_death`）、对移动目标取 `health_delta`、空手回退。

## 复用与落点

- 契约：`command-contract.ts`（动作联合、参数、`GameBrokenReceipt`/`GameAttackedReceipt`、`broken`/`hit` 后置条件）；注册表 `WRITE_ACTIONS`；执行器 `index.ts`；事件形状 `shared/eventa/game-host.ts`；桥工具 `coding-host/game-bridge-tools.ts`。
- 复用：`resolveFollowTarget`/`readEntityByUuid`（目标解析与按 uuid 重读）、`runTerrainLeg`（有限接近）、`ensureItemSelected`/`ensureHandSelected`（由 `place` 的槽位助手泛化）。
