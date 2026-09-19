<script lang="ts">
  /**
   * DesktopAppWindow.svelte — the content of one **app window** on the desktop shell.
   *
   * REQ-A416. The defect this file exists to fix: every `wm_open(label)` builds a real
   * `WebviewWindow` at `index.html#window=<label>` (`crates/amos-tauri/src/wm.rs`),
   * `shell-entry.ts` reads that fragment and calls `open(label)` — and then
   * `Shell.svelte` rendered `DesktopShell` for **every** window whose form factor is
   * `desktop`, whatever the surface said. So on a PC every "app window" was a second
   * copy of the desktop (stage + Dock + menu bar): `docs/PC_DESKTOP_ARCHITECTURE.md`
   * §2.2 documents `app — 聚焦 app 窗口` and `shell.svelte.test.ts` described app
   * windows as "independent WebviewWindow instances", but nothing ever drew the app.
   * The launcher window (no fragment ⇒ surface `home`) keeps rendering `DesktopShell`;
   * a window that *addresses an app* now renders that app.
   *
   * Why a separate component and not the touch path's app surface: a macOS app window
   * has the **OS** title bar (`deviceChrome(desktop).titleBar === true`, and the host
   * asks for an overlay one), so the phone chrome that surface draws — StatusBar plus a
   * back button header — would be a phone screenshot pasted into a window. What is
   * shared is the *decision* (`svelteAppLoader` / `isExtId` / the honest
   * unavailable panel) and the `app-surface` testid, which `SettingsApp` uses to find
   * its scroll container.
   *
   * Honest boundary: the macOS traffic-light inset is not applied. `window_maximize`
   * and `title_bar_style(Overlay)` are already class-driven on the host, but the
   * ~28 px strip a real app leaves for the traffic lights is a **visual** decision that
   * needs a device to judge — inventing one here would be a number nobody measured.
   */
  /**
   * macOS Overlay 标题栏 — WebView 自绘的 28 px inset（REQ-G-α）。
   *
   * `title_bar_style(Overlay)` 由宿主在 `wm.rs` 设好（仅 desktop 形态，跨目标编译
   * 守卫见 FMEA F-WM-019）；Overlay 模式下原生 chrome **不再画**，但 NSWindow
   * 仍然把红绿灯放在屏幕左上角 —— 如果 WebView 内容顶到 0 px，红绿灯会被内容
   * 视觉吃掉。前端在这里画一个 28 px 的 header，让红绿灯有归属、标题有位置、
   * 窗口可拖（`<h1 draggable>` 仅标题可拖）。
   *
   * 红绿灯**不**接管点击 —— NSWindow 已经在管（`performClose:` /
   * `performMiniaturize:` / `zoom:`）。第一版纯装饰，避免与宿主冲突
   * （FMEA F-SH-001："装饰控件假装能做"同族）。
   *
   * 边界：双击 = 派 `wm_maximize(id)`，与 Window 菜单 Zoom 同源；
   * 红绿灯装饰属性、宿主失焦变灰等观感项登记为后续 PC。
   */
  import { onMount } from "svelte";
  import { svelteAppLoader } from "./appRegistry";
  import { appTitleKey, isKnownApp } from "../lib/appMeta";
  import { isExtId, midOf } from "../lib/storeApps";
  import { loadDesktopFeatures } from "../lib/desktopFeatures";
  import { t } from "./locale.svelte";
  import ExtAppHost from "./ExtAppHost.svelte";
  import DesktopWindowKeys from "./modules/DesktopWindowKeys.svelte";
  import { wmMaximize } from "../lib/wm";
  import { APP_WINDOW_TITLEBAR_HEIGHT, APP_WINDOW_TITLEBAR_INSET } from "../lib/desktopLayout";

  let { id }: { id: string } = $props();

  /**
   * REQ-A453 — the app window asks the host which capabilities the operator switched off.
   *
   * The defect this closes was measured on this machine (2026-09-19): the capability answer is
   * held **per WebView** (`lib/desktopFeatures.ts`'s module state), and only `DesktopShell`
   * asked for it. An app window renders `DesktopAppWindow` (REQ-A416), not `DesktopShell`, so
   * its WebView never asked ⇒ in **every** app window `isDesktopFeatureEnabled("shortcuts")`
   * stayed at its documented default (`on`) no matter what the operator set. Launched with
   * `AMOS_DESKTOP_SHORTCUTS=disabled`, the host logged
   * `desktop shell capabilities disabled by the environment disabled=["shortcuts"]`, and
   * pressing ⌘W in the Files window **still** closed it through this window's own chord
   * handler — i.e. the documented switch ("前端不抢键") could not take effect on the surfaces
   * the switch exists for. Same shape as the REQ-A416/REQ-A419 defect one level up: splitting
   * the shell into two surfaces moved a responsibility with it, and only the keys were carried
   * across, not the capability load.
   *
   * Each desktop shell surface asks at mount, exactly like `DesktopShell` does; the fetch is
   * single-flight, so a second caller costs nothing.
   *
   * Honest boundary (recorded, not hidden): the boot-time listener (`lib/earlySystemKeys.ts`,
   * installed by `shell-entry.ts` before anything mounts) still reads the "on" default in the
   * seconds before this component exists — the same window the launcher has had since REQ-A431.
   */
  onMount(() => {
    void loadDesktopFeatures();
  });

  // The same localized name the window title uses, so the two cannot disagree.
  const name = $derived(appTitleKey(id) ? t(appTitleKey(id)!) : id);

  // 双击标题栏 = 派 wm_maximize(id)（macOS 行为）。
  // 我们**不**用原生 dblclick —— 测试用 happy-dom 派 click 事件可移植且行为稳定；
  // 真实浏览器会把两次 click 在 300 ms 内合成 dblclick，但浏览器之间的"合成时机"
  // 不一致（Chromium ~500 ms，Safari ~300 ms），把契约收口在 JS 层就是一行定时器。
  let lastTitleClickTs = 0;
  function onTitleClick() {
    const now = Date.now();
    if (now - lastTitleClickTs < 300) {
      void wmMaximize(id);
      lastTitleClickTs = 0;
      return;
    }
    lastTitleClickTs = now;
  }
  // 键盘双击：Enter / Space 两次（< 300 ms）派同样的命令 —— 给键盘用户同样的能力。
  function onTitleKey(e: KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onTitleClick();
    }
  }

  // Lazy, cancellable load — the same shape `Shell.svelte`'s mounted effect uses
  // (`$state<any>` holding the *component*, so `<AppComp />` is the one dynamic-mount
  // form Svelte 5 accepts). The `alive` guard matters because a slow import must not
  // land after the window switched to another app.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let AppComp = $state<any>(null);
  $effect(() => {
    let alive = true;
    AppComp = null;
    const load = svelteAppLoader(id);
    if (!load) return;
    void load().then((m) => {
      if (alive) AppComp = m.default;
    });
    return () => {
      alive = false;
    };
  });
