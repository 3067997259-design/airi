# R06 后端断线、重连与 outbox（2026-09-09）

- 状态：PARTIAL。断线期间远端错误可见、队列保留并退避；重连后队列清空。但本轮只产生 `update` 操作，没有 `insert`/`delete`，因此未覆盖新增、纠正、删除的完整次序。
- 日期：`2026-09-09`
- 运行端：构建版 Electron `out/`，CDP `9250`，用户 profile
- 同步目标：`server/docker-compose.yaml` 的 `proj-airi-backend-db-1`（`127.0.0.1:5435`）
- 测试事实：`R06 的测试植物现在叫 R06-SYNC-A-20260909。`，originId `656b0f6f-72f4-441b-b647-61c6f15d391c`
- 控制 session：`airi-acc-20260909`

## 步骤与证据

1. 长期记忆设置页连接 Postgres，状态变为 `已连接。晋升的记忆会镜像到该存储。`
2. 开启 `启用长期记忆远端同步`。
3. `docker stop proj-airi-backend-db-1`，容器变为 `Exited (0)`。
4. 在短期记忆页批准测试事实。`setReviewStatus` 为它排入一条 `update`。
5. 页面显示远端 `连接失败。` 并回显完整 SQL 与参数：
   `Failed query: update "memory_fragments" set "review_status" = $1 where ... params: approved,656b0f6f-72f4-441b-b647-61c6f15d391c`。
6. outbox 明细：`1 条记忆等待同步`，`#0 [update] 656b0f6f-72f4-441b-b647-61c6f15d391c · 1 · <同一条错误>`。
   即队列保留了条目、记录了操作类型、originId、尝试次数和错误。
7. 断线期间在聊天会话问 `R06 的测试植物现在叫什么？只回答名称。`。
   journal `6101c13e724ae4d64353c8bc5054e82b.jsonl` 的 `seq=15` 检索命中 `656b0f6f-...`，本地事实可用。
8. `docker start proj-airi-backend-db-1`，容器恢复 `healthy`。
9. 在设置页重新点击 `连接`，状态回到 `已连接`，outbox 变为 `0 条记忆等待同步`。

## 新发现 — update 先于 insert 时静默丢数据

重连后队列清空，但远端没有对应行：

```sql
select count(*) from memory_fragments;                       -- 49
select origin_id from memory_fragments
  where origin_id = '656b0f6f-72f4-441b-b647-61c6f15d391c';  -- 0 rows
```

`setReviewStatus` 对一个**尚未镜像的短期事实**排入 `update`，`updateByOriginId` 影响 0 行，投递被当作成功，outbox 随即清空。结果是：该事实的批准状态永远没有到达远端，而 UI 显示"0 条等待同步"。

这不是连接问题，是操作种类与存储状态的错配：`update` 不能充当首次写入。可能的修法是 `update` 在 0 行时回退为 upsert，或短期事实的审阅变更不排 `update`，等晋升时用 `insert` 携带最终状态。

本轮没有修改产品代码；该发现单独列出，供下一批定位。

## 未覆盖

- 没有产生 `insert`：测试事实在本次运行中保持 `short_term · 有效 · 1 次访问 · 1 个会话`，没有晋升为长期记忆，因此 `mirrorPromotedToLongTermStore` 没有排入 `insert`。晋升阈值在本次运行中通过 UI 调低为 1/1，但事实仍未晋升，原因待查。
- 没有产生 `delete`：未删除事实，避免与本地有效事实的召回检查冲突。
- 没有覆盖"恢复后按正确次序收敛"与"删除不复活"。
- 没有做恢复前后各重启一次的变体。

因此 R06 记 PARTIAL：断线可见性、队列保留、退避与重连清空成立；完整次序收敛与 tombstone 语义未验证。
