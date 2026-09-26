/**
 * The three background OS alert producers — `syncDueAlarmAlerts` / `syncDueReminderAlerts` /
 * `syncDueEventAlerts` — write two things per delivered alert: a **row** on
 * `amos.notifications` (the surface every consumer reads) and a **one-shot marker**
 * (`amos.alarmNotifFired` / `amos.reminderFired` / `amos.calendarFired`) that stops the next
 * reconcile from delivering the same alert again.
 *
 * These leaves hold the four properties the relation between those two demands
 * (REQ-A1398 ∕ F-SH-657):
 *
 *  1. **The marker is consumed only for an alert that landed.** A refused notification write
 *     (quota) must leave the alert due, so a later tick retries it — the marker is exactly
 *     what would otherwise stop the retry.
 *  2. **The row is written id-stable.** Each producer names one *arrival*, so a retry (or a
 *     daily alarm's second day) must replace that row rather than prepend a second copy: the
 *     stored array is what a raw reader sees, and duplicates there eat `NOTIF_CAP`.
 *  3. **The row's id carries the marker's discriminator**, because the OS arrival banner
 *     (`newestAddedNotif`) decides "just arrived" by comparing id **sets**: a second arrival
 *     under the same id is announced exactly never.
 *  4. **A corrupt `amos.notifications` does not wedge the producer** — `alarmCore` used to
 *     read it raw, so one garbage value answered every 2 s tick with a throw, for good.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}

import {
  ALARM_FIRED_KEY,
  ALARM_KEY,
  firedKey,
  syncDueAlarmAlerts,
} from "../lib/alarmCore";
import { FIRED_KEY, syncDueReminderAlerts } from "../lib/reminderCore";
import {
  CALENDAR_FIRED_KEY,
  CALENDAR_KEY,
  CALENDARS_KEY,
  syncDueEventAlerts,
} from "../lib/calendarCore";
import { REMINDERS_KEY } from "../lib/reminders";
import { DEFAULT_CALENDAR_ID } from "../lib/calendar";
import { NOTIF_KEY, newestAddedNotif, type Notif } from "../lib/settings";

const NOW = new Date(2026, 8, 7, 8, 0, 30).getTime(); // 2026-09-07 (Mon) 08:00:30
const DAY = 86_400_000;

/** A `window` whose localStorage refuses writes to one key (full/unavailable storage). */
function installRefusingStorage(failKey: string) {
  const store = new Map<string, string>();
  let refuse = true;
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (refuse && k === failKey) throw new Error("QuotaExceededError");
        store.set(k, v);
      },
      removeItem: (k: string) => void store.delete(k),
    },
    dispatchEvent: () => true,
  };
  return {
    put: (k: string, v: unknown) => store.set(k, JSON.stringify(v)),
    get: <T>(k: string): T | undefined => {
      const raw = store.get(k);
      return raw === undefined ? undefined : (JSON.parse(raw) as T);
    },
    /** Storage recovers (the user freed space / the quota window passed). */
    recover: () => {
      refuse = false;
    },
  };
}

let realWindow: unknown;
beforeEach(() => {
  realWindow = (globalThis as unknown as { window?: unknown }).window;
});
afterEach(() => {
  (globalThis as unknown as { window?: unknown }).window = realWindow;
});

const reminder = (id: string, dueAt: number) => ({
  id,
  title: `事项-${id}`,
  listId: "inbox",
  priority: 0,
  flagged: false,
  createdAt: 0,
  dueAt,
});

const alarm = (over: Record<string, unknown> = {}) => ({
  id: "w1",
  label: "Wake",
  hour: 8,
  min: 0,
  enabled: true,
  ringing: false,
  tone: "🔔",
  createdAt: 0,
  ...over,
});

const event = (startAt: number, over: Record<string, unknown> = {}) => ({
  id: "e1",
  calendarId: DEFAULT_CALENDAR_ID,
  title: "Standup",
  startAt,
  endAt: startAt + 3_600_000,
  allDay: false,
  repeat: "none",
  alertMinutes: 0,
  createdAt: 0,
  ...over,
});

