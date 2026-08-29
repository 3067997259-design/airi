# 维护批次计划（MAINTENANCE PLAN）

**日期**：2026-08-29。定位：接手后的第一批维护工作清单。
与 `MODS.md`（魔改史）、`WIRING-BACKLOG.md`（M-D 批次接线清单）互补：
本文件收录**当前所有已确认的接线断层与止血项**，完成一项勾一项，
后续批次并入 `WIRING-BACKLOG.md` 的体例。

## 执行状态（2026-08-29 收官）

- ✅ **P0 全部完成**：0.1 固化（12 个分批 commit + gitignore）；0.2 上游
  更新检查默认关闭（`resolveAutoUpdaterEnabled` + `AIRI_ENABLE_UPSTREAM_UPDATES=1`
  逃生门）；0.3 定向测试 3/3（真机 dev 冒烟仍待做，步骤见下）；0.4 判定方法
  已记录（设置页看 `follower`/`error` 字样）。
- ✅ **P1 全部完成**：1.1 `memory-scope-nav` + 长期页 wiring-note Callout；
  1.2 MC `deliveryState`（idle/pending/sent）+ 上线自动重发 + 删旧 setup 块
  （修正：表单本就 localStorage 持久化，缺口是投递回执）；1.3
  `CODING_TOOL_META` 单一来源（`coding-harness/tools/coding-tool-meta.ts`
  无副作用子模块）。
- ✅ **P2.1 / P2.2 完成**：`plan_update` 工具 + orchestrator
  `getActivePlanStep` 白名单证据打标（无关工具结果满足不了验证门）；
  `code_mode` 工具（bridge 派发展平为有界文本，超时钳位 1-60s，宿主
  listTools 报告可用性）。P2.3 控制台、P2.4 pgvector 接线未动（见下）。
- ⬜ **仍开放**：P2.3 devtools coding 控制台；P2.4 pgvector 接线（挂载位置
  决策点仍待拍板，推荐主进程 memory-host 模式）；P3 全部；真机 dev 冒烟
  （plan-card 走查、code_mode 端到端、四工具冷启动三次）；Mimosa 完整审计
  （本批提交链 scanner_enobufs，兼容放行，未宣称安全）。
- 测试基线：core-agent 172、coding-harness 28（hashline+tools）、stage-ui
  plans 1、tamagotchi built-in 3 / plan 5 / coding 2 / policy 5，typecheck
  五包全过。

## 当前基线

- GPT 已完成四工具注册时序修复（`main/index.ts`：`codingHost` 进入
  `windows:main` 的 `dependsOn`，宿主挂载前置于主窗口；配套测试
  `built-in.test.ts` "registers coding tools when the coding host reports
  them as available"）。**未做真机/dev 冒烟验收**。
- 工作区约 133 个未提交文件（M-D+ / M-D+1 两批 + GPT 修复），全部
  未进 git 历史。
- 本机构建受存储限制，electron-builder 难以常规运行 → 本计划所有验收
  以「typecheck + 定向 vitest + dev 模式冒烟」为门禁，不依赖打包。

## 验证门禁（存储受限版）

1. 类型：`pnpm -F <pkg> typecheck`（相关包逐个跑；仓库级需
   `NODE_OPTIONS=--max-old-space-size=4096`）。
2. 单测：`pnpm exec vitest run <路径>` 定向跑；改 core-agent/i18n 源码后
   必须先 `pnpm run build:packages`（stage-ui 测试消费 dist）。
3. 冒烟：`pnpm dev:tamagotchi` 跑开发版（不需要 electron-builder）。
   channel-server 6121 端口 `ENOTSUP` 是已知非致命问题。
4. 打包仅在收尾批次做一次（配方见 MODS.md：npmmirror + electronDist
   + 小写 `https_proxy`）。

---

## P0 — 固化与止血（先做，防止丢工作和事故）

### 0.1 提交未提交批次

- **问题**：~133 文件未提交，一次误操作即丢失数天工作量。
- **做法**：按逻辑分批提交（建议切分：① 设计文档七份；② 三个新包
  `coding-harness` / `memory-core` / `skill-forge`；③ core-agent 四个新
  目录 + journal/authority/planning/attention；④ 桌面接线：coding-host
  服务 + bridges + built-in 注册 + GPT 时序修复；⑤ 设置页与聊天卡组件 +
  i18n；⑥ discord/telegram 集成改动；⑦ MODS.md/WIRING-BACKLOG.md）。
- **先加 `.gitignore`**：`云吞kumo/`、`云吞kumo.zip`（46MB 模型资产，
  不进 git，保留在磁盘）、`.pnpm-store/`、`.mimosa/`、
  `apps/stage-tamagotchi/src/renderer/.cache/`。
- **验收**：`git status` 干净；每批 commit 后 `git log` 对应 conventional
  commit。

### 0.2 禁用指向上游的自动更新

