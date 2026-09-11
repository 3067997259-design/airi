# AIRI 单人维护与数据所有权执行计划

## 2026-09-08 验收后代码审查与续批

当前结论：MD-1/2 已有实现，但 [R01](./evidence/short-scenarios/ACC-20260907-01/R01-business-backup.md)
在导出入口失败，后续恢复与崩溃场景仍受阻塞。历史非空 memory 局部恢复通过不覆盖本次失败。

### MD-1/2：导出 owner 注册可以开始修复

设置窗口报错：`Store "data-backup" does not expose synced action "exportSnapshot" in the leader.`
[正常 leader 启动](../../apps/stage-tamagotchi/src/renderer/main.ts)未创建备份 store，
[data-backup](../../packages/stage-ui/src/stores/data-backup.ts)却依赖同步 action 路由。

- [ ] 在正常 leader 就绪阶段注册备份 owner，明确 bridge、Pinia 与 restore gate 的启动顺序。
- [ ] 冷启动后直接从 follower 设置窗口导出，不先打开页面或手工调用 action 预热。
- [ ] 初次注册、重复打开设置与多窗口调用均可路由，快照仍只由 leader 生成。
- [ ] 入口通过后再验证非空 owner、一致性与 manifest；一次下载成功不能代替完整 R01。

### MD-2：adoption 后恢复调度可以开始修复

[adoption 回调](../../apps/stage-tamagotchi/src/renderer/bridges/coding-host-install.ts)解除 hold 并恢复技能，
但未重新初始化此前因 hold 跳过的长期目标 consumer。
由明确 owner 在解除后恢复 scheduler，LG-2 配合检查 listener 与计划镜像。

- [ ] 在同一恢复进程中解除冻结后执行一次到期目标，无需再启动应用。
- [ ] 重复 adoption、已有 follower、新开窗口不重复安装 listener 或执行副作用。
- [ ] 复跑 R02–R05/R07，再解锁 L04/L05；R06 单独准备真实同步后端和测试队列。

### MD-0：验收产物与检查边界

2026-09-08 代码审查时根 typecheck 通过。根 lint 报 21 个错误，集中在 D01 证据代码块和测试技能产物。
自测产物包含沙箱顶层 return，不是普通 ESM 模块；不能为了 lint 改写其执行语义。

- [ ] 区分维护源码与原始验收 fixture，明确受控的 lint 范围或按原始证据归档。
- [ ] 原始 source/selftest/meta 保留字节与哈希；需变换时保存另一个版本并记录来源，不静默替换。
- [ ] 修正可格式化的文档示例或以原始文本标注，重新跑 lint，不把快照代码错误归成产品运行缺陷。

buildId 的内容可识别性、完整数据对照与长期观察沿用原 MD 批次，未在本次审查中宣告完成。
以下保留原计划与历史执行记录。

日期：2026-09-06。状态：MD-0 已完成（只读基线核查）；MD-1 至 MD-4 计划，尚未执行。
归属：[七维升级总索引](./upgrade-roadmap.md) 方向七。优先级：贯穿全部批次。

## 1. 目标与基线

目标：每次升级可识别、数据可迁移、故障可解释，维护与运行成本处于可承受范围。
性能调整根据实际测量开展，模块拆分按所有权与生命周期进行。

当前基线包含未提交源码和未跟踪文档，单靠 git HEAD 不能唯一标识运行产物。
分支已关闭默认上游自动更新，避免上游安装包覆盖魔改；该政策继续保留。
journal、DuckDB、远端镜像、角色配置和技能产物各有存储边界，导出必须说明一致性时点。

## 2. 旧批次承接

| 来源 | 后续归属 |
| --- | --- |
| [长期路线](./reliability-and-roadmap-plan.md) §4.6 | MD-0 至 MD-4 |
| 同文 §4.4 注意力与成本 | MD-3，调度行为由 LG/SP 分别实现 |
| [维护计划](./MAINTENANCE-PLAN.md) P3.1；[接线清单](./WIRING-BACKLOG.md) §7 | MD-0 当前检查基线；不直接沿用旧环境失败结论 |
| 维护计划 P0.2 上游更新政策 | MD-0/2 保留分支升级与恢复边界 |
| [Harness](./HARNESS-PLAN.md) §9 maintenance 相位 | MD-3 条件优化，先测水位压缩与交接 |
| [编码 Harness](./CODING-HARNESS-DESIGN.md) journal archive/tree 资产 | MD-1/2 核对导出与引用闭包，不重建通用日志框架 |
| [镜像计划](./MIRROR-PLAN.md) 图像长期存储后置 | MD-1 定义保留规则，SP-5 决定是否引入 |
| [记忆检索路线](./MEMORY-RETRIEVAL-AND-PERSISTENCE-PLAN.md) A/B 的迁移和来源 | DR-3 验可靠性，MD-2 验导出恢复后仍成立 |
| [自造工具设计](./SELF-AUTHORED-TOOLS-DESIGN.md) 生命周期 | SG-1 实现领域持久化，MD-2 负责整体备份恢复 |

## 3. 盘点范围与所有权

