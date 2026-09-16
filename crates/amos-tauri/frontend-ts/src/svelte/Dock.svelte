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
  import { appIcon, appTitleKey, APP_META } from "../lib/appMeta";
  import { bridgeDiag, invoke } from "../lib/backend";
  import { getLayout } from "../lib/amosStore";
  import { withoutPhone } from "../lib/phoneApps";
  import { isDesktopFeatureEnabled } from "../lib/desktopFeatures";
  import { t } from "./locale.svelte";
  import { modulesFor } from "../lib/shellModule";
  import { SHELL_MODULES } from "./shellModules";
  import {
    DOCK_HEIGHT,
    DOCK_ICON_SIZE,
    DOCK_MIN_WIDTH,
    dockCapacity,
    dockOverflowCount,
    dockIconScale,
  } from "../lib/desktopLayout";
  import {
    DOCK_ITEM_COLUMN,
    DOCK_OVERFLOW_CHIP,
    DOCK_RUNNING_DOT,
    DOCK_RUNNING_DOT_SLOT,
    DOCK_SEPARATOR,
  } from "../lib/shellChrome";
  import DockAppItem from "./modules/DockAppItem.svelte";
  import DockContextMenu from "./modules/DockContextMenu.svelte";

  // ─── Home Layout（哪些 app 进 Dock）────────────────────────────────────────
  // 桌面形态下，home layout 的 dock 项就是 Dock 栏显示的内容。
  // 电话类 app（有 SIM / 蜂窝需求）在桌面形态下不出现。
  const dockLayout = $derived(getLayout(APP_META.map((a) => a.id)));
  const dockAppIds = $derived(withoutPhone(dockLayout.dock).filter((id) => appTitleKey(id) !== null));

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
  // 窗口宽度来自**自己这条 bar 的实测值**（拿不到就退到窗口宽度），绝不猜。
  // 系统项（启动台 / 访达 / 废纸篓）永远保留，先压缩用户 app —— macOS 同样不会
  // 因为图标多就把废纸篓挤掉；被压掉的 app 以 `+N` 计数**显式**告知，而不是悄悄消失。
  let dockWidth = $state(0);
  $effect(() => {
    const el = dockEl;
    if (!el) return;
    const measure = () => {
      dockWidth = el.getBoundingClientRect().width;
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  });
  const capacity = $derived(dockCapacity(dockWidth > 0 ? dockWidth : windowWidth()));
  const appCapacity = $derived(Math.max(0, capacity - dockModules.length));
  const visibleApps = $derived(dockAppItems.slice(0, appCapacity));
  const overflow = $derived(dockOverflowCount(dockAppItems.length, appCapacity));
  const hiddenNames = $derived(dockAppItems.slice(appCapacity).map((i) => i.label).join(", "));

  function windowWidth(): number {
    return typeof window === "undefined" ? 0 : window.innerWidth;
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
  // 鼠标 X 坐标（视口坐标）
  let mouseX = $state(0);
  // Dock 容器 ref
  let dockEl = $state<HTMLElement | null>(null);

  function onMouseMove(e: MouseEvent) {
    mouseX = e.clientX;
  }

  // 每个图标的 scale：判定复用 `lib/desktopLayout::dockIconScale`（已单测的纯函数），
  // 位置则**实测**——`data-dock-item` 包裹层不带 transform，所以量到的中心是布局中心，
  // 不会因为上一帧的放大而漂移；分隔线与 `+N` 也因此被算进去（先前用
  // `index × (ICON + GAP)` 推算，把分隔线之后的项全部算偏了一个身位）。
  //
  // `$derived.by`（不是 `$derived(() => …)`）：后者存下的是**函数本身**，只有调用点恰好
  // 在渲染上下文里才碰巧工作；`by` 明确表示"这段计算的值"。
  const iconScales = $derived.by(() => {
    const el = dockEl;
    const scales = new Map<string, number>();
    if (!el) return scales;
    for (const item of el.querySelectorAll<HTMLElement>("[data-dock-item]")) {
      const id = item.dataset.dockItem;
      if (!id) continue;
      const rect = item.getBoundingClientRect();
      scales.set(id, dockIconScale(mouseX, rect.left + rect.width / 2));
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

  // 点击空白处关闭菜单（与桌面 stage 右键菜单同一条规则）。
  $effect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ctxMenu) return;
      const target = e.target as Node | null;
      const menuEl = dockEl?.querySelector('[data-testid="dock-context-menu"]') ?? null;
      if (target && menuEl && !menuEl.contains(target)) closeCtxMenu();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeCtxMenu();
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
  - position: fixed bottom-0
  - 高度 76px，含顶部圆角 18px
  - 毛玻璃背景
  - 放大镜效果（CSS scale，JS 鼠标追踪 + **实测**中心）
  - 已打开 app 底部白点指示
  - 点击弹跳动画（active:scale，在 dock 瓦片 token 里）
-->
<div
  bind:this={dockEl}
  class="pointer-events-none absolute bottom-0 left-0 right-0 flex justify-center"
  style="height:{DOCK_HEIGHT}px;"
  role="toolbar"
  aria-label={t("desktop.dock")}
  aria-orientation="horizontal"
  tabindex="-1"
  onmousemove={onMouseMove}
>
  <!-- Dock 容器 -->
  <div
    class="pointer-events-auto flex items-end gap-1 px-6 pb-2"
    data-testid="dock-panel"
    style="
      min-width: {DOCK_MIN_WIDTH}px;
      background: rgba(255, 255, 255, 0.18);
      backdrop-filter: blur(24px) saturate(180%);
      -webkit-backdrop-filter: blur(24px) saturate(180%);
      border-radius: 18px 18px 0 0;
      border-top: 1px solid rgba(255, 255, 255, 0.25);
      border-left: 1px solid rgba(255, 255, 255, 0.15);
      border-right: 1px solid rgba(255, 255, 255, 0.15);
      box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.15);
    "
  >
    <!-- 用户 app（数据来自 home layout；不是注册表的东西） -->
    {#each visibleApps as item (item.id)}
      {@const appScale = iconScales.get(item.id) ?? 1.0}
      <div
        class={DOCK_ITEM_COLUMN}
        data-dock-item={item.id}
        role="presentation"
        oncontextmenu={(e) => onItemContextMenu(e, item.id, null)}
      >
        <!-- 放大镜只作用在这一层：包裹层自身不缩放，容器才量得到稳定的中心。 -->
        <div style="transform: scale({appScale}); margin-bottom: {appScale > 1.05 ? (appScale - 1) * 16 : 0}px;">
          <DockAppItem id={item.id} icon={item.icon} label={item.label} />
        </div>
        <span class={isRunning(item.id, null) ? DOCK_RUNNING_DOT : DOCK_RUNNING_DOT_SLOT}></span>
      </div>
    {/each}

    <!-- 系统项（启动台 / 访达 / 废纸篓）：注册表决定有哪些、什么顺序、在哪划线 -->
    {#each dockModules as mod, i (mod.id)}
      {#if separatorBefore(i)}
        <div class={DOCK_SEPARATOR} data-testid="dock-separator"></div>
      {/if}
      {@const modScale = iconScales.get(mod.id) ?? 1.0}
      {@const Widget = mod.component}
      <div
        class={DOCK_ITEM_COLUMN}
        data-dock-item={mod.id}
        role="presentation"
        oncontextmenu={(e) => onItemContextMenu(e, mod.id, i)}
      >
        <div style="transform: scale({modScale}); margin-bottom: {modScale > 1.05 ? (modScale - 1) * 16 : 0}px;">
          <Widget />
        </div>
        <span class={isRunning(mod.id, i) ? DOCK_RUNNING_DOT : DOCK_RUNNING_DOT_SLOT}></span>
      </div>
    {/each}

    <!-- 装不下的用户 app：显式计数，不静默消失 -->
    {#if overflow > 0}
      <div class={DOCK_ITEM_COLUMN} data-testid="dock-overflow">
        <span
          class={DOCK_OVERFLOW_CHIP}
          style="
            width:{DOCK_ICON_SIZE}px;
            height:{DOCK_ICON_SIZE}px;
            border: 1px solid rgba(255,255,255,0.15);
          "
          title={hiddenNames}
          aria-label={t("desktop.dockOverflow", { n: overflow })}
        >
          {t("desktop.dockOverflowBadge", { n: overflow })}
        </span>
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
