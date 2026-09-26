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
  import type { WmWindowsSnapshot } from "../../lib/wm";
  import { getContext } from "svelte";
  import {
    SHELL_CHROME_API,
    type ShellChromeApi,
    type ShellWindowAction,
  } from "../../lib/shellModule";
  // 表派生的键帽（REQ-A342）：菜单不再自持一份"快捷键字符串"，行里的 `shortcut` 要么来自
  // 这张表（壳真正绑定的键），要么是平台自己的编辑键（⌘C/⌘V/⌘A）——后者不可改、也不可翻译。
  import { desktopShortcutLabel } from "../../lib/desktopKeys";
  import { createKeyboardBindings } from "../../lib/keyboardConfigHook.svelte";
  import { clipboardRead, clipboardWrite } from "../../lib/clipboard";
  import { t } from "../locale.svelte";
  import { toggleDesktopView } from "../../lib/desktopView";
  import { installMenuKeyboard } from "../../lib/menuKeys";
  import { selectAllFromMenu } from "../../lib/editKeys";
  import { screenshotCapture } from "../../lib/screenshot";
  // REQ-A816: the snapping zone table — the same one the ⌃⌥ chords match against. The rows below
  // are built from it, so the menu cannot offer a region the chords do not know (or the reverse).
  import { SNAP_ZONES, snapShortcutLabel } from "../../lib/snapZones";
  import { stageToggleLabel } from "../../lib/stageKeys";
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
    // REQ-A555: 三条命令都答 `Result<WmSnapshot, String>`，所以回复类型是同一个名字。
    // 诚实边界：**这条调用对回复门是隐形的** —— `scripts/tauri-reply-scan.mjs` 按字面量命令名
    // 收集调用点，而这里命令名是参数（`command`），所以它既不进 checked 也不进 untyped 清单。
    // 类型仍然要写对：将来若把命令名改成字面量分支，这一处就是可比的。
    const result = await invoke<WmWindowsSnapshot>(command, { label });
    if (result === null) noteFailure(command, label, context);
  }

  /**
   * The shell's handle (REQ-A457), or `undefined` when the bar is mounted standalone (a test,
   * a story): the two window rows below then do nothing — "there is no window to act on" is the
   * honest outcome, not a guess, and it is what a bar with no shell can actually know.
   */
  const api = getContext<ShellChromeApi | undefined>(SHELL_CHROME_API);

  /**
   * The **merged** system bindings (defaults + the user's overrides + disables).
   *
   * REQ-A484 (F-SH-038): the hints below used to be computed from the default table alone, so a
   * user who rebound `newWindow` to ⌥⌘N — or disabled it — still saw `⌘N` in this menu while the
   * shell matched something else. The menu and the dispatch now read the same resolved map
   * (`DesktopShell` dispatches on exactly this), and a disabled binding yields **no hint at all**,
   * which is the rule this file's own doc states: a menu may not advertise a binding the shell does
   * not have.
   */
  const keyboardBindings = createKeyboardBindings();

  /**
   * REQ-A1309 (F-SH-583): REQ-A484 made the rows below read the **resolved** map instead of the
   * default table — but it read it *once*. `desktopShortcutLabel(…, keyboardBindings.bindings.system)`
   * is a string computed at component-init scope, and `fileRows` / `windowRows` / `GROUPS` were
   * plain `const`s, so the keycap was frozen at whatever the config said on the render pass that
   * mounted this bar. Mount-lived (it is not remounted per open, like the overlays), a user who
   * rebinds ⌘N → ⌥⌘N — or disables it — in the Settings window kept seeing ⌘N here while the shell
   * had already switched to ⌥⌘N: the menu advertising a binding the shell does not have, the very
   * thing REQ-A484's own doc forbids. Two halves fix it: this subscription (the config reaches us
   * as a `storage` event, the cross-window path the Settings screen travels) and the `$derived`
   * rows below (so the label is recomputed rather than frozen).
   */
  $effect(() => {
    keyboardBindings.startListening();
    return () => keyboardBindings.stopListening();
  });

  /**
   * Ask the shell to act on the **focused app window**. The bar does not resolve the window
   * itself: "which window is focused" lives in the shell (one poll, one owner), and a second
   * copy here is how the two surfaces started disagreeing in the first place (the rows below
   * still said *unavailable* long after the native menu and the host command were live).
   */
  function windowAction(action: ShellWindowAction): void {
    api?.windowAction(action);
  }

  /**
   * Ask the shell for one more window of the **focused app** (REQ-A473).
   *
   * Same reasoning as [`windowAction`]: the bar does not resolve the window or the app
   * itself. Before the identity model this row could only open the **Files** window (the
   * REQ-A434 compromise) — the shell's `newWindow` handle now duplicates whatever is
   * focused, falling back to Files when nothing app-shaped is, which is exactly what the
   * native File menu item does.
   */
  function newWindow(): void {
    api?.newWindow();
  }

  // ─── File ────────────────────────────────────────────────────────────────────
  // `$derived.by` (not a plain array): the two keycaps below come from `keyboardBindings`, which
  // is a live `$state`. A plain `const` would capture the strings at init and the rebind dead-ends
  // (REQ-A1309 / F-SH-583).
  const fileRows = $derived.by((): MenuRow[] => [
    {
      id: "file.new-window",
      labelKey: "desktop.menu.file.newWindow",
      shortcut: desktopShortcutLabel("new-window", keyboardBindings.bindings.system),
      run: () => {
        // REQ-A297 phase-2 §4 cont.2: pre-fix this row used
        // `.catch(() => undefined)` — dead code, since `invoke`
        // resolves to `null` on a refused open instead of rejecting.
        // A refusal is reported by the shell's handle (`newWindow`), so
        // "Open New Window" doing nothing visible stays diagnosable.
        newWindow();
      },
    },
    {
      id: "file.close",
      labelKey: "desktop.menu.file.closeWindow",
      shortcut: desktopShortcutLabel("close-window", keyboardBindings.bindings.system),
      run: () => {
        // The shell resolves the focused window (it owns the poll) and reports a refusal;
        // this row used to send an empty label, which the host looks up in `by_label` and
        // refuses (`wm.rs::close_core`), so the row silently did nothing.
        api?.focusedWindowIntent("close-window");
      },
    },
    {
      id: "file.print",
      labelKey: "desktop.menu.file.print",
      run: () => {
        // REQ-A869: this row used to call `window.print()` with a comment claiming it
        // "works in the WebView". It does *something* — it prints **this** document, and the
        // bar is drawn by `DesktopShell`, which mounts in the **launcher** window. So the
        // old row printed the desktop while the user was looking at a document in an app
        // window, and it could not report anything either way. The host owns "which window
        // is focused" and is the only side that can print it (`lib/print.ts`), so the row
        // goes through the shell's handle like every other window-acting row here.
        //
        // No keycap, for the reason `file.screenshot` gives: the **shell** binds no print chord
        // (`desktopKeys.ts`'s table has no `print` intent), so drawing ⌘P here would be exactly
        // the hint F-SH-038 forbids — advertising a key this shell does not match. macOS reaches
        // it anyway: the native File menu's accelerator is `CmdOrCtrl+P` and the OS owns that
        // chord. On Windows/Linux there is no native menu bar, so this row is the only entry —
        // recorded as the residual gap in F-SH-280 rather than papered over with a keycap.
        api?.printDocument();
      },
    },
    {
      id: "file.screenshot",
      labelKey: "desktop.menu.file.screenshot",
      run: () => {
        // REQ-A699: capture the screen into `~/Pictures/Screenshots` (the dir Photos
        // reads). No keycap: macOS reserves ⌘⇧3/4/5 and eats the chord before the
        // WebView sees it, so the menu row is the front door, not a binding. A refusal
        // (non-macOS, no home, tool absent, or the tool writing nothing) answers `null`
        // and is reported through the diagnostic ledger — never a silent no-op.
        void screenshotCapture().then((path) => {
          if (path === null) noteFailure("screenshot_capture", "", "topbar.file.screenshot");
        });
      },
    },
  ]);

  // ─── Edit ─────────────────────────────────────────────────────────────────────
  const editRows: MenuRow[] = [
    {
      id: "edit.copy",
      labelKey: "desktop.menu.edit.copy",
      shortcut: "⌘C",
      // REQ-A1213: this row kept the `catch(() => undefined)` that the three `wm_*` rows above
      // were cured of (see the `noteFailure` header) — the sweep that removed it missed the two
      // Edit rows. `invoke` resolves to `null` on a refusal instead of rejecting, so the `catch`
      // never ran and a refused copy (a selection over `MAX_TEXT_LEN`, or no bridge at all) was
      // silent: nothing on screen, and only the generic `backend` line in the ledger.
      run: async () => {
        const text = window.getSelection?.()?.toString() ?? "";
        if (text.length === 0) return;
        const entry = await clipboardWrite({ kind: "text", text }, "topbar.file.copy");
        if (entry === null) noteFailure("clipboard_write", "topbar.file.copy", "topbar.edit.copy");
      },
    },
    {
      id: "edit.paste",
      labelKey: "desktop.menu.edit.paste",
      shortcut: "⌘V",
      // Same dead `catch` as the copy row, plus one more turn of the screw: `clipboard_read`
      // answers `Ok(None)` for **an empty clipboard** as well as `Err(…)` for a refusal
      // (`require_foreground` denies a background window), and `invoke` folds both into `null`.
      // So the report cannot be keyed on `entry === null` — it goes through `noteFailure`, which
      // reads `bridgeDiag("clipboard_read")`: nothing copied yet is not a fault, and only a real
      // refusal (or a missing bridge) leaves a breadcrumb.
      run: async () => {
        const entry = await clipboardRead();
        if (entry === null) {
          noteFailure("clipboard_read", "", "topbar.edit.paste");
          return;
        }
        if (entry.payload.kind !== "text") return;
        const el = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
        if (!el) return;
        const start = el.selectionStart ?? el.value.length;
        const end = el.selectionEnd ?? el.value.length;
        el.value = el.value.slice(0, start) + entry.payload.text + el.value.slice(end);
        el.selectionStart = el.selectionEnd = start + entry.payload.text.length;
        el.dispatchEvent(new Event("input", { bubbles: true }));
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
  /**
   * The snapping rows (REQ-A816) — one per zone, **derived from the chord table**.
   *
   * Why here: snapping reached the host from exactly one place, the ⌃⌥ chords
   * (`DesktopShell` / `DesktopWindowKeys`), and this bar's Window menu is where a person looks
   * for "put this window on the left half". The rows are built by iterating
   * `lib/snapZones.ts`'s table rather than by writing nine of them out: a zone added there (and
   * therefore to `amos_wm::snap::SnapZone::ALL`, which a test pins the table against) appears in
   * this menu in the same commit, and a zone removed cannot leave a row that asks the host for a
   * region it refuses. The keycap column comes from the same table (`snapShortcutLabel`), for the
   * reason the File / Window rows' keycaps do: a hint is not translatable and must not outlive
   * the binding it names.
   *
   * `run` goes through the shell handle, never a `wm_snap` call from here: "which window is
   * focused" is owned by the shell's poll, and a row that resolved it itself would be a second
   * focus model (the F-SH-005 shape) — the same reason `windowAction` / `focusedWindowIntent`
   * exist. The shell then runs the chords' own `snapFocused`, so mouse and key cannot describe
   * the same command differently.
   *
   * Honest boundary: macOS nests these under a *Move & Resize* submenu; `MenuRow` is flat, so
   * this is a separated group of nine rows rather than a nested menu (a submenu is a separate
   * change to the bar's row model). Drag-to-screen-edge is **not** here at all — see the open gap
   * recorded in `docs/DESKTOP_AUDIT_2026_SEP21.md` §5.
   */
  const snapRows: MenuRow[] = SNAP_ZONES.map((zone, i) => ({
    id: `window.snap-${zone}`,
    labelKey: `desktop.menu.window.snap.${zone}`,
    shortcut: snapShortcutLabel(zone),
    separatorBefore: i === 0,
    run: () => api?.snapWindow(zone),
  }));

  const windowRows = $derived.by((): MenuRow[] => [
    {
      id: "window.minimize",
      labelKey: "desktop.menu.window.minimize",
      shortcut: desktopShortcutLabel("minimize-window", keyboardBindings.bindings.system),
      run: () => {
        // Same as File ▸ Close Window: the shell resolves the focused window and reports a
        // refusal. The host has no "the front window" idiom for an empty label, so the old
        // `wm_hide("")` was refused and the row did nothing.
        //
        // REQ-A724: the row is labelled *Minimize*, so it must minimize. It used to ask for
        // `hide-window`, which made this row and the ⌘M chord hide the window (leave the
        // model; the Dock's running dot goes dark) while the native Window ▸ Minimize item
        // called `wm_minimize`. All three surfaces now name the same intent.
        api?.focusedWindowIntent("minimize-window");
      },
    },
    { id: "window.zoom", labelKey: "desktop.menu.window.zoom", run: () => windowAction("zoom") },
    // REQ-A816: the nine zone rows (Left Half … Fill Screen), derived from `lib/snapZones.ts`.
    ...snapRows,
    // REQ-A1568: Stage Manager. macOS puts these in the Window menu too (its Stage Manager
    // switch lives in Control Center, and a menu is where this shell's users look for it);
    // the two rows go through the shell handle, never a command call from here, so the menu,
    // the ⌃⌘S chord and the rail's own Tidy button are one implementation each.
    //
    // The keycap comes from `lib/stageKeys.ts` — the table that actually binds it — for the
    // reason the File / Window rows' keycaps do. `Tidy` has **no** keycap: nothing binds it,
    // and a menu may not advertise a binding that does not exist (REQ-A342).
    {
      id: "window.stage-manager",
      labelKey: "desktop.menu.window.stageManager",
      shortcut: stageToggleLabel(),
      separatorBefore: true,
      run: () => api?.toggleStage(),
    },
    {
      id: "window.stage-tidy",
      labelKey: "desktop.menu.window.stageTidy",
      run: () => api?.tidyStage(),
    },
    {
      id: "window.bring-all",
      labelKey: "desktop.menu.window.bringAllToFrontUnavailable",
      // macOS separates "bring all" from the geometry rows above; the separator is here rather
      // than on the first snap row so that `snapRows` stays a plain view of the zone table.
      separatorBefore: true,
    },
  ]);

  // ─── Help ─────────────────────────────────────────────────────────────────────
  // REQ-A482: the Help menu was empty in the native bar, and the in-app bar had grey
  // rows with "unavailable" labels — nowhere for a user to go. Both rows now do something:
  // "Search Help" opens the Spotlight overlay (⌘? is already the spotlight shortcut), and
  // "Amos Help" opens Settings with Help selected.
  const helpRows: MenuRow[] = [
    {
      id: "help.search",
      labelKey: "desktop.menu.help.search",
      run: () => api?.openSpotlight(),
    },
    {
      id: "help.app",
      labelKey: "desktop.menu.help.amosHelp",
      run: () => {
        void wmRun("wm_open", "settings", "help.amos-help");
      },
    },
  ];

  // Derived too: it *references* the two derived row lists above, so a rebind has to re-evaluate
  // this list as well or the template would keep iterating the frozen pair (REQ-A1309 / F-SH-583).
  const GROUPS = $derived.by((): MenuGroup[] => [
    { id: "file", titleKey: "desktop.menu.file", rows: fileRows },
    { id: "edit", titleKey: "desktop.menu.edit", rows: editRows },
    { id: "view", titleKey: "desktop.menu.view", rows: viewRows },
    { id: "window", titleKey: "desktop.menu.window", rows: windowRows },
    { id: "help", titleKey: "desktop.menu.help", rows: helpRows },
  ]);

  let openId = $state<MenuGroup["id"] | null>(null);
  let wrapEl = $state<HTMLElement | null>(null);
  /** The open panel (`{#if openId === …}` means at most one exists), for REQ-A436's keys. */
  let panelEl = $state<HTMLElement | null>(null);

  // REQ-A436: the bar's menus are keyboard usable — the shared layer walks the rows with the
  // arrows / Home / End, hands Escape to *this* menu's closer, and puts the focus **back on this
  // menu's title**. Without that last half, Escape deleted the panel out from under the focused
  // row, the browser parked focus on `<body>`, and the bar's ←/→ ring went deaf (a key dispatched
  // at `<body>` never bubbles through the bar) — macOS leaves the menu title focused.
  //
  // The title is looked up by the group that was open, captured *before* the state is cleared:
  // `openId` is already gone by the time the callback runs. It is also why this is not derivable
  // from the panel — the trigger is the panel's sibling, outside the `{#if}`.
  $effect(() => {
    if (!panelEl || !openId) return;
    const group = openId;
    return installMenuKeyboard(panelEl, {
      onClose: () => (openId = null),
      restoreFocusTo: () =>
        wrapEl?.querySelector<HTMLElement>(`[data-testid="menu-${group}-trigger"]`) ?? null,
    });
  });

  // …and the bar walks sideways too, but **that axis is not this component's**: 🍎 is a sibling
  // registry widget, and the ring spans both. `TopBar` owns it over the slot that holds them
  // (`lib/menuKeys.ts::installTopBarMenuAxis`). It used to live here, over this `<nav>` — which is
  // exactly why ← from File wrapped past 🍎 to the last menu instead of opening 🍎.

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

  /**
   * A row's accessible name is its label, and unavailability is told by the row's own state.
   *
   * REQ-A1548 (F-SH-788): this used to append the hardcoded English `" — unavailable"`, so the
   * Edit ▸ Undo / Window ▸ Bring All rows announced 「撤销 — unavailable」 in *every* locale. That
   * contradicts the dictionary these keys live in (`zh.ts` beside `…UndoUnavailable`:
   * 「不可用由行状态表达，不在文字里重复说一遍」) and the sibling menus, which either pass the
   * label through unchanged (`TopbarAppleMenu`) or reach for a **translated** sentence
   * (`DockContextMenu`'s `desktop.dockCtxOptionsUnavailable`). `disabled` + `aria-disabled="true"`
   * already carry the fact, so the visible text and the name now read the same string.
   */
  function rowName(row: MenuRow): string {
    return t(row.labelKey!);
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
              aria-label={rowName(row)}
              title={rowName(row)}
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
