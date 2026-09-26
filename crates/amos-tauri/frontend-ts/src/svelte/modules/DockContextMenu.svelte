<script lang="ts">
  /**
   * DockContextMenu.svelte — macOS 风格的 Dock 项右键菜单。
   *
   * macOS Dock 上**右键**一个 app 图标 → 弹出菜单，菜单里有：
   *   • 「显示 / 隐藏」（对应宿主 `wm_focus` / `wm_hide`）
   *   • 「退出」（对应宿主 `wm_close`）
   *   • 「选项 ›」子菜单入口（先登记：dock 选项菜单需要 per-app 配置，宿主尚无此能力）
   *
   * 这是 `DesktopStage.svelte` 里那个**右键菜单**的同形状实现——按 `lib/shellChrome.ts`
   * 那套"做不到 = 灰项 + 名字说明原因"的纪律：能做的就让它真做，做不到的就老实说。
   *
   * 数据契约：
   *   • `label`    — 窗口标签（用作 `wm_close` / `wm_hide` 的参数）
   *   • `running`  — 当前是否打开（不在 Dock 上时 `running=false`，隐藏与关闭都灰掉）
   *   • `x` / `y`  — 鼠标坐标（视口）
   *   • `onclose`  — 父级关闭这个菜单
   *
   * `onclose` 由 props 传进来（不是 `createEventDispatcher`），所以这个面板可以脱离
   * Dock 容器独立挂载/测试——和 `Launchpad` / `MissionControl` 是同一条规则（REQ-A262）。
   *
   * **Prop-read ordering**：每个菜单动作都是 `async`，而 `onclose?.()` 是同步的，会
   * 立即把父级的 `{#if}` 关掉并卸载本组件。在 Svelte 5 中，已卸载组件的 `$props`
   * getter 读取会抛 `Cannot read properties of null (reading 'label')`，所以这里
   * 把 `label` 立刻读到局部 `targetLabel` 再调用 `onclose()`——这是闭包捕获，不是
   * "复制一个字符串"。这一处缺陷本轮才出现：先前的 stage 右键菜单没有跨过 await。
   */
  import {
    wmCloseWithDiag,
    wmHideWithDiag,
    wmFocusWithDiag,
    wmNewWindowWithDiag,
    wmOpenWithDiag,
  } from "../../lib/wm";
  import type { BridgeDiag } from "../../lib/backend";
  import { appOfWindowLabel } from "../../lib/windowRoute";
  import { t } from "../locale.svelte";
  import { installMenuKeyboard } from "../../lib/menuKeys";
  import {
    CHROME_MENU_ITEM,
    CHROME_MENU_PANEL,
    CHROME_MENU_PANEL_STYLE,
    CHROME_MENU_SEPARATOR,
  } from "../../lib/shellChrome";
  import { placeMenuAt } from "../../lib/menuPlacement";
  import { desktopShortcutLabel } from "../../lib/desktopKeys";
  import { createKeyboardBindings } from "../../lib/keyboardConfigHook.svelte";

  let {
    label,
    running,
    x,
    y,
    onclose,
  }: {
    label: string;
    running: boolean;
    x: number;
    y: number;
    onclose?: () => void;
  } = $props();

  // REQ-A297 phase-2 §4 (typed-error discipline): `invoke` swallows
  // rejections into `null`. The pre-fix code wrapped every `wm_close` /
  // `wm_hide` / `wm_focus` in `try { ... } catch {}` — all of them were
  // dead code (the catch could never fire). The user would close the
  // context menu and see the dock app do nothing, with no breadcrumb
  // and no way to retry. We now branch on the null result and write a
  // diagnostic via `bridgeDiag(command)` plus a `console.warn` so the
  // failure is visible in the launcher log.
  const WARN_ICON = "🛟";
  function noteFailure(command: string, targetLabel: string, context: string, diag: BridgeDiag) {
    if (diag.ok) return; // invariant: null result implies diag is not ok
    const code =
      diag.kind === "command-failed" &&
      diag.detail &&
      typeof diag.detail === "object"
        ? (diag.detail as { code?: string }).code
        : undefined;
    console.warn(
      `${WARN_ICON} [Dock menu] ${context} — ${command}(${targetLabel}) refused`,
      code ?? diag.kind,
    );
  }

  /** REQ-A436: the shared keyboard layer (arrows / Home / End / Escape) — see `lib/menuKeys`. */
  let menuEl: HTMLDivElement | undefined = $state();
  $effect(() => {
    if (!menuEl) return;
    return installMenuKeyboard(menuEl, { onClose: () => onclose?.() });
  });

  /**
   * The keycap each row may legitimately advertise (REQ-A484).
   *
   * macOS writes the key equivalent at the right edge of every Dock menu row, and this menu showed
   * none of them while the *top-bar* menu showed them for the same actions. The rule for showing
   * one is this repository's (REQ-A342): **a row may only advertise a binding that the shell really
   * has**, read from the user's merged bindings (a rebound or disabled key changes what is printed,
   * and a disabled one prints nothing).
   *
   * Exactly two rows qualify, and the others do not for stated reasons:
   *   * **新建窗口** ⇒ `new-window` (⌘N): the row calls `wm_new_window(app)`, which is what ⌘N does
   *     for the focused app — the same action, so the same keycap.
   *   * **隐藏** ⇒ `hide-app` (⌘H): the row calls `wm_hide(label)`; macOS's own Dock menu writes ⌘H
   *     here for the same reason (the chord acts on the frontmost app, the row on the clicked one —
   *     which is precisely how macOS behaves for a non-frontmost tile).
   *   * **打开 / 显示** — no chord exists for "open this app" or "focus this app's window": there is
   *     nothing to advertise, and inventing one would be the dead-chord shape this shell refuses.
   *   * **退出** ⇒ *nothing*: macOS writes ⌘Q (quit the whole app) and this shell does not bind it;
   *     the nearest chord, ⌘W, closes the **focused** window, which is a different action from
   *     closing *this* app's window. Printing ⌘W here would promise something the key does not do.
   *   * **选项…** — the row is a disabled placeholder (F-SH-001), so it advertises nothing.
   *
   * Read through the same resolver the top-bar menu uses, at menu-open time (this component lives
   * for one menu, so there is nothing to keep in sync afterwards).
   */
  const keyboardBindings = createKeyboardBindings();
  const newWindowHint = $derived(desktopShortcutLabel("new-window", keyboardBindings.bindings.system));
  const hideHint = $derived(desktopShortcutLabel("hide-app", keyboardBindings.bindings.system));

  /**
   * Where the panel actually goes (REQ-A481).
   *
   * `x`/`y` are the **pointer**, and the Dock sits at the bottom of the shell window — so on this
   * machine a right-click on a tile landed at y=839 in an 880 pt-tall window while this panel is
   * ~223 pt tall: drawn straight down, the window clipped it, and every row below the first
   * (新建窗口 / 显示 / 隐藏 / 选项… / 退出) was invisible and unclickable. The pixels showed the
   * wallpaper and the macOS Dock where the menu should have been; the AX tree still reported all
   * six rows with honest frames, because an accessibility frame is DOM layout and not what a window
   * can show.
   *
   * The rule lives in `lib/menuPlacement` (pure, unit-tested); this effect only *measures* the
   * rendered panel and applies it. Measurement happens in the effect rather than in the caller
   * because the panel's height depends on how many rows this app's state produces (a running app's
   * menu has no 「打开」 row).
   */
  let placed = $derived.by(() => (menuEl ? placeMenuAt(menuEl, x, y) : { left: x, top: y, flipped: false }));

  /**
   * 「打开」：**未运行**时把窗口开出来。
   *
   * macOS 对**未运行**的 Dock 图标右键，第一项就是「打开」（`wm_open`）。此前没有这一项，
   * 而其余三行都因为 `running === false` 灰着 —— 也就是**整张菜单没有任何一行能做任何事**：
   * 用户右键一个没在跑的 app，得到的是一张纯灰的菜单（F-SH-001 家族：看起来是菜单）。
   */
  async function open() {
    const targetLabel = label;
    onclose?.();
    if (running) return;
    const r = await wmOpenWithDiag(targetLabel);
    if (!r.ok) noteFailure("wm_open", targetLabel, "open", r.diag);
  }

  /**
   * 「新建窗口」：给这个图标所代表的**应用**再开一扇窗（`wm_new_window`）。
   *
   * REQ-A474：macOS 的 Dock 右键菜单里这是最常用的一行（"New Window"），而此前它只能
   * 停在"登记为缺口"——因为宿主一个 label 只有一个窗口（身份模型 REQ-A473 才让它成为可能）。
   *
   * Rules, each with a reason:
   *   * **目标是从 label 解析出来的应用**，不是 label 本身：`wm_new_window` 收 app id，
   *     而系统项（访达）的 label 恰好就是 `files`。
   *   * **只有"这个图标指向一个应用"时才渲染这一行** —— Launchpad / 废纸篓 / 未知 id 上
   *     "New Window" 没有意义（macOS 的 Launchpad 图标也没有这一项），而按下去会去建一个
   *     以模块 id 为名的窗口，那是**造一个不存在的应用**。
   *   * 未运行时它同样可用：`wm_new_window` 对"没有窗口的应用"就是开第一扇（macOS 上
   *     "New Window" 对未运行的 app 也只是把它打开），所以这一行不需要 `running` 门。
   */
  async function newWindow() {
    const targetLabel = label;
    const appId = appOfWindowLabel(targetLabel);
    onclose?.();
    if (!appId) return; // the row is not rendered in that case — belt and braces
    const r = await wmNewWindowWithDiag(appId);
    if (!r.ok) noteFailure("wm_new_window", targetLabel, "new-window", r.diag);
  }

  /** 「退出」需要真的把窗口关掉。`wm_close` 在 `main`（Launcher）上是 no-op。 */
  async function quit() {
    const targetLabel = label;
    onclose?.();
    const r = await wmCloseWithDiag(targetLabel);
    if (!r.ok) noteFailure("wm_close", targetLabel, "quit", r.diag);
  }

  /** 「隐藏」对应 macOS 的 "Hide"（⌘H）。非运行中项上没有意义，灰掉。 */
  async function hide() {
    const targetLabel = label;
    onclose?.();
    if (!running) return;
    const r = await wmHideWithDiag(targetLabel);
    if (!r.ok) noteFailure("wm_hide", targetLabel, "hide", r.diag);
  }

  /** 「显示」对应 macOS 的"再次点按运行中的图标 → 切回焦点"。 */
  async function show() {
    const targetLabel = label;
    onclose?.();
    if (!running) return;
    const r = await wmFocusWithDiag(targetLabel);
    if (!r.ok) noteFailure("wm_focus", targetLabel, "show", r.diag);
  }
