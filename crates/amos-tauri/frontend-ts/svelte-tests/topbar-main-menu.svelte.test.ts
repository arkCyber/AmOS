/**
 * topbar-main-menu.svelte.test.ts — the menu bar's **shortcut column** (REQ-A342).
 *
 * `TopbarMainMenu.svelte` had no test file of its own until this round, and the first three cases
 * found a defect that was visible on screen and invisible to every gate:
 *
 *   The column read each row's keycap from an **i18n key** (`desktop.menu.file.closeWindowShortcut`).
 *   Those keys do not exist in either locale, and `translate()` falls back to `raw ?? key` — so the
 *   menu was printing the *key name itself* next to "关闭窗口". `i18n-scan` cannot see that: its
 *   documented boundary is that it does not evaluate runtime expressions, and `t(row.shortcutKey)`
 *   is one.
 *
 * The fix is not "add the five strings": a keycap is not translatable, and a second list of them
 * would drift from the table that actually binds the keys. So the cases below pin two properties:
 *   * a row whose key the shell binds shows the keycap **derived from `lib/desktopKeys.ts`**;
 *   * a row whose key nothing binds shows **no** keycap — a menu may not advertise a binding that
 *     does not exist (the same defect `desktop-shell.svelte.test.ts`'s header records from an
 *     earlier round, when a tooltip claimed F4 while nothing bound it).
 */
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import DesktopShell from "../src/svelte/DesktopShell.svelte";
import { DESKTOP_SYSTEM_KEYS, desktopShortcutLabel } from "../src/lib/desktopKeys";
import { formatShortcut } from "../src/lib/shellModule";
import { resetEditableFocusForTest, trackEditableFocus } from "../src/lib/editKeys";
import { clearDiag, recentDiag } from "../src/lib/debugLog";
import { zh } from "../src/i18n/locales/zh";

/** Did the diagnostic ring record a message containing `needle`? (The observable side of a refusal.) */
const diagSaid = (needle: string) => recentDiag(200).some((e) => e.msg.includes(needle));

/**
 * The app installs the editable-focus tracker in `shell-entry.ts` at boot (REQ-A439); a harness
 * that exercises an Edit ▸ Select All row has to model that, or the row is being tested against a
 * page that never remembers what the user was editing.
 */
beforeAll(() => {
  trackEditableFocus();
});
afterEach(() => {
  resetEditableFocusForTest();
});

const DESKTOP_SNAPSHOT = {
  screen_w: 1496,
  screen_h: 882,
  split: null,
  candidates: [],
  form: "desktop",
  columns: 4,
  multi_window: true,
  free_resize: true,
  divider_gap: 8,
};

const settle = () => new Promise((r) => setTimeout(r, 40));

/** Commands the shell sent to the host, in order (the event test reads this). */
const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];

/** The smallest host the desktop shell needs: the layout snapshot, the window poll, listeners. */
function installHost(windows: unknown[] = []) {
  const listeners = new Map<string, (e: { payload: unknown }) => void>();
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "wm_layout_snapshot") return DESKTOP_SNAPSHOT;
      if (cmd === "wm_windows") return { windows };
      calls.push({ cmd, args });
      // The four/five window mutations answer with a `WmSnapshot` on the real host, and
      // `lib/wm.ts` reads that as "it landed" (`result !== null`) — answering `null`
      // here would model a refusal and make the shell log one (REQ-A415).
      if (
        cmd === "wm_open" ||
        cmd === "wm_close" ||
        cmd === "wm_hide" ||
        cmd === "wm_minimize" ||
        cmd === "wm_focus" ||
        cmd === "wm_zoom" ||
        cmd === "wm_fullscreen"
      ) {
        return { windows };
      }
      return null;
    },
    listen: async (channel: string, handler: (e: { payload: unknown }) => void) => {
      listeners.set(channel, handler);
      return () => listeners.delete(channel);
    },
  };
  return {
    /** Emit a host event (what the Rust side does) so a test can prove someone listens. */
    emit: (channel: string, payload: unknown) => listeners.get(channel)?.({ payload }),
  };
}

beforeAll(() => window.localStorage.clear());
afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

/** Open one menu group and return its panel. */
async function openGroup(container: HTMLElement, group: string) {
  await fireEvent.click(container.querySelector<HTMLElement>(`[data-testid="menu-${group}-trigger"]`)!);
  await tick();
  return container.querySelector<HTMLElement>(`[data-testid="menu-${group}-panel"]`)!;
}

const rowText = (panel: HTMLElement, group: string, id: string) =>
  panel.querySelector<HTMLElement>(`[data-testid="menu-${group}-${id}"]`)?.textContent?.trim() ?? "";


