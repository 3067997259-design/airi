# AIRI 主动交流与共同活动执行计划

## 2026-09-08 验收后代码审查与续批

最新证据：[S07–S20](./evidence/short-scenarios/ACC-20260907-01/S07-S20-social-stimuli.md)、
[登记表](./evidence/short-scenarios/ACC-20260907-01/run-register.md)。SP-0 仍未完整通过。
有效 silence 可以满足单个允许考量的刺激，但不能代替 speak/note/silence 三分支整体覆盖。

### SP-0/2：跨轮去重可以开始修复

S13 已复现第二次考量，没有重复发言。[life-mode](../../packages/stage-ui/src/stores/modules/life-mode.ts)
只在当前候选内按 noveltyKey 合并，跨轮只排除 consumedRefs。相同变化产生新事件 ID 后仍可进入模型。

- [ ] 建立有界的跨轮语义去重，明确消费时间与恢复语义，避免对某个外观值永久禁言。
- [ ] 重复外观事件不再次消耗模型考量；真实新变化、合理间隔后再次发生和切换会话分别检查。
- [ ] 保存首次 S13 FAIL，修复后分别记录调用次数、决定和最终发言次数。

### SP-2：迟到发言竞争需要补测并明确发布条件

S20 只命中 silence 分支，未验证迟到 speak。[life-mode](../../packages/stage-ui/src/stores/modules/life-mode.ts)
收到 speak 后直接 publishAssistantMessage，缺少明显的发布前再次门控。
补“考量开始 → 用户输入/语音/工作开始 → speak 返回”的受控回归和真实交互。
明确过期决定应丢弃还是延后，并记录原因；不能仅靠新 prompt 要求模型克制。

### SP-0/1/3：修正补测方法与依赖

- S03：静默时段若由 scheduler 直接推迟心跳，验“期间无考量，结束后按规则恢复”，不强求制造 quiet-hours 事件。
- S08：先建立真实 focused 条件；S09 先解决测试语音上游 401。环境阻塞不记门控缺陷。
- S16/S17：等待 MQ/PC 的有效可分享事实前置，不造事实冒充通过。
- S18：使用真实达到过期阈值的测试 journal，不改机器时钟，不借用无关日用经历。
- V01/V02：分别补文字识别与停止清理时点；V03 新会话回顾先接 MQ 空回答定位。
- dreaming 主体隔离按 PC-0/2 续批实施；SP-1 只消费当前主体的有效素材。

以下保留原计划与历史执行记录。

日期：2026-09-06。状态：SP-1/2/3 代码、统一构建与基础生产 UI 验收已完成；SP-0 推广门和 SP-4 行为切片待真实场景。
归属：[七维升级总索引](./upgrade-roadmap.md) 方向五。优先级：P1，SP-0 属于日用基线。

## 1. 目标与基线

目标：她能依据真实经历，在合适时机开口，也能明确选择私记或沉默。
共同活动逐步连接感知、表达与记忆，不以提高开口次数作为成功标准。

[CONSIDERATION](./CONSIDERATION-PLAN.md) 批次 0–4 已实施，批次 5 真机与当前模型行为验收仍待完成。
当前契约使用 self_decide 的 speak、note、silence；旧 self_speak/self_note 的考量设计不作为新增实现依据。
当前有 mirror-visual 同模型续接代码，但不能仅凭“有图片载荷”宣告主模型已看到像素。

## 2. 旧批次承接

| 原计划 | 后续归属 |
| --- | --- |
| CONSIDERATION 批次 5、§16 | SP-0，原推广门完整保留 |
| LIFE M4-L0 观测、L1 闯入记忆分享 | SP-0/1 |
| LIFE M4-L2 作息与在场 | SP-2 |
| LIFE M4-L3 多源生活与里程碑 | SP-4；工作执行转 LG，不恢复 tick 工具轮 |
| MEMORY-DESIGN 自动 dreaming 与情绪反射验收 | SP-1 与 MQ-2，私有维护不冒充公开经历 |
| MIRROR 步骤 1–3、P0 和真机清单 | SP-3 核对并完成像素、文本回退和清理验收 |
| MIRROR 步骤 4、步骤 5、图像长期记忆 | SP-5 条件分支 |
| ATTENTION §9.1、§10.5 生产者迁移 | DR-2 验既有路由，SP-4 接一个活动生产者 |
| WIRING §1 MC 沙箱切换；MAINTENANCE P3.5 | SP-4 保留推迟条件，不为共同活动强制先合并沙箱 |
| reliability-and-roadmap §4.4 | SP-2 与 MD-3 明确注意力和资源分配 |

