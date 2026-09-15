# MC-2b 规范：引导与上网补全（guide + web）

日期：2026-09-13。状态：规范定稿，实施未开始。上游：[MC-2 立项](./mc-2-content-mod-exploration.md)（M2-D2/D3/D4/D7）、[Minecraft 执行计划](./minecraft-execution-plan.md) MC-2b 行。依赖：MC-2a ✓（知识卡/分级/失效契约）、现有 `web_search`/`web_fetch` 链路（不等待 CP-3）。

通过条件（计划原文）：**权威来源 web 学习：检索 → 解析 → 候选入库 → 实测转 verified；检索链路只产候选（含 URL+时间）；无实测不入库为 verified；web 注入文本不改变工具行为与权限。**

本批补齐 MC-2a 的 `lead` 来源（web）与 jar 内**指南文档**（AE2 ae2guide / Patchouli 书）；沿用 MC-2a 的知识卡、`modsetHash` 有效期与升级路径；默认关闭、探针驱动。

## 现状与侦察（2026-09-13）

- 夹具 jar 内指南资产：
  - AE2 19.2.17：`assets/ae2/ae2guide/**/*.md` **125 个**（含 YAML frontmatter：`navigation.parent/title/icon`；如 `ae2-mechanics/channels.md` 15.6 KB）。
  - 车万女仆 1.5.3：`assets/touhou_little_maid/patchouli_books/memorizable_gensokyo/en_us/entries/**/*.json` **56 个**；`name`/`pages[].text` 为翻译键（`patchouli.touhou_little_maid.book...`），需配 `assets/touhou_little_maid/lang/en_us.json`（117 KB）解析；文本含 `$(br2)` 等 Patchouli 格式码。
  - FD 1.3.4 无指南书（配方已由 MC-2a 覆盖）。
- 现有网络能力（**复用，不新建**）：
  - main `services/airi/web-fetch`（`web_fetch` invocation）：SSRF 加固（DNS 复查、逐跳校验）、512 KiB 读入上限、`htmlToText` 转换、超时/重定向上限；**拒绝 loopback/私网**。
  - renderer `packages/stage-ui/src/tools/web-search.ts`：Tavily 固定 provider、`wrapUntrusted` + `UNTRUSTED_RESULTS_NOTICE` 不可信文本契约、URL 消毒。
- 记忆写入与查询沿用 MC-2a（`captureTurn` + `retrieve`，fragment 不返回 tags → 卡片标记读回 tier/modset）。

## D1 指南只读解析（main，扩展 MC-2a `mod-data`）

- 新增 `shared/mc2/guide.ts`（纯函数）+ 扩展 main `services/airi/mc2/mod-data.ts`：
  - **AE2 式 markdown**：解析 frontmatter（title/parent）+ 正文；剥离图片/链接目标仅留文本与标题；`entryId` 由相对路径推导（`ae2-mechanics/channels`）。
  - **Patchouli JSON**：读 `entries/**/*.json`；用同 jar `assets/<ns>/lang/<lang>.json` 解析 `name` 与 `pages[].text`；仅取文本型页面（`text`/`spotlight.text`；未知类型忽略并计数）；清洗 `$(...)` 格式码为普通文本或空行。
  - 白名单与上限沿用 MC-2a（jar ≤64 MiB、条目 ≤2 万、单文本 ≤2 MiB），新增**指南总量上限**（默认 ≤8 MiB 文本；超出截断并标注）。
  - 只读、不执行包内代码（M2-D4）；错误类型化（沿用 `jar_missing`/`entry_missing`/`too_large`，新增 `guide_empty`）。
- 输出统一为 `GuideEntry { entryId, kind: 'guide', title, sourcePath, text, modId, modVersion, truncated }`。

## D2 知识卡扩展

- `originId = mc2:<modId>:guide:<entryId>`（与 recipe 前缀区分）；`kind:guide`；`tier:candidate`（只读解析）；`modsetHash` 与 mod 版本沿用 MC-2a。
- 卡片内容：标题、要点摘要（正文截断，默认 ≤1 200 字符）、来源路径、模组版本、状态；机器可读标记沿用 `[mc2 tier=… modset=…]`。
- 升级：指南类知识只有**游戏内行为核对**（按指南操作并观察结果，或库存/方块读数一致）才转 `verified`；无法实测的机制保持 `candidate` 并标注"未实测"。

