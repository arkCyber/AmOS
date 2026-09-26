/**
 * snapZones.ts — the desktop shell's **window-snapping** chords, as a table (REQ-A616).
 *
 * Snapping is the one desktop window capability that had no front door: `amos-wm` and the
 * host could place a window (maximize, split, cascade) but nothing let a *person* ask for
 * "left half" — the geometry rule is `amos_wm::snap::snap_bounds` and the command is
 * `wm_snap`, and this module is the chord→zone table that reaches them.
 *
 * Since REQ-A816 there are **two** front doors to the same zones and the same command:
 * these chords, and the in-app `Window` menu's zone rows (`TopbarMainMenu.svelte`), which
 * iterate [`SNAP_ZONES`] — a view of this table, so a zone added here (and therefore to
 * `SnapZone::ALL`, which a test pins this list against) is reachable by mouse and by key in
 * the same commit, and neither surface can offer a region the other does not. What is
 * **not** wired is drag-to-screen-edge, the gesture a macOS user reaches for first. The
 * title bar is a `data-tauri-drag-region` (REQ-A440 measured on device that the *platform*
 * runs that drag: Tauri starts it on exactly the elements carrying the attribute), so the
 * page sees no pointer stream for the move and there is no "released against an edge" event
 * to key a snap on. Recorded as an open gap rather than approximated — an invented
 * threshold that no device has judged is the kind of number this repo refuses to ship.
 *
 * Design, mirroring `lib/desktopKeys.ts`:
 *   * the **table** is the truth — the zone list mirrors `amos_wm::snap::SnapZone::ALL` and
 *     the wire keys are the Rust `SnapZone::key()` strings, so a zone added on one side and
 *     not the other is caught by a test rather than becoming a chord that does nothing;
 *   * matching reuses `shortcutMatches` — the registry's own rulebook — so exact-modifier
 *     matching behaves exactly as it does for every other shell key;
 *   * the chords are **Rectangle-compatible** (`⌃⌥←/→/↑/↓` halves, `⌃⌥U/I/J/K` corners,
 *     `⌃⌥↩` fill), because that is the de-facto macOS tiling vocabulary users already know.
 *
 * Scope boundary: these chords are **shell-owned** — unlike `⌘W`/`⌘M`, they are not (yet) a
 * user-rebindable keyboard-config domain, and they take the same route the Spaces family did
 * (`SPACES_DEFAULTS`) for the same reason: a fourth config domain is a separate change, and
 * inventing one here would put a chord in the Settings list that the config schema does not
 * yet carry. The zone list, the labels and the dispatch all live here, so promoting them to a
 * domain later touches one file.
 *
 * The **sentences** for the two ways a chord does nothing live here too ([`snapRefusal`]),
 * next to the table rather than in `DesktopShell`, for the reason `desktopSystemKeys` keeps
 * its `deadChordMessage` / `refusedChordMessage` together: a chord's keyboard label has one
 * source (`snapShortcutLabel`, read off the row itself), so a message can never advertise a
 * key the table no longer holds.
 */
import { formatShortcut, shortcutMatches, type ShellShortcut, type ShortcutEvent } from "./shellModule";

/**
 * A named screen region a window can be snapped to.
 *
 * These strings are the **wire keys** `amos_wm::snap::SnapZone::parse` accepts; the host
 * refuses anything else by name, so a typo here surfaces as a refused command rather than a
 * window that silently did not move.
 */
export type SnapZone =
  | "left"
  | "right"
  | "top"
  | "bottom"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right"
  | "maximize";

/** One chord, and the zone it asks for. */
export interface SnapKeyRow {
  zone: SnapZone;
  shortcut: ShellShortcut;
}

/**
 * The table. One row per zone, halves first (the chords a user reaches for), then corners,
 * then fill — the same order as `amos_wm::snap::SnapZone::ALL`.
 *
 * Every row is `⌃⌥` + one key: no row can collide with a system key (`⌘…`), the Spaces
 * family (`⌃` + arrows/`1-9`) or the overlay registry (`F3/F4/⌘Space/⌘Tab`), because each of
 * those either omits ⌥ or requires ⌘ — and `shortcutMatches` compares modifiers exactly.
 */
export const SNAP_KEYS: readonly SnapKeyRow[] = [
  { zone: "left", shortcut: { key: "ArrowLeft", ctrl: true, alt: true } },
  { zone: "right", shortcut: { key: "ArrowRight", ctrl: true, alt: true } },
  { zone: "top", shortcut: { key: "ArrowUp", ctrl: true, alt: true } },
  { zone: "bottom", shortcut: { key: "ArrowDown", ctrl: true, alt: true } },
  { zone: "top-left", shortcut: { key: "U", ctrl: true, alt: true } },
  { zone: "top-right", shortcut: { key: "I", ctrl: true, alt: true } },
  { zone: "bottom-left", shortcut: { key: "J", ctrl: true, alt: true } },
  { zone: "bottom-right", shortcut: { key: "K", ctrl: true, alt: true } },
  { zone: "maximize", shortcut: { key: "Enter", ctrl: true, alt: true } },
];

/**
 * The zones in table order — the **one** list every surface iterates (REQ-A816).
 *
 * A view of [`SNAP_KEYS`], not a second list: the in-app `Window` menu builds one row per
 * entry, so a zone can never be reachable by ⌃⌥ and missing from the menu (or the reverse),
 * and neither surface can name a region `amos_wm::snap::SnapZone::parse` would refuse.
 */
export const SNAP_ZONES: readonly SnapZone[] = SNAP_KEYS.map((r) => r.zone);

/**
 * The keycap a zone's chord shows (`"⌃⌥←"`), read off the row — for a refusal sentence, or
 * the keycap column of a menu row.
 *
 * Exported since REQ-A816 so the menu shows the key the **table** binds rather than a second
 * copy of it: a keycap is not translatable, and a hint that outlives its binding is the
 * defect `TopbarMainMenu`'s own header records (a row advertising a key nothing binds).
 */
export function snapShortcutLabel(zone: SnapZone): string {
  const row = SNAP_KEYS.find((r) => r.zone === zone);
  return row ? formatShortcut(row.shortcut) : "";
}

/** The zone a keydown asks for, or `null` when the event is not a snapping chord. */
export function snapZoneFor(e: ShortcutEvent): SnapZone | null {
  for (const row of SNAP_KEYS) {
    if (shortcutMatches(e, row.shortcut)) return row.zone;
  }
  return null;
}

/**
 * The sentence logged when a snapping chord does nothing — kept apart per reason, because
 * "there was no window to snap" and "the host said no" are different facts (the second is a
 * defect report: the desktop class is the only one that allows free window geometry, and the
 * host refuses `main`, a split pane and an external surface by name).
 *
 * Developer diagnostics, in the same English register as `desktopSystemKeys`' chord
 * messages: they carry the host's own reason code, and the *label* comes from the row so it
 * cannot drift from the chord the user pressed.
 */
export function snapRefusal(zone: SnapZone, reason: "no-window" | "host-refused"): string {
  const chord = snapShortcutLabel(zone);
  if (reason === "no-window") {
    return `${chord} did nothing: the host named no focused app window to snap (the launcher itself is never a target — F-SH-008)`;
  }
  return `the host refused to snap the focused window with ${chord}: no bridge, the class does not allow free window geometry (only the desktop class does), the window is gone, or it is a pane of the active split (see the diagnostic log)`;
}
