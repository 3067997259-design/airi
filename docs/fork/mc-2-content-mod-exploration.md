# MC-2：内容型模组探索实验批次

日期：2026-09-12。状态：立项（仅文档）。定位：Minecraft 线的**最后实验批次**，默认关闭。目标不是把某个内容模组打通关，而是验证一条学习回路：**AIRI 在无预置知识的前提下，能否自己获取"新内容"的配方与机制、验证、记住并复用**。

与 [Minecraft 接入执行计划](./minecraft-execution-plan.md) 的关系：MC-0x 建立执行与证据地基，MC-1x 建立任务、记忆与技能能力；MC-2 是这些能力在"未知内容"上的应用实验，不引入新的证据语义。

## 决策记录

| # | 决策 | 内容 | 理由与边界 |
| --- | --- | --- | --- |
| M2-D1 | 复用现有记忆与检索，不新建 RAG 引擎 | 配方/机制知识以结构化 fact 存入长期记忆（[MQ](./memory-quality-plan.md)、[MD](./maintainability-and-data-plan.md) 既有 `memory_fragments` + embedding 链路），检索走现有 recall；MC-2 只定义**字段契约**与**有效期** | 复用已验证的存储与检索，实验暴露的缺口回填 MQ 线；禁止为实验另起一套记忆系统 |
| M2-D2 | 来源三分级，实测唯一可置信 | ① 游戏内实测（`checked` 游戏回执或 inventory 前后读数）→ 可标记 verified；② 本地模组数据只读解析（`read` 回执，recipe JSON/tags）→ 候选；③ web 检索（官方 wiki / mod 官方页 / GitHub README）→ 线索，带 URL 与抓取时间，**未实测不得当事实** | 沿用 [EP-0 证据作者映射](./extension-execution-plan.md) 与完成门；web 内容按不可信输入处理，注入文本不改变工具行为 |
| M2-D3 | 知识以"模组集 + 版本"为有效期 | 记录 `modId`、`modVersion`、`modsetHash`、`worldId`；模组集或版本变化时旧配方记录标记为候选待复核，查询返回时带新鲜度 | MC-1b 的世界作用域记忆解决跨世界污染；版本失效解决"模组更新后配方变了"的诚实缺口 |
| M2-D4 | 默认关闭、独立世界、只读模组文件 | 实验开关默认 off；使用专用世界与固定模组集；不自动下载/安装模组，不执行模组包内任何代码，仅按路径只读解析数据文件 | 减小误伤与安全面；公共服务器规则不在本批次范围 |
| M2-D5 | 探索受预算与注意力闸门约束 | 仅在空闲窗口（life-mode 心跳 / 显式请求）启动，步数与时长走 MC-1b 预算；用户停止优先 | 防止"好奇心"变成不受控的模型调用与游戏动作 |
| M2-D6 | 加载器纪律：可运行夹具 = Fabric 1.21.1 | 知识摄取可用任意加载器的 jar（只读解析）；要"进去玩并实测验证"的夹具必须是 Fabric 1.21.1；不建第二套（NeoForge/Forge/旧版）游戏环境 | 游戏桥 MCPFabric 是 Fabric 模组；跨加载器运行需要再写桥，面积失控。非官方 Fabric 移植（AE2 Refabricated、Create 1.21.1 社区移植）**可选**，须单独冒烟并在知识记录里标注构建来源 |
| M2-D7 | vision 作为兜底观测通道（用户确认） | 允许用 AIRI vision 读游戏内 tooltip / 界面文本，弥补数据文件与游戏工具未覆盖的信息；不作为唯一来源，读到的内容按"未验证线索"处理 | 无手册模组（类 3）尤其需要；稳定性不足时回退到只读数据与实测 |

夹具盘点（2026-09-12，`D:\example_models` 实测）：