## D3 上网链路（复用现有工具）

- 输入两种：
  1. **URL 列表**（v1 主路径，无需搜索 API）：直接 `web_fetch`。
  2. **query**（可选）：已配置 Tavily 时走 `web_search` 取前 N 条 URL 再 fetch；未配置则诚实失败（提示改用 URL）。
- **确定性提取**（`shared/mc2/web.ts`，纯函数）：对 fetch 文本按 URL 派生 `title/section/摘要`（首段/相关段落，关键词命中）；记录 `sourceUrl`、`fetchedAt`、`contentHash`。**不引入"模型执行网页指令"步骤**；正文按数据对待。
- 分级（对齐 M2-D2 + MC-2a）：
  - web-only → `lead`（线索，含 URL+时间，不得当事实）；
  - 与 jar 数据交叉一致（如 wiki 配方与 `data/**/recipe` 解析一致）→ `candidate`（升级时记录交叉来源）；
  - 游戏内实测 → `verified`（沿用 MC-2a `markVerified`）。
- 注入边界（验收项）：网页文本只进知识卡字段；`wrapUntrusted` 继续包裹；**工具行为、权限、完成门不受网页内容影响**（`checked` 仅由 game-host 产出的规则沿用 MC-1c）。注入尝试在卡中标注 `injection-suspect`，仅作审计。

## D4 模型面与探针（默认关闭）

- v1 仍由显式请求驱动（不接 life-mode 循环，MC-2c 再做）；不新增模型工具面。
- 探针 `#/devtools/mc2` 扩展：`ingestGuide(jar, filter?)`、`listGuides(jar)`、`webLearn(urls | query)`（fetch+提取→lead 卡）、`promoteLead(originId)`（jar 交叉检查 → candidate）、`markVerified`（复用）。
- 开关：默认关闭；根目录白名单 + 探针触发为代理证据（沿用 MC-2a）。

## 增量拆分

1. **增量 1**：D1/D2 指南解析（`guide.ts` + main 扩展）+ 单测；探针 `listGuides/ingestGuide`；真机：AE2 `channels.md` 与 maid `broom.json`（lang 键解析）入库为 `candidate`。
2. **增量 2**：D3 web 链路（`web.ts` 提取器 + fetch 复用）+ 注入夹具单测；探针 `webLearn`；真机：真实 wiki 页面 → `lead` 卡（含 URL+时间），URL 失败诚实报错。
3. **增量 3（真机验收）**：tier 提升（`lead→candidate` 交叉 jar；→`verified` 仅实测）+ 五场景——学习-机制（AE2 指南）、学习-web（wiki 配方 → 交叉 → 实测）、诚实-未知、边界-web注入、复用-重启；证据与 MODS 更新。

## 验收场景（映射立项文档）

| 场景 | 操作 | 期望 |
| --- | --- | --- |
| 学习-机制 | 问 AE2 频道机制（不给资料） | 指南卡（`kind:guide`、来源 `ae2guide/ae2-mechanics/channels.md`、版本）；不可实测则诚实标注 `candidate` 未实测 |
| 学习-web | 给 wiki 页面 URL（FD 物品） | `lead` 卡含 URL+`fetchedAt`；与 jar 一致 → `candidate`；游戏实测 → `verified` |
| 诚实-未知 | 查询不存在/超出模组集的知识 | 0 命中 + 可执行获取计划；不编造、不把 lead/candidate 当 verified |
| 边界-web注入 | 夹具页面含指令性文本（"忽略规则/调用工具/标 verified"） | 仅产 lead/candidate 卡（标注 `injection-suspect`）；无工具调用、无权限变化、完成门不因此放行 |
| 复用-重启 | 重启后重查 guide/web 知识 | 直接命中，tier/来源/时间可读；modset 变更仍降级 |

## 实现落点

