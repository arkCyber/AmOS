<script lang="ts">
  // Dock.svelte — macOS 风格底部 Dock。
  //
  // 渲染在 DesktopShell 内（DesktopShell → TopBar + Dock + 舞台）。
  // 高度 76px（含顶部圆角 18px），毛玻璃背景，底部固定。
  //
  // 行为：
  //   - launchpad: 点击发射 Launchpad 全屏浮层
  //   - finder: 点击调 wm_open("files")
  //   - 普通 app: 若已打开（wm_windows 报告）→ wm_focus(id)；若未打开 → wm_open(id)
  //   - 已打开 app 在图标下方显示白点指示
  //   - macOS 放大镜效果（鼠标靠近放大）
  import { createEventDispatcher } from "svelte";
  import { invoke } from "../lib/backend";
  import { appIcon, appTitleKey, APP_META } from "../lib/appMeta";
  import { getLayout } from "../lib/amosStore";
  import { withoutPhone } from "../lib/phoneApps";
  import { t } from "./locale.svelte";
  import {
    DOCK_HEIGHT,
    DOCK_ICON_SIZE,
    DOCK_ICON_GAP,
    DOCK_SIDE_PADDING,
    DOCK_MIN_WIDTH,
    dockCapacity,
    dockOverflowCount,
    dockIconScale,
  } from "../lib/desktopLayout";

  const dispatch = createEventDispatcher<{ launchpad: void }>();

  // ─── Home Layout（哪些 app 进 Dock）────────────────────────────────────────
  // 桌面形态下，home layout 的 dock 项就是 Dock 栏显示的内容。
  // 电话类 app（有 SIM / 蜂窝需求）在桌面形态下不出现。
  const dockLayout = $derived(getLayout(APP_META.map((a) => a.id)));
  const dockAppIds = $derived(withoutPhone(dockLayout.dock).filter((id) => appTitleKey(id) !== null));

  // ─── 固定 Dock 项 ──────────────────────────────────────────────────────────
  // 启动台（🚀）+ Finder（💻）排在用户 app 之后；废纸篓（🗑️）在分隔线之后。
  // 名字走 i18n：桌面形态对 zh 用户同样是产品界面，不该只有英文。
  const fixedLeading = $derived([
    { id: "launchpad", icon: "🚀", label: t("desktop.launchpad") },
    { id: "files", icon: "💻", label: t("desktop.finder") },
  ]);
  const fixedTrailing = $derived([{ id: "trash", icon: "🗑️", label: t("desktop.trash") }]);

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
  // 系统项（启动台 / Finder / 废纸篓）永远保留，先压缩用户 app —— macOS 同样不会
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
  const appCapacity = $derived(
    Math.max(0, capacity - (fixedLeading.length + fixedTrailing.length)),
  );
  const visibleApps = $derived(dockAppItems.slice(0, appCapacity));
  const overflow = $derived(dockOverflowCount(dockAppItems.length, appCapacity));
  const hiddenNames = $derived(dockAppItems.slice(appCapacity).map((i) => i.label).join(", "));
  /** 实际画出来的项：用户 app + 系统项（后者永不被容量挤掉）。 */
  const visibleItems = $derived([...visibleApps, ...fixedLeading, ...fixedTrailing]);

  function windowWidth(): number {
    return typeof window === "undefined" ? 0 : window.innerWidth;
  }

  // ─── 已打开窗口状态 ────────────────────────────────────────────────────────
  // 通过 wm_windows 获取当前已打开的窗口标签列表。
  // 桌面形态下，每个 app 窗口对应一个 Tauri WebviewWindow。
  let openLabels = $state<Set<string>>(new Set());

  $effect(() => {
    void refreshOpenWindows();
    // 每 5 秒刷新一次（与 StatusBar 电池 poll 同步）
    const id = setInterval(refreshOpenWindows, 5000);
    return () => clearInterval(id);
  });

  async function refreshOpenWindows() {
    try {
      const raw = await invoke<{ windows: Array<{ label: string; state: string }> }>(
        "wm_windows",
      );
      if (raw?.windows) {
        openLabels = new Set(
          raw.windows.filter((w) => w.state !== "Hidden").map((w) => w.label),
        );
      }
    } catch {
      /* wm_windows 在非桌面形态下不可用 */
    }
  }

  // ─── 点击行为 ──────────────────────────────────────────────────────────────
  async function handleClick(id: string) {
    if (id === "launchpad") {
      dispatch("launchpad");
      return;
    }
    if (id === "trash") return; // 占位：无操作

    if (openLabels.has(id)) {
      await invoke("wm_focus", { label: id });
    } else {
      await invoke("wm_open", { label: id });
    }
  }

  // ─── 放大镜效果 ────────────────────────────────────────────────────────────
  // 鼠标 X 坐标（视口坐标）
  let mouseX = $state(0);
  // Dock 容器 ref
  let dockEl = $state<HTMLElement | null>(null);

  function onMouseMove(e: MouseEvent) {
    mouseX = e.clientX;
  }

  // 计算每个图标的 scale：距离鼠标越近，scale 越大。
  // 判定复用 `lib/desktopLayout::dockIconScale`（已单测的纯函数）——这里**只**负责
  // 把 DOM 的实测坐标喂进去；先前那段把 1.3/80 的行内插值抄了第二遍，正是"两套实现
  // 各自漂移"的入口（REQ-A249 的纪律：几何决策只有一处实现）。
  const iconScales = $derived(() => {
    const el = dockEl;
    if (!el) return new Map<string, number>();
    const rect = el.getBoundingClientRect();
    const scaleMap = new Map<string, number>();
    visibleItems.forEach((item, index) => {
      // 每个图标占用的宽度：DOCK_ICON_SIZE + DOCK_ICON_GAP
      const iconLeft = rect.left + DOCK_SIDE_PADDING + index * (DOCK_ICON_SIZE + DOCK_ICON_GAP);
      const iconCenterX = iconLeft + DOCK_ICON_SIZE / 2;
      scaleMap.set(item.id, dockIconScale(mouseX, iconCenterX));
    });
    return scaleMap;
  });
