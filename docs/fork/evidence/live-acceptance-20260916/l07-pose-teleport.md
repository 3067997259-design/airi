# L-07 姿态、骑乘与瞬移：真机记录（2026-09-16）

## 姿态字段（服务端详情读）

| 状态 | onGround | fallFlying | riding | bounds |
| --- | --- | --- | --- | --- |
| 走路（首轮 facts） | true | false | false | 0.6×1.8 |
| 骑乘（首轮 + 复测 facts） | false | false | **true** | 0.6×1.8 |
| 滑翔 | — | true | false | 见 L-02/L-03 与飞行冒烟记录的 `finalTargetObservation` |

三态字段与实际状态一致；滑翔样本此前在各飞行记录中已多次出现（`finalTargetObservation.fallFlying: true`）。

## 瞬移跳跃

- 夹具：地面跟随（keep 3，timeout 90）；跟随开始 5 秒后用服务端命令把目标瞬移到 (50, 78, 33)（同维度、约 100 格外）。
- 采样以瞬移前位置为种子，跳跃在第 **12ms** 的首个新样本被检出（>16 格/1 秒）。
- 结果：命令以 `target_unreachable` 收尾（跨地形徒步腿失败），**无任何跟踪失败**（非 `target_lost`/`target_not_in_read`/`waiting_for_target`）。

## 骑乘跟随

- 瞬移段结束后把目标送回马旁，测得上马（`riding: true`）；短跟随（timeout 12）以 `timeout` 正常收尾，无跟踪失败。

## 首轮脚本缺陷与修正

首轮 `jumpAt: undefined`：采样在瞬移命令之后才开始，第一帧已是瞬移后位置，跨不过跳跃。修正为瞬移前捕获种子位置并传入采样循环；复测通过。证据：[l07-pose-teleport.json](./l07-pose-teleport.json)（首轮，仅作缺陷记录）、[l07-pose-teleport-retest.json](./l07-pose-teleport-retest.json)（复测），脚本 [l07-pose-teleport.mjs](./l07-pose-teleport.mjs)。

## 边界

- "轨迹历史在四类事件（起飞/落地/骑乘/瞬移）处重置"为模块内行为，由 `target-tracking.test.ts` 单测覆盖；真机验证的是字段三态与瞬移后不丢目标。
- 骑乘样本只覆盖静态骑乘（原地），未覆盖骑行中的跟随质量。
