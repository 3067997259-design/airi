# MC-3 立项评估：地形与机动能力（foot / mounted / vehicle / flying）

日期：2026-09-13。状态：评估稿，未定实施。上游：MC-1a/MC-1b/MC-1c 已验收；本批与 MC-2a 无前置耦合。触发：2026-09-13 MC-1c 验收中玩家角色卡在水域边缘（三面高一格、无法攀爬，后卡入陆地内部），暴露出"能走直线但不理解地形"的系统性短板。

## 1. 结论摘要

- 机动能力是正常游玩与后续实验（MC-2a 未知内容实测）的前提：走不过去、卡住、掉沟会污染数据并伤害观感。
- 参考项目里，**TerminatorPlus 的公开代码只是旧版暴力 AI**（无寻路、遇门即拆），视频里的现代引擎闭源；可借鉴的是它的能力清单，而不是实现。
- **Baritone**（LGPL-3.0，1.21.1 有 NeoForge API 版）是可用性最高的"成熟 mover"，适合作为 spike 参照或可选委托；**mineflayer-pathfinder**（MIT）的 movements/代价模型适合移植成 AIRI 原生规划器；两者互补而非二选一。
- 建议分四期：Phase 0 Baritone spike → Phase 1 徒步机动 A–E → Phase 2 骑乘/载具（船、马、矿车）→ Phase 3 条件项（鞘翅、炽足兽）。
- 骑乘与载具**不是"差不多"**：控制原语相同，但运动模型、前置物品、失败形态、验收标准差异很大；因此必须先把"移动模式"抽象出来，后续按模式接入。

## 2. 现状与缺口

### 2.1 已有原语（MCPFabric 桥）

- 输入：`control.setInput { forward/back/left/right/jump/sneak/sprint }`（持续按住语义）、`control.jumpOnce`、`control.look/lookAt`、`control.startUsing/stopUsing`、`control.stop`。
- 交互：`interact.useItem`、`interact.useEntity{ uuid }`、`interact.attackEntity{ uuid }`、`interact.placeBlock/breakBlock`。
- 世界/背包/实体：`world.getBlock(s)/findBlocks/raycast`、`player.getInventory/getState`、`inventory.selectHotbar/swapSlots`、`entities.query/get`、`nav.pathTo/status/stop`。
- 现有主进程执行器：`game_move_to`（mod 侧 A* + 直走/跳跃）、`game_collect`（找方块→走→挖→拾取）、`game_follow`（逐腿导航）、反射（MC-0d）。

### 2.2 缺口（按今天事故的能力清单）

| 缺口 | 现象 | 影响 |
| --- | --- | --- |
| 水域脱困 | 三面高一格爬不上岸，卡进陆地内部 | 任务失败/观感差/可能溺水 |
| 跌落处理 | 无落差评估与缓冲（不会落地水/贴墙） | 摔伤、卡沟 |
| 门与障碍 | 只有"绕不过就挖"的粗策略 | 拆房、破坏场景 |
| 垫脚/搭桥 | 无方块放置参与移动 | 断桥、沟壑直接失败 |
| 垂直机动 | 无塔高/下挖/阶梯 | 上不去、下不来 |
| 水域移动 | 不会主动游泳/上岸选点 | 水池=黑洞 |

## 3. 移动模式抽象（本批的架构决策）

统一为 `MovementMode`，执行器只认模式接口，不同模式共享"移动所有权、取消、反射优先级、世界绑定"四条约束：

| 模式 | 控制方式 | 前置 | 终态/失败形态 | 优先级 |
| --- | --- | --- | --- | --- |
| `foot` | setInput + look + jump，允许放置/破坏 | 无 | 到达/不可达/卡死升级（见 §4） | P0 |
| `boat` | 放置船 → useEntity 上船 → setInput 操舵；sneak 下船 | 船物品、水域 | 搁浅/翻船/下船失败 | P1 |
| `horse` | useEntity 上马 → look+forward 转向、jump 蓄力跳 | 驯服+鞍（可选甲） | 摔下/马死/被卡 | P2 |
| `minecart` | 铺轨+放车+上车；无转向（动力轨/坡度驱动） | 铁轨/矿车 | 脱轨/停死 | P2 |
| `elytra` | 起飞后 3D look + 烟花推进；着陆判定 | 鞘翅装备+烟花 | 高速撞地/空中耗尽 | P3（条件） |
| `strider` | 熔岩行走、诡异菌钓竿转向 | 鞍+钓竿 | 熔岩边缘/下马 | P3（条件） |

- 同一时刻只允许一个模式持有移动权；切换模式必须释放全部输入（`control.stop`）。
- 反射（hazard/低血）优先于任何模式；被反射打断的移动命令按 MC-0b/1a 回执语义结算（`reflex_preempted`）。
- 载具/骑乘**不改变证据语义**：位置/物品/实体回执仍由 main 核对，`checked` 仍只有 game-host 能产出；移动本身不是证据。

## 4. Phase 1（徒步机动）候选子项与算法来源

