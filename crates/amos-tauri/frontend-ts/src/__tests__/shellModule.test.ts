/**
 * Tests for the shell-module contract (`lib/shellModule.ts`) — the data half of
 * the desktop chrome's modularisation.
 *
 * What these pin, and why each one matters:
 *
 *  • ordering is **deterministic**: the bar must not reshuffle when two widgets
 *    declare the same `order` (a status bar that reorders itself between builds is
 *    the kind of bug nobody can reproduce);
 *  • the registry's invariants are checkable in one place (duplicate ids, empty
 *    test ids) — an id typo must fail here, not depend on which widget a DOM test
 *    happens to look at first;
 *  • every module's `titleKey` **resolves in both locales** — the chrome is product
 *    UI, so a widget with no name is a missing translation, not a style choice;
 *  • the real registry is held to all of it, so adding a widget without naming it
 *    is a red test rather than a silent gap.
 */
import { describe, expect, test } from "vitest";
import {
  formatShortcut,
  moduleForShortcut,
  modulesFor,
  normalizeKey,
  overlayShortcutHint,
  shortcutAria,
  shortcutMatches,
  type ShellModule,
} from "../lib/shellModule";
import { SHELL_MODULES } from "../svelte/shellModules";
import { zh } from "../i18n/locales/zh";
import { en } from "../i18n/locales/en";

/** A throwaway module (the contract must be testable without the real registry). */
function mod(over: Partial<ShellModule> & { id: string }): ShellModule {
  return {
    slot: "topbar-right",
    order: 0,
    titleKey: "desktop.clock",
    testId: `t-${over.id}`,
    component: {} as never,
    ...over,
  };
}

/** Named fixtures — an array index would be `T | undefined` under this repo's
 * `noUncheckedIndexedAccess`, so the fixtures are named rather than positional. */
const TIE_A = mod({ id: "tie-a", order: 20 });
const TIE_B = mod({ id: "tie-b", order: 20 });
const TIE_C = mod({ id: "tie-c", order: 20 });
const FIRST = mod({ id: "first", order: 10 });
const THIRD = mod({ id: "third", order: 30 });

describe("shell module contract", () => {
  test("modulesFor keeps only the asked-for slot", () => {
    const mods = [
      mod({ id: "a", slot: "topbar-right" }),
      mod({ id: "b", slot: "dock" }),
      mod({ id: "c", slot: "overlay" }),
    ];
    expect(modulesFor("topbar-right", mods).map((m) => m.id)).toEqual(["a"]);
    expect(modulesFor("dock", mods).map((m) => m.id)).toEqual(["b"]);
    expect(modulesFor("stage", mods)).toEqual([]);
  });

  test("order decides the sequence, and ties keep registry order (stable)", () => {
    expect(modulesFor("topbar-right", [THIRD, FIRST, TIE_A, TIE_B, TIE_C]).map((m) => m.id)).toEqual(
      ["first", "tie-a", "tie-b", "tie-c", "third"],
    );

    // The `order` field always wins over position in the array…
    const sorted = modulesFor("topbar-right", [TIE_C, THIRD, TIE_A, FIRST, TIE_B]).map((m) => m.id);
    expect(sorted[0]).toBe("first");
    expect(sorted[sorted.length - 1]).toBe("third");
    // …and equal orders follow the **registry's** order (the array), which is what
    // "stable" means here: the sorter never invents an order of its own, so the same
    // registry draws the same bar. Reordering the table is the only way to reorder a
    // tie — deliberately, because that is a reviewable diff.
    expect(sorted).toEqual(["first", "tie-c", "tie-a", "tie-b", "third"]);
  });
});

describe("the shipped chrome registry", () => {
  test("holds its invariants (unique ids, named widgets, finite order)", () => {
    const ids = new Set<string>();
    const testIds = new Set<string>();
    const problems: string[] = [];
    for (const m of SHELL_MODULES) {
      if (!m.id.trim()) problems.push("a module has an empty id");
      else if (ids.has(m.id)) problems.push(`duplicate module id: ${m.id}`);
      ids.add(m.id);

      if (!m.titleKey.trim()) problems.push(`${m.id}: empty titleKey`);
      if (!m.testId.trim()) problems.push(`${m.id}: empty testId`);
      else if (testIds.has(m.testId)) problems.push(`duplicate testId: ${m.testId}`);
      testIds.add(m.testId);

      if (!Number.isFinite(m.order)) problems.push(`${m.id}: order is not a finite number`);
    }
    // Every problem at once, not the first: an id typo must not depend on which
    // widget happens to be checked first.
    expect(problems).toEqual([]);
  });

  test("is non-empty and every widget lives in exactly one known slot", () => {
    expect(SHELL_MODULES.length).toBeGreaterThan(0);
    const slots = ["topbar-left", "topbar-right", "stage", "dock", "overlay"] as const;
    const total = slots.reduce((n, s) => n + modulesFor(s, SHELL_MODULES).length, 0);
    expect(total).toBe(SHELL_MODULES.length);
    // Every slot has a container now (REQ-A262): an empty slot would mean a container
    // rendering nothing, which is how `topbar-left`/`stage`/`dock`/`overlay` sat before.
    for (const s of slots) {
      expect(modulesFor(s, SHELL_MODULES).length, `slot ${s} is empty`).toBeGreaterThan(0);
    }
  });

  test("every module's titleKey resolves in zh and en", () => {
    const missing: string[] = [];
    for (const m of SHELL_MODULES) {
      if (!(m.titleKey in zh)) missing.push(`${m.id}: zh missing ${m.titleKey}`);
      if (!(m.titleKey in en)) missing.push(`${m.id}: en missing ${m.titleKey}`);
    }
    expect(missing).toEqual([]);
  });

  test("the shipped order is the order the bar documents", () => {
    expect(modulesFor("topbar-left", SHELL_MODULES).map((m) => m.id)).toEqual([
      "apple-menu",
      "app-name",
      "main-menu",
    ]);
    expect(modulesFor("topbar-right", SHELL_MODULES).map((m) => m.id)).toEqual([
      "launchpad-trigger",
      "spotlight-trigger",
      "control-center",
      "radios",
      "clock",
      "battery",
    ]);
    expect(modulesFor("dock", SHELL_MODULES).map((m) => m.id)).toEqual([
      "dock-launchpad",
      "dock-finder",
      "dock-trash",
    ]);
    expect(modulesFor("overlay", SHELL_MODULES).map((m) => m.id)).toEqual([
      "launchpad",
      "spotlight",
      "mission-control",
      "control-center-panel",
    ]);
  });

  test("exactly one dock item carries the separator, and it is not the first or last", () => {
    const dock = modulesFor("dock", SHELL_MODULES);
    const separators = dock.filter((m) => m.separatorBefore === true);
    expect(separators.map((m) => m.id)).toEqual(["dock-trash"]);
    expect(dock[0]?.separatorBefore).not.toBe(true); // nothing left of a leading divider
    expect(dock[dock.length - 1]?.separatorBefore).toBe(true); // macOS: apps │ Trash
  });

  test("only dock items declare a windowLabel (the running dot's window)", () => {
    const withLabel = SHELL_MODULES.filter((m) => m.windowLabel !== undefined);
    expect(withLabel.every((m) => m.slot === "dock")).toBe(true);
    // Exactly one carries one — the Finder tile: `dock-finder` is a module id, not a
    // window label, which is why the fact is data instead of a guess from the id.
    expect(withLabel.map((m) => `${m.id}=${m.windowLabel}`)).toEqual(["dock-finder=files"]);
  });
});

