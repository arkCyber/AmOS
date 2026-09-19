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
  import { appIcon, appTitleKey, APP_META } from "../lib/appMeta";
  import { bridgeDiag, invoke } from "../lib/backend";
  import {
    getLayout,
    readStoreValue,
    reorderVisibleDock,
    LAYOUT_KEY,
    type HomeLayout,
  } from "../lib/amosStore";
  import { createStoreValue } from "./store";
  import { DOCK_PREFS_KEY, normalizeDockPrefs, DEFAULT_DOCK_PREFS } from "../lib/dockPrefs";
  import type { DockPrefs } from "../lib/dockPrefs";
  import { onMount, tick } from "svelte";
  import { withoutPhone } from "../lib/phoneApps";
  import { isDesktopFeatureEnabled } from "../lib/desktopFeatures";
  import { t } from "./locale.svelte";
  import { modulesFor } from "../lib/shellModule";
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
    isFullscreen,
    onDockBounce,
  } from "../lib/dockConfig";
  import DockAppItem from "./modules/DockAppItem.svelte";
  import DockContextMenu from "./modules/DockContextMenu.svelte";
  import DockGlobalContextMenu from "./modules/DockGlobalContextMenu.svelte";
  import DockOverflowMenu from "./modules/DockOverflowMenu.svelte";
  import StoreErrorBar from "./StoreErrorBar.svelte";
  import { writeStoreValueChecked } from "../lib/amosStore";
  import type { DockPosition } from "../lib/dockPrefs";
  import { wmOpen } from "../lib/wm";

  // ─── P4: 读取用户偏好 ────────────────────────────────────────────────────
  let prefs = $state<DockPrefs>({ ...DEFAULT_DOCK_PREFS });
  let storeError = $state<string>("");
  
  onMount(() => {
    const raw = readStoreValue<unknown>(DOCK_PREFS_KEY, {});
    prefs = normalizeDockPrefs(raw);
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

  // 监听全屏模式变化 + 用户偏好
  $effect(() => {
    const checkFullscreen = () => {
      const wasFullscreen = autoHide;
      // 自动隐藏 = 用户启用 && (全屏模式 || 用户偏好始终隐藏)
      autoHide = autoHideEnabled && isFullscreen();
      // 全屏时隐藏 Dock
      if (autoHide && !wasFullscreen) {
        dockVisible = false;
      }
    };
    document.addEventListener("fullscreenchange", checkFullscreen);
    checkFullscreen(); // 初始化检查
    return () => document.removeEventListener("fullscreenchange", checkFullscreen);
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
  const dockAppIds = $derived(withoutPhone(layout.dock).filter((id) => appTitleKey(id) !== null));

  // ─── 注册表里的系统项（启动台 / 访达 / 废纸篓）─────────────────────────────
  // 「有哪些、什么顺序、在哪划线」住在 shellModules.ts；这里只是槽位。
  // 分隔线来自数据（`separatorBefore`），不再靠模板里的 `{#if id === "trash"}`。
  const dockModules = modulesFor("dock", SHELL_MODULES);
  function separatorBefore(index: number): boolean {
    return dockModules[index]?.separatorBefore === true;
  }

  // 用户可见的名字：`appTitleKey` 返回的是 **i18n key**，不是名字——直接把它塞进
  // `aria-label`/`title` 会让读屏软件念出 `app.files.title`（这正是先前那版的行为）。
  const dockAppItems = $derived(
    dockAppIds.map((id) => {
      const key = appTitleKey(id);
      return { id, icon: appIcon(id), label: key ? t(key) : id };
    }),
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
  // 通过 wm_windows 获取当前已打开的窗口标签列表。动作不再依赖它：`wm_open` 本身就是
  // create + focus（宿主语义），先前前端自己判 focus/open 是把宿主的决定抄了一遍。
  let openLabels = $state<Set<string>>(new Set());

  $effect(() => {
    void refreshOpenWindows();
    // 每 5 秒刷新一次（与 StatusBar 电池 poll 同步）
    const id = setInterval(refreshOpenWindows, 5000);
    return () => clearInterval(id);
  });

  async function refreshOpenWindows() {
    // REQ-A297 phase-2 §4: `invoke` swallows rejections into `null`
    // (REQ-A296). The previous `try/catch` was dead code — the host
    // could only ever resolve, either to a payload or to `null`. We
    // now branch on the null result: when `wm_windows` is genuinely
    // unavailable (not in a desktop form) the dock just keeps the
    // last-known set; a typed refusion is logged instead of swallowed.
    const raw = await invoke<{ windows: Array<{ label: string; state: string }> } | null>(
      "wm_windows",
    );
    if (raw?.windows) {
      openLabels = new Set(
        raw.windows.filter((w) => w.state !== "Hidden").map((w) => w.label),
      );
      return;
    }
    if (raw === null) {
      const diag = bridgeDiag("wm_windows");
      if (!diag.ok && diag.kind !== "not-bridged") {
        // not-bridged is the normal "phone/tablet form factor" path;
        // anything else (command-failed) is worth a breadcrumb because
        // it means we ARE on desktop but the host still refused.
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
  }

  /** 用户 app 的 id 本身就是窗口标签；注册表项用 `windowLabel`（模块 id 不是窗口名）。 */
  function isRunning(appId: string, moduleIndex: number | null): boolean {
    const label = moduleIndex === null ? appId : (dockModules[moduleIndex]?.windowLabel ?? appId);
    return openLabels.has(label);
  }

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
  // `+N` 溢出芯片右键打开也是合理的（macOS 行为：弹出"完整列表"），但本仓先不做溢出
  // 面板，所以 `+N` 自己的右键不弹出这个菜单。
  interface CtxMenu {
    label: string;
    running: boolean;
    x: number;
    y: number;
  }
  let ctxMenu = $state<CtxMenu | null>(null);

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
    const windowLabel =
      moduleIndex === null ? label : (dockModules[moduleIndex]?.windowLabel ?? label);
    ctxMenu = {
      label: windowLabel,
      running: openLabels.has(windowLabel),
      x: e.clientX,
      y: e.clientY,
    };
  }

  function closeCtxMenu() {
    ctxMenu = null;
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

  function onOverflowClick(e: MouseEvent) {
    // 没有隐藏项就不摆一个空菜单（容量变化后正好全部装得下时）。
    if (hiddenItems.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    overflowMenu = { x: e.clientX, y: e.clientY };
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
    void wmOpen(id);
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
    // Honest boundary: landing on the Dock *pane* is not wired. The page channel
    // (`settingsChannel`) is an in-window props bus, and the Settings screen runs in
    // its own webview — there is no cross-window page route on the host
    // (`wm_open(label)` carries a label and nothing else). The row's label states what
    // actually happens instead of promising a pane we cannot reach.
    void wmOpen("settings");
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
      }
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
  onmousemove={onMouseNearDock}
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
            <DockAppItem id={item.id} icon={item.icon} label={item.label} />
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
