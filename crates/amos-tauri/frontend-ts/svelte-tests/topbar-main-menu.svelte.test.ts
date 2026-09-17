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
import { zh } from "../src/i18n/locales/zh";

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

  test("a row whose key nothing binds advertises nothing (⌘N is not wired)", async () => {
    installHost([]);
    const { container } = render(DesktopShell);
    await tick();
    await settle();
    const file = await openGroup(container, "file");
    const row = rowText(file, "file", "file.new-window");
    expect(row, "the row still exists and still works by click").toContain(
      zh["desktop.menu.file.newWindow"],
    );
    expect(row, "…but it must not claim a key").not.toContain("⌘N");
    expect(row).not.toContain("Shortcut");
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
});
