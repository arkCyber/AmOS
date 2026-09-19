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
import { readdirSync, readFileSync } from "node:fs";
import {
  bindingHint,
  formatShortcut,
  modulesFor,
  topOverlay,
  normalizeKey,
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
      // spaces-panel is the 5th overlay (order 50). It deliberately has no entry
      // in the chrome shortcuts table — its launch binding (Ctrl+↑) is wired in
      // `DesktopShell` so the doc-vs-code invariant on the shortcut set
      // (`F3 / F4 / ⌘Space / ⌘Tab`) keeps holding and Ctrl+ArrowLeft/Right stays
      // free for editor caret motion.
      "spaces-panel",
      // REQ-A417: the desktop notification panel (macOS's right-hand surface, opened from
      // the clock). It carries no `shortcuts` row on purpose, so the documented shortcut
      // set above is unchanged by its arrival.
      "notifications",
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

  // 这里曾有一条 `moduleForShortcut("overlay", SHELL_MODULES, e)` 的矩阵（F4 / ⌘Space /
  // F3 / ⌘Tab、Ctrl 视作 ⌘、未列出的修饰符不得触发）。REQ-A394 之后，桌面壳与触摸壳都
  // 从**合并后的绑定**里找匹配（`keyboardConfigHook.findMatchingBinding`），`moduleForShortcut`
  // 因此零生产调用点、已删除；同一套语义由两处**真路径**钉住，不在这里重写一遍匹配器
  // （那会变成"测自己写的 lambda"）：
  //   • `src/lib/__tests__/keyboardConfigHook.bindings.test.ts` —— 合成矩阵（含 Ctrl→⌘、
  //     严格修饰符、先声明先命中、空表）；
  //   • `svelte-tests/desktop-shell.svelte.test.ts` —— 端到端：F4/F3 真的开、再按真的关、
  //     ⌘F3 不开、用户改键/禁用后以合并结果为准。

  test("the label a widget shows comes from the same row the matcher reads", () => {
    // 提示从**行**里折叠（`bindingHint`），行本身可以来自注册表，也可以来自合并后的绑定
    // （桌面壳读的是后者 —— 用户改过的键因此显示的就是他自己那把）。
    const row = (id: string) =>
      modulesFor("overlay", SHELL_MODULES).find((m) => m.id === id)?.shortcuts;

    expect(bindingHint(row("spotlight"))).toEqual({
      label: "⌘Space",
      aria: "Meta+Space",
    });
    expect(bindingHint(row("launchpad"))).toEqual({ label: "F4", aria: "F4" });
    // The *first* binding is the displayed one; both are bound.
    expect(bindingHint(row("mission-control"))).toEqual({
      label: "F3",
      aria: "F3",
    });
    // An overlay with no binding, and one that does not exist: both `null`, never a guess.
    // (`control-center-panel` is the real row without `shortcuts` — macOS has no default
    // key for Control Center, so the panel is opened from its item.)
    expect(bindingHint(row("control-center-panel"))).toBeNull();
    expect(bindingHint(row("nope"))).toBeNull();
    // 合并后的覆盖行（用户在键盘设置里改成 F9）同样只显示第一个绑定
    expect(bindingHint([{ key: "F9" }])).toEqual({ label: "F9", aria: "F9" });
  });

  test("formatting/parsing agree on the shapes the shell binds", () => {
    expect(normalizeKey(" ")).toBe("Space");
    expect(normalizeKey("Spacebar")).toBe("Space");
    expect(normalizeKey("F4")).toBe("F4");
    // FMEA: letter keys from `KeyboardEvent.key` are lowercase, but human-written
    // shortcuts are uppercase. `normalizeKey` widens matching on both sides so a
    // typed ⌘W matches a binding declared as `{ key: "W", meta: true }`.
    expect(normalizeKey("w")).toBe("W");
    expect(normalizeKey("W")).toBe("W");
    expect(formatShortcut({ key: "Space", meta: true })).toBe("⌘Space");
    expect(formatShortcut({ key: "Tab", meta: true, shift: true })).toBe("⇧⌘⇥");
    expect(formatShortcut({ key: "F4" })).toBe("F4");
    expect(formatShortcut({ key: "ArrowDown" })).toBe("↓");
    expect(formatShortcut({ key: "ArrowUp", ctrl: true })).toBe("⌃↑");
    expect(shortcutAria({ key: "Space", meta: true })).toBe("Meta+Space");
    expect(shortcutAria({ key: "ArrowUp", ctrl: true })).toBe("Control+ArrowUp");
    expect(shortcutMatches({ key: " " }, { key: "Space" })).toBe(true);
  });

  /**
   * REQ-A297 phase-2 §2 (compat policy). The shell chrome has always counted
   * ⌃ as ⌘ on `meta`-decorated bindings; adding `ctrl` was meant to escape
   * that fold, not break it. This table pins the four corners the inline
   * doc-comment promises:
   *
   *   ┌──────────────┬──────────────────────────┬──────────────────┐
   *   │ Binding      │ Event                    │ Expected match   │
   *   ├──────────────┼──────────────────────────┼──────────────────┤
   *   │ { meta }     │ metaKey OR ctrlKey       │ meta binding     │
   *   │ { meta, ctrl } │ metaKey (ctrlKey alone) │ false (escapes) │
   *   │ { ctrl }     │ ctrlKey alone            │ ctrl binding     │
   *   │ { }          │ metaKey + ctrlKey        │ false (modifier) │
   *   └──────────────┴──────────────────────────┴──────────────────┘
   */
  test("the modifier truth-table: ctrl as meta fold + ctrl-only escape hatch", () => {
    // Row 1: implicit ctrl→meta fold (legacy Apple-keyboard freedom)
    expect(shortcutMatches({ key: "Space", metaKey: true }, { key: "Space", meta: true })).toBe(true);
    expect(shortcutMatches({ key: " ", ctrlKey: true }, { key: "Space", meta: true })).toBe(true);
    expect(shortcutMatches({ key: " ", metaKey: true, ctrlKey: true }, { key: "Space", meta: true })).toBe(true);
    // Row 2: opted-in `ctrl: true` escapes the fold and requires metaKey-only
    expect(shortcutMatches({ key: " ", ctrlKey: true }, { key: " ", meta: true, ctrl: true })).toBe(false);
    // Row 3: pure-Ctrl row
    expect(shortcutMatches({ key: "ArrowUp", ctrlKey: true }, { key: "ArrowUp", ctrl: true })).toBe(true);
    expect(shortcutMatches({ key: "ArrowUp", metaKey: true, ctrlKey: true }, { key: "ArrowUp", ctrl: true })).toBe(false);
    expect(shortcutMatches({ key: "ArrowUp", metaKey: true }, { key: "ArrowUp", ctrl: true })).toBe(false);
    // Row 4: a no-modifier binding must NOT fire when the user is holding a modifier
    expect(shortcutMatches({ key: "F4", metaKey: true }, { key: "F4" })).toBe(false);
    expect(shortcutMatches({ key: "F4", ctrlKey: true }, { key: "F4" })).toBe(false);
  });

  test("letter keys match case-insensitively (FMEA: ⌘W from a real keyboard)", () => {
    // `KeyboardEvent.key` for "W" is "w". A binding declared `{ key: "W", meta: true }`
    // must still match — the comparison must widen to upper on both sides.
    expect(shortcutMatches({ key: "w", metaKey: true }, { key: "W", meta: true })).toBe(true);
    expect(shortcutMatches({ key: "W", metaKey: true }, { key: "w", meta: true })).toBe(true);
    expect(shortcutMatches({ key: "L", metaKey: true }, { key: "l", meta: true })).toBe(true);
  });
});

