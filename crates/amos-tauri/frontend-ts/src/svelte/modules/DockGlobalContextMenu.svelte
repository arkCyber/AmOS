<script lang="ts">
  /**
   * DockGlobalContextMenu.svelte — macOS 风格的 Dock 全局配置右键菜单。
   *
   * macOS Dock 上**右键空白区域** → 弹出全局配置菜单，包括：
   *   • 位置选择（底部/左侧/右侧）
   *   • 自动隐藏开关
   *   • 放大效果调整（±0.1x）
   *   • 图标大小调整（±4px）
   *   • 打开"程序坞偏好设置"入口
   *
   * 这遵循 macOS 的 UX 模式：快速调整常用配置 + "更多选项..." 入口。
   * 
   * A11y 特性：
   *   • 自动焦点管理（打开时聚焦第一个菜单项）
   *   • 键盘导航（Arrow keys, Home/End）
   *   • Escape 关闭（由 Dock.svelte 处理）
   */
  import { t } from "../locale.svelte";
  import { installMenuKeyboard } from "../../lib/menuKeys";
  import {
    CHROME_MENU_ITEM,
    CHROME_MENU_PANEL,
    CHROME_MENU_PANEL_STYLE,
    CHROME_MENU_SEPARATOR,
  } from "../../lib/shellChrome";
  import type { DockPrefs, DockPosition } from "../../lib/dockPrefs";

  let {
    prefs,
    x,
    y,
    onclose,
    onPositionChange,
    onAutoHideToggle,
    onMagnificationChange,
    onIconSizeChange,
    onOpenPreferences,
  }: {
    prefs: DockPrefs;
    x: number;
    y: number;
    onclose?: () => void;
    onPositionChange?: (position: DockPosition) => void;
    onAutoHideToggle?: () => void;
    onMagnificationChange?: (delta: number) => void;
    onIconSizeChange?: (delta: number) => void;
    onOpenPreferences?: () => void;
  } = $props();

  let menuEl: HTMLDivElement | undefined = $state();

  // REQ-A436: the keyboard rules live in `lib/menuKeys.ts` — one owner for every pop-up menu.
  // This component used to carry its own copy (a `menuItems` array + `currentFocusIndex` +
  // a switch over the four keys) while the other Dock menus had none at all: the same rule in
  // one place and missing in two others (the F-SH-005 shape). The shared layer also skips
  // `aria-disabled` rows and claims Escape for *this* menu's closer.
  $effect(() => {
    if (!menuEl) return;
    return installMenuKeyboard(menuEl, { onClose: () => onclose?.() });
  });

  function handlePositionChange(position: DockPosition) {
    onclose?.();
    onPositionChange?.(position);
  }

  function handleAutoHideToggle() {
    onclose?.();
    onAutoHideToggle?.();
  }

  function handleMagnificationIncrease() {
    onclose?.();
    onMagnificationChange?.(0.1);
  }

  function handleMagnificationDecrease() {
    onclose?.();
    onMagnificationChange?.(-0.1);
  }

  function handleIconSizeIncrease() {
    onclose?.();
    onIconSizeChange?.(4);
  }

  function handleIconSizeDecrease() {
    onclose?.();
    onIconSizeChange?.(-4);
  }

  function handleOpenPreferences() {
    onclose?.();
    onOpenPreferences?.();
  }
</script>

<!--
  macOS 风格的 Dock 全局配置菜单：
  - 玻璃质感（与 Dock 一致）
  - 分组显示配置选项
  - 支持快速切换和调整
  - 键盘导航（Arrow keys, Home/End）
-->
<div
  bind:this={menuEl}
  class="fixed z-[200] {CHROME_MENU_PANEL}"
  style="
    left:{x}px;
    top:{y}px;
    {CHROME_MENU_PANEL_STYLE}
  "
  role="menu"
  tabindex="-1"
  aria-label={t("desktop.dockGlobalCtxDockPrefs")}
  data-testid="dock-global-context-menu"
