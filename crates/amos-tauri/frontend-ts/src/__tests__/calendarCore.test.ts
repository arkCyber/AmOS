/**
 * Pure tests for the Calendar OS-alert reconciler (src/lib/calendarCore.ts).
 *
 * `syncDueEventAlerts` touches the shared store, so we point `window` at a
 * Map-backed localStorage (same trick as core.test.ts) and assert both the
 * notifications and the idempotency markers it writes.
 */
import { describe, expect, test } from "bun:test";
import {
  ALERT_GRACE_MS,
  CALENDAR_FIRED_KEY,
  CALENDAR_KEY,
  CALENDARS_KEY,
  alertKey,
  alertsToNotifs,
  collectDueEventAlerts,
  markFired,
  normalizeFired,
  pruneFired,
  syncDueEventAlerts,
} from "../lib/calendarCore";
import { NOTIF_KEY, normalizeNotifs, type Notif } from "../lib/settings";
import { DEFAULT_CALENDAR_ID, DAY_MS, type CalendarEvent, type CalendarGroup } from "../lib/calendar";

const at = (y: number, mo: number, d: number, h = 0, mi = 0): number =>
  new Date(y, mo - 1, d, h, mi, 0, 0).getTime();

const GROUPS: CalendarGroup[] = [
  { id: DEFAULT_CALENDAR_ID, custom: false, name: "", color: "blue", enabled: true, createdAt: 0 },
  { id: "muted", custom: true, name: "Muted", color: "gray", enabled: false, createdAt: 0 },
];

function ev(over: Partial<CalendarEvent> & { id: string; startAt: number }): CalendarEvent {
  return {
    calendarId: DEFAULT_CALENDAR_ID,
    title: "T",
    endAt: over.startAt + 3_600_000,
    allDay: false,
    repeat: "none",
    alertMinutes: 0,
    createdAt: 0,
    ...over,
  };
}

function withStorage(store: Map<string, string>) {
  (globalThis as unknown as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    dispatchEvent: () => true,
  };
}

describe("calendarCore — fired markers", () => {
  test("normalizeFired keeps finite numeric entries only", () => {
    expect(normalizeFired(null)).toEqual({});
    expect(normalizeFired([1, 2])).toEqual({});
    expect(normalizeFired({ a: 5, b: "x", c: Number.NaN, "": 9 })).toEqual({ a: 5 });
  });

  test("alertKey is stable and occurrence-specific", () => {
    expect(alertKey("e1", 100)).toBe("e1@100");
    expect(alertKey("e1", 200)).not.toBe(alertKey("e1", 100));
  });

  test("markFired records each alert; pruneFired drops stale occurrences", () => {
    const now = at(2026, 3, 9, 12);
    const alerts = [
      { event: ev({ id: "a", startAt: now }), startAt: now, alertAt: now, key: alertKey("a", now) },
    ];
    const marked = markFired({}, alerts);
    expect(marked[alertKey("a", now)]).toBe(now);
    const pruned = pruneFired(
      { [alertKey("recent", now)]: now, [alertKey("old", now)]: now - 20 * DAY_MS },
      now,
    );
    expect(Object.keys(pruned)).toEqual([alertKey("recent", now)]);
    expect(marked[alertKey("a", now)]).toBe(now); // input untouched (immutable)
  });
});

