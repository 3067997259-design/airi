# MC-2a 规范：新内容知识获取（配方/用途/机制）

日期：2026-09-13。状态：规范定稿，实施未开始。上游：[MC-2 立项](./mc-2-content-mod-exploration.md)（M2-D1~D7）、[Minecraft 执行计划](./minecraft-execution-plan.md) MC-2a 行。依赖：MC-1b ✓、MQ-2 ✓（记忆质量闸门）、EP-1（本批不需固化技能，MC-2d 条件子批再谈）。

通过条件（计划原文）：**无预置知识下学会 ≥1 个配方/用途，并用游戏内可核对动作验证；查询命中带来源、时间与有效期；模组版本变化后旧记录不再当事实。**

本批只做 E1（类 1，时间不敏感）+ E3 的摄取先行；默认关闭；不新建记忆引擎（M2-D1）。

## 现状与侦察（2026-09-13）

- 夹具：`versions\1.21.1-NeoForge-MC2`（NeoForge 21.1.233 + Connector）已含 AE2 19.2.17、Create 6.0.10、FD 1.3.4、车万女仆 1.5.3、WDA、Patchouli/GuideME；mcpfabric 桥可用（含 MC-3 期间新增 RPC）。
- 数据可解析：FD jar 含 333 个 recipe JSON；例如 `data/farmersdelight/recipe/cutting_board.json` 为 **2×2 有formula配方**（3× `minecraft:planks` tag + 2× `minecraft:stick` → 1 切菜板）。主进程已有 `jszip`，可只读解析 jar（不需要游戏运行）。
- **能力缺口（开放问题 1 的答案）**：桥没有合成动作——客户端配方书 / 服务端交互 / mod 侧新增三选一，本批选 **mod 侧新增 `craft.byRecipe`**（最可控、可核对、与 fork 既有补丁方式一致）。
- 记忆写入：沿用 `captureTurn` + 自定义 extractor（MQ-2 对照评估已验证该路径可写 `originId/reviewStatus` 事实）；不新建存储。

## D1 数据只读解析（main）

- 新增 `apps/stage-tamagotchi/src/main/services/airi/mc2/mod-data.ts`：
  - 输入：jar 绝对路径 + 白名单（`data/**/recipe*/**/*.json`、`data/**/tags/**`、`assets/**/lang/*.json`、AE2 `assets/ae2/ae2guide/**/*.md`、Patchouli `data/**/patchouli_books/**`）；单 jar 体积与条目上限（默认 64 MiB / 2 万条），只读、不解压执行。
  - 输出：`{ path, entryPath, json | text }`；解析 recipe JSON 为结构化候选（`type/result/ingredients|key|pattern`），保留原始 JSON 供复核。
- 入口：eventa 契约 `airi:mc2:read-jar`（main handler 读文件系统）；渲染端 devtools 探针驱动（见 D5）。
- 安全：**不执行包内代码**（M2-D4）；路径必须落在配置的 jar 列表内；错误类型化（`jar_missing`/`entry_missing`/`too_large`）。

## D2 合成动作（mcpfabric fork 补丁）

- 新增 RPC `craft.byRecipe { recipeId }` 与 MCP 工具 `craft_by_recipe`（**两拍协议**，集成服务器延迟结算）：
  - 校验：配方存在、类型为 `crafting_shaped|shapeless`、且能放入随身 2×2（shaped 宽高 ≤2；shapeless ≤4 材料）；否则返回类型化 `error`（`unknown_recipe`/`unsupported_recipe_type`/`recipe_needs_crafting_table`），不动网格。
  - 每拍：结果槽已填充 → **先领取**（读取真实堆叠并 quick-move，返回 `claimed`+`output`）；否则清理网格残留后 `handlePlaceRecipe`（返回 `placed`+`expected`）。调用方循环至 `claimed`；材料不足时结果槽为空，诚实失败。
- 证据：合成后由调用方用 `get_inventory` 前后读数核对（M2-D2 实测级）；合成回执属游戏动作，不产生 `checked` 领域回执。
- v1 目标配方：`farmersdelight:flint_knife`（1×2，材料 `minecraft:flint`+`stick`，真机 PASS，消耗正确）。**切菜板是 3 列图案**，需 3×3/工作台合成，留待后续能力（原规范中的"2×2"判断已修正）。

## D3 知识契约（与 MQ 记忆 schema 对齐）