| jar | 加载器 | 知识资产（只读可解析） | 用途 |
| --- | --- | --- | --- |
| FarmersDelight 1.21.1-3.3.6+refabricated | **Fabric** ✅ | 333 配方 + lang(en/zh) | **可运行主夹具（类 1 起点）** |
| oceansdelight-fdrf-fabric 1.0.3 | **Fabric** ✅ | 31 配方 | 可运行扩展夹具（依赖 FD） |
| DungeonsArise 2.1.68（本目录为 NeoForge 构建） | NeoForge ❌ | structure 922 / worldgen 275 / loot_table 205 / advancement 40 | 需另下 **Fabric 构建**（`DungeonsArise-1.21.1-2.1.68-fabric-release.jar`，CurseForge 有）→ 类 2 夹具 |
| appliedenergistics2 19.2.17 | NeoForge ❌ | **`assets/ae2/ae2guide` 125 个 Markdown 指南** + 556 配方 | 知识摄取主目标；可玩需非官方 AE2 Refabricated（可选冒烟） |
| create 6.0.10 | NeoForge ❌ | 1884 配方 + lang（Ponder 为代码，仅能取 lang 文本） | 知识摄取目标（规模对照）；官方无 1.21.1 Fabric（仅 1.20.1），可玩需社区移植（可选冒烟） |
| touhoulittlemaid 1.5.3 | NeoForge ❌ | **56 个 Patchouli JSON 条目**（`memorizable_gensokyo`）+ 62 lang | Patchouli 解析基准；**知识-only**（无 Fabric 构建） |
| FarmersDelight 1.21.1-1.3.4 | NeoForge ❌ | 333 配方（与重织版同数据） | 冗余，可删；数据对照用 |

类 3/类 4 样例状态：格列佛（1.20.1）与水桶炮（无高版本）不在 1.21.1 夹具范围；HBM（1.7.10）用户明确放弃。两类在 1.21.1 样例出现前不启动。

待定稿的开放问题：

1. 合成动作的执行方式：MCPFabric 现有能力组（`world_read`/`command`/`world_write`）中"合成"的落地在实施前研究（客户端配方书 / 服务端交互 / mod 侧新增 craft 能力三选一），本批次允许以"放置/交互/破坏 + 合成"任一种可核对的验证动作作为首个通过标准。
2. 知识字段契约的细节（fact type 命名、检索键）在 `mc-2a-spec` 定稿时按 MQ 线现有 schema 对齐。
3. 是否接受非官方 Fabric 移植（AE2 Refabricated / Create 社区移植）进入可玩夹具；默认只在知识摄取轨使用它们的官方 NeoForge jar。
4. 是否把学到的流程固化为技能交给 MC-2d（依赖 EP-2a/审阅线），作为条件子批。

## 批次、依赖与通过条件

| 批次 | 交付 | 依赖 | 通过条件 |
| --- | --- | --- | --- |
| MC-2a | 新内容知识获取：模组数据只读解析 + 游戏内实测验证 + 结构化入库与检索（配方/用途/机制） | MC-1b；MQ-2（记忆质量闸门）；EP-1（若同批固化技能） | 无预置知识下学会 ≥1 个配方/用途，并用游戏内可核对动作验证；查询命中带来源、时间与有效期；模组版本变化后旧记录不再当事实 |
| MC-2b | 权威来源 web 学习：检索 → 解析 → 候选入库 → 实测转 verified | MC-2a；现有 `web_search`/`fetch` | 检索链路只产候选（含 URL+时间）；无实测不入库为 verified；web 注入文本不改变工具行为与权限 |
| MC-2c | 好奇心驱动的探索循环：未知内容识别 → 计划 → 实验 → 记录 → 复用 | MC-2a、MC-1b 预算、life-mode 空闲闸门 | 空闲窗口内完成一次完整闭环（未知→学习→验证→记录→第二次直接复用）；预算耗尽/用户停止均有界收敛 |
| MC-2d（条件） | 探索流程固化为经审阅技能（"学会一个配方"类） | MC-2c；EP-2a（若走包分发） | 复用 SG/EP 审阅与修订：成功、缺条件、取消、撤销、内容变更五类可核对 |

放置：MC-2 依赖 MC-1b 完成后启动，与 CP-2/EP-2 平台线**无前置耦合**（知识存储走记忆线，不依赖插件平台）；MC-2b 的 web 链路复用现有工具，不等待 CP-3。

轨道与夹具映射（按类别，E1 先跑）：

