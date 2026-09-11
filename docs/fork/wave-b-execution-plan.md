# B 波次执行计划（三线起步）

日期：2026-09-11。状态：计划定稿，实施未开始。

本文件给 [MC 执行计划](./minecraft-execution-plan.md)、[EP 执行计划](./extension-execution-plan.md)、[CP 野心线计划](./capability-platform-plan.md) 里的首批批次排出顺序与切入口。契约细节以那三份文档为准，本文件不重复；这里只回答"先做什么、第一步落在哪个文件、怎样算这一步做完"。波次代号沿用此前讨论（A 收尾已关闭，B 为当前，C–F 为后续）。

## 一处修正：P3 组已落地

此前把 P3-1（环境块）与 P3-2（角色锚）列为 B 波次工作，**这个估计是错的**。它们是随 FLOW-KNOWLEDGE 一起落地的，代码已在：

- 环境块：`packages/stage-ui/src/stores/chat.ts:1068-1076`（`## Environment`，注入 workspaceRoot / shell / platform，仅工作轮）。
- 角色锚：`packages/stage-ui/src/stores/chat.ts:173-186`（`WORK_AGENT_ROLE_SECTION`），且 P3-3…P3-9 的条款已全部写在里面——先读后改、验证纪律、工具间隙叙述、计划/行动分界、错误恢复、人格/工作边界、破坏性动作先确认。其中工作区根那条（"Change it only when the user asks"）也就是待修 #14 的提示词侧修复。

所以 B 波次从四项收为**三项**：EP-0、CP-0、MC-0a。P3 组不再单列，改为在 B 的验收里顺带核对它们的实际效果（见"B 波次顺带核对"）。

## 波次地图与依赖

```
A 收尾（已关闭，用户跳过 #11/#14）
   └─ 产出：两个仓库干净基线、Todoist 双向修复

B（当前）  EP-0 ∥ CP-0 ∥ MC-0a      三个都无前置，可并行
   │
   ├─ EP-0 ──────────────→ MC-0c（游戏工具的证据与授权接线）
   ├─ EP-0 ──────────────→ CP-2（deny-by-default resolver 的数据源）
   ├─ EP-1（B 之后）─────→ CP-1 首个消费者
   ├─ CP-0 ──────────────→ CP-1 / CP-2 / CP-3（协议字段与台账是它们的地基）
   └─ MC-0a ─────────────→ MC-0b（执行契约，纯游戏侧）

C  MC-0b ∥ EP-1 ∥ P1-1/P1-3（hint 误导修复）
D  MC-0d ∥ MC-0c（含 S08）∥ CP-1
E  MC-1a ∥ CP-2 ∥ EP-2a ∥ QQ 群行为
F  EP-2b、CP-3、MC-1b/c；R06 长期搁置
```

三条并行且互不阻塞：EP-0 与 CP-0 是纯 TS，MC-0a 是环境与 Java 侧。**关键路径是 MC-0a**（环境搭建最长、不确定性最大），**杠杆最高的是 EP-0**（同时压着 MC-0c 与 CP-2）。三者的完成先后不重要，重要的是不要串行等待。

## EP-0：工具标识、来源、权限与在途撤销

目标（契约见 EP 计划）：注册从"名字集合"升级为携带来源的记录表；证据信任跟随执行链而非包装；撤销三步语义；单一所有者。

工作项（按依赖顺序）：

