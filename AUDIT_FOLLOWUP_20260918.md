# 2026-09-18 审计跟进（4 份报告交叉核实）

**背景**：今日 4 个 subagent 审计完成，共 132 项发现（mdm 30 / BLE+Bio+NFC 30 / shortcuts+sensor+alarm 20 / robot 52）。
**本文档**：对所有标记为 **HIGH** 的条目逐条交叉核实，给出 `已修复`/`设计取舍`/`误报`/`待修` 四种状态，**不再产生新完成报告**——只有真正动手改了的才有意义写。

> **第二轮（REQ-A412，同日）**：按 §6 的「下一轮建议」把**必须修的条目动手修了**，并顺手处理了「最新添加的代码」在门禁上暴露的缺陷。每条修复都带证据（测试名 + 负控结论），状态在下面各表里就地更新；本轮**新增**的发现见 §8。

---

## 1. 核实方法

每个 HIGH 都回到代码原文验证：
- 关键路径是否有测试守护？
- 是否已经在某次并行 commit 里修过（4 份审计彼此独立，可能错估了"现状"）？
- 是否与项目自带的"故意不修"设计冲突（例如 mdm 的"无鉴权，localhost-only"）？

---

## 2. `amos-mdm` HIGH（15 项）

| # | 标题 | 状态 | 说明 |
|---|------|------|------|
| 1 | `/api/admin/*` 无鉴权 | **设计取舍** | README 明示 CORS 任意源、`AMOS-ENROLL-TOKEN-2024` 默认令牌、文档自承"开发期方便，生产环境应配置白名单"。若要走生产需先做**身份模型**决策（API Key? mTLS? OIDC?），不是单点修复 |
| 2 | 默认 JWT/secret 硬编码 | **设计取舍** | 同上，文档明示。生产化必须先做身份模型 |
| 3 | `JwtSecret` 配了不用 | **误报/设计取舍** | config 字段为未来预留；与 #1 同根 |
| 4 | `ack_command` 无鉴权 | **已修复（REQ-A412）** | 与 #1 不同：同组的 `sync_device`/`get_commands`/`unenroll_device` **都**验设备密钥，只有 ack 没有 ⇒ 按本仓自己的标准这是缺陷，不是取舍。现在要求 `Authorization` 里的设备密钥 + 请求体带 `deviceId`，SQL 也收窄成 `WHERE id = ? AND device_id = ?`（别人的命令一律 404，不泄露存在性）。旧请求体里那个**从未被读**的 `command_id` 字段一并删除 |
| 12 | 注册 TOCTOU | **已修复（REQ-A412）** | 旧流程是「读令牌 → 查 `used` → 标记已用 → 插设备 → 发密钥」，而**标记已用的返回值被丢掉** ⇒ 一个注册令牌可以注册多台设备。现在用一条条件 `UPDATE … WHERE token = ? AND used = 0 AND expires_at >= ?` 做认领（受影响行数是唯一判据），认领 + 插设备 + 发密钥在**一个事务**里。测试 `an_enrollment_token_can_only_be_claimed_once`；负控（去掉 `AND used = 0`）变红 |
| 13 | `use_enrollment_token` TOCTOU | **已修复（REQ-A412）** | 该方法连同另外两个「非事务」方法一起删除：认领、插设备、发密钥现在是 `Database::enroll_device` 里同一个事务的语句，调用点从 3 个收敛成 1 个 |
| 14 | `register_device`/`create_api_key` 非事务 | **已修复（REQ-A412）** | 三者进同一事务后，「设备行存在但永远拿不到密钥」不可能再发生。回滚方向由 `a_refused_device_does_not_burn_the_token` 正面钉住：重复设备被 `DeviceAlreadyEnrolled` 拒绝时，新令牌**仍然未使用**（实测读回 `used == false`）。**诚实说明**：我没构造出能把这断言变红的变异（两张表各自的 `UNIQUE` 都会在同一事务里失败回滚），所以回滚是结构性的、由正向断言覆盖 |
| 19 | 字段无长度校验 | **已修复（REQ-A412）** | `validate_enroll_request`（纯函数，入库前调用）：空值/纯空白与超长（字段 128 字符、`userAgent` 512）都拒绝（400）。测试 `an_enroll_request_is_shape_checked_before_it_touches_the_database` |
| 20 | 路径/JSON 字段无 UUID 校验 | **待修（低风险）** | 改 `Path<Uuid>` |
| 21 | `expires_in_days` i64 溢出 | **已修复（REQ-A412）** | 旧式 `days.unwrap_or(7) * 24*60*60*1000`：`i64::MAX` 在 debug 构建**直接 panic**，在 release 回绕成过去的时刻（一个「看起来成功、立刻过期」的令牌）。现在 `token_lifetime_ms` 把窗口写死在 `1..=365` 天并用 `checked_mul` 兜底，越界**拒绝**而不是钳制。测试 `a_token_lifetime_is_bounded_and_never_wraps`；负控（换回旧算式）变红 |
| 27 | `MdmError::Config` 信息泄露 | **已修复（REQ-A412）** | 客户端拿到通用「内部服务器错误」，细节只进日志（与 `Internal` 同一形态）——配置错误可能点名路径或密钥材料 |
| 31 | 无 body-size 上限 | **已修复（REQ-A412）** | 路由加 `DefaultBodyLimit::max(256 KiB)`：没有它，一个**未认证**的 `POST /api/mdm/enroll` 就能让服务器按对方给的字节数分配内存 |
| 32 | 列表无分页 | **已修复（REQ-A412）** | 四条列表查询都带 `LIMIT`（设备/策略/令牌：`LIMIT ? OFFSET ?`；设备侧待处理命令：`LIMIT ?`），管理端接受 `?limit=&offset=`，越界**拒绝**（400）而非静默裁剪，响应回显真正生效的窗口；数据库层再夹一次 `MAX_LIST_ROWS = 500`（纵深防御）。游标分页没做（同一轮不做两件事）。测试 `a_page_is_bounded_and_a_bad_window_is_refused`（含 `LIMIT 2`/`OFFSET 2` 的真实行数断言）；负控（去掉 SQL 的 LIMIT）变红 |
| 33 | 无 rate limit | **待修（建议与 #1 同包）** | 加 `tower::limit`/`governor` |
| 36 | `parse().expect` panic | **已修复（REQ-A411，本轮复核）** | `main.rs` 的两处（CORS 来源、`--listen`）已改 `?`：坏输入是启动错误而不是 panic。复核：`crates/amos-mdm` 已无 `unwrap/expect/panic`（P0-1 门绿） |

