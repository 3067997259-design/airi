# LG-3 与 LG-4 局部执行证据（2026-09-06）

## 环境

- 运行端：构建版 `stage-tamagotchi` Electron。
- 构建命令：`pnpm -F @proj-airi/stage-tamagotchi build`，退出码 0。
- 用户数据：`C:\Users\86130\AppData\Roaming\@proj-airi\stage-tamagotchi`。
- CDP：端口 `9250`。
- 调度 IPC：端口 `6221`。
- 验收工具：`agent-browser`。
- provider/model：使用现有用户 profile 中的已配置值。记录不包含凭据。
- 运行实例：旧 Electron 已关闭。构建完成后，使用相同用户 profile 重启。没有使用 dev 或隔离 profile。

## 已覆盖场景

### 真实 provider 与长程目标创建

发送只读对话，得到 `PROFILE-CHAT-OK`。这证明构建版窗口可以使用现有 provider 配置。

发送 `/goal` 后，模型调用 `plan_update`、`todo_write`、`read` 和 `list`，并创建长期目标。
目标卡显示 3/3 步骤、等待原因和文档证据。工具调用没有写入文件。

### Run now 与一次有界 Flow

结束原有 Flow 后，点击目标卡的“立即运行”。目标重新进入执行路径，并显示“已完成 · 3/3”。
文档证据仍显示在目标卡中。该场景覆盖了真实 provider、构建版 Electron、leader 调度和一次有界 Flow。

### 重启后的目标恢复

关闭并重启 Electron 两次。每次都使用相同用户 profile 和 CDP 端口。
重启后的聊天窗口恢复长期目标卡、3/3 状态和两份文档证据。
这证明目标状态和证据可以跨应用重启保留。

### steering 与用户问题等待

在有界 Flow 运行时发送新的只读要求。聊天界面记录了 `stage.turn.steer-hint`，新的要求没有被静默丢弃。
另一个长期目标进入 `user_ask` 等待，界面显示问题卡和“输入你的回答…”输入框。

### 取消与重启不复活

在 `user_ask` 等待期间发送“取消”，界面记录 `stage.turn.cancel-queued`。
随后停止 Flow。目标卡显示“已取消”。重启 Electron 后，目标仍显示“已取消”，没有恢复 Flow，也没有继续调度。

### 修复后的步骤计数

验收初次发现，修订长期目标的旧步骤完成数会显示为 `3/1`。
回归用例先复现该结果，再限制状态投影只保留当前目标规格中的步骤。
修复后的构建在同一用户 profile 重启后显示“已取消 · 1/1”和“已完成 · 1/1”。

## 未覆盖场景

- 本次 UI 没有直接显示 `constraintVersion`，所以没有用浏览器证据宣称新约束版本递增通过。
- 没有完成真实跨日外部条件切片。
- 没有完成失败恢复切片。
- 没有完成“人工标记完成后重新读取工作区”的完整组合切片。
- 没有完成过期条件复查、多窗口竞争和 PC-2/SP-1/SP-2 回顾表达。

## 结论

本次构建版 Electron 验证了真实 provider、长期目标创建、只读证据、一次有界 Flow、重启恢复、问题等待、steering 记录和取消后的不复活。
LG-3 和 LG-4 仍保持“部分验收”状态。上述未覆盖场景完成前，不更新为全部通过。

## 修复验证

- `packages/stage-ui/src/stores/plans.test.ts`：16/16 通过。
- `pnpm -F @proj-airi/stage-ui typecheck`：退出码 0。
- `pnpm -F @proj-airi/stage-tamagotchi typecheck`：退出码 0。
- `eslint` 对本次修改的两个 `stage-ui` 文件：退出码 0。
- 仓库级 `pnpm lint` 仍受工作树中已有的 `packages/stage-ui/src/stores/modules/life-mode.ts` 错误影响。本次没有修改该文件。
- 仓库级并行 `typecheck` 在 120 秒限制内未完成；已完成的包显示为 `Done`，两个受影响包单独检查通过。
