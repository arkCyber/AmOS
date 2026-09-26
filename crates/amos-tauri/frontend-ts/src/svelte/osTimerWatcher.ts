/**
 * React-free, shell-level countdown-timer watcher for the pure-Svelte host.
 *
 * When Shell.svelte becomes the production host it must surface a running
 * countdown's "time's up" by itself (no React hook). This module is the runes/Svelte
 * side of that: it polls `lib/timerStore.pollTimer` and pushes one OS notification
 * when a deadline is reached — suppressed while the Clock app itself is focused
 * (its in-app timer already shows it). Fully React-free so it can live on the
 * Svelte import graph.
 */
import { readStoreValue, writeStoreValueChecked, STORE_CHANGED_EVENT } from "../lib/amosStore";
import { NOTIF_KEY, NOTIF_CAP, normalizeNotifs, removeNotif, type Notif } from "../lib/settings";
import { pollTimer, timerDue, TIMER_KEY } from "../lib/timerStore";
import { bgT } from "./bgText";

/** Internal Clock app id (suppressed there). */
export const CLOCK_APP_ID = "clock";
/** Poll cadence. */
export const TIMER_WATCH_MS = 1_000;

/**
 * Push this timer's "time's up" row. Returns the store's verdict.
 *
 * Idempotent by id: the retry below (and a second timer later in the session) writes the
 * same `timer:done` row rather than stacking duplicates — `normalizeNotifs` collapses them
 * on read, but the **stored** array would carry two, and a raw reader would draw both.
 *
 * Normalize the existing list (REQ-A1404): a corrupt value must not wedge the alert
 * pipeline. `readJson` quarantines only *unparseable* bytes — a stored `null`, `{}` or `5`
 * parses fine and comes back as-is — and `removeNotif` is a `filter`, so a raw read threw
 * here before the alert was ever written. Both call sites below swallow that throw in a bare
 * `catch {}`, so the failure was silent **every second, forever**: the countdown reached
 * zero, `pollTimer` was never reached (`running` stayed true, `fired` stayed false) and the
 * notification never landed. The three sibling producers of the same key (`alarmCore`,
 * `calendarCore`, `reminderCore`) all normalize this read; two of them state the rule
 * verbatim in a comment.
 */
function pushTimerDoneNotif(nowMs: number): boolean {
  const existing = normalizeNotifs(readStoreValue<unknown>(NOTIF_KEY, []));
  const n: Notif = {
    id: "timer:done",
    app: bgT("app.clock"),
    icon: "⏱️",
    title: bgT("clock.timerDone"),
    time: nowMs,
  };
  return writeStoreValueChecked(NOTIF_KEY, [n, ...removeNotif(existing, n.id)].slice(0, NOTIF_CAP));
}

/**
 * One poll decision: fire (and notify) only when due and Clock app not focused.
 *
 * The alert goes **first** and the one-shot is consumed only once it has a home
 * (REQ-A1394 ∕ FMEA F-SH-653). `pollTimer` writes `fired: true, running: false`, and that
 * is the only thing that stops later ticks from re-notifying — so consuming before the
 * alert landed meant a store that refused the (larger) notifications write while accepting
 * the (small) timer write, which quota pressure makes routine, dropped the alert forever
 * and said nothing. A refused alert leaves the timer due, and the next tick retries: there
 * is no surface to speak on from a `setInterval`, so the honest fix is "don't consume until
 * it lands", not "say so" (the Clock app still owns the on-screen state either way).
 *
 * The consume's verdict is returned rather than dropped (REQ-A1431): the mirror-image store
 * state — the alert landing while `amos.timer` is refused — used to read as `true` here, so
 * "the deadline was consumed" was asserted off the attempt and not off the store. It is the
 * *store* that decides whether a later tick announces this deadline again, and the timer
 * write can be the refused one for the same reason the notification write can (`writeJson`
 * refuses per `setItem`, and availability can change between the two).
 */
export function timerWatcherTick(
  activeAppId: string | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (activeAppId === CLOCK_APP_ID) return false;
  if (!timerDue(nowMs)) return false;
  if (!pushTimerDoneNotif(nowMs)) return false;
  return pollTimer(nowMs);
}

/** Start a background watcher. Returns a stop function (call on unmount). */
export function startTimerWatcher(getActive: () => string | null): () => void {
  const interval = window.setInterval(() => {
    try {
      timerWatcherTick(getActive());
    } catch {
      /* storage unavailable — best-effort */
    }
  }, TIMER_WATCH_MS);
  const onStore = (e: Event) => {
    const key = (e as CustomEvent<{ key?: string }>).detail?.key;
    if (key !== TIMER_KEY) return;
    try {
      timerWatcherTick(getActive());
    } catch {
      /* ignore */
    }
  };
  window.addEventListener(STORE_CHANGED_EVENT, onStore);
  return () => {
    window.clearInterval(interval);
    window.removeEventListener(STORE_CHANGED_EVENT, onStore);
  };
}