## 3. 所有权与边界

主进程拥有 heartbeat、配置、revision、claim、预算和冷却。
leader 构建有界刺激并请求决定；follower 只读快照和提交设置命令。
一个 heartbeat 最多对应一次模型决定，一个 speak 最多发布一次消息和一次语音。
note 与 silence 不发布气泡或 TTS；协议错误不能记为自然沉默。

刺激来自有类型、有来源的事实投影。原始工具输出、私记复读和未审核事实不能直接成为刺激。
社交考量不挂工作工具、不推进 Flow 或 goal。LG 负责工作，SP 只消费它公开的事件。
本批优先维持活跃 Flow 和 focused 对社交的门控。工作阻塞报告由任务通道承担。

代码入口：

- apps/stage-tamagotchi/src/main/services/airi/life-mode/ 与 src/renderer/bridges/life-mode.ts。
- packages/stage-ui/src/stores/modules/life-mode.ts、tools/life/self-tools.ts、stores/chat.ts。
- packages/stage-ui/src/stores/speech-runtime.ts、speech-output-control.ts、mirror-visual.ts、mirror-diagnostics.ts。
- packages/stage-ui-live2d/src/tools/mirror-tools.ts 与现有舞台捕获端口。
- packages/stage-ui/src/stores/character/orchestrator/ 与各 integration 的事件生产端。

## 4. 实施批次

### SP-0：完成社交考量的原验收批次

前置：DR-0、MD-0；复用 CONSIDERATION 已实现代码。

1. 使用隔离 profile 验证设置 follower 与 leader 的 revision 一致。
2. 重启后保留下次 heartbeat；逾期只补一次；无刺激、busy 或不支持工具时不计决定额度。
3. 用受控 provider 分别返回 speak、note、silence、无效参数和缺失决定。
4. 验证气泡、TTS、journal 的数量与对应 ID，覆盖取消、超时和重复回执。
5. 使用当前模型运行固定 20 刺激：高显著 10 条、低显著 10 条。

原推广门：有效 self_decide 至少 95%；高显著组至少一次 speak；低显著组不能全 speak；所有 speak 有来源；零工作工具调用。
这只证明三种选择可用，不规定生产环境必须达到某个开口比例。

### SP-1：有来源的记忆分享与私有维护

前置：SP-0、MQ-2；共同经历可接 PC-1。

1. 承接 L0 观测，记录刺激出现、被门控、决定和发布的完整链。
2. 承接 L1 分享，只允许有效事实与可分享的真实事件进入候选。
3. 以来源和已消费水位去重，不因重复 tick 或重新摘要再次分享同一事件。
4. 验证 dreaming 在既有空闲、预算和新增事实门槛下触发，想法不自动执行。
5. 不把旧 self_note 直接回灌成新刺激，不把“准备整理”说成“整理完成”。

验收：每句话中的活动自述能指向实际事件；无新内容不调用模型；私记不进入公开消息；事实修订后旧候选失效。

### SP-2：作息、在场与交流时机

前置：SP-0/1；依赖 DR-2 的准确工作状态。

1. 承接 L2，核对现有静默时段、在场和音频状态信号，再选择最小可用来源。
2. 明确用户输入、语音播放、Flow、社交考量与 dreaming 的让步顺序。
3. 对可合并的低优先事件保留有界最新状态，对过期社交候选丢弃并记原因。
4. 用户开始讲话或发送新请求时，核对已有语音中断与消息发布的实际语义。
5. 在设置中复用现有模式与预算入口，展示下一次允许考量的原因，不堆叠新旋钮。

验收：忙时无社交抢占；静默时段、离场和恢复在场的行为可解释；重要工作阻塞仍由任务通道可见。
同时报告重复话题、无效打断、漏报与延迟，不以“沉默更多”单独判定改善。

### SP-3：镜像与表达一致性

前置：SP-0；承接 MIRROR P0，不依赖图像长期记忆。