describe("calendarCore — collectDueEventAlerts", () => {
  test("fires at the event time when the alert offset is 0", () => {
    const start = at(2026, 3, 9, 14);
    const events = [ev({ id: "a", startAt: start })];
    expect(collectDueEventAlerts(events, GROUPS, {}, start - 1)).toEqual([]); // 1ms early
    const due = collectDueEventAlerts(events, GROUPS, {}, start);
    expect(due.length).toBe(1);
    expect(due[0]!.event.id).toBe("a");
    expect(due[0]!.alertAt).toBe(start);
  });

  test("honours the 'N minutes before' offset", () => {
    const start = at(2026, 3, 9, 14);
    const events = [ev({ id: "a", startAt: start, alertMinutes: 15 })];
    const dueAt = start - 15 * 60_000;
    expect(collectDueEventAlerts(events, GROUPS, {}, dueAt - 1)).toEqual([]);
    expect(collectDueEventAlerts(events, GROUPS, {}, dueAt).length).toBe(1);
  });

  test("a missed alert is still delivered inside the grace window, not after", () => {
    const start = at(2026, 3, 9, 14);
    const events = [ev({ id: "a", startAt: start })];
    expect(collectDueEventAlerts(events, GROUPS, {}, start + ALERT_GRACE_MS - 1).length).toBe(1);
    expect(collectDueEventAlerts(events, GROUPS, {}, start + ALERT_GRACE_MS + 1)).toEqual([]);
  });

  test("skips events with no alert, hidden calendars, and already-fired markers", () => {
    const start = at(2026, 3, 9, 14);
    const events = [
      ev({ id: "none", startAt: start, alertMinutes: null }),
      ev({ id: "muted", startAt: start, calendarId: "muted" }),
      ev({ id: "ok", startAt: start }),
    ];
    expect(collectDueEventAlerts(events, GROUPS, {}, start).map((a) => a.event.id)).toEqual(["ok"]);
    const fired = { [alertKey("ok", start)]: start };
    expect(collectDueEventAlerts(events, GROUPS, fired, start)).toEqual([]);
  });

  test("a repeating event alerts once per occurrence", () => {
    const start = at(2026, 3, 9, 9);
    const events = [ev({ id: "daily", startAt: start, repeat: "daily" })];
    const now = start + 2 * DAY_MS; // third occurrence
    const due = collectDueEventAlerts(events, GROUPS, {}, now);
    expect(due.map((a) => a.startAt)).toEqual([start + 2 * DAY_MS]);
    // After marking it, the next tick is quiet until the next occurrence.
    const fired = markFired({}, due);
    expect(collectDueEventAlerts(events, GROUPS, fired, now + 60_000)).toEqual([]);
    expect(
      collectDueEventAlerts(events, GROUPS, fired, start + 3 * DAY_MS).map((a) => a.startAt),
    ).toEqual([start + 3 * DAY_MS]);
  });

  test("ordering is chronological and batching is bounded", () => {
    const start = at(2026, 3, 9, 14);
    const events = Array.from({ length: 6 }, (_, i) =>
      ev({ id: `e${i}`, title: `e${i}`, startAt: start + i * 60_000 }),
    );
    const now = start + 5 * 60_000;
    const due = collectDueEventAlerts(events, GROUPS, {}, now, { cap: 3 });
    expect(due.length).toBe(3);
    for (let i = 1; i < due.length; i += 1) {
      expect(due[i]!.alertAt).toBeGreaterThanOrEqual(due[i - 1]!.alertAt);
    }
  });

  test("all-day events alert at midnight of their day", () => {
    const day = at(2026, 3, 9);
    const events = [
      ev({
        id: "holiday",
        title: "Holiday",
        startAt: day,
        endAt: day + DAY_MS,
        allDay: true,
        alertMinutes: 0,
      }),
    ];
    expect(collectDueEventAlerts(events, GROUPS, {}, day).length).toBe(1);
  });
});

describe("calendarCore — notifications", () => {
  test("alertsToNotifs prefixes the time for timed events only", () => {
    const start = at(2026, 3, 9, 14, 5);
    const timed = ev({ id: "t", title: "Standup", startAt: start });
    const allDay = ev({ id: "a", title: "Holiday", startAt: start, allDay: true });
    const mk = (e: CalendarEvent) => ({
      event: e,
      startAt: start,
      alertAt: start,
      key: alertKey(e.id, start),
    });
    const [tn, an] = alertsToNotifs([mk(timed), mk(allDay)], "日历", start);
    expect(tn!.id).toBe(`cal:${alertKey("t", start)}`);
    expect(tn!.title).toBe("14:05 Standup");
    expect(tn!.app).toBe("日历");
    expect(an!.title).toBe("Holiday"); // no time prefix for all-day
  });

  test("long titles are truncated to 60 chars + ellipsis", () => {
    const start = at(2026, 3, 9, 14, 5);
    const e = ev({ id: "long", title: "x".repeat(200), startAt: start });
    const [n] = alertsToNotifs(
      [{ event: e, startAt: start, alertAt: start, key: alertKey("long", start) }],
      "日历",
      start,
    );
    const title = n?.title ?? "";
    expect(title.length).toBe(61);
    expect(title.endsWith("…")).toBe(true);
  });
});


