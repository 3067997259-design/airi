# MC-2c 规范：好奇心驱动的探索循环（未知 → 计划 → 实验 → 记录 → 复用）

日期：2026-09-13。状态：规范定稿；增量 1–3 已实施并通过真机验收（见文末实施记录）。上游：[MC-2 立项](./mc-2-content-mod-exploration.md)（M2-D5）、[Minecraft 执行计划](./minecraft-execution-plan.md) MC-2c 行。依赖：MC-2a ✓、MC-2b ✓（知识来源）、MC-1b 预算与 life-mode 空闲闸门、MC-1c game-host（观测）。不依赖 MC-2d（技能固化）。

通过条件（计划原文）：**空闲窗口内完成一次完整闭环（未知→学习→验证→记录→第二次直接复用）；预算耗尽/用户停止均有界收敛。**

本批只做**确定性探索运行器**（不做模型自由发挥的实验设计），默认关闭、探针驱动；产品自动触发留给后续（MC-2d/更高批）。

## 现状与侦察（2026-09-13）

- **知识侧已就绪**：MC-2a/2b 提供 jar 解析（候选）→ 交叉 → 实测升级（verified）→ 复用查询与 modset 失效降级；记忆事实 `captureTurn`/`retrieve` 已真机验证。
- **实验动作可用**：主进程 MCP stdio 管理器（`mcp-servers/index.ts`）经 eventa 暴露 `electronMcpListTools`/`electronMcpCallTool`；渲染端 `stores/tools/mcp.ts` 已在用。mcpfabric 工具含 **`craft_by_recipe`**（两拍 `placed`/`claimed`）与 **`get_inventory`**（库存前后读数）——闭环的"实验+核对"可完全在应用内完成，不再依赖操作者。
- **空闲闸门与预算**：life-mode（main `life-mode/index.ts`）提供心跳与**原子预算 claim**（`lifeModeClaimDecision`，校验 mode/预算/冷却/安静时段，`gate` 可归因），渲染端桥 `bridges/life-mode.ts` 暴露 `getSnapshot/setConfig/claimDecision/requestTestHeartbeat/recordGate`。生产 heartbeat 消费者（stage-ui `life-mode` store）负责社交决策；**本批不接生产路径**，探针用 `requestTestHeartbeat` + `claimDecision` 走同一原子闸门。
- **缺口 = 循环本体**：未知判定、计划（来源顺序）、有界实验、结果分类、trace 记录与复用判定目前都没有。

## D1 探索状态机（pure，`shared/mc2/explore.ts`）

- 目标：`ExplorationTarget { itemId, recipeId?, modId }`（v1 只处理配方类目标）。
- 计划：`planExploration(target, options)` → 有序步骤 `PlanStep[]`：
  1. `reuse-check`（查询记忆：verified/candidate 且 fresh → 直接复用，不再实验）；
  2. `jar`（读 jar 配方 → 候选）；
  3. `web`（可选，`allowWeb`；lead 交叉，MC-2b）；
  4. `craft`（MCP 两拍合成 + 库存前后读数 → 实测核对）；
  5. `record`（写事实：实测通过 → `verified`；仅解析/交叉 → `candidate`）。
- 预算：`ExplorationBudget { maxSteps, maxDurationMs, maxCraftAttempts }`；`stepAllowed(state, now)` 返回 `budget-steps`/`budget-time`；有界失败 `craft attempts` 上限。
- 分类：`classifyCraftObservation(before, after, expected)` → `verified`（库存差与配方一致）/`failed`（差值与预期不符）/`inconclusive`（读数缺失）。
- 停止：`stop(state, 'user'|'budget'|'error')` → 终态 `stopped`/`failed`，保留已完成步骤与原因（不伪造成功）。
- 复用判定：`shouldReuse(candidates)` → 仅 `tier∈{verified,candidate}` 且 `fresh` 才复用；`lead`/`stale` 不复用（stale → 重新走实验）。

## D2 运行器（探针 `#/devtools/mc2`）