/**
 * Structural gate: an overlay id only exists if the registry declares it.
 *
 * REQ-A414 — the Hot Corners listener's default "Mission Control" action called
 * `api.toggleOverlay("spaces")`, but no overlay row has that id (the rows are
 * `launchpad` / `spotlight` / `mission-control` / `control-center-panel` /
 * `spaces-panel`). The call was *accepted*: the id entered `openOverlays`, rendered
 * nothing, and then the shell's `Escape` handler closed that phantom instead of the
 * real top layer — the documented default hot corner did nothing, twice over
 * (silently, and it ate one Escape). Nothing in the suite looked at the call sites.
 *
 * This test reads every `toggleOverlay("…")` / `openOverlay("…")` /
 * `isOverlayOpen("…")` literal in `src/` and holds it to the registry, so the next
 * id typo fails here instead of on a user's desktop.
 */
describe("overlay-id call sites (structural)", () => {
  test("every literal overlay id passed to the chrome API exists in the registry", () => {
    const known = new Set(modulesFor("overlay", SHELL_MODULES).map((m) => m.id));
    expect(known.size).toBeGreaterThan(0);

    const srcRoot = new URL("../", import.meta.url).pathname; // …/frontend-ts/src
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        if (ent.name === "node_modules" || ent.name === "__tests__") continue;
        const p = `${dir}/${ent.name}`;
        if (ent.isDirectory()) walk(p);
        else if (/\.(ts|svelte)$/.test(ent.name)) files.push(p);
      }
    };
    walk(srcRoot);

    const re = /\b(?:toggleOverlay|openOverlay|isOverlayOpen|overlayShortcut)\(\s*["']([A-Za-z0-9-]+)["']/g;
    const seen = new Set<string>();
    const bad: string[] = [];
    for (const f of files) {
      // **Prose is not a call site.** The defect this gate exists for is *documented* in
      // comments (the literal `toggleOverlay("spaces")` appears in the history notes for
      // REQ-A414/A415), and a naive regex read those as evidence of a live call — the same
      // "the gate read the narrative as a contract" failure `scripts/make-target-doc-scan.mjs`
      // records for `docs/archive/`. So whole-line `//` comments and block comments are
      // stripped first. Only whole-line `//` (never a trailing one) so a URL inside a
      // string literal cannot truncate a real call site.
      const text = readFileSync(f, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "");
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const id = m[1];
        if (!id) continue;
        seen.add(id);
        if (!known.has(id)) bad.push(`${f.slice(srcRoot.length)}: "${id}"`);
      }
    }
    // Sanity: the scan really found the call sites (a broken regex would otherwise pass).
    expect(seen.size).toBeGreaterThan(0);
    expect(bad).toEqual([]);
  });

  test("topOverlay closes the last layer the registry really declares", () => {
    const ids = modulesFor("overlay", SHELL_MODULES).map((m) => m.id);

    // Nothing open ⇒ nothing to close (and `Escape` must not be consumed).
    expect(topOverlay([], ids)).toBeNull();

    // The normal case: the top of the stack.
    expect(topOverlay(["launchpad", "spotlight"], ids)).toBe("spotlight");

    // REQ-A415: an id no row declares draws nothing. The old code closed the raw last
    // entry, so one such entry swallowed an `Escape` and left the *visible* panel up —
    // the "the panel is sticky" symptom the hot-corner defect produced.
    expect(topOverlay(["launchpad", "spaces"], ids)).toBe("launchpad");
    expect(topOverlay(["launchpad", "nope", "also-nope"], ids)).toBe("launchpad");

    // A stack with nothing registered in it is "nothing to close", not a guess.
    expect(topOverlay(["nope", "also-nope"], ids)).toBeNull();

    // Pure: the stack is not modified.
    const stack = ["launchpad", "spaces"];
    topOverlay(stack, ids);
    expect(stack).toEqual(["launchpad", "spaces"]);
  });
});

