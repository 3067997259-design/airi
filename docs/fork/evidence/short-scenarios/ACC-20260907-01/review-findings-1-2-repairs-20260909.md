# 复核发现 1、2 的修复与回归（2026-09-09）

本记录处理 [独立复核](../acceptance-review-20260909.md) 的前两项发现。它只修改产品代码与回归测试，不修改用户 profile、原始验收登记或既有证据。

- 日期：`2026-09-09`
- 运行端：仓库工作树，未重建 Electron（见「剩余验证」）
- 命令：`pnpm -F <包> exec vitest run <路径>`、`pnpm -F <包> typecheck`、`pnpm exec eslint <改动文件>`

## 发现 1 — 技能输入校验会静默忽略未支持的约束

### 复现（修复前）

`validateToolInputSchema` 只检查已知关键字的类型，未知关键字被静默接受；`validateToolInput` 只执行它实现的那部分约束。复核的复现是 `items` 声明为字符串数组并设置 `uniqueItems: true`：Schema 校验返回 `undefined`，`{ items: ['a', 'a'] }` 的校验也返回 `undefined`。

### 修复

- `packages/skill-forge/src/input-validation.ts`
  - 新增 `SUPPORTED_SCHEMA_KEYWORDS`：显式列出校验器理解的子集（结构关键字、值断言，以及 `title`/`description`/`default`/`examples` 等无断言语义的注解）。
  - `validateSchemaNode` 遇到集合外的关键字直接拒绝，不再忽略。
  - 把 `uniqueItems`、`minProperties`、`maxProperties`、`multipleOf` 纳入子集并在 `validateValue` 中真正执行，因此它们不再属于「看起来更严格」的假约束。
- `packages/stage-ui/src/stores/skills.ts`
  - `executeSkill` 不再用 `input ?? {}` 兜底，`null`/`undefined` 会被对象 Schema 拒绝；沙箱调用同样传原始输入。

### 回归

| 文件 | 结果 |
| --- | --- |
| `packages/skill-forge/src/input-validation.test.ts`（新增） | 13 条通过 |
| `packages/skill-forge` 全量 | 4 文件 / 42 条通过 |
| `packages/stage-ui/src/stores/skills.test.ts` | 19 条通过（新增 3 条） |

新增用例覆盖：复核复现的 `uniqueItems` 重复项在到达沙箱前被拒、合法去重输入仍执行；`null`/`undefined` 被拒且空对象 `{}` 仍可执行；提交阶段就拒绝带 `format`、`oneOf` 的 Schema；注解关键字仍被接受。

### 关闭条件

- 非法参数不执行：重复项与 `null` 都在 `executeReviewedSkill` 之前返回结构化错误，`runProgram` 调用次数为零。
- 合法调用继续可用：同一技能在合法输入下仍执行并返回沙箱结果。

## 发现 2 — 恢复后的目标修改存在所有权校验缺口

### 缺口链（复核所列）

1. `resumeFlowAfterRestart()` 重建的 options 没有 `planId`。
2. `authorizeFlowToolExecution()` 在没有 `planId` 时，只通过当前 `running` 目标的 `activeRun` 反查目标。
3. 修改目标会清除旧运行的所有权，此时反查不到目标，代码按 `!plan` 返回允许。
4. `wrapFlowTools()` 对已结束的 Flow 仍会执行通过授权的工具。

### 修复

- `packages/core-agent/src/authority/contract.ts`
  - `applyLongGoalTransition` 在生命周期离开 `running` 而清除 `activeRun` 时，把这条运行记录保留为 `lastRun`，即使它还没有 `endedAt`。中断运行的任务/Flow 身份因此不会随约束修订丢失。
- `packages/stage-ui/src/stores/plans.ts`
  - 新增 `findLongPlanOwningRun()`：按持久运行身份（`activeRun` 或 `lastRun` 的 sessionId/flowId/taskId）解析所属长期计划，只匹配 `horizon: 'long'`。
- `packages/stage-ui/src/stores/chat.ts`
  - `authorizeFlowToolExecution` 在没有 `planId` 时改用 `findLongPlanOwningRun()`。修订清空 `activeRun` 后仍能解析到计划，从而走到既有的 `stale_plan_run` 拒绝分支，而不是落回「无计划即允许」。

### 回归

| 文件 | 结果 |
| --- | --- |
| `packages/core-agent/src/authority/long-goal.test.ts` | 9 条通过（新增 1 条：修订清空 `activeRun` 后 `lastRun` 保留运行身份） |
| `packages/core-agent` authority 全量 | 5 文件 / 51 条通过 |
| `packages/stage-ui/src/stores/plans.test.ts` | 25 条通过（新增 4 条：匹配 `activeRun`、匹配被修订移出的 `lastRun`、忽略会话计划、忽略不同运行身份） |
| `packages/stage-ui` chat 相关 | 11 文件 / 92 条通过 |

### 关闭条件

- 旧约束写入不执行：`activeRun` 被清空后，计划仍由 `lastRun` 解析出来，`goal.lifecycle === 'running'` 且 `activeRun` 匹配的放行条件不成立，返回 `stale_plan_run`。
- 合法调用和当前运行继续可用：`activeRun` 与当前 Flow 完全匹配时仍放行；不属于任何长期计划的普通会话 Flow 仍走 `!plan` 放行分支。

## 剩余验证

两个修复都只改源码。当前运行中的 Electron 实例来自 15:15 的构建，尚未包含这些改动，因此**没有**运行态证据。重建并重启同一 profile 后应补：

1. 提交一个带 `uniqueItems` 的合法技能，确认重复输入被拒、合法输入可执行（K04 的延伸）。
2. 在修订长期目标约束后让旧 Flow 的迟到工具回调到达，确认工具执行次数为零。

这两项列入下一批真实运行，不与本记录的纯函数与 store 回归混为一谈。

## 检查结果

- `pnpm -F @proj-airi/skill-forge typecheck` 退出码 0。
- `pnpm -F @proj-airi/core-agent typecheck` 退出码 0。
- `pnpm -F @proj-airi/stage-ui typecheck` 退出码 0。
- 改动文件 `pnpm exec eslint` 退出码 0。
- 未创建提交。
