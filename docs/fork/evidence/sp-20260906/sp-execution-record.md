# SP-1 至 SP-3 执行记录（2026-09-06）

## 范围

本次先完成 `docs/fork/social-presence-plan.md` 中可在现有架构内落地的代码缺口，再统一构建和验收。SP-5 的条件性媒体扩展没有启用；SP-4 未启动游戏或真实共同活动，因此不宣称行为切片通过。

## 代码结果

- SP-1：记忆刺激要求当前用户/角色作用域、来源上下文、非 pending/rejected/superseded；共享 reaction、任务完成/阻塞进入有界活动投影；按 `noveltyKey` 去重并使用 `life/decision.consideredThroughSeq`；过期候选以 `stale-stimulus` 和 `discarded` 记录消费。
- SP-2：社交心跳复用现有聊天忙碌、语音播放查询、Flow/focused 和单飞状态；新增门控原因沿用生命模式状态页，不增加新的设置旋钮。
- SP-3：镜像图像只留在单一一次性临时帧槽；新调用覆盖旧帧，失败/取消/下游异常、`prepareStep` 注入后和 `dispose` 都释放；持久工具结果只保留文字状态。

## 检查与构建

| 检查 | 结果 |
| --- | --- |
| `apps/stage-tamagotchi` life-mode Vitest | 19/19 passed |
| `packages/stage-ui` life-mode + mirror-visual Vitest | 20/20 passed |
| `pnpm -F @proj-airi/core-agent build` | exit 0 |
| `pnpm -F @proj-airi/stage-ui typecheck` | exit 0 |
| `pnpm -F @proj-airi/stage-tamagotchi typecheck` | exit 0 |
| `pnpm typecheck` | exit 0；56 个 workspace 项目完成 |
| `pnpm lint` | exit 0；仅仓库既有 warning |
| `pnpm -F @proj-airi/stage-tamagotchi build` | exit 0；main/preload/renderer 完成 |

构建标识：

- `apps/stage-tamagotchi/out/main/index.js` SHA-256：`AAE2201ADE9FCDD3026CD6623DB3D9726F5BEA1C8DD819CCFE25BC1A12E74B01`
- `apps/stage-tamagotchi/out/renderer/index.html` SHA-256：`5740C700C2E98E77026E67CE93B6243688667C11D653BBEC219A0E81410264B3`
- `packages/core-agent/dist/index.d.mts` SHA-256：`BD406B59A1E8A7333DDA901820ABA0F31D91694C32572BB3596ABE07102960A4`

## agent-browser 生产验收

- Electron 命令使用构建产物目录 `D:\airi\apps\stage-tamagotchi`，CDP `9250`，真实 profile `C:\Users\86130\AppData\Roaming\@proj-airi\stage-tamagotchi`。
- raw `/json/list` 确认 leader main、settings follower `#/settings/modules/life-mode` 和 chat follower `#/chat` 均来自 `out/renderer`。
- agent-browser 打开生命模式设置页，确认状态卡、模式、心跳间隔、每日预算、冷却、静默时段和最近考量可见；切换到“自主”后状态更新，点击“测试心跳”显示“测试心跳已发出”并更新最近心跳；随后恢复为“关闭”。
- agent-browser 打开 chat follower，确认现有长期目标卡、消息区域、发送控件和输入框可见。
- 测试心跳未出现公开消息或最近决策；当前生产窗口没有为该 follower 建立可供 leader 社交轮消费的活动会话，因此不把这次 UI 测试记为真实 provider 决策通过，也不宣称 SP-0 的 20 刺激推广门或 SP-4 共同活动通过。

## 未覆盖项

SP-0 的隔离双窗口 revision/重启、三种真实 self_decide 决策、20 刺激行为门；SP-2 的长时间音频/用户插话指标；SP-3 的真实同模型像素可见性；SP-4 的 Minecraft/棋类/共同工作完整行为切片，仍需后续真实场景证据。
