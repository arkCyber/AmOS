<script lang="ts">
  // DesktopStage.svelte — macOS 桌面形态中间舞台。
  //
  // 渲染 DesktopShell 的"中间区域"（顶栏之下、Dock 之上）：
  //   - Backdrop（壁纸，由用户配置 / 系统主题决定）
  //   - 桌面图标网格（用户 home layout 的 `page` 项 + 桌面专用快捷入口）
  //   - 时钟 / 日期小部件（右上角，macOS 桌面传统）
  //   - 右键菜单（New Folder / Change Wallpaper / Display Settings）
  //
  // 数据流：
  //   - 壁纸：`SharedStore.settings.wallpaper/background`（与手机形态共用 Backdrop）
  //   - 桌面图标：`SharedStore.home.layout.page` + 桌面专用 `desktop-shortcuts`
  //   - 时钟：本地 `setInterval(1s)`，仅显示用
  //
  // Power of 10 #2：所有几何由 lib/desktopLayout.ts 提供；纯函数决策。
  import { onMount } from "svelte";
  import { invoke } from "../lib/backend";
  import { APP_META, appIcon, appTitleKey } from "../lib/appMeta";
  import {
    LAYOUT_KEY,
    type HomeLayout,
    getLayout,
  } from "../lib/amosStore";
  import { withoutPhone } from "../lib/phoneApps";
  import { createStoreValue } from "./store";
  import { t } from "./locale.svelte";
  import Backdrop from "./Backdrop.svelte";
  import AppIcon from "./AppIcon.svelte";

  // ─── 桌面图标 ───────────────────────────────────────────────────────────────
  // 桌面形态下，桌面图标 = 用户的 home layout page 项（与手机主屏图标一致）。
  // 这样用户编辑 home 时，桌面图标会跟着变化（符合 macOS 行为）。
  const layoutStore = createStoreValue<HomeLayout>(LAYOUT_KEY, getLayout(APP_META.map((a) => a.id)));
  let layout = $state<HomeLayout>(getLayout(APP_META.map((a) => a.id)));
  $effect(() => {
    const un = layoutStore.subscribe((v) => {
      if (v && v.page) layout = v;
    });
    return un;
  });
  // 桌面只显示前 16 个图标（4×4 网格），多于 16 个的通过 Launchpad 访问。
  // 电话类 app（有 SIM / 蜂窝需求）在桌面形态下不出现。
  const DESKTOP_ICON_LIMIT = 16;
  const desktopIcons = $derived(withoutPhone(layout.page).slice(0, DESKTOP_ICON_LIMIT));

  // ─── 时钟 ──────────────────────────────────────────────────────────────────
  let now = $state(new Date());
  $effect(() => {
    const id = setInterval(() => (now = new Date()), 1000);
    return () => clearInterval(id);
  });
  const dayLabel = $derived(
    now.toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
    }),
  );
  const clockLabel = $derived(
    `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`,
  );

  // Settings store is available for future per-wallpaper context-menu actions.
  // Currently "Change Wallpaper" opens the Settings app directly; no wallpaper data needed here.

  // ─── 桌面点击 / 双击 ───────────────────────────────────────────────────────
  let lastClick = $state<{ id: string; at: number } | null>(null);

  async function openApp(id: string) {
    const at = Date.now();
    if (lastClick && lastClick.id === id && at - lastClick.at < 350) {
      // 双击启动
      lastClick = null;
      await invoke("wm_open", { label: id });
    } else {
      lastClick = { id, at };
    }
  }

  // ─── 右键菜单 ──────────────────────────────────────────────────────────────
  type MenuItem = { id: string; label: string; action: () => void | Promise<void>; separator?: undefined } | { id: string; separator: true; label?: undefined; action?: undefined };
  let ctxMenu = $state<{ x: number; y: number; items: MenuItem[] } | null>(null);

  function showContextMenu(x: number, y: number) {
    ctxMenu = {
      x,
      y,
      items: [
        { id: "new-folder", label: t("desktop.ctxNewFolder"), action: handleNewFolder },
        { id: "change-wallpaper", label: t("desktop.ctxChangeWallpaper"), action: handleChangeWallpaper },
        { id: "display-settings", label: t("desktop.ctxDisplaySettings"), action: handleDisplaySettings },
        { id: "sep1", label: "" as never, separator: true as const, action: undefined as never },
        { id: "open-launchpad", label: t("desktop.ctxOpenLaunchpad"), action: handleOpenLaunchpad },
      ],
    };
  }

  function closeContextMenu() {
    ctxMenu = null;
  }

  async function handleNewFolder() {
    // 桌面形态下"新建文件夹"——目前为占位：通过通知 store 推送一条占位消息。
    // TODO: 接入真实文件系统操作。
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("desktop:placeholder", {
        detail: { kind: "newFolder", at: Date.now() },
      }));
    }
    closeContextMenu();
  }

  async function handleChangeWallpaper() {
    // 打开设置应用（壁纸在设置中可改）。
    await invoke("wm_open", { label: "settings" });
    closeContextMenu();
  }

  async function handleDisplaySettings() {
    await invoke("wm_open", { label: "settings" });
    closeContextMenu();
  }

  async function handleOpenLaunchpad() {
    // 通过 window-level 自定义事件通知 DesktopShell。
    window.dispatchEvent(new CustomEvent("desktop:open-launchpad"));
    closeContextMenu();
  }

  function onContextMenu(e: MouseEvent) {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY);
  }

  function onDocumentClick(e: MouseEvent) {
    if (!ctxMenu) return;
    const target = e.target as Node | null;
    if (target && menuEl && !menuEl.contains(target)) closeContextMenu();
  }

  let menuEl = $state<HTMLDivElement | null>(null);

  onMount(() => {
    document.addEventListener("click", onDocumentClick);
    return () => document.removeEventListener("click", onDocumentClick);
  });
