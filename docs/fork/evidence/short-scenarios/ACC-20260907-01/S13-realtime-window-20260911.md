# S13 真实 30 分钟窗口（2026-09-11 凌晨）

- 场景：S13「重复 S12 的同一外观变化」→ 不重复同一句主动表达，且去重符合 30 分钟新鲜度窗口。
- 之前的状态：PASS（受控 31 分钟时钟推进），剩余变体 = **真实 30 分钟窗口**。
- 本次：不用时钟推进，真的等满 30 分钟。
- 运行端：构建版 `@proj-airi/stage-tamagotchi`，CDP `9250`，默认 profile；会话 `EeOAmGbcn8rU6kylUqiAq`，
  journal `fa18449305fc7b3461acf008ee8aba19.jsonl`。
- 开始前把心跳间隔临时改成 60 分钟（避免自动心跳插进来消费候选），结束后已改回 15。
  心跳一律用设置页同一个 store action `requestTestHeartbeat()` 触发（手动心跳）。

## 三跳

| 跳 | 时刻 | 外观事件 | 心跳决定 |
| --- | --- | --- | --- |
| 1 | 00:53 | `seq=8 appearance/changed target=LoveButton value=1` | `seq=22`（00:53:48）`refs=appearance:8,tool:9` —— 候选被消费，**30 分钟窗口从这一刻开始** |
| 2 | 00:54–55 | `seq=29 angry:1`、`seq=32 LoveButton:1`（**与第 1 跳同一个 novelty key**） | `seq=47`（00:55:13）`refs=appearance:29` —— **只有 angry 被呈现，LoveButton 被去重** ✅ |
| 3 | 01:27 | `seq=54 angry:1`、`seq=57 LoveButton:1`（同一个 key） | `seq=72`（01:27:55）`refs=appearance:57,appearance:54,tool:58` —— **同一个值在窗口过期后重新可用** ✅ |

全部外观事件：`8:LoveButton:1 | 29:angry:1 | 32:LoveButton:1 | 54:angry:1 | 57:LoveButton:1`。
第 1 跳的决定时间 00:53:48 → 窗口在 01:23:48 过期；第 3 跳发生在 01:27，已过窗口。

## 判定

三条都成立：

1. **同值在 30 分钟内被去重**（第 2 跳只出现不同值的候选）；
2. **不同值仍然可用**（angry 每次都进候选）；
3. **窗口过期后同值重新可用**（第 3 跳两个候选都在），全程用真实的 30 分钟等待，没有改时钟。

**S13 PASS。** 场景口径里的「不重复同一句主动表达」在三次决定里都表现为 `action=silence`
（没有对外发言），去重发生在候选层——这正是 S13 要验的边界。

## 收尾

- 心跳间隔已改回 15 分钟，静默时段仍为 3–4，模式仍为 `autonomous`。
- 本次新建会话 `EeOAmGbcn8rU6kylUqiAq` 保留为证据。
