/**
 * backNav.ts — what a **system back** press means inside the shell (REQ-A321).
 *
 * The phone form factor runs in an Android WebView whose host implements the platform
 * back gesture as `if (webView.canGoBack()) goBack() else super.onBackPressed()` (Tauri's
 * generated `WryActivity`). Nothing in this app ever pushed a history entry, so
 * `canGoBack()` was **always false**: pressing back inside an app — or inside a settings
 * sub-page, or with an overlay open — left AmOS entirely instead of going up one level,
 * even though the shell already had that idea internally (`Shell.svelte`'s `"back"`
 * channel action called `goHome()`).
 *
 * This module is the pure half: given the shell's own position, decide
 *
 *   * what a **back** press should do inside the shell ([`backActionAt`]), and
 *   * whether a transition goes **deeper** — i.e. needs a history entry so the platform
 *     has somewhere to go back to ([`pushDecision`]).
 *
 * The shell's depth is its **level**: home/lock is 0, the App Library / edit mode / an
 * overlay is 1, an app (or an overlay above an app) is 2. One entry per level means the
 * platform's own `canGoBack()` matches what the user sees, and "back" always undoes
 * exactly one level.
 */

/** Which surface the shell is showing (mirrors `shellState.Surface["kind"]`). */
export type BackSurface = "home" | "app" | "library" | "lock" | "edit";

/** The system overlays that sit above the surface (independent flags in `shellState`). */
export interface BackOverlays {
  nc: boolean;
  recents: boolean;
  spot: boolean;
}

/** Where the shell is, in the terms a back press cares about. */
export interface BackPosition {
  surface: BackSurface;
  overlays: BackOverlays;
}

/** What a back press should do, or `none` = "nothing left inside the shell". */
export type BackAction = "close-overlay" | "home" | "none";

/** Depth of a position: one history entry per level. */
export function levelOf(p: BackPosition): number {
  const base = p.surface === "app" || p.surface === "library" || p.surface === "edit" ? 1 : 0;
  return base + (topOverlay(p.overlays) === null ? 0 : 1);
}

/**
 * The overlay a back press closes first, or `null`.
 *
 * The three flags are **mutually exclusive by construction** — `setNc` / `setRecents` /
 * `setSpot` each clear the other two (`shellState.svelte.ts`), so this order is a
 * tie-breaker for a state that should not exist. It follows the shell's paint order
 * instead of a guess: all three panels are `z-40` full-screen sheets, so the one painted
 * **last** wins (`Shell.svelte` renders RecentsPanel → SpotlightPanel → NotificationCenter),
 * i.e. the notification center is on top. If that exclusivity ever broke, "back" would
 * close the sheet the user can actually see.
 */
export function topOverlay(o: BackOverlays): "nc" | "spot" | "recents" | null {
  if (o.nc) return "nc";
  if (o.spot) return "spot";
  if (o.recents) return "recents";
  return null;
}

/**
 * What back does here: close the top overlay if one is open, otherwise return to the home
 * surface, otherwise **nothing** — the last case is deliberate: at home (or locked) there
 * is nothing left to undo inside the shell, so the press falls through to the platform,
 * which exits the app. That is the platform's own "back at the root" behaviour and the
 * shell must not swallow it.
 */
export function backActionAt(p: BackPosition): BackAction {
  if (topOverlay(p.overlays) !== null) return "close-overlay";
  if (p.surface === "app" || p.surface === "library" || p.surface === "edit") return "home";
  return "none";
}

/**
 * Does moving `from` → `to` need a **new** history entry? Only when it goes deeper: a
 * shallower move is the platform popping (or the shell rewinding) an entry it already
 * has, and a sideways move at the same level needs none.
 */
export function pushDecision(from: BackPosition, to: BackPosition): "push" | "none" {
  return levelOf(to) > levelOf(from) ? "push" : "none";
}

/** How many entries must be popped to get from `from` down to `to` (never negative). */
export function rewindCount(from: BackPosition, to: BackPosition): number {
  return Math.max(0, levelOf(from) - levelOf(to));
}
