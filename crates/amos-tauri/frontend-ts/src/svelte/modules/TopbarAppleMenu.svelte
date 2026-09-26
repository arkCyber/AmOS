<script lang="ts">
  /**
   * TopbarAppleMenu.svelte — the 🍎 menu at the far left of the bar.
   *
   * It was the bar's worst control before this widget existed: a full-strength button
   * with a name, keyboard focus and **nothing behind it**. The honest options were
   * "disable it and say so" (what the control centre got) or "make it real", and the
   * Apple menu is real macOS behaviour that this shell can *actually* do — so it is a
   * dropdown now:
   *
   *   • 系统设置… → `wm_open("settings")` (the Settings app holds the real pages)
   *   • 锁定屏幕 → the chrome handle's `lockScreen()` (the shell owns `shellState`;
   *     this is exactly why the handle belongs to the shell and not to a container)
   *   • 重新启动 / 关机 / 睡眠 → the host's power/session commands (REQ-A515). These
   *     were greyed rows whose own name said the capability was missing; the host now
   *     has `session_restart` / `session_shutdown` / `session_sleep` behind them.
   *
   * **The power rows ask first.** Restarting or shutting down is irreversible and
   * throws away every unsaved thing the user has open, so selecting one does not run
   * it — it opens the inline confirmation below the rows (`role="alertdialog"`) and
   * only 「继续」 reaches the host. A menu where one mis-click powers the machine off
   * is the shape this repository's FMEA scores highest, not a feature.
   *
   * **关于本机 is live too (REQ-A796).** It used to be a greyed row whose own name gave a
   * reason — "尚未接入独立面板" — that was simply untrue: the host opens exactly that panel
   * for the native `menu.about` item (`menu::show_about_dialog`), and the only thing
   * missing was a command the WebView could call. A disabled row that names a false reason
   * is the same defect as a live row that does nothing (FMEA F-SH-001 / F-SH-241), so the
   * row now calls `shell_about_panel` and **reports** a refusal (`unsupported_host` /
   * `wrong_thread`) inline instead of being greyed pre-emptively. A row that cannot know
   * whether it will work must not claim it cannot.
   *
   * **The sideways walk is the bar's, not this widget's.** This menu is the bar's *first*
   * one, and ←/→ move between every menu in the bar — from 🍎 rightwards, and back to 🍎
   * from the first app menu. That axis is installed once by `TopBar`
   * (`lib/menuKeys.ts::installTopBarMenuAxis`) over the slot that holds both this widget
   * and `TopbarMainMenu`, because the ring spans two components. (It used to live on the
   * main menu's own `<nav>`, which is a *sibling* of this element — so 🍎 sat outside the
   * ring and ← from File wrapped to Help instead of reaching it.)
   *
   * Honest boundary: **this menu's rows are arrow-navigable** (the `installMenuKeyboard`
   * call below — ↑/↓/Home/End walk the rows and it opens with its first row focused), and
   * the bar's ←/→ ring includes it, but **submenus** are still missing (macOS's 🍎 has
   * none, so nothing here needs them yet; `TopbarMainMenu` does not have them either). The
   * menu closes on Escape / outside click / after an action. The confirmation is the
   * **shell's**, not AppKit's — the host's own authorization prompts, if any, still apply.
   * It is one file to extend.
   */
  import { getContext } from "svelte";
  import { wmOpenWithDiag } from "../../lib/wm";
  import { shellAboutPanel, type AboutPanelFailure } from "../../lib/backend";
  import {
    sessionActionRunner,
    type SessionAction,
  } from "../../lib/session";
  import { SHELL_CHROME_API, type ShellChromeApi } from "../../lib/shellModule";
  import { installMenuKeyboard } from "../../lib/menuKeys";
  import { t } from "../locale.svelte";
  import {
    CHROME_MENU_BUTTON,
    CHROME_MENU_ITEM,
    CHROME_MENU_PANEL,
    CHROME_MENU_PANEL_STYLE,
    CHROME_MENU_SEPARATOR,
    CHROME_TEXT_SHADOW,
  } from "../../lib/shellChrome";

  const api = getContext<ShellChromeApi | undefined>(SHELL_CHROME_API);

  /** One row of the Apple menu. No `run` and no `power` ⇒ the shell cannot do it yet
   *  (greyed + named). */
  interface AppleMenuEntry {
    id: string;
    labelKey: string;
    /** Menus group their rows; a separator is drawn where the group number changes. */
    group: number;
    run?: () => void | Promise<void>;
    /** A host power/session action this row asks to confirm before it runs (REQ-A515). */
    power?: SessionAction;
    /** The row must be able to report a refusal **before** the menu closes, so `choose`
     *  does not pre-close it — the row closes the menu itself on success (REQ-A796). */
    reports?: boolean;
  }

  /** Open System Settings via the chrome's `wm_open` bridge.
   *
   *  REQ-A297 phase-2 §4: a bare `await invoke("wm_open", ...)` returns
   *  `null` on failure without rejecting, so a refused open would have
   *  been silently swallowed. The post-fix branches on the null result
   *  and writes a `🛟` breadcrumb to the launcher log so the failure
   *  is at least visible.
   */
  async function openSettings() {
    const r = await wmOpenWithDiag("settings");
    if (!r.ok) {
      const diag = r.diag;
      if (!diag.ok) {
        const code =
          diag.kind === "command-failed" &&
          diag.detail &&
          typeof diag.detail === "object"
            ? (diag.detail as { code?: string }).code
            : undefined;
        console.warn(
          "🛟 [Apple menu] wm_open(settings) refused",
          code ?? diag.kind,
        );
      }
    }
  }

  /**
   * 关于本机 (REQ-A796) — ask the host for the platform's About panel.
   *
   * The row reads 「关于本机…」 and a Mac user expects the standard panel, so there are
   * exactly two honest outcomes: it came up, or it did not and here is why. The reason is
   * shown **in the menu**, which stays open, rather than logged — a `console.warn` is
   * invisible to the person who clicked, and this row's whole history is about reasons the
   * user could not check.
   */
  async function openAbout() {
    const r = await shellAboutPanel();
    if (r.shown) {
      close();
      return;
    }
    // Set **after** any `close()`: closing clears the notice (a stale refusal must not be
    // waiting behind the next open).
    notice = r.reason;
  }

  /** The menu, in macOS's order.
   *
   * The three power rows carry `power` rather than `run`: selecting one opens the
   * confirmation instead of acting, which is why they are **not** greyed and why
   * `choose` branches on `power` first.
   */
  const ENTRIES: AppleMenuEntry[] = [
    { id: "about", labelKey: "desktop.apple.about", group: 1, run: openAbout, reports: true },
    { id: "settings", labelKey: "desktop.apple.systemSettings", group: 2, run: openSettings },
    { id: "lock", labelKey: "desktop.apple.lockScreen", group: 2, run: () => api?.lockScreen() },
    { id: "restart", labelKey: "desktop.apple.restart", group: 3, power: "restart" },
    { id: "shutdown", labelKey: "desktop.apple.shutDown", group: 3, power: "shutdown" },
    { id: "sleep", labelKey: "desktop.apple.sleep", group: 3, power: "sleep" },
  ];

  /** The row's label key for an action — the confirmation names the action the user
   *  picked, in the same words the row used. */
  const POWER_LABEL_KEY: Record<SessionAction, string> = {
    restart: "desktop.apple.restart",
    shutdown: "desktop.apple.shutDown",
    sleep: "desktop.apple.sleep",
  };

  /** The sentence for each way the About panel can fail to appear. Keyed by the reason
   *  type, so adding a reason to `AboutPanelFailure` is a compile error here rather than a
   *  missing translation at runtime. */
  const ABOUT_FAILURE_KEY: Record<AboutPanelFailure, string> = {
    unsupported_host: "desktop.apple.aboutUnsupported",
    wrong_thread: "desktop.apple.aboutWrongThread",
    unreachable: "desktop.apple.aboutUnreachable",
  };

  let open = $state(false);
  let wrapEl = $state<HTMLElement | null>(null);
  /** The open panel, for REQ-A436's keyboard layer (see `lib/menuKeys`). */
  let panelEl = $state<HTMLElement | null>(null);
  /** The power action awaiting confirmation, or `null` when none is pending. */
  let pending = $state<SessionAction | null>(null);
  /** Set while a confirmed action is in flight, so 「继续」 cannot be double-fired. */
  let running = $state(false);
  /** Why the About panel did not appear, while the menu is open — or `null`. */
  let notice = $state<AboutPanelFailure | null>(null);

  $effect(() => {
    if (!panelEl || !open) return;
    return installMenuKeyboard(panelEl, {
      onClose: () => close(),
      // Escape leaves the focus on the 🍎 title, like the app menus and like macOS: the
      // panel is about to unmount, and focus dropped to `<body>` would take this menu out of
      // the bar's ←/→ ring (the ring listens on the bar, which a `<body>` event never reaches).
      // Only the Escape path restores — an outside click already owns the focus.
      restoreFocusTo: () =>
        wrapEl?.querySelector<HTMLElement>('[data-testid="apple-menu-trigger"]') ?? null,
    });
  });

  /** Close the menu and drop any pending confirmation (a dismissed menu must not keep
   *  a half-armed destructive action behind it). */
  function close() {
    open = false;
    pending = null;
    running = false;
    notice = null;
  }

  async function choose(entry: AppleMenuEntry) {
    if (entry.power) {
      // Irreversible (FMEA severity ≥ 4): select, confirm, then act.
      pending = entry.power;
      return;
    }
    if (!entry.run) return;
    // A row that reports its outcome stays open until it has one; every other row is
    // dismissed first, so the panel is gone before the host is even asked (REQ-A796).
    if (entry.reports) {
      await entry.run();
      return;
    }
    close();
    await entry.run();
  }

  /**
   * The confirmed action. Reports a refusal the way this repository does: read the
   * typed `code` off the diagnostic and write a `🛟` breadcrumb — a power action that
   * silently did nothing is exactly the "why is nothing happening?" defect class.
   */
  async function confirmPower() {
    if (pending === null || running) return;
    const action = pending;
    running = true;
    const outcome = await sessionActionRunner(action)();
    running = false;
    if (!outcome.ok) {
      const diag = outcome.diag;
      const code =
        !diag.ok &&
        diag.kind === "command-failed" &&
        diag.detail &&
        typeof diag.detail === "object"
          ? (diag.detail as { code?: string }).code
          : undefined;
      console.warn(
        `🛟 [Apple menu] ${action} refused`,
        code ?? (diag.ok ? "unknown" : diag.kind),
      );
      // The menu stays open with the confirmation still up, so the user can retry or
      // cancel instead of being left wondering whether the machine is about to go down.
      return;
    }
    close();
  }

  // Escape and an outside click both dismiss a menu (macOS does the same). The listener
  // exists only while the menu is open — a component that parks a permanent document
  // listener to serve a closed menu is how "click anywhere" bugs start.
  $effect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const el = e.target as Node | null;
      if (el && wrapEl && !wrapEl.contains(el)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  });
