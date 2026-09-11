# L07 修订窗口重试（2026-09-09）

- 状态：未覆盖。本轮的目标在修订消息到达前已经完成，修订窗口再次错过。
- 日期：`2026-09-09`
- 运行端：`@proj-airi/stage-tamagotchi`，CDP `9250`
- 会话 journal：`40ae9ae5f845754a6add46f6ce4c8325.jsonl`
- 夹具：`workspace/L07c-20260909/brief.txt`（`L07C-TOKEN-9E3A71`）

## 本次实际发生的事

1. 发送 `/goal ACC-20260909-L07c：读取 brief.txt，执行一次约 60 秒的前台等待，然后把文件内容写入 initial-result.txt 并读回核对。`
2. Flow `sBiUesRiUMZMoyWyMRUwj` 在 `seq=841` 启动。
3. 正常路径全部走完：
   - `seq=845` `read brief.txt`；
   - `seq=861` `date && sleep 60`；
   - `seq=879` `write initial-result.txt` = `L07C-TOKEN-9E3A71`；
   - `seq=895` 读回；
   - `seq=906` `flow_update done`；`seq=928` `flow/end reason=done iterations=2`；`seq=1008` `goal/update completed`。
4. 修订消息在 `seq=838` 之后才发出，而流程在等待结束后立即完成了写入与读回，所以没有进入「修订先于写入」的窗口。

这条结果与原始 [L07-revision-and-competition.md](./L07-revision-and-competition.md) 的失败模式同类：**写入先于修订**。L07 仍待覆盖。

## 本轮的运行态摩擦（需要先解决）

- `agent-browser` 在本轮多次在产出结果后不退出，并出现长时间无输出：`snapshot -i` 在主窗口和聊天窗口都曾超过 200–400 秒不返回。因此聊天窗口只能用 CSS 选择器 `[i-solar\:chat-line-line-duotone]` 打开，输入框只能用 `textarea` 选择器，`press Enter` 需要重复一次才生效。
- 期间清掉 14 个残留的 `agent-browser` 守护进程后恢复正常；`tab new` 在 Electron 下不被支持（`Target.createTarget: Not supported`）。

## 下一轮的设计修正

1. 把等待时长从 60 秒提高到 **300 秒**，给修订留出足够窗口。
2. 观察到 `bash sleep` 的 `tool/call` 后**立即**发送修订（提前把修订文本准备好，避免现场组装）。
3. 修订用 `/goal` 形式触发结构化约束修订，观察 `goal/update` 的 `constraintVersion` 递增、Flow 被中断，以及旧运行是否仍尝试写 `initial-result.txt`；重点核对 `initial-result.txt` 是否被创建（预期不被创建）。
4. 双窗口「立即运行」竞争部分仍需两个窗口，可与修订部分分开记录。
