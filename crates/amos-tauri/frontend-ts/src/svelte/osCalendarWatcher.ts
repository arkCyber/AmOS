/**
 * Shell-level calendar watcher for the Svelte host.
 *
 * The pure sync lives in `lib/calendarCore.ts`; this module is the scheduler
 * that calls it unless the Calendar app is the focused surface (its events are
 * already on screen). Mirrors `osReminderWatcher` / `osTimerWatcher`.
 */
import {
  CALENDAR_APP_ID,
  CALENDAR_FIRED_KEY,
  CALENDAR_KEY,
  CALENDARS_KEY,
  EVENT_ALERT_INTERVAL_MS,
  syncDueEventAlerts,
} from "../lib/calendarCore";
import { STORE_CHANGED_EVENT } from "../lib/amosStore";

/** One reconcile decision: runs the calendar sync unless Calendar is focused. */
export function calendarWatcherTick(
  activeAppId: string | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (activeAppId === CALENDAR_APP_ID) return false;
  try {
    syncDueEventAlerts(nowMs);
    return true;
  } catch {
    return false;
  }
}

const WATCHED = new Set<string>([CALENDAR_KEY, CALENDARS_KEY, CALENDAR_FIRED_KEY]);

/** Start a background calendar watcher. Returns a stop function (on unmount). */
export function startCalendarWatcher(getActive: () => string | null): () => void {
  const interval = window.setInterval(() => {
    try {
      calendarWatcherTick(getActive());
    } catch {
      /* storage unavailable — best-effort */
    }
  }, EVENT_ALERT_INTERVAL_MS);
  const onStore = (e: Event) => {
    const key = (e as CustomEvent<{ key?: string }>).detail?.key;
    if (key && WATCHED.has(key)) {
      try {
        calendarWatcherTick(getActive());
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
