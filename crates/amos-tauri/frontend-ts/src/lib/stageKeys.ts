/**
 * stageKeys.ts — the desktop shell's **Stage Manager** chord, as a table (REQ-A1568).
 *
 * Same arc as `lib/snapZones.ts` and `lib/desktopKeys.ts`: a capability that the host could
 * already perform had no front door. `crates/amos-tauri/src/stage.rs` owns the commands and
 * `StageRail.svelte` draws the rail, but the rail only exists **while the mode is on** — so
 * without a way to turn it on, everything built for Stage Manager is unreachable for a user
 * who has never seen it. This module is the chord that reaches it, and the keycap the menu
 * row shows.
 *
 * ## Why ⌃⌘S
 *
 * Every other family in this shell is claimed, and `shortcutMatches` compares modifiers
 * **exactly**, so the choice has to be disjoint from all of them:
 *
 *   * the system domain is plain `⌘…` (`⌘N ⌘W ⌘M ⌘H ⌘\` ⌘,`) — those omit ⌃;
 *   * the Spaces family is `⌃` + arrows/digits — those omit ⌘;
 *   * the overlay registry is `F3 / F4 / ⌘Space / ⌘Tab` — those omit ⌃;
 *   * the snapping family is `⌃⌥` + one key — those omit ⌘;
 *   * `⌘⇧3/4/5` are the platform's screenshots, and the menu's editing keys are `⌘C/V/A`.
 *
 * `⌃⌘` is also the modifier pair macOS itself uses for the "hide/show a system surface"
 * family (`⌃⌘F`, `⌃⌘Space`), so `⌃⌘S` reads as "S for Stage" without inventing a grammar.
 * `src/__tests__/stageKeys.test.ts` pins the disjointness against the other tables rather
 * than trusting this comment.
 *
 * ## Scope boundary
 *
 * Like the snapping chords, this one is **shell-owned**: it is not a user-rebindable
 * keyboard-config domain, so it takes the `SPACES_DEFAULTS` route rather than adding a fifth
 * domain to the settings schema. The table, the keycap and the match all live here, so
 * promoting it to a domain later touches one file.
 */
import { formatShortcut, shortcutMatches, type ShellShortcut, type ShortcutEvent } from "./shellModule";

/**
 * Toggle Stage Manager on or off.
 *
 * The one chord: the mode switch is the only Stage verb that needs a key (parking a window
 * is the rail's own per-tile control, bringing one back is a click on its tile, and "Tidy"
 * is a menu row plus the rail's header button). A second chord for a sub-action would be a
 * key nobody could have guessed.
 */
export const STAGE_TOGGLE_CHORD: ShellShortcut = { key: "s", ctrl: true, meta: true };

/**
 * The keycap the Window menu's Stage Manager row shows (`"⌃⌘S"`).
 *
 * Read off the table rather than typed next to the row, for the reason
 * `snapShortcutLabel` gives: a hint is not translatable and must not outlive the binding it
 * names. A menu that advertises a key nothing matches is the defect `TopbarMainMenu`'s own
 * header records.
 */
export function stageToggleLabel(): string {
  return formatShortcut({ ...STAGE_TOGGLE_CHORD, key: STAGE_TOGGLE_CHORD.key.toUpperCase() });
}

/** Does this keydown ask to toggle Stage Manager? */
export function isStageToggleChord(e: ShortcutEvent): boolean {
  return shortcutMatches(e, STAGE_TOGGLE_CHORD);
}

/**
 * The sentence logged when the chord could not even **ask**, in the register
 * `lib/snapZones.ts::snapRefusal` uses (English developer diagnostics).
 *
 * One fact, and only the one this module owns: the shell could not reach the host (no
 * window, a `null` reply), so nothing was attempted — saying "the host refused" here would
 * name a cause nobody established.
 *
 * **Why the host-refused half is not here.** It used to be, and it drifted: the sentence
 * named `no stage rail`, which `stage_set_enabled` produces only when
 * `LayoutPolicy::stage_rail_width() == 0` — unreachable from this shell, which is the
 * *desktop* one — while it could not name `amos.stage.persist_failed` or
 * `amos.stage.lock_failed`, the refusals a desktop can actually get. The refusal wording
 * has exactly one home (`lib/stage.ts::stageFailure`, whose own doc says so), and the
 * caller routes through it; a second sentence here is how the two came to disagree.
 *
 * The keycap comes from the table, so the message can never name a chord the shell no
 * longer binds.
 */
export function stageToggleRefusal(): string {
  const chord = stageToggleLabel();
  return `${chord} did nothing: the shell could not reach the host (see the diagnostic log)`;
}
