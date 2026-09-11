# ACC-20260907-01 状态对齐（2026-09-09）

本文件处理 [独立复核](../acceptance-review-20260909.md) 发现 5：把 62 个场景的当前状态对齐，并保留原始记录。

- 原始登记 [run-register.md](./run-register.md) 不修改。
- 每个场景的早期 FAIL / BLOCKED 与后续追加运行都保留。
- 四列含义：**历史结果** 取原始登记；**最近结果** 取追加运行记录；**证明范围** 说明最近结果实际证到什么；**剩余变体** 列出未覆盖部分。

相关记录：

- [runtime-repair-20260908.md](./runtime-repair-20260908.md)
- [runtime-memory-repair-20260908.md](./runtime-memory-repair-20260908.md)
- [R01-R02-R07-retest-20260909.md](./R01-R02-R07-retest-20260909.md)
- [V02-vision-cancel-cleanup.md](./V02-vision-cancel-cleanup.md)
- [S07-S20-social-stimuli.md](./S07-S20-social-stimuli.md)
- [L04-recovery-continuation-20260909.md](./L04-recovery-continuation-20260909.md)
- [M07-firstq-pairing-20260909.md](./M07-firstq-pairing-20260909.md)
- [R06-outbox-reconnect-20260909.md](./R06-outbox-reconnect-20260909.md)
- [review-findings-1-2-repairs-20260909.md](./review-findings-1-2-repairs-20260909.md)

## 汇总

| 历史 | 数量 |
| --- | --- |
| PASS | 22 |
| FAIL | 18 |
| BLOCKED | 22 |

最近结果按场景逐项列在下面。它不改变上面的历史计数。

## B 组

| 场景 | 历史结果 | 最近结果 | 证明范围 | 剩余变体 |
| --- | --- | --- | --- | --- |
| B01 | PASS | PASS | 构建标识与产物哈希 | — |
| B02 | PASS（初测受阻，复测通过） | PASS | profile 与 provider 冒烟 | — |

## D 组

| 场景 | 历史结果 | 最近结果 | 证明范围 | 剩余变体 |
| --- | --- | --- | --- | --- |
| D01 | PASS | PASS | 只读调查 | — |
| D02 | PASS | PASS | 写入与读回核对 | — |
| D03 | PASS | PASS | 失败与恢复 | — |
| D04 | PASS | PASS | 用户声明与文件对照 | — |
| D05 | FAIL（拒绝重试）；超时/迟到 BLOCKED | PASS（runtime-repair：拒绝、超时、迟到裁决） | 同一 Flow 的新审批请求、超时拒绝回执、迟到裁决不重复结算 | 无（原始 FAIL 保留） |
| D06 | FAIL（问题卡不可用） | PASS（工具面修复后）＋跨会话陈旧答案隔离 PASS | 普通聊天问题卡与 steering、跨会话隔离 | 卡片展示策略 |
| D07 | PASS | PASS | Escape 停止、精确恢复、重载持久化 | — |
| D08 | PASS | PASS | 跨窗口投影一致、一次写入 | — |

## M 组

| 场景 | 历史结果 | 最近结果 | 证明范围 | 剩余变体 |
| --- | --- | --- | --- | --- |
| M01 | FAIL | PASS（memory-repair） | 种子事实、批准、新会话召回、journal 检索链 | — |
| M02 | FAIL | PASS（memory-repair） | 显式 reviseFact 与批准后的替代关系 | 自然语言纠正不是产品行为（单独发现） |
| M03 | PASS | PASS | 未知与假前提不编造 | — |
| M04 | FAIL | PASS（memory-repair） | 两个角色的 scope 隔离 | — |
| M05 | FAIL | PASS（memory-repair） | 带日期的历史事实 | — |
| M06 | FAIL | PASS（memory-repair） | 记忆作为数据而非指令 | — |
| M07 | FAIL（新会话回答为空） | 来源链 PASS；首问配对 PASS（本批） | Flow 来源保留、开关隔离、全新会话首问命中、marker 内容与哈希逐字节一致 | 自然语言长转述召回；事实来源指向 recall 问题 |
| M08 | BLOCKED（无公开 dreaming 入口） | PASS（两个角色） | 当前用户两角色的 scope、来源与持久化 | 第二账户变体 |

## L 组