- **问题**：`auto-updater.ts` 硬编码 `api.github.com/repos/moeru-ai/airi`
  的 Releases 检查与下载直链。上游一旦发布高于 v0.12.0-beta.2 的版本，
  魔改安装会被自动升级覆盖（MODS.md「运行时注意事项」已预警）。
- **做法**：fork 构建默认关闭上游更新检查（编译期常量或
  `~build/git` 同源的构建标记；保留 UI 里「检查更新」的手动入口改为
  提示"此为本地魔改版，更新指向 upstream"）。
- **验收**：dev/打包版启动后不再请求 moeru-ai releases API；设置页更新
  区域显示魔改版提示。
- **量级**：小。

### 0.3 四工具时序修复验收（GPT 修复的收尾）

- **做法**：`pnpm dev:tamagotchi` → 设置→编码页四芯片应绿；打开 chat
  发一条消息，确认模型请求的 tools 含 read/write/edit/bash；杀掉重启
  再验一次（覆盖启动顺序抖动）。
- **遗留判断**：renderer 侧 `built-in.ts` 的 `catch { coding = [] }` 仍
  不区分瞬态/永久。主进程侧依赖排序已结构性消除主窗口路径的竞态；若
  验收中出现边缘窗口（settings 先于 codingHost）仍丢工具，再补
  ready-事件回推重刷（模式参照 mcp.vue 的 apply-and-restart）。
- **验收**：连续三次冷启动 chat 均见四工具声明。
- **量级**：验收为主，可能零代码。

### 0.4 短期记忆 DB 状态确认（诊断项）

- **问题**：记忆设置页报告「数据库无法初始化」，未知是 leader/follower
  单写者规则的正常显示（`memory.ts` `initialize()` 的 follower 分支）
  还是真 error（会带 databaseError 消息）。
- **做法**：在设置页看状态字样：`follower` = 正常（库在领导者窗口），
  到舞台窗口验证；`error` = 记下错误消息再排查（优先怀疑 OPFS
  sync-access-handle 冲突与 Electron WebView 环境）。
- **验收**：确认属于哪一类；若 error，另立排查项。

---

## P1 — 小接线（一行级到半天级，可与 P2 并行）

### 1.1 记忆设置入口补长期页导航

- **根因**：`settings/memory/index.vue` 重定向到短期页（有意），但
  `memory-long-term.vue` 全应用零链接，只能手输 URL。
- **做法**：短期页顶部加「短期 / 长期」切换（或 memory index 改双入口
  hub）；长期页在未配置 Postgres 时明示「长期层未接线」状态而非空白。
- **验收**：从侧边栏「记忆体」两跳内到达长期页。
- **量级**：小。

### 1.2 MC 设置页配置持久化 + 诚实状态 + 清理旧内容

- **根因**：`GamingMinecraft.vue` 的 `saveSettings()` 仅
  `ui:configure` WebSocket 发送（`configurator.ts`），无本地持久化、
  无回执；服务离线时配置蒸发。页面下半部旧 setup 指引（指向
  `integrations/minecraft/README.md` 手动起服务）与新表单语义矛盾。
- **做法**：① 配置落 localStorage（照 `gaming-module-factory.ts` 扩展
  或 memory store 的 `useLocalStorageManualReset` 模式）；② 保存后状态
  分「已保存，服务离线（待重发）」/「已保存并送达」——registry sync
  重发钩子已存在（`gaming-minecraft.ts:241`）；③ 删除或改写旧 setup
  指引块，保留 runtime context 查看器与 debug 流量（可观测性有价值）。
- **验收**：离线填表保存 → 重启设置仍在 → bot 上线后配置送达
  （真机 Bot 验证仍是前置，见 WIRING-BACKLOG §1 推迟项）。
- **量级**：小。

### 1.3 四工具双定义合并

- **根因**：`renderer/stores/tools/builtin/coding.ts`（zod JSON-schema
  风格）与 `packages/coding-harness/src/tools/coding-tools.ts`
  （CodeModeTool 位置参数风格）是同一组工具的两份平行定义，描述与
  参数已可漂移。
- **做法**：以 coding-harness 为单一来源——导出每工具的 name/
  description/参数元数据，renderer 侧据此生成 zod schema（或反向：
  schema 常量放 coding-harness，两处消费）。功能不变，纯收敛。
- **验收**：两处定义来自同一常量；既有测试全绿。
- **量级**：小。

---

## P2 — 功能接线（本批主菜，凑一桌）

### 2.1 `plan_update` LLM 工具（激活计划机器）

- **根因**：`plans.start(spec)` 生产零调用方；plan-runtime/证据门/
  turn-projection/plan-card 全部休眠（详见对话结论：引擎完整、方向盘
  没装）。
