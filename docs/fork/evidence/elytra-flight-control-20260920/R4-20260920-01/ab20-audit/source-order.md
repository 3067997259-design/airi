# MC 1.21.1 源码核验：滑翔位移与烟花推进的 tick 顺序（ab-17 审计第 1 项）

日期：2026-09-21。只读核验；未修改游戏、mod 或证据。

## 结论

审计的假设 (A) 成立：**同一 tick 内，玩家先用"推进前"的速度完成滑翔位移，烟花推进在该 tick 的位移之后写入速度**。因此：

- 该 tick 的采样位置增量不含新推力；
- 该 tick 结束时的速度已含新推力。

这与 ab-17 的 139/142 个受控 boost tick 的实测一致（单步位置误差 P95 0.54 → 0.000020，见 `calibration.md`）。

## 核验方式与限制

环境中**没有** 1.21.1 的反编译源码或 `*-sources.jar`（已搜索 `D:\mcpfabric\.gradle\loom-cache`、`C:\Users\86130\.gradle\caches\fabric-loom`、`modules-2`；只有 Fabric API 的 sources）。核验改用 **Mojang 映射后的已编译类 jar + `javap -p -c -l`**；这些类带 `LineNumberTable`，下列行号是真实源码行号。

用到的 jar：

- `C:\Users\86130\.gradle\caches\fabric-loom\minecraftMaven\net\minecraft\minecraft-common\1.21.1-loom.mappings.1_21_1.layered+hash.2198-v2\minecraft-common-…v2.jar`
  （`net/minecraft/world/entity/LivingEntity.class`、`…/projectile/FireworkRocketEntity.class`、`…/world/level/entity/EntityTickList.class`）
- 同缓存下的 `minecraft-clientonly-…v2.jar`（`client/multiplayer/ClientLevel.class`、`client/Minecraft.class`）

## 证据

### 1. 烟花推进写在"被附着实体"的速度上（`FireworkRocketEntity.tick`）

```
// FireworkRocketEntity.java:124  if (this.attachedToEntity != null) {
//                          :126     if (this.attachedToEntity.isFallFlying()) {
//                          :127        Vec3 vec3 = this.attachedToEntity.getLookAngle();
//                          :128        double d = 1.5;
//                          :129        double e = 0.1;
//                          :131        Vec3 vec32 = this.attachedToEntity.getDeltaMovement();
//                          :132        this.attachedToEntity.setDeltaMovement(
//                                        vec32.add(
//                                          vec3.x * 0.1 + (vec3.x * 1.5 - vec32.x) * 0.5,
//                                          vec3.y * 0.1 + (vec3.y * 1.5 - vec32.y) * 0.5,
//                                          vec3.z * 0.1 + (vec3.z * 1.5 - vec32.z) * 0.5));
```

字节码证据：`invokevirtual Vec3.add:(DDD)` → `invokevirtual LivingEntity.setDeltaMovement:(Lnet/minecraft/world/phys/Vec3;)V`。

**这与生产模型 `FlightDynamics.step` 的推进步完全一致**：

```java
vx = vx + look.x * ROCKET_BASE_ACCEL + (look.x * ROCKET_TARGET_SPEED - vx) * ROCKET_PULL;
```

（`ROCKET_BASE_ACCEL=0.1`、`ROCKET_TARGET_SPEED=1.5`、`ROCKET_PULL=0.5`。）

### 2. 滑翔位移读取"当时"的速度（`LivingEntity.travel`）

```
// LivingEntity.java:2254  } else if (this.isFallFlying()) {
//                    :2256     Vec3 vec35 = this.getDeltaMovement();   // ← 读取速度
//                    :2257     Vec3 vec36 = this.getLookAngle();
//                    …（look/rot 项加到 vec35）
//                    :2297     this.setDeltaMovement(vec35.multiply(0.99, 0.98, 0.99));
//                    :2302     this.move(MoverType.SELF, this.getDeltaMovement()); // ← 位移
```

调用链：`LocalPlayer.aiStep` → `AbstractClientPlayer.aiStep` → `Player.aiStep`（`Player.java:1628` 调 `super.travel`）→ `LivingEntity.aiStep`（`LivingEntity.java:2824` 调 `travel`）。`LocalPlayer`/`Player` 不覆盖滑翔分支。

### 3. 实体 tick 顺序：本地玩家先于被附着的烟花

- `EntityTickList` 的两个 map 都是 `Int2ObjectLinkedOpenHashMap`；`add` 为 `active.put(entity.getId(), entity)`（`EntityTickList.java:32`），`forEach` 按 `active.values()` 插入序迭代（`:50`）。
- 客户端：`Minecraft.tick` → `ClientLevel.tickEntities`（`Minecraft.java:1956`）；`ClientLevel.tickEntities` → `tickingEntities.forEach(this::tickNonPassenger)`（`ClientLevel.java:257`），`tickNonPassenger` 在 `:278` 调 `entity.tick()`；玩家在加入世界时就进入该列表，烟花是后来才生成并 `add` 的，所以玩家先 tick。
- 服务端同理（`ServerLevel.java:372`、`:770`、`:1582`）。

因此烟花对速度的写入发生在玩家本 tick 的 `move()` 之后：位移用旧速度，速度含新推力——与实测采样边界一致。

## 保留意见

"玩家先于烟花"来自插入序 + 生成时序，不是硬编码规则；若玩家 tick 段被移除后重加（区块/段重载窗口），该窗口内顺序可能反转。要 100% 钉死，需要在运行时打印 `entityTickList`/`tickingEntities` 的顺序，或对玩家与附着的烟花各打一次 `tick()` 入口日志。若之后生成反编译源码，应按上列行号复核 `FireworkRocketEntity.java:113-176`、`LivingEntity.java:2184-2353` 与 `:2815-2826`。
