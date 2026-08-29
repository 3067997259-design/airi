# 接线期任务清单（WIRING BACKLOG）

**状态**：P0–P5 接线代码已完成；开发版 Electron UI 已完成一次 CDP 冒烟，当前剩余项
是原生设置窗口的完整审批走查、MC 真机 Bot 验证、中文 embedding 与权重标定、
pgvector 环境走查和 Hashline 基准。每条都有对应文档章节与当前代码位置。完成一项勾一项。

> 与本仓库根下的六份设计文档为同一批次产物。环境冻结期间（pnpm store 打不开、
> 锁文件未收录新包）的临时工作区方案均已用 `NOTICE` 注释标记在代码里，
> 本清单第一条就是解除它们。

---

## 0. 环境解除项（先行）

- [x] **`pnpm install` 收录新包**：`@proj-airi/coding-harness`、`@proj-airi/skill-forge`
  尚未进入 `pnpm-lock.yaml`（默认 store 报 `unable to open database file`，本机残留
  `.pnpm-store/` 为本地 store）。安装成功后：
  - `packages/coding-harness/src/tools/bash-tier.ts` 已删除，改为从
    `@proj-airi/core-agent` 导入 `classifyBashCommand`（其头部 NOTICE 标注了收敛条件）
  - `packages/stage-ui/src/stores/skills.ts` 已删除镜像类型/生命周期/哈希助手，改为
    import `@proj-airi/skill-forge`（头部 NOTICE 标注了收敛条件）
  - 之后可跑 `pnpm -F @proj-airi/coding-harness exec vitest run`（本 shell 无法执行
    fork 子进程测试，ptc 与 coding-tools 套件在升权壳下已验证过一次）

## 1. 沙箱共享收敛（CODING-HARNESS §3 / SELF-AUTHORED-TOOLS §2.1）

- [ ] **minecraft 侧切换（推迟）**：通用沙箱的 globals 注入形态与 MC 的
  runtime 快照 / bootstrapScript / mem 回读语义不兼容；MC 侧适配需要真实
  Minecraft 运行验证渠道，风险收益比低。保留双份，收敛条件与映射表待定。
- [ ] **隔离评估**：共享 worker 目前用 `node:vm`（`--permission` + `--frozen-intrinsics`
  的 fork 里）。若 Electron 主进程接线时需要更深的 JS 隔离，评估 isolated-vm 注入。
- [ ] **memory muscle 复用**：skill-forge 最终消费共享沙箱做 draft 自测
  （SELF-AUTHORED-TOOLS §8 第二期）。

## 2. 四工具接入桌面聊天（CODING-HARNESS §5）— ✅ 主体完成 2026-08-29，真机待构建

- [x] **Electron 主进程 IPC 宿主**：`src/main/services/airi/coding-host/`（Eventa 契约
  在 `shared/eventa` 的 coding-host 段 + `policy.ts` 可测编排 + handlers + 挂载）；
  `policy.test.ts` 5/5（分级/审批门/denied/输出上限）。
- [x] **工具注册**：`built-in.ts` 注册 read/write/edit/bash（`listTools` 可达性门控，
  桥断降级不注册）+ Hashline `## Toolset` 指引。
- [x] **PTC 入口**：设置 → 编码页（`coding.vue`：工具状态/工作区根/Code Mode 试运行）
  + `stage-ui/stores/coding.ts` 注入端口 + 每窗口装配（`renderer/main.ts`）。
- [x] **bash 审批卡**：`stage-ui/stores/approvals.ts` + `approval-card.vue`（挂
  `history.vue`）+ 主进程 request/decided 事件链 + 60s 未答复拒绝。
- [x] **Electron 开发版运行期接线修复**：main bundle 排除 workspace 包外部化，
  并发射权限冻结的 `worker.ts` 资源；renderer 改用纯 Hashline 子路径，避免在浏览器
 端加载 `node:fs` / `node:child_process`。
- [x] **Electron UI CDP 冒烟（2026-08-29）**：agent-browser 连接 9250 后确认主
  renderer 可挂载，Chat 有输入框，编码页显示 read/write/edit/bash 与 Code Mode，
  PTC bridge trace 可见，Minecraft/Attention/Skills/Memory 路由均可加载且无 page
  errors。测试使用临时 `APP_USER_DATA_PATH`，没有写入真实 AIRI 用户配置。
- [ ] **真机冒烟**：构建后验证聊天模型调用 4 工具、审批卡弹出、Code Mode 试运行。
  当前仍需在原生 settings/chat 窗口中完成审批卡走查；本机受限环境的
  `SERVER_CHANNEL_PORT=6121` 返回 `ENOTSUP`，且没有配置模型凭据。