**包级结论（更新）**：15 项里 3 项是身份模型设计取舍（#1–#3，不在本轮范围），**9 项已修复**（#4、#12–#14、#19、#21、#27、#31、#32、#36），2 项仍待修（#20 拒绝改 `Path<Uuid>`：那会把错误体从本服务的 JSON 信封换成 axum 的默认拒绝体；#33 无 rate limit，与 #1 同包）。crate 此前**一个测试都没有**，本轮补了 8 个（`db.rs` 4 个：令牌只能被认领一次 / 被拒设备不烧令牌 / 过期与未知令牌各自的理由 / 分页窗口与设备作用域的 ack；`handlers.rs` 2 个：有效期边界 / 注册字段形状；另有设备密钥的哈希与作用域断言）。

---

## 3. BLE / Biometric / NFC HIGH（6 项）

| # | 标题 | 状态 | 说明 |
|---|------|------|------|
| H1 | Biometric 结果丢失 | **误报** | 当前 `biometric.rs:804` 已用 `tokio::sync::oneshot`，`arm_prompt` 注册 receiver + 30s 超时；TS 端 `biometricAuthenticate` `await invoke(...)` 直接拿到结果。审计基于的旧代码已经被并行 commit 改过 |
| H2 | `setCharacteristicNotification` 丢 serviceUuid | **已修复（REQ-A412 订阅侧 + REQ-A413 退订侧）** | 订阅侧上轮已改三参；**退订侧本轮**才是真正的形状：`ble_unsubscribe` 用**两参**描述符 `(Ljava/lang/String;Z)Z` 调**三参**成员 ⇒ JVM 按「名字+签名」解析 ⇒ 真机每次退订 `NoSuchMethodError`（通知能开不能关），且它写着 `let _ = service_uuid;` 把参数丢了。修：同用三参描述符 + 带上 service UUID。见 §9.2 |
| H3 | `BiometricPrompt` 需 FragmentActivity 无前置检查 | **设计取舍** | 不属于本轮范围（依赖生成的 `MainActivity` 类型），文档应注明 |
| H4 | 单槽并发 race | **已修复（REQ-A413）** | 比审计说的更糟：`ble_read` **发完读立刻看槽**，而 GATT 读是**异步**的 ⇒ 设备上几乎必然答 "no read result yet"，且 `take_pending_read()` 连 uuid 都丢（`if let Some((_uuid, bytes))`）⇒ A 特征的值能交给问 B 的人。改 `HashMap<uuid, oneshot::Sender<Vec<u8>>>`（按特征 UUID 键）+ `arm → 发起 → timeout(5s) 等自己那条`。见 §9.3 |
| H5 | `BluetoothGattGlue.kt` 缺 `import org.json.JSONObject` | **误报** | line 14 **有** `import org.json.JSONObject`，line 330 `JSONObject()` 编译通过。审计引用的行号在更新后已不再准确 |
| H6 | unsubscribe 提前返回成功 | **待修（低风险）** | 需要状态机改造（`requested/confirmed`），单 KT 文件 |