| 子项 | 内容 | 算法来源 |
| --- | --- | --- |
| A 水域脱困 | 上岸选点（可行走面搜索）、游泳、避免"三面高一格"死区、危险水体反射 | mineflayer-pathfinder 的 liquid 代价 + 自研岸线搜索 |
| B 落差与落地 | 落差评估（≤N 直接下；>N 拒绝或缓冲）、落地水/贴墙、坠落反射联动 | Baritone fall 处理思路 + mineflayer `maxDropDown` |
| C 垂直机动 | 塔高（垫脚）、下挖、阶梯上行 | mineflayer `allow1by1towers` + MC-1a 挖掘路径 |
| D 门与障碍 | 开门/栅栏门/活板门优先；绕行；破坏需显式授权（默认不拆建筑） | Baritone 门处理 + mineflayer 门逻辑 |
| E 垫脚与搭桥 | 边沿判定、垫方块跨越、断桥修复 | Baritone `allowParkourPlace` + mineflayer `placeCost` |
| F parkour | 1–3 格跳、斜跳、落地续跑 | mineflayer `allowParkour`（社区反馈其复杂序列会卡） |
| G 卡死恢复 | 连续无位移 → 退后/侧移/跳/重新规划 → 有界升级 | 自研（对照今天事故） |

## 5. 参考项目取舍

| 项目 | 许可 | 用法 | 结论 |
| --- | --- | --- | --- |
| [Baritone](https://github.com/cabaletta/baritone) | LGPL-3.0 | Phase 0 spike：fixture 客户端装 `baritone-api-neoforge`（1.21.1 对应 v1.11.3），MCP mod 暴露 `nav.baritoneGoal`，跑夹具矩阵对照；稳定则可选委托 | 能力最全；运动所有权/版本跟随/补丁回馈是约束 |
| [mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder) | MIT | 移植 movements/代价/重算到 main 规划器；世界与输入适配到桥 | 无运行时依赖，最贴近原生方案 |
| [mineflayer-baritone](https://github.com/miner-org/mineflayer-baritone) | 待核 | 备选蓝本（parkour/垫脚/梯子/水，含"水上岸要试几次"的已知弱点） | 备选 |
| TerminatorPlus | EPL-2.0 | 只做能力清单与少量做法参考（游泳贴岸、落地水、塔高） | 公开代码=旧暴力版（无寻路、拆门），不复刻 |

## 6. 分期、验收与回退

- **Phase 0（spike，1 个小批）**：Baritone 装载与对照；产出：`docs/fork/evidence/mc-3/spike-*.md`（成功率、卡死率、与反射/取消的相互作用）。决策点：委托 Baritone / 自研移植 / 两者并存。
- **Phase 1（徒步）**：A–G；验收夹具：三面高一格水坑（今天坐标回归）、门房、断桥、悬崖、塔点、窄缝；指标：到达率、卡死升级次数、未授权破坏 0。
- **Phase 2（骑乘/载具）**：船（过湖）、马（越障+跳）、矿车（定线）；各配一键上下与失败回退。验收：上/下工具、越障、失败有界。
- **Phase 3（条件）**：鞘翅（发射塔+烟花+着陆）、炽足兽（熔岩）；默认关闭，独立世界。
- **回退**：移动策略全部走"计划→执行→观察"的有界循环；任何子项失败保留 MC-1a 的 `move_to` 直走兜底；Baritone 若冲突或版本失配，直接卸载回到自研。

## 7. 明确不做（本批评估范围）

- 不复刻 TerminatorPlus 闭源引擎；不引入服务端假玩家方案。
- 不做 PvP/战斗机动（仅登记，未来单独评估；`IntelligenceAgent` 的 RL 思路记录备查）。
- 不做跨维度、不做服务器管理动作、不做飞行器/红石机械。
- 不给移动新增证据信任：移动回执、破坏/放置与现有契约一致。

## 8. 待决策（已决，2026-09-13）

1. **立项并先跑 Phase 0 Baritone spike**：已执行，见 [evidence/mc-3/spike-20260913.md](./evidence/mc-3/spike-20260913.md)。
2. **Phase 1 路线**：定为**移植 mineflayer movements（MIT、自研）**，不长期委托 Baritone。
3. **载具优先级**：维持 P1 船 → P2 马/矿车 → P3 鞘翅/炽足兽。

## 9. Phase 0 执行记录（2026-09-13）

- 固定 Baritone `v1.11.3` standalone-neoforge（sha256 `a6b3bb3d…3159d`）装入夹具客户端；聊天控制驱动（`#goto`/`#set`/`#stop`），无需改 Java。
- 七个夹具结果：水面齐沿游出 2s；门房开门 2s（门与墙完好）；全宽 3 格沟疾跑跳 4s（无放置）；全宽二格墙垫 1 块翻越 1.6s；水坑（沿高 2）垫 1 块脱困 10.1s；物理无解几何正确拒绝（不空转）；5 格坠落照常掉血、未用落地水。
- 已知弱点：**挖掘时瞄准不稳定**（水中挖掘视角摆动导致进度重置，用户协助后才挖穿）——自研时必须修复；不缓解坠落伤害。
- 结论：以 Baritone 行为为目标基线（绕行优先、垫脚解决垂直、门优先、无解即拒绝），Phase 1 补上其缺失的稳定瞄准、落差缓冲与卡死恢复。Baritone 如需改源码按 LGPL 向上游回馈（用户已同意）。


## 本轮交付与检查

仅新增本文档并更新 MODS 索引；未改产品代码、未安装 Baritone、未跑游戏。
