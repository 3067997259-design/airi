# ACC-20260907-01 测试结果汇总（截至 2026-09-11 凌晨）

本文件把 62 个短场景的当前状态、本轮（09-10 → 09-11）新跑通的项、未关闭项与待修清单汇总到一处。
逐条证据见同目录下的各记录文件；原始登记 [run-register.md](./run-register.md) 与
[状态对齐表](./status-alignment-20260909.md) 不改写。

运行端：`mods` 分支本地构建 `@proj-airi/stage-tamagotchi`（`out/` 2026-09-10 深夜 rebuild + 09-11 凌晨两次
增量验证），CDP `9250`，默认 profile；恢复相关用例在 `restores\restore-7IF4GT`（P''）与
`restores\restore-J2TLrx` 两个副本上执行。

---

## 一、总体状态

| 分组 | 已通过 | 未关闭 |
| --- | --- | --- |
| B（构建/冒烟） | B01 B02 | — |
| D（桌面交互） | D01–D08 | — |
| M（记忆） | M01–M08（含 M08 第二账户隔离与回切复核） | — |
| L（长时/目标） | L01 L02 L03 L05 L06 L07 | L04：Flow 轮次正确，**普通追问仍误归因**（待修 #9） |
| S（社交门控） | S01–S07 S09–S20（含 S03/S09/S13/S16/S17/S18 本轮转通过） | S08（缺插件 `task:start`） |
| V（视觉） | V01 V02 V03 | — |
| K（自造工具） | K01–K06；K07 主体通过 | K07「两窗口并发点击」竞态未造出（待修 #19） |
| R（恢复/同步） | R01 R02 R03 R04 R05 R07 | R06 完整次序与 tombstone（需后端） |

历史计数（09-09 登记）：22 PASS / 18 FAIL / 22 BLOCKED。此后 FAIL 与 BLOCKED 大都被逐条复跑并
关闭或转成明确缺陷，原始计数不改，以本文件与 [状态对齐表](./status-alignment-20260909.md) 的追加段为准。

---

## 二、本轮（09-10 → 09-11）新跑通

