# G-γ · 桌面通知 Banner（macOS Right-Edge Toast）

> 与 [G-α · macOS Overlay Title Bar](./DESKTOP_TITLEBAR_G_ALPHA.md) 同源：把电话形态已有的
> `NotificationBanner.svelte`（REQ-A284）按 macOS 桌面几何重排，**复用同一个通知 store
> 与同一套纯函数**，不另起一份实现。

---

## 1. 现状（Why）

### 1.1 macOS 的通知交互

- 通知到达时，**屏幕右上角滑出一张横幅（Banner）**，停留约 4 秒
- 横向：`Screen Width − 8 px` 居右，距离右边 8 px
- 纵向：顶栏下方 6 px 开始，多张 banner 自上而下**堆叠 12 px**
- 单击 banner → 该 app 通知全部标记已读；停留超时自动消失

### 1.2 仓内现状（已在的工程资产）

| 已存在 | 文件 | 用途 |
|---|---|---|
| `NotificationBanner.svelte`（phone 形态） | `src/svelte/NotificationBanner.svelte` | 4.2s 自动消失 + 复用 `newestAddedNotif` 检测新到 |
| `NOTIF_KEY = "amos.notifications"` | `src/lib/settings.ts` | 通知 store key（**真源唯一**） |
| `newestAddedNotif(prev, curr)` | `src/lib/settings.ts` | 取新到的那一条（纯函数） |
| `addNotif / removeAppNotifs / markNotifRead` | `src/lib/settings.ts` | 增/批量删/标记已读（纯函数） |
| `dndActive / normalizeQuick / normalizeSound` | `src/lib/settings.ts` / `src/lib/sound.ts` | DND + 提示音策略（共享） |
| `DesktopNotificationCenter.svelte` | `src/svelte/DesktopNotificationCenter.svelte` | 桌面右侧通知中心（点时钟打开） |
| `TOPBAR_HEIGHT = 24` | `src/lib/desktopLayout.ts` | 顶栏高度常量（**真源唯一**） |
| `NC_RIGHT_PANEL_WIDTH = 360` | `src/lib/desktopLayout.ts` | 控制中心宽度常量 |
| `playNotifyTone` / `shouldRingOnArrival` | `src/lib/notifyTone.ts` / `src/lib/sound.ts` | 提示音 + 节流门 |

### 1.3 缺口（What）

`Shell.svelte` 第 793 行 `<NotificationBanner />` **仅在 `{:else}`（phone/tablet）分支挂载**。
桌面形态（`LayoutSnapshot.form === "desktop"`）的桌面分支**完全不挂任何横幅** ——

- 通知到达 → 只有 `DesktopNotificationCenter` 的**已读数 + 1**
- 用户必须主动**点时钟**打开右栏才知道有通知到
- 这正是 macOS 用户在 PC 上撞到最频繁的体验缺口：**通知"来了又走"**（never was visible）

`docs/DESKTOP_ECOSYSTEM_GAP_AUDIT.md` G6 的描述：

> 桌面没有通知 Banner（macOS 右上角 toast）

---

## 2. 目标（Goals）

### 2.1 必须

1. **右上角 macOS 风格 banner**：顶栏下方 6 px、右边 8 px、横宽自适应
2. **复用 `newestAddedNotif`**：不另起一个"检测新到"的实现
3. **4.2 秒自动消失**（与 phone banner 同源常量 `SHOW_MS = 4200`）
4. **单击 ack = `removeAppNotifs` 该 app 所有通知**（与 phone banner 同源语义）
5. **DND / 静音策略仍生效**（`dndActive` + `shouldRingOnArrival` 不复制）
6. **可达性**：`role="alert"` + `aria-live=assertive` + `aria-atomic=true`（与 phone banner 同源）
7. **堆叠**：一次只显示**一张** banner（phone banner 行为），后续到达会替换当前 banner
   （macOS Big Sur+ 也是只显示一张，旧通知移到通知中心）

### 2.2 不做（Explicit Non-Goals）

- 不做"点击 banner 打开 app"（macOS 上是"标记已读 + 关 banner"，打开 app 由用户去启动台）
- 不做"通知分组"（macOS Monterey 才有，本轮先把单条 banner 落到位）
- 不做"通知到达时的 haptic pulse"（桌面没马达）
- 不做"通知声音策略的桌面变种"（沿用 `effectiveAlert` 与 `shouldRingOnArrival`）

### 2.3 收益面

- **macOS 用户撞到频率**：一天 30+ 次通知，每个**没有 banner = 用户看不见**
- **修复成本**：复用既有 7 个纯函数 + 1 个新 Svelte 组件 + 1 个 mount 点，2 天可落

---

