# Phase 3 Day 3 调研报告与集成设计（通知中心 × 推送通知）

**调研日期**: 2026-09-17（为 Day 3 = 2026-09-18 执行准备）
**调研范围**: 现有通知中心（`NotificationCenter.svelte` / `NotificationBanner.svelte` / `lib/settings.ts`）、推送后端（`crates/amos-tauri/src/push_notifications.rs`）、推送前端（`lib/pushNotifications.ts`）、Day 1–2 两个 UI 组件、仓库全部门禁脚本
**结论**: ⚠️ **Day 3 原计划的前提不成立**——`PUSH_PHASE3_DAY3_ACTION_PLAN.md` 假设的"通知中心代码需调研 + Phase 3 已 67% + 6–8h 可到 100%"与本仓库的真实状态不符。先看 §0，再决定路线（§7）。

---

## 0. 结论摘要

1. **树是红的**：在 HEAD `6c0b228f` 上，`bun run test` / `tsc` / `svelte-check` / `unwired:scan` / `i18n:scan` / `store:scan` / `write:scan` **全部非零退出**（证据见 §1）。仓库的权威门禁是 `bun run check`（= 上述全部），它现在**不可能通过**。
2. **Day 1–2 的两个"已交付"组件不可编译、也不可达**：两者都 `import { _ } from "svelte-i18n"`——**该依赖未安装**（不在 `package.json`，`node_modules/` 里没有），而且**仓库其他任何文件都不用它**（本仓库用的是 `src/svelte/i18n.ts` + `t()`）；两者都从 `@/lib/pushNotifications` 导入，而 **`@` 别名在 `tsconfig.json` / `vite.config.ts` / `vitest.config.ts` 里都不存在**。除自身与一个测试外，**没有任何生产代码引用它们**。
3. **它们调用的 API 大多不存在**：`getNotificationHistory()` 实际返回**数组**，组件却按 `result.kind === "ok"` 解构；`RustNotificationRecord` / `RustPushStatus` / `PushResult` / `RustDeviceToken` 在 `pushNotifications.ts` 里是**私有 interface（未 export）**，组件却当类型导入（这个错误被"模块解析失败"掩盖了，修好别名后会立刻暴露）。
4. **Day 3 计划点名的东西大多不存在**（§4 逐条对照）：`src/lib/notifications.ts`（无）、`src/svelte/modules/NotificationCenter.svelte`（真实位置是 `src/svelte/NotificationCenter.svelte`）、依赖 `@sveltejs/svelte-virtual-list`（未安装；仓库自带 `src/lib/virtualScroll.ts`）、字段 `is_read` / `has_badge` / `badge_count` / `has_sound` / `priority`（Rust 侧不存在这五个字段，真值在 `payload.aps.*` 里）。
5. **"WebSocket 实时更新"在本仓库没有落点**：`push_notifications.rs` 的 `receive_notification` 只被 `push_simulate_receive` 调用，**从不 `emit` 任何 Tauri 事件**；前端 `lib/pushNotifications.ts` 里**没有任何 `subscribe`/`listen`**。实时只能 (a) 轮询 `push_get_history`，或 (b) 先在 Rust 侧加 `emit`（改 Rust + 改 IPC 契约，属 Phase 2 欠账）。
6. **可删项**：`NotificationToast.svelte` 不必新建——`NotificationBanner.svelte` 已经实现"新通知到达 → toast + 铃声/震动 + DND 门控 + 点按确认"，推送只要写进 `NOTIF_KEY` 就自动获得弹窗。虚拟滚动也不必——`NOTIF_CAP = 100` 上限下无此需求。
7. **因此**：Day 3 的 6–8h 不足以"既修地基又完成集成且让 `bun run check` 回绿"。三种排期见 §7，需要你定一个。

---

## 1. 证据：当前门禁状态（本机实测，非推断）

在 `/Users/arksong/AmOS/crates/amos-tauri/frontend-ts` 下运行：

