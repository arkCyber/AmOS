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
import { readStoreValue, writeStoreValue, STORE_CHANGED_EVENT } from "../lib/amosStore";
import { NOTIF_KEY, NOTIF_CAP, type Notif } from "../lib/settings";
import { pollTimer, TIMER_KEY } from "../lib/timerStore";
import { zh } from "../i18n/locales/zh";

/** Internal Clock app id (suppressed there). */
export const CLOCK_APP_ID = "clock";
/** Poll cadence. */
export const TIMER_WATCH_MS = 1_000;

function pushTimerDoneNotif(nowMs: number): void {
  const existing = readStoreValue<Notif[]>(NOTIF_KEY, []);
  const n: Notif = {
    id: "timer:done",
    app: zh["app.clock"],
    icon: "⏱️",
    title: zh["clock.timerDone"],
    time: nowMs,
  };
  writeStoreValue(NOTIF_KEY, [n, ...existing].slice(0, NOTIF_CAP));
}

/** One poll decision: fire (and notify) only when due and Clock app not focused. */
export function timerWatcherTick(
  activeAppId: string | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (activeAppId === CLOCK_APP_ID) return false;
  if (!pollTimer(nowMs)) return false;
  pushTimerDoneNotif(nowMs);
  return true;
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
