<script lang="ts">
  // Dock.svelte — macOS 风格底部 Dock，现在是一个**容器**（REQ-A262）。
  //
  // 容器只负责容器该负责的事：
  //   - 玻璃面 + 圆角 + 最小宽度（外观 token 在 lib/shellChrome.ts）
  //   - 排布：用户 app（home layout 的 `dock`，数据是用户的）→ 注册表里的系统项
  //     （`modulesFor("dock", SHELL_MODULES)`，分隔线来自 entry 的 `separatorBefore`）
  //   - 容量：装不下的用户 app 用 `+N` **显式**告知，系统项永不被挤掉
  //   - 放大镜：把**实测**的每个 item 中心喂给 `dockIconScale`，transform 加在包裹层上
  //
  // 挂件（modules/Dock*Item.svelte）自带名字与动作；它们通过 getContext 拿到壳注入的
  // `SHELL_CHROME_API` 把手（`openLaunchpad`），拿不到 shellState、布局快照或别的挂件。

  // ─── P2 高级功能 ───────────────────────────────────────────────────────────
  // - Bounce 动画（通知弹跳）
  // - 自动隐藏（全屏模式）
  // - 位置切换（底部/左侧/右侧）
  import { APP_META } from "../lib/appMeta";
  import { iconForId, isDrawableApp, nameForId } from "../lib/appLookup";
  import { getStoreTiles, type StoreTile } from "../lib/storeApps";
  import { bridgeDiag } from "../lib/backend";
  import { subscribeWmWindows } from "../lib/wmWindowsPoll";
  import { runningAppsOf } from "../lib/wm";
  import type { WmWindowsSnapshot } from "../lib/wm";
  import {
    getLayout,
    readStoreValue,
    reorderVisibleDock,
    LAYOUT_KEY,
    type HomeLayout,
  } from "../lib/amosStore";
  import { createStoreValue } from "./store";
  import {
    NOTIF_KEY,
    SETTINGS_KEY,
    dndActive,
    normalizeNotifs,
    normalizeQuick,
    type Notif,
  } from "../lib/settings";
  import { appUnread, badgeText, dockBadgeTotal, setDockBadge } from "../lib/dockBadge";
  import { DOCK_PREFS_KEY, normalizeDockPrefs, DEFAULT_DOCK_PREFS } from "../lib/dockPrefs";
  import type { DockPrefs } from "../lib/dockPrefs";
  import { getContext, tick } from "svelte";
  import { withoutPhone } from "../lib/phoneApps";
  import { isDesktopFeatureEnabled } from "../lib/desktopFeatures";
  import { isContextMenuKey } from "../lib/menuKeys";
  import { NAV_KEYS, nextGridIndex, overviewTiles } from "../lib/overviewKeys";
  import { openSettingsAt } from "./appLinks";
  import { t, ALL_LABEL_DICTS } from "./locale.svelte";
  import { modulesFor, SHELL_CHROME_API, type ShellChromeApi } from "../lib/shellModule";
  import { SHELL_MODULES } from "./shellModules";
  import {
    dockCapacity,
    dockOverflowCount,
    dockIconScale,
  } from "../lib/desktopLayout";
  import {
    DOCK_ITEM_COLUMN,
    DOCK_DROP_TARGET,
    DOCK_OVERFLOW_CHIP,
    DOCK_RUNNING_DOT,
    DOCK_RUNNING_DOT_SLOT,
    DOCK_SEPARATOR,
    GLASS_DOCK_STYLE,
    GLASS_BORDER_DOCK,
  } from "../lib/shellChrome";
  import {
    dockCapacityExtent,
    dockHideTransform,
    dockMagnifyAxis,
    dockPanelStyle,
    dockPositionClass,
    dockRevealZone,
    dockWrapperStyle,
    onDockBounce,
  } from "../lib/dockConfig";
  import DockAppItem from "./modules/DockAppItem.svelte";
  import DockContextMenu from "./modules/DockContextMenu.svelte";
  import DockGlobalContextMenu from "./modules/DockGlobalContextMenu.svelte";
  import DockOverflowMenu from "./modules/DockOverflowMenu.svelte";
  import StoreErrorBar from "./StoreErrorBar.svelte";
  import { writeStoreValueChecked } from "../lib/amosStore";
  import type { DockPosition } from "../lib/dockPrefs";
  import { wmOpenReported } from "../lib/wm";
  import { appOfWindowLabel } from "../lib/windowRoute";

  // ─── P4: 读取用户偏好 ────────────────────────────────────────────────────
  //
  // REQ-A1281：Dock 偏好也**订阅**共享 store（不再是挂载时读一次的快照），与上面
  // `layoutStore`（REQ-A456）同一条理由、同一枚原语。这枚键的另一个写者不在这个文档里：
  // 「Dock」设置页跑在 Settings 自己的 `WebviewWindow`（见 `lib/settingsPages.ts` 开篇），
  // 它写完之后要走跨窗口那半条通路（同源 localStorage 的 `storage` 事件 / 宿主的
  // `store-updated` 推送）才到得了这里，而 `createStoreValue` 正是把两条接上的那枚原语。
  // 此前只读一次，于是设置页上写着的「更改将立即生效」在已经挂着的 Dock 上并不成立 ——
  // 位置、自动隐藏、放大倍数、图标尺寸四项都要等启动器窗口重新加载才生效。
  const prefsStore = createStoreValue<DockPrefs>(DOCK_PREFS_KEY, { ...DEFAULT_DOCK_PREFS });
  let prefs = $state<DockPrefs>({ ...DEFAULT_DOCK_PREFS });
  let storeError = $state<string>("");
  $effect(() => {
    const un = prefsStore.subscribe((v) => (prefs = normalizeDockPrefs(v)));
    return un;
  });

  // ─── P2: Dock 位置配置 ────────────────────────────────────────────────────
  // 现在从用户偏好读取
  const dockPosition = $derived(prefs.position);
  const autoHideEnabled = $derived(prefs.autoHide);
  
  // ─── P4: 放大倍数和图标大小配置 ───────────────────────────────────────────
  const userMagnification = $derived(prefs.magnification);
  const userIconSize = $derived(prefs.iconSize);

  // ─── P2: 自动隐藏功能 ────────────────────────────────────────────────────
  let autoHide = $state(false);
  let dockVisible = $state(true);
  let hideTimer: ReturnType<typeof setTimeout> | null = null;

  // 自动隐藏由**用户偏好**驱动：勾上就隐藏、移近 Dock 边唤出（macOS 的「自动隐藏 Dock」
  // 正是这个含义）。
  //
  // 旧实现写成 `autoHideEnabled && isFullscreen()`，而 `isFullscreen()` 看的是
  // `document.fullscreenElement` —— Tauri 窗口的原生全屏不设该属性，`fullscreenchange`
  // 也不触发，于是右键菜单里那个「自动隐藏」复选框勾了等于没勾：它只在 HTML 全屏下才生效。
  // 只有 `main` 桌面窗口（`document.fullscreenElement` 永远为 null）上跑，所以是永久空开关。
  $effect(() => {
    autoHide = autoHideEnabled;
    dockVisible = !autoHideEnabled;
  });

  // 鼠标移近时显示 Dock（自动隐藏功能）
  function onMouseNearDock(e: MouseEvent) {
    // 放大镜跟的是 Dock **自己的轴**：底部条用 X，左右侧栏用 Y（REQ-A414 ——
    // 旧实现只更新 mouseX，侧栏里每个图标的 X 中心几乎相同 ⇒ 所有图标一起放大）。
    mouseX = e.clientX;
    mouseY = e.clientY;
    if (!autoHide) return;
    // 唤起的边也要跟位置走：旧实现只看底部 80px，于是"左侧 + 自动隐藏"是一个
    // 死角——Dock 正确隐藏之后，唯一能把它叫回来的手势永远够不到。
    if (
      dockRevealZone(dockPosition, e.clientX, e.clientY, window.innerWidth, window.innerHeight)
    ) {
      dockVisible = true;
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
      // 3秒后重新隐藏
      hideTimer = setTimeout(() => {
        if (autoHide) dockVisible = false;
      }, 3000);
    }
  }

  /**
   * 指针位置的消费者挂在 **window** 上，不是 Dock 的包裹层上（REQ-A1345 / FMEA F-SH-610）。
   *
   * 上面那段「唤起的边要跟位置走」把区域几何修对了，但那段代码**根本没人调用**：监听器
   * 原先写在包裹层 `<div … onmousemove>` 上，而那个 div 是 `pointer-events-none` ——
   * 它自己不是命中目标，唯一能命中的小孩是 `pointer-events-auto` 的那颗面板，而自动隐藏
   * 时面板正被 `translateY(100%)`（左右侧栏同理）推出屏幕之外。于是指针永远落不到这一支
   * 元素上，`dockRevealZone` 再准也没有调用者，Dock 一旦滑走就只能靠进设置改偏好叫回来。
   *
   * 挂到 window 上之后，放大镜与唤起都由同一个处理器读同一份坐标（原先有两个处理器各自
   * 更新 `mouseX`/`mouseY`，会因为覆盖顺序闪帧）——`dockIconScale` 在 120px 之外恒为 1.0，
   * 所以指针离得远时不会有任何视觉变化。
   */
  $effect(() => {
    const onMove = (e: MouseEvent) => onMouseNearDock(e);
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  });

  // ─── P2: Bounce 动画状态 ─────────────────────────────────────────────────
  let bouncingAppId = $state<string | null>(null);

  // 订阅 bounce 事件
  $effect(() => {
    const cleanup = onDockBounce("*", (eventAppId) => {
      // 通配符订阅：接收任何 app 的 bounce 事件
      bouncingAppId = eventAppId;
      setTimeout(() => {
        if (bouncingAppId === eventAppId) bouncingAppId = null;
      }, 600);
    });
    return cleanup;
  });

  // ─── Home Layout（哪些 app 进 Dock）────────────────────────────────────────
  // 桌面形态下，home layout 的 dock 项就是 Dock 栏显示的内容。
  // 电话类 app（有 SIM / 蜂窝需求）在桌面形态下不出现。
  //
  // REQ-A456：布局现在**订阅共享 store**（不再是挂载时读一次的快照）。这是拖拽排序的
  // 前提（拖完必须立刻按新顺序重画），也修掉了一个潜伏问题：此前另一个窗口改了布局
  // （或 `store-updated` 从别处到达），Dock 不会跟。
  const layoutStore = createStoreValue<HomeLayout>(
    LAYOUT_KEY,
    getLayout(APP_META.map((a) => a.id)),
  );
  let layout = $state<HomeLayout>(getLayout(APP_META.map((a) => a.id)));
  $effect(() => {
    const un = layoutStore.subscribe((v) => {
      if (v && Array.isArray(v.dock)) layout = v;
    });
    return un;
  });
  // REQ-A1179：Dock 画的 `layout.dock` 与触屏主屏是**同一份**，所以它必须和 `HomeDock`
  // 一样接受商店应用。此前这里的过滤条件是 `appTitleKey(id) !== null`（= 只认内置 app），
  // 一个用户拖进 Dock 的商店应用在桌面形态下会**整个消失**；而紧跟着的名字回退
  // （`key ? t(key) : id`）正是为它写的——过滤已经保证了 `key !== null`，那行是死代码。
  // 瓷砖列表由壳推下来（`SHELL_CHROME_API.storeTiles`，getter ⇒ 保持活）；单独渲染本组件
  // 时回退到模块缓存本身。
  const api = getContext<ShellChromeApi | undefined>(SHELL_CHROME_API);
  const ext = $derived<readonly StoreTile[]>(api?.storeTiles ?? getStoreTiles());
  const dockAppIds = $derived(withoutPhone(layout.dock).filter((id) => isDrawableApp(id, ext)));

  // ─── 注册表里的系统项（启动台 / 访达 / 废纸篓）─────────────────────────────
  // 「有哪些、什么顺序、在哪划线」住在 shellModules.ts；这里只是槽位。
  // 分隔线来自数据（`separatorBefore`），不再靠模板里的 `{#if id === "trash"}`。
  const dockModules = modulesFor("dock", SHELL_MODULES);
  function separatorBefore(index: number): boolean {
    return dockModules[index]?.separatorBefore === true;
  }

  // 用户可见的名字：`appTitleKey` 返回的是 **i18n key**，不是名字——直接把它塞进
  // `aria-label`/`title` 会让读屏软件念出 `app.files.title`（这正是先前那版的行为）。
  // 两个来源（内置注册表 / 已安装商店应用）的解析属于 `lib/appLookup` 一个属主。
  const dockAppItems = $derived(
    dockAppIds.map((id) => ({ id, icon: iconForId(id, ext), label: nameForId(id, ext, t) })),
  );

  // ─── 容量：Dock 装得下才画得下 ──────────────────────────────────────────────
  // 长边来自**自己这条 bar 的实测值**（拿不到就退到窗口的长边），绝不猜。
  // 长边是哪一条取决于位置：底部条量宽、左右侧栏量高（`dockCapacityExtent`）——
  // 旧实现只量宽，于是侧栏会永远报“只能放 3 个”。
  // 系统项（启动台 / 访达 / 废纸篓）永远保留，先压缩用户 app —— macOS 同样不会
  // 因为图标多就把废纸篓挤掉；被压掉的 app 以 `+N` 计数**显式**告知，而不是悄悄消失。
  let dockSize = $state({ width: 0, height: 0 });
  $effect(() => {
    const el = dockEl;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      dockSize = { width: r.width, height: r.height };
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  });
  const capacity = $derived(
    dockCapacity(
      dockCapacityExtent(
        dockPosition,
        dockSize.width > 0 ? dockSize.width : windowWidth(),
        dockSize.height > 0 ? dockSize.height : windowHeight(),
      ),
    ),
  );
  const appCapacity = $derived(Math.max(0, capacity - dockModules.length));
  const visibleApps = $derived(dockAppItems.slice(0, appCapacity));
  const overflow = $derived(dockOverflowCount(dockAppItems.length, appCapacity));
  /** 装不下、被 `visibleApps` 截掉的那些 app —— 溢出芯片的「完整列表」就是它。 */
  const hiddenItems = $derived(dockAppItems.slice(appCapacity));
  const hiddenNames = $derived(hiddenItems.map((i) => i.label).join(", "));

  function windowWidth(): number {
    return typeof window === "undefined" ? 0 : window.innerWidth;
  }
  function windowHeight(): number {
    return typeof window === "undefined" ? 0 : window.innerHeight;
  }

  // ─── 已打开窗口状态（只用于「正在运行」白点）────────────────────────────────
  // 通过 wm_windows 获取当前已打开的**应用**（不是窗口）集合。动作不再依赖它：`wm_open`
  // 本身就是 create + focus（宿主语义），先前前端自己判 focus/open 是把宿主的决定抄了
  // 一遍。
  //
  // REQ-A473：集合里放的是 **app id**。一个应用的第二扇窗标签是 `files_2`，与 Dock 瓦片的
  // `files` 不相等 —— 按标签匹配会让"多开一扇窗"反而把运行中白点**熄灭**（看得见的倒退）。
  // 宿主在 `wm_windows` 里直接给出 `app`，这里只做一次回退到本地解析器，供旧宿主使用。
  let runningApps = $state<Set<string>>(new Set());

  // 运行中白点读的是**壳与 Dock 共用的那一次**轮询（`lib/wmWindowsPoll.ts`）。以前这里
  // 自己开一组 5s 定时器 `invoke("wm_windows")`，与 `DesktopShell` 的同名定时器各问
  // 宿主一遍；注释却写着两者"共享心跳"。现在真的是同一组。
  $effect(() => subscribeWmWindows(applyWindowsSnapshot));

  function applyWindowsSnapshot(snap: WmWindowsSnapshot | null): void {
    if (snap) {
      // REQ-A709：「运行中」= **有已注册的窗口**，与 `state` 无关——窗口只有被**关闭**时
      // 才从 `wm_windows` 消失，`Hidden` 是「在跑、窗口暂时不在屏幕上」（⌘M 的 `wm_hide`、
      // 显示桌面的热角、停在别的 Space）。此前这里过滤 `state !== "Hidden"`，于是最小化 /
      // 显示桌面 / 切 Space 都会把白点熄灭，用户把**在跑**的应用读成**已关闭**（A1 缺陷）。
      runningApps = runningAppsOf(snap);
      return;
    }
    // `null` = 宿主没答。未桥接（手机/平板形态）是正常路径；真正失败
    // （command-failed）留一条面包屑 —— 那说明我们在桌面形态上、宿主仍然拒了。
    const diag = bridgeDiag("wm_windows");
    if (!diag.ok && diag.kind !== "not-bridged") {
      const code =
        diag.kind === "command-failed" &&
        diag.detail &&
        typeof diag.detail === "object"
          ? (diag.detail as { code?: string }).code
          : undefined;
      console.warn(
        "🛟 [Dock] wm_windows refused",
        code ?? diag.kind,
      );
    }
  }

  /** 用户 app 的 id 本身就是**应用**键；注册表项用 `windowLabel`（模块 id 不是应用 id）。 */
  function isRunning(appId: string, moduleIndex: number | null): boolean {
    const label = moduleIndex === null ? appId : (dockModules[moduleIndex]?.windowLabel ?? appId);
    return runningApps.has(label);
  }

  // ─── 未读角标（与触屏 HomeDock 对齐 + 真实 macOS Dock 图标）── REQ-A549 ─────────
  // 桌面的 Dock 此前**完全不画角标**：同一个通知在触屏首页的 dock 图标上有数字，
  // 切到桌面形态就消失（`HomeDock.svelte` 的 `unreadOf` 是此前唯一的另一半）。这里
  // 读**同一个**共享 store（`amos.notifications`）与同一条 DND 规则，判定复用
  // `lib/dockBadge.ts` 的纯函数 —— 两个壳因此不可能给出不同的数字。
  const notifStore = createStoreValue<unknown>(NOTIF_KEY, []);
  const quickStore = createStoreValue<unknown>(SETTINGS_KEY, {});
  let notifs = $state<Notif[]>([]);
  let quick = $state<unknown>({});
  $effect(() => {
    const un = notifStore.subscribe((v) => (notifs = normalizeNotifs(v)));
    return un;
  });
  $effect(() => {
    const un = quickStore.subscribe((v) => (quick = v));
    return un;
  });
  const quiet = $derived(dndActive(normalizeQuick(quick)));

  /** One app's unread count — by **id**, never by a resolved name. A stored row's `app` is
   * a display string in the locale active at push time (`lib/notifApp.ts`), so the rule is a
   * reverse lookup over **every** locale; resolving the id forward through `zh` (the old
   * `notifNameOf`) read zero for any row written under English. */
  const unreadOf = (id: string): number => appUnread(notifs, id, ALL_LABEL_DICTS, quiet);

  // 真实 macOS Dock 图标角标。宿主自 REQ-A389 起就有 `dock_badge_set`，而
  // `tauri-command-allowlist.json` 记下的缺口正是「本壳的 Dock 瓦片不画角标，也没有
  // 通知→角标的桥」。只有 `main` 窗口挂这个 Dock，所以这里是**唯一**的写入者
  // （`dock_badge.rs` 整个模块就是为了保证「一个 app 一个写者」）。
  //
  // 值没变就不写：这个 effect 跟着 store 走，而 store 会在每次 `store-updated` 广播时
  // 抖动，反复写只会换来一串无意义的宿主日志。
  //
  // `lastBadge` 是「宿主**已经**在显示这个」的记忆，所以它只能记**已经被接受**的值
  // （REQ-A1246）：先前这里是 `lastBadge = label; void setDockBadge(label);` —— 记忆落定在
  // 判决**之前**，而 `setDockBadge` 的 `false` 正是宿主拒绝（`dock_badge_set` 在
  // `set_badge_label` ∕ `set_badge_count` 失败或 `no main window` 时返回 `Err`，`invoke`
  // 把它折成 `null`，真值只能从 `bridgeDiag` 读）。于是一次被拒的写入被记成「已经画上」：
  // 同一个值此后直接 `return`，再也不重试，真实的 macOS 图标就与瓦片上的数字永久不一致，
  // 而屏幕上没有任何东西说得出这件事。现在只有 `ok` 才落定 —— 被拒时记忆保持旧值，下一次
  // store 抖动自然会再试一次（拒绝也顺带说一句，与同文件 `wm_windows` 那条面包屑同形）。
  let lastBadge: string | null = null;
  $effect(() => {
    const label = badgeText(dockBadgeTotal(notifs, quiet));
    if (label === lastBadge) return;
    void setDockBadge(label).then((ok) => {
      if (ok) {
        lastBadge = label;
        return;
      }
      // `not-bridged`（手机 ∕ 平板形态）是正常路径，不是失败 —— 与 `wm_windows` 同一把尺子。
      // `diag.ok` 必须**先**判：`bridgeDiag(command)` 的返回类型是 `BridgeDiag | { ok: true }`
      // （「没有记录」的那一支），只有先排除 `ok` 才读得到 `kind` ∕ `detail`。
      const diag = bridgeDiag("dock_badge_set");
      if (diag.ok || diag.kind === "not-bridged") return;
      const code =
        diag.kind === "command-failed" &&
        diag.detail &&
        typeof diag.detail === "object"
          ? (diag.detail as { code?: string }).code
          : undefined;
      console.warn("🛟 [Dock] dock_badge_set refused", code ?? diag.kind);
    });
  });

  // ─── 放大镜效果 ────────────────────────────────────────────────────────────
  // 指针坐标（视口坐标）—— 放大镜 + 自动隐藏共用 `onMouseNearDock`，在那里一并更新
  // `mouseX` / `mouseY`。先前 `onMouseMove` 与 `onMouseNearDock` 两个处理器各自更新
  // 自己的状态，会因为覆盖顺序产生闪烁（自动隐藏处理器先到、放大镜丢一帧）。
  // 两个坐标都留：Dock 走哪条轴由位置决定（`dockMagnifyAxis`），用错轴时侧栏上每个
  // 图标的中心几乎相同 ⇒ 整列一起放大。
  let mouseX = $state(0);
  let mouseY = $state(0);
  // Dock 容器 ref
  let dockEl = $state<HTMLElement | null>(null);

  // 每个图标的 scale：判定复用 `lib/desktopLayout::dockIconScale`（已单测的纯函数，
  // 它的两个位置参数是**沿轴的距离**，与哪条轴无关），位置则**实测**——`data-dock-item`
  // 包裹层不带 transform，所以量到的中心是布局中心，不会因为上一帧的放大而漂移；
  // 分隔线与 `+N` 也因此被算进去（先前用 `index × (ICON + GAP)` 推算，把分隔线之后的
  // 项全部算偏了一个身位）。
  //
  // `$derived.by`（不是 `$derived(() => …)`）：后者存下的是**函数本身**，只有调用点恰好
  // 在渲染上下文里才碰巧工作；`by` 明确表示"这段计算的值"。
  const iconScales = $derived.by(() => {
    const el = dockEl;
    const scales = new Map<string, number>();
    if (!el) return scales;
    const axis = dockMagnifyAxis(dockPosition);
    for (const item of el.querySelectorAll<HTMLElement>("[data-dock-item]")) {
      const id = item.dataset.dockItem;
      if (!id) continue;
      const rect = item.getBoundingClientRect();
      const pointer = axis === "y" ? mouseY : mouseX;
      const centre = axis === "y" ? rect.top + rect.height / 2 : rect.left + rect.width / 2;
      // P4: 使用用户配置的放大倍数
      scales.set(id, dockIconScale(pointer, centre, userMagnification));
    }
    return scales;
  });

  // ─── 右键菜单（macOS Dock 的"右键 → 显示/隐藏/退出"）────────────────────
  // Dock 上右键一个 app 图标弹出菜单。**只有"宿主能做的"动作是实活**：能开 / 关 / 隐藏
  // 一个窗口，per-app 选项菜单就先灰掉登记为缺口，不假装能做（与桌面 stage 右键菜单
  // 是同一套纪律——见 `docs/FMEA.md` F-SH-001）。
  //
  // `moduleIndex === null` ⇒ 这是一个用户 app（label = appId）；非 null ⇒ 是注册表里
  // 的系统项（label 取自 `windowLabel`，模块 id 不是窗口名）。两种 item 都允许右键。
  // `+N` 溢出芯片的右键**不是**这个菜单：它弹出的是它自己那份「完整列表」（macOS 行为，
  // 与左键同一个面板）—— 见 `onOverflowContextMenu`。原先这里写的是「本仓先不做溢出
  // 面板」，但 REQ-A415 早就把 `DockOverflowMenu` 做出来了，那句理由已经不成立；而芯片
  // 只有 `onclick`，右键会一路冒泡到这里，于是给出一个**答非所问**的菜单（问的是"这几个
  // 装不下的 app 是什么"，答的是"Dock 偏好设置"）。这正是 F-SH-001 那一族。
  interface CtxMenu {
    label: string;
    running: boolean;
    x: number;
    y: number;
  }
  let ctxMenu = $state<CtxMenu | null>(null);

  /** 摆出某一块瓦片的菜单。位置由调用者给 —— 指针走 `clientX/clientY`，键盘走那块瓦片的
   * 矩形；**一条实现**，否则「菜单是关于谁的」这半个判定会在两条路径上漂移。
   *
   * REQ-A1124：**只有指向一个应用的瓦片才有应用菜单**。系统项里只有「访达」带
   * `windowLabel`（`shellModules.ts:159` → `files`）；「启动台 / 废纸篓」没有，于是上面那行
   * 回退成**模块 id**（`dock-launchpad` / `dock-trash`）—— 而宿主不校验 label：
   * `WmState::open`（`wm.rs:1271`）照单解析、注册、`WebviewWindowBuilder`（`wm.rs:1815`）真的
   * 建出一扇窗。也就是说，在启动台上右键会**造出一个不存在的应用**的窗口，正是 `DockContextMenu`
   * 里姊妹行「新建窗口」用 `appOfWindowLabel` 守住的那件事（它的注释逐字写了这个危害）。
   * macOS 的启动台图标本来也没有右键菜单 —— 不弹，比弹一个关于「不存在的应用」的菜单诚实。 */
  function openItemMenu(label: string, moduleIndex: number | null, x: number, y: number) {
    const windowLabel =
      moduleIndex === null ? label : (dockModules[moduleIndex]?.windowLabel ?? label);
    if (appOfWindowLabel(windowLabel) === null) return;
    ctxMenu = {
      label: windowLabel,
      running: runningApps.has(windowLabel),
      x,
      y,
    };
  }

  function onItemContextMenu(
    e: MouseEvent,
    label: string,
    moduleIndex: number | null,
  ) {
    // 关掉右键菜单 ⇒ 让浏览器原生的右键菜单出现(开发者/调试用)。这是
    // `AMOS_DOCK_CONTEXT_MENU=disabled` 的语义:不抢右键,但也不假装提供。
    if (!isDesktopFeatureEnabled("dock-context-menu")) return;
    e.preventDefault();
    e.stopPropagation();
    openItemMenu(label, moduleIndex, e.clientX, e.clientY);
  }

  function closeCtxMenu() {
    ctxMenu = null;
  }

  /**
   * 键盘打开菜单的那一半（Shift+F10 / 键盘上的 ContextMenu 键）—— F-DEV-026 把危害写成
   * 了「**打不开**也用不了 …… 的右键菜单」，而它那一轮只实现了「用不了」（`lib/menuKeys`
   * 让**已经打开**的菜单能走行）。没有任何一个键能打开这两份菜单。
   *
   * 判定与「菜单是关于谁的」都来自指针路径的同一处实现：焦点在哪块瓦片上，菜单就是哪块
   * 瓦片的（macOS 同一条规则）。位置取那块元素自己的矩形。
   *
   * **只在焦点真的落在 Dock 里时才认领这个组合键**：桌面 stage 在 `window` 上听同一个
   * 组合键，冒泡路径上 `document` 先于 `window` —— 于是要么这里认领（`stopPropagation`
   * 让 window 收不到），要么 stage 拿到，绝不会两边同时开菜单。
   */
  /**
   * Arrow-key navigation between the Dock's tiles — the keyboard model its `role="toolbar"`
   * declares (APG: a toolbar's items are reached with the arrows; macOS's Dock walks the same
   * way). Until now the Dock answered exactly one key, Shift+F10, so the arrows did nothing.
   */
  function onDockNavKey(e: KeyboardEvent): boolean {
    if (!NAV_KEYS.has(e.key)) return false;
    if (!dockEl) return false;
    const tiles = overviewTiles(dockEl);
    if (tiles.length === 0) return false;
    // Claim the key **only when one of the Dock's own tiles holds the focus** — and return
    // without claiming otherwise, rather than landing on the first tile the way
    // `installGridKeyboard` does. That installer may assume a focused container because
    // Launchpad traps the focus for its whole lifetime; a Dock that stays mounted for the
    // whole session may not, or every arrow pressed anywhere in the shell would yank the
    // focus ring into the Dock. Everywhere else the key belongs to whoever really has it —
    // the desktop's icon grid listens on `window` and must keep its arrows.
    const from = tiles.indexOf(document.activeElement as HTMLButtonElement);
    if (from < 0) return false;
    // A bottom Dock is one row of tiles; a side Dock is one column. `nextGridIndex` reads the
    // same geometry the overview panels and Launchpad use — one owner of "where does the arrow
    // go" — and in a single row it makes Up/Down walk the row rather than dead keys.
    const cols = dockPosition === "bottom" ? tiles.length : 1;
    const target = nextGridIndex(e.key, from, tiles.length, cols);
    if (target === null) return false;
    const next = tiles[target];
    if (!next || next === document.activeElement) return false;
    e.preventDefault();
    // Claimed here for the same reason the overview installers do it: `DesktopStage`'s icon
    // grid listens on `window`, and a bubble-phase `window` listener runs after this one.
    e.stopPropagation();
    next.focus();
    return true;
  }

  function onDockKeyDown(e: KeyboardEvent) {
    if (!isContextMenuKey(e)) return;
    const el = e.target instanceof Element ? e.target : null;
    if (!el || !dockEl?.contains(el)) return;
    // 与右键同一个能力开关：关掉时一个键都不抢（见 `onItemContextMenu`）。
    if (!isDesktopFeatureEnabled("dock-context-menu")) return;

    // 焦点落在这块瓦片的哪个子元素上都算（真按钮是瓦片的子节点）。
    const itemEl = el.closest("[data-dock-item]");
    const overflowEl = el.closest('[data-testid="dock-overflow"]');
    const anchor = (node: Element | null) => {
      const r = node?.getBoundingClientRect();
      return { x: r?.left ?? 0, y: r?.top ?? 0 };
    };
    e.preventDefault();
    e.stopPropagation();
    if (overflowEl) {
      // 芯片是 `aria-haspopup="menu"` 的真按钮，它自己的菜单是「装不下的那些 app」——
      // 在这里落到 Dock 偏好菜单上就是 F-SH-001 那种「答非所问」。
      const at = anchor(overflowEl);
      openOverflowMenuAt(at.x, at.y);
      return;
    }
    if (itemEl) {
      const id = itemEl.getAttribute("data-dock-item");
      if (!id) return;
      const i = dockModules.findIndex((m) => m.id === id);
      const at = anchor(itemEl);
      openItemMenu(id, i >= 0 ? i : null, at.x, at.y);
      return;
    }
    // 焦点在 Dock 空白处（容器本身）：macOS 给的是 Dock 偏好菜单。
    const at = anchor(dockEl);
    globalCtxMenu = { x: at.x, y: at.y };
  }

  // ─── 全局右键菜单（macOS Dock 的"右键空白区域 → Dock 偏好设置"）────────
  interface GlobalCtxMenu {
    x: number;
    y: number;
  }
  let globalCtxMenu = $state<GlobalCtxMenu | null>(null);

  function onDockContainerContextMenu(e: MouseEvent) {
    if (!isDesktopFeatureEnabled("dock-context-menu")) return;
    e.preventDefault();
    e.stopPropagation();
    globalCtxMenu = {
      x: e.clientX,
      y: e.clientY,
    };
  }

  function closeGlobalCtxMenu() {
    globalCtxMenu = null;
  }

  // ─── 拖拽排序（REQ-A456）─────────────────────────────────────────────────────
  // macOS 的 Dock：按住图标横向（侧边栏时纵向）拖动，指针下的那个图标就是插入位置，
  // 松手即落位。规则本身住在 `lib/amosStore.ts::reorderVisibleDock`（纯函数、已单测）；
  // 这里只负责"谁在拖、指针在谁上面、松手时交给谁"。
  //
  // 两个刻意的选择：
  //   * **只有用户 app 瓦片是投放目标**：系统项（启动台 / 访达 / 废纸篓）的位置是产品
  //     决定，不是用户数据（`layout.dock` 里根本没有它们）——把 app 拖到废纸篓上不该
  //     发生任何事，也不该被画成"会落在这里"。
  //   * **投放目标取自事件本身**（`e.target.closest`），不是 `elementFromPoint`：
  //     mousemove 的 target **就是**指针下的元素，这条路径既更短，也能在 happy-dom 里
  //     被测试驱动（`elementFromPoint` 在无布局的测试环境里没有意义）。
  let dragState = $state<{ id: string; x: number; y: number; active: boolean } | null>(null);
  let dropTargetId = $state<string | null>(null);
  /** 一次成功落位之后要吃掉紧随其后的那次 click —— 否则拖完会顺手把 app 打开。 */
  let dragJustEnded = false;
  /** 小于这个位移算点击（用户只是点了一下图标，肌肉记忆是"打开"而不是"排序"）。 */
  const DOCK_DRAG_THRESHOLD_PX = 4;

  /**
   * Drag start — **delegated on the dock container**, not one listener per tile.
   *
   * Two reasons. (1) The tile wrapper is a `<div role="listitem">`, and hanging a mouse
   * listener on a non-interactive element is exactly the a11y warning this repo keeps at
   * zero (`svelte-check` flags it, and the warning is right: the *button* inside is the
   * interactive thing). (2) One listener cannot drift from another: "which tiles are
   * draggable" is one predicate, evaluated where the drag starts.
   */
  function onDockMouseDown(e: MouseEvent) {
    if (e.button !== 0) return; // right click belongs to the context menu
    const el = e.target instanceof Element ? e.target : null;
    const item = el?.closest("[data-dock-item]") as HTMLElement | null;
    const id = item?.dataset.dockItem ?? null;
    // System tiles (launchpad / finder / trash) are not in `layout.dock` and are not
    // draggable: their positions are a product decision, not user data.
    if (!id || !dockAppIds.includes(id)) return;
    dragState = { id, x: e.clientX, y: e.clientY, active: false };
  }

  function onWindowDragMove(e: MouseEvent) {
    const d = dragState;
    if (!d) return;
    if (!d.active) {
      if (
        Math.abs(e.clientX - d.x) < DOCK_DRAG_THRESHOLD_PX &&
        Math.abs(e.clientY - d.y) < DOCK_DRAG_THRESHOLD_PX
      ) {
        return;
      }
      d.active = true;
    }
    const el = e.target instanceof Element ? e.target : null;
    const item = el?.closest("[data-dock-item]") as HTMLElement | null;
    const over = item?.dataset.dockItem ?? null;
    // `dockAppIds.includes` is **defence in depth**, not the protection: the rule itself
    // lives in the pure layer, where a hovered id that is not in the dock makes
    // `reorderVisibleDock` return the layout unchanged (unit-tested). Keeping the predicate
    // here states the intent where the pointer is read — and stops a system tile from ever
    // becoming a target if a later edit paints the hint from this state instead.
    dropTargetId = over && over !== d.id && dockAppIds.includes(over) ? over : null;
  }

  function onWindowDragEnd() {
    const d = dragState;
    dragState = null;
    const target = dropTargetId;
    dropTargetId = null;
    if (!d?.active || !target) return;
    const next = reorderVisibleDock(layout, dockAppIds, d.id, target);
    if (next === layout) return; // 落回原位：什么都不写
    if (!writeStoreValueChecked(LAYOUT_KEY, next)) {
      // 与 Dock 的其他写入同一条纪律：写不进去就如实说，并**保持内存里的旧顺序**。
      storeError = t("common.storeWriteFailed");
      return;
    }
    storeError = "";
    layout = next;
    dragJustEnded = true;
    void tick().then(() => {
      dragJustEnded = false;
    });
  }

  /** 捕获阶段：拖拽结束后的那一次 click 属于"用户刚把图标放下"，不是"请打开它"。 */
  function onItemClickCapture(e: MouseEvent) {
    if (!dragJustEnded) return;
    e.preventDefault();
    e.stopPropagation();
  }

  $effect(() => {
    window.addEventListener("mousemove", onWindowDragMove);
    window.addEventListener("mouseup", onWindowDragEnd);
    return () => {
      window.removeEventListener("mousemove", onWindowDragMove);
      window.removeEventListener("mouseup", onWindowDragEnd);
    };
  });

  // ─── 溢出「完整列表」（macOS 点 `+N` 芯片 → 菜单）────────────────────────────
  // REQ-A415：芯片原来是 `<span title="…">` —— 看着像 Dock 的溢出入口，实际是个
  // tooltip：点不动、键盘到不了。现在它是个真按钮，列出**装不下的那些 app**，
  // 条目走与 Dock 瓦片**同一条** `wm_open` 路径。
  interface OverflowMenu {
    x: number;
    y: number;
  }
  let overflowMenu = $state<OverflowMenu | null>(null);

  /** 摆出「完整列表」。位置由调用者给：指针走 `clientX/clientY`，键盘走芯片的矩形。 */
  function openOverflowMenuAt(x: number, y: number) {
    // 没有隐藏项就不摆一个空菜单（容量变化后正好全部装得下时）。
    if (hiddenItems.length === 0) return;
    overflowMenu = { x, y };
  }

  function onOverflowClick(e: MouseEvent) {
    if (hiddenItems.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    openOverflowMenuAt(e.clientX, e.clientY);
  }

  /**
   * 溢出芯片的右键 —— 与左键打开**同一个**「完整列表」（macOS 行为）。
   *
   * 少了这一个处理器，芯片的右键会冒泡到 Dock 容器的 `onDockContainerContextMenu`，
   * 弹出的是一份关于 Dock 偏好的菜单：用户问的是"这几个装不下的 app 都是谁"，答的是
   * "图标多大"。停止冒泡，让这次右键落到它自己那份列表上。
   *
   * 它同样是右键手势，所以与 Dock 其余右键菜单共用同一个开关：`dock-context-menu`
   * 关掉时浏览器原生菜单照常出现，这里一个字都不拦截（见 `onItemContextMenu`）。
   */
  function onOverflowContextMenu(e: MouseEvent) {
    if (!isDesktopFeatureEnabled("dock-context-menu")) return;
    onOverflowClick(e);
  }

  function closeOverflowMenu() {
    overflowMenu = null;
  }

  /** 从列表里打开一个装不下的 app（与 Dock 瓦片同一动作）。 */
  function openOverflowApp(id: string) {
    // REQ-A415: must be `wm_open`, not `openApp(...)` — `openApp` switches the **touch
    // shell's** surface (`shellState`), which the desktop form never renders (Shell
    // mounts `DesktopShell` for it). Every other Dock action (`DockAppItem`,
    // `DockFinderItem`) goes through `wm_open`; the overflow list is one of them.
    void wmOpenReported(id, "Dock");
  }

  function handlePositionChange(position: DockPosition) {
    prefs.position = position;
    const success = writeStoreValueChecked(DOCK_PREFS_KEY, prefs);
    if (!success) {
      storeError = t("common.storeWriteFailed");
      // 恢复到之前的值
      const raw = readStoreValue<unknown>(DOCK_PREFS_KEY, {});
      prefs = normalizeDockPrefs(raw);
    } else {
      storeError = "";
    }
  }

  function handleAutoHideToggle() {
    prefs.autoHide = !prefs.autoHide;
    const success = writeStoreValueChecked(DOCK_PREFS_KEY, prefs);
    if (!success) {
      storeError = t("common.storeWriteFailed");
      // 恢复到之前的值
      const raw = readStoreValue<unknown>(DOCK_PREFS_KEY, {});
      prefs = normalizeDockPrefs(raw);
    } else {
      storeError = "";
    }
  }

  function handleMagnificationChange(delta: number) {
    const oldMag = prefs.magnification;
    const newMag = Math.max(1.0, Math.min(2.0, prefs.magnification + delta));
    prefs.magnification = parseFloat(newMag.toFixed(1));
    const success = writeStoreValueChecked(DOCK_PREFS_KEY, prefs);
    if (!success) {
      storeError = t("common.storeWriteFailed");
      prefs.magnification = oldMag;
    } else {
      storeError = "";
    }
  }

  function handleIconSizeChange(delta: number) {
    const oldSize = prefs.iconSize;
    const newSize = Math.max(32, Math.min(64, prefs.iconSize + delta));
    prefs.iconSize = newSize;
    const success = writeStoreValueChecked(DOCK_PREFS_KEY, prefs);
    if (!success) {
      storeError = t("common.storeWriteFailed");
      prefs.iconSize = oldSize;
    } else {
      storeError = "";
    }
  }

  function handleOpenPreferences() {
    // REQ-A415: this used to be `openApp("settings", "dock")` — the **touch** shell's
    // surface switcher. In the desktop form `Shell.svelte` mounts `DesktopShell` and
    // never renders that surface, so the row was a silent no-op (the FMEA F-SH-001
    // shape: a menu item that says something will happen). It opens the real Settings
    // window through `wm_open`, exactly like the desktop stage's 「显示设置」 row.
    //
    // REQ-A790: it now lands on the Dock *pane* too. The old note here said that was
    // impossible because `settingsChannel` is an in-window bus and "`wm_open(label)`
    // carries a label and nothing else" — the first half is true, the second is not:
    // `wm_open` is not the only cross-window channel, the **shared store** is one, and
    // the Files window already receives destinations through it (REQ-A458/A783). So the
    // destination goes through the store and `wmOpen` still does the opening. Order
    // matters — write, then open — because a Settings window that does not exist yet
    // seeds itself from the store as it mounts.
    if (!openSettingsAt("dock")) {
      // The pane could not be recorded, so say so instead of opening Settings at its
      // index and letting the user think this is the page they asked for.
      storeError = t("common.storeWriteFailed");
      return;
    }
    storeError = "";
    void wmOpenReported("settings", "Dock");
  }

  // 点击空白处关闭菜单（与桌面 stage 右键菜单同一条规则）。
  $effect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ctxMenu && !globalCtxMenu && !overflowMenu) return;
      // REQ-A414: both menus render as **siblings** of the `bind:this={dockEl}`
      // container (see the template comment), so `dockEl.querySelector(...)` could
      // never find them and the two close branches were dead — the menu stayed put on
      // every outside click. Ask the event's own target instead: `closest` walks up
      // from wherever the mousedown landed and finds the menu regardless of nesting.
      const target = e.target instanceof Element ? e.target : null;
      if (ctxMenu && !target?.closest('[data-testid="dock-context-menu"]')) closeCtxMenu();
      if (globalCtxMenu && !target?.closest('[data-testid="dock-global-context-menu"]')) {
        closeGlobalCtxMenu();
      }
      // REQ-A415: same rule for the overflow list (and same reasoning — it is a
      // sibling too).
      if (overflowMenu && !target?.closest('[data-testid="dock-overflow-menu"]')) {
        closeOverflowMenu();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeCtxMenu();
        closeGlobalCtxMenu();
        closeOverflowMenu();
        return;
      }
      // 键盘打开菜单的那一半（见 `onDockKeyDown`）：焦点不在 Dock 里时它什么都不做，
      // 组合键留给桌面 stage。
      if (onDockNavKey(e)) return;
      onDockKeyDown(e);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  });
