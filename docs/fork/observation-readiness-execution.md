# 日用观察准入与数据恢复执行文件

## 2026-09-08 准入复核

[ACC 登记表](./evidence/short-scenarios/ACC-20260907-01/run-register.md)已无 NOT-RUN，
但 18 FAIL 与 22 BLOCKED 均保留，7/30 天准入尚未满足。
验收后代码审查与续批已分别写回七份执行文档，汇总见 [总索引最新入口](./upgrade-roadmap.md)。

当前依赖顺序：

1. MD-1/2 注册 leader 备份 owner，复跑 R01 入口与非空一致性，解除恢复和崩溃前置阻塞。
2. SG-1 补实际源码/自测审阅与哈希绑定，复跑 K02 后再运行 K03–K07。
3. LG-2/3 修复“继续”双入口与恢复协调，MD-2 补 adoption 后调度，验证 R04 和 L04/L05。
4. MQ-0/2 定位新会话空回答，再复跑 M 系列；PC-0/2 修复 dreaming 主体隔离，SP-1 才能完整验证记忆素材。
5. DR-1 修证据语义，补拒绝重试和 60 秒超时；SP-0/2 修跨轮去重并补迟到 speak 分支。

根 typecheck 的既有类型错误已修复。原始验收文件的 lint 边界另归 MD-0，不改写 source/selftest 的原始哈希。
本增量仅更新设计和依赖，不把修复标成已实施，不覆盖 ACC 首次验收结果。

本文件承接 [七维总索引](./upgrade-roadmap.md)，用于把剩余实施批次和行为验收合并成可执行依赖。
状态按证据更新。代码通过、真实场景通过和跨天观察通过分别记录。

## 1. 依赖与完成边界

| 工作 | 前置 | 当前证据与下一项 |
| --- | --- | --- |
| MD-0 | 现有构建与工作树 | [基线记录](./evidence/md-0/md-0-baseline-record.md)已有；本轮修改后必须重新构建和记录哈希 |
| MD-1 | MD-0、SG-0 盘点 | 清单、ZIP 契约、owner 导出和恢复 gate 已实施；完整运行证据待补 |
| SG-1 | SG-0、MD-1 的技能格式 | 已修正快照写回、异步动作、审阅哈希、源码复核、工作区关联；实际重启验收待完成 |
| SG-2 | SG-1 | 待实际生成低风险实用技能、人工审阅、三个不同输入、失败边界及重启复用 |
| MD-2 | MD-1、DR-3、SG-1 | ZIP 检查、隔离 staging、relaunch、owner 导入和 held outbox gate 已实施；打包运行和完整对照待补 |
| 7 天观察 | DR-1/2/3、MQ-0/2、SG-1、SP-0 | 尚未满足；不得把 MD/SG 链完成等同于全部准入通过 |
| 30 天观察 | 7 天前置、LG-4、PC-3、SG-2 | 尚未满足；LG-4 的真实跨日条件不能用模拟时间代替 |

用户列出的 `MD-0 → MD-1 → SG-1 → SG-2 → MD-2` 可以作为执行顺序。
MD-2 的技术前置是 SG-1，不必等待 SG-2 的收益观察；两者可以分别准备证据。
MQ-0/2、SP-0、PC-3、LG-4 是另外的准入支线。

## 2. MD-1 数据清单

`profile` 指 Electron `app.getPath('userData')`；`workspace` 指 coding-host 当前根目录。
体积由每次导出清单的 UTF-8 字节或二进制字节实测；本文件不把未测量项填成零。

