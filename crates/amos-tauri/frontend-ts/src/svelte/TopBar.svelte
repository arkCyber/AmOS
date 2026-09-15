<script lang="ts">
  // TopBar.svelte — macOS 风格顶部菜单栏。
  //
  // 渲染在 DesktopShell 内（DesktopShell → TopBar + Dock + 舞台）。
  // 高度 28px（含刘海区占位 12px），毛玻璃背景。
  // 左侧：Apple Logo + 当前 App 名 + 主菜单占位（File/Edit/View/Window/Help）。
  // 右侧：Spotlight + 控制中心 + 时钟 + WiFi + 电池。
  //
  // 焦点 app 状态来自 SharedStore（`amos.app_focused`），由 wm.rs 在
  // FocusChanged 事件时写入（跨窗口同步）。
  import { createEventDispatcher } from "svelte";
  import { t } from "./locale.svelte";
  import { fmtClock } from "../lib/time";
  import { batterySvg, iconSvg, radioIcon } from "../lib/sysIcons";
  import { firstBattery, batteryTone } from "../lib/batteryStatus";
  import { statusIcons } from "../lib/netStatus";
  import { SETTINGS_KEY, normalizeQuick } from "../lib/settings";
  import { APP_FOCUSED_KEY } from "../lib/wm";
  import { createStoreValue } from "./store";

  const dispatch = createEventDispatcher<{ spotlight: void; launchpad: void }>();

  // ─── 焦点 App 状态（来自 SharedStore）─────────────────────────────────────────
  // 键名从 `lib/wm.ts` 导入（与 Rust `store.rs::APP_FOCUSED_KEY` 同名）：不在这里
  // 再拼一遍字面量——`scripts/store-scan.mjs` 挡的正是"同一个键两处拼写"那类漂移。

  /** 顶栏主菜单的**唯一**真源：key 顺序即显示顺序（`t()` 负责语言）。 */
  const MENU_KEYS = [
    "desktop.menu.file",
    "desktop.menu.edit",
    "desktop.menu.view",
    "desktop.menu.window",
    "desktop.menu.help",
  ] as const;
  const focusedStore = createStoreValue<string>(APP_FOCUSED_KEY, "");
  let focusedApp = $state("");

  // 订阅 store（跨窗口同步：wm.rs 写，TopBar 读）
  $effect(() => {
    const un = focusedStore.subscribe((v) => (focusedApp = v ?? ""));
    return un;
  });

  // ─── 时钟 ──────────────────────────────────────────────────────────────────
  let now = $state(new Date());
  $effect(() => {
    const id = setInterval(() => (now = new Date()), 1000);
    return () => clearInterval(id);
  });

  // ─── 电池 / 网络 ────────────────────────────────────────────────────────────
  const settingsStore = createStoreValue<unknown>(SETTINGS_KEY, {});
  let quickRaw = $state<unknown>({});
  let online = $state(typeof navigator !== "undefined" ? navigator.onLine : true);

  $effect(() => {
    const un = settingsStore.subscribe((v) => (quickRaw = v));
    return un;
  });
  $effect(() => {
    const on = () => (online = true);
    const off = () => (online = false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  });

  const quick = $derived(normalizeQuick(quickRaw));
  const icons = $derived(statusIcons(quick, online, typeof quick.wifi === 'string' ? quick.wifi : null));
  // batt 占位：桌面形态下从顶层 daemon 读取 system_health（Phase 2 实测接入）。
  const batt = $derived(firstBattery([{ levelPct: null, charging: null }]));
  const battTone = $derived(batteryTone(batt));
  const battText = $derived(batt.levelPct === null ? "—" : `${Math.round(batt.levelPct)}%`);

  // 显示名称
  const appDisplayName = $derived(
    focusedApp ? focusedApp.charAt(0).toUpperCase() + focusedApp.slice(1) : "Amos",
  );

  // 辅助函数：规范化 title 为字符串（i18n key 可能返回 undefined）
  function titleOrUndef(s: unknown): string | undefined {
    return typeof s === "string" ? s : undefined;
  }
</script>

<!--
  macOS 顶栏：
  - 高度 40px（28 内容 + 12 刘海区占位）
  - 毛玻璃背景（backdrop-filter: blur）
  - 字体：SF Pro（-apple-system fallback）
-->
<div
  aria-label={t("desktop.topbar")}
  class="relative flex h-10 w-full select-none items-center justify-between px-4"
  style="
    background: rgba(30, 30, 30, 0.72);
    backdrop-filter: blur(20px) saturate(180%);
    -webkit-backdrop-filter: blur(20px) saturate(180%);
    border-bottom: 1px solid rgba(255,255,255,0.08);
  "
>
  <!-- 左侧：Apple Logo + 当前 App 名 + 主菜单占位 -->
  <div class="flex items-center gap-4">
    <!-- Apple Logo -->
    <button
      aria-label={t("desktop.appleMenu")}
      title={t("desktop.appleMenu")}
      class="flex h-6 w-6 items-center justify-center text-[15px] text-white/90 transition-colors hover:text-white"
      style="text-shadow: 0 1px 2px rgba(0,0,0,0.3);"
    >🍎</button>

    <!-- 当前 App 名（焦点 app） -->
    <span class="text-[13px] font-semibold text-white" style="text-shadow: 0 1px 2px rgba(0,0,0,0.3);">{appDisplayName}</span>

    <!-- 主菜单占位（File / Edit / View / Window / Help）—— 名字必须走 i18n：
         这是产品界面文案，不是内部标识。 -->
    <nav class="ml-1 flex gap-1" aria-label={t("desktop.mainMenu")}>
      {#each MENU_KEYS as menuKey (menuKey)}
        <button
          class="rounded px-2 py-0.5 text-[12px] text-white/80 transition-colors hover:bg-white/10 hover:text-white"
          style="text-shadow: 0 1px 2px rgba(0,0,0,0.3);"
        >{t(menuKey)}</button>
      {/each}
    </nav>
  </div>

  <!-- 右侧：Spotlight + Launchpad + 控制中心 + 时间 + WiFi + 电池 -->
  <div class="flex items-center gap-3">
    <!-- Launchpad 图标 -->
    <button
      aria-label={t("desktop.launchpad")}
      title={t("desktop.launchpad")}
      onclick={() => dispatch("launchpad")}
      class="flex h-5 w-5 items-center justify-center text-[12px] text-white/60 transition-colors hover:text-white/90"
      style="text-shadow: 0 1px 2px rgba(0,0,0,0.3);"
    >🚀</button>

    <!-- Spotlight 图标 -->
    <button
      aria-label={t("desktop.spotlight")}
      title={t("desktop.spotlight")}
      onclick={() => dispatch("spotlight")}
      class="flex h-5 w-5 items-center justify-center text-[12px] text-white/60 transition-colors hover:text-white/90"
      style="text-shadow: 0 1px 2px rgba(0,0,0,0.3);"
    >🔍</button>

    <!-- 控制中心图标 -->
    <button
      aria-label={t("desktop.controlCenter")}
      class="flex h-5 w-5 items-center justify-center text-[12px] text-white/60 transition-colors hover:text-white/90"
      style="text-shadow: 0 1px 2px rgba(0,0,0,0.3);"
    >⚙️</button>

    <!-- WiFi / 网络图标 -->
    {#each icons as ic (ic.kind)}
      <span
        title={titleOrUndef(ic.titleKey ? t(ic.titleKey, ic.titleSsid ? { ssid: ic.titleSsid } : undefined) : undefined)}
        class="text-[11px] transition-opacity {ic.on ? 'text-white/90' : 'text-white/30'}"
        style="text-shadow: 0 1px 2px rgba(0,0,0,0.3);"
      >{@html iconSvg(radioIcon(ic.kind), "")}</span>
    {/each}

    <!-- 时钟 -->
    <span
      class="text-[12px] tabular-nums font-medium text-white"
      style="text-shadow: 0 1px 2px rgba(0,0,0,0.3);"
    >{fmtClock(now)}</span>

    <!-- 电池 -->
    <span
      aria-label={t("a11y.batteryLevel")}
      title={titleOrUndef(batt.levelPct === null ? undefined : t(batt.charging === true ? "a11y.batteryCharging" : "a11y.battery", { pct: battText }))}
      class="flex items-center gap-0.5 text-[11px] tabular-nums text-white"
      style="text-shadow: 0 1px 2px rgba(0,0,0,0.3);"
    >
      {@html batterySvg(batt.levelPct === null ? 0 : batt.levelPct, "h-3 w-3", battTone)}
      <span>{battText}</span>
    </span>
  </div>
</div>
