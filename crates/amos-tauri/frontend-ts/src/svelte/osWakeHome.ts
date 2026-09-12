/**
 * React-free, shell-level "return to home on wake" watcher.
 *
 * Ports the React host's `wakeHome` resume behaviour into the pure-Svelte shell
 * (see `react-removal-plan.md` system-layer list). When enabled
 * (`amos.wakeHome`, default **on**), coming back to the app after a *real*
 * absence (screen off / backgrounded / focus regained for at least
 * `WAKE_HOME_MIN_MS`) returns the user to the home/dock page — a brief
 * notification-shade peek or permission dialog does not.
 *
 * "Away"/"back" are observed through `visibilitychange` plus window
 * `blur`/`focus`. The decision itself is the pure `makeWakeHomeGate`
 * (`lib/display`), so it is headless-testable; this file is only the DOM wiring.
 * Started by `Shell.svelte`; returns a stop fn.
 */
import { readStoreValue } from "../lib/amosStore";
import { WAKE_HOME_KEY, makeWakeHomeGate, wakeHomeEnabled } from "../lib/display";

/** Start watching for wakes that should return home. Returns a stop fn. */
export function startOsWakeHome(opts: { onHome: () => void }): () => void {
  const gate = makeWakeHomeGate({
    // Read the preference live so toggling it in Settings applies immediately.
    enabled: () => wakeHomeEnabled(readStoreValue<unknown>(WAKE_HOME_KEY, true)),
    now: () => Date.now(),
    wakeHome: opts.onHome,
  });
  const onVisibility = () => {
    if (document.visibilityState === "hidden") gate.onLeave();
    else gate.onReturn();
  };
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("blur", gate.onLeave);
  window.addEventListener("focus", gate.onReturn);
  return () => {
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("blur", gate.onLeave);
    window.removeEventListener("focus", gate.onReturn);
  };
}
