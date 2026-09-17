/**
 * keyboardConfigHook.test.ts — `keyboardConfigHook.svelte.ts` 的纯函数测试。
 *
 * 只测**纯**函数 (`matchesShortcut`)，不实例化 `createKeyboardBindings`：后者
 * 会立刻访问 Svelte 5 编译期的 rune 原语，单测里没有编译器介入就跑不起来。
 */
import { describe, expect, test } from "vitest";
import { matchesShortcut } from "../keyboardConfigHook.svelte";
import type { ShellShortcut } from "../shellModule";

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
});
