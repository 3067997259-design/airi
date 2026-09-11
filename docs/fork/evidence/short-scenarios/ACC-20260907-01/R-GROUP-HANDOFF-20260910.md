# R 组交接件：三条待修问题（2026-09-10）

供外部模型定位。每条都给出可复现步骤、磁盘证据与怀疑点。

## 环境

- 源 profile P：`C:\Users\86130\AppData\Roaming\@proj-airi\stage-tamagotchi`
- 恢复副本 P''：`…\stage-tamagotchi\restores\restore-7IF4GT`（2026-09-10 13:10 创建）
- 归档：`C:\Users\86130\Downloads\airi-backup-2026-09-09T17_53_15.331Z.zip`（14,280,283 字节，149 条目，`credentials: excluded`，`outbox: held`）
- 构建：`out/` 2026-09-10（含 R1–R5 调度修复）
- 契约（用户确认）：恢复后**要求重新登录**；未登录显示明确原因；不自动改 owner；本地 remap 暂不实施

## 问题 1（最重）：R04 — adoption 后目标不进入调度，「立即运行」无效

### 复现

1. 在 P 里 `Backup ZIP` 导出（原生保存框，人工点击）；
2. 在 P 的「设置 → 数据」页点 `Restore ZIP` 并选择归档。**注意：点击按钮不弹对话框**——它绑定隐藏的 `input[type=file] accept="application/zip,.zip"`，需要直接给该 input 赋值（可用 CDP `upload 'input[accept*=zip]' <path>`）。赋值后产品会自动重启进 P''；
3. 在 P'' 完成正常登录（数据可见性见问题 3）；
4. 在 P'' 重新配置 provider；
5. 点击 `使用恢复的 profile`（adoption）；
6. 在任意目标卡上点 `立即运行`。

### 现象与证据

| 检查点 | 实际 |
| --- | --- |
| adoption 释放 hold | ✅ `restore-state.json` → `"effectsHeld": false` |
| 调度器持久状态 | ❌ P'' 的 `long-goals.json` = `{"schedules": []}` —— 恢复的目标一个都没排程 |
| 等待到期自动跑 | ❌ 无任何 `goal/update` / `flow/start` |
| `立即运行`（两张卡各点一次） | ❌ P'' 全部 journal 的**最新写入仍是 13:10:11**（恢复时刻），之后零事件 |
| 有界 Flow 次数 | 0 |

目标卡状态：lifecycle 显示「需要输入」，等待原因 `Flow ended with interrupted.`，`nextReviewAt` 是 **2026-09-09 23:47 / 23:48**（已过期）。

### 怀疑点

1. adoption 后是否真的在 leader renderer 注册了 wake consumer？注册点是否只覆盖「目标创建 / 生命周期转换」，而漏掉「恢复后已存在的目标」？
2. `schedules` 为空：恢复的 `PlanState.longGoal.nextReviewAt` 有没有被重新排程？还是恢复流程刻意不排程、等第一次用户触发？
3. `立即运行` 的点击链路是否因为恢复副本缺上下文（owner/session 绑定、coding host root）而**静默返回**？按钮可点、无反馈、无日志，这本身就是可观测性缺口。
4. 目标 lifecycle 是 `waiting-user`，而 `handleWake` 会对非 `executable`/`waiting-condition` 的目标 `unschedule`——`立即运行` 是不是先被这条规则挡掉？

### 关闭条件

adoption 后**不重启**：目标启动**恰好一次**有界 Flow；多窗口状态一致、无重复调度；若必须重启才工作，首次结果记 FAIL。

## 问题 2：R05 — 恢复技能不可调用，但原因不可见 + 静默回退到 MCP 元工具

### 现象（journal 事件链）

在 P'' 会话里发送：`请实际调用 acc_20260909_dedupe 处理 ["r"," r ","s"]，只报告工具返回。`

| seq | 事件 |
| --- | --- |
| 4842 | `user/message` |
| 4843 | `memory/retrieved` |
| 4844 | `prompt/supplement-changed` |
| **4845** | **`tool/call builtIn_mcpListTools {}`** |
| **4846** | **`tool/result builtIn_mcpListTools -> []`** |
| 4850 | `assistant/done`：答「工具列表中不存在 acc_20260909_dedupe，当前无法实际调用它。」 |

### 缺口 A：阻断原因没有传达给模型

技能被正确排除在工具面之外（`artifactError = "Artifact verification is pending."`），但模型只看到「名字不在工具列表里」，因此只能说「无法调用」。它不知道原因是「待重新验证」，也不知道要走复核流程。