- `exploreOnce({ itemId, budget, allowWeb? })`：执行 D1 计划；JAR 步骤复用 MC-2a 探针逻辑（`readCandidate`→`ingestRecipe`），实验步骤经 MCP：
  - `electronMcpListTools()` 动态查找工具名（不硬编码 server 名）：`craft_by_recipe`、`get_inventory`；
  - `craft_by_recipe` 两拍循环（≤ `maxCraftAttempts`，间隔重试）至 `claimed`；
  - `get_inventory` 前后读数 → `classifyCraftObservation`（物品差：目标 +1、材料按配方 −N）；
  - 通过 → `markVerified`（记录核实说明与库存差）；不通过 → 保持候选并记 `failed`。
- `exploreStop()`：置用户停止位；步骤间检查并终态 `stopped(user)`（用户停止优先于预算）。
- `exploreIdleOnce({ itemId, budget })`：空闲窗口入口——`lifeModeGetSnapshot()`；`mode==='off'` → `{ gated: 'mode' }` 不做工；`requestTestHeartbeat()` → 若被 gate 拒绝直接返回 `{ gated }`；`claimDecision(heartbeatId)` 原子 claim，未 claim 到（gate 或被他消费者抢走）→ 返回 `{ gated }` 不做工；claim 成功 → 跑 `exploreOnce`（心跳只发一次机会，消费即计入 MC-1b 预算）。
- `exploreTrace()`：返回最近一次运行的步骤/预算/终态（v1 内存 + 证据文档；journal 化留后续批）。
- 默认关闭：无探针调用则无任何循环；不使用模型、不新增模型工具面。

## D3 复用与失效

- 第二次对同一目标 `exploreOnce` → `reuse-check` 命中 `verified/fresh` → 返回 `reused: true`、`steps: ['reuse-check']`，**零实验**（不做 jar 解析、不发 MCP 调用）。
- modset 变更 → 事实 `stale` → 不复用 → 重新走计划（重新解析/实验，通过后重写 verified）。
- 诚实未知：目标不在 jar、web 无来源、实验无配方 → 终态 `failed` 且说明原因；不写入 verified。

## D4 安全与边界（沿用 M2-D4/D5）

- 默认关闭；仅探针显式请求触发；空闲入口必须通过 life-mode 原子 gate（预算/冷却/安静时段）才做工。
- 实验动作白名单：仅 `craft_by_recipe` + `get_inventory`（只读核对）；不做破坏性动作、不自动下载/安装、不执行包内代码。
- 到达 budget（步数/时长/尝试）即有界停止并留 trace；用户停止优先。
- trace 记录步骤、预算消耗与终态；不把网页/指南文本当指令（沿用 MC-2b 注入边界）。

## D5 验收场景（映射立项文档）

| 场景 | 操作 | 期望 |
| --- | --- | --- |
| 闭环 | 给一个未学过的配方目标 → `exploreOnce` | 未知识别 → 计划 → jar 候选 → MCP 合成实测（库存差核对）→ 记录 `verified`；trace 完整 |
| 复用 | 同目标第二次 `exploreOnce` | `reused: true`，零实验步骤（无 MCP 调用） |
| 空闲窗口 | `exploreIdleOnce`（mode off / gate 拒绝 / claim 成功三种） | off/拒绝 → 不做工且 `gated` 可归因；claim 成功 → 完成闭环且预算 +1 |
| 预算-收敛 | `maxSteps` 调小（或中途 `exploreStop()`） | 到界/停止即有界收敛，trace 记 `stopped(budget\|user)`；不伪造 verified |
| 失效重学 | 改 modset（模拟版本升级）后再 `exploreOnce` | 旧 verified 不复用 → 重新实验 → 通过后回 `verified/fresh` |
| 诚实未知 | 目标不在 jar/无来源 | `failed` + 原因；不写 verified |

## 夹具

- 已熟悉：`farmersdelight:flint_knife`（1×2，材料燧石+木棍；库存读数已验证）。
- 新目标候选（增量 1 时确认材料可得）：`farmersdelight:wheat_dough`（shapeless，需水桶）或其它 2×2 内 FD 配方；优先选"材料已在库存/可简单取得"的一个，避免把验收卡在取材上。
- 失败夹具：`farmersdelight:cutting_board`（3 列，随身 2×2 外）——计划应识别并诚实 `failed(unsupported)`，或降级为"需工作台"提示。

## 增量拆分

