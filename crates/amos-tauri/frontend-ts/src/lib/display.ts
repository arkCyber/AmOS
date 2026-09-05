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


export function isOn(s: ScreenState): boolean {
  return s === "on";
}

/** Tolerant parse of an arbitrary value (store / payload / event) to a state. */
export function asScreenState(v: unknown): ScreenState {
  return v === "off" ? "off" : "on";
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

/**
 * Auto-off decision for a *live* shell, folding in a screen hold (an active
 * call / media). While `inCall` is true the screen must never auto-sleep —
 * phone-accurate keep-awake (the domain equivalent of `ScreenController`'s
 * "call" hold). Returns false whenever idle has not elapsed, the timeout is
 * disabled, or a call is holding the screen.
 */
export function dueForAutoSleep(
  lastSec: number,
  nowSec: number,
  timeoutSec: number,
  inCall: boolean,
): boolean {
  if (inCall) return false;
  return autoOffDue(lastSec, nowSec, timeoutSec);
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
