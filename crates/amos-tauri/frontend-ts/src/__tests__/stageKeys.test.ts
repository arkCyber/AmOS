/**
 * stageKeys.test.ts — the Stage Manager chord as **data** (see `lib/stageKeys.ts`, REQ-A1568).
 *
 * The mode switch had no front door before this round: `crates/amos-tauri/src/stage.rs` owned
 * the commands and `StageRail.svelte` drew the rail, but the rail only exists *while the mode is
 * on*, so everything built for Stage Manager was unreachable for a user who had never seen it.
 * `lib/stageKeys.ts` is the chord that reaches it; this file is what keeps the chord honest.
 *
 * Three things rot silently here, one case each:
 *   * the **modifier set** — `shortcutMatches` decides with one shared truth table, and ⌃⌘S is
 *     only disjoint from the ⌘ family if ⌃ is genuinely *required*. It was not, until this
 *     round: `{meta: true, ctrl: true}` named itself "Ctrl AND ⌘" while matching `metaKey`
 *     alone, so the chord also fired on every app's bare ⌘S. The near-miss cases below are the
 *     pin for that, and the bidirectional family sweep is the pin for the rest;
 *   * the **keycap** — the Window menu shows `stageToggleLabel()`, read off the table, so the
 *     row cannot advertise a key the matcher no longer holds (the `snapZones` rule). The row's
 *     *source* is read here rather than trusted to a comment;
 *   * the **refusal sentences** — the two ways this chord does nothing are different facts
 *     ("the shell could not ask" vs "the host answered and said no"), and each must name the
 *     chord from the table.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DESKTOP_SYSTEM_KEYS } from "../lib/desktopKeys";
import { SPACES_DEFAULTS } from "../lib/keyboardConfigHook.svelte";
import { SNAP_KEYS, snapZoneFor } from "../lib/snapZones";
import {
  STAGE_TOGGLE_CHORD,
  isStageToggleChord,
  stageToggleLabel,
  stageToggleRefusal,
} from "../lib/stageKeys";
import { shortcutMatches, type ShellShortcut } from "../lib/shellModule";
import { SHELL_MODULES } from "../svelte/shellModules";

/** A keydown as the shell sees it (only the fields the matcher reads). */
const key = (
  k: string,
  mods: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean } = {},
) => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

/** The keydown a binding describes — the modifiers *it* asks for, and no others. */
const eventFor = (s: ShellShortcut) =>
  key(s.key, {
    ctrlKey: Boolean(s.ctrl),
    metaKey: Boolean(s.meta),
    altKey: Boolean(s.alt),
    shiftKey: Boolean(s.shift),
  });

/** The four overlay launches, straight off the registry (`F3 / F4 / ⌘Space / ⌘Tab`). */
function overlayShortcuts(): ShellShortcut[] {
  const rows = SHELL_MODULES as ReadonlyArray<{ id: string; shortcuts?: ReadonlyArray<ShellShortcut> }>;
  const out = rows.flatMap((r) => [...(r.shortcuts ?? [])]);
  // Non-vacuity: an empty or renamed registry field must fail here, not pass by comparing
  // nothing (the overlays are the family most likely to be mistaken for this chord).
  expect(out.length, "the registry must still declare the four overlay launches").toBeGreaterThanOrEqual(4);
  return out;
}

/**
 * The chords the shell already matches, as (label, binding) pairs. Each family is asserted
 * non-empty so a renamed export cannot turn the sweep below into a no-op.
 */
function takenChords(): Array<[string, ShellShortcut]> {
  const system: Array<[string, ShellShortcut]> = DESKTOP_SYSTEM_KEYS.map((r) => [
    `system:${r.intent.kind}`,
    r.shortcut,
  ]);
  const snap: Array<[string, ShellShortcut]> = SNAP_KEYS.map((r) => [`snap:${r.zone}`, r.shortcut]);
  const spaces: Array<[string, ShellShortcut]> = Object.entries(SPACES_DEFAULTS).map(([id, s]) => [
    `spaces:${id}`,
    s,
  ]);
  const overlays: Array<[string, ShellShortcut]> = overlayShortcuts().map((s, i) => [
    `overlay:${i}`,
    s,
  ]);
  for (const [family, list] of [
    ["system", system],
    ["snap", snap],
    ["spaces", spaces],
    ["overlay", overlays],
  ] as const) {
    expect(list.length, `the ${family} family must not be empty`).toBeGreaterThan(0);
  }
  return [...system, ...snap, ...spaces, ...overlays];
}