**期望**：把阻断理由作为可见信息传达（工具集说明节 / system supplement / 工具返回），不要让模型靠「名字不在列表里」推断。

### 缺口 B：静默回退到已废弃的 MCP 代理元工具

模型为查找一个**自造技能**而调用了 `builtIn_mcpListTools` —— 正是 fork 立项时 M1 要消灭的 MCP 代理元工具路径（`packages/stage-ui/src/tools/mcp.ts` 的扁平化改造）。它返回 `[]`，既没帮助也没报错。

可疑点：
1. `tool-resolver` 只在「存在 `mcp_*` 运行时工具」时抑制默认元工具；**没有 MCP 服务器时元工具仍然暴露**，模型把它当成通用「找工具」入口。
2. 该元工具的语义是 **MCP 服务器工具**，与**自造技能**不是同一个面；用它查技能从接口上就是错的。
3. 与缺口 A 叠加：查不到 → 无原因 → 只能报告「不存在」。整条链路对用户是**静默失败**。

**历史对应**：用户指出这正是 fork 立项时修复过的 MCP 调用异常域（M1/M2：`mcp_<server>_<tool>` 扁平化、抑制默认元工具、降级可见化）。本次复现的是同一域里**未覆盖的分支**：无 MCP 服务器时的元工具暴露 + 自造技能查找失败时的静默回退。

### 已确认正确的部分

| 字段 | 值 |
| --- | --- |
| `trust` | `reviewed` |
| `reviewedHash` | `9103be732a70d335` |
| `workspaceRoot` | `D:/airi`（原工作区） |
| **`artifactError`** | **`Artifact verification is pending.`** |

P'' 的 coding root 是 `…\restores\restore-7IF4GT\workspace`，与原工作区不同，`verifySource` 的 workspace 比对应当拒绝——「未复核不执行」这一层是对的；问题在**原因不可见**与**回退路径错误**。

## 问题 3：R03 — 未登录时无明确原因

P'' 首次启动显示的是**全新安装 onboarding**：

> 「欢迎来到 AIRI！让我们设置您的第一个服务来源来开始使用。」+ `登录` / `配置您自己的 AI 服务来源`

契约要求显示「已恢复原 owner 数据，需登录后才能查看」这类**明确原因**。现在的呈现把恢复副本当成一台全新机器。

**建议修**：恢复回执为 `complete` 且存在未认证 owner 时，首屏改为「数据已恢复，请登录 `<owner>` 以查看」并提供登录入口。

登录后数据身份是正确的（见下），所以这只是**首屏文案与入口**的问题。

## 已确认正确的部分（无需修）

| 检查点 | 证据 |
| --- | --- |
| 归档契约 | `credentials: excluded`、`outbox: held`、149 条目、覆盖 7 域 |
| 恢复回执 | `state: complete`、snapshotId 与归档 manifest 一致、`effectsHeld: true` |
| 自动重启进副本 | renderer 命令行 `--user-data-dir=…\restores\restore-7IF4GT` |
| 冻结期无社交活动 | 副本 `life-mode.json` 为 `mode: "off"` |
| 登录后数据身份 | 角色 `n8cz_qXFxNLwpJmuAsfIl`；会话抽屉 111 条；会话计划列出原 owner 的 L07d/FIX1 目标卡；135 个 journal 文件 |
| 技能审阅哈希 | `reviewedHash` 保留，且标记 `Artifact verification is pending.` |

## R 组当前状态

| 场景 | 状态 |
| --- | --- |
| R01 | PASS |
| R02 | PASS |
| R03 | PASS（数据身份）；未登录文案 = 问题 3 |
| R04 | **FAIL** = 问题 1 |
| R05 | 部分完成（技能验证状态 PASS；运行时调用 = 问题 2；embedding 切换与凭据缺失变体未做） |
| R06 | PARTIAL（断线可见、队列保留、重连清空；`update` 先于 `insert` 静默丢数据未修） |
| R07 | PASS |

## 运行手册要点（复现时用）

1. `Restore ZIP` 点按钮**不弹对话框**，要直接给隐藏 input 赋值；`Backup ZIP` 反而会弹原生保存框。
2. 判断当前跑在哪个 profile，要看 **renderer** 的 `--user-data-dir`（主进程命令行不带该参数）。
3. `agent-browser` 会因 stdout 接管道而无限挂死（上游 #1308 / #1713）；用文件重定向 + 硬超时包装，例如 `Start-Process -RedirectStandardOutput <file>` + `WaitForExit(超时)` 超时即 `Kill()`，再读文件。