| 轨道 | 类别 | 夹具 | 学习路径要点 |
| --- | --- | --- | --- |
| E1 | 类 1（时间不敏感） | FD Refabricated + Ocean's Delight（可运行）；AE2 指南/Create 配方（摄取先行） | 里程碑链：切菜板 → 锅 → 餐；配方图路径搜索 + 每步实测验证；手册 markdown/Patchouli 先入库再应用 |
| E2 | 类 2（时间敏感） | WDA Fabric（先下 Fabric 构建） | 只做战前简报 + 受控遭遇 + 战后复盘；秒级执行交给反射；安全/止损协议 |
| E3 | 知识摄取基准（跨加载器） | AE2 `ae2guide` 125 md、车万女仆 Patchouli 56 JSON、Create 1884 配方 | 解析→知识卡→在可运行夹具上应用验证；NeoForge jar 只读，不运行 |
| E4 | 类 3 / 类 4 | 暂无 1.21.1 样例（格列佛/水桶炮/ HBM 均出局） | 待样例；类 3 的实验运行器与观测补丁设计保留在 MC-2a 规范中预研 |

## 夹具平台冒烟（2026-09-12）：NeoForge + Connector 通过

> 排序说明（2026-09-12，用户指示）：本节的夹具平台准备属于**提前预置**，不代表优先级变化。MC-2 仍按 [Minecraft 执行计划](./minecraft-execution-plan.md) 排在执行链路**最后**（依赖 MC-1b 与 MQ-2），`mc-2a-spec` 不提前起草。以下内容仅作平台可行性记录，供 MC-2 启动时直接使用。

加载器现实：`D:\example_models` 里只有 FD Refabricated 与 Ocean's Delight 是 Fabric；AE2/Create/车万女仆/WDA/FD 官方在 1.21.1 均为 NeoForge。AE2 的 Fabric 社区移植（`Starriers-Studio/Applied-Energistics-2-Refabricated`）最后提交停在 **2024-08**（提交信息 "core port 90%"/"I cannot"/"goodbye my health"），属弃坑半成品，不满足"维护好"标准。因此平台改为 **NeoForge 客户端 + Sinytra Connector 跑我们的 Fabric 桥**（mcpfabric 无 mixin、仅依赖 fabric-api，是 Connector 兼容性最好的形态）。

- **夹具实例**：PCL `versions\1.21.1-NeoForge-MC2`（复制自现有 `1.21.1-NeoForge_21.1.233`，清空存档/模组/配置），NeoForge 21.1.233 + Java 21。
- **mod 清单（10）**：connector 2.0.0-beta.17-full、FFAPI 0.116.15+2.3.4、guideme 21.1.17（AE2 必装前置）、Patchouli 1.21.1-93、mcpfabric 0.2.3（夹具副本）、AE2 19.2.17、Create 6.0.10（Registrate/Flywheel/Ponder 经 jarjar 内嵌）、FD 1.3.4、车万女仆 1.5.3、WDA 2.1.68。
- **版本上限**：FFAPI **≤2.3.4**。2.3.5 的内嵌模块要求 NeoForge ≥21.1.248，而夹具是 21.1.233；2.3.4 及更早最高只要求 21.1.219。Connector beta.17 自身仅要求 NeoForge ≥21.1.97。
- **夹具副本元数据放宽**（仅 jar 内声明，不改代码）：mcpfabric `fabricloader >=0.19.3 → >=0.15.0`；WDA `minecraft [1.21,1.21.1) → [1.21,1.21.2)`（上游元数据错误，CF 页面标 1.21.1 可用）。
- **工具教训**：不要用 .NET `ZipArchive` 原地改写 jar——会产生本地头 size=0 的坏条目，NeoForge 报 `invalid entry size (expected 0 but got 1495 bytes)`；改用 JDK `jar xf` + 编辑 + `jar uf` 重建，并对所有 jar 跑 `jar tf` 验证。
- **冒烟证据**：Connector 把 mcpfabric 识别并重映射（`mcpfabric-0.2.3+1.21.1_mapped_moj_1.21.1.jar`）后加载；mod 列表含 AE2/Create/FD/GuideME/MCP Fabric/Connector/maid/WDA；`[mcpfabric] HTTP bridge listening on http://127.0.0.1:25599`；MCP server 以新 token 重连桥并列全能力；AIRI game-host `connected` + identity（1.21.1/overworld）；`game_observe` = `ok/checked:true/observed`，快照坐标 (20.05, 64, -3.01)、血量 20、手持 `touhou_little_maid:smart_slab_init`。
- **运行注意**：新实例会生成新的桥 token，MCP server 需用新 token 重启（客户端不用动）；Patchouli 已入 mods，待下次客户端重启生效（车万女仆的手册需要它才能打开）。
- **未做**：多人夹具（当前为单人集成服冒烟，专用 NeoForge 服未搭）；内容模组的实际玩法/学习实验（MC-2a 之后）。

