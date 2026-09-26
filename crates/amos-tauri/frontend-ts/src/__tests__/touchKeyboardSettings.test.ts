/**
 * touchKeyboardSettings.test.ts — does the Settings page's 「触屏导航」 section actually govern
 * the touch shell's keyboard admission? (REQ-A1200 / F-SH-490)
 *
 * The defect this pins: `KeyboardPage.svelte` rendered `TOUCH_DEFAULTS` into an editable
 * section and persisted every edit to `config.touch` — but `shellKeyIntent` (the **only**
 * admission the touch shell has, called from `Shell.svelte`) matched a **hard-coded** copy of
 * the chords: `if (e.key === "Escape")` for 关闭/取消 and `TOUCH_SYSTEM_SHORTCUTS` for
 * 返回上一级. So the section's controls were authorable, saved and re-rendered, and read by
 * nobody: rebinding 返回上一级 to ⌘B left ⌘[ live, disabling it left ⌘[ live, and `⌘,` — the
 * one chord the ⌘-hold panel taught — had **no row at all**. `resolveBindings`/`getTouchShortcut`
 * resolved the merged table faithfully, but `getTouchShortcut` had zero production callers, so
 * "a writer and a reader exist" was true and the feature was still dead.
 *
 * Why this file needs its own stub: `shellKeyIntent` is pure, but the value it now consults is
 * **persisted**, so proving the defect means seeding `localStorage` and re-deciding. Like
 * `keyboardConfigHook.bindings.test.ts` this installs a hand-written `window` and does **not**
 * import happy-dom (importing it would mark the file as a DOM file and drop it from the `pure`
 * batch; `window` needs only `localStorage`). The stub lives only for this file's lifetime.
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import type { ShellModule, ShellShortcut } from "../lib/shellModule";
import { shellKeyIntent, touchShortcutCatalog } from "../lib/systemKeys";
import { KEYBOARD_CONFIG_KEY } from "../lib/keyboardConfig";
import { TOUCH_DEFAULTS } from "../lib/keyboardConfigHook.svelte";

/** The real overlay rows' shape — enough for the registry half of the decision. */
const MODULES = [
  { id: "launchpad", slot: "overlay", order: 10, shortcuts: [{ key: "F4" }] },
  { id: "spotlight", slot: "overlay", order: 20, shortcuts: [{ key: "Space", meta: true }] },
  {
    id: "mission-control",
    slot: "overlay",
    order: 30,
    shortcuts: [{ key: "F3" }, { key: "Tab", meta: true }],
  },
] as unknown as ShellModule[];

const memory = new Map<string, string>();
const windowStub = {
  localStorage: {
    getItem: (key: string) => (memory.has(key) ? memory.get(key)! : null),
    setItem: (key: string, value: string) => void memory.set(key, String(value)),
    removeItem: (key: string) => void memory.delete(key),
    clear: () => memory.clear(),
  },
  addEventListener: () => {},
  removeEventListener: () => {},
  /** `amosStore.writeJson` fires a `CustomEvent`; bun has no such constructor and it is swallowed. */
  dispatchEvent: () => true,
};

const globals = globalThis as Record<string, unknown>;
const previousWindow = globals.window;

beforeAll(() => {
  globals.window = windowStub;
});
afterAll(() => {
  if (previousWindow === undefined) delete globals.window;
  else globals.window = previousWindow;
});
beforeEach(() => memory.clear());

/** What the Settings page would have persisted when the user edits a touch row. */
function seedTouch(touch: Record<string, ShellShortcut | null>): void {
  memory.set(
    KEYBOARD_CONFIG_KEY,
    JSON.stringify({
      version: 1,
      overlays: {},
      system: {},
      spaces: {},
      touch,
      updatedAt: 0,
    }),
  );
}

const press = (key: string, mod: Partial<KeyboardEvent> = {}) =>
  ({ key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mod }) as KeyboardEvent;

const dismiss = (via: "escape" | "cmd-bracket") => ({ kind: "dismiss" as const, via });

