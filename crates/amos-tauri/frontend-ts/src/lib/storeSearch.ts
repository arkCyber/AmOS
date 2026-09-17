/**
 * storeSearch.ts — the App Store's **search** decision, in one testable place.
 *
 * The daemon owns catalog search (`appstore_search`: id / name / summary / author /
 * category, case-insensitive) and `lib/backend.ts` has always wrapped it — but no screen
 * called it (`scripts/unwired-baseline.json` recorded `storeSearch`), so the store could
 * only be *scrolled*. That is worse than it sounds: an unsearchable catalog hides apps
 * that are present, and "I could not find it" is indistinguishable from "it is not
 * published".
 *
 * This module holds the one decision the screen must not get wrong: whether a keystroke
 * state means *search* or *browse*. Everything else (the round-trip, the refusal, the
 * empty-result wording) stays in the screen, where it can be tested through the real
 * component.
 */

/**
 * The query the host should actually search for, or `null` when this is a **browse**.
 *
 * `null` for anything that trims to nothing. An empty box means "show me the catalog":
 * searching for `""` would be a round-trip whose reply is *not* browse state (the daemon's
 * own semantics), and a whitespace-only box must not become a search for a space. One
 * rule, one place.
 *
 * The **host owns the length ceiling** (`MAX_APPSTORE_QUERY_BYTES`, 256 B): this helper
 * deliberately does **not** mirror it. A too-long query is refused by the daemon and the
 * screen shows that refusal — silently truncating what the user typed would be a lie
 * about what was searched.
 */
export function searchQueryOf(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const q = input.trim();
  return q === "" ? null : q;
}
