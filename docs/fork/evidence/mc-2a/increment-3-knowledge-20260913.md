# MC-2a 增量 3/4 真机：知识入库、有效期与五场景（2026-09-13）

范围：知识事实写入/核实/检索/有效期（增量 3）与验收场景（增量 4）。

## 实现要点

- `shared/mc2/knowledge.ts`：`modsetHash`（排序 `id@version` 的 FNV-1a）、`knowledgeTags`（`mod:<id>`/`modset:<hash>`/`tier:<candidate|verified>`/`kind:recipe`）、`formatRecipeKnowledgeCard`（含机器可读标记 `[mc2 tier=… modset=…]`）、`parseKnowledgeMarker`。
- 探针 `#/devtools/mc2` 新增：`setMods/getModsetHash`、`ingestRecipe`、`markVerified`、`listKnowledge`、`queryKnowledge`、`resetKnowledge`；事实经 `captureTurn`（`originId=mc2:<recipeId>`、`reviewStatus=approved`、真实 tags 写入 `memory_tags`）。
- **表示说明（v1）**：`memory.list/retrieve` 返回的 fragment 不含标签（标签在独立 `memory_tags` 表），因此 tier/modset 由卡片标记读回；真实 tags 仍会写入，后续可用标签 join 替换标记，无需重新入库。

## 验收场景结果

| 场景 | 操作 | 结果 |
| --- | --- | --- |
| 学习-配方 | `ingestRecipe farmersdelight:flint_knife`（不给配方，只读 jar 解析） | 候选卡：`2×1 图案 ["m","s"]，材料 m=minecraft:flint、s=minecraft:stick；产出 flint_knife×1；来源 data/farmersdelight/recipe/flint_knife.json；模组 farmersdelight 1.3.4；状态：候选（未实测）` |
| 复用-配方（同会话） | `queryKnowledge('farmersdelight:flint_knife')` | `tier=candidate, fresh=true, score=1.115`（命中带来源/时间/版本） |
| 实测升级 | 两拍合成 1 次（刀 5→6、燧石/木棍各 5→4）→ `markVerified` | 卡片改为 `核实：随身合成 1 次，库存前后核对（…）`；查询 `tier=verified, fresh=true` |
| 失效-版本 | `setMods` 把 FD 改为 9.9.9 → 查询 | `tier=candidate, fresh=false, stale=true`（降级复核，不当事实） |
| 诚实-未知 | 查询 `farmersdelight:not_a_thing_xyz` | 0 命中（不编造） |
| 恢复版本 | `setMods` 恢复 1.3.4 → 查询 | `tier=verified, fresh=true` |
| 复用-配方（重启后） | 重启应用 → `listKnowledge/queryKnowledge` | 仍为 `verified/fresh=true`，来源与核实信息可读 |
| 开关-默认关闭（代理证据） | 根目录白名单（`AIRI_MC2_JAR_ROOTS`）与探针 | 越界路径被拒 `mc2 jar_not_allowed`；无任何产品路径监听/解析/合成（仅探针与显式调用触发） |

## 测试与检查

- 单测 13/13（`shared/mc2/knowledge.test.ts` 5、`mod-data.test.ts` 8）；stage-tamagotchi typecheck/eslint 0。
- 应用两次重建/重启（`AIRI_MC2_JAR_ROOTS` 指向夹具 mods）。
- 仓库级：`pnpm lint` **0 问题**（顺带修掉 `main/index.ts` 导入排序与 `docs/fork` 既有 markdown lint 基线：伪代码 fence 改 `text`、行尾空格/EOF、`A\*` 转义、`fs.test.ts` describe 小写）。`pnpm typecheck`（根递归）在 `packages/stage-ui` 处 Node 堆 OOM（基线环境限制，exit 134）；单包 `pnpm -F @proj-airi/stage-ui typecheck` 与 `pnpm -F @proj-airi/stage-tamagotchi typecheck` 均 0。

## 清理

- 夹具知识事实（`originId=mc2:farmersdelight:flint_knife`）保留用于后续复用测试；可用探针 `resetKnowledge()` 或按 `originId` 前缀清理。
- 遗留：多出的测试用 `flint_knife`（合成实测产物）。
