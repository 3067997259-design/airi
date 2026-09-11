# R04 复验：adoption 后的调度唤醒（2026-09-10）

- 状态：FAIL。adoption 释放了 effects hold，但恢复后的目标**没有进入调度**，「立即运行」也无任何作用。
- 恢复副本 P''：`restores\restore-7IF4GT`
- 契约：R03 用「要求重新登录」；R04 要求「不重启即安装 wake consumer，目标启动一次有界 Flow」

## 步骤

1. 在 P'' 里完成正常登录（R03 已验数据可见）。
2. 在 P'' 里重新配置 provider。
3. 点击 `使用恢复的 profile`（adoption）。
4. 在两张目标卡上各点一次 `立即运行`。

## 观察

| 检查点 | 实际 | 结果 |
| --- | --- | --- |
| adoption 释放 hold | `restore-state.json` → `"effectsHeld": false` | ✅ |
| 调度器持久状态 | P'' 的 `long-goals.json` = `{"schedules": []}` | ❌ 没有任何目标被排入唤醒 |
| 等待到期自动跑 | 无 `goal/update`、无 `flow/start` | ❌ 不会触发 |
| `立即运行` | 两次点击后，P'' 全部 journal 的**最新写入时间仍是 13:10:11**（恢复时刻），没有任何新事件 | ❌ 点击无作用 |
| 有界 Flow 次数 | 0 | ❌ |

P'' 里能搜到的 `flow/start` 全部来自归档带进来的**历史会话**（trigger 为 `command`/`tool`，内容是很早的对话），不是本次点击产生的。

## 判断

R04 的关闭条件「leader 安装 wake consumer，目标启动一次有界 Flow；不能只看到 `effectsHeld=false`」**未满足**。当前状态正是场景明确警告的那种情形：只看到 hold 被释放，调度没有任何动作。

可能的方向（供外部模型定位）：

1. adoption 后是否真的在 leader renderer 里注册了 wake consumer？注册点是否只在「目标创建/转换」时触发，而没有覆盖「恢复后已存在的 `waiting-condition` 目标」？
2. 主进程 `long-goals.json` 的 `schedules` 为什么是空的——恢复的 `PlanState.longGoal.nextReviewAt` 有没有被重新排程？还是恢复流程刻意不排程、等第一次用户触发？
3. 「立即运行」按钮的点击链路是否因为恢复副本缺少某些上下文（例如 owner/session 绑定、coding host root）而静默返回？UI 上按钮可点但没有反馈也没有日志，这本身就是可观测性缺口。
4. 恢复后的目标 lifecycle 是 `waiting-user`（卡片显示「需要输入」），而 `handleWake` 对非 `executable/waiting-condition` 的目标会 `unschedule` —— 是不是「立即运行」先被这条规则挡掉了？

## 附带观察

- R03 的契约缺口（未登录时显示全新 onboarding 而非「已恢复，请登录」）仍然有效，见 [R02-R03 复验记录](./R02-R03-retest-20260910.md)。

## 复位

原 profile 未受影响；P'' 停在原地（`effectsHeld=false`）。
