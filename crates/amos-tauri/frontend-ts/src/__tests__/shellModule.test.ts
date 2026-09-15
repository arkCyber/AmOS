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
import { modulesFor, type ShellModule } from "../lib/shellModule";
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

  test("is non-empty and every widget is in the top bar's right slot", () => {
    expect(SHELL_MODULES.length).toBeGreaterThan(0);
    expect(modulesFor("topbar-right", SHELL_MODULES).length).toBe(SHELL_MODULES.length);
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
    expect(modulesFor("topbar-right", SHELL_MODULES).map((m) => m.id)).toEqual([
      "launchpad-trigger",
      "spotlight-trigger",
      "control-center",
      "radios",
      "clock",
      "battery",
    ]);
  });
});