| 命令 | 结果 | 实测内容 |
|---|---|---|
| `bun run test` | ❌ EXIT=1 | `2074 pass / 7 fail / 5 errors`，2081 tests across 151 files |
| `bun run typecheck` (tsc) | ❌ EXIT≠0 | 含 `PushPermissionDialog.test.ts`(4)、`crypto/mdmCrypto.ts`(3)、`enterprise/mdm.ts`(7+) |
| `bun run typecheck:svelte` | ❌ EXIT=1 | **90 errors / 40 warnings in 16 files**（其中推送相关 8 条） |
| `bun run unwired:scan` | ❌ EXIT=1 | 未接线符号含 `pushNotifications.ts` 的 13 个（`registerDeviceToken`、`PUSH_*_KEY`、`normalizeRegistrationStatus`、`updateAppBadge`…）与 `webman.ts` 的 5 个 |
| `bun run i18n:scan` | ❌ EXIT=1 | 含 `PushNotificationSettings.svelte` 的英文 markup `"DEV"`；另有 `MDMPanel.svelte` / `APISettings.svelte` / `AuditLogViewer.svelte` |
| `bun run store:scan` | ❌ EXIT=1 | `amos.webman.*` 三个 key 未分类 |
| `bun run write:scan` | ❌ EXIT=1 | 11 处已验证写入丢弃了返回值（含 `enterprise/templates.ts:256`） |
| `bun run a11y:scan` | ✅ EXIT=0 | 该脚本**设计上**只报告缺口（有意不失败） |

### 1.1 推送相关的 8 条 svelte-check 错误（原文）

```
src/svelte/modules/PushNotificationSettings.svelte:3:21  Error: Cannot find module 'svelte-i18n'
src/svelte/modules/PushNotificationSettings.svelte:6:5   Error: 'setBadgeCount' is declared but its value is never read.
src/svelte/modules/PushNotificationSettings.svelte:12:10 Error: Cannot find module '@/lib/pushNotifications'
src/svelte/modules/PushPermissionDialog.svelte:3:21      Error: Cannot find module 'svelte-i18n'
src/svelte/modules/PushPermissionDialog.svelte:4:60      Error: Cannot find module '@/lib/pushNotifications'
src/svelte/modules/PushPermissionDialog.svelte:5:35      Error: Cannot find module '@/lib/pushNotifications'
src/svelte/modules/PushPermissionDialog.svelte:148:9     Error: Type 'HTMLElement | undefined' is not assignable to type 'HTMLElement'
src/svelte/modules/PushPermissionDialog.svelte:149:9     Error: 同上
```

### 1.2 为什么"21 tests / 100% pass"没暴露问题

`src/lib/__tests__/PushPermissionDialog.test.ts` 用 `mock.module("svelte-i18n", …)` **把不存在的依赖 mock 掉了**，所以它在 bun 下"通过"；但 `tsc` / `svelte-check` 仍然报错（`reason` 不存在于 `{kind:string}`、表达式不可调用）。这是"测试替身让失败看不出失败"的典型案例——门禁的价值正在于 `check` 是**全部**扫描器的合取，不能只看单个测试文件的绿灯。

### 1.3 与推送无关但同样红的两处（Day 3 若要声称"门禁回绿"必须处理）

- `src/lib/__tests__/hotCorners.test.ts:97` **测试自身自相矛盾**：输入里 `top-left` 的 action 是 `"mission-control"`（第 99 行），断言却要求 `result[0]?.action === "launchpad"`（第 107 行）；`normalizeHotCorners` 保持输入顺序（`lib/hotCorners.ts:102-147`），所以这条断言必然失败。**2 行的测试修正**。
- `src/lib/__tests__/compass-cache.test.ts` 的失败是 **5s 网络超时**（`TimeoutError`），属环境/网络相关，需分类为"环境不稳定性"或加 mock，不该用重试掩盖。

---

## 2. 现有通知中心代码地图（真实）