- 事实以 `memory_fragments` 存储；约定：
  - `originId = mc2:<modId>:<recipeId>`（幂等更新用）；
  - `tags = [mc2, mod:<modId>, modset:<hash>, tier:<candidate|verified|lead>, kind:<recipe|use|guide>]`；
  - `content` 为人类可读知识卡（示例）：
    `FD 切菜板 farmersdelight:cutting_board：随身 2×2 配方 = 3×木板(tag minecraft:planks) + 2×木棍；来源 data/farmersdelight/recipe/cutting_board.json；模组 FD 1.3.4；核实：随身合成 1 次，库存 +1（2026-09-13）。`
  - 世界绑定沿用 `MemorySourceContext`（MC-1b 的 gameWorld）；模组集信息写入 tags。
- `modsetHash`：夹具固定模组集（M2-D4）按 `(modId, modVersion)` 排序后哈希；解析与入库都带该值。
- **有效期（M2-D3）**：查询时比较当前 modsetHash 与记录 tags；不一致的记录降级为 `candidate` 并标注“需复核”，不得当事实使用。
- 分级（M2-D2）：`candidate`（本地数据解析）/ `verified`（实测核对）/ `lead`（web，MC-2b）。

## D4 模型面（v1 最小）

- v1 由**显式请求**驱动（用户/探针），不接 life-mode 空闲循环（MC-2c 再做）；不新增模型工具面——摄取与合成经 devtools 探针执行，知识查询经现有记忆召回（`retrieve`）验证"命中带来源/时间/有效期"。
- 探针：`#/devtools/mc2`，暴露 `readJar`（D1）、`ingestRecipe`（解析→候选入库）、`craftRecipe`（D2）、`markVerified`（实测核对后升级）、`queryKnowledge`（按 item 检索并返回分级与新鲜度）、`setModsetHash`（失效演练）。

## 增量拆分

1. **增量 1**：D2 mod 补丁（`craft.byRecipe` + 工具）+ 单测 + 真机合成切菜板；材料链可用（木板/木棍）。
2. **增量 2**：D1 main 只读解析（`mod-data.ts`、eventa 契约、白名单与上限）+ 单测；探针 `readJar/ingestRecipe`。
3. **增量 3**：D3 知识入库/召回/有效期（`captureTurn` 写入、tags/originId、modsetHash 比对降级）+ 探针 `markVerified/queryKnowledge`。
4. **增量 4（真机验收）**：五场景——学习-配方、复用（重启后）、失效-版本、诚实-未知、预算/开关默认关闭；记录 `docs/fork/evidence/mc-2a/*.md`。

## 验收场景（映射立项文档）

| 场景 | 操作 | 期望 |
| --- | --- | --- |
| 学习-配方 | 只给 `farmersdelight:cutting_board`（不给配方） | 解析数据 → 候选知识卡；随身合成成功（库存前后读数 +1）→ `verified` |
| 复用-配方 | 重启应用与会话后再问 | 直接命中 `verified`，返回来源文件、时间、模组版本；不再解析/实验 |
| 失效-版本 | 改 modsetHash（模拟升级） | 旧记录降级 `candidate` 并提示复核，不按旧配方直接开做 |
| 诚实-未知 | 查询不存在的物品（如 `farmersdelight:not_a_thing`） | 明确“不知道”+可执行获取计划；不编造、不把 candidate 当 verified |
| 开关-默认关闭 | 关闭 MC-2 开关 | 不监听、不解析、不合成；行为回到 MC-1 |

（web 注入与预算-收敛分别留 MC-2b/MC-2c。）

## 实现落点

- mod fork：`InteractHandlers`/新 `CraftHandlers`（`craft.byRecipe`）+ mcp-server `tools.ts`（`craft_by_recipe`）。
- main：`services/airi/mc2/{mod-data.ts,modset.ts}`、`shared/eventa/mc2.ts`、`main/index.ts` 接线。
- renderer：`pages/devtools/mc2.vue` 探针（驱 D1/D3）；知识写入用 `captureTurn`（custom extractor）。
- 测试：mod 侧真机合成；main 解析单测（白名单/上限/坏 jar）；探针脚本与验收记录。

## 风险与回退

- 合成实现差异（配方类型/材料 tag）：v1 限 2×2 shaped/shapeless；失败返回类型化原因，不伪造。
- tag 材料（如 `minecraft:planks`）需要按 tag 展开可用物品：v1 由探针传入候选物品（如 oak_planks）并在知识卡中保留 tag 语义。
- 解析成本：白名单 + 上限；大 jar 只取目标条目，不全量读。
- 回退：MC-2 开关默认关闭；入库知识可按 `modset:<hash>` / `originId` 前缀清理（记忆线既有能力）。