---

# 给修复方的定位指引

## 先读什么

1. 本文件（三条问题的现象、证据、怀疑点）。
2. `docs/fork/MODS.md` 的 M1 / M2 / M2.5 三节——问题 2 的缺口 B 属于那个域的未覆盖分支。
3. `docs/fork/evidence/short-scenarios/ACC-20260907-01/` 下的 `R02-R03-retest-20260910.md`、`R04-retest-fail-20260910.md`、`R05-retest-partial-20260910.md`。

## 问题 1（R04 不调度）——建议的排查顺序

1. **先确认 wake consumer 是否注册**：adoption 路径（`packages/stage-ui/src/services/data-restore.ts`、`packages/stage-ui/src/stores/modules/long-goals.ts` 的初始化、`apps/stage-tamagotchi/src/main/services/airi/long-goal-scheduler/index.ts`）里，注册是否只在「目标创建 / lifecycle 转换」时发生，而没有覆盖「恢复后已存在的目标」。
2. **再看 `schedules` 为什么空**：主进程持久化的 `long-goals.json` 与渲染端 `PlanState.longGoal.nextReviewAt` 谁负责写入。恢复流程是否**刻意**不排程（若是，这属于设计缺口，需要在 adoption 后补一次「按 nextReviewAt 重新排程」）。
3. **然后查「立即运行」的静默返回**：按钮 handler → `handleWake` 的入口。注意 `handleWake` 会对非 `executable`/`waiting-condition` 的目标 `unschedule`，而恢复目标当前是 `waiting-user`／卡片显示「需要输入」——先确认这条规则是否把点击直接挡掉。无论结论如何，**按钮可点但无反馈、无日志本身就是缺陷**，请补可见结果（toast / waiting reason / journal 事件）。
4. **加回归**：恢复 → adoption → 不重启 → 目标启动**恰好一次**有界 Flow；重复点击不产生第二次。

## 问题 2（R05 原因不可见 + MCP 元工具回退）——建议的排查顺序

1. **缺口 A（原因不可见）**：看技能被排除的位置（`packages/stage-ui/src/stores/skills.ts` 的 `activeEntries` 以 `artifactError` 过滤）与提示词组装（M2.5 的 `## Toolset` 节）。当前被过滤掉之后**没有任何面向模型的说明**。请在工具集说明里明确写出「哪些已审技能因待复核/工作区不符而不可用，以及如何恢复」。
2. **缺口 B（元工具暴露）**：`packages/stage-ui/src/stores/ai/chat-llm/tool-resolver.ts` 现在只在「存在 `mcp_*` 运行时工具」时抑制 `builtIn_mcpListTools` / `builtIn_mcpCallTool`。**没有 MCP 服务器时它仍然暴露**，模型就把它当通用「找工具」入口。请判断：无 MCP 服务器时是否应完全不注入这两个元工具（它们对自造技能毫无意义）。
3. **对齐语义**：`builtIn_mcpListTools` 只列 MCP 服务器工具；自造技能的可见性应来自技能面（toolset 节 + 技能上拉栏），不要靠模型去「列工具」猜。
4. **加回归**：① 已审技能因 `artifactError` 不可用时，模型收到明确的不可用原因；② 无 MCP 服务器时工具面不出现 `builtIn_mcp*`。

## 问题 3（R03 首屏）——建议的修法

恢复回执为 `complete` 且存在未认证 owner 时，首屏不要走全新安装 onboarding，而是显示「数据已恢复，请登录 `<owner>` 以查看」+ 登录入口。判定：未登录时能读到**明确原因**；登录后原 owner 数据可见（这部分当前已正确）。

## 验证与交付要求

1. **先复现再修**：仓库规定（`.agents/skills/enforce-rules-for-vitest`）要求在改生产代码前先加失败测试。
2. **不要为测试新增导出或依赖袋**；测试走稳定公共行为。
3. **i18n**：只改英文源与中文（Crowdin 规则）。
4. **改完告诉用户，由用户重建**：`pnpm -F @proj-airi/stage-tamagotchi build` 后需要重启应用；**不要自行重建/重启用户的运行实例**（会打断用户正在用的窗口）。
5. **验收口径**：修好后由用户重跑三条复现路径，按本文件的「关闭条件」判定；证据写进 `docs/fork/evidence/short-scenarios/ACC-20260907-01/`。
