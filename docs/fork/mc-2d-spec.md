# MC-2d 规范：探索流程固化为经审阅技能（"学会一个配方"类）

日期：2026-09-13。状态：规范定稿；增量 1–3 已实施并通过五类真机验收（见文末实施记录）。上游：[MC-2 立项](./mc-2-content-mod-exploration.md) MC-2d（条件批，**用户显式开启**）、[Minecraft 执行计划](./minecraft-execution-plan.md) MC-2d 行。依赖：MC-2c ✓（探索循环与实验步骤）、MC-1c ✓（审阅技能、声明门、取消/撤销）、EP-0/EP-1 ✓（工具标识与适配器）。EP-2a 包分发**本批不走**（见"明确不做"）。

通过条件（计划原文）：**复用 SG/EP 审阅与修订五类情形可核对**（成功、缺条件、取消、撤销、内容变更）。

## 现状与侦察（2026-09-13）

- **探索循环已就绪**（MC-2c）：`exploreOnce` 的 craft 步骤现由探针直接调用 MCP 工具（`electronMcpCallTool` → `craft_by_recipe` 两拍 + `get_inventory` 前后读数）。
- **技能执行面**：沙箱 `bridge()` 工具表 = `createGameBridgeTools` 的 7 个域动作（`game_observe/status/move_to/say/collect/follow/cancel`），全部经 main `GameCommandPort` → `command-registry`（去重键 = 连接代次 + 命令 ID、租约、写动作门、终态回执与后置条件）；`WRITE_ACTIONS = {move_to, collect, say, follow}`。
- **技能声明**（MC-1c）：`meta.json` 的 `tools: string[]`（只接受 `game_*` 桥名）+ `execution.timeoutMs`；批准绑定 `reviewedTools` 精确匹配；桥层白名单；未声明调用 `not_allowed` 并写 journal。
- **缺口**：桥没有合成动作（craft 只在 MCP 工具面，不在 game-host 域动作里），因此"把实验步骤固化进技能"当前不可行；探索与技能的衔接（runner 调技能而不是直接 MCP）也没有路径。

## D1 `craft` 领域动作（game-host，复用 MC-0b 契约）

- `GameDomainAction` += `'craft'`；参数 `{ recipeId: string }`；进入 `WRITE_ACTIONS`（去重/租约/单写者/取消一致）。
- 执行器（main）：
  - `craft_by_recipe` 两拍循环（≤ `attempts` 上限，默认 5，间隔 400ms）；`placed` 继续、`claimed` 结束、`error` 立即类型化失败；
  - 合成前后各读一次 `get_inventory`；`expected` 由 main 侧配方数据推导（result + 具体材料；**tag 材料不计入 delta**并记录 tag 列表）；
  - 取消：每拍之间检查取消位；取消后不再发起新拍（残留网格由既有工具语义处理，回执 `cancelled`）。
- 回执/后置条件：`crafted { result, consumed, tagMaterials, attempts }`；`postCondition.kind='crafted'`，`target = result.count`，`actual = 库存 delta`，`met` = 逐项匹配（具体材料差为 −n）；未确认/读数缺失 → `met:false`，不伪造成功。
- 类型化错误：`unknown_recipe`、`recipe_needs_crafting_table`、`materials_missing`、`not_confirmed`、`mcp_unavailable`（沿用命令错误模型，进 journal）。
- 领域工具描述（`gameHostListDomainTools`）同步加 `craft` 的参数 schema（模型面可见）。

## D2 桥工具 `game_craft`（技能沙箱）

- `game-bridge-tools.ts` 增 `{ name: 'game_craft', action: 'craft' }`；描述复用语域工具 schema。
- 声明门沿用 MC-1c：技能 `meta.json` 的 `tools` 必须含 `game_craft`；`reviewedTools` 精确匹配；未声明调用 `not_allowed`。
- 超时/租约：craft 单次为短动作（≤ 60s），桥超时随程序超时派生，不短于单拍等待窗口。

## D3 "学会一个配方"技能（`learn-recipe`）

- 固定夹具技能（fork 内产物，非包分发）：`source.mjs` 流程 `game_status`（连接/身份）→ `game_craft({ recipeId })` → 汇总回执（result/consumed/tagMaterials/attempts）；`meta.json`：`tools: ['game_status','game_craft']`、`execution.timeoutMs = 60_000`。
- **边界（重要）**：技能只负责**游戏内实验与核对**；知识入库/检索（记忆事实、modset 有效期）仍由 MC-2c runner（渲染端）负责。这是有意的分工：沙箱在 main，记忆事实在渲染端存储；跨进程桥不在本批扩张。
- 审批/修订走 MC-1c 既有流程（hash 绑定、`reviewedTools`、重审恢复）；技能视为"可复用的实验器"。

## D4 runner 衔接（MC-2c 探针）

- `exploreOnce({ itemId, jarPath, mode: 'direct' | 'skill' })`：
  - `direct`（默认，保留 MC-2c 证据可复现）：现有 MCP 直连路径；
  - `skill`：craft 步骤改为执行已批准 `learn-recipe`（渲染端 coding-host 客户端传入 `recipeId`），以技能回执替代 MCP 直连读数；未批准/哈希不符 → `craft:failed` 类型化原因（不静默降级）。