</script>

<!--
  `data-testid="app-surface"` is kept deliberately: `SettingsApp` looks up
  `[data-testid="app-surface"] .overflow-y-auto` to scroll a field into view, and that
  has to keep resolving inside a desktop window. `data-window-app` names the app the
  window is showing, which is what the tests assert on.
-->
<div
  class="flex h-full min-h-0 flex-col overflow-hidden bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100"
  data-testid="app-surface"
  data-window-app={id}
>
  <!-- G-α: macOS Overlay 标题栏（**可拖区** + 居中标题）。
       高度来自 APP_WINDOW_TITLEBAR_HEIGHT（lib/desktopLayout.ts 唯一真源）。
       双击空白区域派 wm_maximize（macOS 行为，与 Window 菜单 Zoom 同源）。
       用 role="button" + tabindex="0" 让 a11y 工具把它当成可激活元素 —— macOS
       顶栏的语义是"可拖区 + 双击最大化"，最接近的 ARIA 角色就是 button。

       REQ-A440 真机实测（2026-09-19，CGEvent 真鼠标拖 + TextEdit 对照）：
       • **这一条 28 px 是整个窗口唯一能让它移动的地方**，而 Tauri 的 overlay 窗口只在带
         `data-tauri-drag-region` 的元素上按下才开始拖窗口 —— 本仓此前**一处都没有**该属性，
         于是应用窗口**根本拖不动**（拖 24 步后位置仍是 236,69；同一工具拖 TextEdit
         208,126 → 328,196，证明工具本身可用）。原来的 `draggable="true"` 只是 HTML 的
         **内容**拖拽，与移动窗口无关（那句注释是错的，已删）。
       • **不再自绘红绿灯**：AppKit 在 Overlay 模式下把真正的红绿灯画在同一条带上（与内容
         重叠，与自绘的三个圆点叠成双影；自绘那组永远点不到）。左侧改为等宽留白
         （`APP_WINDOW_TITLEBAR_INSET`），真红绿灯正好落在留白里。
       • 拖区必须逐元素标：Tauri 判的是**事件目标**自己有没有该属性，子元素不会继承 ——
         所以标题与两侧留白各自都带它。 -->
  <div
    role="button"
    tabindex="0"
    aria-label={name}
    class="grid shrink-0 select-none items-center border-b border-black/5 dark:border-white/5"
    style="height: {APP_WINDOW_TITLEBAR_HEIGHT}px; grid-template-columns: {APP_WINDOW_TITLEBAR_INSET}px 1fr {APP_WINDOW_TITLEBAR_INSET}px;"
    data-testid="app-window-titlebar"
    data-window-titlebar-height={APP_WINDOW_TITLEBAR_HEIGHT}
    data-tauri-drag-region
    onclick={onTitleClick}
    onkeydown={onTitleKey}
  >
    <!-- 系统红绿灯的留白（NSWindow 画，见文件头的实测）。 -->
    <div
      class="h-full"
      aria-hidden="true"
      data-testid="app-window-titlebar-inset"
      data-tauri-drag-region
    ></div>

    <!-- 居中标题：与 wmSetShellTitle(name) 同源 —— 名字只有一份。 -->
    <h1
      class="truncate justify-self-center text-[12px] font-semibold text-neutral-700 dark:text-neutral-200"
      data-testid="app-window-title"
      data-tauri-drag-region
    >
      {name}
    </h1>

    <!-- 右侧等宽留白：让标题真正居中（未来放窗口动作）—— 也是拖区。 -->
    <div
      class="h-full"
      aria-hidden="true"
      data-testid="app-window-titlebar-trailing"
      data-tauri-drag-region
    ></div>
  </div>

  <!-- REQ-A419: an app window still owns ⌘W / ⌘M / ⌘H / ⌘, for **itself** — macOS closes
       the window you are in. The launcher's `DesktopShell` is not mounted here (that was the
       whole point of REQ-A416), so the keys come from this listener. -->
  <DesktopWindowKeys label={id} />
  <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain">
    {#key id}
      {#if isExtId(id)}
        <!-- A store-installed app runs its own bundle at its own origin (see ExtAppHost). -->
        <ExtAppHost mid={midOf(id)} {name} />
      {:else if AppComp}
        <AppComp />
      {:else}
        <!-- An id with no screen in this build (a built-in the loader dropped for this
             form factor, e.g. `phone` on desktop, or an unknown id from a link): never a
             blank frame, and never a fabricated app. Same wording the touch shell uses. -->
        <div class="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
          <span class="text-3xl" aria-hidden="true">❓</span>
          <p class="text-sm font-semibold">{name}</p>
          <p class="text-xs opacity-60">
            {isKnownApp(id) ? t("app.screenMissing", { id }) : t("app.unknown", { id })}
          </p>
        </div>
      {/if}
    {/key}
  </div>
</div>