| 文件 | 职责 | 关键点 |
|---|---|---|
| `src/svelte/NotificationCenter.svelte`（423 行） | **控制中心**（不只是通知面板）：快捷开关 + 手电筒 + 蜂窝状态 + **通知列表**；Shell 通过 `propsBus("nc")` 控制 `open` | 通知列表在第 395–420 行；`clear()` = `writeStoreValue(NOTIF_KEY, [])`、`dismiss(id)` = `writeStoreValue(NOTIF_KEY, removeNotif(notifs, id))`；挂载时若 store 为空会 `seedNotifs(Date.now())` 喂 3 条演示通知 |
| `src/svelte/NotificationBanner.svelte`（156 行） | 到达横幅：用 `newestAddedNotif(prev, notifs)` 嗅探"刚到达"，`SHOW_MS=4200` 自动消失，受 `dndActive` / `effectiveAlert` 门控，播放 `playNotifyTone` + `navigator.vibrate(30)`；点按 = `removeAppNotifs`（打开即已读） | **这就是计划里的"通知弹窗"**，已挂载于 `Shell.svelte:721` |
| `src/svelte/Shell.svelte` | 挂载点：`NotificationBanner`(721) / `NotificationCenter`(725) / `ClipboardAnnounce`(726) | 顶边下拉手势也走 `nc` 通道 |
| `src/lib/settings.ts` | 通知的**权威模型与不变量**：`NOTIF_KEY="amos.notifications"`、`NOTIF_CAP=100`、`Notif{id,app?,title?,body?,icon?,time}`、`addNotif` / `removeNotif` / `removeAppNotifs` / `countForApp` / `newestAddedNotif` / `seedNotifs` / `normalizeNotifs` | `normalizeNotifs` 只保留 `id`+`time` 与 `app/title/body/icon` 四个字符串字段，**任何新字段都会被它洗掉** |
| `src/svelte/store.ts` | `createStoreValue(key, fallback)`：跨窗口（`storage` / `store-updated`）+ 同窗口（`amos-store-changed`）反应式视图 | 通知中心与 Banner 都靠它接收"任意写入者"的更新 |
| `src/lib/pushNotifications.ts`（692 行） | 纯函数层（token 校验、payload 解析、徽章、历史、统计）+ **Tauri IPC 调用层** | Rust 类型是**私有 interface**（第 492–532 行）；模块顶层 `await import("@tauri-apps/api/core")`，失败时 `invoke` 变"永远 throw"的兜底 |
| `crates/amos-tauri/src/push_notifications.rs` | `PushNotificationState` + 12 个 `push_*` 命令（已在 `lib.rs:418-429` 注册） | `receive_notification` 是唯一入口，仅被 `push_simulate_receive` 调用；**无 `emit`**；`NotificationRecord{id,payload,received_at(ISO 字符串),read}`；`PushStatistics` 全 snake_case |

### 2.1 关键不变量（集成必须遵守）

1. **单写入口**：`amos.notifications` 是通知的**唯一持久化真相**；所有写都要经 `writeStoreValue`（`store-scan` / `write-scan` 会查）。
2. **`normalizeNotifs` 是腐蚀防线**：读侧必须继续挡脏数据；加字段就要同步改它 + 补测试。
3. **`NOTIF_CAP=100`**：任何聚合都必须有界（同类做法见 `lib/bounded.ts`）。
4. **`.svelte` 组件必须被生产入口挂载**（`unwired-scan` 检查 4，先例 `ClipboardAnnounce.svelte`），否则要进 `scripts/unwired-allowlist.json` 并写明理由。
5. **文案必须走 `t()`**，中英双语键在 `src/i18n/locales/{zh,en}.ts`；markup 里不许出现裸文案。

---

## 3. 两套通知模型的真值对照