| 场景 | 历史结果 | 最近结果 | 证明范围 | 剩余变体 |
| --- | --- | --- | --- | --- |
| L01 | FAIL | PASS（含首次等待证据） | 外部信号、一次写入、读回 | — |
| L02 | FAIL | PASS | 工作区守卫与恢复 | 第二模型变体（无第二模型时 BLOCKED） |
| L03 | FAIL | PASS（fresh evidence ＋ recheck boundary） | 人工接手后重新读取 | — |
| L04 | BLOCKED | PARTIAL（重绑与不重复写入成立；完成门归属未复验） | 重启后同一运行身份重绑、一次写入、一次读回 | 干净重跑：无 unverified 步骤、目标只结算一次 |
| L05 | BLOCKED | PASS（变体 C：输入缺失且答案不可推断） | 恢复后 `read` ENOENT → 声明 blocked、`user_ask`、`flow/end reason=blocked`；目录 0 文件，无伪造输出；目标停在 `waiting-condition` | 结算未持久化窗口（按计划记 BLOCKED，由受控故障注入覆盖） |
| L06 | FAIL | PASS | 取消后不复活、恢复入口收敛 | — |
| L07 | FAIL | 行为层 PASS（修订先于写入；`initial-result.txt` 未写、`revised-result.txt` 已写并读回）；结算层 FAIL（完成门两次 rejected，Flow 未结束） | 修订窗口内的行为适配 | 被替换计划的旧步骤仍阻塞完成门；结构化修订；双窗口竞争 |

## S 组

| 场景 | 历史结果 | 最近结果 | 证明范围 | 剩余变体 |
| --- | --- | --- | --- | --- |
| S01 | PASS | PASS | off 模式忽略真实外观变化 | — |
| S02 | PASS | PASS | respond 模式不自主发言 | — |
| S03 | BLOCKED（无公开静默时段心跳路径） | 未运行 | — | 公开入口 |
| S04 | PASS | PASS | 每日预算门 | — |
| S05 | PASS | PASS | 冷却门 | — |
| S06 | PASS | PASS | 忙碌门 | — |
| S07 | PASS | PASS | 工作 Flow 不被外观变化抢占 | — |
| S08 | BLOCKED（无活跃公开任务） | 未运行 | — | 公开任务 |
| S09 | BLOCKED（语音 provider 401） | 未运行 | — | 健康语音 provider |
| S10 | BLOCKED（无公开无会话路径） | 未运行 | — | 隔离会话删除策略 |
| S11 | PASS | PASS | 无刺激门 | — |
| S12 | PASS | PASS | 新外观刺激产生有效 silence | — |
| S13 | FAIL（重复变化仍进入第二次决策） | PASS（受控 31 分钟窗口） | 同值跨轮去重、变化值仍可用 | 真实 30 分钟窗口 |
| S14 | PASS | PASS | 真实完成来源 | — |
| S15 | PASS | PASS | 真实失败来源 | — |
| S16 | BLOCKED（无可分享已审记忆） | 未运行 | — | 有效候选 |
| S17 | BLOCKED（无 M02 纠正事实） | 未运行 | — | 有效候选 |
| S18 | BLOCKED（journal 未过期） | 未运行 | — | 超过过期阈值的真实旧活动 |
| S19 | PASS | PASS | 低重要性活动只沉默 | — |
| S20 | PASS（用户算术答案赢得竞争） | PASS（竞争回归） | 静默分支与受控延迟 speak 竞争 | provider 延迟的真实 speak |

## V 组

| 场景 | 历史结果 | 最近结果 | 证明范围 | 剩余变体 |
| --- | --- | --- | --- | --- |
| V01 | FAIL（形状被消费，可见文本漏读） | PASS（重建后复测） | 形状、颜色、背景与可见文字全部正确；该会话零工具调用、零记忆注入，文字只能来自图片 | — |
| V02 | FAIL（陈旧帧守卫通过；停止检查点不可用） | PARTIAL（取消检查点、受控 capture failure、持久 journal） | 单张预览、单个 `image_url`、`turn/end: aborted`、磁盘 journal 完整 | 重启/导出边界；新会话中失败附件不可复用 |
| V03 | FAIL（视觉活动通过，新会话召回为空） | PASS（聚焦运行） | 视觉活动、来源链接、跨会话检索 | — |

## K 组

