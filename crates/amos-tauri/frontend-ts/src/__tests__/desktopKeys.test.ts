/**
 * desktopKeys.test.ts — the desktop shell's **system-key table as data** (REQ-A348).
 *
 * Why this file is small: binding a key to a command is not this module's job any more. That is the
 * user-configurable layer's (`lib/keyboardConfig` → `DesktopShell.customSystemBindings`, matched with
 * the shared `shortcutMatches`), and a second dispatch table here would be the "two places that know
 * the keys" defect this audit keeps removing — so the dispatch half was **deleted**, not wired, when
 * `unwired-scan` asked which of the two it should be.
 *
 * What remains is what the table *says*, and the only production consumer: `desktopShortcutLabel`,
 * which the menu bar calls to draw `⌘W` / `⌘M` next to its rows. (The menu's own cases live in
 * `svelte-tests/topbar-main-menu.svelte.test.ts`, against the real component.)
 */
import { describe, expect, test } from "bun:test";
import { DESKTOP_SYSTEM_KEYS, desktopShortcutLabel } from "../lib/desktopKeys";

describe("desktopKeys (REQ-A348)", () => {
  test("the table is exactly the four keys macOS documents for the focused window", () => {
    expect(DESKTOP_SYSTEM_KEYS.map((r) => [r.intent.kind, r.shortcut.key, r.shortcut.meta])).toEqual([
      ["close-window", "w", true],
      ["minimize-window", "m", true],
      ["hide-app", "h", true],
      ["open-settings", ",", true],
    ]);
  });

  test("labels are Apple keycaps: ⌘ plus an upper-case letter", () => {
    expect(desktopShortcutLabel("close-window")).toBe("⌘W");
    expect(desktopShortcutLabel("minimize-window")).toBe("⌘M");
    expect(desktopShortcutLabel("hide-app")).toBe("⌘H");
    expect(desktopShortcutLabel("open-settings")).toBe("⌘,");
  });

  test("every row's label is derived from that row's own key (the hint cannot drift)", () => {
    for (const row of DESKTOP_SYSTEM_KEYS) {
      const label = desktopShortcutLabel(row.intent.kind);
      expect(label.startsWith("⌘"), `${row.intent.kind} carries the meta glyph`).toBe(true);
      expect(label.slice(1)).toBe(row.shortcut.key.toUpperCase());
    }
  });
});
