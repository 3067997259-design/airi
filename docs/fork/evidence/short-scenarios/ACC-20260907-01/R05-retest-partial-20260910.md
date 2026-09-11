# R05 复验（进行中）：恢复技能、embedding 与凭据缺失（2026-09-10）

- 状态：部分完成。技能验证状态已取得关键证据；运行时调用与 embedding / 凭据变体未完成。
- 恢复副本 P''：`restores\restore-7IF4GT`（`effectsHeld: false`，已 adoption）
- provider：用户已在 P'' 重新配置

## 1. 恢复技能的验证状态（关键证据，PASS）

从 P'' 的 `skills/review-queue` 读取恢复后的技能条目：

| 字段 | 值 | 判断 |
| --- | --- | --- |
| `toolId` | `acc-20260909-dedupe` | 恢复成功 |
| `trust` | `reviewed` | 审阅信任级保留 |
| `reviewedHash` | `9103be732a70d335` | 审阅哈希保留（与源 profile 一致） |
| `workspaceRoot` | `D:/airi` | 记录的是**原工作区** |
| **`artifactError`** | **`Artifact verification is pending.`** | ✅ 恢复后被标记为**待重新验证** |

同时 P'' 的 coding root 是：
`...\restores\restore-7IF4GT\workspace` —— **与原工作区不同**。

结论：恢复链路**没有**把技能当成可直接使用，而是标记为待复核，且没有改写 registry 路径去绕过验证。这正是 R05 第一条要求。
「不能加载原工作区的不同文件」这条在状态层面成立：技能记录指向 `D:/airi`，而 P'' 的根是副本工作区，两者不一致时 `verifySource` 的 workspace 比对会拒绝。

## 2. 运行时调用（已取得结果：暴露两条缺口）

在 P'' 会话里发送：`请实际调用 acc_20260909_dedupe 处理 ["r"," r ","s"]，只报告工具返回。`

journal 事件链：

| seq | 事件 |
| --- | --- |
| 4842 | `user/message` |
| 4843 | `memory/retrieved` |
| 4844 | `prompt/supplement-changed` |
| **4845** | **`tool/call builtIn_mcpListTools {}`** |
| **4846** | **`tool/result builtIn_mcpListTools -> []`** |
| 4850 | `assistant/done`：答「工具列表中不存在 acc_20260909_dedupe，当前无法实际调用它。」 |

### 缺口 A：被阻断的原因没有传达给模型

技能被正确排除在工具面之外（`artifactError = "Artifact verification is pending."`），但模型看到的只是「工具列表里没有这个名字」，于是只能说「无法调用」。它**不知道**原因是「待重新验证」，也不知道需要走复核流程。
期望：把阻断理由作为可见信息（工具描述里的工具集说明、或 system supplement 的提示节）告诉模型，而不是让它靠「名字不在列表里」推断。

### 缺口 B：静默回退到已废弃的 MCP 代理元工具

模型为查找一个**自造技能**，调用了 `builtIn_mcpListTools` —— 正是 fork 立项时 M1 要消灭的「MCP 代理元工具」路径（`packages/stage-ui/src/tools/mcp.ts` 的扁平化改造）。它返回 `[]`，既没有帮助也没有报错。

可疑之处：
1. `tool-resolver` 只在「存在 `mcp_*` 运行时工具」时抑制默认元工具；**没有 MCP 服务器时元工具仍然暴露**，于是模型把它当成了通用的「找工具」入口。
2. 该元工具的语义是 **MCP 服务器工具**，与**自造技能**不是同一个面；用它查找技能从接口上就是错的。
3. 结合缺口 A：查不到 → 无原因 → 模型只能报告「不存在」。整条链路对用户来说是「静默失败」。

### 与 MODS 历史的对应

用户指出这正是 fork 立项时修复过的 MCP 调用异常域（M1/M2：扁平化 `mcp_<server>_<tool>`、抑制默认元工具、降级可见化）。本次在恢复副本里复现的是**同一域的一个未覆盖分支**：无 MCP 服务器时的元工具暴露 + 自造技能查找失败时的静默回退。

## 3. 未完成的变体

- **embedding 切换**：通过 UI 切换 embedding source/model → 再问 M02 的不泄露答案探针。期望不混用旧指纹向量、迁移/不可用状态明确。未执行。
- **凭据缺失**：在 P'' 保持未配置时尝试需要模型的动作，期望可解释的未配置提示。本次 P'' 已配置 provider，需要另开一个未配置凭据的副本来做，或临时清空配置（未执行）。

## 待补

1. 重跑 §2 的运行时调用，确认拒绝文案与「未复核不执行」的可见性；
2. 做 embedding 切换变体；
3. 做凭据缺失变体（需要一份未配置凭据的副本环境）。
