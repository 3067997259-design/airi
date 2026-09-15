# MC-2b 增量 3 真机：分级提升与五场景（2026-09-13）

范围：web 线索分级提升（lead→candidate→verified）、modset 失效、重启复用与诚实边界。

## 实现

- `knowledgeMarker(tier, modset, extras)` 支持附带来源键（web 卡带 `web=<encodeURIComponent(url)>`），`parseWebMarker` 读回 URL；`parseKnowledgeMarker` 改为键值扫描（兼容扩展键，保留 tier/modset）。
- 探针：`promoteLead(originId, jarPath, recipeId)`（先检查线索是否提到该配方名，再读 jar 配方，重写卡片为 `candidate` + `交叉核对` 说明）、`markLeadVerified(originId, how)`（重写为 `verified` + 核实说明）；会话内 lead 缓存优先、缓存缺失（重启后）才重取 URL。
- 探针 `writeFact` 诚实失败（`captureTurn` 空返回即抛错），本轮所有写入均为真实持久化。

## 结果（真机）

| 场景 | 操作 | 结果 |
| --- | --- | --- |
| 学习-web | `webLearn('https://zh.minecraft.wiki/w/燧石')` | lead 卡：标题「燧石 - 中文 Minecraft Wiki」、URL、抓取日期；查询可命中 |
| 交叉-负例 | 对燧石页 `promoteLead(..., 'farmersdelight:flint_knife')` | **诚实拒绝**：`lead does not reference the recipe (no cross-check basis)`（页面未提该配方） |
| 交叉-正例 | 夹具事实页（"crafted with one flint above one stick in a 2x2 grid"）→ `promoteLead` | `candidate`：`交叉核对：与 data/farmersdelight/recipe/flint_knife.json 数据一致`；marker `tier=candidate … web=…` |
| 实测升级 | 游戏内两拍合成 1 次（刀 6→7、燧石/木棍各 4→3）→ `markLeadVerified` | `verified`：卡片含「核实：游戏内按页面配方随身合成 1 次，库存前后核对（刀 +1、燧石/木棍各 -1）」 |
| 查询排序 | `queryKnowledge('flint knife 配方 燧石 刀')` | 命中：verified web (1.137) > 旧 recipe candidate（stale）(1.136) > injection lead (1.095) |
| 诚实-未知 | `queryKnowledge('totally_unknown_thing_xyz')` | 0 命中 |
| 边界-web注入 | 注入夹具 `webLearnText`（含英/中"忽略指令/调用工具/标 verified"） | `lead` 卡 + `注入嫌疑：ignore-instructions、ignore-instructions-zh、tool-call、mark-verified、tool-name（仅审计，未执行）`；无工具调用、无权限变化、不入 verified |
| 重启-复用 | 重启应用后查询 | `verified/fresh:true`（web）、`lead/fresh:true`（注入夹具）；tier/来源/时间持久 |
| 失效-版本 | `setMods` 把 FD 改 9.9.9 → 查询 | web `verified` 降级 `candidate/stale:true`；注入 `lead` 标 `stale:true`；旧 recipe candidate 同样 stale |
| 恢复 | `setMods` 恢复 1.3.4 → 查询 | `verified/fresh:true`、`lead/fresh:true` 恢复 |

## 说明与限制

- 直连可达性（本网络）：`zh.minecraft.wiki` 可直连；fandom 直连不可达（代理可用但主进程 fetch 不走系统代理）；github 域名解析到 CGNAT 被 SSRF 守卫拒绝（按设计）；MC百科物品页为 JS 渲染、抓取文本为站点导航（不可用）。因此"与 jar 配方一致"的正例用夹具事实页承载；真实网页拉取由中文 wiki 页证明。
- 重启后对夹具 URL（`fixture.example`）再提升会诚实失败（缓存空且 URL 不可解析）；真实可达 URL 会重取后继续。夹具事实保留用于复用验证。
- 注入嫌疑仅为审计标注；完成门仍只认 game-host 回执（MC-1c 规则不变）。

## 检查

- 单测 21/21（含 marker 扩展键）；eslint 0；stage-tamagotchi typecheck 0；应用三次重建/重启。