describe("stageKeys", () => {
  test("the chord is ⌃⌘ + one key, and **both** modifiers are really required", () => {
    expect(STAGE_TOGGLE_CHORD.ctrl, "the ⌃ is what makes this chord free").toBe(true);
    expect(STAGE_TOGGLE_CHORD.meta, "the ⌘ half of the ⌃⌘ fold").toBe(true);
    expect(STAGE_TOGGLE_CHORD.alt ?? false).toBe(false);
    expect(STAGE_TOGGLE_CHORD.shift ?? false).toBe(false);
    expect(STAGE_TOGGLE_CHORD.key.length, "a letter, not a named key").toBe(1);

    // Fires on the chord the table names…
    expect(isStageToggleChord(eventFor(STAGE_TOGGLE_CHORD))).toBe(true);
    // …and each of these is a chord owned by someone else, or an inexact modifier set. ⌘S in
    // particular is the case this round had to *fix* in the matcher: `{meta, ctrl}` used to
    // accept ⌘ alone, which would have swallowed every app's Save.
    expect(isStageToggleChord(key("s", { metaKey: true })), "⌘S belongs to the app").toBe(false);
    expect(isStageToggleChord(key("s", { ctrlKey: true })), "⌃S is nobody's").toBe(false);
    expect(isStageToggleChord(key("s", { ctrlKey: true, metaKey: true, shiftKey: true }))).toBe(false);
    expect(isStageToggleChord(key("s", { ctrlKey: true, metaKey: true, altKey: true }))).toBe(false);
    expect(isStageToggleChord(key("s"))).toBe(false);
    // Same chord, wrong key (⇧ is part of the set the matcher compares exactly).
    expect(isStageToggleChord(key("S", { ctrlKey: true, metaKey: true }))).toBe(true);
    expect(isStageToggleChord(key("d", { ctrlKey: true, metaKey: true }))).toBe(false);
  });

  test("the chord is disjoint from every family the shell already matches", () => {
    const stageEvent = eventFor(STAGE_TOGGLE_CHORD);
    for (const [label, binding] of takenChords()) {
      // Nothing else claims ⌃⌘S…
      expect(
        shortcutMatches(stageEvent, binding),
        `${label} (${JSON.stringify(binding)}) must not match the Stage chord`,
      ).toBe(false);
      // …and pressing that family's own chord never toggles Stage. The snap family is checked
      // through its own entry point too, because `snapZoneFor` is what the shell calls first.
      const e = eventFor(binding);
      expect(isStageToggleChord(e), `the Stage chord must not claim ${label}`).toBe(false);
    }
    for (const row of SNAP_KEYS) {
      expect(snapZoneFor(stageEvent), `${row.zone} must not claim the Stage chord`).toBeNull();
    }
  });

  test("the keycap is read off the chord the matcher holds", () => {
    const label = stageToggleLabel();
    expect(label).toBe("⌃⌘S");
    // What the menu shows and what the engine matches are the same binding: the label's own
    // glyphs round-trip back into a keydown the matcher accepts. A keycap that survives the
    // chord being rebound (to, say, ⌃⌘T) would fail here rather than in the field.
    expect(isStageToggleChord(key(STAGE_TOGGLE_CHORD.key, { ctrlKey: true, metaKey: true }))).toBe(true);

    // …and the Window menu row really does take its keycap from that function, rather than
    // typing the glyphs beside it (REQ-A342: a hint must not outlive the binding it names).
    const menu = readFileSync(
      new URL("../svelte/modules/TopbarMainMenu.svelte", import.meta.url),
      "utf8",
    );
    const rowAt = menu.indexOf('id: "window.stage-manager"');
    expect(rowAt, "the Window menu must keep a `window.stage-manager` row").toBeGreaterThan(-1);
    const row = menu.slice(rowAt, menu.indexOf("},", rowAt));
    expect(row, "the row's keycap comes from the table").toContain("shortcut: stageToggleLabel(),");
    // Tidy has no key: nothing binds it, so a keycap there would advertise a dead key.
    const tidyAt = menu.indexOf('id: "window.stage-tidy"');
    expect(tidyAt, "the Window menu must keep a `window.stage-tidy` row").toBeGreaterThan(-1);
    expect(menu.slice(tidyAt, menu.indexOf("},", tidyAt))).not.toContain("shortcut:");
  });

  test("the bridge sentence names the chord from the table and claims nothing was attempted", () => {
    const label = stageToggleLabel();
    // The sentence names the chord the user pressed, read off the table.
    expect(stageToggleRefusal()).toContain(label);
    // "nothing was attempted" — it must not borrow the host-refusal register, which would
    // name a cause (`the host refused`) that this fact does not establish.
    expect(stageToggleRefusal()).toContain("could not reach the host");
    expect(stageToggleRefusal()).not.toContain("refused");
  });

  test("the shell's toggle names a refusal through the family's one wording rule", () => {
    // `lib/stage.ts::stageFailure` documents itself as the **only** place that turns an
    // `amos.stage.*` code into a sentence, precisely because this refusal family has several
    // faces (the rail's buttons, the Window menu's Tidy, the settings switch). The chord and
    // the Window menu's Stage row are two more — and they used to hand-write a sentence of
    // their own, which named `no stage rail`, a refusal `stage_set_enabled` cannot produce on
    // a desktop (its guard is `rail == 0`, and this path only runs where a rail exists), while
    // it could not name `amos.stage.persist_failed` that the rest of the family maps.
    const shell = readFileSync(new URL("../svelte/DesktopShell.svelte", import.meta.url), "utf8");
    const at = shell.indexOf("async function toggleStage()");
    expect(at, "DesktopShell must keep its `toggleStage`").toBeGreaterThan(-1);
    const body = shell.slice(at, shell.indexOf("\n  }", at));
    expect(body, "the refusal goes through the family's one rule").toContain(
      'stageFailure("stage_set_enabled")',
    );
    expect(body, "a second hand-written sentence is what drifted").not.toContain(
      'stageToggleRefusal("host-refused")',
    );
  });
});