</script>

<!--
  桌面舞台：
  - 100% × 100%（父容器定位后铺满）
  - 壁纸（Backdrop）作为底
  - 时钟小部件（右上角）
  - 桌面图标网格（左上 4×4）
  - 右键菜单（绝对定位浮层）
-->
<div
  class="absolute inset-0 select-none"
  oncontextmenu={onContextMenu}
  role="presentation"
  aria-label={t("desktop.stage")}
>
  <!-- 壁纸 -->
  <Backdrop />

  <!-- 时钟小部件（macOS 桌面传统右上角位置） -->
  <div
    class="pointer-events-none absolute right-6 top-6 text-right"
    style="text-shadow: 0 2px 12px rgba(0,0,0,0.5);"
  >
    <div class="text-[64px] font-thin leading-none text-white" style="font-variant-numeric: tabular-nums;">
      {clockLabel}
    </div>
    <div class="mt-1 text-[14px] font-medium text-white/85">
      {dayLabel}
    </div>
  </div>

  <!-- 桌面图标网格（4 列，每列 4 个） -->
  <div
    class="absolute left-8 top-8 grid grid-cols-4 gap-x-6 gap-y-5"
    style="width: calc(4 * 80px + 3 * 24px);"
  >
    {#each desktopIcons as id (id)}
      <button
        class="group flex flex-col items-center gap-1.5 outline-none"
        aria-label={appTitleKey(id) ? t(appTitleKey(id)!) : id}
        title={appTitleKey(id) ? t(appTitleKey(id)!) : id}
        onclick={() => openApp(id)}
      >
        <AppIcon
          {id}
          icon={appIcon(id)}
          tileClassName="h-20 w-20 rounded-[24px] group-hover:-translate-y-0.5 group-active:scale-90 transition-transform"
          glyphClassName="text-[3.2rem]"
        />
        <span
          class="max-w-[80px] truncate text-center text-[11px] font-medium text-white/90"
          style="text-shadow: 0 1px 3px rgba(0,0,0,0.6);"
        >
          {appTitleKey(id) ? t(appTitleKey(id)!) : id}
        </span>
      </button>
    {/each}

    {#if desktopIcons.length === 0}
      <div class="col-span-4 py-8 text-center text-[12px] text-white/40" style="text-shadow: 0 1px 3px rgba(0,0,0,0.6);">
        {t("desktop.emptyDesktop")}
      </div>
    {/if}
  </div>

  <!-- 右键菜单浮层 -->
  {#if ctxMenu}
    <div
      bind:this={menuEl}
      class="fixed z-[200] min-w-[200px] rounded-lg py-1 shadow-2xl"
      style="
        left:{ctxMenu.x}px;
        top:{ctxMenu.y}px;
        background: rgba(40, 40, 40, 0.92);
        backdrop-filter: blur(20px) saturate(180%);
        -webkit-backdrop-filter: blur(20px) saturate(180%);
        border: 1px solid rgba(255,255,255,0.08);
      "
      role="menu"
      aria-label={t("desktop.contextMenu")}
    >
      {#each ctxMenu.items as item (item.id)}
        {#if "separator" in item && item.separator}
          <div class="my-1 h-px bg-white/10"></div>
        {:else}
          <button
            class="block w-full px-4 py-1.5 text-left text-[13px] text-white/85 transition-colors hover:bg-blue-500/70 hover:text-white"
            role="menuitem"
            onclick={() => item.action()}
          >
            {(item as { label: string }).label}
          </button>
        {/if}
      {/each}
    </div>
  {/if}
</div>
