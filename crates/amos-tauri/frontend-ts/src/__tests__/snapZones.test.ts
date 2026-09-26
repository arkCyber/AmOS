/**
 * snapZones.test.ts — the desktop shell's snapping table as **data** (see `lib/snapZones.ts`).
 *
 * Three things can silently rot here, and each has a case below:
 *   * the **zone list** drifting from `amos_wm::snap::SnapZone::ALL` — a zone the host does
 *     not know becomes a chord that always gets refused, and one missing here becomes a
 *     region no person can reach. The list is read from Rust's `ALL`/`key()`, in that order;
 *   * the **chords** drifting into a family the shell already owns (⌘… system keys, ⌃ + arrows
 *     Spaces, F3/F4/⌘Space/⌘Tab overlays) — every row is asserted to be `⌃⌥` + one key, and
 *     the modifier-exact matcher is pin-driven against the near misses;
 *   * the **labels** drifting from the table — `snapRefusal` names the chord the user pressed,
 *     read off the row, so the sentence cannot advertise a key the table no longer holds.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  SNAP_KEYS,
  SNAP_ZONES,
  snapRefusal,
  snapShortcutLabel,
  snapZoneFor,
  type SnapZone,
} from "../lib/snapZones";

/**
 * The zone list as `amos_wm::snap::SnapZone::ALL` really declares it — read from the Rust
 * source (REQ-A654) instead of re-typed here. `ALL` fixes the variant **order** and `key()`
 * maps each variant to its **wire string**, so a zone added, renamed or reordered in
 * `amos-wm` fails this test rather than leaving a chord that does nothing (or a region no one
 * can reach). Before REQ-A654 this was a local literal that could only ever equal itself.
 */
function rustZoneKeys(): string[] {
  const src = readFileSync(new URL("../../../../amos-wm/src/snap.rs", import.meta.url), "utf8");
  const allAt = src.indexOf("pub const ALL: [SnapZone; 9] = [");
  const implAt = src.indexOf("impl SnapZone {");
  const keyAt = src.indexOf("pub fn key(self)", implAt);
  expect(allAt, "SnapZone::ALL not found in amos-wm/src/snap.rs").toBeGreaterThan(-1);
  expect(keyAt, "SnapZone::key() not found").toBeGreaterThan(-1);
  const allBody = src.slice(allAt, src.indexOf("];", allAt));
  const variants = [...allBody.matchAll(/SnapZone::(\w+)/g)].map((m) => m[1] ?? "");
  // `key()` runs to the next method in the same impl block.
  const keyBody = src.slice(keyAt, src.indexOf("\n    pub fn ", keyAt));
  const keys = new Map(
    [...keyBody.matchAll(/SnapZone::(\w+) => "([^"]+)"/g)].map((m) => [m[1] ?? "", m[2] ?? ""]),
  );
  // Non-vacuity: a partial/empty parse must fail here, not silently compare short lists.
  expect(variants, "SnapZone::ALL must list 9 variants").toHaveLength(9);
  expect(keys.size, "SnapZone::key() must map 9 variants").toBe(9);
  return variants.map((v) => keys.get(v) ?? `«no key for ${v}»`);
}

