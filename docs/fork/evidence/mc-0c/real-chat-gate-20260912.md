# MC-0c 真实聊天 + 完成门真机验证（2026-09-12）

结果：**真聊天下令 PASS；完成门真机核对 PASS**。环境：Electron 应用（leader）+ 真实 provider（`openai-compatible` / `gemini-3.8-flash`）+ 环境 A（客户端桥 25599 / MCP server 25600 / 专用服在跑）；会话 `n1rlqFSVTzYSk1D9ViR4A`，工作回合（`profile: 'work'`，`maxSteps: 12`）。

## 模型实际工具调用（按序列）

1. `plan_update` `{ action: "start", goal: "观察玩家当前状态", horizon: "session", steps: [{ id: "observe", lane: "mcp", intent: "观察游戏内玩家位置与血量", allowedTools: ["game_observe"], expectedEvidence: [{ source: "tool_result", description: "观察回执包含玩家坐标与血量" }], riskLevel: "low", approvalRequired: false }] }`
2. `game_observe` `{}`
3. `plan_update` `{ action: "complete", stepId: "observe" }`

（同一回合同样出现历史流的收尾调用 `read` / `flow_update(done)`，来自会话中先前遗留的 FIX1 任务，与本次验收无关。）

## 回执与完成门

计划 `e772b80d-0951-4671-a5fd-cd252b950a13` 的投影：

```json
{
  "completedSteps": ["observe"],
  "unverifiedSteps": [],
  "evidenceRefs": [{
    "stepId": "observe",
    "source": "tool_result",
    "summary": "{\"status\":\"ok\",\"checked\":true,\"commandId\":\"3752dd16-2d51-49fe-9736-c0287c313b58\",\"endReason\":\"observed\",\"finalSnapshot\":{\"position\":{\"x\":15.44,\"y\":81,\"z\":-1.50},\"health\":20,\"food\":20},\"postCondition\":{\"kind\":\"observed\",\"target\":16,\"actual\":16,\"met\":true}}"
  }]
}
```

- `checked: true` 的游戏回执（`game_observe`）满足了步骤声明的 `tool_result` 证据：步骤 **completed 且未列入 unverifiedSteps**（无需 rationale 强完成）。
- 模型最终用中文汇报了坐标（约 X 15.44 / Y 81 / Z -1.50，血量 20/20），与实际位置一致。

## 覆盖与限制

- 覆盖：真实 provider 回合、工具面挂载与执行、`checked` 分级证据、完成门核验通过。
- 限制：普通社交回合不会挂载 `plan_update`/`game_*`（工作回合按 `WORK_TURN_TOOL_NAMES` + 计划步骤 `allowedTools` 组装工具面）；本次为显式 `profile: 'work'` 的工作回合。若要让玩家在普通聊天里直接下令，需要把游戏工具加入发送侧工具引用（`InteractiveArea` 的 send 工具列表）或做成显式工具选择，属产品面后续项。
- 未覆盖：raw（未核对）游戏回执在真机中被拒（单测覆盖，真机仅产生 checked 回执）。