- 其余步骤（reuse-check/jar/web/record）不变；trace 记录 `mode` 与实际使用者。

## D5 验收（五类情形，映射 MC-1c）

| 情形 | 操作 | 期望 |
| --- | --- | --- |
| 成功 | 有材料 + `mode:'skill'` 探索 flint_knife | 技能执行 → `crafted` 回执（材料 −1、成品 +1）→ runner 记录 `verified` |
| 缺条件 | 材料不足 | 类型化 `materials_missing`/`not_confirmed`；技能 `failed`；runner 保持 `candidate` |
| 取消 | 运行中 cancel | 回执 `cancelled`；沙箱终止；迟到结果不入完成门（EP-0 语义） |
| 撤销 | 运行中 unwrap 技能 | 工具面消失、`revoked`、幂等 |
| 内容变更 | 改 source 或 `tools` 声明 | 执行被拒（`hash_mismatch`/`skill_tools_changed`）；重审后恢复；在途按 D3 终止 |
| 闭环-技能 | `mode:'skill'` 完整探索（删知识 → 技能实验 → verified → 二次复用） | 同 MC-2c 闭环，实验步骤 usage 标记 `skill` |

## 增量拆分

1. **增量 1**：D1 `craft` 域动作 + 单测（参数/后置条件/取消/错误映射；两拍与库存读用注入的 MCP 调用桩）+ D2 桥工具 `game_craft` + 单测；真机：经 `gameHostExecuteCommand` 合成 flint_knife（材料核对）。
2. **增量 2**：D3 `learn-recipe` 技能产物 + 审批绑定 + D4 runner `mode:'skill'`；单测（桥声明门/哈希不符拒绝）。
3. **增量 3**：D5 五类 + 闭环真机验收；证据 `docs/fork/evidence/mc-2d/*.md`；MODS 收尾（MC-2 主线完成）。

## 实现落点

- main：`game-host/{command-contract.ts,command-registry.ts,index.ts}`（动作/执行器/后置条件）、`coding-host/{game-bridge-tools.ts}`（桥工具）。
- 渲染端：`pages/devtools/mc2.vue`（`mode:'skill'` 分支）、既有 coding-host 客户端与 skills store（执行/取消/撤销）。
- 技能产物：fork 内固定夹具技能（`learn-recipe`），沿用 MC-1c 审阅存储位置。

## 风险与回退

- MCP 工具名/读数形状变化：动态查找 + 类型化 `mcp_unavailable`，不猜。
- 两拍竞态/材料被并发消耗：去重 + 单写者门 + 每次合成前重新读数；失败分类如实。
- tag 材料无法核对：只核 result 与具体材料，tag 记录在案（与 MC-2c 一致）。
- 回退：`mode` 缺省 `direct`（MC-2c 行为不变）；技能未批准时 `skill` 路径明确失败。

## 明确不做（本批）

- EP-2a 包分发/跨会话分发、MC-2 之外的新知识来源。
- 把记忆写入搬进 main（跨进程桥扩张）；模型自由设计实验。
- 新游戏动作（除 `craft`）、容器 GUI、3×3 工作台合成。

## 本轮交付与检查

仅新增本文档并更新 MODS 索引；未改产品代码、未跑游戏。实施从增量 1（`craft` 域动作 + `game_craft`）开始。

## 实施记录

### 增量 1–3（2026-09-13，MC-2d 完成）

- **增量 1**：`craft` 域动作（`command-contract.ts` 动作/参数/后置条件 `crafted`；`command-registry.ts` 进 `WRITE_ACTIONS`、receipt/outcome 携带 `crafted` 回执；`game-host/index.ts` 执行器：MCP 两拍 ≤5 次 + 前后 `get_inventory` 读数 + `inventoryDeltaOf`，类型化失败，60s 租约；`shared/eventa/game-host.ts` 类型同步）+ `game_craft` 桥工具。真机：`minecraft:stick` 成功（目标 4/实际 4）、`cutting_board` 诚实失败、缺材料修复为 `not_confirmed`。
- **增量 2**：固定夹具技能 `learn-recipe`（`game_status → game_craft`，`tools` 声明 + 60s）经审阅创建；runner `mode:'skill'`（`executeReviewedSkill`，未批准/无回执类型化失败）。真机：skill 模式闭环 → `verified`，二次复用零技能调用。
- **增量 3 五类全 PASS**：成功（runner + 适配器）、缺条件、取消（沙箱 abort）、撤销（`revoked` + 工具面移除 + 幂等）、内容变更（改盘阻断 + 原地重审恢复）；另修 `knowledgeMatchesTarget` 主语段匹配与 `craft failed: not_confirmed` 文案。
- 夹具：`D:\airi\skills\learn-recipe`、`mc2-fixtures/vanilla-recipes-1.21.1.jar`（原版配方抽取）；材料经合法合成获得（世界无作弊）。
- 单测 game-host 103 / mc2 35 / 桥工具 8；eslint/typecheck 0。记录 [evidence/mc-2d/live-acceptance-20260913.md](./evidence/mc-2d/live-acceptance-20260913.md)。**MC-2d 完成，MC-2 内容探索主线收尾**；MC 线剩余：MC-3c Phase 3（鞘翅/炽足兽，条件草案）与 MC-0a 遗留（环境 B、1.21.11 冒烟、资源测量、设置页走查）。