1. **定义注册记录**。新增 `ToolRegistration` 类型（字段见 EP 计划 §EP-0）。落点建议：`packages/stage-ui/src/stores/ai/chat-llm/tools.ts`（`useLlmToolsStore` 所在的注册拥有者），因为三条注册路径最终都汇到它；类型可放 `packages/stage-ui/src/types/`。这是唯一的新公开契约，先落它，其余都依赖它。
2. **证据桶扩展**。`packages/core-agent/src/authority/provenance.ts:14` 的 `ToolEvidenceAuthor` 联合加 `untrusted_plugin` 与 `game`；`packages/core-agent/src/authority/contract.ts` 的 `PLANNING_AUTHORITY_ORDER`（约 505 行前的表）加两条规则——`untrusted_plugin` 的 precedence 低于 `remote_agent`（指引可用、不作变更证明），`game` 需先核对来源/授权/连接代次/命令身份。加完跑 core-agent 全包测试确认没有断言依赖旧桶数量。
3. **迁移三条注册路径**。`apps/stage-tamagotchi/src/renderer/stores/tools/` 下的 `built-in.ts`（372 行，注册表主体）、`mcp.ts`、`plugins.ts` 各自在登记时提供 `ownerKind/ownerId/execution`。迁移期必须保持行为等价——这是本批的回归基线，先用现有测试锁住。
4. **改证据判定**。`packages/stage-ui/src/stores/chat.ts:921` 的 `getToolEvidenceAuthor` 从按工具名前缀猜（`mcp_`→remote_agent、其余→builtin）改为读注册记录；`reviewed_self_authored` 仍由有效批准哈希决定。**这一步是整批的要害**：包装后证据等级不得上升。
5. **撤销语义**。撤工具面 + 终止在途（沿 execution kind 传取消）+ 迟到回执标 `revoked` 不入完成门；多窗口下为 leader-owned action，幂等。
6. **单一所有者**。注册表拒绝重复 `toolId`；迁移走"撤下→登记"两步。

通过条件：EP 计划 §验收场景全绿，重点是"包装不提升信任""批准失效降级""双重注册被拒""撤销后 in-flight 终止且回执标 revoked"；且迁移前后现有 builtin/技能/MCP 行为等价。

## CP-0：契约纪律与版本协商

目标（契约见 CP 计划）：以已发布契约为 spec、加法纪律、第一天版本协商、建立 COMPAT 台账。

工作项：

1. **建 COMPAT 台账** `docs/fork/capability-platform-compat.md`：逐条记录"实现了她文档的哪一节、偏离在哪、为什么"。CP-0 先建空台账与填写规则，后续每批追加。
2. **握手加法字段** `ForkProtocolDescriptor`（字段与规则见 CP 计划 §版本协商契约）。落点：`packages/plugin-protocol/src/types/events.ts`（`ModuleAnnounceEvent` 在 746 行、`ExtensionModuleAnnounceEvent` 在 693 行附近）加可选字段；运行侧 `packages/server-sdk/src/client.ts` 的 announce 包装它；读取方取共同最高版本、未知 `extensions` 条目忽略、不兼容返回类型化错误。
3. **缺省等价测试**：字段两侧都缺席时，行为与上游逐项一致（对照测试）；字段在场且被识别时协商生效。

通过条件：台账建立且相对链接有效；缺省等价测试通过；不引入任何对既有名字的语义改动（纯加法）。

## MC-0a：固定候选、双环境、只读连接

目标（契约见 MC 计划 §MC-0a）：固定 MCPFabric commit 与 fork 构建；环境 A（本地 offline 专用服）与环境 B（LAN 联机）就绪；只读 observe 链路；退役旧 spark 入口；1.21.11 移植冒烟；资源占用测量。

工作项与切入口：

1. **建 fork 并固定 commit**。建议 MCPFabric fork 放在 AIRI 仓库**之外**的独立仓库（例如同级目录），不 vendor 进 pnpm workspace——它是 Java/Gradle 工程，进 workspace 会干扰工具链。fork 后登记 commit 哈希、构建摘要、许可（MIT）、MC 版本支持范围到 MC 计划文档。构建产物（jar）路径写进本地配置，不进库。
2. **环境 A**：本地 Fabric offline-mode 专用服，固定种子、模组列表仅我们的 fork，测试用 op 命令仅在此环境开。夹具脚本（岩浆坑/饥饿/僵尸/封闭目标/标记点）在 MC-0b 才需要，MC-0a 只要求能连上并读到正确状态。
3. **环境 B**：LAN 世界或自建服关 online-mode；AIRI 用第二个客户端 + 固定离线身份加入。玩家名取 persona 名。
4. **只读 observe**：这一步先用确定性协议脚本验证（不经 LLM）——`get_status`/`get_self`/`get_inventory`/`get_blocks_region` 返回的位置、背包与世界绑定正确，附采集时间。TS 侧连接方式在此定型（MC 计划的落点是 Electron main 的 `game-host` 服务；MC-0a 只要求连接与读取，工具面注册留到 MC-0c）。
5. **退役旧入口**：停注册 `packages/stage-ui/src/tools/character/orchestrator/spark-command.ts` 及 `tool-resolver.ts` 的接线；`integrations/minecraft` 不再随任何流程启动，README 标注 deprecated，代码保留作参考。退役本身是验收项。
6. **版本移植冒烟**：同一补丁在 MC-1.21.11 构建 + 只读 observe + 单次移动，记 PASS 但不推断全量兼容（补丁到 MC-0b 才全）。
7. **资源测量**：第二客户端 CPU/内存/帧率与最低可用画质，记录在案。

