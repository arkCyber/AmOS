/**
 * Shell-level alarm watcher for the Svelte host.
 *
 * When Shell.svelte is the production host it must run the OS "due alarm"
 * reconcile itself. All real logic lives in `lib/alarmCore.ts`; this module is
 * the timer/scheduler that calls `syncDueAlarmAlerts` unless the Clock app is
 * the focused surface (its own in-app ring is on screen).
 *
 * It also drives `osAlarmArm.reconcileNativeAlarms` — once at start (so persisted
 * alarms are registered after a boot) and on every alarm-list change (so a new
 * alarm is armed and a disabled/deleted one is cancelled), which
 * `syncDueAlarmAlerts` alone cannot do.
 */
import {
  ALARM_ALERT_INTERVAL_MS,
  ALARM_FIRED_KEY,
  ALARM_KEY,
  CLOCK_APP_ID,
  syncDueAlarmAlerts,
} from "../lib/alarmCore";
import { STORE_CHANGED_EVENT } from "../lib/amosStore";
import { reconcileNativeAlarms } from "./osAlarmArm";

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
  // Register the persisted alarms with the host scheduler up-front (a boot may
  // never open the Clock screen), then keep them in step on every change.
  void reconcileNativeAlarms();
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
      // An alarm was added / edited / enabled / disabled / deleted → make the
      // native registrations match (arm the new next occurrence, cancel the rest).
      if (key === ALARM_KEY) void reconcileNativeAlarms();
    }
  };
  window.addEventListener(STORE_CHANGED_EVENT, onStore);
  return () => {
    window.clearInterval(interval);
    window.removeEventListener(STORE_CHANGED_EVENT, onStore);
  };
}