>
  <!-- 位置 -->
  <div class="px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
    {t("desktop.dockGlobalCtxPosition")}
  </div>
  
  <button
    type="button"
    role="menuitemradio"
    class={CHROME_MENU_ITEM}
    aria-checked={prefs.position === "bottom"}
    onclick={() => handlePositionChange("bottom")}
    data-testid="dock-global-ctx-position-bottom"
  >
    <span class="mr-2">{prefs.position === "bottom" ? "✓" : "  "}</span>
    {t("desktop.dockGlobalCtxPositionBottom")}
  </button>
  
  <button
    type="button"
    role="menuitemradio"
    class={CHROME_MENU_ITEM}
    aria-checked={prefs.position === "left"}
    onclick={() => handlePositionChange("left")}
    data-testid="dock-global-ctx-position-left"
  >
    <span class="mr-2">{prefs.position === "left" ? "✓" : "  "}</span>
    {t("desktop.dockGlobalCtxPositionLeft")}
  </button>
  
  <button
    type="button"
    role="menuitemradio"
    class={CHROME_MENU_ITEM}
    aria-checked={prefs.position === "right"}
    onclick={() => handlePositionChange("right")}
    data-testid="dock-global-ctx-position-right"
  >
    <span class="mr-2">{prefs.position === "right" ? "✓" : "  "}</span>
    {t("desktop.dockGlobalCtxPositionRight")}
  </button>

  <div class={CHROME_MENU_SEPARATOR} role="presentation"></div>

  <!-- 自动隐藏 -->
  <button
    type="button"
    role="menuitemcheckbox"
    class={CHROME_MENU_ITEM}
    aria-checked={prefs.autoHide}
    onclick={handleAutoHideToggle}
    data-testid="dock-global-ctx-autohide"
  >
    <span class="mr-2">{prefs.autoHide ? "✓" : "  "}</span>
    {t("desktop.dockGlobalCtxAutoHide")}
  </button>

  <div class={CHROME_MENU_SEPARATOR} role="presentation"></div>

  <!-- 放大效果 -->
  <div class="px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
    {t("desktop.dockGlobalCtxMagnification")} ({prefs.magnification.toFixed(1)}x)
  </div>
  
  <button
    type="button"
    role="menuitem"
    class="{CHROME_MENU_ITEM} {prefs.magnification >= 2.0 ? 'opacity-40 cursor-not-allowed' : ''}"
    onclick={handleMagnificationIncrease}
    disabled={prefs.magnification >= 2.0}
    aria-disabled={prefs.magnification >= 2.0 ? "true" : undefined}
    data-testid="dock-global-ctx-mag-increase"
  >
    <span class="mr-2">+</span>
    {t("desktop.dockGlobalCtxMagnificationIncrease")}
  </button>
  
  <button
    type="button"
    role="menuitem"
    class="{CHROME_MENU_ITEM} {prefs.magnification <= 1.0 ? 'opacity-40 cursor-not-allowed' : ''}"
    onclick={handleMagnificationDecrease}
    disabled={prefs.magnification <= 1.0}
    aria-disabled={prefs.magnification <= 1.0 ? "true" : undefined}
    data-testid="dock-global-ctx-mag-decrease"
  >
    <span class="mr-2">−</span>
    {t("desktop.dockGlobalCtxMagnificationDecrease")}
  </button>

  <div class={CHROME_MENU_SEPARATOR} role="presentation"></div>

  <!-- 图标大小 -->
  <div class="px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
    {t("desktop.dockGlobalCtxIconSize")} ({prefs.iconSize}px)
  </div>
  
  <button
    type="button"
    role="menuitem"
    class="{CHROME_MENU_ITEM} {prefs.iconSize >= 64 ? 'opacity-40 cursor-not-allowed' : ''}"
    onclick={handleIconSizeIncrease}
    disabled={prefs.iconSize >= 64}
    aria-disabled={prefs.iconSize >= 64 ? "true" : undefined}
    data-testid="dock-global-ctx-size-increase"
  >
    <span class="mr-2">+</span>
    {t("desktop.dockGlobalCtxIconSizeIncrease")}
  </button>
  
  <button
    type="button"
    role="menuitem"
    class="{CHROME_MENU_ITEM} {prefs.iconSize <= 32 ? 'opacity-40 cursor-not-allowed' : ''}"
    onclick={handleIconSizeDecrease}
    disabled={prefs.iconSize <= 32}
    aria-disabled={prefs.iconSize <= 32 ? "true" : undefined}
    data-testid="dock-global-ctx-size-decrease"
  >
    <span class="mr-2">−</span>
    {t("desktop.dockGlobalCtxIconSizeDecrease")}
  </button>

  <div class={CHROME_MENU_SEPARATOR} role="presentation"></div>

  <!-- 打开偏好设置 -->
  <button
    type="button"
    role="menuitem"
    class={CHROME_MENU_ITEM}
    onclick={handleOpenPreferences}
    data-testid="dock-global-ctx-open-prefs"
  >
    {t("desktop.dockGlobalCtxDockPrefs")}
  </button>
</div>