| 数据 | 位置与 owner | 必须保留的关系 | 快照要求 |
| --- | --- | --- | --- |
| 本地事实、向量、经历、想法 | leader 的 OPFS `airi-memory.duckdb`；`useDuckDb` 与 memory repository | id、originId、scope、来源上下文、修订关系、embedding source/status | owner 阻止新写入并完成事务/checkpoint；禁止复制仍在写入的数据库 |
| 计划与长期目标 | 同库 `memory_long_term_goals`；plan store | goalId、spec、state、constraintVersion、证据、sessionId、workspaceRoot | 与记忆同一数据库快照；恢复后保持调度暂停 |
| journal 与完整归档 | `profile/journal`；主进程 journal-host | sessionId、seq、事件身份、跨事件来源 | leader `flushNow` 后，owner 等待全部 append 队列；不能使用有截断上限的普通 replay 作为全量导出 |
| 技能注册表 | localStorage `skills/review-queue`；leader skills-review 动作 | toolId、contentHash、reviewedHash、review/quarantine、workspaceRoot、muscleMemoryId、自测证据 | 接收快照不写存储；坏注册表保持原始字节并阻止覆盖 |
| 技能文件 | `workspace/skills/<toolId>/source.mjs`、`selftest.mjs`、`meta.json`；coding-host | 源码/自测哈希、提交版本、外部来源 | 通过 host 读取并核对同一 workspace；未注册孤立文件列为缺失或未纳入 |
| 聊天 | IndexedDB `airi-local`；chat session store/repository | 用户、角色、sessionId、消息身份 | 复用 `exportSessions()`；另核对 outbox/tombstones，不能把聊天导出当全库备份 |
| 角色身份与设置 | `airi-card` 及设置 stores；各自 persistence owner | characterId、活动角色、角色定义、模型引用 | 明确字段白名单；角色卡分享包经过删减，不作为无损恢复格式 |
| 待同步项 | 聊天 repository 的 outbox/tombstones；memory 的 longTermSyncOutbox | messageId、originId、绝对 patch、删除顺序 | 单独保留并标记 held；恢复不会自动投递 |
| PostgreSQL 镜像 | memory-host 与 pgvector repository | originId、scope、有效 source、同步水位 | 记录镜像状态；本地权威库与远端覆盖不同，不能默认为完整镜像 |
| 凭据与外部副作用 | provider/auth 配置、系统凭据、外部服务 | 不纳入默认业务包 | 不导出 API key、认证串、cookie；恢复后等待重新配置 |
| 临时镜像帧与运行时客户端 | renderer 临时状态 | 不纳入 | 不导出临时原图、函数、连接、控制器或未决 Promise |

## 3. 一致性时点

1. 在 leader 获取维护锁，拒绝新的工作、技能审阅和业务写入。
2. 等待已经运行的 Flow、模型请求、记忆抽取、embedding、dreaming、技能和持久化任务结束；存在未决任务时不生成“完整”快照。
3. 暂停长期目标唤醒、社交心跳以及聊天/记忆 outbox 投递。记录暂停前状态。
4. 完成 journal flush 和数据库 checkpoint；保存每个 session 的最高 seq。
5. 各 owner 导出快照及覆盖数量；核对 journal/archive 与事实来源的闭包。
6. 对遗漏的来源和未包含的镜像写入 `missing`，对重新配置要求写入 `prerequisites`。
7. 生成 ZIP 后再释放维护锁。失败时恢复原运行配置，保留原数据并报告失败。

ZIP 打包层不能替代维护锁，也不能靠字段 `credentials: excluded` 自动清洗数据。
清洗和一致性由提供数据的 owner 保证。

## 4. ZIP 契约与检查

2026-09-06 用户选择复用现有 JSZip，不新增依赖。
实现入口：`packages/stage-ui/src/services/data-backup.ts`。

- 根文件 `manifest.json`，`format: airi-data-backup`、`version: 1`。
- 固定记录 snapshotId、createdAt、buildId、coverage、missing、prerequisites。
- 每个文件记录 path、domain、bytes、sha256；domain 限于 memory、plans、journal、skills、chats、identity、outbox。
- `credentials: excluded`；`outbox: held`。
- 拒绝绝对路径、反斜杠、空路径段、`.`/`..`、大小写重名、跨 owner 路径及未声明文件。
- 检查 JSZip 的原始文件名，不能只检查被清洗后的路径。
- 当前上限为 64 MiB 未压缩业务数据、10,000 个条目、1 MiB manifest；超过上限明确失败，不能截断导出。
- 校验和只证明内容一致，不授予技能执行权限。
- 2026-09-07：新增 Electron backup host、隔离 restore profile 状态机、restore gate，以及 memory/chat/long-goal 的恢复前副作用门控。数据页已提供 ZIP 导出和导入入口；当时完整打包运行仍未执行。
- 2026-09-07：随后使用重新打包的 Electron 和 Playwright/CDP 完成一次独立 source/restore profile 运行。plan、journal、active session、memory setting 和 durable receipt/adoption 对齐；fixture 的 memory rows、skills 和 outbox 为空，完整非空 owner 对照及 custom workspace 迁移仍未完成。