describe("TopbarMainMenu — the shortcut column (REQ-A342)", () => {
  test("keycaps come from the binding table, never from an i18n key", async () => {
    installHost([{ label: "files", kind: "App", state: "Focused", focused: true }]);
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    const file = await openGroup(container, "file");
    const close = rowText(file, "file", "file.close");
    expect(close, "the row is rendered").toContain(zh["desktop.menu.file.closeWindow"]);
    // The literal keycap, not "whatever the helper returns": comparing the row against the same
    // helper it renders with would be circular (the first version of this case was, and the
    // injection proved it: returning "" from the helper kept it green). The user-visible truth is
    // macOS's spelling, so that is what is asserted — and the *pairing* (row ↔ intent ↔ table row)
    // is pinned in the next case.
    expect(close).toContain("⌘W");
    expect(close, "no raw i18n key leaks onto the screen").not.toContain("desktop.menu");

    const win = await openGroup(container, "window");
    expect(rowText(win, "window", "window.minimize")).toContain("⌘M");
    expect(rowText(win, "window", "window.minimize")).not.toContain("desktop.menu");
  });

  test("every shell-bound row agrees with the table (the menu cannot drift from the engine)", async () => {
    installHost([]);
    const { container } = render(DesktopShell);
    await tick();
    await settle();
    // The pairing matters: a row may not point at the wrong intent, and if the table changes a key
    // the menu changes with it (both go through the table's own display function).
    const pairs: Array<[string, string, string]> = [
      ["file", "file.close", "close-window"],
      ["window", "window.minimize", "minimize-window"],
    ];
    for (const [group, id, intent] of pairs) {
      const panel = await openGroup(container, group);
      const text = rowText(panel, group, id);
      expect(text, `${id} shows its own intent's keycap`).toContain(desktopShortcutLabel(intent));
      // …and the case is macOS's: the table stores "w" (so matching stays case-insensitive) while
      // the menu writes "W".
      const row = DESKTOP_SYSTEM_KEYS.find((r) => r.intent.kind === intent)!;
      expect(text).toContain(
        formatShortcut({ ...row.shortcut, key: row.shortcut.key.toUpperCase() }),
      );
    }
  });

  // The mirror image of the two cases above, and it is the half that had no test until now:
  // **a row the shell binds nothing for must show no keycap**. `file.print` is exactly such a row —
  // macOS reaches Print through the *native* menu's own `CmdOrCtrl+P` accelerator and Windows/Linux
  // have no chord at all (the residual gap recorded as F-SH-280), so drawing ⌘P here would be the
  // hint F-SH-038 forbids: advertising a key this shell does not match (`file.screenshot` set the
  // precedent). Two-sided on purpose — the same panel is asked for a row that *does* carry a
  // binding, so "no keycap" cannot pass by the row (or the read) rendering nothing at all.
  test("a row with no binding draws no keycap, while its neighbour does (REQ-A869 / F-SH-280)", async () => {
    installHost([]);
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    const file = await openGroup(container, "file");
    const print = rowText(file, "file", "file.print");
    expect(print, "the row is rendered").toContain(zh["desktop.menu.file.print"]);
    // Every keycap this shell's own table can draw, held against this row: none belongs to it. The
    // table is the authority for what a keycap looks like, so this asserts against the same
    // spellings the menu would draw if the row ever acquired a binding.
    for (const row of DESKTOP_SYSTEM_KEYS) {
      expect(print, `file.print must not advertise ${row.intent.kind}`).not.toContain(
        formatShortcut({ ...row.shortcut, key: row.shortcut.key.toUpperCase() }),
      );
    }
    expect(print, "no keycap glyph at all on this row").not.toContain("⌘");

    // …and the same panel does draw one for the row beside it, so the absence above is a fact
    // about `file.print` rather than about `rowText`/`openGroup` returning an empty string.
    expect(rowText(file, "file", "file.close"), "the neighbour's keycap is drawn").toContain("⌘W");
  });

  test("the File → New Window row advertises its binding (REQ-A473, REQ-A482)", async () => {
    installHost([]);
    const { container } = render(DesktopShell);
    await tick();
    await settle();
    const file = await openGroup(container, "file");
    const row = rowText(file, "file", "file.new-window");
    expect(row, "the row still exists and works by click").toContain(
      zh["desktop.menu.file.newWindow"],
    );
    // REQ-A473: the new-window shortcut is now wired (per-app "New Window").
    expect(row).toContain("⌘N");
    expect(row).not.toContain("desktop.menu");
  });

  test("the host's native-menu activations have a consumer again (REQ-A342)", async () => {
    // `crates/amos-tauri/src/menu.rs` emits `menu-event` with the item id. For a while nothing in
    // the frontend listened **and** `DesktopShell` imported a subscriber that no longer existed —
    // so the menu bar's items did nothing *and* the shell could not mount. This case pins the
    // outcome: an emitted id reaches the command the shell maps it to.
    calls.length = 0;
    const host = installHost([]);
    render(DesktopShell);
    await tick();
    await settle();

    host.emit("menu-event", "menu.preferences");
    await tick();
    await settle();
    expect(
      calls.some((c) => c.cmd === "wm_open" && (c.args as { label?: string })?.label === "settings"),
      "⌘, from the native menu opens the Settings window",
    ).toBe(true);
  });

  /**
   * REQ-A439 — the shell's **own** Edit menu row. It used to dispatch a synthetic
   * `KeyboardEvent("keydown", {key:"a", metaKey:true})`, which selects nothing (a synthetic event
   * has no default action, and no consumer). It now calls the shared rule — and the row taking DOM
   * focus must not erase the field the user is editing (`lib/editKeys.ts`, the menu-row rule).
   *
   * The **native** Edit ▸ Select All row is the platform's own (`select_all_with_text`, localized
   * text, platform selector) and works on click; its ⌘A accelerator is a measured platform gap —
   * see `docs/mac-menu.md` §6 and `lib/editKeys.ts`.
   */
  test("the in-app Edit ▸ Select All row selects the field the user was editing", async () => {
    installHost([]);
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    const field = document.createElement("input");
    field.value = "in-app-row";
    document.body.append(field);
    field.focus();

    const panel = await openGroup(container, "edit");
    await fireEvent.click(
      panel.querySelector<HTMLElement>('[data-testid="menu-edit-edit.select-all"]')!,
    );
    await tick();

    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe("in-app-row".length);
    field.remove();
  });

  test("the Window menu's Zoom and Enter Full Screen really act on the focused window (REQ-A415)", async () => {
    // Both rows used to be explicit **no-ops** in `DesktopShell` (their comments said
    // "No `wm_zoom` — leave as a no-op for now" / "not exposed as a command yet"), so the
    // macOS Window menu offered two items that did nothing. The host has the commands
    // now; these cases pin that the activation reaches them with the *focused* label.
    calls.length = 0;
    const host = installHost([{ label: "notes", kind: "App", state: "Focused", focused: true }]);
    render(DesktopShell);
    await tick();
    await settle(); // let the mount-time `wm_windows` read set `focusedWindowLabel`

    host.emit("menu-event", "menu.zoom");
    await tick();
    await settle();
    expect(
      calls.some((c) => c.cmd === "wm_zoom" && c.args?.label === "notes"),
      "Zoom must reach wm_zoom with the focused window",
    ).toBe(true);

    calls.length = 0;
    host.emit("menu-event", "menu.enter-fullscreen");
    await tick();
    await settle();
    expect(
      calls.some((c) => c.cmd === "wm_fullscreen" && c.args?.label === "notes"),
      "Enter Full Screen must reach wm_fullscreen with the focused window",
    ).toBe(true);
  });

  test("with nothing focused (or only the launcher) the geometry menu items send no command", async () => {
    // The two rows act on the focused window. With no focused app there is nothing to
    // zoom, and `main` is the launcher itself — sending `wm_zoom("main")` would resize the
    // shell window the whole desktop lives in (the F-SH-008 shape, one menu item over).
    calls.length = 0;
    const host = installHost([{ label: "main", kind: "Launcher", state: "Focused", focused: true }]);
    render(DesktopShell);
    await tick();
    await settle();

    host.emit("menu-event", "menu.zoom");
    host.emit("menu-event", "menu.enter-fullscreen");
    await tick();
    await settle();
    expect(calls.filter((c) => c.cmd === "wm_zoom" || c.cmd === "wm_fullscreen")).toEqual([]);
  });

  /**
   * REQ-A757 — the native Window ▸ Minimize item must report a host refusal, like the ⌘M chord
   * and the in-app Window ▸ Minimize row already do.
   *
   * `DesktopShell`'s `menu.minimize` branch was the **fourth** implementation of minimize: it
   * called `wmMinimize(label)` directly and dropped the returned boolean, so a host refusal — the
   * real one is a split pane, `wm.rs::minimize_target`'s "window '{label}' is in a split — exit
   * the split before minimizing" — was swallowed while the other two surfaces logged it. It also
   * re-stated the launcher-skip rule inline (`mlabel !== "main"`) that `actionableLabelOf` owns.
   * The fix routes it through `focusedWindowIntent("minimize-window")`, the same path ⌘M takes.
   *
   * The refusal is the discriminator: `wmMinimize` (the old call) is silent on failure, so before
   * the fix nothing reached the ring — this case is red. After the fix the shell goes through
   * `reportIntentOutcome` and writes `refusedChordMessage`.
   */
  test("the native Window ▸ Minimize item reports a host refusal (REQ-A757)", async () => {
    calls.length = 0;
    const host = installHost([{ label: "notes", kind: "App", state: "Focused", focused: true }]);
    // Make the host **refuse** `wm_minimize` (answer `null`), which `lib/wm.ts` reads as a
    // failure — this is the split-pane refusal from the host's chair.
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: Function } })
      .__TAURI_INTERNALS__;
    const inner = internals.invoke;
    internals.invoke = async (cmd: string, args?: Record<string, unknown>) => {
      // Record it here: the `calls.push` inside `installHost` runs in the *inner* invoke,
      // which this wrapper bypasses for `wm_minimize`.
      if (cmd === "wm_minimize") {
        calls.push({ cmd, args });
        return null;
      }
      return inner(cmd, args);
    };

    render(DesktopShell);
    await tick();
    await settle(); // let the mount-time `wm_windows` read set `focusedWindowLabel`

    clearDiag();
    host.emit("menu-event", "menu.minimize");
    await tick();
    await settle();
    expect(
      calls.some((c) => c.cmd === "wm_minimize" && c.args?.label === "notes"),
      "the item still reaches wm_minimize with the focused window",
    ).toBe(true);
    expect(
      diagSaid("the host refused to minimize `notes`"),
      "a refused minimize must not be silent (REQ-A430)",
    ).toBe(true);
  });

  test("Window ▸ Minimize on the launcher sends no command (the F-SH-008 rule survives the rework)", async () => {
    // The refactor dropped the inline `mlabel !== "main"` check; the rule now lives only in
    // `actionableLabelOf`. This pins that it is still applied — "main" is the desktop itself.
    calls.length = 0;
    const host = installHost([{ label: "main", kind: "Launcher", state: "Focused", focused: true }]);
    render(DesktopShell);
    await tick();
    await settle();

    clearDiag();
    host.emit("menu-event", "menu.minimize");
    await tick();
    await settle();
    expect(calls.filter((c) => c.cmd === "wm_minimize")).toEqual([]);
    // …and the launcher-only case is the "nothing to act on" dead chord, not a refusal.
    expect(diagSaid("⌘M did nothing")).toBe(true);
  });

  /**
   * REQ-A457 — the **in-app** menu's two window rows.
   *
   * They hold a different promise from the native items above: on a platform with no native
   * menu bar (`wm.rs::install` is macOS-only), this bar **is** the menu, so a row drawn as
   * "unavailable" is the only way to reach the command there — and it was drawn that way long
   * after `wm_zoom`/`wm_fullscreen` existed, i.e. the two menu surfaces of the *same* shell
   * disagreed about what the shell can do. These cases drive the row itself (open the group,
   * click the row), so the wiring they pin is the one a user touches.
   */
  test("the in-app Window ▸ Zoom / View ▸ Enter Full Screen rows reach the host (REQ-A457)", async () => {
    calls.length = 0;
    installHost([{ label: "notes", kind: "App", state: "Focused", focused: true }]);
    const { container } = render(DesktopShell);
    await tick();
    await settle(); // the mount-time `wm_windows` read is what fills `focusedWindowLabel`

    const win = await openGroup(container, "window");
    const zoomRow = win.querySelector<HTMLElement>('[data-testid="menu-window-window.zoom"]')!;
    // A **live** row, not the greyed placeholder it used to be (`disabled` + no handler).
    expect(zoomRow.getAttribute("aria-disabled")).toBeNull();
    expect(zoomRow.textContent ?? "").toContain(zh["desktop.menu.window.zoom"]);
    await fireEvent.click(zoomRow);
    await tick();
    await settle();
    expect(
      calls.some((c) => c.cmd === "wm_zoom" && c.args?.label === "notes"),
      "the in-app Zoom row must reach wm_zoom with the focused window",
    ).toBe(true);

    calls.length = 0;
    const view = await openGroup(container, "view");
    const fsRow = view.querySelector<HTMLElement>('[data-testid="menu-view-view.fullscreen"]')!;
    expect(fsRow.getAttribute("aria-disabled")).toBeNull();
    expect(fsRow.textContent ?? "").toContain(zh["desktop.menu.view.enterFullScreen"]);
    await fireEvent.click(fsRow);
    await tick();
    await settle();
    expect(
      calls.some((c) => c.cmd === "wm_fullscreen" && c.args?.label === "notes"),
      "the in-app Enter Full Screen row must reach wm_fullscreen with the focused window",
    ).toBe(true);
  });

  test("the in-app File ▸ Close / Window ▸ Minimize rows reach the host with the FOCUSED label", async () => {
    // The same shape as the geometry rows above, and the same bug: both rows sent an
    // **empty** label (`wmRun("wm_close", "")`), and the host resolves a window by label
    // (`wm.rs::close_core` / `hide` → `by_label.get(label)`), so an empty label is a look-up
    // that cannot hit — the row looked live and did nothing. They go through the shell's
    // `focusedWindowIntent` now, which resolves the focus the shell already tracks.
    calls.length = 0;
    installHost([{ label: "notes", kind: "App", state: "Focused", focused: true }]);
    const { container } = render(DesktopShell);
    await tick();
    await settle(); // the mount-time `wm_windows` read is what fills `focusedWindowLabel`

    const file = await openGroup(container, "file");
    await fireEvent.click(
      file.querySelector<HTMLElement>('[data-testid="menu-file-file.close"]')!,
    );
    await tick();
    await settle();
    expect(
      calls.some((c) => c.cmd === "wm_close" && c.args?.label === "notes"),
      "Close Window must reach wm_close with the focused label, not an empty one",
    ).toBe(true);

    calls.length = 0;
    const win = await openGroup(container, "window");
    await fireEvent.click(
      win.querySelector<HTMLElement>('[data-testid="menu-window-window.minimize"]')!,
    );
    await tick();
    await settle();
    // REQ-A724: *Minimize* must minimize (wm_minimize), not hide — the row was labelled
    // Minimize but sent wm_hide, so it disagreed with the native menu item and with ⌘M.
    expect(
      calls.some((c) => c.cmd === "wm_minimize" && c.args?.label === "notes"),
      "Minimize must reach wm_minimize with the focused label, not an empty one",
    ).toBe(true);
    expect(
      calls.some((c) => c.cmd === "wm_hide"),
      "and it must NOT hide the window (that is ⌘H / Window ▸ Hide)",
    ).toBe(false);
  });

  /**
   * REQ-A816 — the Window menu's snapping rows.
   *
   * Snapping reached the host from exactly one place: the ⌃⌥ chords. This is the mouse front
   * door, and the properties worth pinning are the ones that can rot silently — the **row ↔
   * zone** pairing (ids are derived from `lib/snapZones.ts`, so a shift in the table must not
   * silently re-point a row at its neighbour), the **label and keycap** (which must name the
   * region and the chord that really matches it), and that a click lands on `wm_snap` with the
   * **focused** label from the shell's own poll.
   *
   * The expectations below are written out literally rather than derived from `SNAP_KEYS`:
   * asserting a row against the same helper it renders with is circular, and this file's own
   * header records a round where exactly that kept a broken keycap column green.
   */
  const SNAP_ROWS = [
    { zone: "left", key: "desktop.menu.window.snap.left", keycap: "⌃⌥←" },
    { zone: "right", key: "desktop.menu.window.snap.right", keycap: "⌃⌥→" },
    { zone: "top", key: "desktop.menu.window.snap.top", keycap: "⌃⌥↑" },
    { zone: "bottom", key: "desktop.menu.window.snap.bottom", keycap: "⌃⌥↓" },
    { zone: "top-left", key: "desktop.menu.window.snap.top-left", keycap: "⌃⌥U" },
    { zone: "top-right", key: "desktop.menu.window.snap.top-right", keycap: "⌃⌥I" },
    { zone: "bottom-left", key: "desktop.menu.window.snap.bottom-left", keycap: "⌃⌥J" },
    { zone: "bottom-right", key: "desktop.menu.window.snap.bottom-right", keycap: "⌃⌥K" },
    { zone: "maximize", key: "desktop.menu.window.snap.maximize", keycap: "⌃⌥↩" },
  ] as const;

  test("Window ▸ a zone row snaps the focused window: the row, its label and its chord agree", async () => {
    calls.length = 0;
    installHost([{ label: "notes", kind: "App", state: "Focused", focused: true }]);
    const { container } = render(DesktopShell);
    await tick();
    await settle(); // the mount-time `wm_windows` read is what fills `focusedWindowLabel`

    // A click on one row reaches the host with the focused label and **that row's** zone —
    // asserted at both ends of the table so an off-by-one in the derived ids cannot hide.
    // (Each click closes the menu, which is why the panel is re-opened every time.)
    for (const zone of ["right", "maximize"] as const) {
      calls.length = 0;
      const panel = await openGroup(container, "window");
      await fireEvent.click(
        panel.querySelector<HTMLElement>(`[data-testid="menu-window-window.snap-${zone}"]`)!,
      );
      await tick();
      await settle();
      expect(
        calls.filter((c) => c.cmd === "wm_snap"),
        `the ${zone} row must ask for ${zone} on the focused window`,
      ).toEqual([{ cmd: "wm_snap", args: { label: "notes", zone } }]);
    }

    const win = await openGroup(container, "window");
    for (const { zone, key, keycap } of SNAP_ROWS) {
      const row = win.querySelector<HTMLElement>(`[data-testid="menu-window-window.snap-${zone}"]`);
      expect(row, `the menu has a row for ${zone}`).not.toBeNull();
      // Live, not a greyed placeholder: every one of these has a `run`.
      expect(row!.getAttribute("aria-disabled"), `${zone} is live`).toBeNull();
      const text = row!.textContent ?? "";
      expect(text, `${zone} shows its translated name`).toContain(zh[key]);
      expect(text, `${zone} shows the chord that really snaps it`).toContain(keycap);
      // …and the raw i18n key never reaches the screen (the defect this file was written for).
      expect(text, `${zone} leaks no raw key`).not.toContain("desktop.menu");
    }
  });

  test("the in-app rows send nothing when the launcher is the only window (same F-SH-008 rule)", async () => {
    calls.length = 0;
    installHost([{ label: "main", kind: "Launcher", state: "Focused", focused: true }]);
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    await fireEvent.click(
      (await openGroup(container, "window")).querySelector<HTMLElement>(
        '[data-testid="menu-window-window.zoom"]',
      )!,
    );
    await tick();
    await settle();
    // REQ-A816: the snapping rows take the chords' own `snapFocused`, so this rule covers them
    // too — a zone row pressed with only the launcher up must send nothing, exactly as ⌃⌥← does.
    await fireEvent.click(
      (await openGroup(container, "window")).querySelector<HTMLElement>(
        '[data-testid="menu-window-window.snap-left"]',
      )!,
    );
    await tick();
    await settle();
    await fireEvent.click(
      (await openGroup(container, "view")).querySelector<HTMLElement>(
        '[data-testid="menu-view-view.fullscreen"]',
      )!,
    );
    await tick();
    await settle();
    // One implementation, so the rule cannot differ between the two surfaces: the launcher
    // *is* the desktop and resizing it is not what the user asked for.
    expect(
      calls.filter((c) => c.cmd === "wm_zoom" || c.cmd === "wm_fullscreen" || c.cmd === "wm_snap"),
    ).toEqual([]);
  });

  test("the platform's own bindings are shown as keycaps, never as i18n keys", async () => {
    installHost([]);
    const { container } = render(DesktopShell);
    await tick();
    await settle();
    const edit = await openGroup(container, "edit");
    for (const [id, keys] of [
      ["edit.copy", "⌘C"],
      ["edit.paste", "⌘V"],
      ["edit.select-all", "⌘A"],
    ] as const) {
      const text = rowText(edit, "edit", id);
      expect(text, `${id} shows its platform keycap`).toContain(keys);
      expect(text).not.toContain("desktop.menu");
    }
  });

  // REQ-A482: Help menu was empty in native bar, grey "unavailable" rows in in-app bar.
  // Both rows now do something: "Search Help" opens Spotlight, "Amos Help" opens Settings.
  test("the Help menu rows are live (REQ-A482)", async () => {
    calls.length = 0;
    installHost([]);
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    const help = await openGroup(container, "help");

    // "Search Help" is a live row (opens Spotlight overlay).
    const searchRow = help.querySelector<HTMLElement>(
      '[data-testid="menu-help-help.search"]',
    )!;
    expect(searchRow.getAttribute("aria-disabled")).toBeNull();
    expect(searchRow.textContent ?? "").toContain(zh["desktop.menu.help.search"]);

    // "Amos Help" is a live row (opens Settings).
    const amosRow = help.querySelector<HTMLElement>(
      '[data-testid="menu-help-help.app"]',
    )!;
    expect(amosRow.getAttribute("aria-disabled")).toBeNull();
    expect(amosRow.textContent ?? "").toContain(zh["desktop.menu.help.amosHelp"]);
  });

  // REQ-A869 (was REQ-A482): this case used to assert that the row calls `window.print()`, and
  // that assertion was pinning a defect rather than a contract. `window.print()` acts on **the
  // document that calls it**, and this bar is drawn by `DesktopShell` — which mounts in the
  // *launcher* window (`Shell.svelte`: `{#if s.kind === "app"} DesktopAppWindow {:else}
  // DesktopShell`) while the shell's only `menu-event` subscriber. So the old row printed the
  // desktop while the user was looking at a document, and it could not report a refusal either.
  // Two-sided now: the DOM call must **not** happen, and the host command must.
  //
  // The mock host below answers `null` for `print_document` (it models only the layout/poll and
  // the window geometry commands), which is the *refusal* branch — the success branch and the
  // three `amos.print.*` reason sentences are pinned in `src/lib/__tests__/print.test.ts`.
  test("the File → Print row asks the host and never prints the launcher (REQ-A869)", async () => {
    calls.length = 0;
    installHost([{ label: "files", kind: "App", state: "Focused", focused: true }]);
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    // Spy on window.print — the call the row must no longer make.
    let printCalled = false;
    const origPrint = window.print;
    (window as unknown as { print?: () => void }).print = () => { printCalled = true; };

    clearDiag();
    const file = await openGroup(container, "file");
    const printRow = file.querySelector<HTMLElement>(
      '[data-testid="menu-file-file.print"]',
    )!;
    expect(printRow.getAttribute("aria-disabled")).toBeNull();
    await fireEvent.click(printRow);
    await tick();
    await settle();

    expect(
      calls.filter((c) => c.cmd === "print_document"),
      "the row asks the host, once",
    ).toHaveLength(1);
    // A zero-argument command: the shell cannot name a window the host might not agree is
    // focused (F-SH-008 — the launcher is never a target).
    expect(calls.find((c) => c.cmd === "print_document")?.args).toBeUndefined();
    expect(printCalled, "the launcher's own document must never be printed").toBe(false);
    // …and a host answer this shell cannot read is reported rather than swallowed.
    expect(diagSaid("print"), "a refused print is on the diagnostic ring").toBe(true);

    // Restore.
    (window as unknown as { print?: () => void }).print = origPrint;
  });

  // REQ-A869: the same command from the *native* menu item (⌘P on macOS) — the id is declared in
  // `menu.rs`'s `ALL` and must have a case in the shell's switch (`desktopKeys.test.ts` pins that
  // pairing; this case pins that the case *does* something).
  test("the native Print item reaches the host, not window.print() (REQ-A869)", async () => {
    calls.length = 0;
    const host = installHost([{ label: "files", kind: "App", state: "Focused", focused: true }]);
    render(DesktopShell);
    await tick();
    await settle();

    let printCalled = false;
    const origPrint = window.print;
    (window as unknown as { print?: () => void }).print = () => { printCalled = true; };

    host.emit("menu-event", "menu.print");
    await tick();
    await settle();

    expect(calls.filter((c) => c.cmd === "print_document")).toHaveLength(1);
    expect(printCalled, "the native item must not print the launcher either").toBe(false);

    (window as unknown as { print?: () => void }).print = origPrint;
  });

  // REQ-A482: native macOS menu "Search Help" and "Amos Help" events reach the shell.
  test("the native menu's Help events reach the shell (REQ-A482)", async () => {
    calls.length = 0;
    const host = installHost([]);
    render(DesktopShell);
    await tick();
    await settle();

    host.emit("menu-event", "menu.search-help");
    await tick();
    // Search Help → openSpotlight (no host call, just the shell overlay).
    // Verify the shell handled it without error (no crash, no unhandled event).
    expect(calls.filter((c) => c.cmd === "wm_open")).toEqual([]);

    host.emit("menu-event", "menu.amos-help");
    await tick();
    expect(
      calls.some((c) => c.cmd === "wm_open" && (c.args as { label?: string })?.label === "settings"),
      "Amos Help from native menu opens Settings",
    ).toBe(true);
  });
});