describe("shellKeyIntent reads the user's touch bindings, not a hard-coded copy (REQ-A1200)", () => {
  test("with no config the defaults still hold (the control: the untouched path is unchanged)", () => {
    expect(shellKeyIntent(press("[", { metaKey: true }), MODULES)).toEqual(dismiss("cmd-bracket"));
    expect(shellKeyIntent(press("Escape"), MODULES)).toEqual(dismiss("escape"));
    expect(shellKeyIntent(press(",", { metaKey: true }), MODULES)).toEqual({ kind: "settings" });
  });

  test("rebinding 返回上一级 moves the chord: the new key works and the old one goes inert", () => {
    seedTouch({ back: { key: "B", meta: true } });
    expect(shellKeyIntent(press("b", { metaKey: true }), MODULES)).toEqual(dismiss("cmd-bracket"));
    // The half the old hard-coded table could never express: ⌘[ must stop being "back".
    expect(shellKeyIntent(press("[", { metaKey: true }), MODULES)).toEqual({ kind: "none" });
  });

  test("disabling 返回上一级 makes ⌘[ inert — a `null` row is absent, not merely un-drawn", () => {
    // This is the assertion that separates "the page re-renders the row as —" from "the shell
    // obeys". Before the fix the page showed 「—」 and ⌘[ still dismissed.
    seedTouch({ back: null });
    expect(shellKeyIntent(press("[", { metaKey: true }), MODULES)).toEqual({ kind: "none" });
  });

  test("rebinding 关闭/取消 moves dismissal off Escape and onto the new chord", () => {
    seedTouch({ dismiss: { key: "D", meta: true } });
    expect(shellKeyIntent(press("d", { metaKey: true }), MODULES)).toEqual(dismiss("escape"));
    expect(shellKeyIntent(press("Escape"), MODULES)).toEqual({ kind: "none" });
  });

  test("disabling 关闭/取消 makes Escape inert", () => {
    seedTouch({ dismiss: null });
    expect(shellKeyIntent(press("Escape"), MODULES)).toEqual({ kind: "none" });
  });

  test("Escape is a row like any other now — it obeys the exactness rule", () => {
    // The old `e.key === "Escape"` matched a modified Escape too, so ⇧Escape was half-consumed
    // (dismissed, but the Shift was ignored). Routing it through `shortcutMatches` is the same
    // rule every other row uses.
    expect(shellKeyIntent(press("Escape", { shiftKey: true }), MODULES)).toEqual({ kind: "none" });
    expect(shellKeyIntent(press("Escape", { metaKey: true }), MODULES)).toEqual({ kind: "none" });
  });

  test("⌘, has an editor row at all — the admitted key the panel taught could not be changed", () => {
    // The mirror half: the ⌘-hold panel has always listed ⌘, (label `app.settings`), but there
    // was no `TOUCH_DEFAULTS` row for it, so the Settings page could not offer one. A key the
    // shell admits with no row to edit it is the door-narrower-than-the-room shape.
    expect(Object.keys(TOUCH_DEFAULTS)).toContain("settings");
    seedTouch({ settings: { key: "P", meta: true } });
    expect(shellKeyIntent(press("p", { metaKey: true }), MODULES)).toEqual({ kind: "settings" });
    expect(shellKeyIntent(press(",", { metaKey: true }), MODULES)).toEqual({ kind: "none" });
  });

  test("a rebind is still subject to the exactness rule (no chord is widened)", () => {
    seedTouch({ back: { key: "B", meta: true } });
    expect(shellKeyIntent(press("b", { metaKey: true, shiftKey: true }), MODULES)).toEqual({
      kind: "none",
    });
    expect(shellKeyIntent(press("b", { metaKey: true, altKey: true }), MODULES)).toEqual({
      kind: "none",
    });
  });

  test("the registry half is untouched by a touch rebind", () => {
    seedTouch({ back: { key: "B", meta: true }, dismiss: null, settings: null });
    expect(shellKeyIntent(press("F4"), MODULES)).toEqual({ kind: "toggle", target: "library" });
    expect(shellKeyIntent(press(" ", { metaKey: true }), MODULES)).toEqual({
      kind: "toggle",
      target: "spot",
    });
    expect(shellKeyIntent(press("F3"), MODULES)).toEqual({ kind: "toggle", target: "recents" });
  });
});

describe("the ⌘-hold panel teaches the user's chords, not the defaults (REQ-A1200)", () => {
  test("defaults: the platform rows then the registry rows", () => {
    expect(touchShortcutCatalog(MODULES).map((h) => h.keys)).toEqual([
      "⌘[",
      "⌘,",
      "F4",
      "⌘Space",
      "F3 / ⌘⇥",
    ]);
    expect(touchShortcutCatalog(MODULES).map((h) => h.labelKey)).toEqual([
      "a11y.back",
      "app.settings",
      "appLibrary.title",
      "shell.search",
      "shell.recents",
    ]);
  });

  test("a rebind changes the keycap the panel shows", () => {
    seedTouch({ back: { key: "B", meta: true } });
    expect(touchShortcutCatalog(MODULES).map((h) => h.keys)[0]).toBe("⌘B");
  });

  test("a disabled row is dropped from the panel (it is no longer admitted)", () => {
    seedTouch({ settings: null });
    const keys = touchShortcutCatalog(MODULES).map((h) => h.keys);
    expect(keys).not.toContain("⌘,");
    expect(keys).toEqual(["⌘[", "F4", "⌘Space", "F3 / ⌘⇥"]);
  });

  test("Escape is still never advertised, even when 关闭/取消 is rebound to a chord", () => {
    // The panel teaches chords; the platform's own dismissal is not one. `dismiss` is simply
    // not in the catalog's id list, so neither its default nor its rebind appears.
    seedTouch({ dismiss: { key: "D", meta: true } });
    const catalog = touchShortcutCatalog(MODULES);
    expect(catalog.some((h) => /Escape|⌘D/.test(h.keys))).toBe(false);
  });
});
