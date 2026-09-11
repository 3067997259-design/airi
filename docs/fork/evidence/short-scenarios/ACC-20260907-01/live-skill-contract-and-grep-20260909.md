# 技能输入契约运行态复验与 grep 降级发现（2026-09-09）

- 日期：`2026-09-09`
- 运行端：重建后的 `@proj-airi/stage-tamagotchi`（`out/` 17:35），CDP `9250`，原用户 profile
- 会话 journal：`9f9d9fa56b59d6feeba0a0d6d7f07750.jsonl`
- 技能：`acc-20260909-dedupe`（`reviewed`，`contentHash` 与 `reviewedHash` 均为 `9103be732a70d335`）

## 一、技能输入契约（复核发现 1 的运行态复验）

同一会话内连续两次真实工具调用：

| seq | 调用 | 结果 |
| --- | --- | --- |
| 220 | `acc_20260909_dedupe {items: ["a", 3, null]}` | `Skill "acc-20260909-dedupe" rejected the input: input.items[1] must be a string.` |
| 246 | `acc_20260909_dedupe {items: [" a ", "b", "a", ""]}` | `sandbox ok: ["a","b"]`，随后返回 `["a","b"]` |

结论：

- 非法输入在到达沙箱之前被拒绝，`sandbox ok` 没有出现。
- 合法输入仍然执行并返回预期结果。
- 这同时更新 K04 的运行态状态：先前记录的 `['a',3,null] → ['a']` 失败在当前构建与当前技能版本上不再复现。技能的声明 Schema 已包含 `items: { type: "string" }`，因此这次拒绝由既有的元素类型校验产生，不能单独归功于本批的 `uniqueItems` 修复；`uniqueItems` 一类关键字的行为由 `packages/skill-forge/src/input-validation.test.ts` 的 13 条回归覆盖，当前没有使用该类关键字的真实技能可供运行态验证。

模型在调用前先 `grep`/`read` 了 `skills/acc-20260909-dedupe/meta.json` 与 `source.mjs`，属于自主核对，不是产品行为。

## 二、新发现 — 构建版里 grep 永远走 Node 兜底

`seq=215` 的 grep 结果带降级说明：

```
grep "acc_20260909_dedupe" · 1 match in 1 file skills/acc-20260909-dedupe/meta.json
Search ran without ripgrep (search binary unavailable); it scans fewer files and may miss matches
```

### 根因

`packages/coding-harness/src/tools/grep-search.ts` 的 `resolveRipgrepPath()` 动态导入 `@vscode/ripgrep` 读取 `rgPath`。构建时该包被**打进主进程产物**，导入被改写成 `await import("./lib-C3N1uzz9.js")`；该 chunk 保留了原始实现：

```js
const require = createRequire(import.meta.url)
resolved = require.resolve(`@vscode/ripgrep-${process.platform}-${arch}/bin/${binaryName}`)
```

运行时 `import.meta.url` 是 `out/main/lib-C3N1uzz9.js`，从该位置向上查找 `node_modules` 看不到平台包：

- `D:\airi\node_modules\@vscode\ripgrep` 不存在；
- `D:\airi\apps\stage-tamagotchi\node_modules\@vscode\ripgrep` 不存在；
- 二进制实际位于 `node_modules/.pnpm/@vscode+ripgrep-win32-x64@1.18.0/node_modules/@vscode/ripgrep-win32-x64/bin/rg.exe`，只对 `packages/coding-harness` 可见。

`resolveRipgrepPath()` 的 `catch` 返回 `undefined`，`searchWorkspace()` 因此走 `searchByWalking()` 并声明 `search binary unavailable`。

用 Node 直接验证：从 `@vscode/ripgrep` 自己的 `lib/index.js` 解析能拿到 `rg.exe`，说明二进制本身完好；问题只在打包后的解析上下文。

### 影响

C1「检索原语」在构建版里从未生效，grep 一直是 Node 遍历兜底。降级是**可见**的（符合 M2 教训），但速度与召回范围都退回到引入 ripgrep 之前。既有的 T8/T9 验收只断言了命中与签名，没有断言 `degradedReason` 为空，所以没有被发现。

### 可能的修法（未实施）

- 把 `@vscode/ripgrep` 从主进程打包中外部化，并让它在运行时可从 app 解析（需要给 `apps/stage-tamagotchi` 增加依赖，属于用户拍板的依赖变更）；
- 或构建时解析二进制路径并注入常量，交给 `createNodeWorkspaceHost` 的 `rgPath` 选项；
- 或给打包器加插件，把 `require.resolve` 的目标改写为绝对路径。

本记录不修改产品代码；修法需要用户选择后再实施。

## 三、检查

- 未修改产品代码、用户 profile 或原始验收登记。
- 两次调用都在同一真实会话内完成，provider 为 `openai-compatible` / `gemini-3.8-flash`。