通过条件：双环境下身份/位置/背包读取正确且附世界绑定与采集时间；旧 spark 入口确认失效；MCPFabric commit 与构建摘要登记；移植冒烟通过；资源数据记录。

**用户触点**（需要你操作）：环境 B 需要一个可开联机的世界或自建服；第二客户端的一次性登录/身份确认。其余可自动化。

## 排序与交错

| 起点 | 批次 | 说明 |
| --- | --- | --- |
| 立即 | EP-0 工作项 1–2 | 定义记录 + 证据桶，是整条线的地基，纯 TS 无环境依赖 |
| 立即 | CP-0 工作项 1–3 | 一天量级，先建台账与字段，越早越省后续返工 |
| 立即 | MC-0a 工作项 1–3 | 环境搭建最长，越早开跑越好，哪怕价值到 MC-0b 才兑现 |
| 汇合 | EP-0 工作项 3–6 | 依赖 1–2，是 EP-0 主体，也是本批最费工的部分 |
| 收尾 | MC-0a 工作项 4–7 | 依赖环境就绪 |

建议的检查点：CP-0 完成即封（它不阻塞别人）；EP-0 的 1–2 完成时跑一次 core-agent 全包确认证据桶扩展无副作用；MC-0a 的环境就绪先于只读验证，环境卡住就先把 EP-0 推到底。

## B 波次顺带核对

- **P3 组实际效果**：`WORK_AGENT_ROLE_SECTION` 与 `## Environment` 已在，但真机效果未见复验（L02 变体当时模型仍自行改回工作区根）。B 波次任一次真机跑动时，顺手确认角色锚是否真的改变了她的行为（尤其工作区根与验证纪律两条），结论记入 MODS。#14 若提示词侧已足够，可考虑正式关闭；不足则补代码级守卫。
- **#18 恢复副本 journal**：此前列为高优先，用户判定收尾波已完成。B 波次无需专门跑，但 MC-0c 依赖证据链，动 MC-0c 前用一次恢复副本场景确认 journal 确实 replay 且落盘。
- **QQ 桥 admins_id**：与本波次无关，但它是 QQ 线唯一的手动解锁项，你有空时可做。

## 风险与回退

- **MC-0a 环境不确定性最高**：MCPFabric 构建（首次可能撞 TLS 检查的防火墙，重跑即可）、双客户端资源、离线身份限制。若环境长期卡住，EP-0/CP-0 不受影响，先把它们推完。
- **MCPFabric 上游很小**（约 21 commits）：固定 commit、自维护 fork；补丁面积超 P1–P4 量级时触发 MC 计划的 D1 退路（转最小自写桥，领域契约不变）。
- **EP-0 迁移面广**：三条注册路径 + 证据判定 + 撤销，回归基线必须先锁住；分步提交，每步跑对应包测试。
- **CP-0 的协议改动**：纯加法，但 server-sdk 与 plugin-protocol 都要动，注意两侧事件名同源、载荷可能漂移——以运行时代码为准逐字段核对。
- **不要串行**：三项并行是 B 波次的核心纪律；任何一项卡住都不应该让另两项停摆。

## 与其他计划的关系

契约与验收细节全部在上述三份计划文档，本文件只排顺序。P3 组的原始清单在 [FLOW-DIAGNOSIS](./FLOW-DIAGNOSIS.md) §5.5；待修清单在 [TEST-SUMMARY-20260911](./evidence/short-scenarios/ACC-20260907-01/TEST-SUMMARY-20260911.md)；A 波次的双向修复见 MODS 台账。

## 本轮交付与检查

本轮只新增本计划文档并更新 MODS.md 索引。未改动产品代码、未安装外部依赖、未运行游戏、未建 MCPFabric fork。文中代码锚点为当前工作区实际位置，实施时若行号漂移以符号名为准。