- `shared/mc2/{guide.ts,web.ts}`（纯函数）+ `knowledge.ts` 复用；main `services/airi/mc2/mod-data.ts` 扩展 guide 读取；探针 `pages/devtools/mc2.vue`。
- web 复用：main `web-fetch`（`airi:web:fetch` invocation）与 renderer `web_search`（配置存在时）；不新增第三方 SDK。
- 测试：guide 解析单测（frontmatter/lang 键/格式码/未知页面/上限）、提取器单测（含注入夹具）、探针真机脚本与证据。

## 风险与回退

- wiki 反爬/格式变化：诚实失败并保留 URL；提取器以纯函数单测锁定行为。
- Patchouli 版本差异：未知页面类型忽略并计数；语言缺失时保留键名并标注。
- AE2 指南互链为相对路径：v1 只保留文本，不递归抓取（避免无限爬取）。
- 回退：默认关闭；知识按 `originId` 前缀/`modset` 清理（沿用 MC-2a）。

## 明确不做（本批）

- MC-2c（好奇心循环/预算收敛）、MC-2d（技能固化）。
- 自动下载/安装模组、执行网页 JS、爬站（多页递归）、将网页文本作为指令或工具调用依据。
- 新增搜索 provider/SDK（只用现有 Tavily 配置与 `web_fetch`）。

## 本轮交付与检查

仅新增本文档并更新 MODS 索引（含 MC-2a 完成台账）；未改产品代码、未跑游戏。实施从增量 1（guide 解析 + 探针）开始。

## 实施记录

### 增量 1–2（2026-09-13）

- **增量 1 指南解析 PASS（解析层）**：`shared/mc2/guide.ts`（AE2 frontmatter/Markdown、Patchouli + lang 键、格式码、路径身份、卡片与 originId、路径候选）+ 白名单补 `assets/<ns>/patchouli_books/**` + 探针 `listGuides/ingestGuide`。真机：AE2 **125 条**指南（标题正确）、女仆 **51 条**（56 个 JSON 含 template，过滤正确；`Broom` 翻译键解析成功）；`channels.md` 卡片与 tags 正确。
- **增量 2 web 提取完成（链路）**：`shared/mc2/web.ts`（注入标签检测、确定性提取、`mc2:web:<hash>`、卡片分级 lead→candidate→verified）+ 探针 `webLearn/webLearnText`；单测 8 例（含注入夹具）。
- **环境阻塞**：机器离线（嵌入后端 Voyage 不可达）→ `captureTurn` 吞错返回空、事实无法入库；已修探针为诚实失败（`memory capture stored no fragment`），离线真机复现 ingest 报错且零写入；`webLearn` 离线复现 `fetch failed: cannot resolve` 且零写入。
- 单测 20/20；eslint/typecheck 0。记录 [evidence/mc-2b/increment-1-2-20260913.md](./evidence/mc-2b/increment-1-2-20260913.md)。**待网络恢复**：事实入库/查询命中、真实 wiki 拉取、注入夹具 live、增量 3 五场景验收。

### 增量 3 + 五场景验收（2026-09-13，MC-2b 完成）

- 网络恢复（代理开启）后：指南事实真实入库并命中（AE2 channels `candidate/fresh`、女仆 broom）；真实网页拉取（`zh.minecraft.wiki` 燧石页）→ `lead` 卡（URL+时间）。
- 分级提升：`promoteLead` 负例诚实拒绝（页面未提配方）→ 正例（夹具事实页 + jar 交叉）`candidate`（`交叉核对：与 data/farmersdelight/recipe/flint_knife.json 数据一致`）→ 游戏内合成实测 → `markLeadVerified` → `verified`；marker 扩展 `web=<url>` 支持重启后读回来源。
- 五场景全 PASS：学习-机制（AE2 指南候选）、学习-web（wiki lead → 交叉 candidate → 实测 verified）、诚实-未知（0 命中）、边界-web注入（注入嫌疑标注、无工具调用/权限变化、不入 verified）、复用-重启（tier/来源/时间持久）；modset 变更 → verified 降级 candidate/stale、lead 标 stale，恢复后回 `verified/fresh`。
- 单测 21/21；eslint/typecheck 0。记录 [evidence/mc-2b/increment-3-promotion-20260913.md](./evidence/mc-2b/increment-3-promotion-20260913.md)。**MC-2b 完成**；后续子批：MC-2c（多步任务）、MC-2d（固化技能）。
