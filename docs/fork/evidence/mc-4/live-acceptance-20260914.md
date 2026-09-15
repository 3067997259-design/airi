# MC-4 统一真机验收（2026-09-14）

上游：[MC 执行计划](../../minecraft-player-capability-execution-plan.md) §6、[能力缺口](../../minecraft-player-capability-gaps.md)、[MC-4a](../../mc-4a-spec.md) 至 [MC-4f](../../mc-4f-spec.md)。

## 环境与产物

- **服务端**：自建 Fabric 1.21.1（offline），`D:\Minecraft-Server`；mcpfabric 服务端入口 **0.2.3**（验收期间未升级）；桥 `127.0.0.1:25598`，MCP `25602`。
- **AIRI 客户端**：PCL 实例 `versions\AIRI`；mcpfabric **0.2.12**（jar SHA-256 `d0f1c70e22ae1a65c5cc6b9e7d645b8ace06b8b79c0cf6997a1c9bd741c0ad38`）；桥 `127.0.0.1:25599`，MCP `25600`。
- **用户客户端**：第二实例（玩家 `AfterRain`，创造），负责聊天下单与真机配合。
- **AIRI 应用**：Electron 预览（`airi-wrap.cmd`，CDP 9222，`AIRI_TERRAIN_DEBUG=1`）；游戏宿主 devtools 页 `#/devtools/game-host`（`window.__AIRI_GAME_HOST_SMOKE__.executeGameTool`）。
- **夹具**：庭院平台（74..98,74,-30..-10）与箱子 (78,75,-25)/工作台/熔炉/铁砧/附魔台/床/告示牌/村民；鞘翅塔与山脊、水岛、岩浆池与炽足兽（MC-3c 保留）；庭院原木 (92..94,75,-20) 供采集；测试用雨（`world.setWeather {durationSeconds}`）。

## A. MC-4a 观察与物品使用 — PASS

- `game_equip`：剑/盾/头盔换装，`equipped` 后条件 + 新鲜装备读核对。
- `game_use`：mode item 正常释放与 `abort`（释放会触发蓄力物、中止不会）；mode block 放置火把；mode entity 右击村民开出交易菜单。
- 观察回执扩展（背包/装备/效果 + 截断与缺失标记）随工具返回。

## B. MC-4b 菜单与生产 — PASS

- 箱子：open → snapshot → move 16 煤 → 核对 → 移回 → close，全程 containerId 身份校验。
- `craft_table`：木板 16→8 + 箱子 ×1，`crafted` 后条件；未知配方诚实失败（`not_confirmed`）。
- 熔炼：`smelt_load` 返回 `stage=cooking` 并可读进度；`smelt_take` 铁锭 +3、残留煤 15（领取前清残留）。

## C. MC-4c 生存连续性 — PASS（follow 修复后）

- `supply`：食物 14→19（`already_full` 守卫修复后不再谎报）。
- `sleep`：`slept`；`respawn`：床点重生（keepInventory 夹具）。
- `collect`：3 原木逐块破坏 + 走到掉落物上拾取，`collected` 后条件 1/1 met；落入凹洞的掉落拾取腿 `no_path`，如实报告。
- `follow`：修复后从 (96,-28) 追到 (91.8,-18.2)，与目标距离 11 格 → **1 格**并保持，期限 `timeout` 干净收尾。

## D. MC-4d 远程战斗 — PASS（含误伤保护）

- 弓：单发击杀（投射物 UUID 归属 + `entity_death`）。
- 弩：装填 → 发射 → 击杀（`charge-cleared` 证明）。
- 三叉戟：忠诚 `returned:true`；普通 `returned:false`；蓄力取消不发射；发射后取消保留已发事实；无箭 `no_ammo`。
- **friendly_blocked**：用户站到弹道 0.04 格 → 拒绝射击（零耗箭 63→63）；用户离开弹道 7.6 格 → 正常射击并击杀（箭 63→62）。

## E. MC-4e 快速保命与进阶移动 — PASS

- **落地水**：y88 自由落体 → 落地自动放水（85..87,75,-21..-23 为水），血量 20 无摔伤。
- **激流（水中）**：深水 y58 蓄力释放，位移 14.85 格，落点 met。
- **激流（雨中）**：客户端重连同步天气后雨中起飞，位移 14.66 格，met。
- **条件失败**：`riptide_unavailable`（`unmet: not_in_water_or_rain`，0 蓄力、不发射）。
- **维度切换**：运行中 `move_to` 途中传送到下界 → `cancelled / dimension_changed`，回执保留签发维度（overworld）；绑定刷新为 the_nether、新维度命令可用；回到主世界后旧绑定信封被终止，重建后新命令 `reached`。

## F. MC-4f 生活与内容 — PASS

