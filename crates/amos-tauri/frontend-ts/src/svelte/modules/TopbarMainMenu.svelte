<script lang="ts">
  /**
   * TopbarMainMenu.svelte — macOS's File / Edit / View / Window / Help bar (REQ-A275).
   *
   * Round 1 had five disabled buttons ("App menus are not wired up yet") — the FMEA
   * F-SH-001 honest shape. This round turns the bar into **real dropdowns** for every
   * row the shell can actually do, and lists the rest as macOS does — visible, greyed,
   * and named with the reason.
   */
  import { bridgeDiag, invoke } from "../../lib/backend";
  import { getContext } from "svelte";
  import {
    SHELL_CHROME_API,
    type ShellChromeApi,
    type ShellWindowAction,
  } from "../../lib/shellModule";
  // 表派生的键帽（REQ-A342）：菜单不再自持一份"快捷键字符串"，行里的 `shortcut` 要么来自
  // 这张表（壳真正绑定的键），要么是平台自己的编辑键（⌘C/⌘V/⌘A）——后者不可改、也不可翻译。
  import { desktopShortcutLabel } from "../../lib/desktopKeys";
  import { clipboardRead, clipboardWrite } from "../../lib/clipboard";
  import { t } from "../locale.svelte";
  import { toggleDesktopView } from "../../lib/desktopView";
  import { installMenuKeyboard } from "../../lib/menuKeys";
  import { selectAllFromMenu } from "../../lib/editKeys";
  import {
    CHROME_MENU_BUTTON,
    CHROME_MENU_ITEM,
    CHROME_MENU_PANEL,
    CHROME_MENU_PANEL_STYLE,
    CHROME_MENU_SEPARATOR,
    CHROME_TEXT_SHADOW,
  } from "../../lib/shellChrome";

  /** One row of the bar menus. `run` is optional: a missing run is F-SH-001 honest UI. */
  interface MenuRow {
    id: string;
    labelKey?: string;
    /**
     * The keycap drawn at the right edge of the row.
     *
     * Two kinds of value, and the difference matters (REQ-A342):
     *   * a **shell** key ⇒ `desktopShortcutLabel(…)`, derived from the table that actually binds
     *     it, so hint and engine cannot drift;
     *   * a **platform** key (⌘C/⌘V/⌘A — the WebView's own editing commands, which this shell does
     *     not bind and cannot change) ⇒ the literal keycap, in one place, with that reason stated.
     *
     * There used to be a third kind: an **i18n key** (`shortcutKey: "desktop.menu.file.…Shortcut"`).
     * No locale defined those keys and `translate()` falls back to `raw ?? key`, so the menu printed
     * the key *name* on screen — and a keycap is not translatable anyway. A row whose key **nothing**
     * binds simply has no `shortcut` (see `file.new-window`): a menu may not advertise a binding
     * that does not exist.
     */
    shortcut?: string;
    separatorBefore?: boolean;
    run?: () => void;
  }

  interface MenuGroup {
    id: "file" | "edit" | "view" | "window" | "help";
    titleKey: string;
    rows: MenuRow[];
  }

  // REQ-A297 phase-2 §4 cont.2 (typed-error discipline). The bar's three
  // wm_* rows used to be `invoke("wm_*", ...).catch(() => undefined)` —
  // `catch` is dead code because `invoke` swallows rejections into `null`
  // (REQ-A296). A refused wm_open / wm_close / wm_hide therefore
  // silently dropped the user's File→New Window / Close / Minimize tap.
  // We now branch on the null result via a tiny `noteFailure` helper
  // and write a `🛟` breadcrumb to the launcher log so the failure is
  // visible. Sharing one helper keeps the three rows symmetric — if a
  // future View→Toggle Stage Module (or similar) needs the same
  // shape, it can reuse this code rather than invent a new variant.
  function noteFailure(
    command: string,
    label: string,
    context: string,
  ): void {
    const diag = bridgeDiag(command);
    if (diag.ok) return;
    const code =
      diag.kind === "command-failed" &&
      diag.detail &&
      typeof diag.detail === "object"
        ? (diag.detail as { code?: string }).code
        : undefined;
    console.warn(
      `🛟 [Topbar menu] ${context} — ${command}(${label}) refused`,
      code ?? diag.kind,
    );
  }

  /**
   * Run a bar-row action. The shell has many rows that fire a `wm_*`
   * command; reading the result and routing through `noteFailure` keeps
   * the failure surface honest. The user still expects the menu to
   * close on click — that's the topbar's job, not this helper's.
   */
  async function wmRun(
    command: "wm_open" | "wm_close" | "wm_hide",
    label: string,
    context: string,
  ): Promise<void> {
    const result = await invoke<unknown>(command, { label });
    if (result === null) noteFailure(command, label, context);
  }

  /**
   * The shell's handle (REQ-A457), or `undefined` when the bar is mounted standalone (a test,
   * a story): the two window rows below then do nothing — "there is no window to act on" is the
   * honest outcome, not a guess, and it is what a bar with no shell can actually know.
   */
  const api = getContext<ShellChromeApi | undefined>(SHELL_CHROME_API);

  /**
   * Ask the shell to act on the **focused app window**. The bar does not resolve the window
   * itself: "which window is focused" lives in the shell (one poll, one owner), and a second
   * copy here is how the two surfaces started disagreeing in the first place (the rows below
   * still said *unavailable* long after the native menu and the host command were live).
   */
  function windowAction(action: ShellWindowAction): void {
    api?.windowAction(action);
  }

  // ─── File ────────────────────────────────────────────────────────────────────
  const fileRows: MenuRow[] = [
    {
      id: "file.new-window",
      labelKey: "desktop.menu.file.newWindow",
      run: () => {
        // REQ-A297 phase-2 §4 cont.2: pre-fix this row used
        // `.catch(() => undefined)` — dead code, since `invoke`
        // resolves to `null` on a refused open instead of rejecting.
        // The new helper logs the typed error so the user (and ops)
        // can tell that "Open New Window" did nothing visible.
        void wmRun("wm_open", "files", "file.new-window");
      },
    },
    {
      id: "file.close",
      labelKey: "desktop.menu.file.closeWindow",
      shortcut: desktopShortcutLabel("close-window"),
      run: () => {
        // Empty `label` is the macOS "close the focused window" idiom;
        // a refused close surfaces honestly through `noteFailure`.
        void wmRun("wm_close", "", "file.close");
      },
    },
    { id: "file.print", labelKey: "desktop.menu.file.printUnavailable" },
  ];

  // ─── Edit ─────────────────────────────────────────────────────────────────────
  const editRows: MenuRow[] = [
    {
      id: "edit.copy",
      labelKey: "desktop.menu.edit.copy",
      shortcut: "⌘C",
      run: () => {
        const text = window.getSelection?.()?.toString() ?? "";
        if (text.length > 0) {
          clipboardWrite({ kind: "text", text }, "topbar.file.copy").catch(
            () => undefined,
          );
        }
      },
    },
    {
      id: "edit.paste",
      labelKey: "desktop.menu.edit.paste",
      shortcut: "⌘V",
      run: () => {
        clipboardRead().then((entry) => {
          if (entry?.payload.kind === "text") {
            const el = document.activeElement as
              | HTMLInputElement
              | HTMLTextAreaElement
              | null;
            if (el) {
              const start = el.selectionStart ?? el.value.length;
              const end = el.selectionEnd ?? el.value.length;
              el.value =
                el.value.slice(0, start) +
                entry.payload.text +
                el.value.slice(end);
              el.selectionStart = el.selectionEnd =
                start + entry.payload.text.length;
              el.dispatchEvent(new Event("input", { bubbles: true }));
            }
          }
        }).catch(() => undefined);
      },
    },
    {
      id: "edit.select-all",
      labelKey: "desktop.menu.edit.selectAll",
      shortcut: "⌘A",
      // This row used to dispatch a synthetic `KeyboardEvent("keydown", {key:"a", metaKey:true})`
      // — which selects nothing, because no consumer exists and a synthetic event has no default
      // action (measured 2026-09-19; the OS does not deliver ⌘A to the WebView at all, REQ-A439).
      // It now performs the gesture through the same rule the shell's key path uses.
      run: () => {
        selectAllFromMenu();
      },
    },
    { id: "edit.undo", labelKey: "desktop.menu.edit.undoUnavailable" },
  ];

  // ─── View ─────────────────────────────────────────────────────────────────────
  const viewRows: MenuRow[] = [
    {
      id: "view.toggle-wallpaper",
      labelKey: "desktop.menu.view.toggleWallpaper",
      run: () => {
        toggleDesktopView("wallpaper");
      },
    },
    {
      id: "view.toggle-icons",
      labelKey: "desktop.menu.view.toggleIcons",
      run: () => {
        toggleDesktopView("icons");
      },
    },
    {
      id: "view.toggle-stage-widgets",
      labelKey: "desktop.menu.view.toggleStageWidgets",
      run: () => {
        toggleDesktopView("stageWidgets");
      },
    },
    { id: "view.fullscreen", labelKey: "desktop.menu.view.enterFullScreen", run: () => windowAction("full-screen") },
  ];

  // ─── Window ──────────────────────────────────────────────────────────────────
  const windowRows: MenuRow[] = [
    {
      id: "window.minimize",
      labelKey: "desktop.menu.window.minimize",
      shortcut: desktopShortcutLabel("minimize-window"),
      run: () => {
        // Empty `label` is the macOS "minimize the focused window"
        // idiom — same as File→Close above. A refused minimize is
        // surfaced via `noteFailure` rather than silently ignored.
        void wmRun("wm_hide", "", "window.minimize");
      },
    },
    { id: "window.zoom", labelKey: "desktop.menu.window.zoom", run: () => windowAction("zoom") },
    {
      id: "window.bring-all",
      labelKey: "desktop.menu.window.bringAllToFrontUnavailable",
    },
  ];

  // ─── Help ─────────────────────────────────────────────────────────────────────
  const helpRows: MenuRow[] = [
    { id: "help.search", labelKey: "desktop.menu.help.searchUnavailable" },
    { id: "help.app", labelKey: "desktop.menu.help.appHelpUnavailable" },
  ];

  const GROUPS: MenuGroup[] = [
    { id: "file", titleKey: "desktop.menu.file", rows: fileRows },
    { id: "edit", titleKey: "desktop.menu.edit", rows: editRows },
    { id: "view", titleKey: "desktop.menu.view", rows: viewRows },
    { id: "window", titleKey: "desktop.menu.window", rows: windowRows },
    { id: "help", titleKey: "desktop.menu.help", rows: helpRows },
  ];

  let openId = $state<MenuGroup["id"] | null>(null);
  let wrapEl = $state<HTMLElement | null>(null);
  /** The open panel (`{#if openId === …}` means at most one exists), for REQ-A436's keys. */
  let panelEl = $state<HTMLElement | null>(null);

  // REQ-A436: the bar's menus are keyboard usable — the shared layer walks the rows with the
  // arrows / Home / End and hands Escape to *this* menu's closer.
  $effect(() => {
    if (!panelEl || !openId) return;
    return installMenuKeyboard(panelEl, { onClose: () => (openId = null) });
  });

  async function choose(row: MenuRow) {
    if (!row.run) return;
    openId = null;
    await row.run();
  }

  $effect(() => {
    if (openId === null) return;
    const onDown = (e: MouseEvent) => {
      const el = e.target as Node | null;
      if (el && wrapEl && !wrapEl.contains(el)) openId = null;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") openId = null;
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  });

  function unavailableName(row: MenuRow): string {
    if (row.run) return t(row.labelKey!);
    return t(row.labelKey!) + " — unavailable";
  }
</script>

<nav
  class="ml-1 flex gap-1"
  aria-label={t("desktop.mainMenu")}
  data-testid="menu-main"
  bind:this={wrapEl}
>
  {#each GROUPS as group (group.id)}
    {@const open = openId === group.id}
    <div class="relative" data-testid="menu-{group.id}">
      <button
        class="{CHROME_MENU_BUTTON}"
        style="text-shadow: {CHROME_TEXT_SHADOW};"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t(group.titleKey)}
        title={t(group.titleKey)}
        data-testid="menu-{group.id}-trigger"
        onclick={() => (openId = open ? null : group.id)}
      >
        {t(group.titleKey)}
      </button>
      {#if open}
        <div
          class="absolute left-0 top-full z-50 mt-1 {CHROME_MENU_PANEL}"
          style={CHROME_MENU_PANEL_STYLE}
          bind:this={panelEl}
          role="menu"
          aria-label={t(group.titleKey)}
          data-testid="menu-{group.id}-panel"
        >
          {#each group.rows as row, i (row.id)}
            {#if i > 0 && row.separatorBefore}
              <div class={CHROME_MENU_SEPARATOR} role="presentation"></div>
            {/if}
            <button
              role="menuitem"
              class={CHROME_MENU_ITEM}
              data-testid="menu-{group.id}-{row.id}"
              disabled={!row.run}
              aria-disabled={row.run ? undefined : "true"}
              aria-label={unavailableName(row)}
              title={row.run ? t(row.labelKey!) : t(row.labelKey!)}
              onclick={() => choose(row)}
            >
              <span class="flex w-full items-center justify-between gap-3">
                <span>{t(row.labelKey!)}</span>
                {#if row.shortcut}
                  <span class="text-[11px] text-white/45">{row.shortcut}</span>
                {/if}
              </span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {/each}
</nav>
