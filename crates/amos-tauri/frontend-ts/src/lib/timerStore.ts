/**
 * Persisted countdown-timer store + OS-level "time's up" poll — React-free.
 *
 * The Clock app's countdown used to live only in its component (`TimerState`),
 * so a timer only ever "finished" while the Clock screen was open. Here we keep
 * the running deadline in the shared store (`amos.timer`) and let an OS-level
 * notifier (`svelte/osTimerWatcher.ts`, started from the shell) poll it — so a
 * countdown reaches zero and fires a notification even when the Clock app is
 * closed (as long as the System UI is alive).
 *
 * Semantics mirror the alarm bridge: while `running`, the store carries the
 * wall-clock `endAtMs`; `pollTimer(now)` turns a reached deadline into `fired`
 * exactly once (the caller surfaces it).
 *
 * Every writer reports the **store's own verdict** (REQ-A1431). The whole point of this
 * module is the sentence above — that the countdown outlives the screen — and that is true
 * only if the write landed: a refused `setItem` leaves the store on its previous value, so
 * the OS notifier polls an idle timer and the user's countdown silently never rings. The
 * `amos.timer` record is small, but "small" is not "safe": `writeJson` refuses **per
 * `setItem`** (quota is size-dependent), and storage can go unavailable between the alert's
 * write and this one. So the app screen says a refusal out loud, and `pollTimer` answers
 * with the verdict that decides whether the one-shot was really consumed.
 */
import { readStoreValue, writeStoreValueChecked } from "./amosStore";
import { timerInit } from "./time";

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

/** Write the timer record, returning the **store's** verdict (`false` ⇒ it did not land). */
export function writeTimer(p: PersistTimer): boolean {
  return writeStoreValueChecked(TIMER_KEY, p);
}

/** Field-wise equality on the normalized shape (the two sides are always built by
 *  `normalizeTimer` / `persistFromTimer`, so the key order matches too — but comparing
 *  fields rather than serialized bytes does not depend on that). */
function sameTimer(a: PersistTimer, b: PersistTimer): boolean {
  return (
    a.running === b.running &&
    a.totalMs === b.totalMs &&
    a.remainingMs === b.remainingMs &&
    a.endAtMs === b.endAtMs &&
    a.fired === b.fired
  );
}

/**
 * Persist the current in-memory timer state (re-arms `fired` for a new start).
 *
 * Returns the store's verdict, except that a write which would not change the stored record
 * is a **no-op → `true`**, not a refusal. Two reasons, and the first is the load-bearing
 * one: the screen persists from an `$effect` that also runs on the mount flush, before the
 * user has touched the countdown at all — answering `false` there would print
 * 「本次改动未保存」 on a screen where nothing was changed (the honest-copy rule; the empty
 * rename in `lib/customGroups.ts` is the same shape). Second, while a countdown is merely
 * *running* this record is constant (`remainingMs` is zeroed and `endAtMs` is the deadline),
 * so the guard also stops the 1 Hz effect from rewriting `amos.timer` once per second.
 */
export function persistFromTimer(t: {
  running: boolean;
  totalMs: number;
  remainingMs: number;
  endAtMs: number;
}): boolean {
  const next: PersistTimer = {
    running: t.running,
    totalMs: t.totalMs,
    remainingMs: t.running ? 0 : t.remainingMs,
    endAtMs: t.running ? t.endAtMs : 0,
    fired: false,
  };
  if (sameTimer(readTimer(), next)) return true;
  return writeTimer(next);
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
    return timerInit();
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
  // The idle shape is `lib/time.timerInit()` — the domain's single source for it
  // (the countdown reducer resets to the same value), never a re-typed literal.
  return timerInit();
}

/**
 * Is a running timer's deadline reached and not yet surfaced? **Pure** — reads only.
 *
 * Split out of `pollTimer` (REQ-A1394 ∕ FMEA F-SH-653) so the caller can put the *alert*
 * first and consume the one-shot only once that alert has somewhere to land. `fired` is a
 * promise that this deadline has been surfaced; `pollTimer` writes it, so calling it before
 * the notification exists made that promise false whenever the notification's store write
 * was refused — and because `running` goes false in the same write, no later tick ever
 * retried: the user waited on a timer whose "time's up" was never delivered, and nothing
 * said so. Order is the guard (the same rule REQ-A1263 states for the memo's two stores).
 */
export function timerDue(nowMs: number): boolean {
  const p = readTimer();
  return p.running && p.endAtMs <= nowMs && !p.fired;
}

/**
 * OS poll: if a running timer's deadline has been reached and not yet surfaced,
 * mark it fired (stop running) and return true so the caller can notify. Fires
 * exactly once.
 *
 * Call this **after** the notification has landed — see `timerDue` above.
 *
 * The consume *is* a write, and that write is the only thing that makes "exactly once" true:
 * it is what flips `running` off and `fired` on, so a refused one leaves the deadline just
 * as due as it was. Hence the return is the **store's** verdict, not "we tried" — `true`
 * means this deadline has been consumed and no later tick will announce it again. Callers
 * on a `setInterval` keep retrying either way (there is no surface to speak on from a timer
 * callback); what changes is that the retry is now reported honestly instead of a refused
 * consume reading as a successful one.
 */
export function pollTimer(nowMs: number): boolean {
  const p = readTimer();
  if (!p.running) return false;
  if (p.endAtMs > nowMs) return false;
  if (p.fired) return false;
  return writeTimer({ ...p, running: false, remainingMs: 0, endAtMs: 0, fired: true });
}