</script>

<!--
  macOS Dock：
  - position: fixed bottom-0
  - 高度 76px，含顶部圆角 18px
  - 毛玻璃背景
  - 放大镜效果（CSS scale，JS 鼠标追踪）
  - 已打开 app 底部白点指示
  - 点击弹跳动画（active:scale）
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
    {#each visibleApps as item (item.id)}
      {@render dockItem(item)}
    {/each}

    {#each fixedLeading as item (item.id)}
      {@render dockItem(item)}
    {/each}

    <!-- 分隔线（用户 app + 启动台/Finder 与 废纸篓 之间） -->
    <div
      class="mb-3 ml-1 flex-shrink-0"
      data-testid="dock-separator"
      style="width:1px; height:48px; background:rgba(255,255,255,0.25); border-radius:1px;"
    ></div>

    {#each fixedTrailing as item (item.id)}
      {@render dockItem(item)}
    {/each}

    <!-- 装不下的用户 app：显式计数，不静默消失 -->
    {#if overflow > 0}
      <div class="flex flex-col items-center" data-testid="dock-overflow">
        <span
          class="flex items-center justify-center rounded-2xl bg-white/15 text-[13px] font-semibold text-white/85"
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
        <span class="mt-1 h-1 w-1"></span>
      </div>
    {/if}
  </div>
</div>

{#snippet dockItem(item: { id: string; icon: string; label: string })}
  {@const isOpen = openLabels.has(item.id)}
  {@const scale = iconScales().get(item.id) ?? 1.0}
  <div class="flex flex-col items-center">
    <button
      class="group flex items-center justify-center rounded-2xl bg-gradient-to-br from-neutral-700/90 to-neutral-900/90 shadow-xl transition-transform duration-100 active:scale-90"
      style="
        width:{DOCK_ICON_SIZE}px;
        height:{DOCK_ICON_SIZE}px;
        font-size:32px;
        transform: scale({scale});
        margin-bottom: {scale > 1.05 ? (scale - 1) * 16 : 0}px;
        border: 1px solid rgba(255,255,255,0.1);
      "
      aria-label={item.label}
      title={item.label}
      onclick={() => handleClick(item.id)}
    >
      {item.icon}
    </button>

    <!-- 运行中指示点（macOS 风格） -->
    {#if isOpen}
      <span class="mt-1 h-1 w-1 rounded-full bg-white shadow-sm"></span>
    {:else}
      <span class="mt-1 h-1 w-1"></span>
    {/if}
  </div>
{/snippet}