describe("calendarCore — syncDueEventAlerts (store round-trip)", () => {
  test("writes one notification + a fired marker, and is idempotent", () => {
    const store = new Map<string, string>();
    withStorage(store);
    const start = at(2026, 3, 9, 14);
    store.set(CALENDARS_KEY, JSON.stringify(GROUPS));
    store.set(CALENDAR_KEY, JSON.stringify([ev({ id: "a", title: "Standup", startAt: start })]));

    syncDueEventAlerts(start);
    const notifs = normalizeNotifs(JSON.parse(store.get(NOTIF_KEY) ?? "[]") as Notif[]);
    expect(notifs.length).toBe(1);
    expect(notifs[0]!.id).toBe(`cal:${alertKey("a", start)}`);
    expect(notifs[0]!.app).toBe("日历");

    const fired = JSON.parse(store.get(CALENDAR_FIRED_KEY) ?? "{}") as Record<string, number>;
    expect(fired[alertKey("a", start)]).toBe(start);

    // Second pass at a later instant must not duplicate the notification.
    syncDueEventAlerts(start + 1000);
    const after = normalizeNotifs(JSON.parse(store.get(NOTIF_KEY) ?? "[]") as Notif[]);
    expect(after.length).toBe(1);
  });

  test("hidden calendars and alert-less events never notify", () => {
    const store = new Map<string, string>();
    withStorage(store);
    const start = at(2026, 3, 9, 14);
    store.set(CALENDARS_KEY, JSON.stringify(GROUPS));
    store.set(
      CALENDAR_KEY,
      JSON.stringify([
        ev({ id: "muted", startAt: start, calendarId: "muted" }),
        ev({ id: "silent", startAt: start, alertMinutes: null }),
      ]),
    );
    syncDueEventAlerts(start);
    expect(store.get(NOTIF_KEY)).toBeUndefined();
    expect(JSON.parse(store.get(CALENDAR_FIRED_KEY) ?? "{}")).toEqual({});
  });

  test("corrupt stored values don't throw (fail-safe empty state)", () => {
    const store = new Map<string, string>();
    withStorage(store);
    store.set(CALENDAR_KEY, "{ not json");
    store.set(CALENDARS_KEY, "[]");
    store.set(CALENDAR_FIRED_KEY, "nope");
    expect(() => syncDueEventAlerts(at(2026, 3, 9))).not.toThrow();
  });

  test("a corrupt notifications store is repaired, not left wedging every tick", () => {
    const store = new Map<string, string>();
    withStorage(store);
    const start = at(2026, 3, 9, 14);
    store.set(CALENDARS_KEY, JSON.stringify(GROUPS));
    store.set(CALENDAR_KEY, JSON.stringify([ev({ id: "a", title: "Standup", startAt: start })]));
    // Non-array garbage: spreading it used to throw on EVERY reconcile, so no
    // calendar alert could ever be delivered again (silent, permanent).
    store.set(NOTIF_KEY, JSON.stringify({ nope: true }));
    expect(() => syncDueEventAlerts(start)).not.toThrow();
    const notifs = normalizeNotifs(JSON.parse(store.get(NOTIF_KEY) ?? "[]") as Notif[]);
    expect(notifs.map((n) => n.id)).toEqual([`cal:${alertKey("a", start)}`]);
  });
});