</script>

<div class="relative" bind:this={wrapEl} data-testid="menu-apple">
  <button
    aria-label={t("desktop.appleMenu")}
    title={t("desktop.appleMenu")}
    aria-haspopup="menu"
    aria-expanded={open}
    data-testid="apple-menu-trigger"
    class="{CHROME_MENU_BUTTON} h-6 w-6 px-0"
    style="text-shadow: {CHROME_TEXT_SHADOW};"
    onclick={() => (open ? close() : (open = true))}>🍎</button
  >

  {#if open}
    <div
      class="absolute left-0 top-full z-50 mt-1 {CHROME_MENU_PANEL}"
      style={CHROME_MENU_PANEL_STYLE}
      bind:this={panelEl}
      role="menu"
      aria-label={t("desktop.appleMenu")}
      data-testid="apple-menu-panel"
    >
      {#each ENTRIES as entry, i (entry.id)}
        {@const first = i === 0}
        {#if !first && entry.group !== ENTRIES[i - 1]?.group}
          <div class={CHROME_MENU_SEPARATOR} role="presentation"></div>
        {/if}
        <button
          role="menuitem"
          class={CHROME_MENU_ITEM}
          data-testid="apple-menu-{entry.id}"
          disabled={!entry.run && !entry.power}
          aria-disabled={entry.run || entry.power ? undefined : "true"}
          aria-label={t(entry.labelKey)}
          title={t(entry.labelKey)}
          onclick={() => choose(entry)}>{t(entry.labelKey)}</button
        >
      {/each}

      {#if notice}
        <div class={CHROME_MENU_SEPARATOR} role="presentation"></div>
        <!--
          Why 关于本机 did not open a panel (REQ-A796). `role="status"` (not `alert`): the
          user clicked and is looking here, so this is a polite report, not an interruption.
          It renders inside the menu, next to the row that produced it, and the menu stays
          open so the row stays clickable.
        -->
        <p
          role="status"
          class="px-3 py-2 text-xs text-white/70"
          data-testid="apple-about-notice"
        >
          {t(ABOUT_FAILURE_KEY[notice])}
        </p>
      {/if}

      {#if pending}
        {@const actionLabel = t(POWER_LABEL_KEY[pending])}
        <div
          class={CHROME_MENU_SEPARATOR}
          role="presentation"
        ></div>
        <!--
          The confirmation for an irreversible action (REQ-A515). `alertdialog` (not
          `dialog`) because the action destroys unsaved work with no undo — the assistive
          layer should interrupt, which is what the role means. It renders **inside** the
          menu so the user never loses sight of which action they picked.
        -->
        <div
          role="alertdialog"
          aria-labelledby="apple-power-confirm-title"
          aria-describedby="apple-power-confirm-body"
          class="px-3 py-2 text-xs text-white/90"
          data-testid="apple-power-confirm"
        >
          <p id="apple-power-confirm-title" class="font-medium">
            {t("desktop.apple.confirmTitle", { action: actionLabel })}
          </p>
          <p id="apple-power-confirm-body" class="mt-1 text-white/70">
            {t("desktop.apple.confirmBody")}
          </p>
          <div class="mt-2 flex gap-2">
            <button
              type="button"
              class="{CHROME_MENU_ITEM} flex-1 justify-center"
              data-testid="apple-power-cancel"
              onclick={() => (pending = null)}
              >{t("desktop.apple.confirmCancel")}</button
            >
            <button
              type="button"
              class="{CHROME_MENU_ITEM} flex-1 justify-center"
              data-testid="apple-power-confirm-go"
              disabled={running}
              onclick={confirmPower}
              >{t("desktop.apple.confirmGo")}</button
            >
          </div>
        </div>
      {/if}
    </div>
  {/if}
</div>