## 实验设计与验收场景

夹具：独立世界 + 固定模组集（E1：FD Refabricated + Ocean's Delight；E2：WDA Fabric）+ 清空该模组集作用域的知识；环境 A（offline 专用服）执行，环境 B 仅冒烟。

| 场景 | 操作 | 期望与证据 |
| --- | --- | --- |
| 学习-配方 | 给 AIRI 一个模组物品（如某食物），不给配方 | 她自主选择来源（模组数据 / web / 游戏内尝试），给出计划；最终用实测动作验证一次产出或用途 |
| 复用-配方 | 隔一段会话与一次重启后，再给同类物品 | 直接命中已存知识，不再重复检索/实验；返回带 `verified` 来源与时间 |
| 失效-版本 | 升级夹具模组版本（或改 modsetHash） | 旧记录返回候选状态并触发复核，不以旧配方直接开做 |
| 诚实-未知 | 给一个不存在/超出当前模组集的知识请求 | 明确"不知道"，给出可执行的获取计划；不编造配方，web 候选不冒充实测 |
| 边界-web注入 | web 页面携带指令性文本（注入夹具） | 仅提取结构化候选，工具行为/权限不受影响；完成门不因网页文本放行 |
| 预算-收敛 | 空闲窗口探索预算调小 | 到界即有界停止并留记录；用户停止优先于探索 |

## 风险与回退

- **合成能力缺位**：若 MCPFabric 无法可靠提供合成动作，首批通过标准退化为"知识获取 + 放置/交互类实测验证"，合成留作能力补丁（研究项 2），不伪造"合成成功"。
- **知识幻觉**：任何未实测内容不得入库为 verified；查询接口返回来源分级，模型不得把候选当事实叙述。
- **模组数据解析**：大 jar/混淆命名可能拖慢只读解析；先限制在 `data/**/recipe|tags` 白名单路径与体积上限。
- **成本失控**：探索循环默认关闭 + 预算 + 空闲闸门三重限制；实验结论未达标前不进入产品默认路径。
- **回退**：关闭 MC-2 开关即回到 MC-1 行为；入库的实验知识可按 `modsetHash` 批量清理（记忆线既有按 scope 清理能力）。

## 与其他计划的关系

- [MQ](./memory-quality-plan.md)：知识检索质量与事实语义复用 MQ；MQ-2 空回答未收敛前 MC-2a 不启动（列为硬前置）。
- [EP](./extension-execution-plan.md)/[SG](./skill-growth-plan.md)：MC-2d 的技能固化复用审阅与修订流程；EP-2a 提供包形态以便跨会话复用。
- [SP](./social-presence-plan.md)/[LIFE](./LIFE-PLAN.md)：探索触发借用空闲心跳与注意力闸门，不新造调度。
- [LG](./long-horizon-goals-plan.md)：跨会话的"持续探索一个模组"若需要长期目标，复用 LG 目标而非新机制。

## 本轮交付与检查

- 2026-09-12 立项轮：新增本计划文档，在 [Minecraft 执行计划](./minecraft-execution-plan.md) 批次表登记 MC-2，更新 [MODS.md](./MODS.md) 索引。
- 2026-09-12 夹具盘点轮：实测 `D:\example_models` 的 7 个 jar（加载器、版本、知识资产计数），记录 M2-D6 加载器纪律与 M2-D7 vision 兜底；确定 E1–E4 轨道映射与待下载项（WDA Fabric）。未换世界、未装新模组、未写 `mc-2a-spec`、未改产品代码。