1. 核对 mirror 捕获、toolCallId、临时槽、prepareStep 与 transcript 清理的当前接线。
2. 用参数文本无法推断的可见特征验证同一主模型在同一用户回合读到像素。
3. 对 text-only 模式验证明确视觉不可用，不能根据工具成功推断看见图片。
4. 覆盖多个工具调用、失败、取消和超时，确认帧不串调用且结束后释放。
5. 检查 gallery、聊天持久化、下一轮附件和记忆输入中没有临时原图。
6. 对正常语音回复检查文本、语音与外观变化的顺序，不用额外动作强行解释错误事实。

验收：视觉能力有真实行为证据，临时帧生命周期符合旧计划；语音只播有效发布内容。

### SP-4：一个共同活动的完整切片

前置：SP-1/2/3、PC-2、MQ-2；涉及跨天目标时追加 LG-3。

1. 从已存在的 Minecraft、棋类或共同工作场景中，按可运行程度选择一个验收对象。
2. 核对该生产者的 context、spark、task 和 reaction 路由，迁移绕过分流的路径。
3. 让她观察一个真实变化、参与一次交互，并按合适时机表达。
4. 将结果形成 PC 的共同经历；新会话能正确回顾，未发生动作不能被声称完成。
5. 若选 Minecraft，先提供真实 Bot 验证渠道；仅在确认 sandbox 语义一致后考虑共享实现切换。

验收：活动事实、表达与记忆连成可追踪链；高频进度不淹没聊天或记忆；用户能停止活动与后续社交。
没有游戏运行环境时，可先用共同工作完成切片，但不能把 MC 待办记为通过。

### SP-5：条件性的媒体扩展

前置：SP-3；各子项有独立用户需求，不阻塞其他批次。

| 旧后续项 | 启用条件 | 验收边界 |
| --- | --- | --- |
| Gemini 原生多模态函数响应 | 兼容路径存在实证缺口或明确需求；新 SDK/REST 方案经调研选择 | 保留调用 ID、流式事件和清理语义，与 P0 对照 |
| 通用 view_image | 有明确读取既有媒体的任务 | 先 gallery 稳定引用；workspace 路径需已有只读二进制端口，不扩大读写边界 |
| 图像长期记忆 | 用户明确需要，保存范围和保留规则由 MD-1 定义 | 支持来源、删除、导出与恢复；临时镜像不自动变持久媒体 |

## 5. 完成定义与执行记录

执行规则见 [总索引](./upgrade-roadmap.md)。SP-0 是原批次的正式验收，不能被人工点击设置页替代。

- [ ] SP-0 机械、三种决定与 20 刺激推广门通过。
- [ ] SP-1 分享来源和 dreaming 边界通过。
- [ ] SP-2 时机、门控与打断记录完成。
- [ ] SP-3 同模型视觉和临时媒体清理通过。
- [ ] SP-4 一个共同活动的行为切片通过。
- [ ] SP-5 条件扩展逐项记录采用或暂缓。

首条执行记录：2026-09-06，先完成 SP-1/2/3 的代码缺口，未进行统一构建、真实 provider、生产 profile 或 agent-browser 验收。

代码实施记录：2026-09-06

- SP-1：`life-mode` 现在只接收当前用户/角色范围内、带来源且非 pending/rejected/superseded 的事实；共享 reaction、完成/阻塞任务进入有界活动投影。候选按 `noveltyKey` 去重，消费水位和来源引用继续落在 `life/decision`；过期候选写入 `discarded` 决策记录并以 `stale-stimulus` 说明原因。旧 self_note/self_speak 和原始工具输出不进入刺激。
- SP-2：复用现有 BroadcastChannel 音频播放状态，在用户发送、语音播放、Flow/focused 和社交考量之间执行本地门控；新增门控原因的 journal/UI 文案，不新增设置旋钮。
- SP-3：镜像帧改为单一的一次性临时槽；新的成功调用清除旧帧，失败/取消/下游异常和 `dispose` 清理所有帧，`prepareStep` 注入后立即释放，持久 transcript 仍只保存文本状态。
- 回归覆盖：life-mode 与 mirror-visual 定向测试通过（20 tests）；`core-agent` 重建后 `stage-ui` 与 `stage-tamagotchi` typecheck 通过；根 lint、typecheck、生产构建和真实 profile 的 agent-browser 记录见 [SP 执行证据](./evidence/sp-20260906/sp-execution-record.md)。完整 SP-0 推广门和 SP-4 行为切片仍未通过。
