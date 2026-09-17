/**
 * desktopKeys.test.ts — the desktop shell's system keys as a **pure decision** (REQ-A341).
 *
 * Why this exists at all: before the table, "which system keys does the desktop shell have" was
 * only knowable by reading a `switch` inside `DesktopShell.svelte`, and two other artefacts had to
 * keep their own copy (the Settings shortcuts page lists them as literals). These assertions pin
 * the table, so the dispatch and any display read the same truth.
 */
import { describe, expect, test } from "bun:test";
import { DESKTOP_SYSTEM_KEYS, desktopKeyIntent } from "../lib/desktopKeys";

const press = (key: string, mod: Partial<KeyboardEvent> = {}) =>
  ({ key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mod }) as KeyboardEvent;

describe("desktopKeyIntent (REQ-A341)", () => {
  test("the four keys that act on the focused window", () => {
    expect(desktopKeyIntent(press("w", { metaKey: true }))).toEqual({ kind: "close-window" });
    expect(desktopKeyIntent(press("m", { metaKey: true }))).toEqual({ kind: "minimize-window" });
    expect(desktopKeyIntent(press("h", { metaKey: true }))).toEqual({ kind: "hide-app" });
    expect(desktopKeyIntent(press(",", { metaKey: true }))).toEqual({ kind: "open-settings" });
  });

  test("Ctrl is the documented stand-in for ⌘ on non-Apple keyboards", () => {
    for (const key of ["w", "m", "h", ","]) {
      expect(desktopKeyIntent(press(key, { ctrlKey: true }))).toEqual(
        desktopKeyIntent(press(key, { metaKey: true })),
      );
    }
  });

  test("the table is exactly those four rows — no more, no fewer", () => {
    expect(DESKTOP_SYSTEM_KEYS.map((r) => [r.intent.kind, r.shortcut.key, r.shortcut.meta])).toEqual([
      ["close-window", "w", true],
      ["minimize-window", "m", true],
      ["hide-app", "h", true],
      ["open-settings", ",", true],
    ]);
  });

  test("modifiers must match exactly", () => {
    // ⌘⇧W closed the focused window before the table (the old switch ignored Shift); it must not
    // now — every other binding in this shell is exact, and macOS's ⌘⇧W means something else.
    expect(desktopKeyIntent(press("W", { metaKey: true, shiftKey: true }))).toBeNull();
    expect(desktopKeyIntent(press("w", { metaKey: true, altKey: true }))).toBeNull();
    // A plain letter is text, not a command.
    expect(desktopKeyIntent(press("w"))).toBeNull();
    expect(desktopKeyIntent(press(","))).toBeNull();
    // …and a key the shell has no opinion about stays unclaimed (the caller must let it through).
    expect(desktopKeyIntent(press("q", { metaKey: true }))).toBeNull();
    expect(desktopKeyIntent(press("Escape"))).toBeNull();
  });

  test("the Spaces keys are deliberately NOT in this table (their handling is stateful)", () => {
    // Stated as an assertion so a future reader cannot "finish the job" by flattening them: these
    // belong to `DesktopShell` / `SpacesPanel`, where each has its own failure path.
    expect(desktopKeyIntent(press("1", { ctrlKey: true }))).toBeNull();
    expect(desktopKeyIntent(press("ArrowLeft", { ctrlKey: true }))).toBeNull();
    expect(desktopKeyIntent(press("ArrowUp", { ctrlKey: true }))).toBeNull();
  });
});
