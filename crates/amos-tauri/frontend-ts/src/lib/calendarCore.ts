/*
 * OS-level "upcoming event" alerts for the Calendar.
 *
 * An event with an alert offset should notify the user wherever they are — home
 * screen, another app, even the lock screen — not only while the Calendar app is
 * open. The Shell mounts `osCalendarWatcher` once (mirroring the reminders /
 * alarms / timer watchers), which periodically reconciles the calendar store and
 * fires ONE app notification per occurrence the first time its alert instant is
 * reached. Persisted "fired" markers (`amos.calendarFired`, entry key →
 * occurrence start) make publishing idempotent, so a repeating event alerts once
 * per occurrence — never twice for the same one.
 *
 * Honesty boundary (see docs/calendar.md): this is a *foreground* reconciler.
 * While the OS process is alive a missed alert is still delivered within
 * ALERT_GRACE_MS; a device that is powered off or has the process killed does
 * not wake up for it (that needs the OS scheduler + a native AlarmManager
 * bridge, tracked separately).
 *
 * Pure helpers are exported for tests; `syncDueEventAlerts` is the side-effecting
 * entry point used by the watcher (and callable on its own).
 */
import { readStoreValue, writeStoreValue } from "./amosStore";
import { NOTIF_KEY, NOTIF_CAP, normalizeNotifs, type Notif } from "./settings";
import {
  CALENDAR_KEY,
  CALENDARS_KEY,
  DAY_MS,
  MINUTE_MS,
  fmtTime,
  normalizeCalendars,
  normalizeEvents,
  occurrencesInRange,
  visibleEvents,
  type CalendarEvent,
  type CalendarGroup,
} from "./calendar";
import { zh } from "../i18n/locales/zh";

export { CALENDAR_KEY, CALENDARS_KEY };

export const CALENDAR_FIRED_KEY = "amos.calendarFired";
/** Internal app id of the Calendar app. While the user is focused there, due
 *  alerts are not published (the events are already on screen). */
export const CALENDAR_APP_ID = "calendar";
/** How often the OS re-checks alert instants (a coarse background scheduler). */
export const EVENT_ALERT_INTERVAL_MS = 15_000;
export const EVENT_ALERT_ICON = "📅";
/** A missed alert is still worth delivering for this long after its instant. */
export const ALERT_GRACE_MS = 15 * MINUTE_MS;
/** Bounded scan window around `now` when looking for alertable occurrences. */
export const ALERT_SCAN_PAST_MS = 8 * DAY_MS;
export const ALERT_SCAN_FUTURE_MS = 8 * DAY_MS;
/** Upper bound on alerts turned into notifications in one reconcile pass. */
export const ALERT_BATCH_CAP = 40;

export interface EventAlert {
  event: CalendarEvent;
  /** Occurrence start (epoch ms) — identifies the concrete happening. */
  startAt: number;
  /** Instant the alert becomes due (start − alertMinutes). */
  alertAt: number;
  /** Stable marker key: `${eventId}@${startAt}`. */
  key: string;
}

/** Stable identity of one alertable occurrence. */
export function alertKey(eventId: string, startAt: number): string {
  return `${eventId}@${startAt}`;
}

export function normalizeFired(v: unknown): Record<string, number> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, number> = {};
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!k) continue;
    const t = o[k];
    if (typeof t === "number" && Number.isFinite(t)) out[k] = t;
  }
  return out;
}

export interface CollectOpts {
  graceMs?: number;
  scanPastMs?: number;
  scanFutureMs?: number;
  cap?: number;
}

/**
 * Occurrences whose alert instant has arrived (now − grace ≤ alertAt ≤ now) and
 * that have not been alerted yet — earliest alert first, bounded by `cap`.
 * Hidden calendars are ignored: a muted calendar must not notify.
 */
export function collectDueEventAlerts(
  events: readonly CalendarEvent[],
  groups: readonly CalendarGroup[],
  fired: Record<string, number>,
  now: number,
  opts: CollectOpts = {},
): EventAlert[] {
  const graceMs = opts.graceMs ?? ALERT_GRACE_MS;
  const scanPast = opts.scanPastMs ?? ALERT_SCAN_PAST_MS;
  const scanFuture = opts.scanFutureMs ?? ALERT_SCAN_FUTURE_MS;
  const cap = opts.cap ?? ALERT_BATCH_CAP;
  const visible = visibleEvents(events, groups);
  const occs = occurrencesInRange(visible, now - scanPast, now + scanFuture);
  const out: EventAlert[] = [];
  for (const occ of occs) {
    const minutes = occ.event.alertMinutes;
    if (minutes == null) continue;
    const alertAt = occ.startAt - minutes * MINUTE_MS;
    if (alertAt > now || alertAt < now - graceMs) continue;
    const key = alertKey(occ.event.id, occ.startAt);
    if (fired[key] === occ.startAt) continue;
    out.push({ event: occ.event, startAt: occ.startAt, alertAt, key });
  }
  return out.sort((a, b) => a.alertAt - b.alertAt).slice(0, cap);
}

/** Record that each alert has been delivered at its occurrence start. */
export function markFired(
  fired: Record<string, number>,
  alerts: readonly EventAlert[],
): Record<string, number> {
  const out: Record<string, number> = { ...fired };
  for (const a of alerts) out[a.key] = a.startAt;
  return out;
}

/** Drop markers for occurrences older than the scan window (bounds growth). */
export function pruneFired(fired: Record<string, number>, now: number): Record<string, number> {
  const floor = now - ALERT_SCAN_PAST_MS;
  const out: Record<string, number> = {};
  for (const k of Object.keys(fired)) {
    const v = fired[k];
    if (typeof v === "number" && Number.isFinite(v) && v >= floor) out[k] = v;
  }
  return out;
}

/** Turn alerting occurrences into OS notifications (pure). */
export function alertsToNotifs(
  alerts: readonly EventAlert[],
  app: string,
  now: number,
): Notif[] {
  return alerts.map((a) => {
    const prefix = a.event.allDay ? "" : `${fmtTime(a.startAt)} `;
    const title = `${prefix}${a.event.title}`;
    return {
      id: `cal:${a.key}`,
      app,
      icon: EVENT_ALERT_ICON,
      title: title.length > 60 ? `${title.slice(0, 60)}…` : title,
      time: a.alertAt || now,
    };
  });
}

/** Side-effecting reconciliation: fire new alerts + prune markers. Idempotent. */
export function syncDueEventAlerts(now = Date.now()): void {
  const events = normalizeEvents(readStoreValue<unknown>(CALENDAR_KEY, []));
  const groups = normalizeCalendars(readStoreValue<unknown>(CALENDARS_KEY, []));
  const fired = normalizeFired(readStoreValue<unknown>(CALENDAR_FIRED_KEY, {}));
  const alerts = collectDueEventAlerts(events, groups, fired, now);
  if (alerts.length > 0) {
    // Normalize the existing list: a corrupt value must not wedge the alert
    // pipeline (spreading a non-array would throw on every tick, forever).
    const existing = normalizeNotifs(readStoreValue<unknown>(NOTIF_KEY, []));
    const fresh = alertsToNotifs(alerts, zh["app.calendar"], now);
    // Newest alert first, keep the rest, respect the notification cap.
    writeStoreValue(NOTIF_KEY, [...fresh.reverse(), ...existing].slice(0, NOTIF_CAP));
  }
  const next = pruneFired(markFired(fired, alerts), now);
  if (JSON.stringify(next) !== JSON.stringify(fired)) {
    writeStoreValue(CALENDAR_FIRED_KEY, next);
  }
}

