# 2026-09-09 修复批独立复核

本次复核对象为 [修复记录](./acceptance-repairs-20260908.md)、相关实现、回归测试及 ACC-20260907-01 的追加证据。没有调用真实模型，没有操作 CDP 9250，没有修改用户 profile、产品代码或原验收登记。

结论：修复方向基本正确，可以继续收尾；当前还不满足全量验收通过或长期观察准入条件。模型额度不足只阻塞依赖模型的检查，不能代替产品缺陷的判断。下一批应集中处理恢复所有权、技能输入契约和证据口径，不宜继续扩展功能。

## 需要处理的发现

### 1. 技能输入校验会静默忽略未支持的约束

代码位置：[input-validation.ts](../../packages/skill-forge/src/input-validation.ts)、[skills.ts](../../packages/stage-ui/src/stores/skills.ts)。

`validateToolInputSchema()` 检查部分关键字，但不拒绝其他约束；`validateToolInput()` 也不执行这些约束。提交、注册和执行都使用这套校验，因此模型收到的 Schema 可以比执行边界更严格。

本次直接调用生产纯函数复现：对象属性 `items` 声明为字符串数组，并设置 `uniqueItems: true`。Schema 校验返回 `undefined`；输入 `{ items: ['a', 'a'] }` 的校验也返回 `undefined`。这不是外部模型失败。

另一个代码边界是 `executeSkill()` 使用 `input ?? {}`：显式 `null` 被转换为空对象。对没有必填字段的对象 Schema，它无法履行“拒绝非对象输入”的描述。

应先明确支持的 Schema 子集，并拒绝无法执行的断言关键字，或使用已评估的完整校验方案。不要继续零散补关键字后宣称完整 JSON Schema 校验。补测应通过提交及 `executeReviewedSkill()`，确认非法输入不会到达沙箱、合法输入仍可执行。现有 K04 字符串数组混入数字的回归通过，不能覆盖上述情况。

### 2. 恢复后的目标修改存在所有权校验缺口

代码位置：[chat.ts](../../packages/stage-ui/src/stores/chat.ts)、[chat-orchestrator-runtime.ts](../../packages/core-agent/src/runtime/chat-orchestrator-runtime.ts)、[long-goals.ts](../../packages/stage-ui/src/stores/modules/long-goals.ts)。

这是静态代码发现，尚未执行真实副作用复现：

1. `resumeFlowAfterRestart()` 重建的 options 没有 `planId`；runtime 保留传入的 options。
2. `authorizeFlowToolExecution()` 在没有 `planId` 时，只通过当前 `running` 目标的 `activeRun` 反查目标。
3. 修改目标会清除旧运行的所有权。此时反查不到目标，代码按 `!plan` 返回允许。
4. `wrapFlowTools()` 对已结束的 Flow 仍会执行通过授权的工具。因此恢复后旧 provider 响应迟到时，不能仅凭“Flow 已结束”证明旧写入被阻断。

当前核心回归用注入的 authorizer 验证拒绝分支；长期目标浏览器回归用模拟的 resume 验证结算。两者没有联测上述真实反查路径。

下一步优先用隔离回归覆盖“重启恢复 → 修改约束 → 旧写入回调迟到”，要求旧工具执行次数为零。修复应保留持久的目标身份，并在所有权丢失时明确拒绝，不能只从当前 activeRun 推断旧运行身份。另补 `waiting-user` 状态重启；现有 `recoverRunningGoals()` 只选择 `running`。

### 3. V02 对自动化证据的描述超出了测试覆盖

现有 [mirror-snapshot.test.ts](../../packages/stage-ui/src/stores/mirror-snapshot.test.ts) 只有捕获函数抛错后返回 `null` 的回归；它没有先生成帧，也没有验证帧释放、第二次请求、附件状态或重启导出。

[V02 记录](./evidence/short-scenarios/ACC-20260907-01/V02-vision-cancel-cleanup.md) 的“temporary frame is released”与“failed frame is not available to the next request”尚不能由这项测试证明。可以保留捕获失败降级 PASS，以及既有真实取消/日志落盘 PASS；清理和后续请求隔离继续记为待验证。还要区分镜像工具临时帧和聊天上传附件，两条路径不能互相替代。

### 4. M07 已证明一次命中，尚未证明新会话首问召回

本次只读核对了原 profile 下的指定验收 journal：