</script>

<!--
  macOS Dock：
  - position: bottom-0（或 left-0 / right-0，见 `dockPositionClass` + `dockWrapperStyle`）
  - 高度 68px（macOS 标准，含 16px 底部 padding）——侧边时改为从顶栏下沿到底边的**竖列**
  - 毛玻璃背景
  - 放大镜效果（CSS scale，JS 鼠标追踪 + **实测**中心，轴由位置决定）
  - 已打开 app 底部白点指示
  - 点击弹跳动画（active:scale，在 dock 瓦片 token 里）
-->
<StoreErrorBar message={storeError} />

<div
  bind:this={dockEl}
  class="pointer-events-none absolute flex {dockPositionClass(dockPosition)}"
  style="{dockWrapperStyle(dockPosition)}"
  role="toolbar"
  aria-label={t("desktop.dock")}
  aria-orientation={dockPosition === "bottom" ? "horizontal" : "vertical"}
  tabindex="-1"
  onmousedown={onDockMouseDown}
>
  <!-- Dock 容器 -->
  <div
    class="pointer-events-auto flex items-end gap-1 px-6 pb-2"
    class:flex-col={dockPosition !== "bottom"}
    data-testid="dock-panel"
    role="list"
    aria-label={t("desktop.dockApps")}
    oncontextmenu={onDockContainerContextMenu}
    style="
      {dockPanelStyle(dockPosition)}
      {GLASS_DOCK_STYLE}
      {GLASS_BORDER_DOCK}
      box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.15);
      transition: transform 0.3s ease-in-out;
      transform: {dockHideTransform(dockPosition, autoHide && !dockVisible)};
      --dock-icon-size: {userIconSize}px;
    "
  >
    <!-- 用户 app（数据来自 home layout；不是注册表的东西） -->
    {#each visibleApps as item (item.id)}
      {@const appScale = iconScales.get(item.id) ?? 1.0}
      {@const isBouncing = bouncingAppId === item.id}
      <div
        class="{DOCK_ITEM_COLUMN} {dropTargetId === item.id ? DOCK_DROP_TARGET : ''}"
        data-dock-item={item.id}
        data-dock-drop-target={dropTargetId === item.id ? "true" : undefined}
        role="listitem"
        aria-label={item.label}
        onclickcapture={onItemClickCapture}
        oncontextmenu={(e) => onItemContextMenu(e, item.id, null)}
      >
        <!-- 放大镜只作用在这一层：包裹层自身不缩放，容器才量得到稳定的中心。
             bounce 动画应用在放大镜**内部**的图标上：放大是容器的事、弹跳是
             应用的事，分两层职责更清晰（先前把 bounce 加在外层 listitem 上，
             弹跳与放大同时发生时位置计算就漂了）。 -->
        <div style="transform: scale({appScale}); margin-bottom: {appScale > 1.05 ? (appScale - 1) * 16 : 0}px;">
          <div class={isBouncing ? "dock-bounce" : ""}>
            <DockAppItem
              id={item.id}
              icon={item.icon}
              label={item.label}
              unread={unreadOf(item.id)}
            />
          </div>
        </div>
        <span class={isRunning(item.id, null) ? DOCK_RUNNING_DOT : DOCK_RUNNING_DOT_SLOT}></span>
      </div>
    {/each}

    <!-- 系统项（启动台 / 访达 / 废纸篓）：注册表决定有哪些、什么顺序、在哪划线 -->
    {#each dockModules as mod, i (mod.id)}
      {#if separatorBefore(i)}
        <div class={DOCK_SEPARATOR} data-testid="dock-separator" role="separator" aria-orientation="vertical"></div>
      {/if}
      {@const modScale = iconScales.get(mod.id) ?? 1.0}
      {@const modIsBouncing = bouncingAppId === mod.id}
      {@const Widget = mod.component}
      <div
        class={DOCK_ITEM_COLUMN}
        data-dock-item={mod.id}
        role="listitem"
        aria-label={t(mod.titleKey)}
        oncontextmenu={(e) => onItemContextMenu(e, mod.id, i)}
      >
        <div style="transform: scale({modScale}); margin-bottom: {modScale > 1.05 ? (modScale - 1) * 16 : 0}px;">
          <div class={modIsBouncing ? "dock-bounce" : ""}>
            <Widget />
          </div>
        </div>
        <span class={isRunning(mod.id, i) ? DOCK_RUNNING_DOT : DOCK_RUNNING_DOT_SLOT}></span>
      </div>
    {/each}

    <!-- 装不下的用户 app：显式计数，不静默消失。点它 → macOS 的「完整列表」菜单
         （REQ-A415：此前是个 `<span title>`，看着像入口却点不动）。 -->
    {#if overflow > 0}
      <div class={DOCK_ITEM_COLUMN} data-testid="dock-overflow">
        <button
          type="button"
          class={DOCK_OVERFLOW_CHIP}
          style="
            width:{userIconSize}px;
            height:{userIconSize}px;
            border: 1px solid rgba(255,255,255,0.15);
          "
          title={hiddenNames}
          aria-label={t("desktop.dockOverflow", { n: overflow })}
          aria-haspopup="menu"
          aria-expanded={overflowMenu !== null}
          onclick={onOverflowClick}
          oncontextmenu={onOverflowContextMenu}
        >
          {t("desktop.dockOverflowBadge", { n: overflow })}
        </button>
        <span class={DOCK_RUNNING_DOT_SLOT}></span>
      </div>
    {/if}
  </div>
</div>

<!-- Dock 右键菜单（macOS 的"右键 → 显示/隐藏/退出"）。渲染在 Dock 容器**之外**，所以
     `z-index` 与浮层一致，且不参与放大镜测量（包裹层不放在 Dock 容器里）。 -->
{#if ctxMenu}
  <DockContextMenu
    label={ctxMenu.label}
    running={ctxMenu.running}
    x={ctxMenu.x}
    y={ctxMenu.y}
    onclose={closeCtxMenu}
  />
{/if}

<!-- Dock 全局右键菜单（macOS 的"右键空白区域 → Dock 偏好设置"） -->
{#if globalCtxMenu}
  <DockGlobalContextMenu
    prefs={prefs}
    x={globalCtxMenu.x}
    y={globalCtxMenu.y}
    onclose={closeGlobalCtxMenu}
    onPositionChange={handlePositionChange}
    onAutoHideToggle={handleAutoHideToggle}
    onMagnificationChange={handleMagnificationChange}
    onIconSizeChange={handleIconSizeChange}
    onOpenPreferences={handleOpenPreferences}
  />
{/if}

<!-- 溢出「完整列表」（macOS 点 `+N` 芯片 → 列出装不下的 app）。同样渲染在 Dock 容器
     之外：z-index 与浮层一致，且不参与放大镜测量。 -->
{#if overflowMenu}
  <DockOverflowMenu
    items={hiddenItems}
    x={overflowMenu.x}
    y={overflowMenu.y}
    onpick={openOverflowApp}
    onclose={closeOverflowMenu}
  />
{/if}
