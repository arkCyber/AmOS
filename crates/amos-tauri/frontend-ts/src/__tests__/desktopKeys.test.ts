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
import { readFileSync } from "node:fs";
import { DESKTOP_SYSTEM_KEYS, desktopShortcutLabel, intentIdFor, nativeAcceleratorPayload, toAccelerator } from "../lib/desktopKeys";
import { SYSTEM_DEFAULTS } from "../lib/keyboardConfigHook.svelte";
import type { ShellShortcut } from "../lib/shellModule";

/**
 * The **host** side of the accelerator contract, read from source rather than re-typed here
 * (REQ-A661, F-SH-127). `nativeAcceleratorPayload`'s docs claim its intent list "mirrors `menu.rs`'s
 * `ACCELERATOR_ITEMS` and is checked against it" — the check is this file's, and it exists only if it
 * reads the Rust. Parsing follows the same `readFileSync` shape `snapZones.test.ts` /
 * `robotVocab.test.ts` use for the same reason.
 */
const MENU_RS = readFileSync(new URL("../../../src/menu.rs", import.meta.url), "utf8");

/**
 * The shell's native-menu consumer, read from source (REQ-A761). `DesktopShell.svelte`'s
 * `onMenuEvent` switch is what turns a forwarded `menu-event` id into an action; nothing else
 * reads `menu.rs`'s id tables against it, so a menu item the host forwards with no case here is
 * swallowed by `default` and silently does nothing.
 */
const SHELL_SVELTE = readFileSync(new URL("../svelte/DesktopShell.svelte", import.meta.url), "utf8");

/** Every `pub const NAME: &str = "menu.…";` in `menu.rs` — the item-id declaration table (`ids`). */
function menuItemIds(): Map<string, string> {
  const ids = new Map<string, string>();
  for (const [, name, id] of MENU_RS.matchAll(/pub const (\w+): &str = "(menu\.[\w-]+)";/g)) {
    ids.set(name ?? "", id ?? "");
  }
  return ids;
}

/** The literal body of a `pub const X: &[…] = &[ … ];` declaration, up to its closing `];`. */
function constBody(decl: string): string {
  const start = MENU_RS.indexOf(decl);
  expect(start, `${decl} is declared in menu.rs`).toBeGreaterThan(0);
  const end = MENU_RS.indexOf("\n];", start);
  expect(end, `${decl} is closed`).toBeGreaterThan(start);
  return MENU_RS.slice(start, end);
}

/** `ACCELERATOR_ITEMS`: the shell intent ids the host accepts, and the menu item each drives. */
function hostSyncedIntents(): Array<{ intent: string; item: string }> {
  return [...constBody("pub const ACCELERATOR_ITEMS").matchAll(/\("(\w+)",\s*ids::(\w+)\)/g)].map(
    ([, intent, item]) => ({ intent: intent ?? "", item: item ?? "" }),
  );
}

/** `DEFAULT_ACCELERATORS`: each menu item's build-time chord, in muda's grammar. */
function hostChords(): Map<string, string> {
  const chords = new Map<string, string>();
  for (const [, item, chord] of constBody("pub const DEFAULT_ACCELERATORS").matchAll(
    /\(ids::(\w+),\s*"([^"]+)"\)/g,
  )) {
    chords.set(item ?? "", chord ?? "");
  }
  return chords;
}