describe("TopbarMainMenu — the menu bar walks sideways with ← / → (macOS parity)", () => {
  /** The group whose panel is currently mounted, or `null`. */
  const openGroupId = (container: HTMLElement): string | null =>
    container.querySelector<HTMLElement>('[data-testid^="menu-"][data-testid$="-panel"]')
      ?.dataset.testid?.replace(/^menu-/, "").replace(/-panel$/, "") ?? null;

  /** Press a key on whatever currently has focus and let Svelte flush. */
  async function press(key: string) {
    await fireEvent.keyDown(document.activeElement ?? document.body, { key });
    await tick();
  }

  test("ArrowRight opens the next top-level menu, ArrowLeft the previous (wrapping)", async () => {
    installHost([]);
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    await openGroup(container, "file");
    // macOS opens a menu with its first row focused; the arrow then belongs to the *menubar*,
    // not to the row list, because ←/→ are not row-movement keys.
    expect(openGroupId(container)).toBe("file");
    expect(document.activeElement?.getAttribute("data-testid")).toBe("menu-file-file.new-window");

    await press("ArrowRight");
    expect(openGroupId(container), "the neighbour opened, the original closed").toBe("edit");

    await press("ArrowRight");
    expect(openGroupId(container)).toBe("view");

    await press("ArrowLeft");
    expect(openGroupId(container)).toBe("edit");

    // From the first *app* menu, ArrowLeft reaches 🍎 — the bar's actual first menu, owned by the
    // sibling widget. This case used to assert `help` here ("wraps to the last one"), which was the
    // defect rather than the rule: the ring only spanned this component's five groups, so it could
    // not see 🍎 at all. The wrap itself is still real, one step further out (🍎 → ↑ see the
    // "ONE bar" describe below, which pins both halves).
    await openGroup(container, "file");
    await press("ArrowLeft");
    expect(openGroupId(container), "← from 文件 reaches 🍎, it does not skip it").toBeNull();
    expect(container.querySelector('[data-testid="apple-menu-panel"]')).not.toBeNull();
  });

  // The other half of "the axes do not fight", and the one that decides which key belongs to whom:
  // **Home/End stay with the row axis**. Focus is *inside* an open menu, so the APG menu pattern's
  // Home/End (first/last row) apply — not the menubar's (first/last menu). Two layers claiming one
  // keypress is what `nextMenuBarIndex`'s `null` prevents, and this case is what pins that it was
  // not merely omitted by accident.
  test("Home and End stay inside the open menu (the row axis owns them, not the bar)", async () => {
    installHost([]);
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    await openGroup(container, "view");
    await press("Home");
    expect(openGroupId(container), "Home did not switch menus").toBe("view");
    expect(document.activeElement?.getAttribute("data-testid")).toBe(
      "menu-view-view.toggle-wallpaper",
    );

    await press("End");
    expect(openGroupId(container), "End did not switch menus").toBe("view");
    expect(document.activeElement?.getAttribute("data-testid")).toBe("menu-view-view.fullscreen");
  });

  test("the sideways move focuses the new panel's first row, so the arrows keep working", async () => {
    installHost([]);
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    await openGroup(container, "file");
    await press("ArrowRight");
    await tick();
    expect(document.activeElement?.getAttribute("data-testid")).toBe("menu-edit-edit.copy");

    // …and the row walk still works from there: the two axes do not fight.
    await press("ArrowDown");
    expect(openGroupId(container), "Down stays inside the open menu").toBe("edit");
    expect(document.activeElement?.getAttribute("data-testid")).toBe("menu-edit-edit.paste");
  });
});

