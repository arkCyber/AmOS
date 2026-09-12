/**
 * Display-protection (auto screen-off) shell helpers + typed bridge to the
 * Tauri `screen_state_set` / `screen_state_get` commands.
 *
 * The screen-state authority lives in the System UI (the host that owns the
 * display): when the shell has been idle for `autoOffSec` it calls
 * `setScreenState(false)` to (a) tell the daemon `screen_on = off` (so the
 * energy beat defers background work / freezes apps — see docs/display-idle.md)
 * and (b) surface the existing lock screen. On wake/unlock it calls
 * `setScreenState(true)`.
 *
 * Wire shape: crates/amos-tauri/src/display.rs. Offline (no Tauri) every call
 * degrades to `null` so the shell keeps working with no bridge.
 */

import { invoke } from "./backend";

/** Canonical screen state, matching the shared file contract ("on" | "off"). */
export type ScreenState = "on" | "off";

/**
 * Durable-store key for the auto screen-off idle timeout in *seconds*. Absent or
 * 0 disables the feature (desktop default). Setting it (e.g. `10`) arms the
 * shell's idle watcher.
 */
export const AUTOOFF_STORE_KEY = "amos.displayAutoOffSec";

/** Durable-store key: return to the home/dock page when the display wakes. */
export const WAKE_HOME_KEY = "amos.wakeHome";

/**
 * Whether waking/unlocking should drop you back on the home/dock page. Absent or
 * unparseable defaults to `true` (the requested behavior); explicit false disables it.
 */
export function wakeHomeEnabled(raw: unknown): boolean {
  if (raw === true || raw === 1 || raw === "1" || raw === "true") return true;
  if (raw === false || raw === 0 || raw === "0" || raw === "false") return false;
  return true;
}

/**
 * Minimum time (ms) the app must have been backgrounded / lost focus before a
 * resume is treated as a real "wake" (physical power key / screen on) that returns
 * to the dock. Shorter absences (a permission dialog, a notification-shade peek,
 * a transient focus steal) are ignored so the user isn't yanked back to home.
 */
export const WAKE_HOME_MIN_MS = 1000;

/**
 * Pure "is this a real wake that should return to the dock?" decision. A resume
 * counts only if the app was genuinely away for at least `minMs` (default
 * [WAKE_HOME_MIN_MS]); a null/no-away or too-brief absence is not a wake.
 */
export function wakeHomeDue(
  leaveAtMs: number | null | undefined,
  nowMs: number,
  minMs: number = WAKE_HOME_MIN_MS,
): boolean {
  if (leaveAtMs == null) return false;
  return nowMs - leaveAtMs >= minMs;
}

/**
 * Pure gate for the "return to home on wake" watcher: `onLeave` records when the
 * shell went away (backgrounded / lost focus), `onReturn` decides — reading the
 * live preference and using [`wakeHomeDue`] — whether that resume is a real wake
 * worth sending the user home, then clears the marker. A too-brief / unknown
 * absence is a no-op (never yanks someone back to the dock), and calling
 * `onReturn` twice without an intervening `onLeave` fires at most once.
 *
 * Kept headless-testable; the DOM plumbing lives in `svelte/osWakeHome.ts`.
 */
export function makeWakeHomeGate(opts: {
  enabled: () => boolean;
  now: () => number;
  wakeHome: () => void;
  minMs?: number;
}): { onLeave: () => void; onReturn: () => void } {
  let leftAt: number | null = null;
  return {
    onLeave() {
      leftAt = opts.now();
    },
    onReturn() {
      const due = opts.enabled() && wakeHomeDue(leftAt, opts.now(), opts.minMs);
      leftAt = null;
      if (due) opts.wakeHome();
    },
  };
}



/** Serializable snapshot returned by the Rust commands. */
export interface ScreenPayload {
  on: boolean;
}

/**
 * Clamp a raw idle-timeout setting (seconds) to a safe integer. Values <= 0 or
 * non-finite disable auto-off entirely (0 = off). Large values are capped at 6h.
 */
export function clampAutoOffSec(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.max(0, Math.floor(n)), 6 * 60 * 60);
}

/** Seconds elapsed since `lastSec`, never negative, clock-skew-safe. */
export function idleElapsedSec(lastSec: number, nowSec: number): number {
  return Math.max(0, nowSec - lastSec);
}

/** Pure auto-off rule: due when the timeout is enabled and idle has reached it. */
export function autoOffDue(lastSec: number, nowSec: number, timeoutSec: number): boolean {
  if (timeoutSec <= 0) return false;
  return idleElapsedSec(lastSec, nowSec) >= timeoutSec;
}

/** Tell the OS the screen is on/off; `null` when not bridged. */
export async function setScreenState(on: boolean): Promise<boolean | null> {
  const p = await invoke<ScreenPayload>("screen_state_set", { on });
  return p === null ? null : p.on;
}

/** Read the current OS screen state (true when on); `null` when not bridged. */
export async function getScreenState(): Promise<boolean | null> {
  const p = await invoke<ScreenPayload>("screen_state_get");
  return p === null ? null : p.on;
}