describe("the shortcut table (the overlay rows are the list)", () => {
  test("every binding is unique across the overlays (two overlays cannot own one key)", () => {
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const m of modulesFor("overlay", SHELL_MODULES)) {
      for (const s of m.shortcuts ?? []) {
        const key = shortcutAria(s);
        const other = seen.get(key);
        if (other) clashes.push(`${key}: ${other} and ${m.id}`);
        seen.set(key, m.id);
      }
    }
    expect(clashes).toEqual([]);
    // …and the set is the one the shell documents: F4 / ⌘Space / F3 + ⌘Tab.
    expect([...seen.keys()].sort()).toEqual(["F3", "F4", "Meta+Space", "Meta+Tab"].sort());
  });

  test("only overlays declare shortcuts", () => {
    for (const m of SHELL_MODULES) {
      if (m.shortcuts !== undefined) expect(m.slot).toBe("overlay");
    }
  });

  test("F4 opens the Launchpad, ⌘Space the Spotlight, F3 and ⌘Tab Mission Control", () => {
    const at = (e: Parameters<typeof moduleForShortcut>[2]) =>
      moduleForShortcut("overlay", SHELL_MODULES, e)?.id;
    expect(at({ key: "F4" })).toBe("launchpad");
    expect(at({ key: "F3" })).toBe("mission-control");
    expect(at({ key: " ", metaKey: true })).toBe("spotlight");
    expect(at({ key: "Tab", metaKey: true })).toBe("mission-control");
    // Ctrl counts as ⌘ (the shell already treated them as one) …
    expect(at({ key: " ", ctrlKey: true })).toBe("spotlight");
    // … and a modifier the binding does not list must not fire it: F4 with ⌘ is free
    // for something else, and a bare Space must not open Spotlight while typing.
    expect(at({ key: "F4", metaKey: true })).toBeUndefined();
    expect(at({ key: " ", shiftKey: true, metaKey: true })).toBeUndefined();
    expect(at({ key: " " })).toBeUndefined();
    expect(at({ key: "F5" })).toBeUndefined();
  });

  test("the label a widget shows comes from the same row the matcher reads", () => {
    expect(overlayShortcutHint(SHELL_MODULES, "spotlight")).toEqual({
      label: "⌘Space",
      aria: "Meta+Space",
    });
    expect(overlayShortcutHint(SHELL_MODULES, "launchpad")).toEqual({ label: "F4", aria: "F4" });
    // The *first* binding is the displayed one; both are bound.
    expect(overlayShortcutHint(SHELL_MODULES, "mission-control")).toEqual({
      label: "F3",
      aria: "F3",
    });
    // An overlay with no binding, and one that does not exist: both `null`, never a guess.
    // (`control-center-panel` is the real row without `shortcuts` — macOS has no default
    // key for Control Center, so the panel is opened from its item.)
    expect(overlayShortcutHint(SHELL_MODULES, "control-center-panel")).toBeNull();
    expect(overlayShortcutHint(SHELL_MODULES, "nope")).toBeNull();
  });

  test("formatting/parsing agree on the shapes the shell binds", () => {
    expect(normalizeKey(" ")).toBe("Space");
    expect(normalizeKey("Spacebar")).toBe("Space");
    expect(normalizeKey("F4")).toBe("F4");
    expect(formatShortcut({ key: "Space", meta: true })).toBe("⌘Space");
    expect(formatShortcut({ key: "Tab", meta: true, shift: true })).toBe("⇧⌘⇥");
    expect(formatShortcut({ key: "F4" })).toBe("F4");
    expect(formatShortcut({ key: "ArrowDown" })).toBe("↓");
    expect(shortcutAria({ key: "Space", meta: true })).toBe("Meta+Space");
    expect(shortcutMatches({ key: " " }, { key: "Space" })).toBe(true);
  });
});
