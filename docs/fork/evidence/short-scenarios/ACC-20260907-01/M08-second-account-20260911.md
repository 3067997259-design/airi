# M08 第二账户变体：账户隔离（2026-09-11 凌晨）

- 场景：M08 的剩余变体「第二账户」。原口径（两个角色）已 PASS；本文件验的是**换一个用户账户**后的隔离。
- 运行端：构建版 `@proj-airi/stage-tamagotchi`，CDP `9250`，默认 profile。
- 操作：用户在「设置 → 账号」登出 GitHub 账户 A，改用 **Google** 登录账户 B（OAuth 由用户在浏览器完成）。

## 账户

| | userId | 说明 |
| --- | --- | --- |
| A（切换前） | `3bXjSqeoKBQnOCCXBcudtmM8omc0xKxY` | GitHub 登录，`3067997259@qq.com` |
| B（切换后） | `iWgl0e0b6NtsGAEENEBzVAj7SxbeIBOu` | Google 登录 |

角色卡在两边的 `characterId` 都是 `n8cz_qXFxNLwpJmuAsfIl`（同一张卡仍然可用）。

## 切换前的 A 基线

| 项 | 值 |
| --- | --- |
| `memoryScope` | `{userId: 3bXjSqeo…, characterId: n8cz_qXFxNLwpJmuAsfIl}` |
| 记忆片段 | 总数 79：**A 68**、匿名时代 `local` 9、无 scope 2 |
| `shareable` | 3 条：`656b0f6f` / `4c211389` / `17edcfbe` |
| 会话 | 121 |
| dream ideas | 0 |

## 切换到 B 之后

| 检查点 | 结果 |
| --- | --- |
| `auth.userId` / `memoryScope` | `iWgl0e0b6NtsGAEENEBzVAj7SxbeIBOu`，scope 随之切换 ✅ |
| `listShareableFacts(B)` | **`[]`** —— A 的三条已审事实不可见 ✅ |
| 一次真实提问的检索 | 会话 `3IVCwx1IrB5_2NQEh8_Aw`，journal `memory/retrieved` → **`memoryIds: []`**（A 的记忆没有被注入）✅ |
| 按 scope 直接查库 | `repo.list({scope: B})` → **0 行**；`repo.list({scope: A})` → **59 行**（同一 `characterId` 下 A 的数据仍在）✅ |
| 会话索引 | 从 A 的 121 条切到 **B 自己的 1 条** ✅ |
| 记忆库总量 | 切换后仍是 **79**：A 68 / local 9 / 无 scope 2 —— **A 的数据只是被 scope 挡住，没有被动过** ✅ |
| 数据库状态 | `ready` ✅ |

### dreaming 隔离

| 动作 | 结果 |
| --- | --- |
| `runAutomaticDreaming({scope: B})` | `{status: "skipped", reason: "cooldown"}` —— 未运行 |
| `dream({...B})`（记忆体页面「现在做梦」同一个 action） | 返回 ok，**没有产生任何 idea**（`dreamIdeas` 仍为空） |
| 之后复查片段数 | 仍是 79 / A 68 —— A 的片段既没被读取也没被改写 ✅ |

## 判定

**M08 第二账户变体 PASS（隔离部分）**：换账户后用户域完全切换——A 的记忆在候选、检索、按 scope 查询、
会话索引四条路径上都不可见，而库里的行数与内容保持不变（软删除/改写都没有发生）；
B 侧的 dreaming 也不会碰到 A 的片段。

## 回切验证 —— 全部原样恢复

用户重新用 GitHub 登录账户 A 后逐项核对：

| 项 | 切换前基线 | 回切后 | |
| --- | --- | --- | --- |
| `userId` | `3bXjSqeoKBQnOCCXBcudtmM8omc0xKxY` | 同 | ✅ |
| `memoryScope` | `{3bXjSqeo…, n8cz_qXFxNLwpJmuAsfIl}` | 同 | ✅ |
| 会话 | 121 | **121** | ✅ |
| `shareable` | `656b0f6f` / `4c211389` / `17edcfbe` | **同样三条** | ✅ |
| 记忆片段 | 总数 79（A 68 / local 9 / 无 scope 2） | **79（68 / 9 / 2）** | ✅ |
| 按 scope 查 A | 59 | **59** | ✅ |
| `activeCardId` | `n8cz_qXFxNLwpJmuAsfIl` | 同 | ✅ |
| dream ideas | 0 | 0 | ✅ |
| 数据库状态 | `ready` | `ready` | ✅ |

**结论**：换账户再换回来是**非破坏性且可逆**的——户 A 的会话数、记忆条数、已审事实、按 scope 的查询结果
全部与切换前逐项一致。M08 第二账户变体完整通过。