## 3. 权威链接入运行时（CODING-HARNESS §4 第四期 / WORKSPACE-DESIGN）— 部分完成

- [x] **计划状态机（plan-runtime）**：`core-agent/src/planning/plan-runtime.ts` ——
  工具白名单结构拒绝、证据血缘（默认未审阅）、验证门判定、审批事件入证据；8/8 单测。
- [x] **证据登记入 journal**：聊天工具结果、PTC 每次 bridge 调用、opencode 适配器调用
  都写 `tool/call` + `tool/result`；计划 store 支持 `stepId` + `provenance`，验证门只消费
  可信结果。
- [x] **短会话执行循环**（WORKSPACE §3）：`buildTurnProjection` 生成有界的计划摘要、
  当前步骤、最近证据和上一工具结果，并在每轮 system supplement 注入。
- [x] **承认度迁移**：attention task、context:update、reaction、approval、review 和
  chat/tool 生命周期均写入 core journal；旧 websocket/task store 仍保留丰富 UI 字段，
  但 journal 已成为统一审计输入。

## 4. 自造工具飞轮收尾（SELF-AUTHORED-TOOLS-DESIGN）

- [x] **skill-forge 接入运行时**：`skills.vue` 使用 `@proj-airi/skill-forge` 的哈希、
  生命周期和 probation 上限；只有 `reviewed` 项进入动态 LLM 工具表。
- [x] **第一批工具**：`OPENCODE_ADAPTER_SKELETON` 已在 catalog seed，支持
  draft→probation→reviewed，并将 reviewed tool 的触发模式注册到 prompt。
- [x] **compatibility 探测执行**：opencode 调用前执行 `opencode --version`；失配会
  quarantine 并从运行时工具表移除。
- [x] **dream 修订批处理**：`dreamRevisionBatch()` 从 journal 回顾失败的 reviewed
  工具调用，最多形成 5 个 revision 候选并退回 probation；设置页提供手动批处理入口，
  仍需人工复审后才能重新激活。

## 5. ATTENTION 遗留（ATTENTION-DESIGN）

- [x] **integration 通道指引**：`docs/ai/context/integration-channels.md` 给出
  `context:update` / `spark:notify` / `spark:command` / task / reaction 的路由表。
- [x] **focused 模式开关**：`## Mode` 注入已上线，并由 Attention 设置页控制。
- [ ] **运行验收**：§9.1 六条验收条件需要实跑 Electron 验证（卡片折叠、blocked
  冒泡、`logRef` 只显指针等）。

## 6. MEMORY 遗留（MEMORY-DESIGN）

- [ ] **nomic 中文表现实测**：§11.1 —— 中文语料相似度验证，备选 bge-m3（1024 维列
  已存在）。
- [ ] **权重调参**：§11.3 —— 五个滑杆已暴露，等真实检索数据标定。
- [x] **dreaming agent**：memory store 提供可替换的 `MemoryDreamAgent` 接口、受限批量
  生成、去重和 idea lifecycle；短期记忆设置页可手动运行并审阅结果，schema 无需迁移。
- [x] **pgvector 接线（主进程 memory-host，2026-08-29）**：`memory-pgvector` 新增
  `ensureMemorySchema`（幂等建表，此前 DDL 不存在）与 `./repository` 子路径导出；
  Electron 主进程 `memory-host` 服务持有连接（Eventa 契约），stage-ui 记忆 store
  暴露 `MemoryHostPort` 注入端口；`promoteEligible` 晋升后镜像片段（renderer 端
  768 维 embedding）到 Postgres，失败仅记录状态不阻塞本地层；长期记忆设置页提供
  连接串配置与状态显示。剩余：真库走查（起 `server/docker-compose.yaml` 的 db
  服务，`127.0.0.1:5435`）与跨窗口检索 UI。

## 7. 常规收尾

  - [ ] **全量回归**：本次相关包的 typecheck 已通过；仓库级 `pnpm typecheck` 在
  `NODE_OPTIONS=--max-old-space-size=4096` 下通过，默认 Node 堆上限会使
  `apps/stage-web` 的 vue-tsc 因 OOM 退出。`pnpm lint` 和 `pnpm test:run` 仍被既有
  设计稿/模型资产格式与 Windows 路径/symlink 测试阻断，详见本次验收记录。
- [x] **MODS.md**：实现批次已记录在 M-D+1 小节。
- [ ] **hashline 校准**：`packages/coding-harness` 目标模型编辑基准（§2.4）：
  20 个文件（30~5000 行）统计拒绝率/重读次数/碰撞命中率，校准签名宽度档位。