- `05b386832dcc569d71e23cd05fcc7536.jsonl`，会话 `ihapa7PsW4DmImuDX9xvW`：`seq=5` 的首轮检索为 `memoryIds: []`；同会话再次询问后，`seq=15` 才命中 `17edcfbe-6195-4369-a2de-d37f9623afca`。
- 关闭记忆的会话 `Z8zjfXAZEPHtkWBFFr-T1`，`seq=5` 为空。
- V03 会话 `SRKUxO_1l_Kj3SPpC76u-`，首轮 `seq=5` 命中 `4c211389-4f6a-45d1-91ee-571a592624c2`，与追加记录一致。

不能据此认定 M07 首轮失败一定是检索缺陷：还需核对记忆批准和首轮请求的先后顺序。当前可接受“来源链与记忆开关的局部证据”，不可把同会话重试当作全新会话首问。后续先批准并记录时间，再建立新会话，用相同问句配对开关记忆；保留请求、检索、回答和工具调用，避免工作区检索替代记忆。

### 5. 汇总文档需要统一当前状态

- D05/D06 在 [runtime-repair](./evidence/short-scenarios/ACC-20260907-01/runtime-repair-20260908.md) 已有完整超时、迟到裁决、普通聊天问题卡及跨会话隔离的追加 PASS。9 月 9 日汇总又称这些仍未执行。应保留历史 FAIL，同时链接后来 PASS；只有后续实现变化影响相关路径时才安排有理由的回归。
- R02/R03 以 [最新恢复记录](./evidence/short-scenarios/ACC-20260907-01/R01-R02-R07-retest-20260909.md) 的 PARTIAL 为准。数据存在，未登录的恢复 profile 无法显示原账户索引；不能把持久化存在当作正常 UI 可用。
- K05–K07 已有部分真实 PASS，新增两窗口并发或新实现复测应单独标识，不能笼统写成从未通过。
- lint 实际还排除了 `.zcode/**` 和 `skills/acc-20260909-dedupe/**`；修复文档所说“仅排除 short-scenarios”需要同步。保留哈希绑定产物原始字节是合理的，但应完整登记范围。

这些是证据汇总与覆盖范围问题，不是发现了伪造验收。原始 FAIL、BLOCKED 和追加运行均应保留。建议每个场景维护“历史结果、最近构建结果、证明范围、剩余变体”四列。

## 下一批顺序

| 时机 | 工作 | 关闭条件 |
| --- | --- | --- |
| 现在 | 修复技能 Schema 契约；复现并修复恢复后旧写入授权 | 非法参数不执行；旧约束写入不执行；合法调用和当前运行继续可用 |
| 现在 | 补 V02 两条图像路径的失败和下一请求测试；补 waiting-user 恢复 | 帧与附件状态有明确清理断言；恢复等待不会丢失所有权 |
| 现在 | 对齐验收汇总，明确恢复账户契约 | 保留原 owner 并要求重新登录，或另行设计显式迁移；不自动把账户改为 local |
| 模型恢复后 | 一次非空恢复/adoption 链覆盖 R02–R05 与调度唤醒 | 正常 UI 可见数据；adoption 后恰好一个调度运行；原 profile 不变 |
| 模型恢复后 | L04/L05/L07 故障与修改约束组合 | 相同运行身份可追溯；旧运行无重复副作用；新证据完成门通过 |
| 模型恢复后 | M07 新会话首问配对、S20 真实迟到 speak、V02 运行时尾项 | 按原场景行为通过，局部回归不代替完整场景 |
| 独立环境具备后 | R06 后端断线恢复、M08 第二账户 | 使用真实隔离环境；环境缺失继续 BLOCKED |

不建议把“恢复模型额度”放在所有剩余工作的前置条件。先完成离线缺陷和验收口径，再集中跑必要的真实调用，可以减少重复消费。现在也不宜只因某个定向记忆查询命中就调整整体检索阈值。

## 本次执行检查

以下均未使用真实模型：

- core-agent 编排、authority gate、evidence gate、flow completion：4 文件，134 项通过。
- stage-ui life-mode、mirror-snapshot、skills、plans、data-restore、journal、memory：7 文件，93 项通过。
- 隔离浏览器 long-goals、skills、data-backup、DuckDB snapshot：4 文件，14 项通过。
- Electron coding-host 与 long-goal：2 文件，12 项通过。
- 合计 253 项通过。浏览器输出 DuckDB 依赖 sourcemap 警告，各命令退出码均为 0。
- 技能校验纯函数复现确认未支持约束被静默忽略；不计入通过测试数。
- 全仓按根脚本同范围串行类型检查通过：56 个工作区项目，退出码 0。
- `corepack pnpm lint` 通过，退出码 0，保留既有警告；文档相对链接检查通过。

这些结果证明当前已覆盖的回归通过，不代表上文未覆盖的场景通过。主实例状态沿用现有记录，本次未连接主实例重新验证。
