/**
 * systemKeys.test.ts — the touch shell's keyboard admission, as a **pure decision** (REQ-A335).

 *
 * The registry that says "which key opens which system surface" is the desktop chrome's
 * (`svelte/shellModules.ts` → the load-bearing set `["F3", "F4", "Meta+Space", "Meta+Tab"]`).
 * Until this round the touch shell ignored it entirely: on an iPad with an external keyboard
 * the same device that shows these surfaces to a finger could not open one with a key, and the
 * shell's own Escape did *less* than the platform back gesture. `shellKeyIntent` is the one
 * place that turns a keystroke into a shell intent, and it takes the registry **as an
 * argument** — so this test needs no Svelte, and `lib/` keeps pointing away from `svelte/`.
 */
import { describe, expect, test } from "bun:test";
import type { ShellModule } from "../lib/shellModule";
import { shellKeyIntent, touchShortcutCatalog, touchTargetForOverlay } from "../lib/systemKeys";

/** The real overlay rows' *shape* (ids, slots, orders and the documented keys). */
const MODULES = [
  { id: "launchpad", slot: "overlay", order: 10, shortcuts: [{ key: "F4" }] },
  { id: "spotlight", slot: "overlay", order: 20, shortcuts: [{ key: "Space", meta: true }] },
  {
    id: "mission-control",
    slot: "overlay",
    order: 30,
    shortcuts: [{ key: "F3" }, { key: "Tab", meta: true }],
  },
  { id: "control-center-panel", slot: "overlay", order: 40 },
] as unknown as ShellModule[];

/**
 * A registry whose key is a single uppercase letter. Tests the same FMEA finding as
 * `keyboardConfigHook.test.ts` — `KeyboardEvent.key` is lowercase for letters, so the
 * declared key must be normalised on both sides or the binding silently misses.
 */
const LETTER_MODULES = [
  { id: "launchpad", slot: "overlay", order: 10, shortcuts: [{ key: "L", meta: true }] },
] as unknown as ShellModule[];

const press = (key: string, mod: Partial<KeyboardEvent> = {}) =>
  ({ key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mod }) as KeyboardEvent;

describe("shellKeyIntent (touch keyboard admission, REQ-A335)", () => {
  test("Escape asks to go up one level — the same intent as the platform back gesture", () => {
    expect(shellKeyIntent(press("Escape"), MODULES)).toEqual({ kind: "dismiss", via: "escape" });
  });

  test("⌘[ is macOS's own spelling of Back — the same intent, another key (REQ-A336)", () => {
    expect(shellKeyIntent(press("[", { metaKey: true }), MODULES)).toEqual({
      kind: "dismiss",
      via: "cmd-bracket",
    });
    // External keyboards: Ctrl is the documented equivalent of ⌘.
    expect(shellKeyIntent(press("[", { ctrlKey: true }), MODULES)).toEqual({
      kind: "dismiss",
      via: "cmd-bracket",
    });
    // …and it is subject to the same exactness rule as everything else.
    expect(shellKeyIntent(press("[", { metaKey: true, shiftKey: true }), MODULES)).toEqual({
      kind: "none",
    });
    expect(shellKeyIntent(press("[", { metaKey: true, altKey: true }), MODULES)).toEqual({
      kind: "none",
    });
    // ⌘] (Forward) is **deliberately not admitted**: the shell's history has no forward model
    // (rewinding pops our entries and the next push truncates the browser's forward stack), so
    // the key would usually do nothing and occasionally lie. Not wired is the honest state.
    expect(shellKeyIntent(press("]", { metaKey: true }), MODULES)).toEqual({ kind: "none" });
    expect(shellKeyIntent(press("]"), MODULES)).toEqual({ kind: "none" });
  });

  test("⌘, reaches Settings — the one desktop system key with a real touch counterpart", () => {
    expect(shellKeyIntent(press(",", { metaKey: true }), MODULES)).toEqual({ kind: "settings" });
    expect(shellKeyIntent(press(",", { ctrlKey: true }), MODULES)).toEqual({ kind: "settings" });
    expect(shellKeyIntent(press(",", { metaKey: true, altKey: true }), MODULES)).toEqual({
      kind: "none",
    });
    // ⌘W / ⌘M / ⌘H are **not** admitted on touch — see `lib/systemKeys.ts` for each reason.
    for (const k of ["w", "m", "h"]) {
      expect(shellKeyIntent(press(k, { metaKey: true }), MODULES), `⌘${k} stays desktop-only`).toEqual(
        { kind: "none" },
      );
    }
  });

  test("the registry's keys reach the touch shell's own overlays", () => {
    expect(shellKeyIntent(press(" ", { metaKey: true }), MODULES)).toEqual({
      kind: "toggle",
      target: "spot",
    });
    // An external (non-Apple) keyboard: Ctrl is the shell's documented equivalent of ⌘.
    expect(shellKeyIntent(press(" ", { ctrlKey: true }), MODULES)).toEqual({
      kind: "toggle",
      target: "spot",
    });
    expect(shellKeyIntent(press("F3"), MODULES)).toEqual({ kind: "toggle", target: "recents" });
    expect(shellKeyIntent(press("Tab", { metaKey: true }), MODULES)).toEqual({
      kind: "toggle",
      target: "recents",
    });
    expect(shellKeyIntent(press("F4"), MODULES)).toEqual({ kind: "toggle", target: "library" });
  });

  test("modifiers must match exactly (no shortcut is widened by a stray Shift/Alt)", () => {
    for (const extra of [{ shiftKey: true }, { altKey: true }]) {
      expect(shellKeyIntent(press(" ", { metaKey: true, ...extra }), MODULES)).toEqual({
        kind: "none",
      });
      expect(shellKeyIntent(press("F4", extra), MODULES)).toEqual({ kind: "none" });
    }
    // A plain letter is never a shortcut, and neither is an unmodified Space.
    expect(shellKeyIntent(press("k"), MODULES)).toEqual({ kind: "none" });
    expect(shellKeyIntent(press(" "), MODULES)).toEqual({ kind: "none" });
  });

  test("Control Center and Spaces have no key by design — and neither does an unknown row", () => {
    expect(touchTargetForOverlay("control-center-panel")).toBeNull();
    expect(touchTargetForOverlay("spaces-panel")).toBeNull();
    expect(touchTargetForOverlay("something-new")).toBeNull();
    expect(shellKeyIntent(press("F1"), MODULES)).toEqual({ kind: "none" });
  });

  test("a keystroke that is not ours must be left alone, not half-consumed", () => {
    // An IME (the pinyin overlay) is composing: the shell must never steal the keystroke.
    expect(shellKeyIntent(press(" ", { metaKey: true, isComposing: true }), MODULES)).toEqual({
      kind: "none",
    });
    expect(shellKeyIntent(press("Escape", { isComposing: true }), MODULES)).toEqual({
      kind: "none",
    });
    // A held key must not toggle a sheet on every repeat (flicker, and it fights the user).
    expect(shellKeyIntent(press(" ", { metaKey: true, repeat: true }), MODULES)).toEqual({
      kind: "none",
    });
    expect(shellKeyIntent(press("Escape", { repeat: true }), MODULES)).toEqual({ kind: "none" });
    // Someone closer to the event already handled it.
    expect(shellKeyIntent(press("Escape", { defaultPrevented: true }), MODULES)).toEqual({
      kind: "none",
    });
  });

  test("an empty registry admits nothing but Escape", () => {
    expect(shellKeyIntent(press(" ", { metaKey: true }), [])).toEqual({ kind: "none" });
    expect(shellKeyIntent(press("F4"), [])).toEqual({ kind: "none" });
    expect(shellKeyIntent(press("Escape"), [])).toEqual({ kind: "dismiss", via: "escape" });
    // The platform navigation keys do not depend on the registry either.
    expect(shellKeyIntent(press("[", { metaKey: true }), [])).toEqual({
      kind: "dismiss",
      via: "cmd-bracket",
    });
    expect(shellKeyIntent(press(",", { metaKey: true }), [])).toEqual({ kind: "settings" });
  });

  test("letter shortcuts match case-insensitively (FMEA finding from keyboardConfigHook)", () => {
    // Today no overlay row uses a single letter, but a future row or user override might.
    // The FMEA finding: `KeyboardEvent.key` for letters is lowercase ("l"), while the
    // registry declares the binding as uppercase ("L"). A strict `===` silently misses.
    expect(shellKeyIntent(press("l", { metaKey: true }), LETTER_MODULES)).toEqual({
      kind: "toggle",
      target: "library",
    });
  });
});