| 计划假设的字段 | 实际真值 | 位置 |
|---|---|---|
| `timestamp: number` | `Notif.time: number`（既有） / Rust `received_at: String`（**ISO 8601 字符串**，不是 ms） | `lib/settings.ts:34`、`push_notifications.rs:97-107` |
| `read: boolean` | **既有 `Notif` 没有 read**；Rust `NotificationRecord.read: bool` 有 | 同上 |
| `is_read` | ❌ 不存在（真名是 `read`） | — |
| `priority: "high"\|"normal"\|"low"` | Rust `NotificationPriority{High,Normal}`（**只有两档，`serde(rename_all="lowercase")`**），且**不在** `NotificationRecord` 上，只在 payload 语义里 | `push_notifications.rs:28-34` |
| `has_badge` / `badge_count` / `has_sound` | ❌ 都不存在。徽章在 `payload.aps.badge?: number`，声音在 `payload.aps.sound?: string`，`PushStatistics.with_badge/with_sound` 只是计数 | `push_notifications.rs:61-82`、`pushNotifications.ts:34-58` |
| `source: "system"\|"push"\|"app_name"` | 既有以 `Notif.app`（显示名，如 `"信息"`）表达来源 | `lib/settings.ts:30` |
| `type: "system"\|"push"\|"app"` | 无此字段；需新增（注意 §2.1 第 2 条） | — |
| `action?: () => void` | 无；既有"打开即已读"由 `removeAppNotifs` 表达 | `NotificationBanner.svelte:116-124` |
| `dismissable?: boolean` | 无；所有通知都可 dismiss（每条一个 ✕） | `NotificationCenter.svelte:408-413` |

**结论**：计划的 `UnifiedNotification` 是把两套模型**想象**出来的第三套。真实可用的做法是**扩展既有 `Notif`**（加 `source?` / `read?` / `badge?` 三个可选字段）并同步 `normalizeNotifs`，而不是造并行类型。

---

## 4. Day 3 原计划 vs 现实（逐条）

| # | 计划内容 | 现实 | 影响 |
|---|---|---|---|
| 1 | 关键文件 `src/svelte/modules/NotificationCenter.svelte` | 真实是 `src/svelte/NotificationCenter.svelte` | 路径错 |
| 2 | 新建 `src/lib/notifications.ts` 统一模型 | 既有模型在 `lib/settings.ts`，且 `normalizeNotifs` 会洗掉新字段 | 会造出第二套真相 |
| 3 | `convertPushToUnified` 用 `push.received_at`（当 ms）、`push.is_read`、`push.has_badge`、`push.badge_count`、`push.has_sound` | 五个字段里四个不存在，`received_at` 是 ISO 字符串 | 抄下来即坏 |
| 4 | `aggregateNotifications()` 调 `getSystemNotifications()` | 该函数不存在（系统通知就是 `NOTIF_KEY` 里的 `Notif[]`） | 需自造聚合点或直接复用 store |
| 5 | `NotificationList.svelte` 用 `export let` 传参 | 仓库是 Svelte 5 runes（`$props` / `$state` / `$derived`），仅两个新组件用了 `export let` | 约定不符 |
| 6 | `import VirtualList from "@sveltejs/svelte-virtual-list"` | **依赖未安装**；仓库自带 `src/lib/virtualScroll.ts`（`calculateVirtualRange`，已有测试） | 不可用 |
| 7 | 新建 `NotificationToast.svelte` | `NotificationBanner.svelte` 已实现同等职责并已挂载 | 重复造轮 |
| 8 | "WebSocket/轮询机制" | 无 WebSocket；Rust 不 emit 任何事件；`lib/backend.ts` 的 `subscribe(channel, …)` 是唯一事件通道 | 只能轮询或改 Rust |
| 9 | "推送通知正确显示在通知中心"的验收 | 组件不编译、未挂载；`push_get_history` 的 13 个符号在 `unwired:scan` 里是红的 | 验收不成立 |
| 10 | 交付清单含 `src/svelte/modules/NotificationList.svelte` 等 | 任何新 `.svelte` 必须挂载进 Shell（否则 `unwired:scan` 检查 4 失败） | 需在 Shell 接线 |

---

## 5. 集成设计（方案 B：统一列表，但落在既有 store 上）

原计划**方案 B（统一列表）的结论是对的**，实现路径要换：不造第三套模型，而是让推送记录**投影成既有 `Notif`**，写进 `amos.notifications`。这样 `NotificationCenter` 的列表、`NotificationBanner` 的弹窗、DND/铃声/震动/徽章全部**自动生效**，新增代码量最小。

### 5.1 数据层（新增 1 个纯函数模块 + 扩展既有模型）