const group = () => ({
  id: DEFAULT_CALENDAR_ID,
  custom: false,
  name: "",
  color: "blue",
  enabled: true,
  createdAt: 0,
});

describe("alert producers — a refused write does not consume the one-shot marker", () => {
  test("calendar: a refused notification write leaves the alert due, and the retry delivers it", () => {
    const s = installRefusingStorage(NOTIF_KEY);
    s.put(CALENDARS_KEY, [group()]);
    s.put(CALENDAR_KEY, [event(NOW - 60_000)]);

    syncDueEventAlerts(NOW);
    // Nothing landed → nothing may be marked: the marker is what stops the retry, and the
    // alert is still inside its grace window (ALERT_GRACE_MS = 15 min).
    expect(s.get(CALENDAR_FIRED_KEY)).toBeUndefined();

    s.recover();
    syncDueEventAlerts(NOW + 30_000); // a later tick, still within grace
    const notifs = s.get<Notif[]>(NOTIF_KEY)!;
    expect(notifs.filter((n) => n.id.startsWith("cal:e1@")).length).toBe(1);
    expect(Object.keys(s.get<Record<string, number>>(CALENDAR_FIRED_KEY)!).length).toBe(1);
  });

  test("reminder: a refused notification write leaves the alert due, and the retry delivers it", () => {
    const s = installRefusingStorage(NOTIF_KEY);
    s.put(REMINDERS_KEY, [reminder("r1", NOW - 1_000)]);

    syncDueReminderAlerts(NOW);
    expect(s.get(FIRED_KEY)).toBeUndefined();

    s.recover();
    syncDueReminderAlerts(NOW + 30_000);
    const notifs = s.get<Notif[]>(NOTIF_KEY)!;
    expect(notifs.filter((n) => n.id.startsWith("rem:r1:")).length).toBe(1);
    expect(s.get<Record<string, number>>(FIRED_KEY)).toEqual({ r1: NOW - 1_000 });
  });

  test("alarm: a refused ring-latch leaves the ring due, and the retry rings + marks it", () => {
    const s = installRefusingStorage(ALARM_KEY);
    s.put(ALARM_KEY, [alarm({})]);

    const rang = syncDueAlarmAlerts(NOW);
    expect(rang).toBe(true);
    // The latch did not land, so the day marker must not either: `liveRingingIds` reads the
    // marker to decide whether a persisted `ringing:true` is *today's* ring, so consuming the
    // marker here would claim a surface nothing holds and silence the alarm for the day.
    expect(s.get(ALARM_FIRED_KEY)).toBeUndefined();

    s.recover();
    expect(syncDueAlarmAlerts(NOW)).toBe(true);
    const stored = s.get<Array<{ id: string; ringing?: boolean }>>(ALARM_KEY)!;
    expect(stored.find((a) => a.id === "w1")!.ringing).toBe(true);
    expect(s.get<Record<string, string>>(ALARM_FIRED_KEY)![firedKey(alarm({}) as never)]).toBe(
      "2026-09-07",
    );
  });
});