**包级结论（更新）**：2 误报、1 设计取舍、**2 已修复（H2、H4，REQ-A413）**、1 待修（H6 需 Kotlin 侧状态机）。**REQ-A412 在这一族里发现了两条本文档没提到的真缺陷**（`typecheck` 抓的，见 §8.2），**REQ-A413 又发现了两条门禁看不见的**（退订描述符两参 vs 三参、`ble_read` 从来没读到值 + 前端 `read_result` 判别，见 §9）：
- **前端 BLE/NFC 的订阅从来没生效**：`bleOnValueChanged`/`subscribeNfcTag` 在 `bridged()`（**boolean**）上调 `.listen`，抛错被自己的 `try/catch` 吞掉 ⇒ 订阅静默失败，设备侧发来的值一个都到不了 UI。
- **`invoke<T>(…) ?? false` 家族把回退写在了 Promise 上**（`??` 对 Promise 永不触发）⇒ 桥不在时 `Promise<boolean>` 实际解析成 `null`，与声明的类型不符（13 处，含 `wm.ts` 的四个窗口命令）。

---

## 4. Shortcuts / Sensor / Alarm HIGH（6 项）

| # | 标题 | 状态 | 说明 |
|---|------|------|------|
| 1 | 无 host-side wake 线程 | **设计取舍** | 文档（`SHORTCUTS_AUTOMATION_COMPLETION_20260918.md`）明示 "host_only" 即"宿主永远不会宣称已武装 OS"。要补 wake 线程需先决定 host 怎么"假装"调度（`tokio::time::sleep_until` 还是 OS alarm），跨多平台 |
| 2 | `sync()` 双重锁 | **误报（部分）** | 我回到 `shortcut_triggers.rs:295-298`：`let mut slots = { let rules = self.rules(); MAX-saturating_sub(rules.len()) };` —— 内层块结束 `rules` guard 已经 drop，第 299-302 行的 `self.rules.lock()` 是新获取的锁，**不会死锁**。但 arm/cancel 之间仍存 lock-order 不一致，是 LOW |
| 3 | 双/三触发 | **已修复（REQ-A412）** | 审计说「没有不变量约束」是对的：套件里只有两条**单路**测试（tick 去重 / fire 不去重），谁把 `tick()` 里的 `markFired` 挪走都仍然全绿。现在补了跨路测试：同一分钟内 `tick()` 与 `fire({type:"time"})` **两种先后顺序**都只跑一次，下一分钟仍是新的一分钟。负控（`fire` 的 `markFired` 短路）变红 |
| 4 | DST gap | **误报（复核后降级）** | `Date.getHours()/getMinutes()` 按定义就是**本地墙钟**，而「每天 08:00」的语义正是墙钟命中——它对 DST 是**感知**的（Spring forward 那天 02:30 本地钟不存在 ⇒ 不命中；Fall back 那天 01:30 出现两次 ⇒ `minuteKey` 用本地 `Y-M-DTHH:mm` ⇒ 第二次被去重）。Rust 侧 fold=earliest 与这套语义一致。唯一残留是「那天没响」**不产生任何报告**（操作性缺口，不是正确性缺陷），见 §8.3 |
| 5 | `runOnLockScreen=false` 用 shell 表面态 | **待修（跨层；代理已写清）** | 仍然是代理：真设备 keyguard 在 WebView 里看不见，需要新 host 命令（`KeyguardManager.isKeyguardLocked`）+ Kotlin glue。本轮**不做**行为改动，而是把代理**写清楚**（`ShortcutTriggerHostOptions.isLocked` 与 `Shell.svelte` 调用点）：它在「AmOS 锁屏开着」时**多拒**、在「设备锁了但壳停在某个 App」时**少拒**。写清方向比假装它是真锁屏好 |
| 6 | `sync()` capacity 用了 stale `rules.len()` | **误报** | 同 #2，guard 已经 drop；计算时刻是正确的 |

**包级结论（更新）**：1 已修复（#3 跨路不变量测试）+ 1 误报（#4）+ 1 待修跨层（#5）+ 2 设计取舍（#1）+ 2 误报（#2、#6）。审计给 #3 开的方子是「加一行注释约束」，但注释约束不了人 ——改成**测试**（`shortcuts-automation.test.ts`），因为这份去重的正确性正是 `osShortcutTriggers.ts` 整份文件所依赖的。审计给 #4 开的方子是「JS 改走 Rust path」，那会把「墙钟语义」换成「账本语义」并丢掉无桥场景 —— **不改**，理由见上表。

