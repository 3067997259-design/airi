# CAPABILITY-PLAN：能力扩展（新工具 + 极简 UI + 插件兼容 + 自造工具闭环）

**日期**：2026-08-29。定位：补齐她作为 agent 的工具能力、极简操作 UI、插件兼容通道，以及**自造工具闭环**缺的齿。
与 `MAINTENANCE-PLAN.md`（接线断层）、`LIFE-PLAN.md`（自主节拍）并列，三个都指向后续实施。
本文件只记录经核实的现有资产与建议顺序，**不含实现代码**。

## 一、定位

现状盘点（全部经本轮核实）：

- **web_search**：官方已完整实现（`packages/stage-ui/src/tools/web-search.ts`，Tavily 打通，带测试），且已在聊天链路自动注册——配置了 API key 就会进入 toolset，还带现成 toolset prompt（"优先用已知知识，需最新事实时实际调用、引用 URL"）。**零工作，仅验收。**
- **新工具缺失**：fetch/网页阅读、goal/babysitting（后台推进任务）。
- **UI 缺失**：审批模式三档按键、@ 文件引用、skill 上拉栏。
- **插件兼容**：`plugin-sdk-tamagotchi` 的 `registerTools({ tool, toolsetPrompt })` 本就是 dsh 纯内容插件的对应物（chess / homeassistant / bilibili 插件是活例）。
- **自造工具闭环约 70%**：skill-forge 契约 / 证据血缘 / 审阅界面 / PTC 沙箱 / 四工具都在，缺提交、自测、通知三齿。

## 二、新工具

### web_search — 已完成，仅验收
聊天里让她搜索并引用来源。若她不调，再查注入链。

### fetch / 网页阅读
- 需求：fetch URL → 转 markdown → 大小上限 → 标注来源注入。
- **SSRF 防护必须**：拒绝内网 / 环回地址（Mimosa 扫描约束已强调）。外部内容 = 数据原则（DESIGN-PRINCIPLES §四），抓取内容标注来源，不当作指令。

### goal / babysitting
- plan 系统大半已在（plan_update + 证据门 + 任务泳道）。缺的是**后台 babysitter**：定时唤醒她、推进计划下一步、超时上报。
- **与 LIFE-PLAN 的 M3 tick 合流**：同一个心跳两面——对内推进任务、对外开口分享。
- **（2026-08-30 核查：未实现。）** 现状 = 计划只能在她人在场时沿对话推进（chat store `getActivePlanStep` 把当前步 + allowedTools 喂给编排器）；心跳考量回合只挂 `self_speak`/`self_note`，不能执行计划工具——"对内推进"这一面缺失。
- plan 文件化（workspace 开 `plans/` 文件夹）：**缓做**。journal + devtools 控制台已能查计划，文件化边际价值不高，待真实使用确需"翻旧计划"再做。

## 三、极简 UI 按键组

同意不大改 UI，加必要按键。

### 审批模式三档（需要审核 / 代替审核 / 完全控制）
- 机制已支持：`coding-host` policy 有 `mediumBashApprovalRequired` 选项、高危必卡。
- 工作：把该旋钮暴露成设置 + 输入区按钮（三档切换）。**小工程。**

### @ 文件引用
- 依赖 workspace host 加一个 `listDir` 枚举 + 输入区选择器。**工程中。**

### skill 上拉栏
- 依赖自造闭环 + skill 目录成型。**后置。**
- **（2026-08-30 完成。）** 见 MODS.md"Codex 风 skill 上拉栏"：`/name` 唤起 → 过滤 → 回填 → 发送时 `prepareForPrompt` 按名称激活。

## 四、插件兼容

### 现状
`plugin-sdk-tamagotchi` 提供 `registerTools({ tool, toolsetPrompt })`——插件可注册 xsai 兼容工具 + 注入工具集提示词，零 UI 改动。活例：`airi-plugin-game-chess`（游戏工具）、`homeassistant`、`bilibili`。

