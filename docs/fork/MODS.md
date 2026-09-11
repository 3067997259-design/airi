# AIRI fork mods（本地魔改记录）

本分支（`mods`）是 3067997259-design 的本地魔改，不打算提交 upstream。
基于 upstream `main`（`e170d454e`，v0.12.0-beta.2）。

## 扩展与自开发能力执行计划定稿（2026-09-09）

新增 [扩展与自开发能力执行计划](./extension-execution-plan.md)（批次代号 EP），三条计划线的闸门线落纸。
四项决策：证据信任跟随执行来源不跟随包装（注册记录携带执行链）；单一所有者迁移即换防；EP-2 首批为声明式包（无任意 Node 入口，执行走 coding-host 沙箱，worker 隔离等 CP-2）；批准绑定内容哈希（单技能沿用 SG-1，插件包扩展为整包摘要）。
定稿 EP-0 注册记录与证据作者映射（新增 `untrusted_plugin` 与 `game` 桶）、在途撤销三步语义（撤工具面/终止在途/迟到回执标 revoked）、EP-1 首闭环七步与 EP-2a/b 分相交付。本轮仅文档。

## 插件平台野心线计划定稿（2026-09-09）

新增 [插件平台野心线执行计划](./capability-platform-plan.md)（批次代号 CP），把上游作者在插件平台设计文档中声明、从未实现的野心落成 fork 探索批次。
定位依据：作者对 50K star/5K fork 社区负责须谨慎，fork 只对自己负责、第一意义是探索（先例：记忆系统即在她的底子上由 fork 实现）。
四项决策：以已发布契约为 spec（manifest v1、作者面 API、plugin-protocol 事件名、CapabilityRecord、kit 命名哲学）；加法纪律 + `fork:` 命名空间 + 第一天版本协商；消费者先行（每个组件带真实消费者，禁止平台先行于消费者）；按锚定度排序 CP-0 契约纪律 → CP-1 能力注册表与 waiting-deps/degraded → CP-2 权限策略与 node-worker 隔离 → CP-3 websocket 远程插件统一两半球 → CP-4 数据面搁置。
含断层地图与作者意图重建、兼容分层判断（作者面 API > 事件名 > 宿主内部）、COMPAT 台账与 rebase 纪律。本轮仅文档。

## Minecraft 执行计划定稿（2026-09-09）

新增 [Minecraft 接入执行计划](./minecraft-execution-plan.md)，把 Fabric 方向落成可执行批次。
四项决策经用户确认：适配 MCPFabric（fork 固定 commit）、独立客户端离线身份双环境（本地 offline 服 + LAN 联机）、首批完整生存反射（新增 MC-0d 批）、1.21.1 起步且版本改动限制在 mod 层。
定稿命令信封与状态机、六工具面与 MCPFabric 能力映射、反射契约、fork 补丁清单 P1–P4、旧 spark 入口退役项、TS 侧代码落点与批次依赖（MC-0c 前置 EP-0）。
本轮仅文档；未安装外部依赖、未编写 Java、未运行游戏。

## Minecraft 开源路线研究（2026-09-09）

新增 [Fabric 实现方向与分批验证](./minecraft-fabric-implementation-direction.md)。
对照 Mindcraft、Voyager、MCPFabric、AIBot、Easy LLM 和 STEVE-1，建议保留 AIRI 核心，通过固定适配器接入 Fabric 客户端。
记录导航启动与完成的区别、网络超时与游戏取消的区别，以及 MCP 来源到领域证据的接线缺口。
细化 MC-0/MC-1 与 EP、LG、MQ、PC、SG 批次关系；组件选型待定，外部项目未安装，游戏验收未开始。

## 插件、自开发能力与 Minecraft 勘探（2026-09-09）

新增 [兼容边界与后续批次](./extension-and-minecraft-exploration.md)，记录技能/插件的工具声明共性，以及权限、证据、生命周期和备份缺口。
区分 Fabric 迁移的代码依据与架构推测，确定个人 fork 可先做固定适配器和本地游戏桥接。
记录用户接受的任务 UI 方案及跨会话显示的隔离复现；本轮仅勘探，未安装插件、修改产品实现或操作主实例。

## 复核发现 1、2 修复（2026-09-09）

新增 [修复与回归记录](./evidence/short-scenarios/ACC-20260907-01/review-findings-1-2-repairs-20260909.md)。
技能 Schema 改为显式支持集合并拒绝未执行的关键字，`uniqueItems`/`minProperties`/`maxProperties`/`multipleOf` 真正生效，`executeSkill` 不再把 `null` 折成 `{}`。
长期目标在约束修订清空 `activeRun` 时保留 `lastRun` 运行身份，Flow 授权改为按持久运行身份解析所属长期计划，修订后的迟到写入会走到 `stale_plan_run`。
验证：skill-forge 42、core-agent authority 51、stage-ui skills 19、stage-ui plans 25、stage-ui chat 92 全绿；三包 typecheck 与改动文件 eslint 退出码 0。未重建 Electron，运行态复验列为下一批。未创建提交。

## UI 表面与反馈契约设计定稿（2026-09-11）

新增 [UI-SURFACE-PLAN](./UI-SURFACE-PLAN.md)：把 [插件与 Minecraft 勘探](./extension-and-minecraft-exploration.md) 里与两个宏大方向并列的「已确认的 UI 方向」独立成篇，并绑定实际验收中观察到的 UI 缺陷。
结论把 UI 工作定为三件事：**反馈契约**（用户动作在 300 ms 内必须有可见结果或可见拒绝理由，静默按缺陷处理）、**表面预算**（一个窗口一个主输入位，辅助表面合计不超过聊天区可视高度的 40%）、**归属与来源**（正文只展示当前会话，跨会话走全局入口，不伪造来源、不因完成删证据）。给出 9 条可检验不变量、6 类动作的最低反馈表、`UI-0…UI-4` 五个批次（反馈清零 / 单输入位与预算 / 会话与任务归属 / 窗口角色与跨窗口能力 / 首屏与不可用状态），并逐条映射到验收证据（UI-A btw 侧通道静默错投、UI-B 控制岛展开失效、UI-C 技能页静默按钮、UI-D 未登录副本静默弹回、UI-H 主窗离开舞台后 Live2D 工具静默失效等）。原勘探文档该节已加指向本文件的说明并保留为历史记录。本轮仅文档，未改产品代码。

## M08 回切复核通过（2026-09-11）

用户重新用 GitHub 登录账户 A 后逐项核对：`userId`/scope/`activeCardId` 回到原值，会话 **121**、记忆片段 **79（A 68 / local 9 / 无 scope 2）**、`shareable` 仍是 `656b0f6f`/`4c211389`/`17edcfbe` 三条、按 scope 查 A 仍 **59**、dream ideas 0、DB `ready` —— **与切换前基线完全一致**。换账户再换回来是非破坏性且可逆的，M08 第二账户变体完整闭环。证据追加在 [M08-second-account-20260911.md](./evidence/short-scenarios/ACC-20260907-01/M08-second-account-20260911.md)。语音相关的官方链路（TTS/STT）按用户意见不纳入本次魔改验收范围。

## M08 第二账户隔离 + S09 speech-active 通过（2026-09-11）

记录：[M08-second-account-20260911.md](./evidence/short-scenarios/ACC-20260907-01/M08-second-account-20260911.md)、[S09-speech-active-20260911.md](./evidence/short-scenarios/ACC-20260907-01/S09-speech-active-20260911.md)。
用户在「设置 → 账号」登出 GitHub 账户 A、改用 Google 登录账户 B（150 Flux），两件事都在 B 上完成。
**M08 第二账户变体 PASS（隔离）**：`userId`/scope 切到 B 后，A 的记忆在 `listShareableFacts`（`[]`）、一次真实提问的 `memory/retrieved`（`memoryIds: []`）、按 scope 直查库（B → 0 行、A → 59 行）、会话索引（121 → 1）四条路径上都不可见；库内总量始终 79（A 68 / local 9 / 无 scope 2），**A 的数据只被挡住、未被改动**；B 侧 `runAutomaticDreaming` 因 cooldown 跳过、手动 `dream` 无产出，A 的片段同样未被触碰。
**S09 speech-active 门 PASS**：官方语音来源在 B 下不再 401（`speechProviderError` 为空），轮询到 `nowSpeaking=true` 且 `sending=false` 时触发心跳 → `life/heartbeat gate=speech-active`，其后 journal 无任何 `turn/start`/`assistant/*`（无插入发言、无重叠播放、无模型调用）。
顺带记录：同一会话第一条消息以 `turn/end error: Remote sent 403 insufficient balance` 结束，来源是用户自建的 chat provider（`direct.linkai.pics`），与官方语音不是同一链路，第二次调用成功，记录备查。未创建提交。

## S13 真实 30 分钟窗口通过（2026-09-11）

记录：[S13-realtime-window-20260911.md](./evidence/short-scenarios/ACC-20260907-01/S13-realtime-window-20260911.md)。
不用时钟推进，真的等满 30 分钟：第 1 跳把 `LoveButton` 的候选消费掉（`seq=22 refs=appearance:8`，窗口从 00:53:48 起算）；第 2 跳重新设同一个值（新事件 `seq=32`，同一 novelty key）后，心跳决定只带 `appearance:29`（angry），**同值被去重**；第 3 跳在 01:27（窗口 01:23:48 已过期）再次设同值，决定里 `refs=appearance:57,appearance:54` —— **同值重新可用**。三次决定均为 `silence`，即口头层没有重复表达。心跳间隔测试期间临时设 60 分钟、结束已改回 15。

## 验收结果汇总（2026-09-11）

新增 [测试结果汇总](./evidence/short-scenarios/ACC-20260907-01/TEST-SUMMARY-20260911.md)：把 62 个短场景的当前状态、本轮新跑通的项、未关闭项与原因、20 条待修清单、复跑方法与证据索引收到一处。要点：B/D/M/V 组全通过；L 组剩 L04 的普通追问归因；S 组剩 S08/S09（外部条件）与 S13（30 分钟窗口进行中）；K 组剩 K07 的竞态取证；R 组剩 R06 完整次序。历史计数（22 PASS / 18 FAIL / 22 BLOCKED）不改写，追加状态以汇总文件与状态对齐表为准。未创建提交。

## L07 双窗口竞争通过 + K07 部分（2026-09-11）

用户手动打开设置窗口后，同一 profile 下同时有 follower 设置窗与 leader 主窗，两者都导航到 `#/chat` 后各有真实输入框。记录追加在 [L07-K07-L02-20260910.md](./evidence/short-scenarios/ACC-20260907-01/L07-K07-L02-20260910.md)。
**L07 PASS**：主窗 `/flow` 起一条 `sleep 90` 打头的有界 Flow，等待期间从两个窗口的主输入框各发一条同样的修订（间隔 0.43 秒）。journal `abfa404f…` 记录了两条 `user/steering`（seq 28/29），单条 Flow `sYW0Solw` 走完 `flow/step`×2 → `flow/completion-review` → `flow/end done`；工作区只有 `brief.txt` 与 `revised-result.txt`，**旧目标零写入**，模型收尾明确说明转向结果。
**K07 部分**：跨窗口机制已验——设置窗（follower）点「批准」后，决策经 leader 落地，两个窗口的 `skills-review` 状态一致（probation → reviewed，`probationCount` 1→0）。但真正的竞态没造出来：唯一可操作的 probation 条目在准备阶段就被批准，而重建条目的两条公开路径都是**静默空操作**（未读源码时点「批准」、对已审阅条目点「提交审阅」），记为待修第 19 条。
副产物：本轮第一次发修订时输入落进了 btw 侧通道（`#/chat` 有两个 `textarea`，`querySelector` 命中的是侧通道），journal 里既无 `user/message` 也无 `user/steering`——补强待修第 10/20 条（侧通道会静默错投输入）。收尾：技能队列已恢复为 `acc-20260909-dedupe:reviewed`，两个窗口路由复位，DB/life-mode/模型/embedding 均保持原值。未创建提交。

## R04 adoption 后恰好一次有界 Flow（2026-09-10）

