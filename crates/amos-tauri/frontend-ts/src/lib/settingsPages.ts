/**
 * settingsPages.ts — the settings screen's page vocabulary, and the **cross-window** intent
 * that names one of them (REQ-A790).
 *
 * Why this module exists at all: `SettingsApp.svelte` used to hold the page list as a bare
 * union type (`type Sub = "account" | "wifi" | …`) with `PAGE_KEY` typed off it. A union is
 * enough when the only writer lives in the same file. It is not enough for an intent that
 * arrives **from another window**: the Dock runs in the launcher's `WebviewWindow` and the
 * Settings screen runs in its own, so a value that crossed the gap must be validated against
 * a list that exists at *runtime*, not only at compile time. That list is `SETTINGS_PAGES`,
 * and `SettingsPageId` is **derived from it** rather than spelled a second time — a union and
 * an array of the same literals is exactly what `vocab-mirror-scan` forbids, because the two
 * drift and only one of them is ever read.
 *
 * The sibling precedent is `lib/files.ts` (`FILES_VIEWS` / `normalizeViewIntent`, REQ-A783),
 * which the Dock's trash tile uses to land on Files' trash pane. Same shape, same reasons:
 * a cross-window request carries a nonce so a replay cannot yank the user back, an unknown
 * destination is **ignored** rather than guessed, and the intent is a one-shot command that
 * the reader clears after serving it.
 */

/**
 * Every page the settings screen can be asked to show, in the order the index lists them.
 * `index` is deliberately **not** here: it is the absence of a page, not a destination a
 * caller should aim at, and `normalizePageIntent` treats it as unknown.
 */
export const SETTINGS_PAGES = [
  "account",
  "wifi",
  "bluetooth",
  "cellular",
  "hotspot",
  "notifications",
  "push_management",
  "sound",
  "ringtone",
  "recordings",
  "focus",
  "display",
  "wallpaper",
  "dock",
  "hotcorners",
  "language",
  "ime",
  "keyboard",
  "lock",
  "ai",
  "privacy",
  "spy",
  "guard",
  "about",
  "diagnostics",
  "window",
  "link",
  "enterprise",
] as const;

/** One of the pages above. `SettingsApp.svelte`'s `Sub` is an alias for this. */
export type SettingsPageId = (typeof SETTINGS_PAGES)[number];

/** The shared-store key the intent travels on. */
export const SETTINGS_PAGE_KEY = "amos.settings.page";

export interface SettingsPageIntent {
  page: SettingsPageId;
  nonce: number;
}

/**
 * Read a value that came off the shared store and decide whether it is a request, and for what.
 *
 * `null` means "not a request" — for every one of: not an object, no usable page name, or a page
 * name **this build does not have**. The last one is the important case: a store can hold a value
 * written by a newer build (or by a hand-edited localStorage), and the honest answer to "show me a
 * page I do not know" is to stay where we are, not to land on some other page and let the user
 * believe it was the one they asked for.
 *
 * A missing nonce reads as `0` rather than as a refusal: the nonce exists to stop a *replay*, and
 * a caller that could not supply one has not replayed anything. (Same rule as `normalizeViewIntent`;
 * a clock is not a trust source, so freshness is never inferred from the number's size.)
 */
export function normalizePageIntent(raw: unknown): SettingsPageIntent | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.page !== "string") return null;
  // Widened for the lookup: `SETTINGS_PAGES` is a tuple of literals, so `includes` would
  // otherwise only accept a literal — and this string came off a store, i.e. from anywhere.
  if (!(SETTINGS_PAGES as readonly string[]).includes(o.page)) return null;
  const nonce = typeof o.nonce === "number" && Number.isFinite(o.nonce) ? o.nonce : 0;
  return { page: o.page as SettingsPageId, nonce };
}