1. **增量 1**：D1 纯状态机 + 单测（计划顺序/预算/分类/复用判定/停止）；探针 `exploreOnce` 骨架（reuse-check + jar 步骤 + record，实验步骤先直连 MCP 的封装准备好）。
2. **增量 2**：D2 实验步骤（MCP 两拍 + 库存读数 + 分类）+ 预算/停止 + `exploreIdleOnce`（life-mode claim）+ `exploreTrace` + 单测。
3. **增量 3**：真机验收（闭环/复用/空闲窗口/预算收敛/失效重学/诚实未知）+ 证据 `docs/fork/evidence/mc-2c/*.md` + MODS。

## 实现落点

- `shared/mc2/explore.ts`（pure）+ `explore.test.ts`；探针 `pages/devtools/mc2.vue` 扩展（`exploreOnce/exploreStop/exploreIdleOnce/exploreTrace`）。
- 复用：`shared/mc2/{recipe,guide,web,knowledge}.ts`、探针既有 `readCandidate/ingestRecipe/markVerified/queryKnowledge`、`electronMcpCallTool`（渲染端既有用法见 `stores/tools/mcp.ts`）、`bridges/life-mode.ts`。
- 无 main 代码改动（v1 全在 shared + 探针）；若 MCP 调用需要新契约，再议。

## 风险与回退

- MCP 工具名/后缀变化：`listTools` 动态匹配 `craft_by_recipe`/`get_inventory`，缺失 → `failed(tool-missing)`，不猜。
- 两拍合成竞态：沿用 MC-2a 处理（循环重试 ≤ 上限，禁止重叠调用）。
- 库存读数含 tag 材料（如 planks tag）：v1 只核对**结果物品数**与**具体 item 材料**；tag 材料在知识卡保留语义、实验核对按实际消耗记录（不伪造）。
- 回退：默认关闭；停止优先；事实可 `resetKnowledge()` 清理。

## 明确不做（本批）

- MC-2d（固化技能为经审阅技能）、产品自动探索触发（不接生产 heartbeat 消费者/聊天循环）。
- 模型驱动的实验设计与自由探索（v1 确定性计划；多目标排队/优先级排序留后续）。
- 任意游戏动作实验（不含破坏/移动/容器 GUI）、自动下载或安装模组、跨世界/多人服务器。

## 本轮交付与检查

仅新增本文档并更新 MODS 索引；未改产品代码、未跑游戏。实施从增量 1（纯状态机 + 单测 + 探针骨架）开始。

## 实施记录

### 增量 1–3（2026-09-13，MC-2c 完成）

- **增量 1**：`shared/mc2/explore.ts` 纯状态机（计划顺序、预算、停止、分类、复用判定）+ 单测；探针 `exploreOnce/exploreStop/exploreTrace`；真机：复用命中（web verified 事实）、budget-time、user stop、未知目标 `jar:failed`。
- **增量 2**：MCP 实验步骤（`electronMcpListTools`/`electronMcpCallTool` 动态查找 `craft_by_recipe`/`get_inventory`；两拍循环 ≤ `maxCraftAttempts`；库存前后读数 → `classifyCraftObservation`）+ `exploreIdleOnce`（life-mode `requestTestHeartbeat` + 原子 `claimDecision`）+ `craftExpectation`（shaped/shapeless，tag 材料不计数）+ trace notes；探针补 `lifeSnapshot/lifeSetMode`。
- **增量 3 真机六场景全 PASS**：闭环（MCP 实测 → verified）、复用（零实验）、空闲窗口（autonomous claim 全闭环，预算 7→8；二次复用 8→9；非 autonomous gate 不做工）、预算-步数/时长与用户停止（有界收敛、skipped 不占预算）、失效重学（modset 变更 → stale → 全闭环 → verified）、诚实未知/缺材料（`jar:failed`、`craft-attempts` 不伪造 verified）。
- **途中修复**：复用误判（语义检索假阳性 → `knowledgeMatchesTarget`）；预算把 skipped 计步（`stepAllowed` 只计非 skipped）。
- 夹具前置：应用真实 userData `mcp.json` 注册 mcpfabric stdio（`%APPDATA%\@proj-airi\stage-tamagotchi\mcp.json`）。
- 单测 34/34；eslint/typecheck 0。记录 [evidence/mc-2c/live-acceptance-20260913.md](./evidence/mc-2c/live-acceptance-20260913.md)。**MC-2c 完成**；后续子批：MC-2d（固化技能，条件批）。
