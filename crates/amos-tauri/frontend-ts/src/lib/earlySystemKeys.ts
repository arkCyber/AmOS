/**
 * earlySystemKeys.ts — the system chords that must work **before the shell has mounted**.
 *
 * REQ-A431. Measured on this machine (2026-09-18, six fresh launches per delay): after `⌘,`
 * opened a window, pressing `⌘W` **3 s later closed it in 3/6 runs**, while the same press
 * **12 s later closed it 4/4**. The window is created and shown immediately, but its key
 * handler lives inside the Svelte shell (`DesktopAppWindow` → `modules/DesktopWindowKeys`),
 * which appears only after `shell-entry.ts` has hydrated the store and mounted `Shell` — so
 * there is a window of several seconds in which the chord is delivered and nobody listens
 * (and the native menu does not take it either: the WebView owns these chords while the shell
 * is up — see the corrected note in the CHANGELOG).
 *
 * This module closes that window: the entry script installs a capture-phase listener at boot,
 * and it stands down the moment a component that owns the chords mounts
 * (`handOverSystemKeys`). Two rules keep it honest:
 *   • it acts on **this window's own app** (the `#window=<label>` fragment the host put in the
 *     URL), never on a "focused window" — the early phase has no host poll, and guessing a
 *     neighbour is worse than doing nothing;
 *   • `Preferences` (⌘,) needs no target at all, so it works in every window from frame one.
 *
 * The intent table, the key matching and the dispatch are the **shared** ones
 * (`svelte/desktopSystemKeys.ts`, `lib/keyboardConfigHook`), so a user's rebind or a disabled
 * feature is respected here exactly as it is once the shell takes over.
 */
import { getGlobalBindings, matchesShortcut } from "./keyboardConfigHook.svelte";
import { isDesktopFeatureEnabled } from "./desktopFeatures";
import { amosWarn } from "./debugLog";
import {
  refusedChordMessage,
  runSystemIntent,
  systemIntentFor,
  type DesktopSystemIntent,
} from "../svelte/desktopSystemKeys";

/** The chord the early listener resolved, and the window it acts on. */
export interface EarlyIntent {
  intent: DesktopSystemIntent;
  label: string | null;
}

/**
 * Does a mounted component already handle these chords in this window?
 *
 * A module-level latch, not per-listener state: inside one WebView there is exactly one
 * window, so "the shell is up" is a property of the page, not of a listener instance.
 */
let shellOwns = false;

/** Has the shell taken the chords over? (Read by tests and by the early listener.) */
export function systemKeysOwnedByShell(): boolean {
  return shellOwns;
}

/**
 * Called by the components that own the chords, **at the moment their listener is
 * registered** (`DesktopShell`'s key effect, `DesktopWindowKeys`'s `onMount`).
 */
export function handOverSystemKeys(): void {
  shellOwns = true;
}

/** Reset the latch (tests only — the convention every reset fn here follows). */
export function resetSystemKeysHandoverForTest(): void {
  shellOwns = false;
}

/**
 * What the pre-shell listener may run for `bindingId` in a window whose own app is
 * `ownLabel` — or `null` when it must leave the key alone.
 */
export function earlyIntentFor(bindingId: string, ownLabel: string | null): EarlyIntent | null {
  const intent = systemIntentFor(bindingId);
  if (!intent) return null;
  // Preferences opens the Settings window: no target needed, so any window can do it.
  if (intent === "open-preferences") return { intent, label: null };
  // Close / hide act on this window's own app. Without one (the launcher) there is nothing
  // this phase can honestly act on.
  return ownLabel ? { intent, label: ownLabel } : null;
}

/**
 * Install the boot-time listener. Returns an uninstaller (used by tests; the production call
 * in `shell-entry.ts` keeps it for the page's lifetime — the listener stands down by itself
 * via the latch, so removing it would only add a way for the chords to become unowned again).
 *
 * @param ownLabel the app this window addresses (`appIdFromHash`), or `null` for the launcher.
 */
export function installEarlySystemKeys(ownLabel: string | null): () => void {
  // The **shared** rule book, read once (no reactive state: this listener lives for seconds,
  // and a rebind during them is picked up by the shell's own handler a moment later).
  const systemBindings = getGlobalBindings().system;
  const onKeyDown = (e: KeyboardEvent) => {
    if (systemKeysOwnedByShell()) return;
    // The documented switch (`AMOS_DESKTOP_SHORTCUTS=disabled`) is honoured here exactly as
    // it is in the shell: the operator asked the frontend not to take these keys.
    if (!isDesktopFeatureEnabled("shortcuts")) return;
    for (const [id, shortcut] of systemBindings) {
      const early = earlyIntentFor(id, ownLabel);
      if (!early) continue;
      if (!matchesShortcut(shortcut, e)) continue;
      e.preventDefault();
      e.stopPropagation();
      // Same reporting discipline as the mounted handlers (REQ-A430): a refused command is
      // reported, not swallowed — otherwise "the key did nothing" has no explanation.
      void runSystemIntent(early.intent, early.label).then((outcome) => {
        if (outcome.reason === "host-refused") {
          amosWarn("shell", refusedChordMessage(early.intent, early.label), {
            reason: outcome.reason,
            phase: "early",
          });
        }
      });
      return;
    }
  };
  window.addEventListener("keydown", onKeyDown, { capture: true });
  return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
}
