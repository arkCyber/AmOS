/**
 * keyboardConfigHook.test.ts — `keyboardConfigHook.svelte.ts` 的纯函数测试。
 *
 * 只测**纯**函数 (`matchesShortcut`)，不实例化 `createKeyboardBindings`：后者
 * 会立刻访问 Svelte 5 编译期的 rune 原语，单测里没有编译器介入就跑不起来。
 */
import { describe, expect, test } from "vitest";
import { matchesShortcut } from "../keyboardConfigHook.svelte";
import { shortcutMatches, type ShellShortcut } from "../shellModule";

/**
 * Minimal `KeyboardEvent` substitute — `matchesShortcut` only ever reads
 * `key`, `metaKey`, `ctrlKey`, `shiftKey`, `altKey`. We don't need a real
 * `KeyboardEvent` (and `bun test` outside a JSDOM env doesn't ship one).
 */
function fakeKey(key: string, mods: Partial<Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "shiftKey" | "altKey">> = {}) {
  return { key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods };
}

describe("matchesShortcut", () => {
  test("matches ⌘W (declared as uppercase, fired as lowercase)", () => {
    // FMEA finding: `KeyboardEvent.key` for letter keys is lowercase ("w"), but
    // `SYSTEM_DEFAULTS` declares keys uppercase ("W"). A strict `===` would
    // mean a user pressing ⌘W on a real Mac does NOT match the close-window
    // binding — exactly the silent-defect class this audit is hunting.
    const s: ShellShortcut = { key: "W", meta: true };
    expect(matchesShortcut(s, fakeKey("w", { metaKey: true }) as KeyboardEvent)).toBe(true);
  });

  test("rejects ⌘W when no modifier", () => {
    const s: ShellShortcut = { key: "W", meta: true };
    expect(matchesShortcut(s, fakeKey("w") as KeyboardEvent)).toBe(false);
  });

  test("rejects ⌘M for a ⌘W binding", () => {
    const s: ShellShortcut = { key: "W", meta: true };
    expect(matchesShortcut(s, fakeKey("m", { metaKey: true }) as KeyboardEvent)).toBe(false);
  });

  test("⌘ + Space (declared with literal ' ') matches a real Space keydown", () => {
    const s: ShellShortcut = { key: " ", meta: true };
    expect(matchesShortcut(s, fakeKey(" ", { metaKey: true }) as KeyboardEvent)).toBe(true);
  });

  test("Esc alone matches a no-modifier Escape binding", () => {
    const s: ShellShortcut = { key: "Escape" };
    expect(matchesShortcut(s, fakeKey("Escape") as KeyboardEvent)).toBe(true);
  });

  test("Esc alone does NOT match a ⌘Esc binding", () => {
    const s: ShellShortcut = { key: "Escape", meta: true };
    expect(matchesShortcut(s, fakeKey("Escape") as KeyboardEvent)).toBe(false);
  });

  /*
   * The modifier truth table. `keyboardConfigHook.matchesShortcut` used to implement its
   * own version of this, which drifted from `shellModule.shortcutMatches` (the bar's
   * `shortcutAria`/the native accelerator path read that one). Two matchers for one
   * registry is the silent-defect shape: a user binds ⌘W, the bar renders ⌘W, and the
   * key never fires. The fix made them one table; these cases pin the table **and** the
   * parity, so a future edit to either alone fails here.
   */
  const TABLE: Array<[ShellShortcut, Parameters<typeof fakeKey>[0], Parameters<typeof fakeKey>[1], boolean]> = [
    // ── implicit Ctrl-as-⌘: a Meta binding also accepts the physical Ctrl key ──
    [{ key: "W", meta: true }, "w", { metaKey: true }, true],
    [{ key: "W", meta: true }, "w", { ctrlKey: true }, true],
    [{ key: "W", meta: true }, "w", {}, false],
    // ── `ctrl: true` beside `meta`: **both** physical modifiers (REQ-A1568) ──
    // This row used to be named "Ctrl AND ⌘" while matching ⌘ alone, so writing `ctrl` only
    // disabled the implicit Ctrl-as-⌘ fold. A binding that names both is the one shape that
    // can reach a chord the ⌘ family does not already own, and accepting ⌘ alone would both
    // ignore the user's ⌃ and steal the app's ⌘ chord (`lib/stageKeys.ts`'s ⌃⌘S).
    [{ key: "W", meta: true, ctrl: true }, "w", { metaKey: true }, false],
    [{ key: "W", meta: true, ctrl: true }, "w", { ctrlKey: true }, false],
    [{ key: "W", meta: true, ctrl: true }, "w", { metaKey: true, ctrlKey: true }, true],
    // ── pure Ctrl: the physical Ctrl key, and ⌘ must not be down ──
    [{ key: "ArrowUp", ctrl: true }, "ArrowUp", { ctrlKey: true }, true],
    [{ key: "ArrowUp", ctrl: true }, "ArrowUp", { metaKey: true }, false],
    [{ key: "ArrowUp", ctrl: true }, "ArrowUp", { metaKey: true, ctrlKey: true }, false],
    [{ key: "ArrowUp", ctrl: true }, "ArrowUp", {}, false],
    // ── no modifier: Meta or Ctrl belongs to a more specific binding ──
    [{ key: "Escape" }, "Escape", {}, true],
    [{ key: "Escape" }, "Escape", { metaKey: true }, false],
    [{ key: "Escape" }, "Escape", { ctrlKey: true }, false],
  ];

  for (const [s, key, mods, want] of TABLE) {
    const label = `${JSON.stringify(s)} + ${key}${JSON.stringify(mods)}`;
    test(`matchesShortcut: ${label} → ${want}`, () => {
      expect(matchesShortcut(s, fakeKey(key, mods) as KeyboardEvent)).toBe(want);
    });
    test(`parity with shellModule.shortcutMatches: ${label}`, () => {
      // Same registry, two call sites (shell chrome vs. the bar/accelerator path) — the
      // two matchers must agree on every row or one of them is lying about the binding.
      expect(matchesShortcut(s, fakeKey(key, mods) as KeyboardEvent)).toBe(
        shortcutMatches(fakeKey(key, mods), s),
      );
    });
  }
});
