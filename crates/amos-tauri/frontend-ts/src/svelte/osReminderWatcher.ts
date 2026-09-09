/**
 * Shell-level reminder watcher for the Svelte host.
 *
 * The pure sync lives in `lib/reminderCore.ts`; this module is the scheduler
 * that calls it unless the Reminders app is the focused surface (its due items
 * are already on screen). Mirrors `osTimerWatcher` / `osAlarmWatcher`.
 */
import {
  DUE_ALERT_INTERVAL_MS,
  FIRED_KEY,
  REMINDERS_APP_ID,
  REMINDERS_KEY,
  syncDueReminderAlerts,
} from "../lib/reminderCore";
import { STORE_CHANGED_EVENT } from "../lib/amosStore";

/** One reconcile decision: runs the reminder sync unless the Reminders app is focused. */
export function reminderWatcherTick(
  activeAppId: string | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (activeAppId === REMINDERS_APP_ID) return false;
  try {
    syncDueReminderAlerts(nowMs);
    return true;
  } catch {
    return false;
  }
}

/** Start a background reminder watcher. Returns a stop function (call on unmount). */
export function startReminderWatcher(getActive: () => string | null): () => void {
  const interval = window.setInterval(() => {
    try {
      reminderWatcherTick(getActive());
    } catch {
      /* storage unavailable — best-effort */
    }
  }, DUE_ALERT_INTERVAL_MS);
  const onStore = (e: Event) => {
    const key = (e as CustomEvent<{ key?: string }>).detail?.key;
    if (key === REMINDERS_KEY || key === FIRED_KEY) {
      try {
        reminderWatcherTick(getActive());
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