**新增 `src/lib/pushNotifBridge.ts`**（纯函数，可在 bun 下直接测）：

```ts
// 形状与既有 Notif 对齐；新增字段全部可选，且必须同步 normalizeNotifs
export function pushRecordToNotif(rec: PushNotificationRecord, fallbackNow: number): Notif | null
//   - 标题/正文：payload.aps.alert 为 string 时作 body；为对象时取 title/body
//   - 时间：Date.parse(rec.received_at)；NaN → 用 fallbackNow（并保留原文以便排查）
//   - 徽章：payload.aps.badge（number 才取）
//   - 静默推送（content-available 且无 alert）→ 返回 null（不产生可见通知）
export function mergePushHistory(existing: Notif[], records: PushNotificationRecord[], now: number): Notif[]
//   - 按 id 去重（推送 id 与系统 id 前缀不同，天然不冲突）
//   - 时间倒序 + 走 NOTIF_CAP 上限（有界，复用 addNotif 的语义）
```

**必须同时改 `src/lib/settings.ts`**：
- `Notif` 加 `source?: "system" | "push"`、`read?: boolean`、`badge?: number`；
- `normalizeNotifs` 保留这三个字段（否则写进 store 就被洗掉——见 §2.1 第 2 条）；
- 新增 `markNotifRead(list, id)` 之类的纯函数（与 `removeNotif` 同风格）；
- 补 `src/lib/__tests__/settings*.test.ts` 用例（新增字段往返 + 脏数据仍被拒）。

**必须改 `src/lib/pushNotifications.ts`**：把 `PushResult` / `RustDeviceToken` / `PushNotificationRecord` / `RustPushStatistics` / `RustPushStatus` **export**（现在私有），否则调用方无法类型化。

**必须改 Rust（仅在选 (b) 实时方案时）**：`push_notifications.rs` 的 `receive_notification` 成功后 `emit("push-received", record)`，并在 `push_simulate_receive` 的 `State` 里拿到 `AppHandle`。**注意**：命令签名变化属 IPC 契约变更，需同步 `lib.rs` 的注册与前端 `subscribe`。

### 5.2 实时更新（两选一，都不涉及 WebSocket）

- **(a) 轮询（推荐，0 行 Rust 改动）**：新增 `src/svelte/osPushWatcher.ts`（仿既有 `osAlarmWatcher.ts` / `osTimerWatcher.ts` / `osReminderWatcher.ts` 的职责与命名），在 Shell 挂载一次：`bridged()` 时每 5s 调 `getNotificationHistory(50)` → `mergePushHistory` → `writeStoreValue(NOTIF_KEY, next)`；**仅在有变化时写**（避免每 5s 触发 Banner/存储广播）；失败静默（离线就是离线，不伪造）。
- **(b) 事件（更正确，但要改 Rust）**：`subscribe("push-received", …)` → 直接合并。选它就必须接受"Day 3 触及 Rust + IPC 契约"。

### 5.3 UI 层（几乎不需要新组件）

- **不在** `NotificationCenter.svelte` 里塞第二个列表组件：既有 `{#each notifs as n (n.id)}`（第 399–418 行）里加"来源徽标 + 已读/未读样式"即可；`dismiss` / `clear` 复用既有两个函数，**零新写路径**。
- 列表需要 100 条以上的性能保障时才用 `lib/virtualScroll.ts`；当前 `NOTIF_CAP=100` 下**不做虚拟滚动**。
- 若确实要抽 `NotificationList.svelte`：必须 (1) 用 runes（`$props`/`$derived`），(2) 被 `Shell.svelte` 或 `NotificationCenter.svelte` **真正挂载**，(3) 配 `svelte-tests/*.svelte.test.ts` DOM 测试。
- **弹窗**：不新建，写进 `NOTIF_KEY` 即自动获得 `NotificationBanner`。

### 5.4 i18n / 测试 / 门禁义务