- **做法**：
  1. 新工具文件（照 `builtin/coding.ts` 体例）：`plan_update`，zod
     schema 描述 PlanSpec（goal + steps：intent/allowedTools/
     expectedEvidence/riskLevel/approvalRequired）；
  2. plan store 补 replan 动作（journal `lastReplanReason` 字段已预留）；
  3. `built-in.ts` 注册 + `codingToolReferences` 相邻位；Toolset prompt
     补「多步任务先建计划；完成以证据门为准，宣称不算数」；
  4. 测试：模型建计划 → journal 事件 → 投影状态 → plan-card 渲染。
- **安全边界**（已在设计文档成立）：模型写 spec 是提议；完成仍只认
  tool_result；高风险步骤走既有审批卡。
- **验收**：chat 里让模型做三步任务，plan-card 显示进度，步骤完成由
  工具证据驱动而非模型宣言。
- **量级**：中。

### 2.2 Code Mode 暴露为 LLM 工具

- **根因**：`runProgram`（PTC 沙箱 + bridge）只有设置页人工入口，模型
  用不上（CODING-HARNESS §3.2 的主要消费方缺席）。
- **做法**：新工具 `code_mode`（参数：program + timeoutMs 上限钳位），
  execute 走 `createCodingHostClient().runProgram`；返回值 = 程序返回值
  摘要 + bridge traces 摘数（有界）；journal 每次 bridge 派发记
  tool/call+result（宿主侧已记）。Toolset prompt 说明「多步重复操作写
  程序一次跑完，优于逐个工具调用」。
- **验收**：模型对「把这三个文件的标题改成大写」类任务选择 code_mode，
  trace 可见，结果正确；超时/parse 错误以结构化 failure 返回。
- **量级**：中（沙箱/限额都已存在，只是壳）。

### 2.3 devtools coding 控制台（维护视角）

- **根因**：coding 调试只能翻 chat 或设置页，journal 已有全部数据但无
  平铺视图。
- **做法**：`packages/stage-pages/src/pages/devtools/` 新增
  `coding-console`（照 `context-flow` 页体例）：journal 事件流过滤
  tool/call+result/approval/plan；按会话折叠；PTC bridge trace 展开视图。
  可附最小计划编辑器（手工构造 spec 验证门机器——测试台哲学同 Code
  Mode 的 TS 框）。
- **验收**：一轮带计划+审批的对话后，控制台能完整回放。
- **量级**：中。

### 2.4 长期记忆 pgvector 接线

- **根因**：`packages/memory-pgvector` 全仓库零消费者；长期记忆页空转。
- **决策点（需拍板）**：挂载位置 A = Electron 主进程新服务
  `memory-host`（照 coding-host 模式，Eventa 契约 + settings 页配置
  connectionString；推荐——不引入外部依赖，与桌面单机定位一致）；
  B = server-channel 让外部 service 持有（适合未来接 hosted backend，
  但当前多一层部署）。
- **做法（按 A）**：① `server/docker-compose.yaml` 的 `db` 服务
  （`127.0.0.1:5435`，tensorchord vchord-postgres，账号见 compose）起库；
  ② 主进程 memory-host：连接管理 + 健康检查 + DDL 迁移（review_status
  列已在 schema）；③ 记忆 store 增加双仓储路由：DuckDB 短期 staging +
  pgvector 长期（晋升写入走 `promotion.ts`）；④ 长期设置页接线
  connectionString 输入与状态显示。
- **验收**：起 Docker → 配连接串 → 长期页浏览器可检索；对话产生记忆 →
  晋升后落 Postgres；Docker 停止时优雅降级为仅短期层。
- **量级**：中偏大（本批最大项，可独立成第二批）。

---

## P3 — 质量收尾（可后置，多依赖真实使用数据）

- 3.1 全量 `pnpm lint` / `pnpm test:run` 清理（WIRING-BACKLOG §7 既有
  阻断：设计稿/模型资产格式、Windows 路径/symlink 测试）。
- 3.2 Hashline 签名宽度校准（WIRING-BACKLOG §7：20 文件基准，统计
  拒绝率/重读/碰撞）。
- 3.3 Attention §9.1 六条运行验收（dev 冒烟即可做，可并入 0.3 顺带）。
- 3.4 nomic 中文 embedding 实测 + 检索权重标定（依赖 2.4 之后有真实
  数据）。
- 3.5 MC 侧沙箱 import 切换（维持推迟，等真机 Bot 渠道）。

---

## 建议执行顺序

```
P0.1 提交固化 ──► P0.2 更新止血 ──► P0.3+3.3 合并冒烟（一次 dev 起跑验多项）
        │
        ├─► P1.1 / P1.2 / P1.3（小件，穿插）
        │
        └─► P2.1 plan_update ──► P2.2 code_mode ──► P2.3 控制台
                    （2.4 pgvector 视精力独立成批）
```

原则沿用 DESIGN-PRINCIPLES：先固化已有工作（0.1），再做让机器活过来的
接线（2.1/2.2），新增面（2.3/2.4）放最后。