### 三条通道
1. **skill 导入器**：纯文本 skill → skill-forge 契约（draft→probation→reviewed）+ toolset prompt 注入。**容易。**
2. **dsh 内容类插件适配器**：dsh bundle 的 `dsh.bundle.patch` / `dsh.client.inject` 元数据 → `registerTools` 映射。**中等。**
   **（2026-08-30 拍板：放弃。）** dsh 插件与 AIRI 架构不同源、外部改动五花八门，适配性价比低；兼容面收敛为 AIRI 自有技能格式（与 skill_submit 产物天然一致），外部作者按我们的格式发布，而不是适配别人的运行时。
3. **UI/外观类插件**：跳过并在导入时报告。**不碰。**

### 安全红线（必须）
- dsh 生态规模已产业化：GitHub topic 页、awesome 列表、社区市场（deepseekplugins.com 等）、官方"14 个零配置工具插件"合集，总计 11000+ 插件（来自 `awesome-deepseek-harness-plugins` 等目录）。
- **11000 个来路不明插件撞上威胁模型——"外部内容是数据，不是指令"。dsh 插件导入绝不能直通。**
- 必须走 skill-forge 管道：导入即 probation、绑定内容哈希、审阅后激活。**这正是自造工具闭环的同一扇门**——外部作者 = probation 桶。
- **待拍板**：从 awesome 列表选 2-3 个工具类样本插件做解剖（GitHub 直连受限，需代理）。

## 五、自造工具闭环缺齿（现状约 70%）

### 已在手
skill-forge（哈希绑定审阅、draft→probation→reviewed 生命周期、静态分析）、证据血缘（未审阅自造工具产出默认不可信）、`skills.vue` 审阅界面（reviewed 才进动态 LLM 工具表）、PTC 沙箱、四工具（她写代码的手段）、`dreamRevisionBatch` 修订批处理。

### 缺的三齿
1. **`skill_submit` 工具**——闭环第一齿，最大断层。没有它她无法"提交一个技能"。功能：接收代码 + 元数据 → 落盘 `workspace/skills/` → 静态分析 → 沙箱自测 → 进 probation 等你审。
2. **沙箱自测接线**——skill-forge 消费共享沙箱做 draft 自测（`WIRING-BACKLOG.md` 明确推迟的那条）。"她证明自己的工具能用"靠这一步，否则审阅只看代码没有运行证据。
3. **审阅通知**——技能待审时走审批卡通道（bash 审批卡模式现成），否则你不知道有东西等着审。

### 毕业考
用 OPENCODE_ADAPTER_SKELETON 之外的一个真实小工具（如"剪贴板记忆"或"每日摘要"）完整走一遍：
她写 → 自测 → 你审 → 启用 → 她用出价值 → 固化。这一趟走通，"自增长能力"从架构变成事实。

## 六、建议顺序与依赖

```
fetch（含 SSRF 防护）
  → 审批模式三档（UI 小工程）
  → skill_submit（钥匙）
  → 沙箱自测接线
  → 审阅通知
  → dsh 适配器（需先做样本插解剂，待拍板）
  → 毕业考演练
```

- `web_search`：仅验收，不开发。
- `babysitter`：与 LIFE-PLAN 的 M3 tick 合流，归 LIFE-PLAN。
- `@文件引用 / skill 上拉栏`：后置，依赖上述成形。

## 七、验收策略

每期按仓库准则：定向 vitest（含 browser 模式）+ agent-browser 真机走查（沿用项目 `cdp-eval.cjs` 流程）。
- dsh 适配器需样本插件解剖先行（GitHub 直连受限，需确认代理后拍板样本）。
- `fetch` 重点：SSRF 拒绝内网/环回 + 标注来源 + 大小上限。
- `skill_submit`：probation 后不进动态工具表、审阅通过才激活、绑定内容哈希失效条件。
