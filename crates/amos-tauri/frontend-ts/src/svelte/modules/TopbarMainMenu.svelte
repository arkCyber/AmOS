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
  import { clipboardRead, clipboardWrite } from "../../lib/clipboard";
  import { t } from "../locale.svelte";
  import { toggleDesktopView } from "../../lib/desktopView";
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
    shortcutKey?: string;
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

  // ─── File ────────────────────────────────────────────────────────────────────
  const fileRows: MenuRow[] = [
    {
      id: "file.new-window",
      labelKey: "desktop.menu.file.newWindow",
      shortcutKey: "desktop.menu.file.newWindowShortcut",
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
      shortcutKey: "desktop.menu.file.closeWindowShortcut",
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
      shortcutKey: "desktop.menu.edit.copyShortcut",
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
      shortcutKey: "desktop.menu.edit.pasteShortcut",
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
      shortcutKey: "desktop.menu.edit.selectAllShortcut",
      run: () => {
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key: "a", metaKey: true }),
        );
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
    { id: "view.fullscreen", labelKey: "desktop.menu.view.toggleUnavailable" },
  ];

  // ─── Window ──────────────────────────────────────────────────────────────────
  const windowRows: MenuRow[] = [
    {
      id: "window.minimize",
      labelKey: "desktop.menu.window.minimize",
      shortcutKey: "desktop.menu.window.minimizeShortcut",
      run: () => {
        // Empty `label` is the macOS "minimize the focused window"
        // idiom — same as File→Close above. A refused minimize is
        // surfaced via `noteFailure` rather than silently ignored.
        void wmRun("wm_hide", "", "window.minimize");
      },
    },
    { id: "window.zoom", labelKey: "desktop.menu.window.zoomUnavailable" },
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
                {#if row.shortcutKey}
                  <span class="text-[11px] text-white/45">{t(row.shortcutKey)}</span>
                {/if}
              </span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {/each}
</nav>
