/**
 * React-free, shell-level alarm watcher for the pure-Svelte host.
 *
 * When Shell.svelte is the production host it must run the OS "due alarm"
 * reconcile itself. All real logic lives in React-free `lib/alarmCore.ts`; this
 * module is the React-free timer/scheduler that calls `syncDueAlarmAlerts` unless
 * the Clock app is the focused surface (its own in-app ring is on screen).
 */
import {
  ALARM_ALERT_INTERVAL_MS,
  ALARM_FIRED_KEY,
  ALARM_KEY,
  CLOCK_APP_ID,
  syncDueAlarmAlerts,
} from "../lib/alarmCore";
import { STORE_CHANGED_EVENT } from "../lib/amosStore";

/** One reconcile decision: runs the alarm sync unless the Clock app is focused. */
export function alarmWatcherTick(
  activeAppId: string | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (activeAppId === CLOCK_APP_ID) return false;
  try {
    syncDueAlarmAlerts(nowMs);
    return true;
  } catch {
    return false;
  }
}

/** Start a background alarm watcher. Returns a stop function (call on unmount). */
export function startAlarmWatcher(getActive: () => string | null): () => void {
  const interval = window.setInterval(() => {
    try {
      alarmWatcherTick(getActive());
    } catch {
      /* storage unavailable — best-effort */
    }
  }, ALARM_ALERT_INTERVAL_MS);
  const onStore = (e: Event) => {
    const key = (e as CustomEvent<{ key?: string }>).detail?.key;
    if (key === ALARM_KEY || key === ALARM_FIRED_KEY) {
      try {
        alarmWatcherTick(getActive());
      } catch {
        /* ignore */
      }
    }
  };
  window.addEventListener(STORE_CHANGED_EVENT, onStore);
  return () => {
    window.clearInterval(interval);
    window.removeEventListener(STORE_CHANGED_EVENT, onStore);
  };
}