## 3. 设计（Design）

### 3.1 组件契约

新文件 `src/svelte/DesktopNotificationBanner.svelte`：

```svelte
<script lang="ts">
  // G-γ: 桌面通知 banner — 复用 NotificationBanner 同源的纯函数与策略。
  //
  // 关键点：
  //   1. **不复制 newestAddedNotif / removeAppNotifs / dndActive / normalizeQuick**
  //      —— 这五个函数是仓内通知交互的**唯一真源**。复制 = G-α 钉住的
  //      「几何常量两份」的同型缺陷。
  //   2. 4.2s 自动消失（SHOW_MS）与 phone banner **同源**，`lib/desktopLayout.ts`
  //      不再添一份 SHOW_MS；我们从 `NotificationBanner.svelte` 删常量并提到
  //      `lib/desktopLayout.ts` 让两端共享。
  //   3. 几何：top = TOPBAR_HEIGHT + 6, right = 8, width = 自适应。
  //      TOPBAR_HEIGHT 是仓内**唯一**顶栏高度真源（`lib/desktopLayout.ts`）。
  //   4. a11y：role="alert" + aria-live=assertive + aria-atomic=true。
  //      「通知到达 = 中断我」 —— polite 会输给聚焦任务（REQ-A284）。
  //
  // 挂载在 `DesktopShell.svelte` 的浮层容器**之前**，z-index 高于 stage
  // （= 100 + index）但低于注册表浮层（= 100 + overlayIndex）。这样不会盖住
  // Launchpad / Spotlight / MissionControl / NotificationCenter。
  ...
</script>
```

### 3.2 几何常量（**集中收口**，不复制）

`src/lib/desktopLayout.ts` 新增：

```typescript
/** 桌面通知 banner 距离顶栏下沿的偏移（px）—— macOS 实测标准 6 px。 */
export const NOTIF_BANNER_TOP_OFFSET = 6;

/** 桌面通知 banner 距离屏幕右沿的偏移（px）—— macOS 实测标准 8 px。 */
export const NOTIF_BANNER_RIGHT_OFFSET = 8;

/** 桌面通知 banner 最大宽度（px）—— 与 macOS 通知中心一致 360 px。 */
export const NOTIF_BANNER_MAX_WIDTH = 360;

/** 通知 banner 停留时长（ms）—— 与 phone 形态 NotificationBanner 同源常量。 */
export const NOTIF_BANNER_SHOW_MS = 4200;
```

### 3.3 复用与收敛

**修改** `src/svelte/NotificationBanner.svelte`：

```diff
- const SHOW_MS = 4200;
+ import { NOTIF_BANNER_SHOW_MS } from "../lib/desktopLayout";
+ const SHOW_MS = NOTIF_BANNER_SHOW_MS;
```

**新增 mount** 在 `src/svelte/DesktopShell.svelte` 第 522 行（`</div>` 之后, 浮层 `<div>` 之前）：

```svelte
<DesktopNotificationBanner />
```

### 3.4 i18n（保持与 phone banner 同源键）

复用 `src/i18n/locales/zh.ts` 与 `en.ts` 已有的 `nc.*` 字符串（`DesktopNotificationCenter` 已用）——
banner 内文本直接显示 `banner.app / title / body`，不再额外加键。

### 3.5 负面控制（Negative Controls，钉实现不退化）

| 负控 | 移除/篡改 | 期望 FAILED 的测试 |
|---|---|---|
| 把 `<DesktopNotificationBanner />` 从 `DesktopShell.svelte` 摘掉 | mount 行删 | `topBanner_appears_when_a_new_notification_arrives` |
| 把 `newestAddedNotif` 调用换成 `notifs[0]` | 替换一行 | `topBanner_only_shows_the_just_arrived_notification` |
| 把 `SHOW_MS` 改回 `4200` 内联 | 把 import 删 | `desktopLayout_NOTIF_BANNER_SHOW_MS_is_the_single_source_of_truth` |
| 把 `removeAppNotifs` 改成 `removeNotif`（仅删单条） | 替换一行 | `clicking_topBanner_marks_all_notifications_of_that_app_read` |
| 把 DND 门禁去掉 | 删 `if (dnd)` | `topBanner_does_not_appear_when_DND_is_active` |
| 把 `TOPBAR_HEIGHT` 内联 | 把 import 替换成 `24` | `desktopLayout_TOPBAR_HEIGHT_is_the_single_source_of_truth` |

---

## 4. 测试矩阵（先于实现）

新文件 `frontend-ts/svelte-tests/desktop-notification-banner.svelte.test.ts`：

### 4.1 几何（5 条）

