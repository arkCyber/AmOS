/**
 * Persisted countdown-timer store + OS-level "time's up" poll — React-free.
 *
 * The Clock app's countdown used to live only in its component (`TimerState`),
 * so a timer only ever "finished" while the Clock screen was open. Here we keep
 * the running deadline in the shared store (`amos.timer`) and let an OS-level
 * notifier (`lib/timerNotify.ts`, mounted in the shell) poll it — so a countdown
 * reaches zero and fires a notification even when the Clock app is closed (as
 * long as the System UI is alive).
 *
 * Semantics mirror the alarm bridge: while `running`, the store carries the
 * wall-clock `endAtMs`; `pollTimer(now)` turns a reached deadline into `fired`
 * exactly once (the caller surfaces it).
 */
import { readStoreValue, writeStoreValue } from "./amosStore";

export const TIMER_KEY = "amos.timer";

/** Shape persisted under `amos.timer`. */
export interface PersistTimer {
  running: boolean;
  totalMs: number;
  remainingMs: number;
  /** Wall-clock deadline while running (0 otherwise). */
  endAtMs: number;
  /** Set once a reached deadline has been surfaced (so it fires once). */
  fired: boolean;
}

export function persistTimerInit(): PersistTimer {
  return { running: false, totalMs: 0, remainingMs: 0, endAtMs: 0, fired: false };
}

/** Corruption guard for the persisted timer. */
export function normalizeTimer(v: unknown): PersistTimer {
  const d = persistTimerInit();
  if (!v || typeof v !== "object") return d;
  const o = v as Record<string, unknown>;
  const num = (x: unknown): number =>
    typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : 0;
  return {
    running: o.running === true,
    totalMs: num(o.totalMs),
    remainingMs: num(o.remainingMs),
    endAtMs: num(o.endAtMs),
    fired: o.fired === true,
  };
}

export function readTimer(): PersistTimer {
  return normalizeTimer(readStoreValue<unknown>(TIMER_KEY, undefined));
}

export function writeTimer(p: PersistTimer): void {
  writeStoreValue(TIMER_KEY, p);
}

/** Persist the current in-memory timer state (re-arms `fired` for a new start). */
export function persistFromTimer(t: {
  running: boolean;
  totalMs: number;
  remainingMs: number;
  endAtMs: number;
}): void {
  writeTimer({
    running: t.running,
    totalMs: t.totalMs,
    remainingMs: t.running ? 0 : t.remainingMs,
    endAtMs: t.running ? t.endAtMs : 0,
    fired: false,
  });
}

/**
 * Restore the countdown on Clock-app mount from the store. Returns a live timer
 * (running into the future) if one is persisted, else a fresh idle timer. A
 * deadline that has already passed is NOT resumed (the OS notifier surfaced it).
 */
export function restoreTimerState(nowMs: number): {
  running: boolean;
  totalMs: number;
  remainingMs: number;
  endAtMs: number;
} {
  const p = readTimer();
  if (p.running) {
    // Running into the future → resume live countdown.
    if (p.endAtMs > nowMs) {
      return {
        running: true,
        totalMs: p.totalMs > 0 ? p.totalMs : p.endAtMs - nowMs,
        remainingMs: p.endAtMs - nowMs,
        endAtMs: p.endAtMs,
      };
    }
    // Deadline already passed → the OS notifier surfaced it; don't resurrect.
    return { running: false, totalMs: 0, remainingMs: 0, endAtMs: 0 };
  }
  // Not running, but an armed/paused countdown was persisted → restore it so a
  // set-but-not-started (or paused) timer survives a restart instead of resetting.
  if (p.totalMs > 0 && p.remainingMs > 0) {
    return {
      running: false,
      totalMs: p.totalMs,
      remainingMs: p.remainingMs,
      endAtMs: 0,
    };
  }
  return { running: false, totalMs: 0, remainingMs: 0, endAtMs: 0 };
}

/**
 * OS poll: if a running timer's deadline has been reached and not yet surfaced,
 * mark it fired (stop running) and return true so the caller can notify. Fires
 * exactly once.
 */
export function pollTimer(nowMs: number): boolean {
  const p = readTimer();
  if (!p.running) return false;
  if (p.endAtMs > nowMs) return false;
  if (p.fired) return false;
  writeTimer({ ...p, running: false, remainingMs: 0, endAtMs: 0, fired: true });
  return true;
}