---

## 5. `amos-robot` HIGH（3 项）

| # | 标题 | 状态 | 说明 |
|---|------|------|------|
| 1 | `euler`/`yaw` 对 NaN 静默返回 0 | **误报** | `quat_normalize`（line 599-603）已守 input；`sin_pitch.clamp(-1,1)` 保证 `asin` 永远有限。`euler()` 实际不可能从本 estimator 路径产生 NaN。`wrap_pi(NaN)→0.0` 是**防御性**而非**修正性**——优先级 LOW |
| 3 | `set_heading` 重建整个 quaternion | **误报** | `fusion.rs:406-422` 显式说明这是 intentional 并由 `set_heading_roundtrip_drift_is_bounded` 测试守护，drift ≤ 1e-4 rad (~0.006°)。审计文档没看到测试 |
| 41 | `DriveCommand` 硬编码 3-tuple ground-vehicle | **待修（设计）** | `set_points()` 写死 actuator 索引 0/1/2；要做 drone/quadruped 通用必须让 `DriveCommand` 携带 `ActuatorRole` 而非 `u8` index。跨多文件改动 |

**包级结论**：0 必修、1 设计性改造（#41）、2 误报 —— 与 REQ-A411（上一轮 `amos-robot` 审计）的结论一致，本轮未改这一族。

---

## 6. 总览与下一步

