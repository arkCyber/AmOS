/**
 * Auto screen-off watcher for the Svelte shell.
 *
 * The decision math lives in `lib/display` (`autoOffDue`/`clampAutoOffSec`). This
 * module is the host loop Shell.svelte starts: it reads the persisted auto-off
 * timeout, tracks the last activity time, and calls `onSleep` once the device
 * has been idle long enough (then stops).
 */
import { AUTOOFF_STORE_KEY, autoOffDue, clampAutoOffSec } from "../lib/display";
import { readStoreValue } from "../lib/amosStore";

/** Poll cadence. */
export const AUTO_OFF_POLL_MS = 1_000;

/**
 * Fresh-install default auto-off timeout (seconds). **0 = off (never auto-lock).**
 *
 * This must agree with the React host (`App.tsx` reads `AUTOOFF_STORE_KEY` with
 * fallback `0`) and with Settings → General → Auto screen-off (whose Segmented
 * labels "关闭" with value `0`). It used to be `30` here only, so a brand-new or
 * data-cleared device self-locked to the AmOS lock screen after 30 s idle even
 * though the Settings UI said "关闭" — the "UI won't stay / 不常驻" symptom. With
 * the default now `0` an install with no stored timeout shows the home UI
 * forever; the idle watcher only arms when the user picks 15/30/60 in Settings.
 */
export const AUTO_OFF_DEFAULT_SEC = 0;

/** Read + clamp the persisted auto-off timeout (seconds). */
export function osAutoOffTimeout(raw: unknown): number {
  return clampAutoOffSec(raw);
}

/** Pure decision: true when idle >= timeout (seconds). Wraps display.autoOffDue. */
export function osAutoOffDecision(lastSec: number, nowSec: number, timeoutSec: number): boolean {
  return autoOffDue(lastSec, nowSec, timeoutSec);
}

/** Start tracking activity and sleep once idle >= timeout. Returns a stop fn. */
export function startOsAutoOff(opts: { onSleep: () => void }): () => void {
  const timeout = osAutoOffTimeout(readStoreValue<unknown>(AUTOOFF_STORE_KEY, AUTO_OFF_DEFAULT_SEC));
  const nowSec = () => Math.floor(Date.now() / 1000);
  let last = nowSec();
  let sleeping = false;
  const touch = () => {
    last = nowSec();
  };
  const activityEvents = ["pointerdown", "pointermove", "keydown", "touchstart"] as const;
  activityEvents.forEach((e) => window.addEventListener(e, touch));
  const interval = window.setInterval(() => {
    if (sleeping) return;
    if (osAutoOffDecision(last, nowSec(), timeout)) {
      sleeping = true;
      window.clearInterval(interval);
      activityEvents.forEach((e) => window.removeEventListener(e, touch));
      try {
        opts.onSleep();
      } catch {
        /* ignore */
      }
    }
  }, AUTO_OFF_POLL_MS);
  return () => {
    window.clearInterval(interval);
    activityEvents.forEach((e) => window.removeEventListener(e, touch));
  };
}
