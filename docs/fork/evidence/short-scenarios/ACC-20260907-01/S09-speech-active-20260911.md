# S09 speech-active 门（2026-09-11 凌晨）

- 场景：S09「语音仍在播放时触发心跳」→ 不重叠播放或插入社交发言；记录 `speech-active`。
- 之前的状态：**BLOCKED**（语音 provider 上游 401；Electron `speechSynthesis` 无本地语音）。
- 解阻塞方式：用户在**第二个账户**（Google 登录，150 Flux）下重新登录，官方语音来源不再 401。
  本场景不要求特定账户，故在账户 B 上完成。
- 运行端：构建版 `@proj-airi/stage-tamagotchi`，CDP `9250`，默认 profile；会话 `G3ChfNk92zFcrTiZpDKkC`，
  journal `53cb5c948931cd63c0c8895beaa31786.jsonl`。

## 前置：官方语音可用

| 字段 | 值 |
| --- | --- |
| `speech.configured` | `true` |
| `activeSpeechProvider` | `official-provider-speech`（model `auto`，voice `jilingshaonv`） |
| `speechProviderError` | **空**（账户 A 时这里是 `audio voices upstream 401: UNAUTHORIZED`） |
| `character-speaking.nowSpeaking` | 轮询到 `true` |

## 步骤与证据

1. 在聊天窗口发一条会产生较长回复的消息（「用大约八十个词讲一个关于雨天的小故事」）。
2. 主窗口（leader）轮询 `character-speaking.nowSpeaking`；在 `nowSpeaking === true` 且
   `chat.sending === false` 的那一刻触发一次手动心跳（设置页「测试心跳」同一个 store action）：

   ```
   poll=30（每 0.5 秒一次）emitted=true
   ```

3. journal：

```
seq=9  01:38:23 turn/start
seq=22 01:38:37 turn/end completed
seq=23 01:38:43 life/heartbeat gate=speech-active      ← 播放中触发的心跳被门控
```

该心跳之后 journal 再没有任何 `turn/start` / `assistant/*` —— **没有插入社交发言，也没有启动考量回合**。

## 判定

- 真实播放存在（官方语音来源可用，`nowSpeaking` 实测为 true）；
- 播放期间的心跳被记为 **`speech-active`**（场景要求的「记录 speech-active」）；
- 门控在**认领之前**短路，因此没有模型调用、没有插入社交话术、也没有重叠播放。

**S09 PASS。**

## 顺带记录

- 同一会话的第一条消息（01:36:37）以 `turn/end error` 结束：
  `Remote sent 403 response: {"error":{"message":"insufficient balance","type":"billing_error"}}`，
  来源是**用户自建的 chat provider**（`openai-compatible` / `https://direct.linkai.pics/v1`），
  与官方语音来源（Flux）不是同一条链路。同一会话稍后的第二次调用成功，属于该端点的余额波动，
  记录备查，不计入场景判定。
- 官方语音来源可用之后，之前因 401 而 BLOCKED 的 S09 变体已无阻塞。