1. `desktopLayout_NOTIF_BANNER_SHOW_MS_is_the_single_source_of_truth` —— `SHOW_MS` 在仓内仅出现 1 次（grep gate）
2. `desktopLayout_TOPBAR_HEIGHT_is_the_single_source_of_truth` —— `TOPBAR_HEIGHT = 24` 在仓内仅出现 1 次
3. `desktopLayout_NOTIF_BANNER_RIGHT_OFFSET_equals_8` —— 常量值
4. `desktopLayout_NOTIF_BANNER_TOP_OFFSET_equals_6` —— 常量值
5. `desktopLayout_NOTIF_BANNER_MAX_WIDTH_equals_360` —— 常量值

### 4.2 行为（5 条）

6. `topBanner_appears_when_a_new_notification_arrives` —— 写入 `NOTIF_KEY` → 出现 banner 元素
7. `topBanner_dismisses_after_NOTIF_BANNER_SHOW_MS` —— fast-forward 4200ms → banner 消失
8. `topBanner_is_positioned_top_right_corner` —— `data-testid="desktop-notif-banner"` 的 `style.top/right` 等于常量
9. `topBanner_only_shows_the_just_arrived_notification` —— 一次性 push 3 条 → banner 只显示**最新那条**（其他两条仍在 store）
10. `clicking_topBanner_marks_all_notifications_of_that_app_read` —— 单击 banner → 该 app 所有通知从 `NOTIF_KEY` 中被 `removeAppNotifs` 移除

### 4.3 负面控制 / 契约不退化（3 条）

11. `topBanner_does_not_appear_when_DND_is_active` —— `dnd=true` 时 banner 不出现
12. `topBanner_does_not_ring_when_shouldRingOnArrival_returns_false` —— `sound=muted` 时不调 `playNotifyTone`
13. `topBanner_does_not_steal_focus_from_active_window` —— banner 不抢键盘焦点（`tabindex=-1`）

### 4.4 i18n / 仓内纪律（2 条）

14. `desktopShell_mounts_DesktopNotificationBanner_exactly_once` —— `grep "DesktopNotificationBanner"` 在 `DesktopShell.svelte` 仅 1 行
15. `topBanner_uses_the_same_store_as_NotificationCenter` —— 写入 banner 触发后，`DesktopNotificationCenter` 也能看到（即 `nc-notif-<id>` row 存在）

**合计 15 条测试，全部先于实现写出**。

---

## 5. 文件清单（落地范围）

| 文件 | 改动 | 行数（估） |
|---|---|---|
| `docs/DESKTOP_NOTIFICATION_BANNER_G_GAMMA.md` | 新增 | 230 |
| `frontend-ts/src/lib/desktopLayout.ts` | `+ NOTIF_BANNER_* 4 个常量` | +18 |
| `frontend-ts/src/svelte/NotificationBanner.svelte` | `SHOW_MS` 改用 import | −1 / +2 |
| `frontend-ts/src/svelte/DesktopNotificationBanner.svelte` | **新组件** | +130 |
| `frontend-ts/src/svelte/DesktopShell.svelte` | `+ <DesktopNotificationBanner />` mount | +1 |
| `frontend-ts/svelte-tests/desktop-notification-banner.svelte.test.ts` | **新测试** | +200 |
| `CHANGELOG.md` | 一条完整变更记录 | +55 |

总计：**净增 ~635 行 / 删除 0 行**。

---

## 6. 真机复核清单（Self-Review Checklist）

落地完成后**必须**逐项人工复核：

- [ ] 启动 `amos-tauri dev`，触发 `notif_send()`（用 `amos-notifier` CLI 工具或开发脚本）
- [ ] 通知**确实**从右上角滑入；4.2s 后滑出
- [ ] 单击 banner → 通知中心对应 app 的所有通知被清空（点时钟验证）
- [ ] 开启 DND（控制中心月亮按钮）→ 通知**不再**出现 banner
- [ ] 静音（系统设置 → 声音）→ banner 出现但**不响**
- [ ] 通知到达时打开 Launchpad → banner **不**覆盖 Launchpad（z 序对）
- [ ] macOS: 实际在 macOS 上跑一遍（顶栏高度 / 字体 / 颜色可能与设计稿略有差）

---

## 7. 不做清单（Explicitly Out of Scope）

- 通知分组 / 通知聚合（macOS Monterey+）
- 通知 banner 的"展开/收起"动画
- 通知到达时屏幕边缘闪烁（macOS Catalina 之前的"跳跃"动画已被 Apple 弃用）
- 通知的"暂停 24 小时"按钮（属于通知中心面板的范围）
- 通知来源应用的"设置通知偏好"入口

---

**Status**: 设计稿已就绪，等待「立刻落代码（负控先行）」授权。
