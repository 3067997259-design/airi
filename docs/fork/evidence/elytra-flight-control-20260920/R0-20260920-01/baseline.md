# R0 基线记录（R0-20260920-01）

日期：2026-09-20。执行边界：用户指示今晚只跑 vitest / typecheck / lint，不做真机验收。全程未创建 Git 提交，未运行 reset / clean / stash，未改写任何旧 JSONL。

## 1. 与执行文件 §2 基线的核对结果

| 项 | 执行文件记录 | 本批实读 | 差异 |
| --- | --- | --- | --- |
| AIRI HEAD | `f0dc80208…` | `f0dc80208…`（mods 分支） | 无 |
| 已跟踪修改 | 10 个文件 | 10 个文件，清单一致（§2 列表逐项核对） | 无 |
| MCPFabric HEAD | `274ce412…`，树干净 | 同 | 无 |
| 源码 mod_version | 0.2.34 | 0.2.34 | 无 |
| 部署 jar | "仍需实读" | **客户端与服务端均为 0.2.29**（源码 0.2.34，部署滞后 5 个版本） | 新事实 |
| 栈与库存 | "未重新探测" | 服务器与两个客户端**已关闭**（25565/25598/25601/25599 无监听）；MCP×2（25600/25602）与 CDP 9222 仍在；get_self 经死桥返回空字段。烟花数不可读 | 新事实：栈部分关闭 |
| world / 种子 | 未知 | 仍未知（服务器关闭无法实读） | 维持未知 |
| 历史场地 | 起点 (-1007,74,79)、目标 (-843,65,-266) | 以 venue README 为准，未实地核对 | 维持 |
| 根级类型命令 | `pnpm type-check` 不存在，实际为 `pnpm typecheck` | 未重验脚本清单，按文件口径执行 | 维持 |
| lint 阻塞 | ov5 目录九个 JSON 缺末尾换行 | 本批未重跑全仓 lint（见 checks.md 的分批范围说明） | 维持 |

## 2. 已保存的基线产物

- `tracked-workspace.patch`：10 个已跟踪文件的完整工作区补丁（相对 HEAD `f0dc80208`，439 行）。补丁为纯代码差异，无凭据。
- `originals/*.head`：四个将被 R1/R3 大改的文件在 HEAD 状态的快照（low-route.ts、corridor.ts、elytra.ts、low-route.test.ts）。工作区当前版本由补丁 + Git 本身双重保全；Mimosa 钩子拦截了 `cp` 源文件路径，故工作区版本未额外复制，以补丁为准。
- 未跟踪文件清单见 manifest.json（7 批 JSONL 全部保留原样，本批零接触）。

## 3. 配置开关快照（game-host.json，token 已剔除）

`flight: { planner: on, calibrated: true, escort: on }`，`movement.planner: terrain`。这是 2026-09-18 第四轮（LR-2/3/4 用户批准启用）写入的状态。R3 的"去掉 lowRouteUsed 历史布尔分支"与 R1 的通道迁移都将以此为起点。

物理档案：version 1.21.1 / solutionRevision 1 / ROCKET_BOOST_TICKS 35（E-01 实测修正值）。

## 4. 部署滞后警示（R2a 前置）

源码 0.2.34 对部署 0.2.29：`movement.jump*`、`combat.ballistics`、`mine.*`、`vehicle.query/observe` 等在跑的桥上**不存在**。R2a 的客户端飞行模块构建后必须走 §10 的部署纪律：结束会话 → 记录旧（0.2.29）/新产物摘要与 SHA-256 → 重启所需进程 → 核对进程实际加载的新构建，才可记录真机结果。

## 5. R0 完成门核对

| 门 | 状态 |
| --- | --- |
| 两个已确认反例可重复失败 | 见 `reproductions.md` 与当轮 vitest 输出（先失败后修复的顺序已保持） |
| 旧证据未改写 | 7 批 JSONL 与 ov5/e01 目录零接触 |
| 新诊断运行不覆盖证据 | e02 修正见 checks.md；输出唯一化已实现 |
| 完整路径断言有明确失败原因 | 见 reproductions.md 第 3 项（弯道路径顺序） |