- 新文案走 `t()`，键加 `src/i18n/locales/{zh,en}.ts`（`i18n:scan` 会抓裸文案；`PushNotificationSettings.svelte` 的 `"DEV"` 已 FAIL）。
- 纯函数测试 → `src/lib/__tests__/*.test.ts`（`bun:test`）；DOM 测试 → `svelte-tests/*.svelte.test.ts`（vitest + happy-dom），且必须被断言真正使用（`testreach:scan`）。
- 每步验收（= `bun run check` 的合取，别只跑一个）：
  `bun run test` → `bun run typecheck` → `bun run typecheck:svelte` → `bun run test:svelte` → `unwired:scan` → `i18n:scan` → `store:scan` → `write:scan`。
- 在 `docs/TRACEABILITY_MATRIX.md` 按仓库惯例登记一个 `REQ-Axxx` 行（含"诚实边界"），并在 `CHANGELOG.md` 记一条。


---

## 6. 修订后的 Day 3 交付清单（两段式）

### 6.1 Day 3a — 地基（必做，否则任何"集成完成"的说法都不成立）

| # | 任务 | 验收 |
|---|---|---|
| 1 | 两个推送组件：把 `svelte-i18n` 换成 `t()`（`src/svelte/locale.svelte`）、`@/lib/...` 换成相对路径、`export let` 换成 runes、`result.kind` 解构改成真数组、`firstFocusable/lastFocusable` 的 `| undefined` 收紧 | `svelte-check` 推送相关错误归零 |
| 2 | 把 `PushResult` / `Rust*` 类型 export 出来 | `tsc` 推送相关错误归零 |
| 3 | 决定两个组件的归属：接进 `SettingsApp.svelte`（真页面）**或**删除/降级为未跟踪草稿 | `unwired:scan` 不再因它们失败（挂载或 allow-list 二选一，写理由） |
| 4 | `hotCorners.test.ts:107` 的 `"launchpad"` → `"mission-control"` | `bun run test` 少 1 fail |
| 5 | `compass-cache.test.ts` 的网络超时：加 mock 或标记为环境不稳定 | `bun run test` 回绿 |
| 6 | 非推送红项（`enterprise/mdm.ts` + `mdmCrypto.ts` + 3 个 `enterprise-ui-*.test.ts`）：修或明确记录为"已知红" | `bun run check` 的剩余红项有记录、有理由 |

### 6.2 Day 3b — 集成（本文 §5 的设计）

| # | 任务 | 验收 |
|---|---|---|
| 7 | `lib/pushNotifBridge.ts` + 单测（含 ISO 解析失败、静默推送、去重、上限） | `bun run test` 新增用例全绿 |
| 8 | `lib/settings.ts` 扩字段 + `normalizeNotifs` 同步 + 单测 | 同上 |
| 9 | `pushNotifications.ts` 类型 export + 记录形状对齐 | `tsc` 绿 |
| 10 | `svelte/osPushWatcher.ts`（方案 (a)）或 Rust `emit`（方案 (b)） | 有测试；离线不伪造 |
| 11 | `NotificationCenter.svelte` 列表加"推送"来源徽标 + 未读样式 | `notification-center.svelte.test.ts` 新增用例 |
| 12 | i18n 键（zh+en）+ `unwired/i18n/store/write` 四扫描器 | `bun run check` 回绿 |
| 13 | `docs/TRACEABILITY_MATRIX.md` 的 `REQ-Axxx` 行 + `CHANGELOG.md` 条目 | 文档落地 |

**时间**：Day 3a 约 3–4h（1、4、5 是小时级；3、6 取决于取舍），Day 3b 约 4–5h。**合计 7–9h，与原计划同量级，但产出是"真的能编译、能被看见、门禁回绿"的集成**，而不是"又一层不编译的代码"。

---

## 7. 需要决策的一件事（三种排法）

- **方案 A（先修地基，集成顺延）**：Day 3 只做 §6.1（1–6），把 `bun run check` 拉回全绿，集成整块挪到 Day 4。**最诚实**：状态可验证，但 Phase 3 明天到不了 100%。
- **方案 B（删掉重做，最小路径）**：判定 Day 1–2 两个组件是"不编译的孤岛"，**删除**（或移出 `src/` 作草稿），直接按 §5 在既有 store/组件上做集成。Day 3 内**可以**完成集成且门禁回绿，代价是承认那 1,711 行（及其文档/测试）作废。
- **方案 C（照原计划硬推）**：先在红树上继续写集成代码，两个组件保持不可编译。门禁只会更红，"Phase 3 = 100%" 无法验证。

