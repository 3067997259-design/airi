# MC-2a 增量 2 真机：只读 jar 解析与探针（2026-09-13）

范围：main 只读 jar 读取（白名单/上限/根目录约束）、共享纯解析器、`#/devtools/mc2` 探针。

## 实现

- `src/shared/mc2/recipe.ts`（纯函数，主/渲染共用）：条目白名单（`data/**/recipe[s]/**.json`、`data/**/tags/**`、`assets/**/lang/*.json`、AE2 guide、Patchouli）、`recipeIdFromEntryPath`、`entryPathForRecipe`、`parseRecipeCandidate`（shaped/shapeless/cutting 等原样保留）、`fitsPlayerGrid`（≤2×2）。
- `src/main/services/airi/mc2/mod-data.ts`：`readJarEntries`（根目录约束、jar ≤64 MiB、条目 ≤2 万、返回文本 ≤2 MiB、JSZip 只读、不执行包内代码）；错误类型化 `jar_not_allowed`/`jar_missing`/`jar_too_large`/`too_many_entries`。
- `src/shared/eventa/mc2.ts`：`airi:mc2:read-jar` 契约；main `services/airi/mc2/index.ts` 注册 handler（根目录来自 `AIRI_MC2_JAR_ROOTS`，分号分隔）。
- `src/renderer/pages/devtools/mc2.vue`：`window.__AIRI_MC2_SMOKE__` 暴露 `readJar`/`readRecipe`/`listRecipes`。

## 真机结果（FD 1.3.4 jar，根目录 = 夹具 mods）

| 调用 | 结果 |
| --- | --- |
| `readRecipe farmersdelight:flint_knife` | `{type:'minecraft:crafting_shaped', pattern:['m','s'], result:{flint_knife,1}, fits:true}` |
| `readRecipe farmersdelight:cutting_board` | `pattern:['/##','/##'], fits:false`（3 列，符合预期） |
| `listRecipes '/recipe/'` | **count=333**，含 `farmersdelight:acacia_cabinet` 等样例，`truncated=false` |
| `readJar` 越界路径（`D:\airi\package.json`） | 拒绝：`mc2 jar_not_allowed: jar path is outside the configured roots` |

## 测试与检查

- `mod-data.test.ts` 8/8（临时 zip：白名单过滤、精确路径、越界拒绝、缺失 jar；纯解析：id/路径推导、2×2 判定、未知类型保留、坏 JSON 拒绝）。
- stage-tamagotchi typecheck/eslint 0；应用重建并以 `AIRI_MC2_JAR_ROOTS` 启动验证。

## 说明

- 根目录是显式配置（环境变量），默认空 = 一律拒绝；jar 只读、不执行。
- AE2 guide（125 md）与 Patchouli（56 JSON）条目在白名单中，随增量 3 一起入库时可复用同一读取路径。