| 数据 | 现有边界 | 导出必须保留 |
| --- | --- | --- |
| journal 与归档 | 主进程 journal-host、core-agent journal | session、原始 seq、任务身份、引用与完整性状态 |
| 本地记忆与计划 | leader DuckDB、memory/plans store | 有效性、来源、修订关系、向量元数据、迁移与 outbox 状态 |
| 远端镜像 | memory-host、memory-pgvector | originId 与同步状态；说明导出是否覆盖远端 |
| 角色与模块配置 | 现有配置持久化边界 | 角色身份、用户选择、配置版本和缺失项 |
| 自造技能 | coding-host 产物、SG 持久化 | 源码、自测、审阅绑定、隔离与启用状态 |
| 原始媒体 | 当前媒体所有者 | 仅导出已明确持久保存的媒体，不收集临时镜像帧 |

代码入口：apps/stage-tamagotchi/src/main/services/airi/、src/renderer/main.ts。
共享入口：packages/core-agent/src/journal/、packages/stage-ui/src/composables/use-duck-db.ts、stores/modules/memory.ts、stores/skills.ts。
构建与检查入口：根 package.json、apps/stage-tamagotchi 的构建脚本和既有 memory-runtime-smoke.ts。

## 4. 实施批次

### MD-0：构建、检查与文档状态可识别

前置：无。与 DR-0 共用基线记录。

1. 记录 HEAD、工作树差异标识、依赖版本和最终构建摘要；复用既有 SHA-256 构建标识能力。
2. 核对 root scripts，记录实际 typecheck、lint、所属包检查的命令和退出码。
3. 区分源码、dist、开发 Electron 与打包 EXE，发现错配先重新构建对应依赖。
4. 用本系列承接表校正旧文件的页首状态或增加后续入口，保留历史诊断原文。
5. 为本轮触及的包补齐 README 职责、用法与不适用场景，避免只留下总账中的路径。
6. 把环境失败与代码失败分别归档；不通过改 tsconfig 或测试导入路径隐藏真实边界问题。

验收：任一结果都能对应一份确定产物；未运行检查不会显示通过；文档状态与新证据一致。
本计划不要求创建提交，也不授权清理当前工作树或重置他人改动。

执行记录（2026-09-06，只读基线核查）：已冻结工作树 diff SHA-256
（`daf58b34f8c913c3aa39fba8ed323638ceda33faa7b0a1e34dd73b741256946d`）与两套独立构建标识。
dev `out/`（Sep 6 22:50–22:51）：main `aae2201ade9fcdd3026cd6623db3d9726f5bea1c8dd819ccfe25bc1a12e74b01`、
renderer index.html `5740c700c2e98e77026e67ce93b6243688667c11d653bbec219a0e81410264b3`、
preload index.mjs `6d7c0232c289059ededa8435ce8c3d589d27ce0fe74b5ebab5178b1b07dea94d`。
打包 EXE `dist/win-unpacked/airi.exe`（Sep 6 13:36）SHA-256
`f8e36f72b274816a3625af19db60640fdc95a9479bcf958d0dbb1292516a3e64`。
root `pnpm typecheck` 与 `pnpm lint` 均退出码 0（`pnpm type-check` 不存在，实际脚本为 `pnpm typecheck`）。
关键附加发现：真实 Postgres 现可用（`proj-airi-backend-db-1` Up 3 hours healthy，
`127.0.0.1:5435` OPEN），memory-pgvector 4 条集成测试真实通过（805ms），解除 DR-3/MQ-0/MD-2
的数据库硬阻塞。完整记录见 [MD-0 基线证据](./evidence/md-0/md-0-baseline-record.md)。

2026-09-07 复查：当前 shell 未设置 `DATABASE_URL`，`127.0.0.1:5435` 连接失败，因而本轮
`memory-pgvector` 集成测试 4 条均跳过。上面的 2026-09-06 通过记录保留为历史证据，不能
替代本轮的真实 Postgres 复查。

同日 Docker 恢复后再次复查：使用 compose 的本地映射连接串运行
`memory-pgvector` `repository.integration.test.ts`，4/4 通过（约 1 秒）。本次真实测试
覆盖插入/检索/删除、`originId` 幂等、删除 tombstone 防复活，以及审阅/修订/删除传播；
不包含生产 profile、打包 Electron 或 agent-browser 交互。

同日恢复对照增量：stage-ui 新增 `compareDataBackups`，按归档 manifest 对 memory、plans、
journal、skills 等 owner 统计新增、删除、变更和未变路径。它是恢复前后字节级清单工具，
不替代各 owner 对计划状态、事实修订关系、journal 来源链和技能审阅绑定的语义核对。

### MD-1：导出与恢复契约

前置：MD-0；与 SG-0 盘点结果对齐。

1. 列出各类数据的存储位置、唯一写入者、引用关系和体积。
2. 确定一致性时点：暂停新工作与写入，等待领域 flush/checkpoint，再生成完整清单。
3. 区分业务数据、配置和凭据。默认业务导出不含 API key、认证串与临时帧。
4. 为导出清单定义版本、内容校验、构建信息、覆盖范围、缺失项和恢复前置条件。
5. 确定 journal 归档与事实来源引用是否都在包内；不完整来源必须可见。
6. 设计先检查、再预览、再导入的恢复流程，默认导入独立目标 profile。