**建议**：**B**（若认可"可编译 + 可验证"优先于"保留已写代码"），否则 **A**。无论哪种，`PUSH_PHASE3_DAY3_ACTION_PLAN.md` 中 §4 列出的 10 处假设都需要就地订正，否则 Day 3 会重演同一个失败模式。

---

## 8. 诚实边界（本报告的自我限制）

- 证据全部来自本机命令输出与源码阅读（file:line 已在文中标注），**未**在真机/真 APNs 上验证任何推送路径。
- "推送历史 → store"的投影正确性依赖 `aps.alert` 的形状：Rust 侧当前是 `Option<String>`（`push_notifications.rs:58-60`），而前端 `PushPayload` 类型允许 `string | {title,subtitle,body}`——**两边不一致本身就是一条待修的不变量**（做 Day 3b 前必须先统一，否则 `extractAlertText` 的真机行为与本地测试不同）。
- 本文件是唯一新增文件；**未**改动任何源码 / 测试 / 别名配置。

**报告生成**: 2026-09-17（为 2026-09-18 的 Day 3 准备）
---

## 9. 执行结果（方案 B —— 已落地，REQ-A383）

> 本节由执行后补写，记录**实际做了什么、验证到什么、没做什么**。

### 9.1 做了什么

| # | 动作 | 位置 |
|---|---|---|
| 1 | **删除两个孤儿组件**及其专属测试 | `src/svelte/modules/{PushNotificationSettings,PushPermissionDialog}.svelte`、`src/lib/__tests__/PushPermissionDialog.test.ts`（−1,852 行） |
| 2 | 删除随组件一起作废的 **26×2 条**文案（描述已不存在的 3 步对话框 / 分页历史 / 复制令牌等）；保留并新增页面真正持有的键 | `src/i18n/locales/{zh,en}.ts`（+5 / −26） |
| 3 | **修根因**：`push_*` 命令改走 `lib/backend.ts::invoke`（原先 `await import("@tauri-apps/api/core")` —— 该包**不是本工作区依赖**，故 12 个命令在任何环境都到不了 Rust） | `src/lib/pushNotifications.ts` |
| 4 | **模型扩展**：`Notif` 加 `source`/`read`/`badge`，`normalizeNotifs` 同步保留（否则写进去就被洗掉）；新增 `markNotifRead` / `unreadCount` | `src/lib/settings.ts` |
| 5 | **投影桥**（纯函数，不建第二套模型）：`pushRecordToNotif` / `mergePushHistory` / `dropPushNotifs` | `src/lib/pushNotifBridge.ts`（新） |
| 6 | **实时**：5s 轮询 `push_get_history`，仅在真有新增时写，失败不动任何东西 | `src/svelte/osPushWatcher.ts`（新）+ 挂进 `Shell.svelte` |
| 7 | **UI**：「推送」徽标 + 未读计数 + 「标记已读」（本地先改、设备再改）；弹窗**复用** `NotificationBanner`（不新建 Toast） | `src/svelte/NotificationCenter.svelte` |
| 8 | **设置页**：「通知」新增推送分区（权限/令牌/环境/统计/清空 + DEV 测试按钮），复用既有 `push*` 键 | `src/svelte/settings/NotificationsPage.svelte` |
| 9 | **修 Rust 边界**：`ApsPayload` 的 `content-available` / `mutable-content` / `thread-id` 补 `serde(rename)`（原发 snake_case ⇒ 真 APNs 负载掉进 `flatten` 的 `custom`，`isSilentPush()` 永远看不到）+ 4 例测试 | `crates/amos-tauri/src/push_notifications.rs` |
| 10 | **修竞态**：通知中心「首次播种」原来读内存 `notifs`（首次订阅后差一拍）⇒ 会**覆盖**已落库的投递；改读 store 本身 | `src/svelte/NotificationCenter.svelte` |
| 11 | 27 个仍无生产调用点的 `pushNotifications` 导出 → 按门自己的建议登记进 ratchet | `scripts/unwired-baseline.json` |

