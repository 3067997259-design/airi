# 多窗口工具面覆盖修复（2026-09-12）

多窗口验收发现：打开任一 follower 窗口（设置窗）后约 1 秒，leader 的运行时工具面被 follower 的本地状态覆盖，54 个工具（13 MCP + 4 game + 1 plugin + 36 builtin）塌缩为 36 个纯内置工具，`game_*` 全部不可用，MC-0c 多窗口验收被阻塞。关闭 follower 不恢复；重载 leader 有时恢复、有时不恢复。

## 根因（运行时探针实证）

用 Pinia 级探针抓到 follower 启动时序与调用栈：

1. `built-in.ts` 中 `watch(() => lifeModeStore.config.mode, () => refresh())` **没有 leader 门控**。设置窗（`synced-leader=false`，但按 `window-context.ts` 仍运行 full stage runtime）启动时，life-mode 快照同步触发该 watcher。
2. watcher 通过**闭包**调用 `refresh()`，绕过了 synced 插件安装在 store 实例上的 action 包装（包装只拦截 `store.refresh()` 形式的外部调用），因此 `refresh()` 在 **follower 本地**执行，把 36 个内置工具直接写进本窗 `llm-tools`（direct 变更）。
3. `llm-tools` 是 `state: true` 的同步 store：本窗任何本地变更都会被插件当**全量状态提案**回推（`replaceState`）给 leader；leader 应用后再广播，覆盖掉 leader 已发现的 MCP/game/plugin 工具。
4. 同类问题：`skill-adapter-capability.ts` 的 `watch(wrappedCount, () => sync())` 同样通过闭包在 follower 本地执行，会用 follower 的本地适配器状态污染插件宿主的能力注册表。

## 修复

- `renderer/window-context.ts`：新增 `isSyncedLeaderWindow(search?)`（不抛错的轻量判定），`resolveRendererWindowContext` 复用。
- `renderer/stores/tools/built-in.ts`：life-mode watcher 加 leader 门控，follower 不跑本地 discovery。
- `renderer/stores/skill-adapter-capability.ts`：watcher 加 leader 门控，能力由 leader 单所有者公告/撤回。
- `renderer/stores/tools/game-host.ts`：补发现重试（先武装再等待，2/5/10/20/30s），成功即取消并复位。修复重载后首次 `domain-tools` invoke 可能空返回或悬挂、导致 game 工具整会话缺失的问题（MCP store 自带重试，仅 game 缺失）。

## 验证

- 单测：`window-context` 3、`built-in` 5（含 follower 不注册 / leader 注册的正反例，移除守卫时 follower 用例按预期失败）、`game-host` 4（空列表重试 + 悬挂重试）；typecheck 与 eslint 0。全量 stage-tamagotchi：571 通过，5 例既有 Windows 基线失败（symlink EPERM ×4、DOM 事件 ×1，与本修复无导入关系）。
- 真机（重建重启）：启动即 54（13 MCP + 4 game + 1 plugin）。
  - 打开 follower 后 leader 仍为 54 且 `game_observe` 可执行（`ok`、`checked: true`）；
  - follower 采用同一份 54 工具定义但**无本地执行器**，`game_observe` 返回 `Tool "game_observe" is not available now.`——单执行隔离成立；
  - 关闭 follower 后 leader 仍为 54。
- 未跑：真聊天下令、完成门真机核对。