验收：能够说明一份导出包含哪些数据、是否完整、是否仍有待同步 outbox，以及是否需要用户另行配置 provider。
若新增打包或校验依赖，先搜索已有内部实现并完成候选选择，不在此预选库。

### MD-2：实现导出恢复与迁移验证

前置：MD-1、DR-3、SG-1。

1. 通过各领域 owner 导出稳定快照，不能逐目录复制正在写入的数据库文件。
2. 恢复前检查版本、路径、内容校验与必需文件，失败时保留原 profile。
3. 恢复事实、计划、journal 和技能时保持 ID、seq 与来源关系。
4. 对恢复后的源码重新核对审阅哈希，对向量重新核对 active source。
5. 明确 outbox 恢复后何时允许投递，避免导入即对外重复写入。
6. 在独立 profile 完成启动、查询、技能调用和目标恢复，再由用户决定切换。

验收：导出前后有效事实、目标身份和技能审阅关系一致；损坏包不污染原数据；缺凭据表现为待配置。
恢复是数据操作，不保证撤销外部副作用；rewind 的语义归 DR-4。

MD-2 增量记录（2026-09-07）：恢复回执重试、写失败时不发布完成状态、follower 失败传播等 7 条测试通过。
该轮详见 [恢复回执证据](./evidence/md-2/restore-receipts-20260907.md)。
同日已修复 renderer 导入死锁、计划启动竞态、聊天归档改写和技能提前注册。
实际 owner 的浏览器回归通过，完整数据对照和打包恢复仍待完成。见 [owner 回归](./evidence/md-2/restore-owners-20260907.md)。

### MD-3：运行成本与性能观察

前置：MD-0；不阻塞功能基线的只读测量。

1. 汇总主聊天、Flow、摘要、抽取、评审、embedding、dreaming 和社交决定的用量。
2. 将缓存、失败和重试费用单列；未提供的 provider 用量显示未知，不能当作零。
3. 采集长时间驻留的内存、CPU、journal 投影耗时、跨窗口消息量和检索延迟。
4. 记录整库 checkpoint、全量克隆、向量扫描和重嵌批次的实际成本。
5. 只有出现证据支持的瓶颈，才调整批次、投影或缓存；明确失效与新鲜度语义。
6. 只有现有水位压缩阻塞任务或丢交接信息时，再评估 HARNESS 后置的 maintenance 相位。

验收：能够解释一次任务和一天使用的主要成本；优化前后使用同一场景对比；性能优化不破坏恢复和事实有效性。
根据实际预算制定停止或降频政策，模型不能自行提高用户设定的限额。

### MD-4：日用观察与升级决策

前置：7 天观察要求 DR-1/2/3、MQ-0/2、SG-1、SP-0；30 天观察再加入 LG-4、PC-3 和 SG-2。

1. 固定任务集，至少覆盖调查、修改验证、失败恢复、事实纠正、主动表达和技能复用。
2. 每天记录任务成功、虚假完成、用户纠正、恢复结果、记忆错误、打扰与成本。
3. 新模型、prompt 或工具版本在同一任务集上比较，每次只改变可解释的变量。
4. 保存失败样本、修复批次与复验结果，检查问题是否重复出现。
5. 观察结束后分别给出扩大使用、继续观察或回退的结论。

验收：报告包含分母、未覆盖项、构建与模型版本，按任务类型报告，不用一次演示证明长期稳定。
7 天和 30 天是观察窗口建议，不是自动通过门，也不要求连续付费运行模型。

## 5. 完成定义与执行记录

执行规则见 [总索引](./upgrade-roadmap.md)。导出恢复用隔离数据验证，当前用户数据保持原有所有权。

- [x] MD-0 构建、检查与文档状态可追踪（2026-09-06，只读基线核查完成；见上方执行记录）。
- [ ] MD-1 数据清单与一致性边界明确。
- [ ] MD-2 独立 profile 导出恢复通过。
- [ ] MD-3 成本与性能基线可用，条件优化有证据。
- [ ] MD-4 日用观察报告完成并形成升级决策。

首条执行记录：2026-09-06，仅编写计划，未导出用户数据或修改更新设置。
2026-09-07 增量：重新打包 Electron 后，以 Playwright/CDP 启动独立源 profile 和 restore profile。plan、journal sentinel、active session、memory 设置和 durable receipt/adoption 均在恢复前后对齐；恢复 hold 期间技能未执行。第一次运行发现归档设置只写入 localStorage、未更新已创建 Pinia ref，已补 `restorePersistedSettings` 并由浏览器回归和打包重跑验证。第二次打包运行用本地拦截的 deterministic embedding 写入并恢复一条非空 memory row，scope、来源、状态和 768 维向量保持一致。`compareDataBackupSemantics` 现在可对 JSON/JSONL owner 记录做稳定化比较。custom skill workspace migration、非空 outbox/scheduler 仍未完成，因此 MD-2 保持未完成。