### 9.2 验证（实测）

| 命令 | 结果 |
|---|---|
| `cargo test -p amos-tauri --lib push_notifications` | ✅ **4/4** |
| `bun test src/lib/__tests__/pushNotifBridge.test.ts src/__tests__/osPushWatcher.test.ts src/__tests__/settings.test.ts src/lib/__tests__/pushNotifications.test.ts` | ✅ **89 pass / 0 fail**（桥 14、watcher 6、settings +3） |
| `npx vitest run svelte-tests/notification-center.svelte.test.ts` | ✅ **18/18**（原 14 + 4） |
| `npx vitest run svelte-tests/settings-pages.svelte.test.ts` | ✅ **63/63**（原 57 + 6） |
| `npx svelte-check` | **90 errors / 16 files → 78 / 13**，**推送相关归零** |
| `bun run typecheck` | 本轮文件 **0 错** |
| `bun run unwired:scan` | **推送相关归零**（余 `webman`/`filesError`/`measure`，非本轮） |
| `bun run i18n:scan` | **推送相关归零**（余 `APISettings`/`AuditLogViewer`/`MDMPanel`，非本轮） |
| `node scripts/trace-scan.mjs` / `docs-link-scan.mjs` / `fmea-gen.mjs --check` | ✅ EXIT=0（113 failure modes） |
| `node scripts/untracked-source-scan.mjs` | ✅ 本轮新文件已 `git add`；仅余**别人**的 3 个未跟踪文档 |

### 9.3 没做什么（诚实边界）

1. **无真机**：真 APNs / 真 Android 通知栏一条未验。本轮的"能到 Rust"只证明**桥接通**，不证明设备端行为。
2. **实时是轮询**（≤5s），不是 push；事件通道需要 Rust 侧 `emit`（§5.2 方案 b）。
3. `aps.alert` 在 Rust 是 `Option<String>`、在 TS 允许 `string | {title,subtitle,body}` —— **两侧形状仍不一致**，结构化 alert 的真机路径未验。
4. **`bun run check` 整体仍红**，红项**全部属于另一个工作流**（企业/MDM）：`enterprise/mdm.ts:945` 的 `await` 在非 async 方法里 ⇒ 4 个 bun 测试文件 + 2 个 vitest 文件**直接 transform 失败**；`APISettings`/`AuditLogViewer`/`MDMPanel` 的硬编码文案；`store/write` 扫描的 webman/enterprise 分类。**未代修**（不属于本轮，且缺乏其上下文）。
5. `hotCorners.test.ts:107` 的自相矛盾断言（输入 `mission-control`、却断言 `launchpad`）**未改**，`compass-cache` 的网络超时也未动 —— 它们是别的红项。
6. `PushNotificationSettings` 的**分页历史 / 令牌复制 / 3 步权限对话框**这些 UX 能力**被删掉而非重写**：现在设置页是"一行权限状态 + 令牌 + 统计 + 清空"，够用但没有原来那份交互的精细度。

### 9.4 下一步建议（若继续推进 Phase 3/4）

1. **先让 `bun run check` 回到全绿**：修 `enterprise/mdm.ts:945`（`deletePolicy` 应为 `async`）→ 立刻解除 4 个 bun 测试 + 2 个 vitest 文件的红；再处理剩余 78 条 svelte-check 与 i18n/store/write 分类。
2. `hotCorners.test.ts:107` 的 `"launchpad"` → `"mission-control"`（两行）。
3. 若要在**真机**上验收推送：需 `cargo tauri android build` 后注入一条 FCM/APNs 等价负载，或先做 §5.2 方案 (b)（Rust `emit`）把轮询换成事件。
4. 统一 `aps.alert` 的两侧形状（Rust 改成 `enum Alert { Text(String), Full{title,subtitle,body} }` 或 TS 收窄为 `string`）。

