# MC-0a 应用内 game-host 验证记录

日期：2026-09-11 21:1x（本地时间）。结果：**PASS（应用内链路）**。环境：日常 profile、构建版 Electron、CDP 9250；单人世界 1.21.1（integrated server）。

## 方法

- 重建 `@proj-airi/stage-tamagotchi` 后以 `APP_REMOTE_DEBUG=true`、`APP_REMOTE_DEBUG_PORT=9250` 启动构建版。
- 新增 devtools 探针页 `pages/devtools/game-host.vue`，挂载时在渲染端暴露 `window.__AIRI_GAME_HOST_SMOKE__`（applyConfig / getStatus / getConfig / observe / toolNames）。
- 用 `D:\.airi-smoke\cdp-eval.cjs` 在主窗口执行。

## 结果

| 检查 | 结果 |
| --- | --- |
| 配置并连接 | `applyConfig` → `connected`；身份 `1.21.1 / minecraft:overworld / connection-scoped` |
| 配置视图 | `hasToken: false`（token 不回传）；`allowedTools` 默认只读四项 |
| 应用内观测 `get_self` | 位置 (6.5, 75, -1.5)，维度 `minecraft:overworld` |
| 应用内观测 `get_inventory` | `selectedSlot/hotbar/main/armor/offhand` 齐全 |
| 应用内观测 `get_status` | `minecraftVersion: 1.21.1` |
| 白名单 | `give` 被拒：`game tool is not allowed: give` |
| 零工具面泄漏 | 工具面 50 → 50，`faceChanged: false` |
| spark 退役 | 工具面无 `builtIn_emitSparkCommand`，无 spark 相关名 |
| 非 loopback 拒绝 | `http://example.com/mcp` → `error: game bridge endpoint must be loopback, got example.com`；随后恢复好地址并重新 `connected` |
| 遗产 dormant | `#/settings/modules/gaming-minecraft` 正常渲染，显示「服务已离线」，无报错 |
| stdio 回归 | `#/settings/modules/mcp`：`student-hub RUNNING`（python stdio）。`todoist ERROR` 为 `npx mcp-remote` 外部链路既有状态，与本次改造无关 |

## 备注

- `game-host.json` 已写入日常 `userData`（`...\@proj-airi\stage-tamagotchi\game-host.json`），内容为本地 MCP 地址与空白名单；应用仍保持运行（由本轮启动，CDP 9250）。
- 探针页是 devtools 页面，供后续复测复用；不属于产品 UI（MC-0a 规范允许状态页留到 MC-0c）。

## 未覆盖（NOT-RUN）

- 环境 A（本地 offline 专用服）与环境 B（LAN/自建服）未搭建。
- 1.21.11 移植冒烟与资源测量未执行。
- 真实插件的取消终止、多窗口撤销一致（EP-0 真机项）未在本轮执行。
- 设置页传输表单的逐字段交互走查未做（表单映射由单测覆盖）。
