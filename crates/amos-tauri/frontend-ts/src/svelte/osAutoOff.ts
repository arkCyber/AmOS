/**
 * Auto screen-off watcher for the Svelte shell.
 *
 * The decision math lives in `lib/display` (`autoOffDue`/`clampAutoOffSec`). This
 * module is the host loop Shell.svelte starts: it reads the persisted auto-off
 * timeout, tracks the last activity time, and calls `onSleep` once the device
 * has been idle long enough. It also honours the keep-awake reason bus
 * (`lib/keepAwakeCore`): while any reason is held (active call, playing video, …)
 * the display must not auto-sleep, and the idle window restarts so attention ends
 * a full timeout later rather than instantly after release.
 *
 * The timeout is **re-read whenever the setting changes** (REQ-A967): the shell
 * starts this watcher once, so a value captured at start would leave Settings →
 * 「自动息屏」 with no visible effect until the app restarted. Every sibling
 * watcher that honours a persisted preference already applies a change in place
 * (`osWakeHome` reads it live; `osTimer` / `osAlarm` / `osReminder` /
 * `osCalendar` re-read on the same store-change event) — this one was the
 * exception.
 *
 * **The loop also outlives the sleep it causes** (REQ-A1401). `onSleep` here is
 * `lock()` — a surface change *inside the same mounted Shell* — not the process
 * going away, so the watcher has to be able to sleep again after the user
 * unlocks. It used to `clearInterval` + drop its activity listeners on the first
 * sleep and nothing ever restarted it (the Shell starts it once, in `onMount`),
 * so 「自动息屏」 fired **exactly once per app launch** — and a *manual* lock
 * (NC 🔒) tripped the same trap one idle period later. `isLocked` is how the loop
 * learns the state it produced: while the display is off it only re-stamps the
 * idle clock (so the unlock gets a fresh, full window), and the delivered sleep
 * is latched per idle period rather than for the watcher's lifetime.
 */
import { AUTOOFF_STORE_KEY, autoOffDue, clampAutoOffSec } from "../lib/display";
import { readStoreValue, STORE_CHANGED_EVENT } from "../lib/amosStore";
import { onHoldChange, screenHeld } from "../lib/keepAwakeCore";

/** Poll cadence. */
export const AUTO_OFF_POLL_MS = 1_000;

/**
 * Fresh-install default auto-off timeout (seconds). **0 = off (never auto-lock).**
 *
 * This must agree with the shell (`Shell.svelte` / Settings read `AUTOOFF_STORE_KEY`
 * with fallback `0`) and with Settings → General → Auto screen-off (whose Segmented
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

/**
 * Pure decision folding the keep-awake holds: while any reason is held the
 * display must not auto-sleep, so the timeout never fires regardless of idle
 * time. `held=false` falls back to the plain idle decision.
 */
export function osAutoOffDecisionHeld(
  lastSec: number,
  nowSec: number,
  timeoutSec: number,
  held: boolean,
): boolean {
  if (held) return false;
  return osAutoOffDecision(lastSec, nowSec, timeoutSec);
}

/**
 * Start tracking activity and sleep once idle >= timeout. Returns a stop fn.
 *
 * `isLocked` is read at **tick** time (like `startShortcutTriggers`' predicate):
 * the state the sleep produces, so the loop can tell "the user is still here" from
 * "the display is already off". Omitted, the display is assumed always awake.
 */
export function startOsAutoOff(opts: {
  onSleep: () => void;
  isLocked?: () => boolean;
}): () => void {
  let timeout = osAutoOffTimeout(readStoreValue<unknown>(AUTOOFF_STORE_KEY, AUTO_OFF_DEFAULT_SEC));
  const nowSec = () => Math.floor(Date.now() / 1000);
  const locked = () => (opts.isLocked ? opts.isLocked() : false);
  let last = nowSec();
  /** The sleep for the *current* idle period has been delivered. Reset by activity
   *  (a new idle period) and while the display is off — never by the clock alone,
   *  or one sleep would re-fire every tick for as long as the user stays idle. */
  let slept = false;
  const touch = () => {
    last = nowSec();
    slept = false;
  };
  const activityEvents = ["pointerdown", "pointermove", "keydown", "touchstart"] as const;
  activityEvents.forEach((e) => window.addEventListener(e, touch));
  // A hold asserted/released mid-idle is activity-equivalent: restart the window
  // so attention ends a full timeout later (never an instant sleep on release).
  const offHold = onHoldChange(touch);
  // Re-read the persisted timeout in place when the user changes it (REQ-A967):
  // this watcher lives for the whole shell, so a mount-time capture would make
  // Settings →「自动息屏」 a control with no effect until an app restart.
  const onStore = (e: Event) => {
    const key = (e as CustomEvent<{ key?: string }>).detail?.key;
    if (key !== AUTOOFF_STORE_KEY) return;
    timeout = osAutoOffTimeout(readStoreValue<unknown>(AUTOOFF_STORE_KEY, AUTO_OFF_DEFAULT_SEC));
  };
  window.addEventListener(STORE_CHANGED_EVENT, onStore);
  const interval = window.setInterval(() => {
    const now = nowSec();
    // The display is already off (this watcher's own `onSleep`, or a lock the user
    // made in the NC). Nothing to sleep, and the idle clock must keep up with the
    // present: unlocking gets a *full* timeout window, never an instant re-sleep.
    if (locked()) {
      last = now;
      slept = false;
      return;
    }
    const held = screenHeld();
    // A hold asserted mid-idle is activity-equivalent: restart the window so
    // attention ends a full timeout later (never an instant sleep on release).
    if (held) last = now;
    if (slept) return;
    if (osAutoOffDecisionHeld(last, now, timeout, held)) {
      slept = true;
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
    window.removeEventListener(STORE_CHANGED_EVENT, onStore);
    offHold();
  };
}
