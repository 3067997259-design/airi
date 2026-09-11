# DR 执行证据 — 2026-09-06

## 范围

- 批次：DR-0；DR-2 的 TaskRun 活动投影、follower 快照和受控 Electron 冒烟。
- 代码标识：`13c8edc2164980f53f4ea86a275155f8cd3df929` 加当前未提交工作树。
- 构建标识：stage-tamagotchi `out/main/index.js` SHA-256 `2dbccc179882c0f70aa4fccac7576a7139e17607d8e77f4ff6f8a1feef4ec3e7`；`out/renderer/index.html` SHA-256 `b6975aacf8873e952d289c5944f7930fd8756eb9647d778b8695c906f6176f32`。
- 运行端：Windows Electron，独立 userData，CDP 9251。隔离 profile 已在测试后删除；本目录保留 stdout、stderr、[agent-browser follower 截图](./follower-task-activity.png) 和 [Vishot main-window 截图](./vishot-main/dr-main-window.png)。
- provider/model：未使用；输入来自受控 Pinia journal 事件，不连接外部服务。
- 测试数据：`dr-session`、`dr-flow`、`dr-task`。
- journal 范围：session header、user message、flow start/end、assistant narration、一次 tool call/result；活动数组包含 narration、tool-call、tool-result，核心窗口上限 40 行。

## 预期与实际

预期：leader 发布的活动快照按 `taskId` 到达 follower；follower 显示同一任务的状态和工具活动，不扫描全量 journal，不把远端快照重新发布为本地同步提案。

实际：core-agent 测试确认 45 条活动截断为最近 40 条，后续任务不会混入前一任务；受控 Electron 双窗口确认 follower 收到 `dr-task` 的完整活动数组，页面显示任务标题和 `已完成 · 1 次工具调用`。console 与页面 error 队列在冒烟后无新增输出。

## 命令与退出码

| 命令 | 结果 |
| --- | --- |
| `pnpm -F @proj-airi/core-agent build` | 0，通过 |
| `pnpm -F @proj-airi/core-agent typecheck` | 0，通过 |
| `pnpm -F @proj-airi/core-agent exec vitest run` | 0，26 files / 269 tests 通过 |
| core-agent `task-run.test.ts` | 0，12 tests 通过 |
| stage-ui TaskRun 面板与 chat contract 定向测试 | 0，34 tests 通过 |
| `pnpm -F @proj-airi/stage-ui typecheck` | 0，通过 |
| stage-ui node 全量 | 1，874 tests 通过；1 个 provider 网络 fetch 未处理拒绝，目标地址被环境 EACCES 拒绝 |
| stage-ui browser 全量 | 0，50 tests 通过；有既有 `decodeEntities` 与 ResizeObserver 控制台警告 |
| `pnpm -F @proj-airi/stage-tamagotchi typecheck` | 0，通过 |
| `pnpm -F @proj-airi/stage-tamagotchi build` | 0，通过 |
| tamagotchi journal-host 定向测试 | 0，6 tests 通过 |
| tamagotchi node 全量 | 1，458 passed / 1 skipped / 4 failed；失败为 Windows symlink EPERM 与静态资源路径分隔符断言 |
| Vishot task-activity 场景 | 1，打开 chat 窗口超时；未把失败产物当作截图证据 |
| Vishot 直接 main-window capture | 0，生成 `vishot-main/dr-main-window.png`，已人工检查非空白/非 loading |
| core-agent `task-run.test.ts`（最终定向） | 0，12 tests 通过 |
| stage-ui TaskRun 面板与 chat contract（最终定向） | 0，34 tests 通过 |
| `pnpm exec vitest ...` 初始入口尝试 | 1，PowerShell 下 pnpm 未解析该 CLI；改用 workspace/direct Vitest 入口完成测试 |
| 根 `pnpm typecheck` | 0，56/71 workspace projects 通过 |
| 根 `pnpm lint` | 0，0 errors；保留 2 条既有 warning |

