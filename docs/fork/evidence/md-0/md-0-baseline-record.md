# MD-0 可识别构建与检查执行记录（2026-09-06）

## 批次与范围

- 批次：MD-0（构建、检查与文档状态可识别）。只读基线核查，未改动任何代码或生产数据。
- 日期：2026-09-06。
- 运行端：本地工作树（Git Bash，Windows 10.0.26200 x64）。
- provider/model：未调用（本轮未连接真实 provider，未运行模型评估）。
- 测试数据：未使用用户数据；Postgres 集成使用 Docker 容器内的空 `postgres` 库。

## 构建标识冻结（可唯一对应一份产物）

### Git 基线

- 分支：`mods`
- HEAD：`13c8edc2164980f53f4ea86a275155f8cd3df929`
- HEAD 提交时序：2026-09-02 21:16:24 +0800，`docs(fork): add the flow field-test diagnosis and update the loop plan ledger`
- 根包：`@proj-airi/root` / `0.12.0-beta.2`
- 工作树：155 个改动文件（未暂存），94 个未跟踪文件，100 个已跟踪文件有内容差异（stat：+10295 / −1344）
- 工作树 diff SHA-256：`daf58b34f8c913c3aa39fba8ed323638ceda33faa7b0a1e34dd73b741256946d`
- 暂存区 diff SHA-256：`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`（无暂存内容）
- 已暂存内容为空；所有改动均在工作树（未暂存 + 未跟踪）。

### 构建产物

dev/源码构建（electron-vite 输出到 `apps/stage-tamagotchi/out/`，Sep 6 22:50–22:51）：

- main bundle：`out/main/index.js` → SHA-256 `aae2201ade9fcdd3026cd6623db3d9726f5bea1c8dd819ccfe25bc1a12e74b01`
- renderer：`out/renderer/index.html` → SHA-256 `5740c700c2e98e77026e67ce93b6243688667c11d653bbec219a0e81410264b3`
- preload：`out/preload/index.mjs` → `6d7c0232c289059ededa8435ce8c3d589d27ce0fe74b5ebab5178b1b07dea94d`；`beat-sync.mjs` → `b3edfd249ad8a08b55563a942c8f437c480344c3df9a4ee5158f59b0f6d9ac03`；`shared-DtzQ5aVx.mjs` → `695c80e54623d20780cdf40fad6ba45156d9240f08d307414b3c7193fe5e72a3`

打包 EXE（`dist/win-unpacked/airi.exe`，Sep 6 13:36）：

- SHA-256 `f8e36f72b274816a3625af19db60640fdc95a9479bcf958d0dbb1292516a3e64`
- 体积 235,537,920 字节（约 225 MiB）

### dist 一致性

- `packages/core-agent/dist/index.mjs`（Sep 6 22:42）晚于 `src/index.ts`（Sep 6 21:29），说明 core-agent 源码后已重建，跨包测试消费的是新构建。遵循 AGENTS.md 的"改 core-agent 源码必须 `build:packages`"约束。
- `packages/i18n/dist/index.mjs`（Sep 6 10:51）早于部分 i18n 源码改动时间，存在 i18n dist 未完全重建的可能；renderer 消费 i18n 的 `dist`，该包若改动需重建。仅记录为待核对项，不宣称通过。

## 命令与退出码

- `pnpm typecheck`（root，实际脚本，非 `type-check`）：退出码 **0**。全部包一致 `Done`，包括 stage-tamagotchi、stage-ui、stage-web、stage-pocket、core-agent、memory-pgvector、docs。
- `pnpm lint`（root，`moeru-lint .`）：退出码 **0**。0 errors，12 warnings（含 `.zcode/tmp/utf8-read-verify.js`、`pipelines-audio` 等）与 2 warnings（`jsdoc/multiline-blocks`，位于 `apps/stage-tamagotchi/src/shared/eventa/index.ts` 与 `packages/stage-ui/src/stores/mods/api/channel-server.ts`）。上述警告均在既有文件，非本核查引入。
- `pnpm exec vitest run packages/memory-pgvector/src/repository.integration.test.ts`：退出码 **0**。4 tests passed（805ms），启动于 23:09:03。运行时设置 `DATABASE_URL=postgres://postgres:example-PAssw0rd-xHjDYR.b7N@127.0.0.1:5435/postgres`。

## 环境差异（与文档记录相反的关键事实）

- **Docker daemon：RUNNING**。`docker ps` 显示 `proj-airi-backend-db-1`（`ghcr.io/tensorchord/vchord-postgres:pg18-v1.0.0`），状态 `Up 3 hours (healthy)`，映射 `127.0.0.1:5435->5432/tcp`。
- **Postgres 端口 `127.0.0.1:5435`：OPEN**。
- 本机无 `psql` / `pg_ctl` 命令，但可通过 Node/pg 与 Docker 端口访问；集成测试已运行并全部通过。

这 与 [daily-reliability-plan.md#7](../daily-reliability-plan.md) 及 M-M2 记录中"Postgres 端口拒绝连接、Docker daemon 不可用"相反。说明该外部依赖当前是可用的，DR-3、MQ-0、MD-2 三条路的硬阻塞已在本次被解除。

## 预期 vs 实际

- 预期：确认当前工作树、dist 与运行产物可唯一对应一份构建；确认 root scripts 的准确命令与退出码；区分源码/dist/开发 EXE/打包 EXE。
- 实际：
  - 已冻结 dev 构建（out/ ⇒ main/renderer/preload 三 SHA-256）与打包 EXE（win-unpacked/airi.exe SHA-256）两套独立标识；二者时间戳不同（out 为 Sep 6 22:50–22:51，EXE 为 Sep 6 13:36），确认它们是不同产物，不能混用验收结论。
  - root `pnpm typecheck` 与 `pnpm lint` 均退出码 0；`pnpm type-check` 不存在（AGENTS.md 已知），实际脚本为 `pnpm typecheck`。
  - 真实 Postgres 集成 4/4 通过，DR-3 数据库边界由"未运行"翻为"真实通过"。

## 未覆盖项

- 未连接真实 provider，故未做模型行为验收（DR-1 真实 Flow、MQ-0 生产链路、SP-0 20 刺激推广门仍留待各自实例）。
- 打包 EXE 与 dev 构建的行为一致性未在本轮走查（仅登记标识，未运行二者对比）。
- i18n dist 是否与最新源码一致未完全核实；记录为待核对项。
- 内部包 `build:packages` 未重跑（未改动任何工作区包的源码）；仅记录 dist 与 src 的相对时间戳。
- 未创建提交，未清理工作树，未重置他人改动。

## 结论

本次 MD-0 建立了可识别基线：一份工作树差异 SHA-256、两套独立构建标识（dev out/ 与打包 EXE）、以及 root `typecheck`/`lint` 的真实退出码 0。关键附加发现是真实 Postgres 现在可用，DR-3/MQ-0/MD-2 的数据库硬阻塞已解除。
MD-0 本身仅完成基线核查；本记录不构成 MD-1（导出契约）、MD-2（导出恢复）或任何功能批次的完成。