describe("the menu bar is ONE bar — 🍎 is in the sideways ring too (macOS parity)", () => {
  /** The trigger that currently reports itself open, by testid, or `null`. */
  const openTriggerId = (container: HTMLElement): string | null =>
    container.querySelector<HTMLElement>('[data-testid$="-trigger"][aria-expanded="true"]')?.dataset
      .testid ?? null;

  const panelOpen = (container: HTMLElement, testid: string) =>
    container.querySelector(`[data-testid="${testid}"]`) !== null;

  async function press(key: string) {
    await fireEvent.keyDown(document.activeElement ?? document.body, { key });
    await tick();
  }

  async function openApple(container: HTMLElement) {
    await fireEvent.click(container.querySelector<HTMLElement>('[data-testid="apple-menu-trigger"]')!);
    await tick();
  }

  test("→ from 🍎 opens the first app menu, and 🍎 closes", async () => {
    installHost([]);
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    await openApple(container);
    expect(panelOpen(container, "apple-menu-panel"), "the Apple menu really opened").toBe(true);

    // macOS: the Apple menu is the bar's *first* menu, so → walks off it into File.
    await press("ArrowRight");
    expect(panelOpen(container, "menu-file-panel"), "→ from 🍎 opens 文件").toBe(true);
    expect(panelOpen(container, "apple-menu-panel"), "and 🍎 closed behind it").toBe(false);
    expect(openTriggerId(container)).toBe("menu-file-trigger");
  });

  test("← from the first app menu goes back to 🍎 (it does not skip it)", async () => {
    installHost([]);
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    await fireEvent.click(container.querySelector<HTMLElement>('[data-testid="menu-file-trigger"]')!);
    await tick();
    expect(panelOpen(container, "menu-file-panel")).toBe(true);

    // ← must reach 🍎, not wrap past it to the last menu: the Apple menu is a member of the bar.
    await press("ArrowLeft");
    expect(panelOpen(container, "apple-menu-panel"), "← from 文件 opens 🍎").toBe(true);
    expect(panelOpen(container, "menu-file-panel")).toBe(false);
  });

  test("← from 🍎 wraps to the LAST menu (the ring includes both components)", async () => {
    installHost([]);
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    await openApple(container);
    await press("ArrowLeft");
    expect(panelOpen(container, "menu-help-panel"), "← from 🍎 wraps to 帮助").toBe(true);
    expect(panelOpen(container, "apple-menu-panel")).toBe(false);
  });

  // The over-reach half: now that the bar owns an *always-installed* axis, an arrow pressed with
  // nothing open must not reach in and open a menu. (`nextMenuBarIndex` clamps index −1 to 0, so
  // "installed but not open" is a real state that needs its own guard — macOS does nothing.)
  test("an arrow with no menu open opens nothing", async () => {
    installHost([]);
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    expect(openTriggerId(container)).toBe(null);
    await fireEvent.keyDown(document.body, { key: "ArrowRight" });
    await tick();
    await fireEvent.keyDown(document.body, { key: "ArrowLeft" });
    await tick();

    expect(openTriggerId(container), "no menu was opened by the arrows").toBe(null);
    expect(panelOpen(container, "menu-file-panel")).toBe(false);
    expect(panelOpen(container, "apple-menu-panel")).toBe(false);
  });
});

