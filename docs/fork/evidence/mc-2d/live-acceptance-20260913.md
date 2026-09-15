# MC-2d 真机验收：探索流程固化为经审阅技能（2026-09-13）

范围：增量 1（`craft` 域动作 + `game_craft` 桥工具）、增量 2（`learn-recipe` 技能 + runner skill 模式）、增量 3（五类 + 闭环）。

## 夹具与前置

- 技能产物：`D:\airi\skills\learn-recipe`（`source.mjs` + `meta.json`：`tools: ['game_status','game_craft']`、`execution.timeoutMs: 60000`），经 `#/devtools/packages` 探针 `createReviewedSkill` 创建并走审阅批准。
- 原版配方夹具 jar：`…\versions\1.21.1-NeoForge-MC2\mc2-fixtures\vanilla-recipes-1.21.1.jar`（从版本 jar 抽 `data/minecraft/recipe/**` 1290 条，414 KB；版本 jar 本体 2 万+ 条目会被 MC-2 条目上限拒绝，故抽小夹具；`AIRI_MC2_JAR_ROOTS` 已含版本目录）。
- 材料来源（世界无作弊）：`game_craft('minecraft:stick')` 由库存木板合法合成（2 木板 → 4 木棍），并作为增量 1 成功路径验收。

## 增量 1：`craft` 域动作（真机）

| 用例 | 操作 | 结果 |
| --- | --- | --- |
| 成功 | `executeGameTool('game_craft', { recipeId: 'minecraft:stick' })` | `ok/checked:true`，`postCondition {kind:'crafted', target:4, actual:4, met:true}`，`crafted {output stick×4, attempts:2, inventoryDelta {oak_planks:-2, stick:+4}}`（delta 同时出现 `sand:+1` 为窗口内无关拾取，后置条件只核对产出物；runner 侧再按配方核对具体材料） |
| 失败 | `craft_by_recipe='cutting_board'`（3 列） | `failed/checked:false`，`endReason: executor_error: craft failed: recipe_needs_crafting_table`，无 `crafted` 字段 |
| 文案修复 | `iron_knife`（缺铁，5 拍未领取） | 修复前 `craft failed: crafted`（误导）；修复后 `craft failed: not_confirmed`（含单测） |

## 增量 2：技能与 runner 衔接（真机）

- `exploreOnce({ itemId: 'minecraft:stick', jarPath: <vanilla fixture>, mode: 'skill' })`：
  `reuse-check:done:no fresh knowledge > jar:done:candidate recorded > web:skipped > craft:done:skill receipt verified (attempts=2) > record:done:tier=verified`；第二次 → `reused:true`（零技能调用）。
- 卡：`minecraft:stick：2×1 图案 ["#","#"]，材料 #=minecraft:planks；产出 minecraft:stick×4；来源 data/minecraft/recipe/stick.json；模组 minecraft 1.21.1`，`tier=verified/fresh`。
- 途中修复：`knowledgeMatchesTarget` 改为只看卡片"主语段"（首个全角冒号前），避免材料列表提到目标物品导致误复用（单测覆盖）。

## 增量 3：五类情形（真机）

| 情形 | 操作 | 结果 |
| --- | --- | --- |
| 成功（runner） | skill 模式闭环（上） | 技能回执核对 → `verified` |
| 成功（适配器） | `wrap` → `executeTool('learn_recipe')` | 返回 `{output stick×4, checked:true, postCondition met}` |
| 缺条件 | `iron_knife`（缺铁） | `[runtime] craft did not verify: executor_error: craft failed: not_confirmed`，runner/技能均无假成功 |
| 取消 | 运行中 abort（`executeReviewedSkill(..., { signal })`，700ms） | `[sandbox] Sandbox worker aborted: This operation was aborted`；游戏命令经桥取消 |
| 撤销 | 运行中 `unwrapReviewedSkill` | 在途调用结算 `{"status":"revoked", ...result is discarded}`；工具面移除；重复 unwrap 幂等 |
| 内容变更 | 改盘 `source.mjs` → 执行；随后 `applyContentChange`+`readForReview`+`approve` 原地重审 | 改盘后：`Skill "learn-recipe" is blocked: Skill source changed. Submit the new source for review.` 且 `reviewedSkills()` 移除；重审后恢复可执行（`cutting_board` → 诚实 `recipe_needs_crafting_table`，证明已在审阅下运行） |

## 观察与遗留

- 中途 abort 的合成可能留下已放置的配方网格；下一次 `craft_by_recipe` 领取时会一并产出（本次出现 planks −4/stick +8 的双份输出）。delta 与后置条件仍如实（`actual ≥ target`）；fixture 层面记为观察项。
- 材料消耗：木板耗尽（0），木棍 12；`flint` 仍未获得（砾石沉积在 (35,48,31) 附近，`game_move_to` 因 `cost_limit` 未到达，`game_collect` 因 `reflex_preempted` 中止）。flint_knife 的 skill 模式复验留待材料补充后。
- 固定夹具保留：`skills/learn-recipe`（工作区 `D:\airi`）、vanilla 配方夹具 jar；清理方式同 MC-1c（`reject` 技能 + 删目录 + 删夹具 jar）。

## 检查

- 单测：game-host 103（含 craft 成功/失败/耗尽/单写者）、mc2 shared 35（含 `classifyCraftDelta`/目标匹配）、coding-host 桥工具 8 项；eslint 0；stage-tamagotchi typecheck 0；应用多次重建/重启。
