# MC-1c 真机验收（2026-09-13）

范围：经审阅组合技能与修订流程的五类情形（成功 / 缺条件 / 取消 / 撤销 / 内容变更）。构建：2026-09-13 重建（增量 1–3 + 内层游戏回执 journal 接线），CDP `9250`；游戏侧 MCPFabric mod `0.2.3+1.21.1`（1.21.1），MCP server `http://127.0.0.1:25600/mcp`。

## 环境与夹具

- 应用先于游戏启动，游戏宿主启动时 `fetch failed`；启动 MCP server（HTTP 传输、桥 token）后在 `#/devtools/game-host` 重新应用配置 → `connected`（世界 `connection-scoped`/overworld）。
- 夹具经 `#/devtools/packages` 探针 `createReviewedSkill` 创建（本批为探针补充 `tools`、`executionTimeoutMs`、`parameters` 入参，并写入 `meta.json`）：

| 夹具 | 声明工具 | 执行上限 | 用途 |
| --- | --- | --- | --- |
| `mc1c-sand-supply` | `game_observe` / `game_collect` / `game_say` | 200s | 成功、缺条件、内容变更 |
| `mc1c-footwork` | `game_observe` / `game_move_to` | 300s | 取消（未命中，见下） |
| `mc1c-follow` | `game_observe` / `game_follow` | 300s | 取消（命中）、撤销（未命中） |
| `mc1c-wait` | 无（沙箱内自旋） | 200s | 撤销（确定性在途） |

## 五类结果

| 情形 | 操作 | 结果 | 证据 |
| --- | --- | --- | --- |
| 成功 | `mc1c_sand_supply` 采集沙 1 | **PASS** | 返回 `collect {status:'ok', endReason:'collected', actual:1, checked:true}`、`say:'ok'`；journal：内层 `game_observe`/`game_collect` 为 `game_checked`（`checked:true`），`game_say` 为 `game`（`checked:false`），外层技能 `reviewed_self_authored` |
| 缺条件 | 采集不存在的 `minecraft:diamond_block` | **PASS** | 返回 `{status:'failed', endReason:'no_target', actual:0}`；无假成功。说明：`checked:true` 表示主进程回执已验证（与既有 `isCheckedGameResult` 判定一致），不表示目标达成 |
| 取消 | `mc1c_follow` 跟随中（`commandId eb1357ad…`，`status running`）触发 turn abort（`options.abortSignal`） | **PASS** | 技能侧结算 `[sandbox] Sandbox worker aborted: This operation was aborted`；按 commandId 查回执 → `cancelled`；停止后 x/z 水平漂移 0（y 变化为重力下落） |
| 撤销 | `mc1c_wait` 包装为适配器工具，运行中 `unwrapReviewedSkill` | **PASS** | 结算 `{status:'revoked', message:'…revoked before its result arrived; the result is discarded.'}`；工具面移除（0）；重复 unwrap 幂等（0）；`skillAdapterModes['mc1c-wait']='revoked'` |
| 内容变更 | ① 改磁盘 `source.mjs`；② 仅改 `meta.json` 的 `tools` | **PASS** | ① 执行被拒 + `artifactError:'Skill source changed. Submit the new source for review.'` + 工具撤离；`requeueChangedSourceForReview` → `readForReview` → `approve` 后新哈希 `12e2687c015a3d62` 可再次执行；② `artifactError:'The declared tools changed. Review the skill again.'` + 工具撤离 |

未命中记录（保留原样，不伪报）：`mc1c_footwork` 与 `mc1c_follow` 的自然终态（`unreachable`、`reflex_preempted`）快于中止时机，取消/撤销未在这些夹具上命中；取消与撤销分别以 `mc1c_follow`（命中 running）与 `mc1c_wait`（自旋）完成。

原因（用户现场观察）：当时玩家角色卡在水域边缘（三面比水面高一格、无法攀爬），后来卡进陆地内部；和平模式避免了溺水。用户随后把角色移到干燥地面。该环境不属于产品缺陷，但会放大 `unreachable`/`reflex_preempted` 的自然终结频率。

## 补充实验：跟随目标死亡与掉落拾取

在干燥地面重做跟随实验（召唤牛 5 格外 → `mc1c_follow` 跟随 → `/kill` 目标）：

- 跟随仍持续运行（`status running`）；`game_cancel` 后结算 `cancelled`。
- 背包新增皮革 1 / 生牛肉 2。
- 解释：`game_follow` 的 `target` 是**实体类型**（`minecraft:cow`），目标死亡后下一腿查询会命中同类其它牛并继续跟随；走到尸体附近时原版**自动拾取**掉落了皮革与牛肉。这是类型目标的预期行为与 Minecraft 原生拾取，不是技能或 bridge 的额外动作。
- 若要"特定动物死亡即结束"，应使用 uuid 目标（MC-1a 的 `target_lost` 夹具即用 uuid 移除验证），或使用环境中不存在的类型。


## D4 内层证据（本批实现）

- `SkillRuntimeProgramResult` 携带桥 traces；`skills.ts` 对 `game_*` traces 追加 `tool/call` + `tool/result`，`checked:true` 记 `game_checked`、其余记 `game`；非游戏桥调用（`read` 等）不进入 journal。
- 取消时在途桥调用随 worker 终止被丢弃，其回执不在 journal 中；游戏命令的终止以按 commandId 的回执核对（`cancelled`）为准。

## 观察与教训

1. 游戏宿主不会在游戏晚于应用启动时自动重连；需在 `#/devtools/game-host` 重新应用持久化配置（既有行为，非本批缺陷）。
2. 在途夹具必须选择可长时间运行的动作；`move_to`/`follow` 在本地地形与反射下会快速自然终结。纯自旋的 `mc1c_wait` 提供确定性在途窗口。
3. 探针清理：`skills.reject` 需逐一 `await`；并发触发会竞态并在工具面留下一条注册（本次手动 `removeToolsByIds` 清理，未发现产品路径缺陷）。
4. 缺条件场景的 `checked` 语义按既有产品判定解释（回执已验证），与规范 D5 的字面表述差异已在此记录。

## 清理

四个夹具已从队列移除、工作区目录删除（`skills/mc1c-*`）、适配器模式键清除、召唤的牛已不存在、路由回 `#/`。MCP server 保留运行以便继续游戏会话。既有 `acc-20260909-dedupe`（EP-1 夹具）未动。

## 本批代码改动清单

- 桥与端口：`game-host/index.ts`（`GameCommandPort`、`executeDomainCommand` 抽取、abort 级联）、`coding-host/game-bridge-tools.ts`（7 工具、声明门、run 上下文、自身命令取消）、`coding-host/index.ts`（`attachGameCommands`、`codingHostCodeCancel`、`runId` 跟踪）、`main/index.ts`（晚绑定）。
- 契约与运行时：`shared/eventa/index.ts`（`allowedTools`/`runId`/`code:cancel`）、`coding-harness/ptc/code-mode.ts`（`requiresDeclaration`、`allowedTools`、run 上下文、桥超时派生）。
- 声明与批准：`skill-forge/types.ts`（`tools`/`execution`、`GAME_BRIDGE_TOOL_NAMES`）、`stage-ui/types/skill-review.ts`、`skills.ts`（读 meta、`reviewedTools` 绑定与阻断、`allowedTools`/超时/信号传递、内层 journal）、`skill-submit.ts`（声明校验与落盘）、审阅 UI 与 i18n。
- 测试：coding-harness 83、coding-host（桥工具/挂载/端口）、stage-ui skills 28、skill-submit 11；各包 typecheck/eslint 0。