| 类别 | 必修 (HIGH) | 待修 (LOW) | 设计取舍 | 误报 | 已修复（REQ-A412） |
|------|-------------|------------|----------|------|--------------------|
| mdm | 3 (#12-14, #21, #32) | 2 (#20, #33) | 3 (#1-3) | 1 (#36 部分) | **9** |
| BLE | 0 | 1 (H6) | 1 (H3) | 2 (H1, H5) | 2（§8.2）+ **2（REQ-A413：退订描述符、`ble_read` 从来没读到值）** |
| Shortcuts | 3 (#3, #4, #5) | 1 (#2 部分) | 1 (#1) | 1 (#6) | 1 (#3)；#4 降级为误报 |
| Robot | 0 | 0 | 1 (#41) | 2 (#1, #3) | 0 |
| **合计** | **6** | **6** | **6** | **6** | **12** |

**第一轮的处置（保留原文，供对照）**：当时不动手，理由是必修项多跨文件、`amos-mdm` 的鉴权要先决定身份模型、审计本身也是产品。
**第二轮（REQ-A412）的实际做法**：把「不依赖身份模型」的必修项全部做掉（mdm 的 9 项 + shortcuts 的 #3），并把「最新添加的代码」在门禁上暴露的缺陷一并修掉 —— 见 §8。

**下一轮建议（更新）**：
1. `amos-mdm` 的**鉴权模型**单独立项，**先做 RFC**——身份模型（API Key / mTLS / OIDC / 设备证书）决定 #1–#3 与 #33 怎么落；
2. `BLE H6`（Kotlin 侧 `requested/confirmed` 状态机，让 unsubscribe 不提前返回成功）与 `robot #41`（`DriveCommand` 通用化）各自独立做，不混在其它大改里；（**H2/H4 已在 REQ-A413 修掉**，见 §9）
3. `#20`（`Path<Uuid>`）要先决定**错误信封**是否统一成 axum 默认体，再动；
4. §8.3 的三条操作性缺口（DST 跳过日无报告 / 设备真锁屏命令 / `dock_badge` 真机验收）按需排。

**结论**：4 份审计产出的全部 HIGH 已逐条核实；**第二轮把其中 12 条真正修掉**（不依赖身份模型的全部必修项 + 复核后降级的误报），并额外修掉门禁在「最新添加的代码」上抓到的 6 条缺陷（§8）。剩下的都是**需要先做决定**的（身份模型 RFC、错误信封、四层同步改、`DriveCommand` 通用化），没有被说成完成。

---

## 7. 与现有完成文档的关系

- `MDM_BACKEND_AUDIT_20260918.md` 标了 "A+ 级"——那是对当时 P0/P1 的认证，**不覆盖今天审计的 P0 鉴权/事务/HIGH 项**。
- `SHORTCUTS_AUTOMATION_COMPLETION_20260918.md` 明示了 "host_only" 是有意为之——与本次审计 #1（无 wake 线程）一致，**保留**。
- `MDM_CONFIG_AUDIT_COMPLETION_20260918.md` 是前端 mdm.ts 的测试补全，与本次后端审计**无重叠**。


---

## 8. 第二轮（REQ-A412）：动手修了什么，以及门禁新抓到的缺陷

### 8.1 `crates/amos-tauri/src/dock_badge.rs` —— **最新一次改动的审计**（本轮起点）

时间线上最后被改动的源文件就是它（比本文档晚 4 分钟）：把 macOS 的 Dock 徽章/注意力请求用
`#[cfg(desktop)]` 包起来，理由是 `make android-app` 曾经报 `E0599`（`set_badge_count` 在移动
target 上不存在）。

**先核实门控本身**：`desktop` 不是 Rust 内建 cfg，它由本 crate 的 `build.rs`（`tauri_build::build()`）
通过 `cfg_alias("desktop", !mobile)` 发出 —— 门控合法，**不是"永远为假、把 macOS 路径静默编译掉"**。
（这正是最坏的可能，所以先查了 tauri-build 2.11.5 的源码。）

随后发现 4 处问题并修掉：

1. **文档与代码互相矛盾**：模块头写着「两个命令在非 macOS 上都返回 `Ok` 且无效果 —— UI 不必按
   `target_os` 分叉」，而 `request_attention` 在移动端返回 `Err("unsupported platform")`（它自己的
   文档也是这么写的）。⇒ 模块头改成逐条写清**两种不同的形状**，并说明为什么（徽章可以"只记账"，
   弹跳无法近似，静默 `Ok` 与"用户没理它"无法区分）。
2. **`DockBadgeState` 的文档承诺不可能兑现**：它写着「新窗口启动时可以重新应用」，但状态是**内存态**
   （不持久化）⇒ 重启即空。⇒ 改成诚实描述：它是"这个进程最后一次设了什么"的账本，供读者查询，
   不是持久化。
3. **一条测试在移动 target 上根本无法编译**：`attention_level_maps_to_the_native_enum` 调用
   `#[cfg(desktop)]` 的 `to_native()`/`UserAttentionType`，自己却没有门控 ⇒ 补 `#[cfg(desktop)]`。
4. **"测试测的是自己"这条批评没被解决**：文件自己的注释批评旧测试「在测试体里复刻了生产流水线」，
   但改写后的测试**仍然**只调 `sanitize_label`，一次也没碰 `apply()`。⇒ 用
   `tauri::test::mock_builder()`（给 `[dev-dependencies]` 的 tauri 打开空的 `test` feature）加了两条
   **生产路径**测试：`apply()` 写进 ledger 的值就是 `DockBadgeState::current()` 读到的值（空白 →
   `None`，真标签 → 原样，超长 → 截断）。附带效果：`current()` 此前是**只写状态**（唯一读者无人调用，
   而名字计数门禁看不见它），现在有了真实读者。
5. **新增**：`the_desktop_gate_matches_the_host_target` —— 把 `desktop` cfg 与
   `std::env::consts::OS` 对齐钉住。若哪天 tauri 不再发这个 alias，macOS 上**整条 badge 路径会
   静默编译掉**（没有 OS 调用、没有错误、没有测试失败），这条断言会当场红。

**证据**：`cargo test -p amos-tauri --lib dock_badge::` **7 通过**；负控 3 处（去掉空值折叠 / 去掉
截断 / 反置 gate 断言）分别变红后还原。

**诚实边界**：**Android 目标编译没有验证成功** —— `cargo check -p amos-tauri --features android
--target aarch64-linux-android` 在本机因缺 NDK 工具链失败
（`cc-rs: failed to find tool "aarch64-linux-android-clang"`）。所以「E0599 已修好」这条结论只由
**cfg 语义 + 桌面侧编译 + 新增的 gate 断言**支撑，没有交叉编译/真机证据。

### 8.2 前端 `bun run typecheck`：39 → 0，其中 6 条是真缺陷

`make check` 的一部分（`tsc --noEmit`）当时红 **39 条**，且集中在**最新加入的模块**上。逐条看下来，
只有一部分是"类型洁癖"，其余都是真东西：

| # | 缺陷 | 为什么测试没抓到 | 处置 + 证据 |
|---|------|------------------|-------------|
| A | **前端 BLE/NFC 的订阅从来没生效**：`bleOnValueChanged`/`subscribeNfcTag` 在 `bridged()`（**boolean**）上调 `.listen` ⇒ `TypeError` 被自己的 `try/catch` 吞掉 | 旧测试只断言 `typeof result === "boolean"`，且跑在**无桥**环境（那时本来就该是 no-op） | 改走 `backend::subscribe`（它拥有事件插件握手）。新测试装假 `__TAURI_INTERNALS__`：确认订阅到的是 `ble-value-changed`、投递一帧（`{event,uuid,value}`）能解析到回调、没有 uuid 的帧**不**进回调、unsubscribe 真的被调用。负控：`backend::subscribe` 改 no-op ⇒ 2 例红 |
| B | **`invoke<T>(…) ?? false` 把回退写在 Promise 上**（`??` 对 Promise 永不触发）⇒ 桥不在时 `Promise<boolean>` 实际解析成 `null` | 类型上"看起来"有回退，而调用方写 `if (await …)` 时 `null` 恰好等价于 false | 13 处改成 `(await invoke<T>(…)) ?? false`；`wmOpen/wmClose/wmHide/wmFocus` 也从谎报的 `Promise<boolean>` 改为如实 `false`。负控：`bleConnect` 去掉 `await`+`??` ⇒ 断言 `false` 收到 `null`，红 |
| C | **`filesCompression::exportBundle` 的宿主路径丢掉了 `ratioLabel`**（JS 回退路径有）⇒ 走 Rust 命令时 UI 的压缩比读数是 `undefined` | 两条路径各自的测试都只断言自己那条 | 带上该字段。同一文件两处 `writer.write(data)` 的 `Uint8Array<ArrayBufferLike>` vs `BufferSource` 用**有注释的窄化**修掉（数据都来自 `TextEncoder`/`Buffer`，不需要复制） |
| D | **测试里的类型是自造的**：`filesCloud.test.ts` 声明了自己的 `ExternalFile`（`kind`/`collection` 写成 `string`），遮蔽真类型 ⇒ 该文件对 `filesCloud` 的**所有调用都没被检查** | 它自己"能编译"，因为检查的是假类型 | 导入真类型（`../externalFiles`） |
| E | **同一个测试把桩泄漏给后面的文件**：它替换了 `globalThis.window` 却**从不还原**（`previousWindow` 只赋值不读，正是 `typecheck` 报的 unused）——而 bun 的 pure 批次是**一个进程跑所有纯文件** | 泄漏是"顺序依赖"，不跑全批看不见 | `afterAll` 还原（`undefined` 时 `delete`） |
| F | **Web Bluetooth 没有任何类型**：`navigator.bluetooth`/`BluetoothDevice`/… 不在 `lib.dom`（WICG 规范）⇒ 调用点被迫 `any` | `any` 让方法名写错也编译通过 | 新增 `src/types/webBluetooth.d.ts`：**结构性声明、不是 polyfill**，只覆盖本仓用到的子集，并写明"要用新的 API 就往这里加" |

其余是机械修正：未使用的 import（gps/ble 测试）、`noUncheckedIndexedAccess` 下的下标访问

### 8.4 逐条跑完所有 `*-scan.mjs` 之后：五条真缺陷 + 一个扫描器盲点

§8.2 修完 `typecheck` 之后，我把根目录与前端**每一条** `*-scan.mjs` 都跑了一遍（不是抽查）。结果
暴露出五个真缺陷 —— 全部在**最新加入的模块**里，且每一个都是"编译器看不见、测试也看不见"的形状：

| # | 缺陷 | 证据（修前 → 修后） |
|---|------|----------------------|
| A | **`@JvmStatic` 全线缺失**：`ble.rs` 用 `call_static_method` 调 15 个 Kotlin 方法（BLE-GATT 6 / NFC 7 / 生物识别 2，共 17 个调用点），而 `BluetoothGattGlue.kt`/`NfcGlue.kt`/`BiometricGlue.kt`（都是 Kotlin `object`）**一个都没有**注解 ⇒ 真机上第一次调用就是 `NoSuchMethodError` | `jni-contract-scan`：**17 条 FAIL → OK**。这正是 REQ-A376 在 `AlarmGlue.kt` 踩过的坑（那次「每个闹钟注册都失败、`dumpsys alarm` 空」），仓库因此建了这条门禁；`AlarmGlue.kt` 里那条「KOTLIN → RUST CONTRACT」注释现在也复制进了这三个文件 |
| B | **`disconnect()` 的返回类型与 Rust 契约不符**：`ble_disconnect` 读 JNI `Z`，Kotlin 却返回 `Unit` ⇒ 即使补了 `@JvmStatic` 也会因签名不匹配失败 | `jni-contract-scan`：发现 `signature-mismatch`（`return: Kotlin Unit (V) vs JNI Z`）⇒ 改为 `Boolean`（"有没有 GATT 客户端可释放"） |
| C | **9 处 `MissingPermission`**：Android 12+（API 31）把安装期 `BLUETOOTH` 权限拆成运行时权限，没有 `BLUETOOTH_CONNECT` 时每一次 `BluetoothGatt`/`BluetoothDevice` 调用都会抛 `SecurityException`；lint **拒绝编译**直到调用点自己检查或处理 | `bash scripts/android-glue-nv21-check.sh`：**9 条错误、exit 1 → `0 finding(s)`、exit 0**。九个调用点各自内联 `try { … } catch (e: SecurityException)`，如实返回 `false`/`0`（**顺带订正**：`setCharacteristicNotification` 以前无条件 `return true`，现在返回平台自己的答案，`ble_subscribe` 才看得见拒绝）。**注意**：lint 不接受"委托给一个包装函数的 try/catch"，第一版修复因此仍然红 —— 必须落在**调用点** |
| D | **`nfc_read_bytes` 的实参名对不上**：前端发 `tagId`，Rust 参数名曾是 `_tag_id`（Tauri 按另一把键查找）⇒ 命令在到达胶水之前就 "invalid args"，而它是这个模块**唯一**的调用者 | `tauri-args-scan`：**2 条 FAIL → OK**；参数改名 `tag_id`，并把"胶水只读当前持有的标签"这个信息性入参记进日志（而不是收了就丢） |
| E | **`filesCloud.deleteSnapshot` 直写 localStorage、并把镜像写成 `""`**：空串不是 JSON，解析镜像值的读者会**抛异常**而不是看到"缺席" | `write-scan`：**FAIL → OK**；新增 `amosStore::removeStoreValue`（一次调用同时处理 localStorage 与 Rust 镜像，镜像写 JSON 字面量 `"null"`）并改用它 |
| F | **扫描器盲点**（不是产品缺陷，但它让两条真事件看起来是死的）：`tauri-event-scan` 只认 `x.emit(…)`，而 `jni_glue.rs` 用模块内自由函数 `emit("…", …)` 发事件 | 扩宽为「带字符串字面量的自由 `emit(`」+ **3 条 selftest 断言**（含"非字面量自由 emit 不动"的负控）；`emitted` 18 → 21。修好后立刻露出**真**发现：`biometric-result` 有人发、没人订阅 —— 结果实际走命令的 `oneshot` 返回，所以按规则 1 登记 allowlist 并写明理由（"deliberate mirror"） |

**顺带的门禁记账**（都是"让门禁读真话"，不是掩盖）：`rust-discard-baseline.json` +`jni_glue.rs`（6：
4 处 `OnceLock::set` 幂等初始化 + 2 处接收端可能已走的 `oneshot::send`）→ 81→87；
`store-allowlist.json` +`amos.files.cloud`（`derived`：设备自己文件清单的重算快照，不属于云备份清单）；
前端 `unwired-allowlist.json` +4 个模块（biometric/ble/gps/nfc，理由逐条写明"缺的是屏幕不是 seam"）与
`unwired-baseline.json` `values` **81 → 113**（+32 个导出，全部落在这四个模块里）。

**诚实边界**：C 项的修复**没有在真机上验证**（这台机器没有连接设备）；它由 Android Lint 的官方判据
（调用点必须 check 或 catch）与 `android-glue-mirror.sh` 的结构校验（manifest/包名/17 个入口点）支撑，
"没有权限时 BLE 会如实返回 false 而不是抛异常"这句是**设计意图**，不是实测结论。

（`entries[0]?.name`）、voiceMemos 测试里 `kind: "seed"` 缺字面量类型、以及把 `as {transcript: unknown}`
的断言写实。

**证据**：`bun run typecheck` → **0 error**；`bun run test`（bun-iso 全套：纯批 + 每个 DOM 文件独立进程）
→ **`[bun-iso] test OK`，exit 0**；受影响文件定向跑 164 例全绿。

### 8.3 仍然欠着（没有被说成完成）

1. **`dock_badge` 的移动端**：交叉编译与真机验收都没有（§8.1 末）。
2. **`runOnLockScreen` 的真设备锁屏**：代理已写清方向，但 `KeyguardManager` 命令 + Kotlin glue 未做（§4 #5）。
3. **DST 跳过日没有报告**：Spring forward 那天 02:30 的触发不会响，也不产生任何可观察的事实（§4 #4）。
4. `#20`（错误信封）、`#33`（rate limit）、`amos-mdm` 身份模型 RFC、`BLE H6`、`robot #41`（§6）。**（`BLE H2`/`H4` 已在 §9 的 REQ-A413 里修掉 —— §9.6 是这份清单的最新版本。）**

---

## 9. 第三轮（REQ-A413）：把 §8 里「读不到所以没查」的那一类挖到底

§8.4 修 `tauri-event-scan` 的盲点时留下的方法论问题，在这一轮被用到 `jni-contract-scan` 上：
**一个门禁把"读不懂"报成一条只在 `--json` 里出现的 report，就等于把"没查"伪装成"查过且通过"。**

### 9.1 先取证：盲点在哪，有多大

`node scripts/jni-contract-scan.mjs --json` ⇒ **8 条 `signature-unreadable`**，正常跑**一行都不打印**。
逐条追到 `rustBindings()`：它是**扁平**语句扫描，而 BLE 命令把描述符写在**闭包**里 ——

```rust
let _ = android_jni::with_context(|_ctx, env| {
    let sig = "(Ljava/lang/String;String)Z";   // ← 被外层 let _ 的整条语句跳过
    …
});
```

⇒ `signatureOf` 答 `unresolved`，那 8 个调用点的 JNI 描述符**从来没被拿去做过比较**（R1 只"验证"了 22 个成员）。

### 9.2 修门禁，让它当场报出真缺陷

`blockBodies()`（递归取块体、**跳过字符串里的 `{`**）+ `rustBindings` 递归 ⇒ R1 **22 → 34**。
修完立刻红：`ble_unsubscribe` 用两参描述符调三参的 Kotlin 成员（**真机上 `NoSuchMethodError`，通知能开不能关**），
而它还写着 `let _ = service_uuid;` 把参数丢了 —— 审计 **H2** 的另一半（订阅侧上轮已修）。

### 9.3 顺 H4 往上走，发现 H4 上面还有一层

H4 说「单槽并发 race」，但真正的形状更糟：`ble_read` **发完读立刻看槽**，而 GATT 读是**异步**的 ⇒ 设备上几乎必然
答 "no read result yet"（**一次都没成功过**）；槽还是单例、读出时连 uuid 都丢（`if let Some((_uuid, bytes))`）
⇒ A 特征的值可以交给问 B 的人。改成 `HashMap<uuid, oneshot::Sender>` + `arm → 发起 → timeout(5s) 等自己那条`，
被拒即 disarm，同特征二次读**顶掉**前一个，无人等的值由回调**记日志**。

### 9.4 前端同一处谎（第 5 条）

`bleOnValueChanged` 判 `raw.event === "read"`，Rust 只发 `"read_result"` —— 每个读结果都被当成通知；
而它的单测手写 `event:"read"` 的帧**替它掩盖**了这一点。改按真帧，测试改用真实形状。

### 9.5 状态与本轮证据

| 项 | 状态 |
|----|------|
| 审计 H2（`setCharacteristicNotification` 丢 serviceUuid） | **已修复**：订阅侧上轮 + **退订侧本轮**（描述符两参 → 三参、service UUID 不再丢） |
| 审计 H4（单槽并发 race） | **已修复**：按特征 UUID 键的 waiter map + `ble_read` 真正的 await（并顺带修掉"读从来没成功过"） |
| `jni-contract-scan` 的 `signature-unreadable` 盲点 | **已修复**（递归取闭包内绑定；R1 验证数 22 → 34） |
| 前端 `read_result` 判别 | **已修复**（连带把掩盖它的假帧测试换成真帧） |
| 审计 H6（`writeDescriptor` 不等完成） | **仍未修**：需要 Kotlin 侧状态机（`onDescriptorWrite` 回调 → 下一个 enable），不是文本级改动 |

**证据**：`make lint` **EXIT=0**；`make test` **EXIT=0**；`cargo test -p amos-tauri --features android --lib` **527**（此前 524）；
`cargo test -p amos-tauri --lib` **516**；`bun run typecheck` **0 error**；`bun test ble.test.ts` **11/11**；
`android-glue-nv21-check.sh` **0 finding**；`jni-contract-scan --selftest` **79/79**。
**负控 ×4（各自变红后还原）**：关掉 `rustBindings` 递归 ⇒ selftest 恰好 2 条红（门禁退回 22 成员、缺陷重新隐形）；
退订描述符退回两参 ⇒ 门禁 EXIT=1 并精确报出 arity；`arm_read` 忽略 UUID（模拟旧单槽）⇒ 3 条单测全红；
前端判回 `"read"` ⇒ `ble.test.ts` 1 fail。

**诚实边界**：①**无真机** —— 读路径"值真的回来了"由状态机单测 + 假桥帧测试支撑，不是射频实测；
②Kotlin 只在 `status == GATT_SUCCESS` 时回调，所以 **GATT 读失败表现为 5s 超时而不是具体错误码**；
补 `status` 入参要同时改 Kotlin 回调与 Rust 导出，而 R2 **只按名字配对、不看签名** —— 那会是新的盲区，
所以本轮**不动**它，先把这条记在这里；③Android 交叉编译仍未验证（缺 NDK clang）。

### 9.6 §8.3 剩余清单（更新）

1. `dock_badge` 的移动端交叉编译/真机（不变）。
2. `runOnLockScreen` 的真 keyguard 命令 + Kotlin glue（不变）。
3. DST 跳过日的"那天没响"报告（不变）。
4. `#20`（错误信封）、`#33`（rate limit）、`amos-mdm` 身份模型 RFC、`BLE H6`、`robot #41`（不变，均需先做决定）。