## 明确不做（本批）

- MC-2b（web 学习）、MC-2c（好奇心循环）、MC-2d（技能固化）。
- Create/AE2 的可玩实测（NeoForge jar 仅做只读摄取先行；AE2 指南 markdown 入库作为增量 2 的扩展样例）。
- 自动下载/安装模组、执行模组代码、3×3 工作台合成与容器 GUI 自动化。

## 本轮交付与检查

仅新增本文档并更新 MODS 索引；未改产品代码、未跑游戏。实施从增量 1（mod `craft.byRecipe` 真机合成切菜板）开始。

## 实施记录（2026-09-13，增量 1）

- **mod fork 补丁**：`CraftHandlers.java` 的 `craft.byRecipe`（两拍协议：`placed`/`claimed`；2×2 尺寸守卫；claim-first 顺序）+ MCP 工具 `craft_by_recipe`；jar 迭代 `47c74c40…→105cf3fe…→c2b5ff40…`。
- **真机**：`farmersdelight:flint_knife`（1×2）合成 PASS——`placed→claimed`、材料正确扣减（燧石/木棍各 −1）；3 宽配方守卫返回 `recipe_needs_crafting_table` 且零消耗。**修正**：首目标切菜板实为 3 列图案（需工作台），已改列后续能力。
- 途中修掉：同步多拍不可靠（改两拍）、清理先于领取导致材料退回（改 claim-first）、尺寸守卫缺失（部分放置留残渣）。
- 记录见 [evidence/mc-2a/increment-1-craft-20260913.md](./evidence/mc-2a/increment-1-craft-20260913.md)。测试：mod 编译 + 真机核对；无产品代码改动。待续：增量 2（main 只读 jar 解析 + `#/devtools/mc2` 探针）。

## 实施记录（2026-09-13，增量 2）

- `shared/mc2/recipe.ts`（白名单、id/路径推导、候选解析、2×2 判定）+ `shared/eventa/mc2.ts`（`airi:mc2:read-jar`）+ main `services/airi/mc2/{mod-data.ts,index.ts}`（根目录约束、jar/条目/文本上限、JSZip 只读、错误类型化）+ 探针 `#/devtools/mc2`（`__AIRI_MC2_SMOKE__`：readJar/readRecipe/listRecipes）。
- 真机：FD jar `flint_knife` 解析正确且 `fits:true`；`cutting_board` `fits:false`；`/recipe/` **333 条**；越界路径 `mc2 jar_not_allowed`。记录见 [evidence/mc-2a/increment-2-parse-20260913.md](./evidence/mc-2a/increment-2-parse-20260913.md)。
- 测试 8/8；typecheck/eslint 0；应用以 `AIRI_MC2_JAR_ROOTS` 启动。待续：增量 3（知识入库/召回/有效期）。

## 实施记录（2026-09-13，增量 3 + 增量 4 真机验收）

- `shared/mc2/knowledge.ts`：`modsetHash`（排序 `id@version` FNV-1a）、`knowledgeTags`、卡片格式化与机器可读标记 `[mc2 tier=… modset=…]`、`parseKnowledgeMarker`。
- 探针 `#/devtools/mc2` 扩展：`setMods/getModsetHash/ingestRecipe/markVerified/listKnowledge/queryKnowledge/resetKnowledge`；事实经 `captureTurn` 写入（`originId=mc2:<recipeId>`、`reviewStatus=approved`，真实 tags 写入 `memory_tags`）。
- **v1 表示决策**：`memory.list/retrieve` 不返回标签（标签在独立表），tier/modset 从卡片标记读回；真实 tags 仍写入，后续可用标签 join 替换标记。
- 真机五场景全 PASS：学习（候选卡）→ 复用（`candidate/fresh`）→ 实测升级（合成库存核对 → `verified`）→ 失效（modset 变更 → `candidate/stale`）→ 诚实未知（0 命中）→ 恢复版本（`verified`）→ **重启后复用**（`verified/fresh` 持久化）；默认关闭以根目录白名单 + 仅探针触发为代理证据（越界 `mc2 jar_not_allowed`）。
- 测试 13/13；typecheck/eslint 0。记录见 [evidence/mc-2a/increment-3-knowledge-20260913.md](./evidence/mc-2a/increment-3-knowledge-20260913.md)。MC-2a 核心（学习/复用/失效/诚实/开关）验收完成；后续子批：MC-2b（引导/上网补全）、MC-2c（多步任务）、MC-2d（固化技能）。
