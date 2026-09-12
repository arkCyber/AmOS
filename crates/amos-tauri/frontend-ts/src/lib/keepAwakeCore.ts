/**
 * lib/keepAwakeCore.ts — **React-free** keep-awake reason bus.
 *
 * Mirrors the Rust `amos_display::ScreenController` reason-keyed holds
 * (`set_hold("reason")` / `clear_hold("reason")` / `held()`): a screen reason is
 * *why* the display must not auto-sleep (active call, turn-by-turn nav, a
 * foreground video). Module-singleton so any Svelte/React consumer can assert /
 * revoke its own reason without prop-drilling, and the auto screen-off watcher
 * reads the aggregate.
 *
 * This is the non-React core; the legacy React file `keepAwake.ts` re-exports it
 * (and adds React hooks) so the two can never drift. A future Svelte display
 * keep-awake consumer imports this directly.
 */

export type HoldListener = () => void;

const reasons = new Set<string>();
const listeners = new Set<HoldListener>();

function notify(): void {
  for (const l of listeners) l();
}

/** True only when at least one reason is active (conservative). */
export function screenHeld(): boolean {
  return reasons.size > 0;
}

/**
 * Whether an active media playback should keep the screen on.
 *
 * **Video yes, music no**: a foreground video must not blank mid-scene, while a
 * playing audio track is deliberately *not* a hold — a music player letting the
 * display sleep is the expected behaviour (see docs/display-idle.md §6).
 */
export function videoHoldActive(
  playing: boolean,
  kind: string | null | undefined,
): boolean {
  return playing === true && kind === "video";
}

/** Active hold reasons, ascending (diagnostics / logging). */
export function heldReasons(): string[] {
  return [...reasons].sort();
}

/** Assert a reason the display must stay on (idempotent; notifies on change). */
export function assertHold(reason: string): void {
  if (reasons.has(reason)) return;
  reasons.add(reason);
  notify();
}

/** Revoke a reason. No-op if it wasn't active. */
export function releaseHold(reason: string): void {
  if (!reasons.delete(reason)) return;
  notify();
}

/** Test/teardown: drop every reason. Not used by production code. */
export function clearAllHolds(): void {
  if (reasons.size === 0) return;
  reasons.clear();
  notify();
}

/** Subscribe to any hold change; returns an unsubscribe. (React uses this; a
 *  Svelte `$effect` or store can too.) */
export function onHoldChange(cb: HoldListener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Test hook: drop every reason AND every listener (module state reset). */
export function resetHoldBusForTest(): void {
  listeners.clear();
  clearAllHolds();
}