- `place`：火把放置（新鲜世界读确认 + 库存减少）；菜单开启时 `menu_open` 诚实失败（验收中发现并修复）。
- `read_sign`：正面两行文本；`read_item`：成书 title/author/pages（内容不进 checked 路径）。
- 铁砧 `set_name`：`renamed`，结果槽命名生效。
- 村民 `select_trade`：selected offer 的输入槽填入 3 绿宝石、产物槽 2 面包。
- 附魔台 `button`：发送原版按钮点击包，服务端结算（青金石 3→2、剑 +unbreaking 1），`button_applied`（有界菜单重读观察到变化）。
- **补测（同日，服务端升级后）**：
  - 石切机 `button`：石头入槽 → `button_applied`，结果槽出现 `minecraft:chiseled_stone_bricks`（服务端选配方）。
  - 织布机 `button`：白旗+红染料入槽 → `button_applied`，结果槽变为成品旗（按钮前为空）。
  - 酿造台：水瓶×3 + 下界疣 + 烈焰粉入槽，等待 26s 后配料与燃料槽被清空（酿造完成）。
  - `sneak` 放置：`place {sneak:true}` 放箱子成功且**不打开**菜单（`read_menu` → `no_menu`）。
  - 告示牌双面：`read_sign` 返回正面 `MC-4F sign / second line` 与背面 `back line 1 / back line 2`。
  - 服务端 `world.findBlocks`（0.2.12）：三个测试原木按距离升序返回（3.0 / 7.81 / 9.0 / 14.0）；`game_collect` 经 server-first `find_blocks` 的候选顺序为近→远（`89,75,-16` 先于 `79,75,-28`），破最近并拾取成功。
  - **信标 `button`（限制）**：`BeaconMenu` 不实现 `clickMenuButton`，原版信标用独立的 `ServerboundSetBeaconPacket` 结算；`menu.button` 发出按钮点击包后信标无任何结算（`button_sent` / `applied:false`、无效果）。行为诚实，支持信标需要专用原语（见 mc-4f-spec）。
  - **地图正文（模组 0.2.12）**：`give minecraft:map` + 使用生成真实地图；首次读 `unsupported:true` 只给 id（同步前诚实读），数秒后重读得到 `map {id:0, scale:0, dimension:minecraft:overworld}`（服务端 `data get` 复核 `map_id:0`）。

### R8 修复复测（模组 0.2.13，2026-09-14）

[能力复审](../movement-review-20260914/movement-review.test.ts) R8 指出 `menu.set_name`/`menu.select_trade` 只调客户端本地方法。真机确认：`select_trade` 后服务端菜单输入槽为空，取货无结算、背包不变。修复：`menu.select_trade` 增发 `ServerboundSelectTradePacket`、`menu.set_name` 增发 `ServerboundRenameItemPacket`（模组 0.2.13，jar SHA-256 `f78aeb10…92198`）。

- **交易结算 PASS**：选单后输入/产物由服务端同步；取货后背包 3→2 绿宝石、0→2 面包（服务端真实扣款给货）。`move_item` 偶发 `not_confirmed` 属验证窗口早于服务端结算，背包差值为准。
- **交易补货 PASS**：`data modify … uses=16` 制造缺货 → 应用 `select_trade` 报 `outOfStock:true`；村民在堆肥桶工作后 `uses` 归零（字段消失），应用重选报 `outOfStock:false`（需求重算）。
- **铁砧改名服务器侧 PASS**：改名并取货后，服务端 `data get entity airitest Inventory` 出现 `minecraft:custom_name: '"ServerSword"'`。

## 验收中修复

### 模组 0.2.6–0.2.12

- 0.2.6：`menu.snapshot/button` 对玩家 inventoryMenu 报 `no_menu`（不再命中不存在的原版路径）。
- 0.2.7：射击计数（弹药兜底、`maxShots` 守卫、每发 `shotVerifiedBy`）。
- 0.2.8 / 0.2.9：弩装填清除核对、`ItemJson` charged、瞄准稳定、`isCrossbowCharged` 空组件修复。
- 0.2.10：`world.findBlocks` 壳层扫描、预存投射物排除、`friendlyInLine` 误伤守卫。
- 0.2.11 / 0.2.12：`menu.button` 改为发送原版按钮点击包（原实现调用客户端本地 `clickMenuButton`，返回 accepted 但服务端零结算）；并修掉嵌套 `ClientMc.call` 造成的 8 秒死锁（包在超时返回后才发出）。

### AIRI

- `game_place` 增 `menu_open` 预检（菜单开启时静默 `not_confirmed` → 诚实失败）。
- `menu_action button` 回执改为 `sent` + `applied`（有界菜单重读），契约、事件形状与单测同步。
- 采集：破块后走到掉落物拾取、失败轮有界重试、接近/拾取支持邻居站位回退。
- **follow 真根因修复**：`runTerrainLeg` 目标取整（`Math.floor`）——实体的**小数坐标**永远匹配不上整数规划节点，导致每腿 `no_path`、她一步未走；`missing …` 只是探查越界的诊断旁注。加固：落点扫描按 `maxDropDown` 封顶、移动读区域下界 `2*maxDropDown+1`。
- `stopActive` 在记录上保留类型化停止原因：快速返回的执行器不再把 `dimension_changed` 改写成 `cancelled`。

## 检查

- game-host/movement 定向 **204 passed / 1 skipped**；`stage-tamagotchi` typecheck 0；eslint 0。
- 模组 `:1.21.1:build` 0.2.12、mcp-server `npm run build`、应用 `build` 全部成功。

## 未决与限制

- ~~服务端模组仍为 0.2.3~~ **已升级（2026-09-14，用户同意重启）**：专用服务器升级到 0.2.12（同一 jar），`world.findBlocks` 验证按距离升序返回（3.0 / 7.81 / 9.0 / 14.0），近处优先。
- `worldIdentity` 缺失（应用在无玩家时连接）时不检测维度变化（执行计划 §9-1）。
- 客户端天气事件丢失：服务端 `raining:true` 而客户端 `isInWaterOrRain` 为假（重连恢复）；建议 `riptideStatus` 补 `inWater/inRain/rainLevel` 诊断字段（§9-3）。
- 激流 `durabilityAfter` 采样早于服务端同步（§9-4）。
- 寻路/搭桥质量（§9-5）、采集掉落凹洞（§9-6）、devtools smoke promise 回传（§9-7）。
- MC-0a 遗留：1.21.11 冒烟、断线场景、资源测量（未做）。