| 场景 | 历史结果 | 最近结果 | 证明范围 | 剩余变体 |
| --- | --- | --- | --- | --- |
| K01 | PASS | PASS | 提交与未审核不可用 | — |
| K02 | BLOCKED（设置 UI 不暴露源码/自测） | PASS（目录流程） | 源码与自测审阅、哈希绑定 | 工作区续接 |
| K03 | BLOCKED（K02） | PASS（三次真实调用） | `['a','b']`、`[]`、`['猫','狗']` | 收益对照 |
| K04 | BLOCKED（K02） | PASS（重建后复测：`['a',3,null]` 被拒、`[' a ','b','a','']` 返回 `['a','b']`）；早先 FAIL 保留 | 输入契约在沙箱执行前生效 | — |
| K05 | BLOCKED（K02） | PASS（重启复用） | 审阅、源码、注册与 muscle 关系保留 | — |
| K06 | BLOCKED（K02） | PASS（源码变化重新审阅） | 哈希失配阻止旧批准 | — |
| K07 | BLOCKED（K02） | PASS（隔离、退役与生命周期恢复） | 队列、工具面、提示注入一致 | 两窗口并发点击 |

## R 组

| 场景 | 历史结果 | 最近结果 | 证明范围 | 剩余变体 |
| --- | --- | --- | --- | --- |
| R01 | FAIL（导出闸门） | PASS | 138 条目、7 个业务域、凭据排除、outbox hold | 写入/抽取进行中导出 |
| R02 | BLOCKED（无 R01 ZIP） | PARTIAL | staging、relaunch、`effectsHeld=true`、回执 complete | 未认证时原 owner 索引不可见，需账户契约决定 |
| R03 | BLOCKED（无恢复 profile） | PARTIAL | 原始 owner 数据存在 | 重新认证或安全 remap 后的语义对照 |
| R04 | BLOCKED（无恢复 profile） | 未运行 | — | adoption 后不重启即可调度 |
| R05 | BLOCKED（无恢复 profile） | 未运行 | — | 恢复技能、embedding、缺失凭据 |
| R06 | BLOCKED（无同步后端） | PARTIAL（本批） | 断线错误可见、队列保留、重连清空、本地事实可召回 | `insert`/`delete` 次序、tombstone 不复活、重启变体；新发现 update 先于 insert 静默丢数据 |
| R07 | BLOCKED（无 R01 ZIP） | PASS（坏包拒绝） | 校验失配与缺失条目被拒，原 profile 不变 | 导入中途终止 |

## 检查范围对齐

复核发现 5 指出修复文档所说的「仅排除 short-scenarios」与实际不符。实际范围是：

- `docs/fork/evidence/short-scenarios/**`（哈希绑定的验收产物，保留原始字节）
- `.zcode/**`
- `skills/acc-20260909-dedupe/**`

保留原始字节是合理的；本文件只补齐登记范围，不改写产物。

## 未因本文件改变的事项

- 原始 62 项计数仍是 22 PASS / 18 FAIL / 22 BLOCKED。
- R02/R03 仍以 PARTIAL 为准，不把持久化存在当作 UI 可用。
- K04 仍是 FAIL；本批的源码修复需要重建 Electron 后复测。
- 每个新增 PASS 都只证明其「证明范围」一列写明的部分，不扩展为整个场景。

## S 组更新（2026-09-10）

本轮把 S 组原先 BLOCKED 的多数项跑通，逐条证据见 [S03-S18-recovery-20260910.md](./S03-S18-recovery-20260910.md)。

| 场景 | 2026-09-10 结果 | 说明 |
| --- | --- | --- |
| S03 | PASS（含结构性偏差） | 静默窗口内零心跳、零模型调用；真实外观变化不触发考量。`quiet-hours` 门本身无公开可达路径，单列偏差 |
| S08 | 仍 BLOCKED | `tasks=0`、`focusedModeEnabled=false`；active 任务只能由 server channel 的插件 `task:start` 产生，仓库内无发布方 |
| S09 | 仍 BLOCKED | 语音 provider 上游 401；Electron `speechSynthesis` 无本地语音，无真实播放可测 |
| S10 | PASS | 空 profile + 自主模式：`life/heartbeat gate=no-session`，UI 显示「没有活动会话」，预算 0/24 |
| S16 | PASS | 新批准的有效记忆进入候选（`refs` 含 `memory:d5e701eb…`），决策为 `note`，文本自然 |
| S17 | **FAIL（新缺陷）** | 纠正后旧事实失效正确，但有效事实因缺 `sourceContext` 进不了候选；见 open-findings 第 6 条 |
| S18 | PASS（含口径偏差） | 20 小时前的完成类事件未被当作「刚刚发生」；带时间戳的陈旧候选走 `stale-stimulus`。未做真实 6 小时停机 |

这条更新不改动上表的「历史结果」计数，也不把 S03/S18 的偏差算作完全通过。