/** A keydown as the shell sees it (only the fields the matcher reads). */
const key = (k: string, mods: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean } = {}) => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("snapZones", () => {
  test("the zone list mirrors amos_wm::snap::SnapZone::ALL, in wire order", () => {
    expect(SNAP_KEYS.map((r) => r.zone)).toEqual(rustZoneKeys() as SnapZone[]);
    // No zone twice: two rows for one region would make the second unreachable.
    expect(new Set(SNAP_KEYS.map((r) => r.zone)).size).toBe(SNAP_KEYS.length);
  });

  test("SNAP_ZONES is a view of the table, not a second list (REQ-A816)", () => {
    // The in-app Window menu builds one row per `SNAP_ZONES` entry. Two properties make that
    // safe: it is the table's own zones (so the two surfaces cannot offer different regions),
    // and the keycap a row shows comes off the row it names — a menu must not advertise a chord
    // the engine would not match. `snapShortcutLabel` returning "" for an unknown zone is the
    // honest answer for a zone that is not in the table; every zone **is**, so no row is blank.
    expect([...SNAP_ZONES]).toEqual(SNAP_KEYS.map((r) => r.zone));
    expect(new Set(SNAP_ZONES).size).toBe(SNAP_ZONES.length);
    for (const row of SNAP_KEYS) {
      expect(snapShortcutLabel(row.zone), `${row.zone} has a keycap`).not.toBe("");
      // …and that keycap is the chord `snapZoneFor` really matches: the round trip is what
      // couples the menu's hint to the engine, not the shared function call.
      const e = {
        key: row.shortcut.key,
        ctrlKey: row.shortcut.ctrl ?? false,
        metaKey: row.shortcut.meta ?? false,
        altKey: row.shortcut.alt ?? false,
        shiftKey: row.shortcut.shift ?? false,
      };
      expect(snapZoneFor(e), `the keycap shown for ${row.zone} names ${row.zone}`).toBe(row.zone);
    }
    // A zone outside the table has no keycap to show, rather than an invented one.
    expect(snapShortcutLabel("sideways" as SnapZone)).toBe("");
  });

  test("every chord is ⌃⌥ + one key, and no two rows share one", () => {
    const chords = SNAP_KEYS.map((r) => {
      const s = r.shortcut;
      // ⌥ is what keeps this family disjoint from every other shell binding: the system
      // keys require ⌘, Spaces requires ⌃ without ⌥, the overlays are F-keys/⌘-combos —
      // and `shortcutMatches` compares modifiers **exactly**, so a missing ⌥ would let a
      // snap row swallow a Spaces chord.
      expect(s.ctrl, `${r.zone} is a Ctrl binding`).toBe(true);
      expect(s.alt, `${r.zone} is an Option binding`).toBe(true);
      expect(s.meta ?? false, `${r.zone} must not require ⌘`).toBe(false);
      expect(s.shift ?? false, `${r.zone} must not require ⇧`).toBe(false);
      return `${s.key}`;
    });
    expect(new Set(chords).size).toBe(chords.length);
  });

  test("the matcher fires on the documented chords and on nothing else", () => {
    // The Rectangle-compatible vocabulary this table chose on purpose.
    expect(snapZoneFor(key("ArrowLeft", { ctrlKey: true, altKey: true }))).toBe("left");
    expect(snapZoneFor(key("ArrowRight", { ctrlKey: true, altKey: true }))).toBe("right");
    expect(snapZoneFor(key("ArrowUp", { ctrlKey: true, altKey: true }))).toBe("top");
    expect(snapZoneFor(key("ArrowDown", { ctrlKey: true, altKey: true }))).toBe("bottom");
    expect(snapZoneFor(key("u", { ctrlKey: true, altKey: true }))).toBe("top-left");
    expect(snapZoneFor(key("i", { ctrlKey: true, altKey: true }))).toBe("top-right");
    expect(snapZoneFor(key("j", { ctrlKey: true, altKey: true }))).toBe("bottom-left");
    expect(snapZoneFor(key("k", { ctrlKey: true, altKey: true }))).toBe("bottom-right");
    expect(snapZoneFor(key("Enter", { ctrlKey: true, altKey: true }))).toBe("maximize");

    // Near misses: each of these is a real chord owned by someone else (⌃← is Spaces,
    // ⌘⌥← is a system key, a bare ← is a caret move in a text field) or an inexact
    // modifier set, so none of them may snap.
    expect(snapZoneFor(key("ArrowLeft", { ctrlKey: true }))).toBeNull();
    expect(snapZoneFor(key("ArrowLeft", { altKey: true }))).toBeNull();
    expect(snapZoneFor(key("ArrowLeft", { metaKey: true, altKey: true }))).toBeNull();
    expect(snapZoneFor(key("ArrowLeft", { ctrlKey: true, altKey: true, shiftKey: true }))).toBeNull();
    expect(snapZoneFor(key("ArrowLeft"))).toBeNull();
    // The corners are letters, so a bare / ⇧ letter must not snap either (it is typing).
    expect(snapZoneFor(key("u", { ctrlKey: true, altKey: true, shiftKey: true }))).toBeNull();
    expect(snapZoneFor(key("u"))).toBeNull();
    // ↩ is only the fill chord with both modifiers; plain Return stays a form submission.
    expect(snapZoneFor(key("Enter"))).toBeNull();
  });

  test("the refusal sentences name the chord from the row itself", () => {
    // Pins the two facts a user needs from a dead chord: which key it was, and that the
    // reason is one of two different ones (nothing to act on vs. the host said no).
    for (const [zone, chord] of [
      ["left", "⌃⌥←"],
      ["bottom-right", "⌃⌥K"],
      ["maximize", "⌃⌥↩"],
    ] as const) {
      expect(snapRefusal(zone, "no-window")).toContain(chord);
      expect(snapRefusal(zone, "host-refused")).toContain(chord);
    }
    expect(snapRefusal("left", "no-window")).toContain("no focused app window");
    expect(snapRefusal("left", "no-window")).not.toContain("refused");
    expect(snapRefusal("left", "host-refused")).toContain("the host refused");
    expect(snapRefusal("left", "host-refused")).toContain("free window geometry");
  });
});