describe("Escape must not strand the keyboard (REQ-A1057)", () => {
  const activeId = () => document.activeElement?.getAttribute("data-testid") ?? null;

  test("Escape returns the focus to the menu bar title, not to <body>", async () => {
    installHost([]);
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    await openGroup(container, "file");
    expect(activeId()).toBe("menu-file-file.new-window");

    await fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await tick();

    expect(container.querySelector('[data-testid="menu-file-panel"]'), "the menu closed").toBeNull();
    expect(activeId(), "the keyboard user's place, afterwards").toBe("menu-file-trigger");
  });

  test("after Escape the bar is still reachable: the focused title reopens it", async () => {
    installHost([]);
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    await openGroup(container, "file");
    await fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await tick();

    // Focus is on a real menu-bar trigger, so the very next activation reopens the menu and the
    // ring is alive again. Before the restore this element was `<body>`: there was nothing to
    // activate, and getting back into the bar meant tabbing through the whole page.
    expect(activeId()).toBe("menu-file-trigger");
    await fireEvent.click(document.activeElement!);
    await tick();
    expect(container.querySelector('[data-testid="menu-file-panel"]')).not.toBeNull();

    await fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    await tick();
    expect(
      container.querySelector('[data-testid$="-trigger"][aria-expanded="true"]')?.getAttribute("data-testid"),
      "and the ring works from there",
    ).toBe("menu-edit-trigger");
  });

  test("the restore works when the menu was reached by walking the bar (🍎 → 文件)", async () => {
    installHost([]);
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    // Open 🍎, then walk right into 文件 — the *panel* the user lands in belongs to a different
    // component than the one they left, which is why "restore to the opener" has to be the title
    // of the menu being closed, not "whatever had focus before".
    await fireEvent.click(container.querySelector<HTMLElement>('[data-testid="apple-menu-trigger"]')!);
    await tick();
    await fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    await tick();
    expect(container.querySelector('[data-testid="menu-file-panel"]')).not.toBeNull();

    await fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await tick();

    expect(container.querySelector('[data-testid="menu-file-panel"]')).toBeNull();
    expect(activeId(), "文件's title, not 🍎's").toBe("menu-file-trigger");
  });

  test("Escape in the Apple menu returns the focus to 🍎", async () => {
    installHost([]);
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    await fireEvent.click(container.querySelector<HTMLElement>('[data-testid="apple-menu-trigger"]')!);
    await tick();
    await fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await tick();

    expect(container.querySelector('[data-testid="apple-menu-panel"]')).toBeNull();
    expect(activeId()).toBe("apple-menu-trigger");
  });

  test("an outside click is NOT followed by a focus grab (the rule is Escape-only)", async () => {
    installHost([]);
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    await openGroup(container, "file");
    // A pointer dismissal: the click itself owns whatever focus it lands on. Yanking the focus
    // back to the title here would fight the user's own click.
    await fireEvent.mouseDown(document.body);
    await tick();

    expect(container.querySelector('[data-testid="menu-file-panel"]')).toBeNull();
    expect(activeId(), "no focus was taken back").not.toBe("menu-file-trigger");
  });
});
