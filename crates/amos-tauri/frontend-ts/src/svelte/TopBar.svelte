<script lang="ts">
  // TopBar.svelte — the macOS-style top bar, as a **container**.
  //
  // What changed and why: the bar used to hard-code its right-hand widgets (and
  // own their state: a second-ticker for the clock, a settings subscription and
  // `online` listeners for the radios, the battery placeholder). "Which widgets
  // exist, in what order" lived in this template, so every new indicator was an
  // edit here and every widget's test had to mount the whole bar.
  //
  // Now the bar owns only what a container should: the glass surface, the left-hand
  // group (Apple menu + focused app name + the main menu — macOS semantics rather
  // than independent widgets), the **slot layout**, and the chrome handle widgets
  // ask through (`SHELL_CHROME_API`). The widget list — ids, order, test ids — is
  // data in `./shellModules.ts`, and the widgets live in `./modules/` with their own
  // tests.
  //
  // Order on screen is unchanged (Launchpad, Spotlight, control centre, radios,
  // clock, battery); this is a restructuring, not a redesign.
  import { setContext } from "svelte";
  import { t } from "./locale.svelte";
  import { SHELL_CHROME_API, modulesFor, type ShellChromeApi } from "../lib/shellModule";
  import { CHROME_MENU_BUTTON, CHROME_TEXT, CHROME_TEXT_SHADOW } from "../lib/shellChrome";
  import { SHELL_MODULES } from "./shellModules";
  import { APP_FOCUSED_KEY } from "../lib/wm";
  import { createStoreValue } from "./store";

  // ─── The chrome handle the widgets ask through ───────────────────────────────
  // A small, explicit capability set — **not** the shell: a widget cannot reach
  // `shellState`, the layout snapshot or another widget through it. The two
  // overlays remain the shell's (DesktopShell) business, so the bar translates an
  // intent into the callback the shell handed it.
  //
  // The callbacks are **props** (`onlaunchpad` / `onspotlight`), not
  // `createEventDispatcher` events: this file is Svelte 5 with runes, and the
  // legacy `$on(...)` API is gone — a test (or another component) can no longer
  // subscribe to a dispatch, only pass a handler. Moving the two events to props
  // is what makes the container testable without `DesktopShell` around it.
  let {
    onlaunchpad,
    onspotlight,
  }: { onlaunchpad?: () => void; onspotlight?: () => void } = $props();

  setContext<ShellChromeApi>(SHELL_CHROME_API, {
    openLaunchpad: () => onlaunchpad?.(),
    openSpotlight: () => onspotlight?.(),
  });

  /** The right-hand slot, in registry order (`lib/shellModule.ts` sorts it). */
  const rightModules = modulesFor("topbar-right", SHELL_MODULES);

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

  // 显示名称
  const appDisplayName = $derived(
    focusedApp ? focusedApp.charAt(0).toUpperCase() + focusedApp.slice(1) : "Amos",
  );
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
  <!-- 左侧：Apple Logo + 当前 App 名 + 主菜单（macOS 语义，暂留容器内） -->
  <div class="flex items-center gap-4">
    <button
      aria-label={t("desktop.appleMenu")}
      title={t("desktop.appleMenu")}
      class="{CHROME_MENU_BUTTON} h-6 w-6 px-0"
      style="text-shadow: {CHROME_TEXT_SHADOW};"
    >🍎</button>

    <span class="{CHROME_TEXT} font-semibold" style="text-shadow: {CHROME_TEXT_SHADOW};"
      >{appDisplayName}</span
    >

    <!-- 主菜单（File / Edit / View / Window / Help）—— 名字必须走 i18n：
         这是产品界面文案，不是内部标识。 -->
    <nav class="ml-1 flex gap-1" aria-label={t("desktop.mainMenu")}>
      {#each MENU_KEYS as menuKey (menuKey)}
        <button class={CHROME_MENU_BUTTON} style="text-shadow: {CHROME_TEXT_SHADOW};"
          >{t(menuKey)}</button
        >
      {/each}
    </nav>
  </div>

  <!-- 右侧：注册表里的挂件（顺序见 shellModules.ts；此处只是槽位） -->
  <div class="flex items-center gap-3" data-testid="topbar-right-slot">
    {#each rightModules as mod (mod.id)}
      {@const Widget = mod.component}
      <Widget />
    {/each}
  </div>
</div>