</script>

<!--
  macOS 风格的小型下拉面板：
  - 玻璃质感（与顶栏 / Dock 一致）
  - 菜单项 disabled 时仍渲染（macOS 把"做不到"那一项也列出来，灰字而不是消失）
-->
<div
  bind:this={menuEl}
  class="fixed z-[200] {CHROME_MENU_PANEL}"
  style="
    left:{placed.left}px;
    top:{placed.top}px;
    {CHROME_MENU_PANEL_STYLE}
  "
  role="menu"
  aria-label={t("desktop.dockContextMenu")}
  data-testid="dock-context-menu"
  data-label={label}
>
  <!--
    「打开」：只有**未运行**时才出现（运行中时 macOS 的第一项是「显示」，也就是下面的焦点切换，
    两项不可能同时有意义）。它是这张菜单在 `running === false` 时**唯一**可用的行 —— 没有它，
    右键一个没在跑的 app 只会得到一张全灰的菜单。

    REQ-A1124：这一行**必须同时**确认 label 指向一个真实应用，与下面「新建窗口」行同一个判据。
    `wm_open(label)` 不被宿主校验 —— `WmState::open` 解析 label、注册、建窗（`wm.rs:1271` /
    :1815）—— 所以按在一个模块 id（`dock-launchpad`）上会**造出一个不存在的应用**的窗口：
    「新建窗口」行的注释（:164-166）逐字写下了这个后果，却只守住了自己那一行。这里补上同一道
    闸门；容器侧（`Dock.openItemMenu`）不再为无名瓦片摆出菜单，这条是第二道。
  -->
  {#if !running && appOfWindowLabel(label)}
    <button
      type="button"
      role="menuitem"
      class={CHROME_MENU_ITEM}
      data-testid="dock-ctx-open"
      onclick={() => void open()}>{t("desktop.dockCtxOpen")}</button
    >

    <div class={CHROME_MENU_SEPARATOR} role="presentation"></div>
  {/if}

  <!--
    「新建窗口」：只在**这个图标指向一个应用**时出现（REQ-A474）。
    macOS 的 Dock 菜单里它与「显示」并列，而它是**不依赖 `running`** 的那一行：未运行时
    `wm_new_window` 就是开第一扇窗（等于把应用打开），所以"没在跑 ⇒ 整张菜单全灰"这条
    老问题在这里也不再成立。
  -->
  {#if appOfWindowLabel(label)}
    <button
      type="button"
      role="menuitem"
      class={CHROME_MENU_ITEM}
      data-testid="dock-ctx-new-window"
      onclick={() => void newWindow()}
    >
      <span class="flex w-full items-center justify-between gap-3">
        <span>{t("desktop.dockCtxNewWindow")}</span>
        {#if newWindowHint}
          <span class="text-[11px] text-white/45" data-testid="dock-ctx-new-window-hint">{newWindowHint}</span>
        {/if}
      </span>
    </button>
  {/if}

  <!-- 「显示」：仅当窗口已开 -->
  <button
    type="button"
    role="menuitem"
    class={CHROME_MENU_ITEM}
    data-testid="dock-ctx-show"
    disabled={!running}
    aria-disabled={running ? undefined : "true"}
    title={running ? undefined : t("desktop.dockCtxNotRunning")}
    onclick={() => void show()}>{t("desktop.dockCtxShow")}</button
  >

  <!-- 「隐藏」：仅当窗口已开 -->
  <button
    type="button"
    role="menuitem"
    class={CHROME_MENU_ITEM}
    data-testid="dock-ctx-hide"
    disabled={!running}
    aria-disabled={running ? undefined : "true"}
    title={running ? undefined : t("desktop.dockCtxNotRunning")}
    onclick={() => void hide()}
  >
    <span class="flex w-full items-center justify-between gap-3">
      <span>{t("desktop.dockCtxHide")}</span>
      {#if hideHint}
        <span class="text-[11px] text-white/45" data-testid="dock-ctx-hide-hint">{hideHint}</span>
      {/if}
    </span>
  </button>

  <div class={CHROME_MENU_SEPARATOR} role="presentation"></div>

  <!-- 「选项 ›」：占位 — per-app 选项菜单需要宿主扩展，灰项 -->
  <button
    type="button"
    role="menuitem"
    class={CHROME_MENU_ITEM}
    data-testid="dock-ctx-options"
    disabled
    aria-disabled="true"
    title={t("desktop.dockCtxOptionsUnavailable")}
    aria-label={t("desktop.dockCtxOptionsUnavailable")}
    >{t("desktop.dockCtxOptions")}</button
  >

  <div class={CHROME_MENU_SEPARATOR} role="presentation"></div>

  <!-- 「退出」：把窗口关掉 -->
  <button
    type="button"
    role="menuitem"
    class={CHROME_MENU_ITEM}
    data-testid="dock-ctx-quit"
    disabled={!running}
    aria-disabled={running ? undefined : "true"}
    title={running ? undefined : t("desktop.dockCtxNotRunning")}
    onclick={() => void quit()}>{t("desktop.dockCtxQuit")}</button
  >
</div>