describe("alert producers — the arrival row is id-stable and bounded", () => {
  test("a daily alarm's rings are distinct rows, one per day, and an unrelated row survives", () => {
    const s = installRefusingStorage("__never__");
    s.put(ALARM_KEY, [alarm({})]);
    // A genuine unrelated notification the user must not lose.
    s.put(NOTIF_KEY, [{ id: "msg:1", app: "Messages", title: "Hi", time: NOW }]);

    for (let day = 0; day < 5; day++) {
      syncDueAlarmAlerts(new Date(2026, 8, 7 + day, 8, 0, 30).getTime());
    }
    const stored = s.get<Notif[]>(NOTIF_KEY)!;
    const ids = stored.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length); // no invisible duplicate rows
    expect(ids.filter((id) => id.startsWith("alarm:w1:08:00:")).length).toBe(5);
    expect(ids).toContain("msg:1");
  });

  test("a ring that cannot latch does not accumulate a duplicate row on every retry", () => {
    // The latch is refused, so the ring stays due and every tick re-delivers it — with the
    // same arrival id ("the same HH:MM on the same day"). A prepend would therefore add a
    // second copy of that row each time; `normalizeNotifs` hides them on read, so the only
    // way the growth shows is in the stored array, where it eats `NOTIF_CAP`.
    const s = installRefusingStorage(ALARM_KEY);
    s.put(ALARM_KEY, [alarm({})]);
    syncDueAlarmAlerts(NOW);
    syncDueAlarmAlerts(NOW);
    const ids = s.get<Notif[]>(NOTIF_KEY)!.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("a refused-then-retried reminder alert leaves exactly one row for that arrival", () => {
    const s = installRefusingStorage(NOTIF_KEY);
    s.put(REMINDERS_KEY, [reminder("r1", NOW - 1_000)]);
    syncDueReminderAlerts(NOW); // refused → nothing written
    s.recover();
    syncDueReminderAlerts(NOW + 1_000); // retry writes the row
    syncDueReminderAlerts(NOW + 2_000); // marker now set → a no-op tick
    const stored = s.get<Notif[]>(NOTIF_KEY)!;
    expect(stored.filter((n) => n.id.startsWith("rem:r1:")).length).toBe(1);
  });
});

describe("alert producers — a second arrival is announced, not silent", () => {
  test("an alarm's next-day ring is a new id, so the arrival banner sees it", () => {
    const s = installRefusingStorage("__never__");
    s.put(ALARM_KEY, [alarm({})]);
    syncDueAlarmAlerts(NOW);
    const day1 = s.get<Notif[]>(NOTIF_KEY)!;
    expect(newestAddedNotif([], day1)).not.toBeNull();

    // The user dismisses it; the next day's ring must read as a *new* arrival.
    const released = s.get<Array<Record<string, unknown>>>(ALARM_KEY)!;
    released[0]!.ringing = false;
    s.put(ALARM_KEY, released);
    syncDueAlarmAlerts(NOW + DAY);
    const day2 = s.get<Notif[]>(NOTIF_KEY)!;
    expect(newestAddedNotif(day1, day2)).not.toBeNull();
  });

  test("a reminder moved to a new due time alerts again as a new arrival", () => {
    const s = installRefusingStorage("__never__");
    s.put(REMINDERS_KEY, [reminder("r1", NOW - 1_000)]);
    syncDueReminderAlerts(NOW);
    const first = s.get<Notif[]>(NOTIF_KEY)!;

    // The user edits the due time; it later becomes due again.
    s.put(REMINDERS_KEY, [reminder("r1", NOW + 3_600_000)]);
    syncDueReminderAlerts(NOW + 3_600_000 + 1_000);
    const second = s.get<Notif[]>(NOTIF_KEY)!;
    expect(newestAddedNotif(first, second)).not.toBeNull();
  });
});

describe("alert producers — a corrupt notifications store does not wedge the producer", () => {
  test("alarm: a non-array value is repaired instead of throwing on every tick", () => {
    const s = installRefusingStorage("__never__");
    s.put(ALARM_KEY, [alarm({})]);
    (globalThis as unknown as { window: { localStorage: { setItem: (k: string, v: string) => void } } })
      .window.localStorage.setItem(NOTIF_KEY, JSON.stringify({ nope: true }));

    const out: { rang?: boolean } = {};
    expect(() => {
      out.rang = syncDueAlarmAlerts(NOW);
    }).not.toThrow();
    expect(out.rang).toBe(true);
    const stored = s.get<Notif[]>(NOTIF_KEY)!;
    expect(Array.isArray(stored)).toBe(true);
    expect(stored.filter((n) => n.id.startsWith("alarm:w1:08:00:")).length).toBe(1);
  });
});