| 项 | 结果 | 关键证据 |
| --- | --- | --- |
| **R03** 恢复首屏 | PASS | 首屏「数据已恢复 / 来自 `<owner>` 的数据已恢复到本设备。请登录 `<owner>` 以查看。」+ 登录按钮；全新安装入口消失 |
| **R04** adoption 后排程 | PASS | adoption 不重启后 `long-goals.json` 从 `{"schedules":[]}` 变 2 条；00:30:08 与 00:31:38 两个目标各跑**恰好一次**有界 Flow 并 `done` |
| **R05** 技能原因可见 + 元工具 | PASS | `## Toolset` 出现「Unavailable reviewed skills」；运行时回答从「工具列表中不存在」变为「当前无法调用。原因：该技能属于不同的工作区…」；工具面 33 个无 `mcp` 名字，整轮零 `tool/call` |
| **R01** 写入进行中导出 | PASS（变体） | embedding 迁移 `running` 期间导出两份归档，manifest **154/154 逐条哈希一致**，无半截文件 |
| **R07** 导入中途终止 | PASS（变体） | 赋归档后 700 ms 强杀：无残留副本、无半截归档，重启后会话/计划/记忆库完整 |
| **S03** 安静时段 | PASS（含偏差） | 间隔 1 分钟 + 静默窗口 14–15，`nextHeartbeatAt` 被推到 15:00:00；4.5 分钟零心跳零决策 |
| **S10** 无活动会话 | PASS | 空 profile + 自主模式 → `life/heartbeat gate=no-session`，UI 显示「没有活动会话」，预算 0/24 |
| **S16** 有效已审记忆成候选 | PASS | `life/decision action=note`，`refs` 含 `memory:d5e701eb…`，文本自然非倾倒 |
| **S17** 纠正后用有效事实 | PASS | 修正并批准后 `sourceRefs` **只含**纠正后的有效 fact，发言用新名并作废旧名 |
| **S18** 陈旧活动 | PASS（含偏差） | 20 小时前的完成类事件未被当作「刚刚发生」；带时间戳的陈旧候选走 `stale-stimulus` 零模型调用 |
| **L07** 双窗口竞争 | PASS | 两窗口间隔 0.43 秒发同一条修订 → journal 记录两条 `user/steering`，单条 Flow 收敛，**旧目标零写入** |
| **L05** 恢复后输入缺失 | PASS（变体 C） | 随机 token + 「不要猜测」：`flow/end reason=blocked`，目录 0 文件，无伪造 |
| **FIX1 / REV** 完成门 | PASS | 车道化修复后两次复验 `verdict=pass`、`flow/end done`、目标走到 completed |
| **K04** 技能输入契约 | PASS | `["a",3,null]` 被拒（`input.items[1] must be a string`），`[" a ","b","a",""]` → `["a","b"]` |
| **M07** 全新会话首问 | PASS | 新会话 `seq=5` 命中 `17edcfbe…`（score 1.1528），零工具调用，哈希与真实文件一致 |
| **V01/V02** 视觉 | PASS | 形状/颜色/文字全对；重启持久化、陈旧帧探针、导出 ZIP 契约（149 条目、凭据排除、0 图片） |
| **S13** 真实 30 分钟窗口 | PASS | 同值第 2 跳被去重（`refs` 只含 angry），第 3 跳在窗口过期后重新可用（`refs=appearance:57,appearance:54`） |
| **S09** speech-active 门 | PASS | 官方语音在第二账户下可用；播放中（`nowSpeaking=true`、`sending=false`）触发心跳 → `life/heartbeat gate=speech-active`，之后无任何 `turn/start` |
| **M08** 第二账户隔离 | PASS | 换账户后 A 的记忆在候选/检索/按 scope 查询/会话索引四条路径都不可见；库内 79 行（A 68）原样不变；B 的 dreaming 不触碰 A |

---

## 三、未关闭项与原因

| 项 | 状态 | 原因 / 下一步 |
| --- | --- | --- |
| S13 真实 30 分钟窗口 | PASS | 三跳：消费 → 30 分钟内同值被去重 → 窗口过期后同值重新可用（未改时钟） |
| S08 focused 门 | BLOCKED | 需要 server channel 插件发 `task:start`；仓库内无发布方，UI 不产生 active 任务 |
| K07 两窗口竞态 | 部分 | 跨窗口批准已验；制造竞态所需的 probation 条目被两个**静默按钮**挡住（待修 #19） |
| L04 恢复叙述 | 部分 | Flow 轮次正确；普通追问仍把恢复后的失败说成「中断前」（待修 #9） |
| L02 第二模型变体 | 部分 | 第二个模型可用；但环境变化门没触发到（目标从未拿到 Flow 槽 → 无 `lastEnvironment`，待修 #15）；模型自行把根改回（待修 #14） |
| M08 第二账户 | **PASS（完整）** | 切换后四条可见性路径隔离、A 的库内数据未动；**回切 A 后逐项与基线一致**（121 会话 / 79 片段 A 68 / 3 shareable / scopedA 59） |
| R06 完整次序/tombstone | BLOCKED | 需要后端 + `update` 先于 `insert` 的修复（已修，待后端联测） |

---

## 四、待修清单（20 条，详见 [FIX-LIST-20260910.md](./FIX-LIST-20260910.md)）

**已修并复验**：1 技能 Schema 契约、2 恢复后旧写入授权、3 R06 `update` 先于 `insert`、4 L04 恢复边界（Flow 轮次）、
5 grep 构建版降级、6 渲染端门回写主进程、7 活动候选年龄、8 记忆 `list` 参数（登记为非缺陷）、
9 FIX1 车道化、10 心流指示器。

**仍待处理**（编号沿用清单）：