## 继续执行记录 — production user profile（2026-09-06）

- 运行端：重建后的 stage-tamagotchi production Electron，默认用户 profile，CDP 9250；实例在验证后保持运行。provider/model 为 `openai-compatible` / `gemini-3.8-flash`，本记录不保存密钥或连接凭据。
- 新构建标识：`out/main/index.js` SHA-256 `D31B2C12555AD744F25CD06EC036BCD7F103610C4AAF105304C370AD2FC72EB9`；`out/renderer/index.html` SHA-256 `3D2D317BB19865EA222C381A9135740BF2BAA13E41A1BA744BB60DF8558D7450`。
- DR-1 真实场景：路线图只读成功；不存在文件只读失败并返回 ENOENT；probe 读失败后写入再复读成功；`user_ask` 问题卡收到回答；问题等待时停止心流并记录 interrupted，停止后无新工具调用。probe 文件的 SHA-256 为 `A455FA880D9299EB841525EC62EFF27654FF8B90FA147DE0F82AA91B6E6F15FD`。
- DR-2 真实 follower：聊天窗口显示 `read`、`write`、`flow_update` 活动；最新 TaskRun 派生结果为 completed，命令标题正确，活动 28 行并以 completion-review 收尾。截图：[after-fix](./follower-task-activity-after-fix.png)。
- DR-3 重启/持久化：重建后重启主窗口与 follower 正常恢复，最新日志无未编号 header 或 replay suppression 警告。现存最大 journal 文件为 3,308 行、最高 seq 3,113，无缺口/坏行/未编号行，但有 195 条重复 seq；这不是全量历史健康证明。
- DR-3 外部边界：`127.0.0.1:5435` 拒绝连接；本机没有可用 `psql`/`postgres`，Docker daemon 不可用。真实 Postgres 与打包 EXE 场景未运行。
- DR-4 条件：目标模型和一次真实写入样本已使 Hashline 校准前置成立；旧 20 文件基准仍未完成。环境摘要和 rewind 条件未触发。

### 最新回归命令

| 命令 | 结果 |
| --- | --- |
| core-agent `task-run.test.ts` | 0，13/13 通过（含 flow/start 后置命令标题回归） |
| core-agent 全量 Vitest | 0，26 files / 270 tests 通过 |
| stage-ui `stores/journal.test.ts` | 0，10/10 通过（含 legacy header 与 >2,000 事件回放） |
| coding-harness Hashline + coding-tools 定向 | 0，6 files / 48 tests 通过 |
| memory-core 全量 | 0，10 files / 32 tests 通过 |
| memory-pgvector 全量 | 0，5 通过 / 4 integration 跳过（无 Postgres） |
| `pnpm -F @proj-airi/core-agent typecheck` | 0，通过 |
| `pnpm -F @proj-airi/core-agent build` | 0，通过 |
| `pnpm -F @proj-airi/stage-tamagotchi build` | 0，通过；重建后已重启 production profile |
| 根 `pnpm typecheck` | 0，56/71 workspace projects 通过 |
| 根 `pnpm lint` | 0 errors，2 warnings；均为既有 warning |
| coding-harness 全量 | 1，Windows `EBUSY` 清理临时目录；Hashline/工具定向回归不受影响，测试残留已清理 |

## 未覆盖

审批拒绝、超时、验证门异常；ATTENTION 六条、键盘停止与完整窄屏展开可读性；journal 缺口/损坏/写失败/回执丢失故障注入；provider/model/tools/workspace 变化恢复；记忆重启语义；真实 Postgres/断线恢复；可识别打包 EXE；DR-4 Hashline 20 文件校准、环境摘要与 rewind。Vishot task-activity 专用场景仍需修复 chat 窗口发现/打开条件。

本记录不把受控 journal 冒烟当作真实 provider、Postgres 或 EXE 验收，也不改变旧 R5 未完成状态。