describe("desktopKeys (REQ-A348)", () => {
  test("the table is exactly the keys macOS documents for the focused window", () => {
    expect(DESKTOP_SYSTEM_KEYS.map((r) => [r.intent.kind, r.shortcut.key, r.shortcut.meta])).toEqual([
      ["new-window", "n", true],
      ["close-window", "w", true],
      ["minimize-window", "m", true],
      ["hide-app", "h", true],
      ["cycle-window", "`", true],
      ["open-settings", ",", true],
    ]);
  });

  test("labels are Apple keycaps: ⌘ plus an upper-case letter", () => {
    expect(desktopShortcutLabel("close-window")).toBe("⌘W");
    expect(desktopShortcutLabel("minimize-window")).toBe("⌘M");
    expect(desktopShortcutLabel("hide-app")).toBe("⌘H");
    expect(desktopShortcutLabel("open-settings")).toBe("⌘,");
    // REQ-A473: the two per-app window chords the identity model made representable.
    expect(desktopShortcutLabel("new-window")).toBe("⌘N");
    expect(desktopShortcutLabel("cycle-window")).toBe("⌘`");
  });

  test("every row's label is derived from that row's own key (the hint cannot drift)", () => {
    for (const row of DESKTOP_SYSTEM_KEYS) {
      const label = desktopShortcutLabel(row.intent.kind);
      expect(label.startsWith("⌘"), `${row.intent.kind} carries the meta glyph`).toBe(true);
      // The keycap's letter is the row's own key, upper-cased — except a key that is not a
      // letter (⌘`) and ⌘, , where upper-casing is a no-op and `.toUpperCase()` is honest.
      expect(label.slice(1)).toBe(
        row.shortcut.key.length === 1 && /^[a-z]$/.test(row.shortcut.key)
          ? row.shortcut.key.toUpperCase()
          : row.shortcut.key,
      );
    }
  });

  // REQ-A484 (F-SH-038): the hint a menu draws must be the key the **user's** shell honors.
  describe("with the merged bindings in scope, the hint follows the user's binding", () => {
    const withOverride = (id: string, s: ShellShortcut | null): Map<string, ShellShortcut> => {
      const m = new Map<string, ShellShortcut>(Object.entries(SYSTEM_DEFAULTS));
      if (s) m.set(id, s);
      else m.delete(id);
      return m;
    };

    test("the default config prints the default keycap (no behaviour change)", () => {
      const bindings = new Map<string, ShellShortcut>(Object.entries(SYSTEM_DEFAULTS));
      expect(desktopShortcutLabel("new-window", bindings)).toBe("⌘N");
      expect(desktopShortcutLabel("hide-app", bindings)).toBe("⌘H");
    });

    test("a rebound key is what the menu shows (the shell matches that one)", () => {
      const bindings = withOverride("newWindow", { key: "n", meta: true, alt: true });
      expect(desktopShortcutLabel("new-window", bindings)).toBe("⌥⌘N");
      // …and only that row moves
      expect(desktopShortcutLabel("hide-app", bindings)).toBe("⌘H");
    });

    test("a disabled key is advertised as nothing at all", () => {
      // `null` in the config means "the user turned this binding off"; `resolveBindings` then leaves
      // the id *out* of the map. Printing the default here would be a menu promising a key that the
      // dispatch does not match — the defect this rule exists to prevent (REQ-A342).
      expect(desktopShortcutLabel("new-window", withOverride("newWindow", null))).toBe("");
      expect(desktopShortcutLabel("hide-app", withOverride("hideApp", null))).toBe("");
    });

    test("every table id is a real config id (the two lists cannot drift)", () => {
      for (const row of DESKTOP_SYSTEM_KEYS) {
        const id = intentIdFor(row.intent.kind);
        expect(id, `${row.intent.kind} has a config id`).not.toBeNull();
        expect(
          Object.keys(SYSTEM_DEFAULTS).includes(id as string),
          `SYSTEM_DEFAULTS has "${id}"`,
        ).toBe(true);
      }
    });

    test("an intent without a config id answers with the empty hint", () => {
      // Defensive: `desktopShortcutLabel` is called by menus with the intent they draw, and an
      // intent that has no binding must not fall back to somebody else's keycap.
      expect(desktopShortcutLabel("no-such-intent" as never, new Map())).toBe("");
    });
  });

  // REQ-A485: the native menu bar is AppKit's, so the shell has to *tell* it which accelerators its
  // bindings use. These are the two pure halves of that push.
  describe("the accelerator the host is told about (REQ-A485)", () => {
    test("meta is spelled CmdOrCtrl, which is what the host's own literals use", () => {
      expect(toAccelerator({ key: "n", meta: true })).toBe("CmdOrCtrl+N");
      expect(toAccelerator({ key: ",", meta: true })).toBe("CmdOrCtrl+,");
      expect(toAccelerator({ key: "n", meta: true, shift: true })).toBe("CmdOrCtrl+Shift+N");
      expect(toAccelerator({ key: "n", meta: true, alt: true })).toBe("CmdOrCtrl+Alt+N");
    });

    test("ctrl alone is Ctrl (both modifiers would ask for a chord no keyboard has)", () => {
      expect(toAccelerator({ key: "n", ctrl: true })).toBe("Ctrl+N");
      expect(toAccelerator({ key: "n", ctrl: true, meta: true })).toBe("CmdOrCtrl+N");
    });

    test("a named key is not translated (no native row uses one; a guess would lie)", () => {
      expect(toAccelerator({ key: "ArrowLeft", ctrl: true })).toBeNull();
      expect(toAccelerator({ key: "Escape" })).toBeNull();
      expect(toAccelerator({ key: "F3" })).toBeNull();
    });

    test("the payload carries the five synced intents, in the user's state", () => {
      const defaults = new Map<string, ShellShortcut>(Object.entries(SYSTEM_DEFAULTS));
      expect(nativeAcceleratorPayload(defaults)).toEqual({
        newWindow: "CmdOrCtrl+N",
        closeWindow: "CmdOrCtrl+W",
        minimizeWindow: "CmdOrCtrl+M",
        hideApp: "CmdOrCtrl+H",
        preferences: "CmdOrCtrl+,",
      });

      // A rebind travels as the new chord…
      const rebound = new Map(defaults);
      rebound.set("newWindow", { key: "n", meta: true, alt: true });
      expect(nativeAcceleratorPayload(rebound).newWindow).toBe("CmdOrCtrl+Alt+N");

      // …and a disabled binding travels as `null`, which makes the host clear that row's chord
      // (the bar must not advertise a key the shell does not match — F-SH-038's rule).
      const disabled = new Map(defaults);
      disabled.delete("hideApp");
      expect(nativeAcceleratorPayload(disabled).hideApp).toBeNull();
    });

    test("the intent list and its default chords are exactly the host's `ACCELERATOR_ITEMS`", () => {
      // The claim is cross-language: `nativeAcceleratorPayload` says its intent list "mirrors
      // `menu.rs`'s `ACCELERATOR_ITEMS` and is checked against it" — so this reads `menu.rs` and
      // holds both halves (the accepted ids, and each row's build-time chord) to the shell's.
      const synced = hostSyncedIntents();
      const chords = hostChords();
      const ids = menuItemIds();
      // Non-trivial guards: a rewrite that moves either table out of the parse window must fail
      // loudly rather than compare empty sets.
      expect(synced.length, "menu.rs lists the synced intents").toBe(5);
      expect(chords.size, "menu.rs declares build-time chords").toBeGreaterThanOrEqual(5);

      const tsIntents = Object.keys(nativeAcceleratorPayload(new Map()));
      // Same set, both directions: rename/add/remove on either side fails here.
      expect([...tsIntents].sort()).toEqual(synced.map((s) => s.intent).sort());

      // The shell's own default for each intent — through the one translation this module owns —
      // must equal the host's build-time chord for the row that intent drives.
      const defaults = new Map<string, ShellShortcut>(Object.entries(SYSTEM_DEFAULTS));
      for (const { intent, item } of synced) {
        expect(ids.has(item), `${item} is a declared menu id in menu.rs`).toBe(true);
        expect(
          nativeAcceleratorPayload(defaults)[intent],
          `${intent}'s shell default must equal menu.rs's build-time chord for ${item}`,
        ).toBe(chords.get(item));
      }

      // ⌘` (cycleWindows) is deliberately absent: no native row carries it.
      expect(tsIntents).not.toContain("cycleWindows");
    });
  });

  /**
   * REQ-A761 — the shell's `menu-event` switch and `menu.rs`'s id tables describe the same menu.
   *
   * `menu.rs::on_menu_event` forwards **every** item id to the frontend except the ones in
   * `TERMINAL_RUST` (it consumes those and returns). `DesktopShell.svelte` answers a hand-written
   * subset of those ids. Nothing bound the two: a new menu item added in Rust with no `case` in
   * the shell is swallowed by `default` and silently does nothing — and the reverse (a `case` for
   * an id the host never forwards) is dead code whose doc claim ("we map Close Window here") is
   * false. The comment above the switch already drifted that way: it listed Close Window as
   * handled (it is terminal in Rust, `close_key_window`) and called About / Hide Amos terminal
   * (they are forwarded). These cases hold the code relation, both directions.
   */
  describe("the shell's menu-event switch == the ids the host forwards (REQ-A761)", () => {
    /** The `menu.…` literals inside a `pub const X: &[&str] = &[ … ];` ids list. */
    const idList = (decl: string): string[] => {
      const ids = menuItemIds();
      // `ids::NAME` or a nested path like `ids::help::SEARCH_HELP` — take the last segment.
      return [...constBody(decl).matchAll(/ids::(?:\w+::)*(\w+)/g)].map(
        ([, name]) => ids.get(name ?? "") ?? "",
      );
    };
    /** The `case "menu.…":` literals in `DesktopShell.svelte`'s `onMenuEvent` switch. */
    const shellCases = (): string[] => [
      ...SHELL_SVELTE.matchAll(/case "(menu\.[\w-]+)":/g),
    ].map(([, id]) => id ?? "");

    test("every id the host forwards has a case here (or is a deliberate echo)", () => {
      const all = idList("pub const ALL: &[&str] = &[");
      const terminal = idList("const TERMINAL_RUST: &[&str] = &[");
      const rustHandled = idList("const RUST_HANDLED: &[&str] = &[");
      const cases = shellCases();

      // Guards: a rewrite that moves a table out of the parse window must fail loudly, not
      // compare two empty sets.
      expect(all.length, "menu.rs declares its item ids").toBeGreaterThanOrEqual(13);
      expect(cases.length, "the shell handles some of them").toBeGreaterThan(0);

      const forwarded = all.filter((id) => !terminal.includes(id));
      // `default` is the documented "echo, nothing to do" branch — the only forwarded ids it may
      // swallow are the Rust-handled ones whose behavior lives in `menu.rs`.
      const swallowed = forwarded.filter((id) => !cases.includes(id));
      const unexpected = swallowed.filter((id) => !rustHandled.includes(id));
      expect(
        unexpected,
        "every forwarded id must have a case in the shell's switch (or be a Rust-handled echo)",
      ).toEqual([]);

      // The terminal ids must NOT have a case: a case for `menu.quit` / `menu.close-window` …
      // could never run (the host returns before forwarding), and its presence is exactly the
      // stale-doc shape this round removes.
      for (const id of terminal) {
        expect(cases, `${id} is terminal in Rust and must not be cased here`).not.toContain(id);
      }

      // …and every case must name a real, forwarded id (no typo'd literal, no case for a
      // removed item).
      for (const id of cases) {
        expect(all, `${id} is a declared menu id`).toContain(id);
        expect(terminal, `${id} really reaches the shell`).not.toContain(id);
      }
    });
  });
});