参考：[JSZip 限制](https://github.com/Stuk/jszip/blob/main/documentation/limitations.md)、
[原始路径语义](https://stuk.github.io/jszip/documentation/api_jszip/load_async.html)、
[DuckDB-Wasm 导出](https://duckdb.org/docs/current/clients/wasm/query)。

## 5. MD-2 恢复与验证

1. 完整检查 ZIP。任何版本、路径、条目或校验失败均发生在目标写入之前。
2. 展示覆盖、遗漏、体积、待同步项和缺失凭据。检查通过不等于语义验收通过。
3. 创建独立空 profile 作为 staging，禁止覆盖当前 profile。
4. 各 owner 恢复自己的数据，保持 ID、seq、originId、审阅绑定和来源关系。
5. 导入的技能默认不可执行；重新核对源码、自测、审阅哈希和 workspace 后才恢复原有效状态。
6. 向量必须匹配当前 embedding source；不匹配的向量保留但不参与检索。
7. outbox 保持 held；长期目标与社交调度保持暂停，不因启动恢复程序产生外部副作用。
8. 在恢复 profile 检查事实查询、纠正关系、目标身份、技能调用和重启。损坏包需证明原 profile 不变。
9. 保存对比表及新旧构建标识，再由用户决定是否切换日用 profile。

当前代码边界：renderer 普通导入先由主进程保存 archive 并创建独立 profile，然后通过 `APP_USER_DATA_PATH` relaunch。新 profile 的 leader 在 owner 导入完成并写入 `complete` 回执前，memory、long-goal、chat reconcile 和两个 outbox 都等待 restore gate。损坏或中断的 profile 不会自动复用。

2026-09-07 回执回归：主进程现在先持久化状态，再向后续 bootstrap 和 follower 发布状态。
同一 snapshot 与同一结果的重复回执可重试，覆盖 IPC 响应丢失。7 条定向测试通过。
检查另发现 renderer 导入等待 `memory.initialize()` 与 restore gate 相互等待，且普通 owner 启动与导入并行。
该轮证据见 [回执回归](./evidence/md-2/restore-receipts-20260907.md)。

同日 owner 回归已修复导入死锁、计划抢先加载空库、聊天 watcher 改写归档，以及导入技能提前注册。
所有 renderer 等待主进程恢复决定，leader 的 journal 回放在 gate 释放后启动。
浏览器测试 10 条、Node 测试 32 条通过；完整数据关系与打包恢复仍未完成。
详见 [owner 启动证据与剩余项](./evidence/md-2/restore-owners-20260907.md)。

恢复异常增量（2026-09-07）：归档校验、导入或 bootstrap 异常现在会结束本地 owner 初始化，
同时保留恢复 profile 的 durable effect hold；损坏 profile 不再让 renderer 永久等待，也不会
自动恢复外部副作用。该分支仍需独立 profile 和打包运行确认。

技能恢复补充（2026-09-07）：`skills.restore()` 在 durable effect hold 期间不做运行时工具注册；
`backupAdopted` 释放 hold 后才重新执行源码复核和注册。stage-ui skills 浏览器回归 5 条通过，
真实 profile adoption 与打包运行仍未完成。

打包启动补充（2026-09-07）：Electron main bundle 将 `@proj-airi/skill-forge` 纳入 workspace
alias 和 externalize exclude，修复启动时从 workspace source 解析 extensionless `./hash` 的错误。
重建后的非交互 `memory-runtime-smoke.ts --launch` 在 CDP 9267 通过；这不是 profile 恢复或
agent-browser 行为验收。

## 6. 并行验收支线

2026-09-07 数据库对照增量：实际 DuckDB-Wasm 五表经过 Parquet 导出、损坏回滚、重新导入、关闭与重开后逐字段一致。
覆盖纠正链、来源/作用域、向量元数据、目标状态 JSON、经历与想法引用，保留超出 JS 安全整数范围的时间戳。
这不是第二个 Electron profile 或完整 owner 关系闭包验收。见 [数据库对照证据](./evidence/md-2/database-roundtrip-20260907.md)。

2026-09-07 副作用门增量：恢复回执现在分别释放本地 owner 初始化，并保留恢复 profile 的自动副作用暂停。
每次启动由主进程持久标记重新提供恢复状态；记忆 outbox 回放删除的失败回归已修复。
聊天投递、自动 dreaming、社交心跳、旧 Flow 和长期目标调度入口加入暂停检查。
新增显式 adoption 回执：用户完成恢复前后对照后，`adoptRestoredProfile()` 持久化释放副作用保持，
后续启动不再重新暂停。真实远端重连、custom skill workspace 和非空 outbox/scheduler 对照仍待完成；
Electron 打包独立 profile 的 plan/journal 和非空 memory 运行已记录。见
[副作用门证据](./evidence/md-2/restore-effects-20260907.md) 和
[打包恢复证据](./evidence/md-2/packaged-restore-20260907.md)。

2026-09-07 对照工具增量：`compareDataBackups` 现在可对两份已检查归档按 owner/domain
统计新增、删除、变更和未变路径；新增的 `compareDataBackupSemantics` 对 JSON/JSONL 按稳定化记录
统计新增、删除、修改和解析错误。Parquet 仍由 DuckDB owner 负责语义核对；完整计划、记忆、journal
和技能审阅关系仍需非空独立 profile 运行来核对。

- DR：参见 [DR 记录](./evidence/dr-20260906/dr-execution-record.md)。补齐拒绝/超时/取消、故障注入、记忆重启与打包运行证据。MD-0 的 PostgreSQL 集成结果只解除数据库环境阻塞。
- MQ：参见 [gold 语料](./evidence/mq-0/gold-corpus.md)、[接线缺口](./evidence/mq-0/wiring-findings.md) 与 [生产报告](./evidence/mq-0/production-report-20260907.md)。90 条 fixture 已在实际 Electron renderer 的隔离本地 profile 副本中绑定真实 session/scope 并运行，完成 synthetic production-path baseline；语料仍为合成数据，外部 provider、真实用户事实、费用价目和 MQ-2 修订后行为采纳仍待执行。`evaluateProductionRetrieval` 和 `useMemoryStore.evaluateProductionRetrieval` 已接入正式双路 retrieve。
- SP：参见 [SP 记录](./evidence/sp-20260906/sp-execution-record.md)。SP-0 保留 20 刺激原门槛及三种真实决定；点击测试心跳不能替代该验收。
- PC：保留 [PC-3](./persona-continuity-plan.md) 的新会话、重启、角色与模式切换组合测试。
- LG：参见 [LG 记录](./evidence/lg-20260906/lg-execution-record.md)。LG-4 需要真实等待条件、跨日变化及一次有界恢复；不靠修改系统时钟提前通过。
- 条件后续批次继续引用各方向原文件：DR-4 Hashline/rewind、MQ-1/3 多视图/reranker、SP-4/5 共同活动/媒体、SG-3/4 退役/外部能力、MD-3 性能成本。未触发项不追加为本轮硬前置。

## 7. 观察记录模板

每个自然日记录：日期、profile、buildId、provider/model、任务类型、成功数/总数、虚假完成数、用户纠正数、记忆错误、打扰、恢复结果、已知用量、未知用量、失败证据、修复批次。
7/30 天以真实起止日期计算。准入尚未满足时可采集 Day-0 基线，但不得计作正式观察已通过。
重新构建、切换模型或修改 prompt 时保留旧标识，并注明哪些观察需要重新验证。