| # | 问题 | 严重度 |
| --- | --- | --- |
| 9 | 恢复边界只进 Flow 轮次，普通追问仍误归因 | 中 |
| 10 | 「干活时问一句」面板占据聊天页大半（**且会静默错投输入**） | 中 |
| 11 | 未登录恢复副本：发言静默弹回 + 恢复说明消失 | 中 |
| 12 | 记忆社交候选只看「最近访问的前 20 条」 | 中 |
| 13 | 重建后控制岛「展开」拉不出设置入口（疑似回归） | 中 |
| 14 | 模型可自行把工作区根改回 | 中 |
| 15 | 从未启动的长期目标没有环境基线 | 低 |
| 16 | 记忆库连接被卡死过一次（重启恢复，不可复现） | 中 |
| 17 | `createSession` 不校验 characterId | 低 |
| 18 | **恢复副本里 journal 既不 replay 也不落盘** | **高** |
| 19 | 技能页「批准」「提交审阅」是静默空操作 | 中 |
| 20 | btw 侧通道静默错投主输入（补强 #10） | 中 |

---

## 五、方法与运行环境（复跑时照抄）

- **构建**：`pnpm -F @proj-airi/stage-tamagotchi build`；`stage-ui` 的 exports 指向源码无需构建，
  `core-agent`/`i18n` 走 dist，改了要另建。改完必须重启应用才生效。
- **切 profile**：`APP_USER_DATA_PATH=<dir>` 启动；应用跳进恢复副本时会自己写这个变量并 `app.relaunch()`，
  新进程继承它——回默认 profile 必须显式清掉。判断当前跑在哪个 profile 看 **renderer** 的 `--user-data-dir`。
- **驱动方式**：CDP `9250` + `agent-browser`（须用文件重定向 + 硬超时包装，stdout 接管道会挂死，上游 #1308/#1713）。
  设置页可以直接给主窗口/设置窗口改 hash 打开；控制岛的「展开 → 设置」在本轮构建里点不开（待修 #13），
  由用户手动打开一次即可。
- **发消息**：`#/chat` 里可能同时存在两个 `textarea`（btw 侧通道在前、主输入框在后）。
  必须按占位符定位主输入框（「说点什么...」），否则输入会被侧通道吃掉（待修 #10/#20）。
- **心跳**：设置页「测试心跳」与 store action `requestTestHeartbeat()` 等价；手动心跳跳过静默时段/预算/冷却，
  但仍受渲染端门（busy/focused/flow-active/no-session/stale-stimulus 等）限制。
- **导出**：`Backup ZIP` 会弹原生保存框（人工确认），`Restore ZIP` 不弹、需直接给隐藏 `input[accept*=zip]` 赋值。
- **已知坑**：杀掉 Electron 后立刻重启可能静默绑不上 CDP 9250（等 5–8 秒并用 `/json/version` 复核）；
  `sleep 240` 这类单步长等待会撞 bash 单步超时（Flow 自己会分段补足）。

---

## 六、证据索引（本轮新增）

| 文件 | 内容 |
| --- | --- |
| `FIX-LIST-20260910.md` | 待修清单（20 条）与状态 |
| `FIX-LIST-20260910-results.md` / `FIX-LIST-20260910-retest.md` | 修复方记录与其真机复验（6 条） |
| `R-GROUP-FIX-20260910.md` | R03/R04/R05 修复与复验 |
| `R05-variants-20260910.md` | R05 的 embedding 切换与凭据缺失两个变体 |
| `R01-export-during-write-20260910.md` | R01 写入进行中导出 |
| `R04-adoption-and-flow-20260910.md` | R04 恰好一次有界 Flow + journal 不落盘证据 |
| `R07-abort-mid-import-20260910.md` | R07 导入中途终止 + 记忆候选窗口发现 |
| `S03-S18-recovery-20260910.md` | S03/S10/S16/S17/S18 复跑 |
| `L07-K07-L02-20260910.md` | L07 双窗口竞争、K07 部分、L02 第二模型变体 |
| `TEST-SUMMARY-20260911.md` | 本文件 |