用户配合完成登录与 provider 配置。记录：[R04-adoption-and-flow-20260910.md](./evidence/short-scenarios/ACC-20260907-01/R04-adoption-and-flow-20260910.md)。
把副本 coding 根切到 `D:/airi`（与目标 `spec.workspaceRoot` 一致）后等调度器唤醒：00:30:08 目标 `430613eb` 认领 Flow 槽并跑 Flow `6izmfCPf`（3 轮，`flow/end done`，`outcome=completed`）；00:31:38 目标 `598e975d` 接上跑 Flow `FaSIR8xe`（同样 `done`）。两个目标各**恰好一次**有界 Flow、按单槽串行、结算后 `schedules` 清空、`runningGoalId` 归零、lifecycle 均 `completed`。**R04 关闭条件满足，PASS。**
但发现一个高优先问题（待修第 18 条）：这次运行的事件链**只在内存**，副本 `journal\` 最新写入仍是恢复时刻 14:46:53，整个 profile 树下 15 分钟内没有任何 `*.jsonl` 被修改；会话内 journal 还从 seq 0 重新开始而不是续上恢复文件的 0..4838，渲染端警告 `[Flow] Journal replay is incomplete; flow rebuild is suppressed for this session.`。恢复副本目前等于运行在「无证据链」状态。未创建提交。

## R01 变体：写入进行中导出（2026-09-10）

用户配合执行。记录：[R01-export-during-write-20260910.md](./evidence/short-scenarios/ACC-20260907-01/R01-export-during-write-20260910.md)。
制造真实在途写入：切换 embedding 模型触发 77 条片段的重新向量化（`embeddingMigration.state=running`），在迁移窗口内点可见的 `Backup ZIP`，共两次。
两份归档（13.8 MB / 13.7 MB）**manifest 154 条逐条哈希核对全部一致，0 缺失 0 不匹配**，`credentials: excluded`、`outbox: held` 不变；导出 2 的窗口内迁移索引没有推进（点击前后均 `0/77`，落盘 9 秒后仍 `0/77`），迁移随后恢复并 `complete 77/77`。判定 PASS：写入进行中导出得到自洽归档。
观察：`data-backup.ts:57` 的闸门只覆盖 `chat.sending`／运行中的 Flow／`dreaming`，不含迁移；第二道防线是 `:109` 的 `before !== after` 状态比对（含 `embedding` 状态），两次都没触发，与「窗口内无推进」一致；`snapshot-barrier.ts` 只跟踪 store action，后台 IO 不在其内。收尾：模型已切回 `voyage-4-large`。未创建提交。

## L07/K07 受阻 + L02 第二模型变体（2026-09-10）

记录：[L07-K07-L02-20260910.md](./evidence/short-scenarios/ACC-20260907-01/L07-K07-L02-20260910.md)。
**L07「双窗口竞争」/ K07「两窗口并发点击」BLOCKED**：本构建里控制岛「展开」拉不出设置入口（DOM 里只剩 `alt-arrow-up` 与 `chat-line` 两个图标，选择器点击与真实鼠标按压都无效，生产构建没有 `devtoolsRawSetupState` 兜底），聊天窗口也渲染不了设置页（`body.innerText` 长度 0）。没有第二个窗口就无法按口径并发取证；22:19 之前的构建上同一操作是成功的，疑似回归，记为待修第 13 条。
**L02 第二模型变体部分完成**：改用 `gemini-3.1-pro-preview`（provider 列出 27 个模型）跑只读长期目标，读取夹具并正确报告 `ACC-20260907-01-L02b / original-root / 1`，`flow/end reason=done`；通过设置 UI 把工作区根切到 `L02-alt` 也成功。但追问时模型**没有**按口径报告「当前工作区没有该文件、早前结果属于原根」，而是调用 `setWorkspaceRoot` 把根改回去再读——把用户刻意的切换当成事故还原（待修第 14 条）。长期目标的环境变化门没被触发：目标始终没拿到 Flow 槽，`lastEnvironment` 为空（待修第 15 条）。另外误传 `{}` 当 characterId 会造出永远起不来的目标（待修第 17 条，低）。
顺带记录待修第 16 条：一次 `softDeletePlan` 之后所有 DuckDB 查询抛 `reading 'peek'`、`databaseStatus=error`，重启完全恢复且无法按需复现——建议查询失败后重建连接。
收尾：工作区根已改回 `D:/airi`、模型改回 `gemini-3.8-flash`、误建目标已 `softDeletePlan`。未创建提交。

## R05 两变体 + R07 中途终止（2026-09-10）

B 批次继续跑，两条记录：[R05 变体](./evidence/short-scenarios/ACC-20260907-01/R05-variants-20260910.md)、[R07 中途终止](./evidence/short-scenarios/ACC-20260907-01/R07-abort-mid-import-20260910.md)。
**R05 embedding 切换 PASS**：用「明确不存在的模型名」触发（按计划约定的失败变体手法）。切换后迁移 `state=error`、`lastError` 带 provider 的 400 与支持模型清单、设置页可见「错误 / not supported」；同一提问的 `memory/retrieved` 变成 **`memoryIds: []`**，没有把 `voyage-4-large` 时代的旧指纹向量当匹配结果。还原后迁移 `20/20 complete`、检索 id 与基线一致。观察：记忆为空时模型改用 `grep`+`read` 从工作区取答案，用户看不出答案来源（与 M07 的观感问题同类）。
**R05 凭据缺失变体不通过**：在未登录的 `restore-J2TLrx` 里，输入框照常可用，按 Enter 后**草稿原地弹回、无任何提示**（直接调 store 才拿到 `Failed to load the target chat session`；`InteractiveArea.vue:173-189` 会还原草稿）。且该副本已 adoption → `showRestoreNotice` 依赖 `restoreEffectsHeld` 而失效，onboarding 退回全新安装形态，**「数据已恢复，请登录 `<owner>`」的说明整个消失**。记为待修第 11 条。
**R07 导入中途终止 PASS**：赋归档给隐藏 input 后 700 ms 强杀，`restores/` 无新副本、`backups/` 无半截归档；重启后会话 115、计划 61、记忆库 ready、生命模式不受影响。
顺带发现待修第 12 条：`listShareableFacts` 先按 `last_accessed` 取 `limit×4` 行再过滤，生命模式的窗口只有 20 行——合格的已审事实会因为「很久没被访问」而永远进不了社交候选，`(scope,10)` 返回 2 条而 `(scope,25)` 返回 3 条即为证据。未创建提交。

## L04 真机复验 + 活动时间戳回填/告警落盘（2026-09-10）

第二轮：补跑 L04 真机口径，并实现复验暴露的两条新修，结果追加在 [复验记录](./evidence/short-scenarios/ACC-20260907-01/FIX-LIST-20260910-retest.md)。
**L04 部分通过**：用 `/flow` 起含 `bash sleep 240` 的有界 Flow，挂起时杀进程（23:07:51）再重启（23:08:01）。中断前只有一次未返回的 `sleep`；重启后同一 Flow 续跑并明说「中断恢复后已确认当前任务目标」，最终 `result.txt` 与 brief 一致、完成门通过。**但普通聊天追问仍把恢复后才发生的两次 `sleep 240` 失败（23:10:31 / 23:12:36）说成「中断前」** —— `[Recovery boundary]` 只注入 Flow 轮次提示词，记为待修第 9 条。
**新修 A（活动事件时间戳回填）**：`journal.ts` 的 `hydrate` 在 seed 前给缺时间戳的 `tool/result`/`plan/update`/`task/update` 补上同一轮次里最近的时间戳（两侧都没有则保持原样，避免用 `Date.now()` 重造缺陷）。真机验证：旧会话 `iv4bAQfGmsy…` 的 14 条无时间戳活动事件现在全部进 `expiredRefs`（`life/decision action=discarded … 16 stale candidates` + `gate=stale-stimulus`、零模型调用），修复前它们会作为候选送进模型。
**新修 B（告警进持久日志）**：`readPersistedLifeMode` 改用 `useLogg('main/life-mode').useGlobalConfig()`；真机验证截断 `life-mode.json` 后重启，`logs/airi-tamagotchi-*.log` 出现带路径、副本位置、错误与堆栈的 warn。
验证：两包 typecheck 0、改动文件 eslint 0、`journal.test.ts` 15 passed、life-mode 21 passed、应用重建 0。另按用户报告登记待修第 10 条：「干活时问一句」btw 卡片无高度上限、占据聊天页大半，且展开时 chat 窗口有两个 `textarea` 导致脚本误投递。未创建提交。

## FIX-LIST 1–8 修复真机复验（2026-09-10）

重建（退出码 0，`out/` 22:19）后按 [修复记录](./evidence/short-scenarios/ACC-20260907-01/FIX-LIST-20260910-results.md) 的「待真机复验」跑 6 条，结果写进 [复验记录](./evidence/short-scenarios/ACC-20260907-01/FIX-LIST-20260910-retest.md)。
**1 PASS**：纠正链路打通——批准新事实后 `listShareableFacts` 由 3 变 4，纠正并批准修订后**有效片段在列、被替换片段消失**；心跳决定 `action=speak`，`refs` 只含纠正后的 `memory:b3961c0e…`，发言用有效名称并作废旧名称。
**2 PASS（陈旧路径）+ 迁移缺口**：清理测试记忆后切到休眠会话，心跳走 `life/decision action=discarded` + `gate=stale-stimulus`、零模型调用。但原文要求的「20 小时前 `tool/result` 过期」复现不了：`journal.ts` 只在 `append` 时补时间戳，磁盘上的旧活动事件没有该字段，`occurredAt` 为 undefined 就永不进入 `expiredRefs`（该 journal 32 条活动事件里 31 条无时间戳）。建议读回时回填或按「年龄未知」过期。
**3 未完成**：三次尝试，前两次模型内联完成（无 `plan_update`/`flow/start`，没有可恢复的 Flow），第三次建出 Flow 但省掉了长等待步，没有中断窗口；同时旧 FIX1 长期目标被调度器唤醒在后台连续跑 turn。真机口径需一条至少挂起 2 分钟的 Flow。
**4 PASS**：grep 返回 `14 matches in 7 files` 的真实命中，无 `Search ran without ripgrep`。
**5 PASS**：`life-mode.json` 的 `lastGate` 与 follower（聊天窗口）快照都变成 `stale-stimulus`，渲染端门已回写主进程。
**6 PASS**：截断 `life-mode.json` 后重启生成 `.corrupt-1789050406176`、无 `.tmp` 残留、stderr 打印原因+路径+副本位置。小观察：warn 走 stderr，未进 `logs/*.log` 持久日志。
复验后已恢复生命模式（`autonomous / 间隔 15 / 静默 3–4 / 预算不限 / 冷却 30`）与主窗口会话。未改产品代码，未创建提交。

## R03/R04/R05 修复真机复验 + 待修清单（2026-09-10）

重建（`pnpm -F @proj-airi/stage-tamagotchi build`，退出码 0，`out/` 14:44–14:45）后复验交接的三条，结果追加在 [R 组修复记录](./evidence/short-scenarios/ACC-20260907-01/R-GROUP-FIX-20260910.md)。
**R03 PASS**：新建恢复副本 `restore-J2TLrx`，`restore-state.json` 带 `ownerId`，首屏为「数据已恢复 / 来自 `<owner>` 的数据已恢复到本设备。请登录 `<owner>` 以查看。」+「登录以查看数据」，全新安装入口不再出现。
**R04 机制 PASS**：adoption 前 `long-goals.json={"schedules":[]}`；点「使用恢复的 profile」**不重启**后 `effectsHeld:false`、两条排程按 `nextReviewAt` 写入、调度器把 `waitReason` 写进目标状态（不再静默）。「恰好一次有界 Flow」未达：`checkStartConditions` 先被 scope 门拦住（新副本未登录 → `userId=local`），之后还有 provider、workspace root（目标 `D:/airi` vs 副本 `<copy>\workspace`）与接受环境变化三道门，需要用户登录后才跑得完。
**R05 PASS**：`## Toolset` 新增「Unavailable reviewed skills」段（技能名 + toolId + 原因 + Settings→Modules→Skills 入口）；P'' 运行时回答从「工具列表中不存在」变为「当前无法调用。原因：该技能属于不同的工作区…请…重新验证」；工具面 33 个且无任何 `mcp` 名字，运行时整轮零 `tool/call`（修复前会调 `builtIn_mcpListTools`）。
另出 [待修清单](./evidence/short-scenarios/ACC-20260907-01/FIX-LIST-20260910.md)，汇总本轮与既有未修项：纠正后有效事实缺 `sourceContext` 进不了候选（新）、`life-mode.json` 解析失败静默回落默认值且无日志（新）、R06 `update` 先于 `insert` 丢数据、L04 恢复叙述口径、构建版 grep 降级（方案待选）、渲染端门对 follower 不可见、活动类候选无年龄信息、记忆 `list` action 的参数异常观察项。未改产品代码，未创建提交。

## S 组未完项复跑：S03/S10/S16/S18 通过，S17 发现新缺陷（2026-09-10）

新增 [S 组复跑记录](./evidence/short-scenarios/ACC-20260907-01/S03-S18-recovery-20260910.md)（含截图），并更新 [状态对齐](./evidence/short-scenarios/ACC-20260907-01/status-alignment-20260909.md) 与 [未关闭问题清单](./evidence/short-scenarios/ACC-20260907-01/open-findings-20260909.md)。
**S03 PASS（含偏差）**：间隔 1 分钟 + 静默窗口 14–15，主进程把 `nextHeartbeatAt` 直接推到 15:00:00；4.5 分钟内零心跳、零决策，其间产生真实 `appearance/changed`。`quiet-hours` 门本身无公开可达路径（调度器移出窗口 + 测试心跳显式跳过），单列偏差。
**S10 PASS**：空 profile（无任何会话）+ 自主模式 → `life/heartbeat gate=no-session`，UI 显示「没有活动会话」，预算 0/24、无模型调用。
**S16 PASS**：新批准的有效记忆进入候选（`refs=memory:d5e701eb…`），决策为 `note`，文本自然非倾倒；三条超过 6 小时的记忆被 `stale-stimulus` 丢弃。
**S18 PASS（含口径偏差）**：改用约 20 小时前的休眠会话（未做真实 6 小时停机、未改时钟）。陈旧完成类事件未被当作「刚刚发生」（决定为沉默）；带时间戳的陈旧候选走 `stale-stimulus`、零模型调用。残余风险：活动类候选 `occurredAt=0`，不参与过期过滤，刺激文本也无时间戳。
**S17 FAIL（新缺陷）**：显式 `reviseFact` + 批准后，被替换事实正确失效，但有效事实因缺 `sourceContext` 永远进不了 `listShareableFacts`/记忆候选（`memory.ts:1256-1262` 只在有值时写该字段）。
**S08 / S09 仍 BLOCKED**：S08 需 server channel 插件 `task:start`（运行端 `tasks=0`、`eventLog=0`，仓库内无发布方）；S09 语音 provider 上游 401 且 Electron 无本地语音。
另记两条独立发现：`life-mode.json` 在本次重启后被静默重置为默认值（解析失败无日志、直接回落默认，已人工还原为 `autonomous/静默 3–4/预算不限`）；渲染端门（`no-session`/`busy`/`focused`/`speech-active`/`stale-stimulus`）不回写主进程，follower 设置窗看不到。未改产品代码，未创建提交。

## R 组复验与交接（2026-09-10）

新增：[R02/R03 复验](./evidence/short-scenarios/ACC-20260907-01/R02-R03-retest-20260910.md)、[R04 失败](./evidence/short-scenarios/ACC-20260907-01/R04-retest-fail-20260910.md)、[R05 部分](./evidence/short-scenarios/ACC-20260907-01/R05-retest-partial-20260910.md)、[R 组交接件](./evidence/short-scenarios/ACC-20260907-01/R-GROUP-HANDOFF-20260910.md)。
R01/R02/R03/R07 PASS（R03 数据身份正确：原角色、111 条会话、原 owner 计划卡、135 个 journal 文件；未登录首屏是全新 onboarding，属契约缺口）。
**R04 FAIL**：adoption 后 `effectsHeld:false`，但 `long-goals.json={"schedules":[]}`，两次「立即运行」后 P'' journal 最新写入仍停在恢复时刻，零 `flow/start`。
**R05 部分**：恢复技能 `trust=reviewed`+`reviewedHash` 保留且标 `Artifact verification is pending.`（正确）；运行时调用后零事件，疑似静默阻断。
运行手册：`Restore ZIP` 需直接给隐藏 input 赋值（点按钮不弹框）；判断 profile 看 renderer 的 `--user-data-dir`。

## S20 复验：社交考量与用户问题竞争（2026-09-10）

新增 [S20 复验记录](./evidence/short-scenarios/ACC-20260907-01/S20-rerun-20260910.md)。
把生命模式切到**自主**、静默时段由 `0–23` 收窄为 `3–4`（原先全天静默，正是 S03/S08 长期 BLOCKED 的原因）。两次竞争：第一次用户消息先到 → `life/heartbeat outcome=gated gate=busy`；第二次心跳先发 → `outcome=emitted` + `tool/call self_decide` → `life/decision action=silence`，`consideredThroughSeq=5517` 覆盖了 `seq=5513` 的用户消息。两次回答均为 `15。`，没有社交话术串入。
仍未覆盖 live `speak` 变体（取决于模型是否选择开口，无法强制）。

## REV 复验：结构化修订 + 完成门通过（2026-09-10）

新增 [REV 复验记录](./evidence/short-scenarios/ACC-20260907-01/REV-structured-revision-pass-20260910.md)。
重建 R1–R5 后复验：**结构化修订首次在运行态成立**（`seq=5356/5390` `goal/update cv=2/3 revision=true reason=long-goal constraints revised`）；完成门全部 `pass`（`seq=5233/5296/5464`），`flow/end reason=done`；等待原因变为队列语义 `Waiting for another goal that holds the single Flow slot.`；`goal/update` 约 2 小时 14 次（对比昨晚 cv 1→11 的刷屏明显收敛）。
`stale_plan_run` 全文 0 次：修订直接中断 Flow，没有迟到写入，属合理结果。发现 2 记「已修复 + 已复验（中断路径）」，授权器拒绝分支列为可选加强变体。
未覆盖：R3 退避阶梯与 R4 排队超时提问需排队 >2 小时；队列位次 UI 登记为已知缺口。夹具污染 `initial-result.txt`（02:25，重建前写入）已清理。

## agent-browser 挂死规避 + V02 复验（2026-09-10）

**挂死根因（用户定位，上游 issue #1308 / #1713）**：agent-browser 无 per-command deadline，stdout 接管道（`| Select-Object`、`| Out-String`）会在 establishment 后无限挂，且对优雅信号免疫。
**规避**：`.tmp/ab.ps1` 包装器——`Start-Process -RedirectStandardOutput <file>`（不走管道）+ `WaitForExit(超时)` 超时即 `Kill()`，再 `Get-Content` 读文件；同一轮复用单一 session/daemon，不再每轮清进程换 session。实测命令全部秒级返回。
新增 [V02 复验记录](./evidence/short-scenarios/ACC-20260907-01/V02-retest-20260910.md)：视觉回合、重启持久化、陈旧帧探针三项 PASS（`seq=4818/4819/4828`、`seq=4832/4833`）；导出业务包未取得产物（`Backup ZIP` 点击后 backups/ 无新增 ZIP，疑走原生保存对话框），待补。

## agent-browser 机器级补丁（2026-09-10）

**根因修正（上游 [#1407](https://github.com/vercel-labs/agent-browser/issues/1407)，PR [#1781](https://github.com/vercel-labs/agent-browser/pull/1781) 待合并）**：挂死机制为 Windows 下 detached daemon 经 `bInheritHandles=TRUE` 继承调用方 stdout/stderr 管道写端，CLI 退出后调用方等待管道 EOF 永不返回；仅「拉起 daemon 的那次冷启动调用」会挂，暖 daemon 秒回。#1308/#1713 是同一机制的不同表面。
**本机补丁**：npm 全局 shim（`agent-browser` / `.cmd` / `.ps1`）改经 `bin/agent-browser-safe.js` node 启动器——输出被捕获时用 node 自有管道转发，子进程退出后 500ms 静默窗（5s 硬上限）收尾。幂等 re-apply：`D:\.airi-smoke\patch-agent-browser.ps1`（每次 `npm i -g agent-browser` 后重跑；#1781 发版后整体移除）。Defender 排除已加 `npm\node_modules\agent-browser\`。
**验证**：冷 session + PowerShell 捕获 5.7s（原 17min+ 挂死）、暖 daemon 2.1s、bash 管道 2.6s、直出路径不变。

## FIX1 调试全过程与结算通过（2026-09-10）

新增 [调试全过程记录](./evidence/short-scenarios/ACC-20260907-01/FIX1-DEBUG-JOURNEY-20260910.md)，保留两个问题、三次修复尝试、每次失败原因、最终验证证据与复盘。
**问题 A（journal 断供）**：`flushPending` 的 append IPC 永不返回会永久占住 in-flight 锁；改为与 10 秒超时竞速 + 退避重试后恢复秒级落盘。
**问题 B（完成门死锁）**：前两版修复（按会话分组 / 全局最新长期计划）均不足；外部模型纠正了「这些是 long 计划」的事实错误（它们是 session 计划），并指出取代只折 `activeSessionPlan` 且该计划已无开放步骤 → 一条 skip 都没写。最终按**车道化**修复：合取只取每条车道最新计划、`start` 折叠整条车道、`focus/complete` 按 stepId 解析目标。
**复验**：`seq=4721 verdict=pass` → `seq=4722 flow/end done` → `seq=4789/4790` 二次运行通过 → `seq=4794 goal/update completed`；`revised-result.txt` 正确、`initial-result.txt` 不存在、修复后无 `user/ask`。
**遗留两条 UI 问题**（见记录第 7 节）：停止任务按钮无响应；心流指示器标题恒为旧文本。

## FIX1 死锁总说明（2026-09-09）

新增 [死锁总说明](./evidence/short-scenarios/ACC-20260907-01/FIX1-DEADLOCK-SUMMARY-20260909.md)。
问题 A（journal 断供）已修复并验证（4300+ 行、秒级落盘）；问题 B 未修：完成门 blockers 引用**非活跃长期计划**（`plan fa4f2116`、`plan 47d19edd`）的步骤，而活跃计划的步骤是 `step-1-read-brief … step-8-verify-initial`，模型对这些 stepId 调 `plan_update complete` 报 `Unknown stepId` → 硬死锁，5 次 `user_ask` 求助，最终用户两次取消（`goal/update cancelled`）、`flow/end interrupted`。
根因线索：`builtin/plan.ts` 的 skipped 取代分支只覆盖 `horizon === 'session'`，long→long 未覆盖；完成门引用的计划集合与模型可操作的活跃计划集合未由同一解析函数产出。

## 调查简报（2026-09-09）

新增 [调查简报](./evidence/short-scenarios/ACC-20260907-01/INVESTIGATION-BRIEF-20260909.md)，供外部模型独立排查两个未解问题：journal 重启后不落盘、完成门循环。简报自包含环境、证据、相关代码、已尝试的两版修复、复现步骤与需要回答的问题。

## FIX1 复验失败：完成门循环未解 + journal 不落盘（2026-09-09）

新增 [复验失败记录](./evidence/short-scenarios/ACC-20260907-01/fix1-retest-failure-20260909.md)。
重建重启（21:57）后复验：完成门仍拒绝，blocker 指向**最新计划自身**的步骤（`blocked / not started`），模型循环重建计划至第 17 轮，用户于 22:17 手动停止。1a 的「排除旧计划」不是循环的唯一原因。
同时发现 journal **20 分钟零落盘**：`40ae9ae5….jsonl` 最后写入 21:57:07 / `seq=1718`，而 `revised-result.txt` 在 22:02:41 被写入。完成门依赖 journal 投影，落盘链路异常可能是循环的直接原因。
未变好：`initial-result.txt` 仍未被写。

## 问题 1a 修复 — 被替换的长计划不再阻塞完成门（2026-09-09）

新增 [修复记录](./evidence/short-scenarios/ACC-20260907-01/fix-1a-superseded-plans-20260909.md)。
根因：`evaluateFlowCompletion` 把 Flow 窗口内出现过的所有计划都交给完成门，而 `plan_update start` 对长期目标总是新建计划 id，旧计划的步骤永远不会完成，于是永久报 `step has not started`。
修法：新增 `selectFlowCompletionPlans()`，长期目标每个会话只保留最新一份进入完成门；无会话绑定的长期计划按是否被触及判定。
回归：stage-ui plans 30、chat contract 30、long-goals browser 6 全绿；typecheck 与改动文件 eslint 退出码 0。运行态复验待重建。1b（未验证收尾仍记 completed）保留现状，属产品口径决定。

**1b 口径（用户拍板：A）**：目标仍记 `completed`，但原因带上未验证步骤——新增 `longGoalCompletionReason()`；`long-goals.browser.test.ts` 7 通过。
**构建重启**：21:47 `pnpm -F @proj-airi/stage-tamagotchi build` 退出码 0；结束 PID 22744、等 8 秒后重启，CDP `9250` 立即就绪，新主进程 PID 26004。

## 未关闭问题清单（2026-09-09）

新增 [未关闭问题清单](./evidence/short-scenarios/ACC-20260907-01/open-findings-20260909.md)，汇总五条产品缺陷（完成门被旧计划步骤阻塞、记忆同步 update 先于 insert 丢数据、构建版 grep 未用 ripgrep、L04 恢复叙述时间线错误、心流指示器显示旧目标步骤）、两条环境备忘，以及三项待用户决定事项（R03 账户契约、grep 修法、是否修完成门）。

## L07 修订窗口实测（2026-09-09）

新增 [L07 实测记录](./evidence/short-scenarios/ACC-20260907-01/L07-revision-live-20260909.md)。
用户在 300 秒等待窗口内发出修订，`user/steering` 在写入前送达（`seq=1074` < `seq=1082`）：旧目标 `initial-result.txt` **未被写入**，新目标 `revised-result.txt` = `L07D-TOKEN-5C2B84` 写入并读回——行为层 PASS。
结算层 FAIL：完成门两次 `verdict=rejected`（`seq=1112`、`1231`），blockers 指向被替换计划的旧步骤（step-1 blocked、step-2/step-4 not started），Flow 没有 `flow/end`，目标停在 `waiting-condition`。
本次修订走 steering 文本而非结构化 `/goal`（`cv` 始终为 1），因此不构成复核发现 2 的运行态证据。

## L07 修订窗口重试（2026-09-09）

新增 [L07 重试记录](./evidence/short-scenarios/ACC-20260907-01/L07-revision-retest-20260909.md)。
`/goal ACC-20260909-L07c` 的 Flow 在 60 秒等待后立即完成写入与读回（`seq=841..1008`），修订消息到达前流程已结束，L07 仍待覆盖。
运行态摩擦：本轮 `agent-browser` 多次产出后不退出、`snapshot -i` 长时间无输出；清掉 14 个残留守护进程后恢复；`tab new` 在 Electron 下不支持。下一轮把等待延长到 300 秒并在 `sleep` 一出现就发修订。

## 验收运行备忘 — 重启后要等端口释放（2026-09-09）

结束 Electron 后立刻重启时，新实例可能**静默绑定失败**：本轮一次重启后 CDP `9250` 全程不可用（`/json/version` 拒绝连接），而 renderer 命令行仍带 `--remote-debugging-port=9250`。磁盘 journal 照常写入，所以只看 journal 不会发现。
处理：结束进程后等待数秒再启动；启动后必须用 `http://127.0.0.1:9250/json/version` 复核，而不是只看进程存在。

## L05 变体 C — PASS（2026-09-09）

新增 [L05 变体 C 记录](./evidence/short-scenarios/ACC-20260907-01/L05-variant-c-20260909.md)。
夹具改为只含随机 token `L05C-TOKEN-4F7B2E` 且目标明确「不要猜测」；`sleep 60` 挂起时删除输入并结束进程。
重启后同一 Flow 继续，`read` → ENOENT，`list` 确认目录为空，模型 `flow_update blocked` + `user_ask`（超时），`flow/end reason=blocked`；目录 0 文件、无伪造输出，目标停在 `waiting-condition`，面向用户的话术准确说明阻塞原因。
L05 主分支 PASS。结算未持久化窗口按计划记 BLOCKED，由受控故障注入回归覆盖。

## L05 变体 B（2026-09-09）

新增 [L05 变体 B 记录](./evidence/short-scenarios/ACC-20260907-01/L05-variant-b-20260909.md)。
`sleep 60` 挂起时删除 `brief.txt` 并结束进程；重启后同一 Flow 继续，`read` 报 ENOENT，模型多次 `list`/`grep` 未找到文件，仍写入 `result.txt=ACC-20260909-L05b`。
失败分支未触发：RUN 标记同时出现在目标文本与目录名里，模型据此推断答案。修正办法是让目标要求的输出只能来自文件内容（随机 token）。
正面证据：第一次 `flow/completion-review verdict=rejected`，重建计划后才 `pass`。

## L05 变体 A（2026-09-09）

新增 [L05 变体 A 记录](./evidence/short-scenarios/ACC-20260907-01/L05-variant-a-20260909.md)。
`sleep 60` 挂起时把 `brief.txt` 改名为 `brief.txt.moved` 并结束进程；重启后同一 Flow 继续，`read` 失败后自行 `list` 目录、读到改名文件、写入并读回 `result.txt`，`completion-review verdict=pass`。
未制造出失败分支：L05 仍待覆盖，失败分支需要输入真正缺失。

## V01 视觉复测（2026-09-09）

新增 [V01 复测记录](./evidence/short-scenarios/ACC-20260907-01/V01-vision-retest-20260909.md)。
通过聊天输入区真实文件输入上传 PNG 夹具（白底、红圆、蓝方、文字 `ACC-20260909-V01`），模型正确报出四项。
机制证据：该会话零 `tool/*` 事件、`memory/retrieved` 为空，文字只可能来自图片。原始 FAIL 保留。
已知限制：本构建聊天列表不渲染图片附件，journal 的 `user/message` 只记文本。

## 技能输入契约运行态复验与 grep 降级（2026-09-09）

新增 [运行态复验记录](./evidence/short-scenarios/ACC-20260907-01/live-skill-contract-and-grep-20260909.md)。
重建后同一会话真实调用 `acc-20260909-dedupe`：`["a",3,null]` 在沙箱前被拒（`input.items[1] must be a string`），`[" a ","b","a",""]` 执行并返回 `["a","b"]`；K04 运行态状态更新为 PASS，早先 FAIL 保留。
新发现：构建版主进程把 `@vscode/ripgrep` 打进 chunk，运行时 `createRequire(import.meta.url).resolve` 看不到平台包，`resolveRipgrepPath()` 返回 undefined，grep 一直走 Node 兜底并声明 `search binary unavailable`。C1 的 ripgrep 路径在构建版从未生效；修法需用户先选依赖方案，本批只记录。

## L04 崩溃后恢复干净重跑（2026-09-09）

新增 [L04 干净重跑记录](./evidence/short-scenarios/ACC-20260907-01/L04-crash-clean-20260909.md)。
在重建后的构建上，`bash sleep 90` 挂起时结束进程，重启后同一 Flow/task 继续、模型用全新步骤 ID 重建计划；恢复后一次写入、一次读回，`completion-review verdict=pass`，`flow/end reason=done`，目标 `已完成 · 3/3`。
机制 PASS。新发现：追问恢复过程的回答把恢复后的 ENOENT 检查、写入与读回说成「中断前证据」，并引用恢复后那次 `sleep 90` 的 `exitCode 0`，未准确区分中断前证据与恢复后检查。

## 验收状态对齐与 V02 覆盖核查（2026-09-09）

新增 [状态对齐记录](./evidence/short-scenarios/ACC-20260907-01/status-alignment-20260909.md)，按复核建议维护「历史结果、最近结果、证明范围、剩余变体」四列，原始登记不改写。
对齐 D05/D06 的历史 FAIL 与后续 PASS、R02/R03 的 PARTIAL、K05–K07 的真实 PASS，并补齐 lint 实际排除范围（`docs/fork/evidence/short-scenarios/**`、`.zcode/**`、`skills/acc-20260909-dedupe/**`）。
复核发现 3 的自动化部分已由 `mirror-visual.test.ts`（一次性帧槽、失败失效、下游异常释放）与 `mirror-snapshot.test.ts`（捕获失败降级）覆盖；重启/导出边界仍属运行态，保持未验证。

## R06 断线、重连与 outbox（2026-09-09）

新增 [R06 记录](./evidence/short-scenarios/ACC-20260907-01/R06-outbox-reconnect-20260909.md)，状态 PARTIAL。
断线期间远端错误可见，outbox 保留 `update` 条目并记录 originId、尝试次数与错误；本地事实仍可召回；重连后队列清空。
新发现：`update` 先于 `insert` 时投递被当作成功，outbox 清空但远端无对应行（`656b0f6f-…` 查询 0 行），批准状态未到达远端。未产生 `insert`/`delete`，完整次序收敛与 tombstone 未覆盖。

## M07 新会话首问配对（2026-09-09）

新增 [M07 配对记录](./evidence/short-scenarios/ACC-20260907-01/M07-firstq-pairing-20260909.md)。
全新会话首问在记忆开启时命中已批准的 Flow 来源事实（`seq=5`），零工具调用，回答中的 marker 内容与 `contentHash` 和实际文件逐字节一致。
记忆关闭时检索为空，但模型改用工作区工具作答，记为混杂项，不作行为通过。

## 修复批独立复核（2026-09-09）

新增 [独立复核记录](./acceptance-review-20260909.md)，核对修复实现、追加验收与指定会话 journal。
253 项定向回归通过；发现技能 Schema 未支持约束被静默接受，列出恢复后修改约束的授权缺口与后续复现条件。
收窄 V02 清理和 M07 首问召回的证明范围，记录 D05/D06、R02/R03 等汇总状态冲突。
本批仅增加复核文档，不修改产品代码、用户 profile 或原始验收结果。

## 验收后代码审查回填设计（2026-09-08）

后续实施批：备份 leader owner、技能源码/自测审阅与哈希绑定、30 分钟社交跨轮去重、长期目标恢复单入口、证据门分类、adoption 调度初始化、dreaming 主体隔离均已修改。
设置页和聊天卡复用同一审阅组件；目录提交在 follower-to-leader RPC 前增加结构化克隆，新增隔离浏览器回归，保留真实 Pinia、聊天和计划行为。
验收产物单独排除格式检查，未改原始字节。已用明确的用户 profile/provider/CDP 参数重建并重启 Electron；未覆盖 provider 凭据、角色卡或主对话内容，未创建提交。
检查结果、边界与剩余验收顺序见 [实施记录](./acceptance-repairs-20260908.md)。以下保留此前仅文档批次的原始说明。

将 ACC-20260907-01 的代码审查结论补回 DR/MQ/PC/LG/SP/SG/MD 七份原执行文件，并更新总索引、观察准入和短场景入口。
沿用原批次，分别记录可开始修复、先补测定位、前置依赖与关闭条件。
包含备份 owner 注册、技能源码审阅、跨轮社交去重、长期目标恢复双入口、证据语义和 dreaming 主体隔离。
新会话空回答、旧工作区读取、拒绝重试与步骤归属保留为定位任务；审批超时补测按代码的 60 秒执行。
62 项原始验收结果保持 22 PASS、18 FAIL、22 BLOCKED。上述审查回填阶段仅修改文档；随后代码修复、构建和运行态复验见实施记录。

## 七维短场景验收计划（2026-09-07）

新增 [短场景交互验收计划](./short-scenario-acceptance-plan.md)，并加入七维总索引。
计划沿用带用户 profile 的构建版 Electron，通过 CDP 与 agent-browser 执行。
共 62 个场景，覆盖四项基本排查发现、任务介入、记忆与角色隔离、长期目标恢复、20 个社交刺激、视觉、技能及非空数据恢复。
每项记录具体话术、预期回答、行为与持久化证据；全部待执行，不宣称修复或验收通过。

## Postgres 镜像真实回归（2026-09-07）

Docker 恢复后使用 compose 的本地映射连接串运行 `memory-pgvector` 集成测试，4/4 通过。
覆盖插入/检索/删除、`originId` 幂等、删除 tombstone 防复活，以及审阅/修订/删除传播。
这只证明远端镜像契约；90 条真实 provider/profile 记忆评估、断线恢复和打包 Electron 仍未完成。

## MQ-0 生产 trace 接线（2026-09-07）

生产 memory store 评估现在记录原始/归一化查询、两路完整候选与最终注入候选，并传递实际 session/scope；OpenAI-compatible embedding provider 的两路 query token usage 也会保留。成本字段支持实际费用或显式价目估算，缺失值不会伪装成零；memory-core 成本指标 4 条、stage-ui 评估 3 条测试通过。2026-09-07 已在隔离本地 profile 的 Electron renderer 中运行 90 条 synthetic gold 基线，见 [MQ-0 接线证据](./evidence/mq-0/wiring-findings.md) 和 [生产报告](./evidence/mq-0/production-report-20260907.md)。外部 provider、真实用户事实和费用价目仍待执行。

## DR-1 完成评审裁决（2026-09-07）

审批结算增量：命令和计划审批超时都广播拒绝回执，显式裁决清理计时器，迟到审批不重复结算。
两条缺陷先复现后修复，主进程与执行策略共 13 条测试通过。见 [审批证据](./evidence/dr-20260907/approval-settlement.md)。

DR-1 评审增量：修复弃权/否定/驳回文本因包含 pass 或 approve 而被误判通过。
结构化裁决不再落入全文关键词搜索，纯文本只识别明确的起始裁决。
112 条完成门与运行时回归通过，core-agent 生产导出已重建。见 [证据](./evidence/dr-20260907/reviewer-verdicts.md)。
根 typecheck 与 lint 均退出码 0。

完成门补充：批准请求的 rejected、cancelled 和未决状态现在分别显示为拒绝、取消和待批准，
超时拒绝回执因此能沿用同一条阻塞路径。evidence-gate 22 条测试通过；真实窗口和人工接手组合仍待验收。

完成边界补充：L1 完成门先处理审批等待和失败状态，再接受模型的 `declaredComplete` 声明，
所以待审批或失败步骤不能以未验证关闭越过 done 边界。core-agent flow-completion 定向回归
13 条通过；真实审批、超时和人工接手组合仍未验收。

计划投影补充：stage-ui journal 投影不再把审批阻塞或明确失败的模型 `completed` 声明加入
`completedSteps`，用户可见计划会保留 approval/failed blocker。plans 定向回归 19 条通过。

DR-3 journal 补充：journal host 按已落盘 seq 集合去重，允许在 `seq=1,3` 后补写 `seq=2`；
写入异常会丢弃内存集合并在下一次调用重新扫描，覆盖写后回执丢失。journal-host 定向回归
11 条通过，真实打包故障组合仍未验收。

DR-2 键盘停止补充：聊天历史通过 VueUse `useEventListener` 监听 Escape，在存在运行中或等待用户的
TaskRun 时发出既有 `stopTask` 事件；输入框、文本域和 contenteditable 保留自身 Escape 行为。
task activity contract 4 条通过，stage-ui typecheck 通过；真实窗口与窄屏验收仍未运行。

MD-2 恢复异常补充：独立 profile 的归档校验、导入或 bootstrap 失败会释放本地 owner 初始化，
但继续保留 durable effect hold；renderer 不再永久等待，损坏 profile 仍不会自动执行外部副作用。
随后已完成重新打包 Electron 的独立 source/restore profile 运行，且补充非空 memory row 恢复；
custom skill workspace 和非空 outbox/scheduler 关系仍待运行，见 [打包恢复证据](./evidence/md-2/packaged-restore-20260907.md)。

## MD-2 恢复回执故障回归（2026-09-07）

数据库对照增量：快照浏览器回归从单条 tag 扩展到五张表，覆盖事实纠正、来源与作用域、技能肌肉记录、向量元数据、目标状态和经历关系。
真实 DuckDB-Wasm 导出、损坏回滚及关闭重开后的完整行对照通过，未替代 Electron 独立 profile 验收。
详见 [数据库证据](./evidence/md-2/database-roundtrip-20260907.md)。
本批根 typecheck 与 lint 均退出码 0。

副作用门增量：主进程恢复标记在后续启动继续约束自动副作用；本地初始化不再同时释放 outbox 和调度。
修复恢复删除记录被远端重放，保留队列及重试时间。聊天即时发送和删除回执、dreaming、社交、旧 Flow 与目标调度采用同一暂停判断。
本批没有开放解除暂停的入口，真实远端和打包验证仍未完成。见 [执行证据](./evidence/md-2/restore-effects-20260907.md)。
本批浏览器 6 条、Node 55 条测试通过；根 typecheck 和 lint 均退出码 0。

恢复 profile 的副作用保持新增持久 adoption 回执：完成恢复前后对照后由
`adoptRestoredProfile()` 明确释放，后续启动读取同一决定，不再永久暂停或隐式恢复。
数据设置页现在提供该动作，并通过主进程事件同步所有 renderer。主进程 profile、renderer gate、
stage-ui 与设置页 typecheck 通过；打包 fixture 已运行，非空 owner 对照仍未完成。

后续 owner 批次：修复 renderer 恢复导入死锁，普通 owner 启动等待持久回执。
恢复时先写角色身份，再由聊天 owner 选择会话；gate 关闭时不改写归档消息。
已审技能保留审阅哈希，在启动源码复核前不注册。浏览器 10 条与 Node 32 条测试通过。
本批根 `pnpm typecheck`、`pnpm lint` 均退出码 0。
范围与剩余项见 [owner 回归证据](./evidence/md-2/restore-owners-20260907.md)。

## SG-1 自测证据恢复校验（2026-09-07）

修复技能恢复校验把 `selftest.mjs` 哈希误当源码哈希的问题。`skill_submit` 记录的自测哈希现在与归档自测文件逐字节核对；自测文件被替换时恢复拒绝，源码审阅哈希仍单独校验。stage-ui 数据恢复 2 条、stage-tamagotchi skill-submit 8 条定向测试通过；真实 profile 重启、三种不同输入的实用技能毕业考和修订/退役/恢复行为仍待运行。

SG-1/MD-2 恢复副作用补充（2026-09-07）：技能 `restore()` 现在尊重 restored profile 的
durable effect hold；adoption 前不注册已审技能，`backupAdopted` 后再执行源码复核并注册。
stage-ui skills 浏览器回归 5 条通过；真实 profile adoption 和打包运行仍未验收。

MD-2/DR-3 打包启动补充（2026-09-07）：Electron main bundle 将 `@proj-airi/skill-forge`
加入 workspace alias 与 externalize exclude，修复打包后外置包解析 extensionless `./hash`
导致的启动失败。重建并运行 `memory-runtime-smoke.ts --launch --port 9267` 通过，main SHA-256
为 `7e173eb43b0d3a0770737a66427340310e7153eecf1b7d9a6d40ecde530c5342`；仅证明打包启动和 CDP，
未做页面交互、profile 导入或真实 provider。

MD-2 增量（2026-09-07）：修复恢复回执重复确认和持久化写失败后的提前完成状态，补充 7 条主进程恢复测试。
仓库 typecheck 与 lint 通过；DuckDB owner 7 条测试通过。本批运行与未覆盖边界见 [恢复回执证据](./evidence/md-2/restore-receipts-20260907.md)。
完整 owner 启动、数据关系对照和打包运行仍未完成。未创建提交。

## 七维升级执行计划（2026-09-06）

新增 [七维升级总索引](./upgrade-roadmap.md) 和七份执行文件：

- [日用可靠性与任务透明度](./daily-reliability-plan.md)：DR-0 至 DR-4。
- [记忆语义质量](./memory-quality-plan.md)：MQ-0 至 MQ-4。
- [人格与关系连续性](./persona-continuity-plan.md)：PC-0 至 PC-4。
- [跨天目标管理](./long-horizon-goals-plan.md)：LG-0 至 LG-4。
- [主动交流与共同活动](./social-presence-plan.md)：SP-0 至 SP-5。
- [技能持久积累](./skill-growth-plan.md)：SG-0 至 SG-4。
- [单人维护与数据所有权](./maintainability-and-data-plan.md)：MD-0 至 MD-4。

总索引记录旧计划的后续批次、当前解释和新批次归属，包括 TASK-RUN F、
可靠性 R5、记忆多视图 D 与 reranker F、CONSIDERATION 5、LIFE M4-L0 至 L3、
rewind、Hashline 基准、本地 RPC、镜像媒体扩展和外部代劳层。
已实施项保留为回归基线，已取消的 dsh 适配不再排期。
COMMAND Phase E 的历史实现记录与后续社交边界冲突交给 LG-0 核对，
不得恢复社交考量执行工作或 Plan 自续跑的旧路径。

本批只交付文档，没有实现七维路线的生产代码，也没有重新验收历史功能。
各执行文件包含代码入口、所有权、依赖、步骤、验收与待执行状态。

检查：八篇新文档的本地链接和一级标题检查通过，文档差异检查通过。
仓库指南中的 `pnpm type-check` 因脚本不存在失败，改用实际的 `pnpm typecheck`
后通过；`pnpm lint` 退出码 0，非本批文档中的既有警告保留。
本轮未运行 Vitest、真实 provider、Electron 或 Postgres 场景。

## DR-0/DR-2 — 日用可靠性局部执行（2026-09-06）

- 完成 DR-0 基线核对：登记工作树、构建产物、隔离 Electron profile、旧 F/T/L/R 编号和本次证据边界。
- 完成 DR-2 的代码缺口：`core-agent` 的 `TaskRun` 发布最多 40 行的结构化活动投影，按 `taskId`/`flowId` 隔离；stage-ui follower 面板只消费该投影，不扫描或同步全量 journal。
- 受控双窗口 Electron 冒烟通过：leader 的 `dr-task` 活动快照到达 follower，follower 显示任务摘要和工具调用计数；运行无真实 provider/model、Postgres 或用户数据。Vishot 专用 task-activity 场景在打开 chat 窗口时超时，按要求改用直接 main-window capture，产物已检查并登记。
- 验证：core-agent 全量 26 files / 269 tests 通过；stage-ui browser 50 tests 通过；stage-ui node 874 tests 通过但进程有 provider 网络 fetch 的环境级未处理拒绝；tamagotchi 全量有 4 个 Windows symlink/path 环境失败。三个 owning package typecheck 与 Electron build 通过；根 typecheck/lint 的最终结果见证据记录。
- Docker Postgres repository integration 4/4 已通过；真实 provider、网络断线恢复、打包 EXE、>2,000 条 journal 重启及 DR-4 条件扩展仍未验收。详见 [DR 执行证据](./evidence/dr-20260906/dr-execution-record.md) 和 [MQ-0 Postgres 证据](./evidence/mq-0/postgres-integration-20260907.md)。

## DR-1/DR-2/DR-3/DR-4 — production profile 继续执行（2026-09-06）

- 按用户许可重启默认 user profile 的 production Electron，并在重建后的 bundle 上复验。真实 provider 完成只读成功、只读失败、失败后写入并复读、`user_ask` 回答和问题等待中停止；probe 内容与 SHA-256 已登记在 [日用可靠性计划](./daily-reliability-plan.md#7-继续执行记录2026-09-06)。
- 修复两个真实发现：`flow/start` 先于命令 `user/message` 时，TaskRun 标题改从当前 flow 窗口取命令；legacy journal 缺少 header 时，hydrate 合成带 `seq: 0` 的 header。分别加入 core-agent 和 stage-ui 回归。
- production follower 收到真实 TaskRun 活动；最新任务为 completed，活动 28 行并含 read/write/flow_update/completion-review。停止场景记录 interrupted，停止后无新工具调用。
- DR-3 长 journal 盘点发现最大文件 3,308 行/最高 seq 3,113，无 gap/坏行但有 195 条重复 seq；该日 Postgres 端口拒绝连接且 Docker daemon 不可用，属于历史环境记录。当前 Docker Postgres integration 4/4 已通过，网络断线和打包 EXE 仍留待后续。
- DR-4 Hashline 前置因目标模型和一次真实写入样本成立，但 20 文件校准尚未执行；环境摘要和 rewind 条件未触发。
- 验证：core-agent 270/270；stage-ui journal 10/10；memory-core 32/32；memory-pgvector 单测 5/5，Docker integration 4/4；core-agent 与 stage-tamagotchi build 通过。未创建提交。

## M-RP — 记忆检索与持久化（2026-09-06）

完成 [记忆检索与持久化路线计划](./MEMORY-RETRIEVAL-AND-PERSISTENCE-PLAN.md) 的批次 A、B、C、E：

- DuckDB 增加 checkpoint、关闭生命周期、失败状态和 leader-only OPFS 写句柄保护；记忆浏览页显示数据库、checkpoint 和迁移状态。
- 本地 DuckDB 与 pgvector 保存 embedding provider、model、dimensions、input type、fingerprint、生成时间和 active/stale 状态；当前查询只读取匹配的 document 向量。
- embedding source 切换支持有界批次迁移、断点状态和显式 `reembedMemoryVectors()` 命令；Voyage 请求区分 `document` 与 `query`。
- 长查询使用原始与机械归一化双路召回，结果按 id 去重并保留两路相似度诊断；journal 记录候选来源。
- 评估 fixture 扩展为 9 个 strata、每组 10 条，并加入 precision、误召回率、token 成本和额外延迟字段。

验证：相关类型检查通过；stage-ui node 测试 140 个文件、873 条测试通过；memory-pgvector 单元测试 5 条通过。需要外部 Postgres 的 4 条集成测试未运行。构建版 Electron 按指定命令使用默认用户 profile + CDP 9250 经 agent-browser 验收，长期记忆设置页与本地 DuckDB 兼容迁移通过；对话请求已抵达 `openai-compatible` provider 并返回 `provider-ok`，随后通过已有长期记忆相关问句得到“跑相关测试”，确认记忆上下文可读。验收启动约束已晋升为正确 profile 中的 `long_term` 记忆（`approved`、3 次访问、2 个会话）；具体 PowerShell 命令和 profile 路径见 [路线计划](./MEMORY-RETRIEVAL-AND-PERSISTENCE-PLAN.md)。验收默认不使用隔离 profile。批次 D（多视图内容）和 F（reranker）仍未实施。

## 可靠性修复与长期路线计划（2026-09-05）

新增 [短期可靠性修复与长期路线](./reliability-and-roadmap-plan.md)。
本批只交付计划，没有实施运行时代码修复。
计划记录 journal 与长期记忆 SQL 的调查证据，列出 R1–R6 的依赖与验收条件。
长期路线区分能力贯通、可靠日用、持续自主和长期陪伴与成长。
其中完成状态政策、长期方向和观察窗口均为建议，不记为已验收能力。

## 改动动机

桌面端（stage-tamagotchi）无论接哪家模型都出现两类问题：

1. **MCP 工具调用幻觉**：模型"以为"自己调用了工具。根因是 MCP 只暴露两个
   代理元工具（`builtIn_mcpListTools` / `builtIn_mcpCallTool`），参数要求
   `"<server>::<tool>"` 字符串 + JSON 字符串里再套 JSON 的双重编码，失败率极高；
   一次工具相关报错还会触发**静默永久降级**（本会话内直接移除 `tools`），而系统
   提示仍在宣传工具存在，模型只能用纯文本表演调用。
2. **跨轮遗忘**：工具调用结果不进下一轮上下文。流中途失败时整条 assistant
   消息被丢弃；transcript 只在最终消息含 tool 角色时才捕获。

## 改动清单

### M1 — MCP 工具扁平化（`23c6c5bf7`）

- `packages/stage-ui/src/tools/mcp.ts`：新增 `sanitizeMcpToolName`（
  `mcp_<server>_<tool>`，字符集 `[A-Za-z0-9_]`，≤64 字符，超长加稳定哈希）、
  `normalizeMcpInputSchema`（强制 `type:'object'` + 对象 `properties`）、
  `createMcpNativeTools`（每个 MCP 工具生成一个 `rawTool()`，执行时映射回限定名，
  主进程 IPC 零改动）。
- `apps/stage-tamagotchi/src/renderer/stores/tools/mcp.ts`：`refresh()` 先
  `listTools()`；有描述符 → 只注册原生工具；空/失败 → 回退旧元工具。
- `packages/stage-ui/src/stores/ai/chat-llm/tool-resolver.ts`：存在 `mcp_*`
  运行时工具时抑制默认元工具注入（显式 `builtInTools` 覆盖仍优先）。
- `apps/stage-tamagotchi/src/renderer/pages/settings/modules/mcp.vue`：
  apply-and-restart 成功后立即 `refresh()`（原来要等下次领导者选举）。

### M2 — 降级可见化 + transcript 防丢（`8ce05bf4e`）

- `packages/stage-ui/src/stores/ai/chat-llm/llm.ts`：命中 `isToolRelatedError`
  时弹 vue-sonner `toast.warning`；暴露 `degradedToolKeys` 与 `reEnableTools()`。
- `packages/core-agent/src/runtime/chat-orchestrator-runtime.ts`：
  - transcript 捕获条件放宽为"最终消息含 tool 角色 **或** 流式期间见过工具事件"；
  - 流中途失败时持久化部分 assistant 消息（原来整条丢弃）；
  - 传输层没交付 transcript 时，从流式 tool-call/tool-result 事件合成一份。

### M2.5 — 分层提示词注入管线（`f946642c9` + `16923b2fd` + `699b38d4e`）

系统消息拆成带标题的分节，**会话里只持久化角色身份**，其余发送时组装：

- `## Character`：卡的 systemPrompt/描述/性格/场景（持久，现状不变）。
- `## Stage Control`：ACT/DELAY/CALL 协议 + 情绪/动作表（应用所有；i18n 新键
  `base.prompt.protocol.*`，只翻 en + zh-Hans，其余语言回退英文）。存量卡
  （如 ReLU 官方卡）用 `<|ACT` 标记检测去重不重复注入；**新建空白卡从此自动
  获得协议**——顺带修复"自建卡没有协议 → 情绪系统哑掉"。
- `## Output Formatting`：代码块/数学规则（从 session-store 烘焙迁出到发送时；
  旧会话会出现一次重复，无害）。
- `## Toolset`：工具说明，**降级感知**——模型命中 `degradedToolKeys` 时替换为
  "工具本会话不可用，请勿声称已使用工具"，拆除幻觉放大器；MCP 注册的工具集
  提示会列出已连接服务器与 `mcp_<server>_<tool>` 命名约定。
- `[Reminder]`：卡的 `postHistoryInstructions`（CCv3 字段，原来只序列化从不注入）
  以文本块附到最后一条用户消息，沿用 `[Context]` 的投递形态。
- orchestrator：`getSystemPromptSupplement` 增加 `(model, chatProvider)` 参数。

附带修复（`699b38d4e`）：官方卡教的是 `<|DELAY 1|>`（空格），延迟队列正则只认
`<|DELAY:1|>`（冒号）——守规模型的延迟被静默丢弃。现在两种都接受。

**踩坑记录**：stage-ui 的测试消费的是 workspace 包的 **dist**（postinstall 时构建），
改 core-agent/i18n 源码后必须 `pnpm run build:packages`，否则 contract 测试跑的
还是旧代码（表现为"src 里明明改了却不生效"）。

### M-L — Live2D 双特性 + 云吞落地

**`feat(live2d): configurable focus parameter mapping`**
pixi `updateFocus()` 写死六条增益（AngleX/Y 30、AngleZ xy×-30、EyeBallX/Y 1、
BodyAngleX 10）且在所有插件钩子之后执行、无法事后覆盖。`Model.vue` 现按已有
monkey-patch 惯例包装 `internalModel.updateFocus`：standard 走原生；custom 走
`applyCustomFocus` 纯函数（逐参数的 axis/gain/enable，按 modelId 持久化）。
设置页 animation 区新增模式 Choose + 每参数增益滑杆/开关，可直接调低增益或
关掉某条（云吞这类贴图换瞳模型最需要）。i18n 只补 en + zh-Hans。

**`feat(live2d): per-model custom parameter panel`**
模型自带的发型/瞳孔/服装/耳朵开关此前从未暴露。zip-loader 已把 cdi3 DisplayInfo
解析进 `settings._cdiData` 却无人消费；`coreModel.getModel().parameters` 提供权威
参数 id/范围表。新增 `discoverCustomParameters`（合并 cdi 显示名+分组与 core 范围，
剔除系统托管参数与物理摆锤）+ final 插件 `useMotionUpdatePluginCustomParameters`
（每帧重断言启用的覆盖值，动作/表情也抢不走）——复用 expression-controller 的
任意参数直写模式。设置页新增"自定义参数"Section，按 cdi3 分组折叠展示，启用
Checkbox + 范围滑杆（档位参数如 HairBList 天然变整数滑杆），每模型持久化/可重置。

**落地**：修好 `D:\airi\云吞kumo\云吞kumo\云吞kumo.model3.json`（补齐 Expressions
12 项 + Idle/TapBody motions；VTubeube 导出模型通病——热键在 .vtube.json，
model3.json 是残缺骨架），重打成 `D:\airi\云吞kumo.zip`（已保留中文文件名）。
注意：AIRI 导入的是 zip 进 IndexedDB+OPFS 缓存，改磁盘文件夹无效，必须重打包
导入新 zip（新 id → 新缓存键，无需清缓存）。

### M-L2 — 表情写入跨窗口修复 + 外观工具接入 LLM

**表情开关无效（根因）**：`registerExpressions` 把目录镜像进 localStorage 让设置
窗口能"列出"表情，但 `toggle` 只改本渲染进程内存里的 `expressions` Map。设置窗口
和舞台窗口是两个 Electron 渲染进程、两套 Pinia，所以设置页勾选只改了自己那份副本，
真正持有模型、每帧读自己 Map 的舞台窗口从未收到 → 勾了没反应。自定义参数没这问题，
因为它的覆盖值本来就存在 localStorage-backed ref 里、插件每帧重读。

修法：把运行时值从 `expressions` 里抽出来，改成 localStorage-backed 的
`live2d/expression-values`（按 modelId → 参数名 → 数值），两个窗口都读写它；
`expressions` 变成 `catalog`（静态元数据）+ 值的 computed 合并，对外形状不变，
所以 expression-controller / 设置页 / 工具都不用改调用方式。定时自动复位的
timer 仍是渲染进程本地的（handle 不可序列化，谁排的谁负责）。`llmMode` /
`llmExposed` 同理跨窗口化——否则设置页选了"全部"，跑工具的舞台窗口也看不到。

回归测试 `expression-store.test.ts`：两个 Pinia 实例 + 手动派发 `storage` 事件
（jsdom 不会为同文档写入自动发），断言设置窗口的 toggle/resetAll 能到达舞台窗口。

**"公开给 LLM"此前确实是 WIP**：`expressionTools` 写好了但从没被任何地方注册，
`isExposedToLlm` 也没有任何调用方——选"全部"只会弹提示。现在：
- `built-in.ts` 把 `expressionTools()` + 新增的 `live2dParameterTools()` 一起注册，
  并加进 `artistryToolReferences`（主聊天路径）。
- 每个工具都按 `llmExposedGroups` 过滤；`expression_get` 不传名字时只列已公开的组，
  不泄露用户设为私有的表情。删掉 `expression_save_defaults` 的暴露——那是改用户
  持久化默认外观的设置项，不该由模型代劳。
- **更复杂的参数也暴露了**：`parameter-tools.ts` 三个工具
  （`live2d_parameter_list` / `_set` / `_release`）把自定义参数面板那 200+ 个
  模型原生参数开给 LLM，值按 min/max 夹取，一次调用可设多个参数（组合外观算一次
  视觉变化）。云吞有 212 参数 / 24 分组，全开会淹掉工具描述，所以设置页同样给了
  无/全部/自定义三档 + 逐参数勾选。
- toolset prompt 告诉模型两层怎么选：命名表情优先（那是绑定师调好的组合），
  参数只用于表情做不到的细节（发型/瞳孔/耳朵/挂件）。用户没公开任何东西时
  整段 prompt 不注入，不浪费 token。

顺带清掉了上一轮排查留下的 `TEMP-DIAG` 日志。

### M-D — 设计文档集（六份，尚未实现）

勘探后产出的设计稿，全部**未写实现代码**。总纲 `DESIGN-PRINCIPLES.md`
说明分歧时的裁决原则，一句话是：**让她的能力可以增长，但让她的错误
无法伪装成成功。**

| 文档 | 回答 | 核心发现 |
|---|---|---|
| `DESIGN-PRINCIPLES.md` | 按什么原则裁决 | 七条原则，第一条是"结构优先于自律" |
| `ATTENTION-DESIGN.md` | 什么进上下文 | 注意力调度器**已在跑**，只是没接 UI |
| `WORKSPACE-DESIGN.md` | 什么算真的 | 权威表**已写完**在 computer-use-mcp，桌面端零 gate |
| `SELF-AUTHORED-TOOLS-DESIGN.md` | 能力如何增长 | 自证循环：她写的工具产出她要用的证据 |
| `CODING-HARNESS-DESIGN.md` | 如何可靠改代码 | Hashline 是 M1 的同类问题（+15pp） |
| `MEMORY-DESIGN.md` | 什么值得留下 | 四层记忆表**已建好从未使用**，重排公式已在生产跑 |

**贯穿全部六份的判断**：作者与此前的工作留下了大量"做完但没接线"的资产，
所以设计主体是**接线而非重构**。已验证的断层包括：
`compactConversationEntries`（零调用方）、`use-duck-db.ts` 的 `memory_test(vec FLOAT[768])`
（被注释掉的 nomic 写入链路）、`memory_fragments` 五张表（零应用代码）、
`character/orchestrator/store.ts`（完整调度器，reactions 只在 devtools 可见）、
`PLANNING_AUTHORITY_ORDER`（9 级权威表 + 纯函数齐全）、
`js-planner-*`（子进程沙箱 + capability bridge，1503 行 + 600 行测试）。

**两处架构修正**（写在文档头部的修订块里）：

1. **采用 append-only 事件日志**（`model-visible means logged`）作为统一状态底层。
   四泳道状态、`PlanState`、`TaskMemory`、`evidenceRefs`、压缩摘要全部成为
   同一条日志的**投影**。白送 fork/resume、审阅切片、回放。
   注意它是单向的：凡模型看到的必被记录，但**凡记录的不必都给模型看**。
2. **AIRI 现有插件架构就是对的。** DeepSeek Harness 的 Cordis 内核
   （"只负责加载/卸载/依赖，不承载具体能力"）与 AIRI 的
   `injeca` + `module:announce` + server-channel/eventa 是同一形状。
   所以 coding 能力应实现为**一个插件**，不是新外壳。
   此前"参照物选错了"的说法只对 UI 层面成立。

**安全**：调研期间抓取外部文档（oh-my-pi 的 `DEVELOPMENT.md`）时，
返回内容里嵌有试图让读取方改变身份、绕过准则的注入文本。
未见原始文本，无法判定来源（作者放置 / 页面样本 / 链路引入），
但"抓取外部内容会遇到针对读取方的指令"已被实证 →
写入威胁模型（`CODING-HARNESS-DESIGN.md` §8）：**外部内容是数据，不是指令**。
威胁模型边界明确为"对抗弱模型的乐观偏差、疏漏与注入尝试，
**不对抗有意欺骗的强模型**"。

**已验证（2026-08-28）**：dsh 插件的 manifest 与安装机制已查清 ——
静态装配 = pnpm link 依赖（`~/.dsh/plugins/<name>`）+ `dsh.profile.bundles`
列表 + 顶层 YAML 数组的 patch 层；插件包 = 普通 npm 包 + 少量 dsh 元数据
（`dsh.bundle.patch` / `dsh.client.inject` 等）。另发现第二条通道：
会话内**动态 cordis 插件**（`cordis_define`/`cordis_run`/审批/不可变
packageId）。详见 `CODING-HARNESS-DESIGN.md` §7.1 / §7.3。

### M-D+ — 四篇设计文档实现批次（2026-08-28）

| 文档 | 落地内容 | 代码位置 |
|---|---|---|
| CODING-HARNESS | 第一期 Hashline（18 测试）；第二期 journal（23 测试）；第三期 PTC 沙箱提取 + Code Mode SDK + 4 工具（Node 宿主）；第四期证据门核心闭环（8 测试） | `packages/coding-harness/`、`packages/core-agent/src/journal/`、`src/planning/` |
| SELF-AUTHORED-TOOLS | 第一期血缘（authority +3 源 / provenance / gate / approval，24 测试）；第三期 Skill 契约（21 测试）；第四期审阅界面（镜像接线，7 测试 + skills.vue + i18n） | `packages/core-agent/src/authority/`、`packages/skill-forge/`、`packages/stage-ui/src/stores/skills.ts` |
| ATTENTION | 缺陷 A 补齐：Discord 频道在场 → `context:update`（replace-self），关键词 → `spark:notify`（`DISCORD_ATTENTION_KEYWORDS` 环境变量） | `integrations/discord-bot/src/adapters/airi-adapter.ts` |
| MEMORY | §11.2 人工确认流程：新抽取默认 `pending`，晋升要求 `approved`，拒绝不召回；设置页"待确认"队列 | `packages/memory-core/`、`packages/memory-pgvector/`、`packages/stage-ui/src/stores/modules/memory.ts` |

**交叉加固**：并行会话对我交付件的兼容性增强均已合入并全绿 ——
`authority/gate.ts`（"至少一条可证变更"语义）、`journal/store.ts`
（structuredClone 防御）、`skill-forge/lifecycle.ts`（审阅/隔离输入校验）。

**测试面**：core-agent 155/155、memory-core 15/15、skill-forge 21/21、
coding-harness hashline 18/18（ptc/tools 的 fork 套件在升权壳下 26/26 验证过，
本机受限 shell 无法跑子进程测试）、stage-ui skills 7/7。

**当时的剩余接线期任务**：全部列入 `WIRING-BACKLOG.md`；其中 pnpm install 收录
新包、四工具 Electron IPC 宿主与注册、桌面审批卡和防双轨扩展已在 M-D+1 收尾。
MC 侧沙箱 import 切换仍明确等待真机验证。

### M-D+1 — 接线层与桌面 UI 收尾（2026-08-29）

本批次把 M-D 的纯逻辑地基接入 Electron 舞台和设置窗口：

- `coding-host` 通过 Eventa 挂载到 Electron 主进程，提供 workspace read/write、
  Hashline edit、分级 bash 和 Code Mode；高风险命令等待审批卡，超时拒绝。
- 聊天运行时将 user/assistant/tool/context/approval/review/task/reaction 写入 core
  journal；计划卡由 journal evidence gate 投影，模型的 `completed` 声明不能单独完成步骤。
- 每轮 system supplement 注入有界的 `buildTurnProjection`，包含当前步骤、最近证据和
  上一工具结果；Code Mode 面板显示每次 bridge trace。
- reviewed self-authored skill 才进入动态工具表。opencode 适配器在调用前执行版本探测，
  失配自动 quarantine；批准的触发模式同时进入 prompt 和 muscle memory。
- Attention 设置页提供 focused mode 开关；新增 `docs/ai/context/integration-channels.md`
  固化集成事件的泳道选择。
- Minecraft 设置页复用 `GamingModuleSettings`，将 enabled/host/port/username 通过
  `ui:configure` 发送给既有 `minecraft-bot` runtime；状态、context:update 和 spark 流量
  仍保持只读可观测边界。MC 沙箱尚未切换，等待真机验证。
- Memory 设置页增加受限 dreaming pass：idea 写入既有
  `memory_short_term_ideas` 表，独立于事实记忆，支持去重、审阅和 lifecycle 更新；
  `MemoryDreamAgent` 可由后续模型适配器注入。

验证：core-agent、coding-harness、memory-core、memory-pgvector、stage-ui 和
stage-pages 类型检查通过；核心计划/工具/记忆测试通过。permission-frozen Code Mode
worker 的测试启动故障已修为 worker 内部错误提取，不再为读取 workspace 依赖扩大白名单。

### M-M — 维护批次一（2026-08-29）

把 M-D+1 收尾后的接线断层与风险项清掉，全部记录见 `MAINTENANCE-PLAN.md`：

- **固化**：未提交的 M-D+/M-D+1/时序修复按逻辑分 12 个 commit 入库；
  `.gitignore` 补 `云吞kumo/`、`.pnpm-store/`、`.mimosa/`（模型资产 46MB×2
  不进 git）。设计文档的伪代码块从 ```ts 改标 ```text 让 moeru-lint 通过。
- **auto-updater fork 政策**：`resolveAutoUpdaterEnabled()` 默认关闭上游
  更新检查（feed 硬编码指向 moeru-ai/airi Releases，自动升级会覆盖魔改），
  `AIRI_ENABLE_UPSTREAM_UPDATES=1` 可临时开启。原来只对 steam 分发禁用。
- **记忆设置导航**：短期/长期记忆页顶部加 `memory-scope-nav` 切换（长期页
  此前只能手输 URL 到达）；长期页加 Callout 明示"长期持久化尚未接线"。
- **MC 配置投递状态**：表单字段本就是 localStorage-backed（修正"重启丢失"
  的误判），真缺口是 `ui:configure` 无回执。store 增加 `deliveryState`
  （idle/pending/sent），保存时服务离线记 pending，bot registry 上线时自动
  重发；删除与手动起服务指引矛盾的 setup 块。
- **四工具单一来源**：`coding-harness/tools/coding-tool-meta.ts` 导出
  `CODING_TOOL_META`（无副作用子模块，renderer 不拖 node:fs 进 bundle），
  xsAI 工具声明与 Code Mode bridge 标签共用一份描述。
- **plan_update 工具**：激活休眠的计划机器——此前 `plans.start` 生产零调用
  方，证据门/白名单/plan-card 全部空转。orchestrator 新增
  `getActivePlanStep` dep：tool/call+result 仅当工具在当前步骤白名单内才
  打 `planId`/`stepId` 标（无关工具结果无法满足验证门，结构优先于自律）；
  工具支持 start（自动 supersede 旧计划）/focus/cancel，永远无法宣称完成。
- **code_mode 工具**：把 PTC 沙箱暴露给模型（此前只有设置页人工入口）。
  模型写一段程序 `bridge()` 派发四工具，一次调用替代 N 次单工具调用；结果
  展平为有界文本（返回值+日志+每 bridge 一行 trace），超时钳位 1-60s；宿主
  listTools 单独报告 code_mode 可用性。

验证：core-agent 172/172、coding-harness hashline+tools 28/28、stage-ui
plans 1/1、tamagotchi built-in 3/3 + plan 5/5 + coding 2/2 + coding-host
policy 5/5；coding-harness/core-agent/stage-ui/stage-pages/stage-tamagotchi
typecheck 全过（stage-ui 消费 core-agent dist，改源码后需 `build:packages`）。
**真机冒烟通过（2026-08-29）**：构建版 electron.exe + 独立
`APP_USER_DATA_PATH` + CDP，连续三次冷启动 `llm-tools` 均注册
`plan_update` + 四工具（defaultActive）+ `code_mode`——时序修复真机确认，
且注册可用性门同时证明了 coding-host bridge 端到端可达。CDP 调研用
`D:\.airi-smoke\cdp-eval.cjs`（原生 eval，agent-browser 激活式切换在主窗
口忙时会挂）。

### M-M2 — 第二轮：乒乓根修 + 控制台 + pgvector（2026-08-29）

- **ENOTSUP 热循环根修（`14657e2a0`）**：冒烟发现渲染进程周期性冻结后，
  真凶不是主进程无退避，而是 channel-config watcher 的**回滚乒乓**——失败
  回滚恢复"上一次 flush 的值"（与已接受快照不同），回滚本身再次触发
  watcher，apply → fail → rollback → apply 永续循环（每秒 ~13 次失败绑
  定，6908 条日志/3 分钟，Eventa IPC 打满 → 所有渲染进程间歇冻结）。修复：
  watcher 以 `appliedConfig` 去重（启动同步已接受的配置不再触发 apply）+
  回滚恢复快照本身。回归测试 `server-channel.test.ts` 3/3。分析见
  `docs/solutions/runtime/server-channel-enotsup.md`，CDP 冒烟配方见
  `docs/solutions/debugging/electron-cdp-smoke.md`（该目录按 AGENTS.md
  体例新建）。
- **devtools coding 控制台（`140b32d19`）**：`devtools/coding-console` 页：
  计划验证门投影、手工 PlanSpec 测试台（无模型即可检验白名单/证据门）、
  journal 事件流过滤（tool/plan/approval）、coding host 状态芯片。
- **pgvector 主进程 memory-host（`6c8d623f6`）**：`memory-pgvector` 新增
  `ensureMemorySchema`（此前全仓库无 DDL——表从未被创建过；幂等建表 +
  hnsw 索引）与 `./repository` 子路径导出（根 index 顶层 `void main()`
  会启动 standalone client，主进程必须绕开）。主进程 `memory-host` 服务
  （coding-host 同款模式）持有 Postgres 连接；stage-ui 记忆 store 暴露
  `MemoryHostPort` 注入端口；`promoteEligible` 晋升后把片段连同 renderer
  端计算的 768 维 embedding 镜像进 Postgres（尽力而为，不阻塞本地层）；
  长期记忆设置页提供连接串配置/连接/断开/状态。已知边界：检索浏览器仍读
  本地库；真库走查待本机 Docker 起 `server/docker-compose.yaml` 的 db
  服务（`127.0.0.1:5435`）。

验证（第二轮）：core-agent 172/172、memory-core 15/15、skill-forge
23/23、memory-pgvector 2/2、tamagotchi 四套件 13/13；memory-pgvector/
stage-ui/stage-pages/stage-tamagotchi typecheck 全过。

### M-M3 — 记忆维护批次：life-mode 自动梦境整理（2026-09-04）

- `memory-core` 增加 dreaming 生命周期迁移校验和来源筛选：只有已批准的短期/长期
  事实可以进入 dreaming pass，muscle、pending、rejected 和旧模板不会成为输入。
- `stage-ui` 增加 `MemoryDreamAgent` 的自动调用边界：自动整理只在 leader 执行，
  独立维护最短间隔、每日预算、新增事实门槛和本地日计数；失败不会把想法升级成
  事实或计划。
- life-mode 心跳接线遵守“社交优先、私有维护次之”：响应模式或自主模式无 stimulus
  时才触发自动整理；忙碌、活跃 flow、focused 和社交 stimulus 会跳过。成功运行以
  `memory/dream` append-only 事件记录。
- 短期记忆设置页暴露自动开关、间隔、每日预算与新增记忆门槛；更新 en/zh-Hans 文案，
  明确“做梦”不会自动执行计划。

验证：memory-core dreaming 4/4；stage-ui memory + life-mode 16/16；
core-agent/stage-ui/stage-pages typecheck、i18n build、目标文件 eslint 通过。
真实 Electron/当前 provider 的自动触发验收仍待执行。

### M-M4 — 记忆可靠性、事实修订与评估（2026-09-05）

- **P3 可靠同步**：长期晋升先写本地持久 outbox；远端写入携带 `originId`，Postgres
  使用唯一索引幂等；断线按指数退避，支持重试和已有长期记忆批量入队。远端同步默认
  关闭，避免未确认的数据外流。
- **P4 事实修订**：memory fragment 增加 `factStatus`、`supersedesId`、`conflictGroup`；
  设置页可以提交修订/争议提案，提案默认 pending。批准 supersede 后才标记旧事实为
  superseded，disputed 事实不会进入检索或 dreaming 输入。
- **P5 中文评估**：`memory-core` 增加 cosine 排序、recall@K、precision@K、MRR 和
  stratum 指标；`MEMORY-EVALUATION.md` 提供中文 fixture 与浏览器本地 embedding 运行入口。
  指标不会自动改生产权重。
- **P6 隐私/性能/交付**：远端同步开关、outbox 状态与重试 UI；晋升镜像优先复用已有
  768 维向量，避免重复 embedding；新增 `memory-runtime-smoke.ts` 输出构建 SHA-256，
  可启动隔离 Electron userData 并检查 CDP。

验证：memory-core 类型检查与 dreaming/evaluation 6/6；memory-pgvector、stage-ui、
stage-pages 类型检查通过；stage-ui memory tests 9/9；stage-tamagotchi build 与
隔离 renderer/CDP smoke 已通过。真实 Postgres 断线长跑、中文模型分数和带 provider
自动梦境行为仍未宣称完成。

## MD-0 — 可识别构建与检查基线（2026-09-06）

MD-0 完成只读基线核查：冻结工作树 diff SHA-256
（`daf58b34f8c913c3aa39fba8ed323638ceda33faa7b0a1e34dd73b741256946d`）与两套独立构建标识。
dev `out/`（main `aae2201a…`、renderer `5740c700…`、preload `6d7c0232…`）与打包 EXE
（airi.exe `f8e36f72…`）时间戳不同，确认是不同产物，不可混用验收。root `pnpm typecheck`
与 `pnpm lint` 均退出码 0。关键附加发现：真实 Postgres 现可用（`proj-airi-backend-db-1`
Up 3 hours healthy，`127.0.0.1:5435` OPEN），memory-pgvector 4 条集成测试真实通过
（805ms），解除 DR-3/MQ-0/MD-2 的数据库硬阻塞。证据见 [MD-0 基线记录](./evidence/md-0/md-0-baseline-record.md)。
MD-0 本身仅完成基线核查，不构成 MD-1/MD-2 或任何功能批次的完成。未创建提交。



- `pnpm-workspace.yaml`：移除 `minimumReleaseAge`（npmmirror 元数据缺发布时间，
  误报供应链违规）；`stockfish` 钉到 `17.1.0`（镜像没有 18.x）。
- 本机用 pnpm 11.24.0（npm -g 安装）+ node v24.14.0；安装走 npmmirror +
  `ELECTRON_MIRROR`/`ELECTRON_BUILDER_BINARIES_MIRROR`，下载失败时挂
  `127.0.0.1:7890` 代理。

## 桌面版构建配方（本机实测）

electron-builder 这版不认 `ELECTRON_MIRROR`，直连 GitHub 下 Electron zip 会被
TLS 重置。绕行：手动从 npmmirror 拉 Electron 并用 `electronDist` 指过去：

```powershell
# 一次性：下载并解压 Electron 到仓库外缓存
curl -L -o D:\.airi-build-cache\electron-v43.4.1-win32-x64.zip https://npmmirror.com/mirrors/electron/43.4.1/electron-v43.4.1-win32-x64.zip
# 解压到 D:\.airi-build-cache\electron-43.4.1-win32-x64\

cd D:\airi\apps\stage-tamagotchi
# 注意：electron-builder 的代理层只认小写 https_proxy（大写会被忽略，
# nsis-resources 等附加包会直连 GitHub 被 TLS 重置）
$env:https_proxy='http://127.0.0.1:7890'
$env:http_proxy='http://127.0.0.1:7890'
# 免安装版：
npx electron-builder --dir --config.electronDist='D:\.airi-build-cache\electron-43.4.1-win32-x64'
# NSIS 安装包（绝不带 --publish）：
npx electron-builder --win nsis --publish never --config.electronDist='D:\.airi-build-cache\electron-43.4.1-win32-x64'
```

- godot 引擎产物（`engines/stage-tamagotchi-godot/out/win`）缺失只是警告，
  extraResources 跳过，不影响构建（我们不用 godot stage）。
- 产物：`apps/stage-tamagotchi/dist/win-unpacked/airi.exe`（免安装）与
  `dist/AIRI-<version>-windows-x64-setup.exe`。

### 运行时注意事项（第二轮补充）

- **双 userData 目录**：源码构建（electron.exe 直跑）用
  `%APPDATA%\@proj-airi\stage-tamagotchi`，官方安装版用
  `%APPDATA%\ai.moeru.airi`——第一印象"数据全丢"其实是换目录。已用
  robocopy /MIR 把旧版 832MB 迁入源码构建目录；旧目录保留未动。
- **主进程新 workspace 包白名单**：electron.vite.config.ts 的
  `externalizeDeps.exclude` + `resolve.alias` 是主进程消费 TS-only
  workspace 包的硬前提（Node ESM 读到无扩展名源码导入就炸）。
  memory-host 链（memory-pgvector/repository → memory-core）曾漏配，
  症状是启动即 `ERR_MODULE_NOT_FOUND`、进程停在 3 个不进渲染。
  新增主进程依赖的 workspace 包时两处都要加。
- **vue-i18n 消息里的 `@`**：locale 值含 URL/邮箱时 `@` 是 linked-message
  前缀，tokenizer 直接抛错并令整页空白（`{'@'}` 转义）。
  见 `docs/solutions/debugging/vue-i18n-special-chars.md`。

## 运行时注意事项（首跑实测）

- channel-server 绑定 `127.0.0.1:6121` 报 `ENOTSUP`（疑似 TUN/代理网卡干扰
  LSP），非致命，窗口与 MCP 管理器均正常启动；若 widgets 通道异常先查这里。
- **auto-updater 指向 moeru-ai 上游 Releases**：魔改版若被自动升级会覆盖本地
  修改。已于 M-M 批次默认关闭上游更新检查（`AIRI_ENABLE_UPSTREAM_UPDATES=1`
  可临时开启）；如需恢复自动更新，先把 feed 指向 fork 自己的 Releases。
- NSIS 卸载配置 `deleteAppDataOnUninstall: true`：卸载会连
  `%APPDATA%\ai.moeru.airi`（含旧角色数据）一起删，卸载前先备份。

## 验证状态

- vitest：core-agent 21/21、stage-ui 49/49、tamagotchi renderer 3/3 全过
  （含新增：sanitizer/normalizer、原生注册与回退、resolver 抑制、降级 toast
  与恢复、失败流工具轮回放）。
- `vue-tsc`/`tsc` typecheck 全过。
- 手动 E2E：用 student-hub MCP（只读工具 `get_dashboard`/`integrity_check`）
  验证原生工具直调；**不要**用 `scan_school_updates` 做测试（安全边界）。

## 注意事项

- 测试中 Mimosa 钩子对 `tool-resolver.test.ts` 里既有的假 `apiKey` 字面量误报
  过"硬编码凭据"，对动态 DDL 误报过 SQL 注入；绕行方式见提交记录。
- 后续计划：M3（后台长任务 babysitting）、M4（Codex 式长期记忆）未开始。
  两份已审定的前端设计计划已落档：`LIFE-PLAN.md`（Neuro 式自主节拍——考量回合 + 生命模式矩阵 + mirror 工具 + 外观 journal 化）
  与 `CAPABILITY-PLAN.md`（能力扩展——fetch/SSRF、审批模式三档、dsh 插件兼容通道、自造工具闭环 skill_submit/沙箱自测/审阅通知）。
  注意 M3（babysitter）在 LIFE-PLAN 里与自主节拍 tick 合流，不再独立。
  另：`COMMAND-PLAN.md`（/plan 与 /goal 指令面板 · @文件引用 · 计划持久化
  复用休眠的 memory_long_term_goals 表——基座已实现；2026-08-31 增补真机
  诊断与 Phase A–E 执行计划：证据三档归位 / user_ask / 回合内续跑 /
  会话边界 / babysitter 对内面）。

## COMMAND-PLAN 落地（2026-08-31）：Phase A–E

- 提交：7b5658fac（基座：触发面板泛化、@引用展开、/plan /goal 拦截、
  horizon、DuckDB 持久化）；eef7b4d23（Phase A：证据三档 + 审批桥）；
  b4faf6ff8（Phase B/C/D：user_ask、回合内续跑、会话边界）。
- Phase A 解开真机死局：focus 审批步骤阻塞式发审批卡（决策经 coding-host
  重广播进各窗口 journal，planId 贯通），`complete` 动作未验证完成（卡片
  黄档），start 拒绝 human_approval×非审批幽灵组合，projection/prompt 明示
  "聊天文本不是批准"；gate 语义精化：零工具签核步骤批准即完成，带工具
  步骤仍需变异证明。
- Phase B：`user_ask` 工具 + `runtime-user-ask` 同步 store 问题卡（跨窗口
  渲染、answer 路由回 leader、关闭即"无答案继续"降级），journal 记
  user/asked + user/answered。
- Phase C：回合内续跑——回合结束仍有可执行计划步骤时自动续跑（每条用户
  消息上限 2 轮，用户发送重置，审批/受阻步骤不调度）。
- Phase D：session 计划绑定创建会话（DuckDB `session_id` 列 + 卡片/投影
  按当前会话过滤），long goal 全局滚动不变。
- Phase E：确认另一路已实现 life tick → long goal 工具轮 + blocker 上报 +
  stall 检测，无需增补。
- 测试：core-agent 179、stage-ui 837、tamagotchi tools 66 全绿；typecheck
  三包干净；真机 sanity：user_ask/plan_update 注册、/plan 面板列命令、
  计划与 user_ask store 就位、新会话无残留。
- 教训重申：core-agent（exports→dist）修改后必须 `pnpm -F @proj-airi/core-agent
  build` 再跑 tamagotchi 跨包测试，否则测的是旧产物。
- 教训新增：CDP eval 注入非 ASCII 表达式时，`eval(atob(b64))` 会把 UTF-8
  字节按 Latin-1 解析成乱码（信息可逆，模型能自行还原但不可靠）。正确姿势：
  `eval(new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0))))`，
  助手脚本 `.zcode/tmp/cdp-eval-utf8.sh`。
  另：`MIRROR-PLAN.md`（让模型真正"看到"自己——vision 读图 + livespace；真机确诊 mirror 生成像素但图不进对话输入）。

## 第三轮实施（2026-08-29）：CAPABILITY-PLAN + LIFE-PLAN 落地

- **fetch 工具**：`packages/stage-ui/src/tools/fetch.ts` + `fetch-ssrf.ts`（纯函数
  SSRF 守卫：http(s) 白名单、内网/环回/IP 整数与十六进制形式、DNS 解析变体在
  主进程 `web-fetch` 服务里）。桌面端经 `installFetchTextPort` 走主进程
  `eventa:invoke:electron:web-fetch:fetch`——node:dns 解析 + 手动重定向逐跳复检；
  web 端回落浏览器启发式（初始 URL 守卫）。大小上限 512KB 原始 / 8K 字符默认，
  抓取内容一律 `<untrusted_content>` 标注来源。tool-resolver 无条件挂载
  fetch，配套 `FETCH_TOOLSET_PROMPT`（chat store 预实例化 module store）。
- **bash 审批三档**：`require`（中危+高危都卡）/ `substitute`（仅高危，原默认）/
  `full`（全部放行）。主进程 coding-host 的 `codingHostSetApprovalMode` 切策略
  （coding-tools 的 `mediumBashApprovalRequired` 支持函数形式按次求值）；
  renderer 侧 `useCodingToolsStore.approvalMode`（localStorage 持久化 +
  refreshStatus 时回推主进程）。UI：设置 → 编码 → Bash 审批三键 +
  InteractiveArea 输入区盾牌循环按钮（默认 substitute 高亮不变色）。
- **自造工具闭环三齿**：
  1. `skill_submit`（tamagotchi builtin）：`analyzeSkillSource`（skill-forge 新增
     确定性静态分析，findings 首次由规则而非模型自报）+ `validateDeclaration`
     诚实声明门；落盘 `workspace/skills/<id>/{source.mjs,selftest.mjs,meta.json}`；
     自测失败不提交、声明确认与源码矛盾直接拒；风险分层后进 probation。
  2. 沙箱自测：selftest 程序经 code-mode 沙箱（`codingHostCodeRun`）实跑，
     失败返回 trace 日志给模型重写。
  3. 审阅通知：`stores/reviews.ts` 普通单例（非 pinia，卡片渲染不依赖活跃
     pinia）+ skills store 在 review 事件点 `ingestReviewEvent` 喂数据；
     聊天时间线新增 `ReviewCard`（镜像 approval-card，蓝系）。
- **LIFE M1 mirror**：`stage-ui-live2d/src/tools/mirror-tools.ts`——激活表情 +
    持有的装扮参数（group 显示名）+ 心情（mood 走端口注入，live2d 包不依赖
    stage-ui），返回自然语言快照 + 精确 JSON；注册进 built-in（appearance 组）。
- **LIFE M2 外观 journal 化**：core-agent `JOURNAL_EVENT_TYPES` 新增
  `appearance/changed`（含 `life/tick`）；custom-parameters / expression-store
  的变更写点在 `installAppearanceJournalPort`/`installExpressionJournalPort`
  注入后向 journal 追加——LLM 工具与设置面板都叙事化。
- **LIFE M3 考量回合 + 生命模式**：
  - core-agent：`ChatSendSource = 'text' | 'voice' | 'self-initiative'`、
    `ChatOrchestratorSendOptions.source`、correlation 钩子联合类型同步、
    `getSelfInitiativePrompt` 系统补注钩子（仅自主轮注入 `## Self-Initiative` 节）。
  - stage-ui：`ChatSendPayload.source`；自主轮只挂 self_speak/self_note 两工具；
    `## Self-Initiative` 节含集中模式合成（focused 只报工作不社交）；
    `tools/life/self-tools.ts`；chat store 在回合完成后按工具调用审计
    `life/tick`（spoke/noted/considered-silent——沉默也入册）。
  - 生命周期：主进程 `life-mode` 服务（`<userData>/life-mode.json` 持久化，
    同 memory-host 模式）+ 纯函数门控 `evaluateLifeTickGate`
    （mode→静默时段→每日预算→冷却，逐项可测）→ `lifeTick` 事件 → leader
    renderer `useLifeModeStore`（busy 互斥门 + 刺激物构建：真实 journal 事实）→
    `chatStore.send({ source: 'self-initiative' })`。
  - 三档：off（=现状）/ respond（照常入册不开口）/ autonomous（考察回合启用）；
    设置页 `settings/modules/life-mode.vue` + modules 列表入口 + i18n。
  - 注册联动：built-in tools store watch 生命模式，≠off 才注册 self 工具。

### 验收记录（第三轮）

- typecheck 全过：stage-ui / stage-tamagotchi / stage-ui-live2d / core-agent /
  coding-harness / skill-forge / i18n。
- lint 全过（changed 文件 52 个，eslint --fix + 手工修 7 处残留）。
- vitest 定向回归全绿：fetch 13、mirror 5、skill-forge 静态分析 14、
  orchestrator 31（含自主轮注入/普通轮跳过）、coding-tools 11、skills 11、
  history browser 11、journal 3、life-mode brief 3、skill-submit 8、
  life-mode gates 9、built-in 3。
- tamagotchi 生产构建：electron-vite 主进程/preload/renderer 输出 + typecheck
  全绿（web-fetch 与 life-mode 主服务打包路径验证）。
- **遗留/后置（2026-08-30 更新）**：dsh 内容插件适配器**已放弃**（拍板：dsh 插件
  与 AIRI 架构不同源，兼容面收敛为自有技能格式）；@文件引用（skill 上拉栏已于
  当日完成）；**babysitter/长程 goal 后台推进未实现**——计划只能在她人在场时
  沿对话推进（`getActivePlanStep` 喂当前步），心跳考量回合只挂 self_speak/
  self_note、不能执行计划工具，"同一 tick 两面"的对内面缺失；M4 阶梯（L0 观测
  →L1 闯入记忆分享→L2 作息在场→L3 世界泡，babysitter 是其合流点）；生命周期
  预算/冷却的 UI 提示位；skills 队列持久化仍为内存态（产物已落盘，队列状态跨
  重启靠重提）。

## 第三轮验收（含 agent-browser 真机走查，2026-08-30）

真机环境：build 后的 electron + CDP 9250 + agent-browser（raw CDP eval 直连
leader 渲染进程）。API key 解禁、余额充足。**真机走查逼出 7 个仅靠单测发现不了的 bug**：

1. **主进程打包 fetch 工具外部化**：electron.vite externalizeDeps.exclude
   只匹配整包名，`@proj-airi/stage-ui/tools/fetch` 子路径条目不生效 → 启动即
   `ERR_MODULE_NOT_FOUND`。改为整包 `@proj-airi/stage-ui`（配合 alias 只真正
   打包两个工具文件）。
2. **渲染进程整体挂载失败**：renderer main.ts 在 `app.use(pinia)` 前调用
   `installCodingHostBridge`，而 `installLifeModePort` 立即 `useLifeModeStore()`
   → 抛异常，`#app` 空、白屏。修法：life-mode port 安装改为微任务延迟 sync，
   onTick 惰性解析 store。
3. **主进程 main→renderer 推送盲区**：eventa `createContext(ipcMain)` 无 sender
   时 emit 不投递任何窗口 → 审批卡/生命 tick 永远到不了渲染层。新增
   `eventa-window-broadcast`：每个 BrowserWindow 绑一个 window context，emit
   时广播到所有窗口；invoke handler 仍留在 plain context。
4. **ui 包 Collapsible prop 名错**：是 `default`/`label`，不是 `default-open`；
   且 content slot 在 Transition 内需**单根**。审批卡/审阅卡此前完全折叠且只
   渲染首个子节点。
5. **i18n 键路径缺 `stage.` 前缀 + dist 未重建**：卡组件用 `chat.*` 而非
   `stage.chat.*`；且 renderer 消费 i18n 的 `dist`（boot 文档已有此教训）。
6. **workspace writeFile 不建父目录**：skill_submit 落盘 `skills/<id>/` 时
   realpath 对不存在的中间目录抛 ENOENT → 她被迫发起 mkdir 审批。修法：
   writeFile 先递归建父链；且 skill 执行器改用 `readRaw`（read 返回带行号
   签名的投影，不是纯源码，导致 `export default` 剥离后残留字符串语法错）。
7. **生命模式 setConfig 传 reactive 代理**：`setConfigPatch` 把 vue proxy 直接
   送 eventa invoke，`structuredClone` 失败 → disk 永不更新、main 一直按 off
   运行。修法：port 边界 `toPlainConfig` 深拷贝。

真机验证通过的验收项：
- **fetch**：抓 example.com 正常并标注来源；`http://127.0.0.1:9250` 与
  `http://localhost:6221` 均被 SSRF 守卫拒绝；她尝试用 bash curl 绕过被高危
  闸门拦下（`bash denied`）。
- **web_search**：Tavily 实搜出结果并引用链接。
- **审批三档**：设置页三档切换 + 输入区盾牌循环按钮实时改 aria + localStorage
  持久化 + 跨窗口同步；`require` 下中危 bash 触发审批卡（琥珀系，中文标题/
  按钮，含命令 subject、risk badge），点批准 → 目录真实创建，超时 → denied。
- **skill_submit 完整闭环**：她提交 reverse_text/flip_text → 落盘
  `workspace/skills/<id>/{source.mjs,meta.json,selftest.mjs}`（staticAnalysis 全
  clean、contentHash 绑定）→ 沙箱自测通过 → 聊天审阅卡（天空系）→ 审阅并启用
  → trust=reviewed → 真机执行 `flip_text({text:"self-authored loop complete"})`
  返回 `"etelpmoc pool derohtua-fles"`（成功反转）。剩余缺口：技能队列为内存态，
  跨重启需重提（已列后置）；激活机制支持关键词/默认可用（defaultActive 已改
  true 使审阅即用）。
- **mirror**：返回她的真实外观快照（云吞模型、现行发型档位 `HairBList=2`、
  心情 neutral/calm + 精确 JSON）。
- **M2 外观 journal**：`setValue` 改 `HairBList` 后 journal 追加
  `appearance/changed {source:parameter, target:HairBList, value:2}`。
- **生命模式**：`respond` 模式每 1 分钟心跳，renderer 记
  `life/tick {outcome:gated, gate:respond}`（入册不开口、零 token），符合不变量 #2；
  `autonomous` + 静默时段 0-23 下主进程 economic 门在 emit 前拦截，无新 tick。

额外发现并确认：LLM provider 在真机下偶发 `Failed to fetch`（网络抖动），文本回
踢 + 错误条机制正常（此前修复的失败发送提示在真机复现并兜底）。

## 第四轮：mirror 增强为"真·照镜子"（图进对话）

需求确认：用户面前就是实时 Live2D 皮套，不需要工具看图；真实需求是**让对话
模型真正看到当前外观**（B 路径）。经调查确认关键架构事实：

- **mirror 工具与 Live2D 画布在同一渲染进程**（main 窗口 `synced-leader:true`、
  `stage-runtime:full`），不存在跨窗口取帧问题。
- 对话多模态通道已存在：`ChatSendPayload.attachments` → orchestrator 组
  `image_url` content part → `sanitizeMessages` 对支持 content array 的 provider
  保留（视觉模型看到，非视觉模型降级丢图留文本）。
- **工具结果不会自动变下一轮多模态输入**——需在 chat store 加"工具图→attachments"
  注入。

实现（两案并行，均走端口注入、不破坏 `stage-ui-live2d` → `stage-ui` 边界）：

1. **Stage capture 端口**（`stores/stage-capture.ts`）：Stage.vue onMounted 注册
   `captureFrame`，onUnmounted 注销；mirror 工具经端口取帧（与
   `installLifeModePort`/`installFetchTextPort` 同模式）。
2. **mirror 工具增强**：取帧后返回 **content 数组** `[{type:text},{type:image_url}]`
   （方案 A 尽力而为，视觉 provider 透传）；同时把帧存为 backgroundStore
   `selfie` 条目（`BackgroundEntry.type` 本就预留了 `'selfie'`）。
3. **方案 B 列队注入**：`mirror-snapshot.ts` 存 `lastMirrorAttachment` 暂存；
   chat store `onChatTurnComplete` 检测本轮调 mirror → `takeLastMirrorAttachment`
   入 `pendingSelfieAttachments` → 下轮 `executeSend` 合并进 `attachments`。
4. **方案 A**：镜拍后返回数组 content，当前 tool loop 内视觉模型尽力而为看到图，
   可靠兜底交给方案 B。非视觉模型由 `sanitizeMessages` 自动降级（留 `text` part）。

验收：
- typecheck 全过（stage-ui / stage-ui-live2d / stage-tamagotchi）；build 全过。
- mirror-tools.test.ts 新增 2 例：有帧返回 content 数组（含 image_url）、无帧
  返回纯文本 → 7/7 全绿。
- stage-ui 回归 34/34（tool-resolver / history.browser / fetch）、lint 干净（eslint
  在 Git Bash 下偶发 segfault，非代码问题，复跑确认 clean）。
- 遗留：方案 A 的"tool result 内 image_url 是否被视觉 provider 当真"取决于 provider
  实现，AIRI 侧无法保证——因此以方案 B（下轮 attachments）作为可靠兜底。

后续可做：把 mirror 自拍作为共享媒体暴露给模型主动引用（backgroundStore
`selfie` 条目已可被 image_journal apply 检索），以及 M4 阶梯里"镜子"进阶。

## 第四轮梳理（2026-08-30）：记忆层 / life-mode / 上拉栏 状态核查

- 修复：
  1. life-mode i18n：`life-mode.vue` 模式键误写为 `life-mode.modes.${mode}`，
     locale 实际在 `sections.mode.*`（en/zh-Hans 源本就齐全）→ 改为
     `sections.mode.${mode}`。症状即"标题描述正常、三个模式名显示原始键"。
  2. i18n dist 未重建：上一轮 mirror-visual 键只改了 src，dist 里没有 →
     `pnpm -F @proj-airi/i18n build` 重建（教训重申：渲染层吃 dist）。
  3. OPFS 单写者结构性加固：`useDuckDb.getDb` 自己检查 `resolveMemoryWriteAccess`，
     follower 直接抛错——守卫不再只靠 memory store 自觉；`Stage.vue` 移除
     `await getDb() // stub for future update`（每挂一个 Stage 就无条件开一次库，
     白白扩大锁冲突窗口）。
  4. `memory-long-term.vue` 类型错误：Callout theme 传 `'red'` 不存在 →
     `packages/ui` Callout 补 `red` 变体 + ui-components 文档同步。
- 诊断结论：
  - `createSyncAccessHandle` = OPFS 同文件第二个同步句柄冲突。当前代码只有
    主窗口（leader）会开库（WidgetStage 仅 index.vue 挂载，chat 窗口不挂
    Stage；其余窗口全被守卫拦住），嫌疑指向**另一个同源渲染进程持有文件**：
    双开应用实例 / 僵尸进程（dev 模式 HMR 重求值 use-duck-db 也会留旧 worker
    句柄）。复现时的处置：杀干净全部实例再点初始化。
  - 短期与长期记忆在存储层零关系：短期=DuckDB-WASM OPFS（渲染进程本地），
    长期=Postgres/pgvector（主进程 eventa 桥，需 docker pgvector 栈在跑）。
    唯一连接点是 `promoteEligible` 晋升后镜像进长期库。
  - 梦境整理"没作用"= 同一失败链：`dream()` 需 master `enabled` +
    `dreamingEnabled` + DB 初始化成功；DB 失败时静默返回 `[]`，且失败无
    toast（错误只显示在压缩区状态行）。
  - 短期抽提为零 = `captureEnabled` 默认 false + `captureTurn` 同样先过
    DB 初始化 + extractor 的 provider/model 缺省回落当前聊天 provider。
- 核对设计文档未完成项（确认重申）：CAPABILITY-PLAN 的 @文件引用与 skill
  上拉栏 UI（当时即标"后置"）、dsh 适配器（需样本插件解剖）；LIFE-PLAN 的
  M4 阶梯（L0-L3）与预算/冷却 UI 提示位；skills 队列内存态持久化缺口；
  毕业考（真实小工具全流程）未跑。
- 验证：stage-ui / stage-pages / ui typecheck 全过；eslint changed 文件干净；
  i18n dist 重建后 en/zh-Hans 均含 mirror-visual。

### 真机验收（2026-08-30）：记忆链修复复验 + 途中五连修

环境：杀干净残留实例（1 主 + 8 子 electron，即 OPFS 句柄持有者）→ build +
`electron-vite preview` + CDP 9250 raw eval 直连 leader 渲染进程。

复验途中发现并修复（每项先复现后修）：
1. **NaN 拼进 SQL**（抽提为零真凶之一）：`local-memory.ts insert()` 把
   `Math.max(-1, Math.min(1, input.valence))` 原样拼进 INSERT，抽取缺心情
   字段时 DuckDB 报 `Referenced column "NaN" not found`。修：`numberValue()`
   边界归一化（importance 缺省 5、valence/arousal 缺省 0），SQL 与返回值
   共用归一化结果。
2. **抽取 prompt 缺 schema**（抽提为零主因）：`extractMemoryTurn` 的 system
   prompt 没要求模型返回 importance/valence/arousal/tags，而过滤器硬性要求
   它们是 number → 模型输出全被静默过滤。修：prompt 补全字段 schema；过滤
   放宽为结构校验，数值与 tags 在 map 时归一化兜底。
3. **tags 不可迭代**：`insert()` 的 `for (const tag of input.tags)` 对缺
   tags 输入在主行已入库后抛错——调用方收到错误但碎片实际已持久化。修：
   `input.tags ?? []`。
4. **use-duck-db 守卫误伤**：单写者守卫初版在 Node/测试上下文（无 location）
   误判 follower。修：仅浏览器上下文强制；新增 follower 拒绝测试
   （vi.stubGlobal location）。
5. **llm.test.ts 陈旧 mock**：fetch 上线时没把 `createFetchTools` 加进 tools
   barrel 的 vi.mock → 全量 6 失败（第三轮只跑了定向测试的欠账）。修：mock
   补导出。

真机复验结果：
- `initialize()` → `databaseStatus: 'ready'`，createSyncAccessHandle 消失。
- 缺 mood/tags 的抽取完整入库、返回正确、待审阅区可见；`dream()` 产出
  ideas 且去重正常。
- life-mode 页三模式渲染"关闭/只回应/自主"；意识页 mirror-visual 正常。
- 长期记忆：docker daemon 未运行 → 启动 Docker Desktop → 启动
  `proj-airi-backend-db-1`（vchord-postgres pg18，127.0.0.1:5435）→
  `configureRemoteHost` 后 status 'ready'。两个注意点：容器 restart 策略
  原为 no（已改 `unless-stopped`，与 memory-host 注释对齐）；主进程缓存的
  连接失败要靠 configure 触发重连，getStatus 不做活探测。
- stage-ui 全量 818/818 绿；typecheck / lint 干净。

### Codex 风 skill 上拉栏（2026-08-30）

- 构成：`use-skill-shelf` composable（状态机：尾随 `/token` 开栏 → 输入过滤
  → 选择回填规范化名）+ `SkillShelf.vue`（展示面板：名/描述/提示条/空态）+
  `InteractiveArea` 接线（`submit-on-enter=false` 下 Enter 由面板优先消费）。
  store 侧 `activatedEntries` 增加 name/toolId 匹配——插入 `/name` 必然激活；
  新增 `reviewedSkills` 投影；i18n `stage.skill-shelf.*`（en/zh-Hans + dist）。
- 设计要点：上拉栏只做"选择 → 插入"这层 UX，激活与注入完全复用既有
  `prepareForPrompt`（发送时按名称/关键词命中 → toolset prompt 注入）。
  `ShelfKeyEvent` 结构化接口让 composable 保持 DOM-free，node 测试项目可直接
  跑（KeyboardEvent 在 node 项目不存在，浏览器模式才可用）。
- 测试：use-skill-shelf 7 例；skills store 12 例（含 name-token 激活与
  reviewedSkills 投影）。
- 真机验收：chat 窗口输入 `/open` → 面板渲染 opencode_delegate（名 + 描述 +
  中文提示），Enter 消费并回填 `/opencode_delegate `、面板关闭；截图确认暗色
  主题风格一致。坑：skills-review 是 synced store，follower（chat 窗口）本地
  变更会被 leader 快照覆盖——造 reviewed 数据必须在主窗口（leader）做。

## 接手前勘探（2026-08-31）：能力层缺口与原则七修订

新接手方通读全仓后的对照勘探。**只改文档，未动代码**：产出
`HARNESS-PLAN.md` §0.3 / §3.5（批次一·五）/ §9.1 / §9.2，以及
`DESIGN-PRINCIPLES.md` 原则七的修订块。

- **动机**：`HARNESS-PLAN` 原四批次修的是**控制层**（能叫停、能插话、回合有
  边界、不违抗用户）。与 opencode 类 harness 的日常循环对照后确认：**能力层
  （在仓库里干活）同样缺，且缺口更硬**——批次二三四优化的是一个还没法可靠
  定位和改文件的循环。故新增批次一·五插在批次一与二之间。
- **原则七修订**：「4 工具」作废。flash 级模型上"多几个工具 vs 4 个"无区别，
  真正压垮单人项目的是决策面不是条目数。新判据：**工具面只按「是否改变工作
  循环的形状」扩张**（`grep` 改变形状；第 12 个同形状只读工具不改变）。
  方向未变——仍拒绝"因为参照物有所以我们也要有"。
- **七项能力层缺口（C1-C7，全部对到代码）**：无检索原语（grep/glob 全仓零
  匹配，只有单层 `list`）；`read` 无分页（整文件每行带签名，3000 行文件即满
  窗）；`edit` 只能整行替换（插入做不到）；`write` 零校验（可覆盖未读过的
  改动）；win32 上 bash 实为 cmd.exe 而工具描述未声明；CRLF 签名往返破坏行尾；
  工作区根目录写死 `~/AIRI-workspace` 且 eventa 无 setter。
- **最尖锐的一处（C3+C4）**：Hashline 保护了模型会绕开的那条路（`edit` 门槛
  高），模型必走的那条路没有门（`write` 门槛零）。理性模型一路 `write` →
  内容签名机械在最常见场景里完全不生效。按原则一这是**门的位置错了**，不是
  能力缺口；修法是让两条路门槛匹配（`edit` 范围化 + `write` 加 `baseHash`
  陈旧校验），而非劝模型多用 `edit`（那正是被原则一判为错的自律式解法）。
- **C6 实测（非推断）**：`"const a = 1\r\nconst b = 2\r\n"` 经 `split('\n')`
  后首行为 `"const a = 1\r"`，带 CR 签名 `m4`、去 CR 为 `fh`；替换首行再
  `join('\n')` 得 `"const a = 42\nconst b = 2\r\n"`——行尾已混合。本仓库工作
  树即 CRLF（git 持续报 `LF will be replaced by CRLF`），**让她改 AIRI 自己
  的代码就会踩到**。
- **范围外但确认存在（§9.1，需用户单独拍板）**：① journal 仍是内存态——
  `journalToJSONL` 零调用方、store 为 `synced:{state:false}`，§4.4 承诺的
  fork/resume/回放是设计意图不是运行事实；本计划 R4 只把持久化失败上浮成
  芯片，**没治日志本身不落盘**，真正的 resume 不在任何批次里。② 无委派原语
  （btw 是反向通道，不是 subagent）。③ 无 diff 面（`write` 只回 `wrote path`）。
- **预期差异（§9.2，非缺陷）**：批次二后证据门（裁决）与 todo（沟通）并存，
  比 opencode 多一层状态。职责分离的论证成立（沟通职责压给证据门正是 R3 的
  死因），但对 flash 级模型是净收益还是摩擦需真机观察——§7 已留观察项。
- **新增验收**：T8（grep 定位→分页读→edit，`git diff` 无行尾噪声）、T9（3000
  行文件不进满上下文且跨页签名命中）、T10（陈旧覆盖被挡且未落盘，列为常驻
  回归）、T11（win32 下能自行改用正确命令形态）。
- **新增红线**：新依赖必须由用户选择（grep 的 ripgrep 来源、win32 shell 二选
  一，均列表待拍板）；改 `classifyBashCommand` 分级正则属安全变更（漏一条即
  高危降级直跑）；`read` 分页后签名宽度仍按**文件总行数**计算（否则跨页失配，
  是本批唯一容易静默写错处）。

### 批次一·五决策落定与前四项落地（2026-08-31 晚）

**两处依赖决策已由用户拍板**（`AGENTS.md`「新依赖必须由用户选择」流程走完，
对照表见对话记录，结论写进 `HARNESS-PLAN.md` §3.5.3 第 1 / 第 5 条）：

- **C1 检索后端 = `@vscode/ripgrep`**（自带平台二进制）。判据是「任何用户机器上
  行为一致」：只探测系统 `rg` 会让行为随机器变（本机实测 `rg` 不在 PATH，
  即一直走慢回落），而"行为随环境不确定"正是原则一要消除的；纯 Node 遍历在
  AIRI 这种体量的仓库上慢到影响循环。实施注意：`rgPath` 从包导出取不要硬编码；
  `electron-builder.config.ts` 的 `asarUnpack` 要覆盖该二进制（现有只有 `**/*.node`），
  否则打包后 spawn 直接 ENOENT；postinstall 代理只认小写 `https_proxy`；
  保留 Node 遍历兜底但**降级必须可见**（M2 教训）。
- **C5 shell = 探测 Git-Bash → 缺失回落 PowerShell → 两条路都动态声明当前 shell**。
  选 Git-Bash 作首选的判据是**安全面不是便利**：`classifyBashCommand` 的分级正则
  全是 POSIX 形态，Git-Bash 让它继续有效；换 PowerShell 等于重写整张分级表，
  漏一条就是高危命令降级为 read-only 直跑、不弹审批卡。回落那条路仍须补正则，
  且 PowerShell **别名**（`ri`/`iwr`/`sc`）是最容易漏的一类。

**七项里四项已落地**（工作树未提交，定向测试 36/36 绿：`hashline/*` + `coding-tools`）：

- **C2 `read` 分页**：`{ offset, limit }` + `DEFAULT_READ_LINE_LIMIT = 400`；
  签名宽度仍按**文件总行数**算（切片前的 `lines.length`），跨页签名一致。
- **C3 `edit` 范围化**：`endSignature?` + `operation: replace | insertAfter` +
  `afterSignature`。`insertAfter` 是独立语义而非"替换成两行"——后者会迫使模型
  复述它不打算改的那一行，正是 Hashline 要消除的东西。
- **C4 `write` 陈旧校验**：`writeFileIfUnchanged(path, content, baseHash)` →
  `written | state_changed{currentHash}`；`baseHash: null` 显式声明"预期不存在"，
  文件已存在时该声明本身即失配（顺带堵掉"以为在建新文件其实覆盖了旧文件"）。
  哈希用 `contentHash`（FNV-1a → 8 位十六进制），威胁模型是疏漏不是伪造。
- **C6 CRLF 保真**：新增 `hashline/text.ts`——`parseTextFile` 按 `/\r?\n/` 切行
  （**签名不含行尾符**）、探测主导行尾、报 `mixedLineEndings`；`joinTextFile` 按
  探测到的行尾写回。修掉勘探期实测的行尾混合问题。

**剩余三项建议顺序**：C5（她当前在 win32 上几乎发不出可用命令，且 C1 的
"不要用 bash grep"正是为了不继承这个问题）→ C1（依赖打包配置）→ C7（切根，纯增量）。
状态表见 `HARNESS-PLAN.md` §3.5.0。

### 批次一 + 批次一·五落地收官（2026-09-01）

两批全部实现并提交，定向测试与 typecheck 全绿。状态表见 `HARNESS-PLAN.md`
§3.0 与 §3.5.0（那两张表是进度真相，本节只记结论与教训）。

**批次一（回合语义）——四个提交里的两个**：`feat(coding-harness): page reads…`
收编了工作树里 C2/C3/C4/C6 的在途改动，`feat(chat): interruptible turns with
steer and queue lanes` 落地回合化本体：每回合一个 AbortController（中止时给
未结算 tool call 补写合成失败结果，日志仍可回放）、`turn/start` /
`turn/end{reason}`、双车道（Enter 插话 / Shift+Enter 排队、队列逐条撤销）、
停止按钮与 Esc、`maxSteps` 参数化（计划轮 50）与预算将尽提示，
续跑预算从「每用户消息」改为「每计划」且停止意图会把计划置 `paused`。
顺带把 life-mode 的日预算改成「tick 被消费才计费」。

**批次一·五剩余三项（C5 → C1 → C7）**：

- **C5 shell 显式化**：`execFile(command, { shell: true })` 在 win32 上解析
  ComSpec（=cmd.exe），是"她发 `grep -rn` 全部报错"的直接原因。现在探测
  Git-Bash（`git --exec-path` → 程序目录 → PATH）→ 缺失回落 PowerShell，
  显式传可执行文件 + 命令参数。**两处非显然坑**：Git-Bash 必须用 `-lc`
  （非登录 shell 拿不到 `usr/bin`，`grep`/`ls` 都不在 PATH），而 `-l` 又必须
  配 `CHERE_INVOKING=1`，否则 Git for Windows 的 profile 会把工作目录换成
  `$HOME`——命令会"成功"地跑在错误目录里。分级正则补了 PowerShell cmdlet
  与别名，每个别名（`ri`/`rd`/`del`/`iwr`/`irm`/`sc`/`ni`/`cpi`/`mi`/`rni`/`md`）
  单列一条测试样本，并只在命令位（行首或 `;`/`|`/`&` 之后）匹配，
  免得参数里的 "ri" 触发误判。
- **C1 检索原语**：`@vscode/ripgrep@^1.18.0` 实测以平台子包直接分发 `rg.exe`
  （`ripgrep 15.0.0`），没走 postinstall 下载，本次未触发小写 `https_proxy` 那条坑。
  命中行签名按**文件总行数**计算（测试直接与同文件 `read` 投影比对），
  所以 grep 的命中可以直接喂 `edit`。结果有界（50 命中 / 200 字符 / 20 秒）
  且截断会明说；ripgrep 不可用时走 Node 兜底走查并在结果里声明降级。
  **实测两处易错**：ripgrep 会回显搜索参数，所以整仓搜索的路径是 `./src/a.ts`
  （已统一归一化为 `src/a.ts`）；`buildSignedFileProjection` 默认只投影 400 行，
  拿它做跨页签名比对的断言必须显式传 `limit`。
- **C7 切根**：`setWorkspaceRoot` 校验（存在 / 是目录 / 可写）后**同时重建**
  host + tools + codeRuntime——只重建 host 会让 Code Mode 继续跑在旧树上，
  这正是回归测试专门断言的一半。切换持久化到 `<userData>/coding-host.json`
  并压过 `AIRI_WORKSPACE_ROOT`（环境变量只决定首跑），切根写 journal
  `context/inject` 让她知道地面换了。

**环境备注**：本机 4 个 `stage-tamagotchi:node` 用例常态失败，全部是
`EPERM: operation not permitted, symlink`（Windows 未开开发者模式），
与本批改动无关：`plugins/index.test.ts` 的两个 gamelet 用例、
`http-server/static-assets/paths.test.ts` 的两个符号链接用例。


### 批次二 / 三 / 四 + §9.1 落地收官（2026-09-01）

HARNESS-PLAN 的四批与 §9.1 三处缺口全部实现并提交（八个提交）。状态表见
`HARNESS-PLAN.md` §4.0，本节只记结论、决策与踩到的坑。

**批次二（证据门 + todo + 持久化 + 后台）**

- **证据门去焦点化是 R3 的根修**：打戳从「当前焦点步骤」放宽为「任何**未完成**
  且接受该工具的步骤」（焦点只作优先级）。同时把「焦点推进」做成**派生**而非写入：
  步骤被门解决后，`currentStepId` 自动指向下一未决步骤。原实现里步骤一完成就
  没有任何步骤处于 in_progress/blocked，投影随即不再指名任何步骤——这才是
  「计划卡住不动」的直接机制。
- **错配不再静默**：无处可挂的工具结果记 `plan/hint`，并在计划投影里回喂
  「bash 没有产生步骤证据；开放步骤接受 read」。丢证据是原设计里最贵的静默失败。
- **todo 通道是派生态**：取最近 `turn/start` 之后的最后一次 `todo/write`。
  这样「新回合清空」不需要任何清空写入，last-write-wins 也天然成立。
  它不参与验证门，也不被门阻塞——把沟通职责压给裁决机构正是 R3 的成因。
- **持久化可见化**：`plans.persistence` 三态 + 开库退避重试 + 琥珀芯片。
  OPFS 单写者冲突多是残留句柄，退避重试把「静默无持久化」变成「慢一点启动」。
- **bash 后台**：作业注册表 + `job_output` / `job_kill`。**两处非显然点**：
  审批门必须在 spawn 之前（后台启动也是执行）；杀进程要杀**进程树**
  （win32 用 `taskkill /T`，否则 bash 死了但 dev server 还占着端口）。
  切根时 `disposeAll`，不留孤儿进程在没人指向的目录里。

**批次三（工作画像）**：`profile: 'work'`（计划轮默认）——系统前缀不再注入
Stage Control / 注意力节，计划投影移到末条用户消息尾部的 `[Plan]` 块。
判据很直接：前缀是**被缓存的那一段**，计划投影每落一条证据就变一次，
放在前缀里等于每步重付整段对话的钱。叙述跳过 `filterToSpeech`——
那个过滤器是为 TTS 而生的，它在工作轮里吃掉的正是「边干边说」。
每次 supplement 变化记 `prompt/supplement-changed`，T5 验收从此有据可依。

**批次四（btw）**：独立 `streamFrom` + 独立 AbortController，不写主会话、
不进队列、不触发回合钩子、不挂任何工具。上下文是**有界工作投影**
（计划步骤 + todo + 最近 6 条工具摘要），三小时任务与第一分钟同价。

**§9.1 三处缺口（用户拍板一并做掉）**

- **journal 落盘 + 回放**：主进程 `journal-host` 持有
  `<userData>/journal/<sha256 前 32 位>.jsonl`，渲染端只镜像、**按微任务批量**写
  （工具循环一轮几十条事件，逐条写会把循环变成磁盘绑定）。写盘失败不影响内存流。
  leader 启动时**先回放 journal 再水合计划**——计划态是从事件派生的，顺序反了就白回放。
  会话文件名用哈希：会话 id 来自聊天会话，可能含文件系统不接受的字符。
- **委派原语**：`task` 工具 = 只读子运行（grep/read/list、12 步预算、独立消息列表）
  + 短报告。**报告是主张不是证据**（原则三），工具描述与返回文本都写死这句话，
  它不能满足任何计划步骤。
- **diff 面**：`summarizeLineDiff`（公共前后缀 + 有界列举）挂在 `write` / `edit` /
  Code Mode 的结果里，不新增 UI 面（§9 第一条「UI 第 3 位」不变）。
  `write` 为此多一次读——代价换来「整文件覆盖也能审阅」。

**验证**：`packages/stage-ui` 144 文件 / 859 用例全绿；
`coding-harness` + `core-agent` + `stage-tamagotchi:node` 定向全绿；
四个包 typecheck 与全仓 eslint 干净。
全仓 `vitest run` 另有 11 个**与本批无关的 Windows 环境失败**：
`plugins/index.test.ts` 与 `static-assets/paths.test.ts` 各 2 个
（`EPERM: symlink`，未开开发者模式）、`cap-vite` 5 个（路径分隔符断言）、
`ui-server-auth` 1 个（CRLF 断言）、`plugin-sdk` 1 个（入口解析）。
这些包本批一行未改。

**未做（有意）**：`HARNESS-PLAN.md` §7 的真机验收 T1-T11 需要构建版 electron +
CDP 走查，属另一轮工作；本轮只保证代码面与定向测试。

### 真机验收（2026-09-01）：HARNESS-PLAN T1-T11 走查

环境：`build:packages` + `stage-tamagotchi build`（`out/`），electron.exe 直跑 +
`APP_USER_DATA_PATH=D:\.airi-smoke\userdata-acc2`（复制真实 profile 的
Local Storage / IndexedDB——provider 配置随行、旧 journal/计划不带入）+
CDP 9250 raw eval（ASCII 直发，非 ASCII 走 `.zcode/tmp/cdp-eval-utf8.sh`）。
fixture：`~/AIRI-workspace/notes/` 下 3000 行 CRLF `big.txt`（NEEDLE 在 2500 行）
与 3 行 CRLF `stale.txt`。

**通过项（9/11）**

- **T6 计划门自走**：grep→step-locate、edit→step-edit、bash→step-verify 三份
  证据**自动**分戳到三个不同开放步骤（全程零 `plan_update focus`），门判完成，
  计划离开活跃列表——R3「卡 1-3」与「完成不消失」双灭。
- **T8 循环**：grep 命中带签名（`2500 cqp`）**直接喂 edit**（零 read），
  `applied`；bash 确认 `exit 0, git-bash`；**编辑后文件 3000 行全 CRLF、0 裸 LF**
  ——C6 edit 侧保真实证。
- **T9 分页读**：`stale.txt (4 lines · showing 1-4 · more no · baseHash … ·
  lineEnding CRLF)`；`big.txt (3001 lines · showing 1-400 · more yes)`；
  big 签名 3 字符 / stale 2 字符——**签名宽度按总行数**（跨页不变式）成立。
  她的一次 read 参数解析失败收到结构化错误后自愈重试。
- **T10 陈旧写**：盲写（旧 baseHash）→ `state_changed` + 当前哈希、**未落盘**；
  她重读见到外部篡改后以新哈希重写成功并附行级 diff。
- **T2 打断**：工具执行中发消息 → 原回合在工具结算边界以
  `turn/end {reason:'steered'}` 收束，打断消息进入新回合，sending 归位。
  已开始的 bash 照常结算（drain 语义，与 dsh 一致）。
- **T3 零续跑**：计划轮中打断 → `planContinuationMsgs: 0`、零新回合
  （R2 永动机死亡）；停止按钮路径 `abortActiveSend` → `turn/end {reason:
  'aborted'}` + **计划 `paused:true`** + 回合数稳定；「继续」（RESUME_INTENT）
  → `paused:false`。注意：消息级暂停依赖短锚定 `STOP_INTENT`（停/继续/resume…），
  英文长句不匹配——停止按钮才是可靠路径。
- **T7 后台 job**：`bash {runInBackground:true}` → `job-1` 立即返回（返回文本
  自带 job_output/job_kill 教学）→ `job_output: running` → `job_kill: killed`。
  120 秒转圈在结构上死亡。
- **T5 缓存可观测**：`prompt/supplement-changed{hash,previousHash}` 链式落
  journal；A1 三步回合全程仅 1 次（回合内零抖动）。
- **T11 win32**：bash 结果声明 `read-only tier, exit 0, git-bash`——shell
  显式化后她在 Windows 直接用 POSIX grep 成功，cmd.exe 报错模式不复存在。
- **T1 叙述**：slices 为 `call:grep, call:edit, call:bash, text(90)`——
  叙述与工具交错可见（filterToSpeech 旁路生效）。本轮她习惯收尾才说，
  交错密度属模型风格。

**发现（移交修复）**

1. **journal 回放启动时序缺陷（本轮头号）**：写入半边正常——会话 jsonl 落盘
   109 条（`<userData>/journal/sha256(会话id)前32.jsonl`，哈希归属已验证）；
   但重启后 `main.ts` 的 `hydrate(activeSessionId)` 执行时**会话 store 尚未
   恢复**，回放打到了错误的默认会话（journal 仅 1 条）。手动对正确会话
   `hydrate()` 一次性恢复全部 109 条（turnEnds 完整重现 8×completed /
   2×steered / 1×aborted）——机制完好，纯启动顺序问题。计划恢复不受影响
   （DuckDB 快照兜底，但这正是「快照而非日志」的旧路径）。修法方向：boot
   等会话恢复完成后再 hydrate，或 leader 侧 watch `activeSessionId` 变化补
   hydrate。
2. **write 行尾缺口（C6 write 侧）**：edit 保真已证，但她用 `write` 以 `\n`
   内容整写 CRLF 文件后落盘即全 LF——read 头部明明声明 `lineEnding CRLF`，
   write 侧未按主导行尾归一。在本 CRLF 仓库里等于「整文件写一次、diff 全花」。
3. **btw 无首问入口**：`askActive` 仅程序可达；`btw-card` 只处理追问；
   InteractiveArea 无任何 btw 手势。store 懒实例化导致构建版控制台也不可达，
   **T4 真机验证被此阻塞**。

**行为注记（非缺陷）**：steer 后她在新回合顺手完成了原任务的 pending ls
（harness 交付正确，模型顺从性）；裸「继续」只回文本不跑工具；
被打断回合已结算的工具证据仍会完成其步骤（step-wait 在打断回合后 completed）。

**结论**：T1/T2/T3/T5/T6/T7/T8/T9/T10/T11 通过；T4 阻塞于发现 3；
发现 1、2 为移交缺陷。验收后遗留：`~/AIRI-workspace/notes/` fixture 与
`D:\.airi-smoke\userdata-acc2` 冒烟 profile 未清理。

**修复闭环（同日）**：发现 1/2 已修（`e162f17e4` 回放改为 watch
activeSessionId——真机重启后选择落地即回放 110 条、turnEnds 完整重现；
`6dad8e794` write 按主导行尾归一并报 `lineEndingNormalized`，21/21 单测含
CRLF 回归）；发现 3 以 `/btw` 指令解决（`a6f1c2ace`：send 顶部分流到 btw
store，不进队列不写会话；`1559f9d8d` 发送按钮删除、Esc 打断、提示文案
Esc 优先）——真机复验：`/btw` 提问后主会话零写入、零新回合、btw store
answered 且答案带人格口吻。注：btw 回答偶带角色卡的 `<|ACT|>` 协议前缀
（人格节随卡注入所致），属外观问题，后续可在 btw 组装时剥离。



## LOOP-PLAN 立项（2026-09-01）：心流模式

产出 `docs/fork/LOOP-PLAN.md`。**只写文档，未动代码。** 依据是一次真机任务的
完整 journal 复盘（dsh web 连接插件，488 事件 / 36 回合 / 125 次工具调用，
`<userData>/journal/04b0b35e49b94e0822fc9c62107b0c98.jsonl`），文档内所有诊断
均带 `seq` 引用可复查。

- **核心判断**：AIRI 有「一步」，没有「一步一步」。回合结束后没有任何东西在问
  「用户要的事做完了吗」——判定权散在三处互不通气的机械里（`stepCountAtLeast`
  只数步数；`schedulePlanContinuation` 只看计划步骤且**仅在 `options.planId`
  存在时被调用**；用户 Esc/删对话是唯一兜底）。于是"想一下改一下"这种最常见
  的工作形态在结构上不存在。
- **解**：把现有 `profile: 'work'` 升级为独立运行状态「心流模式」，
  **与 `/plan` 完全独立**（已拍板）：计划提供**裁决**，心流提供**推进**；
  心流不会自动升级成计划模式，其终止条件只与任务有关。顺带化解 HARNESS-PLAN
  §9.2 的张力——心流是第三档「有循环、无裁决」。
- **journal 坐实的五处**：
  1. `chat.ts:1088-1095` 的 `planId || command` 同时决定 profile 与预算 →
     计划蒸发后同一件工作 50 步变 10 步（turn 26 → turn 31），且无任何提示。
  2. **三次 max-steps 三次悬空工具调用**（10 call / 9 result，无例外）——
     墙落在她伸手到一半，模型永远看不到最后一步结果，且 transcript 留下
     provider 会拒的悬空 `tool_calls`。
  3. **122 条 `tool/result` 中 `ok=false` 为 0**：`ok: !ctx.data.isError` 记录的是
     调用是否抛异常，而 coding 工具把失败编码成返回字符串从不 throw →
     "失败"这个信号在系统里不存在 → 证据门收下失败命令、步骤永不 failed、
     一切基于失败的循环判据永远空转。**这是第一前置项。**
  4. **三个计划先后蒸发**（seq 220/253/463+470 全是 "No active plan"），
     她三次重建不是健忘而是每次都发现计划没了；全程只有 1 条 `plan/update`，
     **状态转变零记账**。riskLevel 级联已初步修复，但实测残留：只用 `bash`
     干活的步骤（计划 C 的 step-3）仍退回宽松语义。
  5. **`assistant/chunk` 事件数 0**，`assistant/start` 36 / `assistant/done` 24 →
     12 个回合零文本，其中 turn 30 是 32 步连续工具全程一字未说。
     气泡是原子单位，封口前没有中途表达的位置。HARNESS-PLAN 的 T1 判定未达成。
- **推进形态的明确弃用**：现有 `schedulePlanContinuation` 用合成的
  `user/message`（"Plan continuation (n/N)…"）推进。本计划弃用该形态——它污染
  对话历史、使"谁在说话"不可辨、把判据挤进提示词。改为 runtime 内续跑：
  尾部追加、前缀不动，**这同时就是缓存策略**（验收 L4 断言心流各回合之间
  `prompt/supplement-changed` 哈希恒定）。
- **进入条件不靠自律**：「她认为有必要时开启」若交给模型判断即自律式解法。
  改为结构触发为主（出现变更类工具 / `todo_write` / `plan_update start`）、
  显式声明为辅。五种退出（done/blocked/interrupted/budget/no-progress）
  全部落 `flow/end {reason}`——这是第 4 条那个教训的直接应用。
- **顺带发现的证据门缺陷**：`refProvesMutation` 只看 bash tier 不看 exit code，
  一条 `medium tier, exit 1` 的失败命令可以充当变更证明。修 `outcome` 字段时一并处理。
- **另一处收益**：content 已开始后的失败不能重放整轮（会重复内容），正确处置是
  "保住已完成的工具结果、作为新一步继续"——**这与心流的正常推进是同一条代码路径**，
  比在流层做通用重试省得多。
- 批次：前置（`outcome`/`tier` 结构化 + 悬空补偿 + 状态记账）→ 一（心流状态本体）
  → 二（harness 推进）→ 三（重试分类 + chunk 落盘 + btw 反向）→ 后续（rewind
  取代删对话，数据前提 journal + `contentHash` 已具备）。验收 L1-L9，
  其中 L1/L2/L7 列为常驻回归（对应的都是静默失败）。

## LOOP-PLAN 实施（2026-09-01）

已落地前置、批次一、批次二和批次三的代码闭环：

- `ToolResultEvent` 增加 `outcome` 与 `tier`。证据门不再接受失败 bash 结果。
- 预算耗尽的工具调用会写入合成失败结果。provider transcript 保持可回放。
- 新增 `flow/start`、`flow/step`、`flow/end`。心流续跑在 runtime 内执行，不写合成 `user/message`。
- 心流按结构工具触发。它支持 `/flow`、`flow_update`、40 回合预算、400 次工具调用预算、连续无进展退出、重复失败拦截、陈旧 edit 强制 read 和有限失败上下文。
- 心流回合写入 `assistant/chunk`。工作轮使用稳定系统前缀和消息尾部上下文。
- 新增 `btw_ask` 非阻塞提问。用户答案从 journal 投影进入下一步上下文。
- `/flow` 状态指示器和停止操作已加入 composer。

定向 Vitest、core-agent build、core-agent、stage-ui 和 stage-tamagotchi typecheck、受影响文件 lint 均通过。Windows Electron 真机验收 L1-L9 尚未在本批运行；需要带 provider 的实际任务确认自动续跑、缓存哈希和中途中断。

## LOOP-PLAN 二轮深挖（2026-09-02）：`FLOW-DIAGNOSIS.md`

对首次真机深挖的归因做了**修正**（同一 journal，seq 503-652）。**只写文档，未动代码。**

- **新增** `docs/fork/FLOW-DIAGNOSIS.md`，含完整复盘与改动清单（P0 ×3、P1 ×5、P2 ×3）。
- **修正 §11.3.1 的归因**：心流只跑一轮的根因不是「她把 Flow 当事务锁急着交卷」，
  而是证据门把「任意允许工具的成功回执」当作「步骤要验证的内容已完成」。
  `planLinkFor`（`chat-orchestrator-runtime.ts:905-923`）在聚焦步不接受工具时
  落到第一个接受的开放步，于是 seq 547 一条**探活 bash** 满足了
  step-3-test-verify（真正集成测试 seq 590 还没跑），计划 A 提前判 completed，
  `activePlans` 移除，她同回合两次遭遇 "No active plan"。
- **另一条修正**：bash 连发不是「她不会用合适工具」，是本地 HTTP 无声明式通道
  （`fetch` 无 method/body 且 SSRF 封锁 loopback、`code_mode` 沙箱无 http），
  bash 是唯一路径。附带一个安全问题：声明式 fetch 有 SSRF 防护，命令式 bash
  完全没有，她的手写 HTTP POST 绕过了 loopback 封锁，且 `tier=medium` 无审批。
- **同场记档**：`plan/hint` 只取 `slice(-2)`（`buildTurnProjection:94`）且内容
  在教她放弃正确的 grep/list；seq 651 用户安慰在 seq 652 `insufficient balance`
  前未被回复。

## FLOW-FIX 批次（2026-09-02）

- **动机**：首轮真机把探活回执误当验证证据，并在 tool-call 阶段提前结束心流；
  工作轮还混入人格外观工具，缺少环境与 agent 角色基座。
- **改动**：完成门延后到 tool-result 与 turn 边界，并要求本心流已有变更成功证据；
  验证步骤增加 test/verify/build/lint/check 语义门；重启从 journal 重建心流计数；
  hint 改为最近工具聚合；计划变更步骤结构化补入 read/grep/list，未验证计划留在
  active 集。工作轮增加环境块与 Agent Role，Live2D 提示仅 social，工作工具面收紧为
  `WORK_TURN_TOOL_NAMES ∪ 计划步骤 allowedTools ∪ activatedSkills`；压缩失败回落到
  journal 机械摘要；spark 指令补执行契约；删除废弃 `plan-runtime`。
- **验证**：`@proj-airi/core-agent` 全量 Vitest 通过（23 files / 206 tests），
  core-agent build 通过；stage-ui 定向 Vitest 通过（3 files / 41 tests），
  stage-tamagotchi 内置工具测试通过（3 tests）；core-agent、stage-ui、
  stage-tamagotchi 三包 typecheck 和全局 `pnpm lint` 通过，应用 build 通过。
  Electron 9250 抽查成功启动并确认主 renderer、lazy chat 窗口、聊天控件和工作工具
  注册；隔离 profile 无 provider，故 iterations≥2、验证前计划状态和带模型的工作提示
  真机链未执行，不记为通过。
- **遗留**：P1-2 本地 RPC 仅登记端口制并独立立项；P2-1 social 轮 flow 工具待拍板；
  环境块的 git 分支、测试/构建命令扩展待后续。
- **延伸评审（FLOW-DIAGNOSIS §4.2）**：FLOW-FIX 后心流不再提前终止（iterations:12、
  `flow/end` 落回合边界），但**回合内步进**仍不符合 harness 预期。根因不在心流层，
  在 `llm-service.ts:248` 的 `stopWhen: stepCountAtLeast(maxSteps)` + `chat.ts:1129`
  对 work 轮设 `maxSteps:50`，单回合可连发 50 个工具调用而无需停下思考。
  journal 实证（seq 679-932）全部 12 回合 `assistant/chunk` 的 `before`/`during`
  均为 0，100% 落在最后一次工具调用之后。由此新增 **P0-4**：把 work 轮 `maxSteps`
  降到 3-5（方案 A，改一行），配合 `prepareStep`/`postToolCall` 注入叙述指令
  （方案 B），让「一步」从「一个回合」变为「一次工具调用 + 一次评估 + 一次叙述」。
  方案 C（流动步进回调）列为长期方向，不作为第一优先。详见 FLOW-DIAGNOSIS §4.2。

## FLOW-STEP 批次（2026-09-02）

- **动机**：`stopWhen: stepCountAtLeast(maxSteps)` 在工具执行前做停止决策，导致预算边界
  可能丢失当前工具结果；单个心流回合还会连续执行过多工具，工具间隙没有重新思考。
- **改动**：通过 `pnpm patch` 持久修改 `@xsai/stream-text@0.5.0-beta.8`，新增执行后的
  `onStepResult` 回调。`llm-service` 只在无工具调用的 step 上使用 `stopWhen`，runtime
  在工具结果完整落地后用 `{ stop: true }` 控制预算。心流 `softBudget` 固定为 5，非心流
  work 轮保持原 `maxSteps`（默认 50）。心流后续 step 增加工具间隙叙述提示。
- **验证**：真实 patched xsAI SSE 测试确认工具执行、tool message、step result 均先完成，
  然后回调才可停止；core-agent 定向测试 77 tests 通过，core-agent typecheck 通过。
- **遗留**：需要 provider-backed Electron 真机重跑 seq 679 场景，确认每回合不超过 5 步、
  工具间有 chunk，并观察跨回合 iterations；本批不改变 P1-2、P2-1 或环境块扩展范围。

### FLOW-EVIDENCE / ROOT 修正（2026-09-02）

- **动机**：复核发现 `expectedEvidence: 查看 diff` 仍会把成功的 `git log` 当成证据，
  另一个实际阻塞是模型没有可调用的显式根切换工具，无法安全读取根外的 `patches/`。
- **改动**：证据门为 diff/patch 语义增加正文判据，只接受成功回执中实际出现的统一
  diff 标记；`git log`、`git diff --stat` 和探活结果不再过门。保留
  `resolveInsideWorkspace` 的越界拒绝，新增 `setWorkspaceRoot` 模型工具：调用一次
  绝对路径后由主进程校验存在/目录/可写，重建 host + Code Mode，并持久化和记 journal。
- **验证**：新增 `git log` 拒绝与 patch hunk 通过的 core-agent 回归测试；工作区工具
  注册测试覆盖 `setWorkspaceRoot`，主进程切根测试继续覆盖普通 read 与 Code Mode 共同换根；
  core-agent/coding-harness/stage-ui/stage-tamagotchi typecheck 与 stage-tamagotchi build 通过。
- **遗留**：仍需带 provider 的 Electron 真机确认模型先调用 `setWorkspaceRoot` 再读取
  `patches/`；本修正不放宽 read 的绝对路径约束，也不把根切换加入 Code Mode 的静态 bridge。

## MCP SERVER TIMEOUT 配置（2026-09-02）

- **改动**：MCP server 支持独立的 `requestTimeoutMs` 和 `maxTotalTimeoutMs`。
  两个字段进入共享契约、严格 JSON 校验、设置页表单和中英文文档。
- **运行时**：连接、工具枚举、工具调用和测试连接都读取所属 server 的预算。
  请求超时在进度更新时重置，总超时由 AIRI 自有墙钟信号强制执行。
- **验证**：MCP 定向 Vitest 10 tests、stage-tamagotchi typecheck、包级 lint、应用 build 和
  `git diff --check` 已通过。开发 Electron 日志显示 CDP 启动，但端口未在 60 秒内接受连接，
  设置页点击验收未执行；没有停止已有 Electron 进程。

## FLOW-AUTONOMY 心流自主化（2026-09-03）

- **动机**：两轮实测显示心流「过程被硬化勒死、完成判定却是弱判据」：no-progress 杀死
  合法勘探，done 门放行 `ok:true count:0` 型假完成，叙述 100% 挤在回合尾，插话直接杀死
  心流。设计对照 Codex harness 审计（软/硬控制分层、stop-hook 位置）裁决为「外硬内软」，
  设计文档 `docs/fork/FLOW-AUTONOMY-PLAN.md`。
- **runtime**：`todo_write` 不再触发 flow；停滞 = 零变更且零新增互异观察（`stalledTurns`
  + `seenObservations`）；`plan/hint` 仅变更类工具发射；flow 迭代步预算默认 2
  （`flowStepBudget` 可调，turn/start 记 `stepBudget`）+ 45 分钟墙钟；flowPrompt 重构为
  开场契约（开场叙述、预算透明、steering、驳回反馈）。
- **完成权威**：新模块 `core-agent/src/planning/flow-completion.ts`；done 声明在回合边界
  过 L1 步骤门合取（host 端口 `evaluateFlowCompletion`）→ L3 低费 LLM 评审
  （`reviewFlowCompletion`，bounce 必须引用回执，两连驳转 btw_ask 问用户）；移除旧的
  「须有变更」粗暴门，分析型 flow 可诚实完成；`flow/completion-review` 事件入 journal；
  done 的 detail 与 wrap-up 携带 unverified 清单。
- **steering**：心流期间排队用户文本并入下一迭代开场（`user/steering` 事件，
  `steerQueue` 上限 3），排队项 resolve 出队；flow 中 ingest 不再设置 steerRequested。
- **可见性**：`flow-timeline-card.vue` 进聊天时间线（journal 活动流，含叙述与 steering）；
  心流四种结算结束追加可见 wrap-up 助手消息；composer 指示器加聚焦步 intent；
  devtools coding-console 增 `flow/*` 过滤桶；压缩摘要对有 flow 的 session 追加交接项；
  `flow_update`/`plan_update` 描述按新语义改写。
- **验证**：core-agent 228 tests（新增 11）、stage-ui 定向 130 tests 全过；
  core-agent/stage-ui/stage-tamagotchi/stage-pages typecheck 通过；改动文件 lint 全绿；
  i18n 仅增 en 与 zh-Hans。已知无关失败：stage-tamagotchi 插件宿主与静态资源路径
  各 2 例（既有 Windows 路径分隔符问题）。真机验收清单见 FLOW-AUTONOMY-PLAN。

## FLOW-KNOWLEDGE 知识可达性与呈现修复（2026-09-03 第二批）

- **动机**：验收复盘（40 轮预算用尽）定位两条设计性根因：复合体项目的 agent 契约
  （SKILL.md/AGENTS.md/MCP instructions）在工作面零通道；一次失败回执令计划猝死并
  关闭盖章通道 35 轮。另含用户三项呈现要求：迭代气泡可见、开场叙述稳定、收尾由
  模型陈述。设计记录见 FLOW-AUTONOMY-PLAN 的 FLOW-KNOWLEDGE 节。
- **改动**：① 失败回执只产生 blocked 观察，`failed` 仅来自模型显式声明
  （evidence-gate 投影）；② work 轮渲染 `## Toolset`（MCP instructions 可达，
  profile 过滤保留）；③ 新增 `workspace-docs.ts`：skill 目录（`.agents/skills`
  frontmatter + 已审技能，4k 预算）与 `AGENTS.md`（6k 有界 untrusted）进工作前缀，
  正文按需经 `read` 读取，缓存按 root+TTL；④ bash 分类器把解释器/脚本调用归
  medium（`--version/--help` 探针除外）；⑤ flow 迭代助手消息改可见
  （`flowIteration` 标记仅门云同步），step 0 注入系统级开场指令；⑥ wrap-up 改为
  模型轮（机械记录作合成提示，失败回退机械文本）。
- **验证**：core-agent 232 / stage-ui 873 全过（新增约 11 例）；四包 typecheck 过；
  改动区 lint 干净。

## CONSIDERATION 社交考量批次（2026-09-04）

- **动机**：生命模式虽有心跳，却长期只留下 `self_note`，没有可靠的公开开口闭环；
  重启还会重新等待完整间隔，`0 → 23` 静默配置也没有在界面上暴露实际影响。
  设计记录见 `docs/fork/CONSIDERATION-PLAN.md`。
- **主进程**：以持久化 `nextHeartbeatAt` 的单次定时器替代重复间隔；拆分 heartbeat
  与 decision 时间；增加 Valibot 配置校验、pending heartbeat TTL、原子决定 claim、
  每次变更后的完整 Eventa 快照广播；测试心跳只跳过时间门，不跳过预算。
- **社交闭环**：生命 store 移除长期 goal/心流执行，先从 journal 投影最多五个有界事实；
  排除原始工具输出、life 反馈和 `self_*` 结果；只挂 `self_decide`，要求
  `toolChoice=required`、`maxSteps=1`。控制轮普通文本不进入聊天/TTS，只有经过验证的
  `speak` 通过 `publishAssistantMessage` 进入气泡和 TTS。
- **可观测性**：新增 `life/heartbeat` 与 `life/decision` 事件、跨窗口 snapshot，设置页
  拆为状态卡、配置表单、决策列表；显示下一次心跳、预算、gate、决策，并警告超长静默。
- **验证**：core-agent 全量 25 files / 243 tests，stage-ui 全量 148 files / 885 tests，
  stage-tamagotchi 生命模式与内置工具 22 tests，四个目标包 typecheck，改动文件 lint
  和 i18n build 均通过。
- **遗留**：已用隔离 profile 启动 `out/main/index.js` 并确认主 renderer CDP 目标；
  settings lazy window 的 agent-browser 自动化在本轮超时，因此浏览器多窗口、打包 EXE
  和当前 provider 的 20 组行为实验仍未执行。隔离 profile 已清理，日常 userData 不因
  本批次自动修改。

## RELIABILITY 批次（2026-09-05）：审计文档 R1–R6 短期修复

依据 `docs/fork/reliability-and-roadmap-plan.md`，一次落地全部短期可修复项。

- **R2（42P10）**：`memory-pgvector` insert 的 `ON CONFLICT (origin_id)` 补上与部分唯一
  索引相同的谓词（`WHERE origin_id IS NOT NULL AND deleted_at IS NULL`），修掉真库上
  全量 insert 失败的 42P10；insert 增加墓碑守卫——同 `origin_id` 的软删行存在时直接
  返回该行，重投递不再复活已删除事实；`schema.ts` 补唯一索引声明与 DDL 对齐。
  已用 PGlite（真 Postgres 语义）复现修复前 42P10 与修复后幂等；集成测试新增
  幂等重投递、无 originId 插入、墓碑不复活、update/remove 传播四组用例
  （DATABASE_URL 门控，Docker 本轮未运行，真库验收待独立执行）。
- **R1（journal）**：主进程 journal-host 按 seq 去重（回执丢失重试不重复写盘，
  watermark 从文件首个 seq 起算连续段，兼容无 header 的旧格式文件），read 返回
  `lastSeq/gaps/corruptLines/duplicateLines`，回放上限 2000 → 50000。渲染层 store：
  失败批次按序重入队 + 指数退避重试（1s→30s），`flushNow` 挂 beforeunload 尽力落盘；
  hydrate 改为 `initialEvents` 种子化，**回放保留原始 seq**（证据引用、决策水位、
  devtools 编号跨重启身份稳定），遇缺口只装载连续前缀并公开 `identityBrokenFrom`，
  绝不静默改写历史文件；`persistenceStatus.complete` 公开持久化健康度。core-agent
  runtime 新增 `journalIntegrity` 依赖——回放不完整时抑制心流自动续跑。
  devtools coding-console 增加持久化状态行（降级时橙色显示 pending/gaps/缺口）。
- **R3（镜像传播）**：pgvector 新增 `updateByOriginId`/`removeByOriginId`（update 过滤
  软删行，remove 即墓碑）；shared/eventa 新增 `memoryHostUpdate`/`memoryHostRemove`，
  memory-host 与 renderer 桥补齐通道；memory store outbox 泛化为
  `insert | update | delete` 三种操作（旧条目无 kind 归一化为 insert），approve/reject、
  supersede 批准、内容编辑（携带重嵌向量）、删除全部入队同一 FIFO 持久化队列，
  按 kind 分派；leader 为唯一投递所有者，新增 60s 到期重试调度器（修复"退避后
  无人触发"）；设置页 outbox 从纯计数扩展为操作明细（kind/originId/次数/错误）。
  **设计裁决**：不引入版本列——单 owner + FIFO + 幂等绝对状态补丁 + 墓碑已满足
  审计全部验收（乱序不覆盖、不复活、重复幂等），版本列是冗余机制。
- **R4（完成诚实性）**：`settleDoneDeclaration` 门异常从"当 pass 处理"改为照常结束但
  detail/wrap-up 明确 `unverified: the completion gate failed`；评审弃权在机械证据不全
  （有声明关闭的步骤或门异常）时同样标注 `unverified: the completion review was
  unavailable`，证据齐全时弃权放行不变（如实记录 abstain）；**插话先于完成结算**——
  同一边界消费到 steering 时跳过 pendingEnd 结算，插话进入下一迭代开场、模型可在
  新上下文再次声明 done（修复"声明吞掉插话"）；steerQueue 溢出丢弃最旧时在
  `user/steering` 事件记 `droppedOldest`。unverified 状态经 flow detail 进入
  `flow/end` 与 wrap-up prompt（"End detail"）。
- **R6**：`server-runtime` 显式 `import process from 'node:process'`；
  `FLOW-AUTONOMY-PLAN.md` 第二个 H1 降级；i18n 未新增键。

验证：core-agent 25 files / 248 tests、stage-ui 149 files / 901 tests、memory-core
21、memory-pgvector 单元 4、tamagotchi journal-host 6 全绿；core-agent/stage-ui/
stage-tamagotchi/stage-pages/memory-pgvector/memory-core typecheck 全过；改动文件
eslint 干净（stage-ui 全量 src 在 Git Bash 下复现已知 eslint segfault，属环境问题）。

遗留（移交 R5 真机批次）：审计 §5 的 9 个 Electron 组合场景（需真实 provider、
打包 EXE、多窗口）；`DATABASE_URL` 门控的 pgvector 集成测试需 Docker Postgres
现场执行；journal 既有历史文件含缺口时前缀装载 + 状态公开的行为需真机抽查。

## TASK-RUN-AND-UI 真机验收（2026-09-05）：部分场景走查 + 跨窗口投影修复

环境：构建版 electron.exe + CDP 9250 + 日常 profile；agent-browser eval 层
交互 + `D:/.airi-smoke/cdp-eval.cjs` raw CDP（tab/connect 激活层挂死，MODS
已知坑；CDP fill 非 ASCII 乱码、Git Bash `#/xxx` 参数路径转换，均复现为已知坑）。

- **通过**：F2 真实任务 25 轮自动推进且 `user/message` 恒 1（批次 C）；F5
  活动面板标题/状态/迭代/最近失败/结束原因 + 迭代叙述气泡（批次 B）；F6
  停止按钮运行中呈现/结束消失/点击端到端中断；F7 运行中强杀重启后同
  taskId 自动恢复（iter 3→6→9）+ journal 重放 570 条投影稳定（批次 D）。
  flow/step 的 `lastJournalSeq`（17→35→50→560）与完整 resume 快照真机写入。
- **发现 #1（当场修复）**：活动面板渲染在 follower 聊天窗口，但 journal
  投影只在 leader（journal store 刻意不跨窗口同步）→ follower 面板永远
  为空。修复：leader watch 投影、经 synced action `publishTaskRuns` 发布
  `chat.taskRuns` 快照（内容哈希去重）；follower 读快照。复验通过。已知
  限制：follower 面板明细行为空（"暂无动态"），完整记录在 journal/devtools。
- **未走查**：F1/F3/F4/F8–F12；批次 E 升级拦截与大结果截断由单测覆盖。
- 验证记录与场景映射写入 `TASK-RUN-AND-UI-PLAN.md` §9。

## TASK-RUN-AND-UI 批次 E：有界内部上下文（2026-09-05）

- **失败摘要**：`FlowFailureRecord` 加 `outcome` 分类；轨迹 6 条上限、字段
  240 字符截断不变；迭代开场失败段改 `Recent failures ([outcome] …)`——
  教训不是证据（证据门语义不变）。
- **重复调用**：指纹拦截阈值 3 之上新增 `FLOW_REPEAT_FAILURE_ESCALATION = 6`
  ——升级后的 blocked 提示要求问她/声明 blocked/彻底换方法；与 no-progress
  停滞判定共同保证重复失败必然收敛。
- **大型结果**：provider 上下文中 tool 消息超 4000 字符截断并附
  `[truncated N characters — the full result is preserved in the journal]`；
  journal 保全量，UI 不变。**设计调整**：不做 workspace 临时文件外置——
  journal 已是完整结果的可读取存储，免去清理失败面（计划文档已记录裁决）。
- **验证**：runtime 新增 2 例（升级拦截、截断+journal 全量）；core-agent
  265/265、typecheck 0、eslint 干净。

## TASK-RUN-AND-UI 批次 D：Flow 恢复信息（2026-09-05）

- **契约**：`FlowResumeConfig`（provider/model/profile/toolNames/
  workspaceRoot，零 secret）+ `FlowResumeContext`；`flow/start` 带 `resume`，
  `flow/step` 带 `lastJournalSeq` 游标并刷新 resume（最新者胜）。
- **恢复门**：runtime 新 deps `verifyFlowResume`——rebuild 时组装上下文校验，
  失败/缺失写 `flow/end {interrupted, detail:'waiting to resume: …'}` 并放弃
  自动续跑（等待原因可见，不静默）；身份与 seq 用事件游标不重编。
- **宿主**：chat store 提供快照（work 画像 + 常驻工作工具面 + coding host
  root）与校验（provider 配置库同步比对；model/工具目录懒加载，严格比对会
  假阴性，记录不校验）。多窗口 owner 仍为 leader。
- **验证**：runtime 新增 2 例（游标+刷新、阻断可见）；core-agent 263/263、
  stage-ui 911/911、typecheck/eslint 干净。

## TASK-RUN-AND-UI 批次 C：Flow 唯一推进器（2026-09-05）

- **删除 Plan 自续跑**：`schedulePlanContinuation`（合成 self-initiative
  文本、每计划 2 次上限、setTimeout 冷却）整体移除，`onChatTurnComplete`
  不再调度。剩余步骤经计划投影可见、L1 完成门防 done 关闭；自动推进只剩
  Flow 一个入口（用户发送、`/flow`、flow continuation 三种入口保留）。
- **卫生核对**：flow continuation 携带 `source:'flow'`+`taskId`、不写
  user/message、不进记忆提取；续跑前结算/压缩等待/终止检查、steering 先于
  done、停止取消全链——均为既有行为，核对无回归。
- **验证**：新增 `chat-advancer.test.ts` 契约钉住删除；core-agent 261/261、
  stage-ui 911/911、stage-ui typecheck 干净、eslint 干净。

## TASK-RUN-AND-UI 批次 B：三种界面投影分离（2026-09-05）

- **任务活动面板**：新 `task-activity-panel.vue`——TaskRun 驱动、按 taskId+
  flow/end 截断事件窗口（修掉旧卡按 flow/start 扫到日志尾、跨任务泄漏的
  问题）、40 行上限、收起/展开/停止、移动端摘要行；运行中任务固定时间线
  末端，结束任务留最近 3 个可展开摘要。
- **投影去重**：`history.vue` 以 `taskRuns` 替换 `flow` prop（FlowState 卡
  与 `flow-timeline-card.vue` 移除）；`assistant-item.vue` 新增
  `hideToolSlices`——flow 迭代气泡只留叙述，工具活动归活动面板，每投影内
  一次工具调用至多出现一次。计划卡核对确认只读裁决（不显示工具参数）。
- **接线**：tamagotchi InteractiveArea 传 task-runs + stop-task（复用
  endFlow）；composer 琥珀条仍读 runtime flowStates（即时步数与投影分离）。
- **i18n**：`stage.task-activity.*`（en + zh-Hans），删 `stage.flow-timeline.*`。
- **验证**：stage-ui 150 files / 908 tests（新增 3）、tamagotchi typecheck 0
  错误、生产构建通过、eslint 干净。真机投影走查随批次 F。

## TASK-RUN-AND-UI 批次 A：TaskRun 投影（2026-09-05）

依据 `docs/fork/TASK-RUN-AND-UI-PLAN.md`（批次 A–F 的第一批）。

- **契约**：journal 事件的 `taskId` 关联字段（flow/*、plan/update、tool/*、
  user/steering、user/asked|answered、turn/start、flow/completion-review）+
  `TaskRun`/`TaskRunStatus` 类型。`taskId` 与 `flowId` 并列铸造、互不派生。
- **派生**：`core-agent/journal/task-run.ts` 的 `deriveTaskRuns`（按戳记归属，
  零时间窗口猜测；旧 journal 无戳记的 flow 聚合为 `legacy:<flowId>` 一次性
  投影，标记不可恢复）与 `openTaskId`（写方写时归属辅助）。
- **runtime**：startFlow 铸造 taskId 并随 flow/工具/steering/评审事件携带；
  `rebuildFlowFromJournal` 恢复原 taskId，无戳记旧 flow 抑制自动续跑。
- **stage-ui**：journal store 暴露 `taskRuns`；plans/user-ask/btw 写入点按
  开放任务戳记；chat store 只读投影，完成门的计划归属改戳记优先（legacy
  窗口扫描仅对旧事件回退）。
- **验证**：core-agent 261/261（新增 14）、stage-ui 904/904（新增 3）、
  core-agent/stage-ui/stage-tamagotchi typecheck 过、改动文件 eslint 干净。
  踩坑复现：stage-ui 测试消费 core-agent dist，改源码后必须重建。
- **边界**：UI 时间线改造按计划留给批次 B；真机验收随批次 F 统一执行。

## TASK-RUN-AND-UI 任务运行时与聊天界面改造计划（2026-09-05）

- **动机**：继续对照 Codex CLI、AstrBot 与 AIRI 当前实现后，确认控制循环已经存在，
  但任务身份、聊天展示、计划裁决、Flow 推进和重启恢复仍没有形成一个统一契约。
- **计划**：新增 `docs/fork/TASK-RUN-AND-UI-PLAN.md`。计划分六批：建立 `TaskRun`
  投影；分离聊天、任务活动和计划裁决；让 Flow 成为唯一推进器；保存完整恢复信息；
  建立有界的失败、重复调用和大型结果上下文；完成真实 Electron 组合验收。
- **交接**：该文件面向后续实现模型。每批先更新公共事件契约，再更新 runtime、UI 和测试；
  未完成真实 provider、停止、重启、多窗口和打包 EXE 验收时，不得声明桌面端任务运行时完成。

## MEMORY-SEMANTICS-CORRECTION 记忆语义纠偏计划（2026-09-05）

- **动机**：真实记忆样本把用户代码工作偏好保存为 `muscle`，但普通向量检索排除
  `muscle`，自然语言问题也没有匹配的 `triggerPattern`。新会话因此无法证明召回；
  dreaming pass 也有意排除 `muscle`，不能修复这个分类错误。
- **计划**：新增 `docs/fork/MEMORY-SEMANTICS-CORRECTION-PLAN.md`。先收紧普通抽取，
  让 `muscle` 只能由显式能力创建；再迁移无效旧记录；补稳定 memory 引用和召回观测；
  完成事实纠正闭环；最后运行跨会话行为纵切片。
- **范围控制**：批次 A–E 通过前不更换 embedding、不重写排序公式、不扩展生命模式，
  先证明“事实能召回并改变行为”，再决定是否需要记忆层大改动。

## MEMORY-SEMANTICS-CORRECTION 批次 A–D 实施（2026-09-05）

依据 `docs/fork/MEMORY-SEMANTICS-CORRECTION-PLAN.md`，一次一批落地；批次 E
协议见新增的 `docs/fork/MEMORY-BEHAVIOR-SLICE.md`，待实机运行。

- **批次 A（收紧抽取契约）**：`MemoryExtraction.memoryType` 收紧为
  `'short_term'`；新增 `memory-core/extraction.ts` 的
  `parseMemoryTurnExtractions()`（结构校验 + 钳制 + 误标 muscle 纠正为待审核
  事实），chat.ts 抽取提示同步只允许 short_term；`isActionableMemoryFragment()`
  门控 muscle reflex 与闯入通道（pending/rejected/superseded/disputed 一律不
  触发）；pgvector 检索过滤与 DuckDB 对齐为 approved+active 事实门。
- **批次 B（修复错误记录）**：`convertMuscleToFact()` 原位迁移无触发模式的
  muscle（保留 id/来源/访问史，重置 pending、清触发模式、重 embedding、重置
  半衰期），拒绝复活 rejected；`memory/migrated` journal 事件 + 记忆浏览器
  三选 UI（转事实/保留/删除）+ en/zh-Hans 文案。
- **批次 C（召回观测）**：`memory/retrieved` 增加 `turnId`；新增
  `memory/applied`（按 `[memory:<id>]` 标记在回答与工具参数中检测引用，
  retrieved/applied 配对，未引用记空），复述与跨会话召回可分开统计。
- **批次 D（纠正闭环）**：muscle 修订一律转为事实语义（不再保留反射），
  `supersedesId` + relation 标签保留冲突关系；新增 `memory/revised` journal
  事件；批准后旧 claim superseded，检索与 reflex 双侧过滤生效。
- **验证**：memory-core 16 例、stage-ui memory store 16 例、pgvector 5 例、
  core-agent runtime 80 例全部通过；memory-core / memory-pgvector /
  core-agent / stage-ui typecheck 通过（分支预存的无关类型错误已顺手修复
  两处：`connectMemoryRepository` 缺失的 mirror ops 类型、integration 测试
  缺失的 fixture）。改 stage-ui/core-agent 源码后注意先重建再跑跨包测试。
- **边界**：批次 E（实机行为纵切片）未执行，完成定义 §11 的"跨会话召回"
  与"纠正胜出"两条尚未有行为证据；§8 的禁区（embedding、评分公式等）继续冻结。

## MEMORY-SEMANTICS-CORRECTION 批次 B 实机验收（2026-09-05）

- 用户启动带 CDP 的构建版进程（9250）供验收；发现该进程跑的是 18:38 的部分
  构建（含 A + B 的 store 层，缺浏览器 UI 与 C/D），重建后重启补齐。
- 实机闭环（CDP eval + 页面 UI 驱动）：captureTurn 播种误标 muscle（复现
  原始故障）→ 记忆浏览器显示迁移三选 → 点击"转为事实"原位迁移（同 id、
  pending、触发清空、半衰期重置、向量与访问史保留）→ `memory/migrated`
  journal 落盘 → 审核队列批准 → 自然语言检索探针 1.274 分召回。
- 数据事实：源码 profile 两个 OPFS origin（file://、dev 5173）实测均为空库
  （含软删除行），原观察样本的存储来源待确认；PG（5435）未运行。验收记录
  见计划文档 §12.2。
- 工具坑：agent-browser `tab` 在繁忙渲染器上挂起（复认），CDP Runtime.evaluate
  (`D:/.airi-smoke/cdp-eval.cjs`) 仍是可靠探针；`useLocalStorageManualReset`
  不监听 storage 变化，控制台直接改 localStorage 不影响已创建的 store ref，
  必须给 store 赋值；embedding 模型缓存按 origin 隔离，dev origin 首次加载
  会卡在下载，构建版 origin（file://）有缓存。

## MEMORY-SEMANTICS-CORRECTION 批次 E 实机运行 + 门限校准（2026-09-05 晚）

- **切片运行**（provider: openai-compatible/gemini-3.8-flash，token 成本经用户
  许可）：组 B 通过——新会话中文问法 `memory/retrieved.memoryIds` 命中事实、
  回答策略体现"先跑测试"；组 C 通过——reviseFact+批准后旧事实 superseded、
  新会话召回只剩新事实、回答策略翻转为"先核对接口约定"；噪声项部分通过
  （无关请求行为零干扰，召回有噪声）。记录见 `MEMORY-BEHAVIOR-SLICE.md` §7。
- **切片首轮按设计暴露门限缺陷**：nomic-embed 余弦分布压缩（相关 0.377 vs
  无关 0.325 重叠），0.5 硬门限使真实转述永远召不回；实测数据驱动
  `DEFAULT_MEMORY_SIMILARITY_THRESHOLD` 校准为 0.2（memory-core，两仓储统一，
  附测量 JSDoc + pgvector 门限断言）。前缀实验证明 search_query/document
  前缀不解决；embedding 选型归 §9.1 用户决策。
- **新发现 P0 缺陷**：`closeDb()` 从未被调用，OPFS DuckDB 无干净关闭路径，
  强杀/崩溃丢数据（用户原始记忆失踪案的根因候选）；已入 WIRING-BACKLOG N 节。
- **验证**：memory-core 29、pgvector 5、core-agent 268、stage-ui 916 全绿；
  实机三轮 journal 证据（memoryIds/applied/turn-end）落盘复核。工具坑：
  rolldown 产物含 NUL 字节，grep 须加 `-a`，否则误判字符串缺失。

## MEMORY-SEMANTICS-CORRECTION 嵌入后端接入 Voyage（2026-09-05 晚）

- **配置改为直接认证 API endpoint**（绕过单实例 openai-compatible 的 Providers
  页面限制）：记忆设置→嵌入来源 Base URL / API key / 模型；Voyage 已通过实时测
  试验证（`voyage-4-large`，基础调用返回 1024 维，拒绝 `dimensions`，接受
  `input_type`）。
- **适配器**：端点 host 匹配 `voyageai.` 时自动省略 `dimensions` 参数并改为
  `input_type: 'query'|'document'`；向量维度锁定在 768/1024/1536，超出即报错。
- **存储泛化**：DuckDB 新增 `content_vector_json` JSON 列承载任意维度向量，检索
  在 JS 里按当前向量维度过滤并算余弦（不依赖某固定 SQL 列）；pgvector 按
  `content_vector_768/1024/1536` 选列（仍需重写一次 search/insert/update 以选列）。
- **阈值标定 0.5**（从 0.2 调整）：实测 Voyage 边际——短相关中文问 0.547、完整
  转述句 0.12、噪声 0.105。0.5 保留短召回、剔除噪声；长转述句召回是已知缺口，
  按背景容忍。
- **验证**：相关短问 0.547 命中(score 0.959)、噪声猫/诗 0 命中。memory-core
  29、pgvector 5、stage-ui 26 全绿；typecheck 通过。Voyage 免费档 3 RPM/10K TPM
  限流，评估时需隔 45s 单发。

## MEMORY-RETRIEVAL-AND-PERSISTENCE 记忆检索与持久化路线计划（2026-09-05）

- **诊断**：Voyage4large 已改善短中文查询和噪声过滤，但完整长转述的余弦分数仍低。
  当前主要瓶颈是 DuckDB 无可靠关闭/checkpoint、向量来源元数据不足，以及长查询与短事实
  的表示不匹配。降低阈值会重新引入噪声，不能作为长查询修复。
- **计划**：新增 `docs/fork/MEMORY-RETRIEVAL-AND-PERSISTENCE-PLAN.md`。
  先修 DuckDB 持久化；再记录 embedding provider/model/dimensions 和迁移状态；确认
  Voyage document/query input type；实现原始查询与归一化查询的双路召回；扩展分层评估；
  只有在证据充足后评估 reranker。
- **后续**：检索稳定后，再推进多视图记忆、人格连续性、跨天目标、生命模式和能力增长。

## PERSONA-CONTINUITY PC-0 至 PC-2 实施（2026-09-06）

- **PC-0 作用域契约**：新增 `MemoryScope = { userId, characterId }`，由聊天会话、角色
  事件和技能审阅写入；DuckDB、pgvector 与 Electron memory-host 传递并过滤该作用域。
  无作用域旧记录保留审阅能力，但带作用域的行为检索不会使用它们。
- **PC-1 来源事实**：抽取器保留经过结构校验的 episodic 事件；任务/反应事件保存会话与
  事件 ID/类型；已有 `sourceContext`、
  审阅状态和事实状态继续作为来源与有效性边界。不保存原始镜像帧。
- **PC-2 有界投影**：聊天 social/work prompt 增加当前角色、作用域和模式边界；记忆
  继续使用现有 top-3 投影，不复制完整工具或任务日志。
- **验证**：memory-core、stage-ui、memory-pgvector 与 stage-tamagotchi 定向类型/单测
  通过；真实 provider、跨角色重启、实际 Postgres、PC-3/PC-4 未运行，状态为已实施待验收。

## LONG-HORIZON-GOALS LG-0 至 LG-2 首轮实施（2026-09-06）

依据 `docs/fork/long-horizon-goals-plan.md`，完成跨天目标的第一轮状态与调度边界。

- **LG-0**：核对 `/goal`、long plan、Flow、life-mode、journal、memory/notebook 与
  spark 的入口；普通工作请求和 social self-initiative 保持分离，Flow 仍是唯一自动推进器。
- **LG-1**：`PlanSpec` 增加 user/character scope 与 workspace root；`PlanState.longGoal`
  保存生命周期、约束版本、等待条件、问题、运行关联和最后转换；`goal/update` 提供可重放
  的转换日志。旧 long 行保留 goalId，缺少范围时进入可见等待。
- **LG-2**：Electron 主进程新增持久化 long-goal scheduler，负责 startup/schedule/retry
  wake 和带过期时间的单租约；leader renderer 负责范围、workspace、provider、工具和已有
  Flow 检查，以及一次有界工作 Flow。主进程不调用模型和工作工具。
- **LG-3 初步路径**：暂停、取消、恢复、`Run now`、`user_ask`/审批等待和旧运行结果隔离
  已写入状态边界；完整插话、接管、过期和失败恢复仍需组合验收。
- **验证**：core-agent authority 6 例、Electron scheduler 4 例、plan tool 11 例、
  stage-ui plan store 16 例通过；core-agent、stage-ui、stage-tamagotchi typecheck 通过。
  真实 provider、打包 Electron、跨天停机重启、Postgres 和 LG-4 尚未运行。

## LONG-HORIZON-GOALS 构建版 Electron 局部组合验收（2026-09-06）

- 使用相同的用户 profile 和 CDP 9250 重建并重启 `stage-tamagotchi`。没有使用 dev 或隔离 profile。真实 provider 返回 `PROFILE-CHAT-OK`。
- agent-browser 验证了 `/goal`、`plan_update`、`todo_write`、`read`、`list`、目标卡证据、一次 `Run now` 有界 Flow 和重启后的目标恢复。
- LG-3 局部场景通过：Flow 中的只读 steering 留下 `stage.turn.steer-hint`；`user_ask` 等待可见；取消后的目标在重启后保持“已取消”，没有继续调度。
- 验收发现修订目标的旧步骤完成数曾显示为 `3/1`。`stage-ui` 回归测试先复现该问题，再让状态投影只保留当前规格中的步骤。重建并重启后，目标卡显示 `1/1`。
- 详细记录见 [LG-3 与 LG-4 局部执行证据](./evidence/lg-20260906/lg-execution-record.md)。LG-3 的约束版本递增、人工接手后重新观察、过期复查和失败恢复仍待组合验收。LG-4 的真实跨日外部条件和回顾表达仍未完成。

## SOCIAL-PRESENCE SP-1 至 SP-3 代码实施（2026-09-06）

- `life-mode` 增加当前用户/角色作用域的有来源记忆事实筛选，并把任务完成/阻塞和共享 reaction 投影为有界活动；重复 `noveltyKey` 只保留最新/高显著候选，过期候选以 `stale-stimulus` 和独立 `discarded` journal 记录消费。
- 社交心跳复用既有语音播放查询、聊天忙碌、Flow/focused 和单飞状态，新增门控原因沿用现有设置状态卡，不增加独立旋钮；社交请求仍只允许 `self_decide`。
- `mirror-visual` 的像素载荷严格留在一次性临时帧槽，失败、下游异常、prepareStep 注入完成和 dispose 均释放；持久工具结果继续仅保存文字状态。
- 定向回归 `life-mode.test.ts` 与 `mirror-visual.test.ts` 共 20 tests 通过；`core-agent` 重建后 `stage-ui`、`stage-tamagotchi` typecheck 通过；根 lint/typecheck、生产 build 和真实 profile + CDP agent-browser 已完成。SP-0 推广门和 SP-4 行为切片仍待真实场景；详细结果见 [SP 执行证据](./evidence/sp-20260906/sp-execution-record.md)，未创建提交。
## 2026-09-07 长期目标环境与 journal 写失败回归

- 长期目标保存最近一次接受的 provider、model、workspace 和可用工具快照。
- 调度发现环境变化时进入可见等待；用户 `Run now` 会重新读取并接受当前环境。
- journal host 支持写入失败注入；失败不会推进回执水位，重试只写入一次。
- 定向回归：core-agent 长期目标契约 8 条、stage-ui 计划 18 条、journal host 9 条通过。
- 这些代码与测试证据不代替真实 Postgres 断线、打包 EXE、真实跨天或 agent-browser 验收。

## 2026-09-07 Flow 恢复环境校验与 MQ-0 误召回明细

- 普通 Flow 恢复复用 provider、model、workspace 和 coding-host 工具集合校验；Electron renderer 在恢复前刷新 host status，缺失或变化进入可见等待原因。core-agent、stage-ui、stage-tamagotchi typecheck 通过，flow-resume 与 chat contract 35 条定向测试通过。
- MQ-0 生产 trace 保存 gold `relevantIds` 与 top-3 `falsePositiveIds`，报告逐样本列出误召回 id；stage-ui 评估 4 条通过。
- 真实 provider/profile 的 90 条检索、Postgres 断线、打包 EXE 和 agent-browser 仍未执行。

## 2026-09-07 MQ-0 评估上下文与误召回明细

- `evaluateProductionRetrieval` 要求显式的 profile、session、user/character scope，并将上下文随结果返回；90 条 trace 保存 gold 与 top-3 false-positive id，报告逐样本列出误召回。
- stage-ui memory module 24 条定向测试通过；真实 provider/profile 的 90 条检索与费用仍未运行。

## 2026-09-07 MQ-0 Electron renderer 生产路径基线

- 在实际 Electron renderer 中使用现有本地 profile 的临时副本，绑定真实 owner scope 和独立 session，写入 20 条 approved synthetic gold facts，并运行全部 90 条 fixture。
- 修正评估 trace 使用内部 DuckDB row id 导致 gold 无法匹配的问题，改用稳定 `originId`；报告得到 recall@3 `0.789`、precision@3 `0.263`、MRR@3 `0.637`、false-positive@3 `0.626`、平均延迟 `1104.84ms`，详见 [生产报告](./evidence/mq-0/production-report-20260907.md)。
- 本地 embedding worker 没有 token usage，90 条 query/normalized-query token 与 cost 均记录为 missing；该基线使用合成语料，不代表真实用户事实或外部 provider 质量。
- Docker Postgres 的 repository integration 4/4 通过；额外固定 owner scope 关闭客户端后重连并检索命中同一 `originId`，随后清理。该结果覆盖持久化和 scope 的客户端重连边界，网络断线、自动 outbox 重试和 EXE 组合仍未验证。

## 2026-09-07 远端记忆镜像断线状态

- long-term mirror 写入失败会把 remote status 置为 `error`，保留带退避信息的 outbox 项；重新报告 `ready` 后立即重试并恢复定时发送。stage-ui memory module 24 条定向测试通过。
- Docker Postgres 的 4/4 基础集成已通过；断线重连、真实 provider/profile 的 90 条 MQ-0 检索和打包 EXE 仍未执行。

## 2026-09-07 MD-2 归档对照工具

- stage-ui 新增 `compareDataBackups`，按 owner/domain 对两份已校验归档统计新增、删除、变更和未变路径；7 条 data-backup 测试通过。
- 该工具只提供 manifest 字节级对照，完整计划、记忆、journal 来源链与技能审阅关系仍需独立 profile 语义核对和打包运行。

## 2026-09-08 验收修复与长期目标会话归属

- 完成 R01 备份 owner 注册、K02 技能源码审阅与哈希绑定、S13 跨轮变化去重、L06 恢复入口收敛，以及证据门的文件观察/读回/测试执行区分。
- 长期目标现在保留创建会话并把计划事件、工具结果、调度唤醒和 `plan_update` 执行绑定到该会话；adoption 后的调度器初始化保持幂等。补充 scope、dreaming 归属和回归测试。
- 自动化回归：core-agent 81、stage-ui 22、stage-tamagotchi 12；根 typecheck、lint、core-agent build 和 Electron build 通过。真实 Electron 的干净 L06 场景，以及 M07/V03、L01/L03、L02、D05/D06、S20 等运行证据仍待补齐。

## 2026-09-09 Journal persistence race and visual cancellation evidence

- 修复 stage-ui journal 在 per-session IPC batch 写入期间追加尾部事件后不再调度 flush 的竞态，并增加 11 条 journal persistence 回归测试。
- 重建后的 Electron 实例使用原 profile、provider、角色和 CDP 9250；V02 取消分支确认单张图片预览、单个 `image_url`、`turn/end: aborted` 和完整磁盘 journal。V02 的受控 capture failure、重启/导出清理以及 M07/V03 记忆来源链仍待验收。

## 2026-09-09 M07/V03 来源链、L04 恢复重绑与延迟社交竞争

- M07 的 Flow-owned fact 现在保留任务来源，记忆开启/关闭对照分别命中与不命中；V03 的视觉活动事实可在新会话按精确 memory ID 取回。原始失败记录保持不变。
- long-goal scheduler 在 renderer 重启后按 goal/plan/step/Flow/task/session 重绑 persisted running goal；L04 已实证 pending shell 失败后的单次写入与读回。运行时工具结果按调用时的 focused step 归属，覆盖并发 `plan_update focus` 与 read 结果乱序。
- S13 的跨轮同值去重、S20 的延迟 speak 竞争、V02 capture failure 清理和 K04 严格输入校验均有回归覆盖。真实 provider 余额、V02 重启/导出边界、adoption 后真实唤醒、R04/R06 后端以及 L04/L05/L07 组合场景仍需外部条件满足后验收。

## 2026-09-09 备份恢复与坏包验收

- R01 在重建 Electron 中从 Data 页面导出 138 条目、7 个业务域的真实 ZIP；凭据保持排除、outbox 保持 hold，旧 journal 文件在归档中。
- R02 用同一归档创建隔离 profile，重启后回执为 `complete` 且 `effectsHeld=true`；修复了恢复 schema 漏掉 `role: "error"` 的缺口，并保留 3/3 回归。二次启动确认原用户 index 与 payload 已落盘，但 P' 无认证凭据时普通 chat UI 不能选择原 owner，因此完整数据可见条件仍是 partial。
- R07 的扩容/校验不一致和缺失条目坏包均由真实 UI 拒绝，原 profile、主会话和 provider 配置不变。R03 语义对照需要先决定 P' 的重新认证或安全 owner remap；R04/R05 与 R06 后端仍待验收。

## R-GROUP 修复批次（2026-09-10）

- **动机**：R 组交接件三条待修问题（R04 adoption 后不调度、R05 技能不可用原因不可见 +
  MCP 元工具回退、R03 恢复后首屏无明确原因）。
- **问题 1（R04）**：`backupAdopted` 原先走普通主进程 Eventa context，只回发起窗口
  （设置窗口/follower），leader 的 effect hold 永远不释放，`long-goals.json` 恒为空、
  wake consumer 从未注册。改为经 `EventaWindowBroadcast` 广播；`runNow` 增加 toast
  可见反馈；新增 host 广播回归（修复前失败）与 adoption 补排程回归。
- **问题 2（R05）**：reviewed 技能被 `artifactError`/quarantine/hash 不符等挡下时，
  在 `## Toolset` 独立说明节逐条显示不可用原因与恢复入口；无 MCP 服务器时 MCP store
  不再注册 `builtIn_mcp*`，`tool-resolver` 也不再默认注入旧代理工具（运行时 store 是
  唯一生产者）。
- **问题 3（R03）**：restore marker 记录归档 owner 并经 bootstrap 返回所有窗口；
  restore gate 暴露 `restoredOwner`；未登录首屏显示「数据已恢复，请登录 <owner>」并
  隐藏全新安装入口；i18n 仅 en + zh-Hans。
- **验证**：stage-tamagotchi node 16 files / 98 passed（1 skipped）、stage-ui 定向
  node/browser 全过、两包 typecheck 与根 lint 通过。真机复验待用户重建后执行；记录见
  `docs/fork/evidence/short-scenarios/ACC-20260907-01/R-GROUP-FIX-20260910.md`。

## FIX-LIST 批次（2026-09-10）：纠正来源、R06、life-mode 损坏保护、恢复边界、grep、门广播、活动年龄

- **动机**：`FIX-LIST-20260910.md` 的待修项 1–7；8 登记为非缺陷。
- **记忆**：`reviseFact` 的修订片段继承被替换事实的 `sourceContext`（纠正后有效事实可进
  `listShareableFacts`）；记忆镜像 update 只对已晋升的 `long_term` fact 排队，短期待审变更等
  晋升 insert 携带最终状态，修掉 R06 的「update 0 行当成功、队列清空远端缺行」。
- **life-mode**：`life-mode.json` 解析失败保留 `.corrupt-*` 副本并写日志，持久化改临时文件 +
  rename 原子写；新增 `lifeModeRecordGate`，渲染端门回写主进程快照并广播，follower 设置页可见；
  journal 为 `tool/result`/`plan/update`/`task/update` 记录时间戳，活动候选按真实 `occurredAt`
  进入 `stale-stimulus`。
- **core-agent**：重建心流时记录 `resumedAt`/`resumedFromSeq`，`flowPrompt` 每轮注入
  `[Recovery boundary]`，恢复叙述不得把恢复后动作说成中断前证据。
- **grep（方案 a）**：`@vscode/ripgrep` 加为 `apps/stage-tamagotchi` 依赖并在主进程 bundle
  外部化，运行时从 app 解析平台二进制。
- **顺带**：修复 `stateFromJournal` 在毫秒并列时重复应用已入快照转换的缺陷（queue-depth 用例
  稳定通过）。
- **验证**：core-agent 302、stage-ui 定向 node 160 / browser 34、stage-tamagotchi node 133
  （1 skipped）、InteractiveArea 15；三包 typecheck 与根 lint 通过。真机复验待用户重建；记录见
  `docs/fork/evidence/short-scenarios/ACC-20260907-01/FIX-LIST-20260910-results.md`。

## FIX-LIST 第二批（2026-09-11）：journal 身份、恢复边界、侧通道、恢复首屏、查询回压下推等

- **动机**：`FIX-LIST-20260910.md` 的待修项 9–20，按严重度从 #18 到 #17 依次处理。
- **#18（高）journal**：渲染端在 `send`/`startFlow`/计划写入前先 `hydrate`；host 去重表改为
  `seq -> 内容指纹`，同 seq 不同内容报 `sequence conflict` 而不是静默丢弃。修掉恢复副本
  「运行只在内存、磁盘零写入、seq 从 0 重来」。
- **#9 恢复边界**：新增 `flow/resumed` journal 事件（时间 + seq 边界）；普通轮次 system
  supplement 带 `## Recovery Boundary`。
- **#10/#20 侧通道**：btw 卡片限高 + 历史滚动 + 折叠；主输入框 `data-testid="chat-main-input"`。
- **#11 恢复首屏**：`showRestoreNotice` 不再依赖 effect hold；无会话发送给出可读 toast 并保留草稿。
- **#12 记忆候选**：`MemoryRepository.list` 增加 `shareable` 谓词，DuckDB/pgvector 查询内完成
  资格过滤，不再用访问时间窗口当候选全集。
- **#13 控制岛**：只有面板打开后的 outside 采样才自动收起（3 秒宽限）；补锚点与 jsdom 回归。
- **#14 工作区根**：`setWorkspaceRoot` 描述与 Agent Role 明确「根由用户设定，不得自行改回」。
- **#15 环境基线**：登记为设计选择（首次启动总是允许，首次成功运行记录基线）。
- **#16 记忆连接恢复**：查询失败后统一重开 DuckDB 连接，下一次操作自动恢复。
- **#17 会话契约**：`createSession` 拒绝非字符串 characterId；长目标损坏 scope 有专门原因。
- **#19 技能页**：批准禁用时给出「先读源码」说明；目录提交显示已提交/失败原因。
- **验证**：core-agent 302、stage-ui 定向 node 243 / browser 38、stage-tamagotchi node 148
  （1 skipped）、InteractiveArea 17、pgvector 6（4 skipped）；7 包 typecheck 与根 lint 通过。
  真机复验待用户重建；记录见
  `docs/fork/evidence/short-scenarios/ACC-20260907-01/FIX-LIST-20260911-results.md`。

## UI-SURFACE 批次（2026-09-11）：跨会话计划卡堆积、计划中心、窗口能力、输入位状态

- **动机**：`docs/fork/UI-SURFACE-PLAN.md` 的 UI-2/UI-3/UI-4 与 UI-1 剩余部分；触发缺陷是聊天窗里
  已完成/已取消的长期目标卡跨会话堆积，正文与输入框被挤出视口。
- **归属分类**：新增 `planSurfaceLane` / `planSurfaceLanes`（stage-ui `stores/plans.ts`）：
  `current` / `other-session` / `unattributed` / `archived`；完成（含未验证）、失败、取消归
  `archived`，同一会话被更新计划取代的旧会话计划也归档。时间线只收 `current` + `unattributed`；
  `plan-lanes` 增加未归属分区。
- **计划中心（新）**：`plan-center.vue` 默认收起，`活动/待处理/待验证/历史` 计数（`待验证 N`
  保留完成未验证计划的琥珀色状态）；展开后按 `当前会话/其它会话/未归属/历史` 分区，复用计划卡；
  其它会话目标带来源跳转（会话已删时 toast），历史区保留完整证据与步骤展开。
- **agent-browser 验收**：真机走查发现同会话内 9 张被取代 pending 计划 + 9 张完成未验证计划
  仍堆在活动面；追加取代与归档口径并补 `plan.status.paused` 文案。截图见
  `docs/fork/evidence/short-scenarios/ACC-20260907-01/ui-acceptance-20260911/`。
- **会话检索**：`sessions-dialog` 增加 `sessions-search`，按标题/预览/sessionId/最近 100 条消息文本
  过滤；关闭时清空。
- **窗口能力**：`RendererWindowContext.capabilities.stage`（leader-only + full）；Live2D 无模型时
  返回可解释拒绝（打开主窗、加载模型、保持舞台路由），替换裸错误。
- **输入位状态**：无会话/无 provider 时禁用主输入框，显示原因；无 provider 提供 `electronOpenSettings`
  跳转 `#/settings/providers`；辅助区（问题卡/侧通道/计划中心）加 `max-h-[40%]` 预算。
- **i18n**：新增 `plan-center.*`、`sessions.search-*`、`no-provider`、`open-settings`、
  `plan.horizon.unattributed`；仅 en + zh-Hans；已重建 i18n dist。
- **验证**：stage-ui `plans.test.ts` 49、计划中心 browser 5、sessions dialog/drawer + history + btw
  browser 15、stage-ui-live2d expression-tools 6、stage-tamagotchi window-context 6、
  InteractiveArea browser 19、i18n 20；stage-ui node 全量 969、stage-ui-live2d 全量 68；
  相关包 typecheck 与根 lint 通过。stage-ui 全量 browser 里 sessions-dialog 超时、
  stage-tamagotchi node 的 symlink EPERM 与路径断言失败均已用 HEAD 复现，属 Windows/套件环境基线。
  真机复验待用户重建；
  记录见 `docs/fork/evidence/short-scenarios/ACC-20260907-01/UI-SURFACE-20260911.md`。

## 恢复副本 journal 缺陷修复 + 待重建项真机复验（2026-09-11 下午）

- **新缺陷（真机复现，同一恢复副本）**：新构建首次启动后 `runtime-journal` 仍停在
  `pendingCount: 1` / `lastError: journal sequence conflict at seq 0` / `complete: false`。
  replay 本身已经生效（内存 4,839 条、header 与磁盘一致），但队列里那条自造 header 永远写不进去，
  该会话后续事件只能留在内存。
- **根因**：`packages/stage-ui/src/stores/journal.ts` 的 `hydrate()` 先 `ensureSession()`，
  而 `ensureSession` 对新会话会立刻把一个 `session/header`(seq 0, `createdAt = Date.now()`)
  排进持久化队列；恢复副本文件里 seq 0 是另一份 header，宿主按 `seq + 指纹` 去重
  (`journal-host/index.ts`) 于是每次都拒绝，重试永不成功。离线回归没抓到，是因为假 port 不去重。
- **修复**：`hydrate` 改为「先 `read` 再建 store」——文件为空才 `ensureSession`（自造 header 归本进程）；
  读等待前后都用 `hasLiveEvents()` 保护已 append 的 live 历史；文件有内容则用文件内容 seed，
  并 `dropQueuedHeader()` 丢掉先前排队的自造 header（此时队列只可能是 header），队列清空时同时
  清掉 `lastPersistError`。回归：`stores/journal.test.ts`
  「does not wedge a replayed session behind a header queued before the read」——假 port 按宿主
  规则做 `seq → 指纹` 去重，修复前失败（`pendingCount: 2`），修复后通过。
- **真机复验（重建后，恢复副本 `restore-J2TLrx`，账号 A）**：
  #18 启动即 `complete: true`、无冲突错误；同一 journal 文件从 4,839 行 / seq 0..4838
  续写到 4,841 行 / seq 0..4840（新增事件落在 4839/4840），跨一次崩溃重启后再 replay 到 4,997 条
  仍 `complete: true`。
- **#9（L04 恢复边界）**：真机新建长期目标 → 前台 `sleep 90` 中断（强杀）→ 重启，journal 写入
  `flow/resumed`(seq 4855, `resumedFromSeq` 4854)，恢复后继续执行至 `flow/end done`(4971)；
  **普通追问**（`user/message`，非 steering）回答把写入与读回核验归到「恢复后」，
  不再把恢复后动作当作中断前证据。`snapshotSession(active)` 返回该 `flow/resumed`，
  构建产物的 `chat-*.js` 含 `Recovery Boundary` 段代码。
- **#13**：主窗点「展开」2.5 秒后设置入口仍可见，点它打开设置窗（follower）。
- **#19**：技能页目录提交 → 队列 `0/5 → 1/5` +「已提交/等待审阅」；未读源码时「批准」禁用并显示
  「请先查看源码与自测…」；读完后按钮解禁。
- **UI-2**：聊天窗出现 `chat-plan-center`（活动/待处理/待验证/历史），展开后 `当前会话/其它会话/历史`
  分区齐全；辅助区 `max-height: 40%`，展开后实测 35.9%。
- **K07**：两个窗口各自 `setTimeout` 到同一绝对时刻点击「批准」（相差 211 ms），journal 只产生
  一条 `review/decided`(seq 4840)，待审归零，两窗收敛。
- **#12**：真机 `listShareableFacts` 在当前角色 scope 返回 3 条旧 fact（`656b0f6f`/`4c211389`/
  `17edcfbe`，approved+active，均 `lastAccessedAt: never`，含一条 `flow` 来源）；「不被最近 20 条
  窗口挡住」由 `local-memory.test.ts` 的 SQL 谓词断言与 `memory.test.ts` 的 `shareable: true` 断言覆盖
  （本副本只有 10 条 long_term，无法用排序差异反证）。
- **仍未真机复验**：#11（需未认证恢复副本；offline 由 `step-welcome.browser.test.ts` 采纳用例覆盖）、
  #14（需过期工作区根 + 一次模型轮次；offline 由 `coding.test.ts` / `chat.contract.test.ts` 文案断言覆盖）。
- 记录见 `docs/fork/evidence/short-scenarios/ACC-20260907-01/FIXLIST-9-20-live-20260911.md`。