/**
 * REQ-A338 — the **catalog** the ⌘-hold shortcut panel renders.
 *
 * §16.4's boundary ⑤ said this admission was undiscoverable ("no interface hint at all"), and
 * iPadOS answers that with a panel you get by holding ⌘. The panel must not become a *second*
 * place that knows the keys, so the catalog is **generated** from the same two sources the
 * engine reads (the registry's overlay rows + `TOUCH_SYSTEM_SHORTCUTS`). These assertions are
 * the drift guard: add a key anywhere and this fails until the panel is told about it — and the
 * labels are i18n **keys**, so nothing here can hard-code English.
 */
describe("touchShortcutCatalog (the ⌘-hold panel's content, REQ-A338)", () => {
  test("every admitted key is listed — and nothing that is not admitted", () => {
    const catalog = touchShortcutCatalog(MODULES);
    // Keycaps come from the registry's own formatter, so they use the Apple glyphs (⌘ and ⇥,
    // not "Meta"/"Tab") — the same strings the desktop chrome's tooltips already show.
    expect(catalog.map((h) => h.keys)).toEqual(["⌘[", "⌘,", "F4", "⌘Space", "F3 / ⌘⇥"]);
    // Labels are keys, never text: the panel is translated like everything else.
    expect(catalog.map((h) => h.labelKey)).toEqual([
      "a11y.back",
      "app.settings",
      "appLibrary.title",
      "shell.search",
      "shell.recents",
    ]);
    // `Escape` is deliberately absent: it is the platform's dismissal, not a "shortcut" a panel
    // needs to teach. The same assertion catches a key the shell *refuses* (⌘W / ⌘H / ⌘M / ⌘])
    // being listed, because it forbids those glyphs outright.
    expect(catalog.some((h) => /Escape|⌘W|⌘H|⌘M|⌘\]/.test(h.keys))).toBe(false);
  });

  test("a registry row with no touch counterpart contributes nothing", () => {
    const withDesktopOnly = [
      ...MODULES,
      { id: "control-center-panel-2", slot: "overlay", order: 60, shortcuts: [{ key: "F9" }] },
    ] as unknown as ShellModule[];
    expect(touchShortcutCatalog(withDesktopOnly).map((h) => h.keys)).not.toContain("F9");
  });

  test("an empty registry still teaches the platform's own navigation keys", () => {
    expect(touchShortcutCatalog([]).map((h) => h.keys)).toEqual(["⌘[", "⌘,"]);
  });
});

