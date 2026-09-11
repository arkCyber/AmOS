/**
 * Pure-domain tests for the Calendar kernel (src/lib/calendar.ts).
 *
 * Everything here runs without a DOM so the whole date/recurrence/selector
 * surface is locked deterministically. Local-time assertions build their
 * instants with `new Date(y, m, d, h, mm)` so the suite is timezone-agnostic.
 */
import { describe, expect, test } from "bun:test";
import {
  ALERT_OPTIONS,
  CALENDAR_COLORS,
  DEFAULT_CALENDAR_ID,
  DAY_MS,
  EVENT_CAP,
  addCalendar,
  addDays,
  addEvent,
  addMonths,
  allDayEnd,
  atLocalTime,
  calendarById,
  countDays,
  daysInMonth,
  expandOccurrences,
  fmtTime,
  fromDateAndTime,
  groupByDay,
  isSameDay,
  isContinuation,
  makeId,
  monthGrid,
  newEventDraft,
  normalizeCalendars,
  normalizeEvents,
  occurrencesByDay,
  occurrencesInRange,
  occurrencesOnDay,
  overlapsRange,
  reassignOrphans,
  removeCalendar,
  removeEvent,
  searchEvents,
  seedCalendars,
  seedEvents,
  shiftByWallClock,
  shiftOccurrence,
  sortOccurrences,
  spansDays,
  startOfDay,
  startOfMonth,
  startOfWeek,
  toDateInput,
  toTimeInput,
  toggleCalendar,
  updateEvent,
  visibleEvents,
  weekDays,
  weekdayOrder,
  type CalendarEvent,
  type CalendarGroup,
  type Repeat,
} from "../lib/calendar";

const at = (y: number, mo: number, d: number, h = 0, mi = 0): number =>
  new Date(y, mo - 1, d, h, mi, 0, 0).getTime();

/** Terse event factory (fields overridable). */
function ev(over: Partial<CalendarEvent> & { id: string; startAt: number }): CalendarEvent {
  return {
    calendarId: DEFAULT_CALENDAR_ID,
    title: "T",
    endAt: over.startAt + 3_600_000,
    allDay: false,
    repeat: "none",
    alertMinutes: null,
    createdAt: 0,
    ...over,
  };
}

describe("calendar — date math", () => {
  test("startOfDay / isSameDay", () => {
    const d = at(2026, 3, 9, 23, 59);
    expect(startOfDay(d)).toBe(at(2026, 3, 9));
    expect(isSameDay(d, at(2026, 3, 9, 0, 1))).toBe(true);
    expect(isSameDay(d, at(2026, 3, 10))).toBe(false);
  });

  test("addDays keeps the wall-clock time across a month boundary", () => {
    expect(addDays(at(2026, 1, 31, 9, 30), 1)).toBe(at(2026, 2, 1, 9, 30));
    expect(addDays(at(2026, 3, 1, 9, 30), -1)).toBe(at(2026, 2, 28, 9, 30));
  });

  test("daysInMonth / addMonths clamps the day (Jan 31 → Feb 28)", () => {
    expect(daysInMonth(2026, 1)).toBe(28);
    expect(daysInMonth(2024, 1)).toBe(29); // leap year
    expect(addMonths(at(2026, 1, 31, 9, 0), 1)).toBe(at(2026, 2, 28, 9, 0));
    expect(addMonths(at(2026, 1, 31, 9, 0), 3)).toBe(at(2026, 4, 30, 9, 0));
    expect(addMonths(at(2026, 12, 15), 1)).toBe(at(2027, 1, 15));
  });

  test("startOfMonth snaps to the first midnight of the month", () => {
    expect(startOfMonth(at(2026, 3, 9, 12))).toBe(at(2026, 3, 1));
    expect(startOfMonth(at(2026, 3, 1))).toBe(at(2026, 3, 1));
    expect(startOfMonth(at(2026, 12, 31, 23, 59))).toBe(at(2026, 12, 1));
  });

  test("monthGrid is 6×7, Sunday-first, covers the whole month", () => {
    const g = monthGrid(at(2026, 3, 15), 0);
    expect(g.length).toBe(42);
    expect(new Date(g[0]!).getDay()).toBe(0); // Sunday
    for (let i = 1; i < g.length; i += 1) {
      const step = g[i]! - g[i - 1]!;
      // A local day is 23–25h across DST transitions.
      expect(step).toBeGreaterThanOrEqual(23 * 3_600_000);
      expect(step).toBeLessThanOrEqual(25 * 3_600_000);
    }
    expect(g).toContain(at(2026, 3, 1));
    expect(g).toContain(at(2026, 3, 31));
    expect(g[0]! <= at(2026, 3, 1)).toBe(true); // never starts after the 1st
    const m = monthGrid(at(2026, 3, 15), 1); // Monday-first
    expect(new Date(m[0]!).getDay()).toBe(1);
  });

  test("weekdayOrder rotates the week start", () => {
    expect(weekdayOrder(0)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(weekdayOrder(1)).toEqual([1, 2, 3, 4, 5, 6, 0]);
  });

  test("startOfWeek respects the region's first weekday (Sun- vs Mon-first)", () => {
    // 2026-03-11 is a Wednesday; Sun-first week starts 03-08, Mon-first 03-09.
    const wed = at(2026, 3, 11, 15, 30);
    expect(startOfWeek(wed, 0)).toBe(at(2026, 3, 8));
    expect(startOfWeek(wed, 1)).toBe(at(2026, 3, 9));
    // A day that IS the first weekday is its own week start.
    expect(startOfWeek(at(2026, 3, 8), 0)).toBe(at(2026, 3, 8)); // Sunday
    expect(startOfWeek(at(2026, 3, 9), 1)).toBe(at(2026, 3, 9)); // Monday
    // Crosses a month/year boundary without drifting.
    expect(startOfWeek(at(2027, 1, 1), 1)).toBe(at(2026, 12, 28));
  });

  test("weekDays is exactly 7 consecutive local midnights (DST/month-safe)", () => {
    const w = weekDays(at(2026, 3, 11, 9), 1); // Mon-first week around 03-11
    expect(w.length).toBe(7);
    expect(w[0]).toBe(at(2026, 3, 9));
    expect(w[6]).toBe(at(2026, 3, 15));
    for (let i = 1; i < w.length; i += 1) {
      const step = w[i]! - w[i - 1]!;
      expect(step).toBeGreaterThanOrEqual(23 * 3_600_000); // DST spring-forward
      expect(step).toBeLessThanOrEqual(25 * 3_600_000); // DST fall-back
      // Every entry is a local midnight, so a fixed grid never pops.
      expect(w[i]).toBe(startOfDay(w[i]!));
    }
    // A week straddling a DST switch still has 7 distinct days (the assertion
    // holds in every host timezone; the step bounds above are what make it so).
    const dst = weekDays(at(2026, 3, 29), 1);
    expect(new Set(dst).size).toBe(7);
  });

  test("fromDateAndTime parses valid input and rejects impossible dates", () => {
    expect(fromDateAndTime("2026-03-09", "09:30")).toBe(at(2026, 3, 9, 9, 30));
    expect(fromDateAndTime("2026-03-09", "")).toBe(at(2026, 3, 9, 0, 0));
    expect(fromDateAndTime("2026-02-31", "09:00")).toBeNull(); // rolls over
    expect(fromDateAndTime("", "09:00")).toBeNull();
    expect(fromDateAndTime("2026-13-01", "09:00")).toBeNull();
    expect(fromDateAndTime("2026-03-09", "25:00")).toBeNull();
  });

  test("toDateInput / toTimeInput / fmtTime round-trip local values", () => {
    const ms = at(2026, 3, 9, 7, 5);
    expect(toDateInput(ms)).toBe("2026-03-09");
    expect(toTimeInput(ms)).toBe("07:05");
    expect(fmtTime(ms)).toBe("07:05");
  });
});

describe("calendar — normalization (corruption guards)", () => {
  test("normalizeEvents drops unusable rows and repairs the rest", () => {
    const out = normalizeEvents([
      null,
      "nope",
      { title: "   " },
      {
        id: "a",
        title: "  Standup  ",
        startAt: at(2026, 3, 9, 9, 0),
        endAt: at(2026, 3, 9, 8, 0), // inverted → +1 minute
        repeat: "hourly", // not whitelisted → none
        alertMinutes: 99999, // out of range → null
        calendarId: "",
      },
      // all-day: snapped to midnight, exactly one day long
      { id: "b", title: "Holiday", startAt: at(2026, 3, 9, 13, 20), allDay: true },
      { id: "a", title: "Dup id" }, // duplicate id → renamed, kept
    ]);
    expect(out.length).toBe(3);
    const a = out[0]!;
    expect(a.title).toBe("Standup");
    expect(a.endAt).toBe(a.startAt + 60_000);
    expect(a.repeat).toBe("none");
    expect(a.alertMinutes).toBeNull();
    expect(a.calendarId).toBe(DEFAULT_CALENDAR_ID);
    const b = out[1]!;
    expect(b.allDay).toBe(true);
    expect(b.startAt).toBe(at(2026, 3, 9));
    expect(b.endAt).toBe(at(2026, 3, 10));
    expect(out[2]!.id).not.toBe(a.id); // de-duplicated
  });

  test("normalizeEvents bounds the list at EVENT_CAP (keeps the newest)", () => {
    const many = Array.from({ length: EVENT_CAP + 5 }, (_, i) => ({
      id: `e${i}`,
      title: `t${i}`,
      startAt: i,
    }));
    const out = normalizeEvents(many);
    expect(out.length).toBe(EVENT_CAP);
    expect(out[out.length - 1]!.id).toBe(`e${EVENT_CAP + 4}`);
  });

  test("normalizeCalendars keeps the unnamed built-in but needs custom names", () => {
    const out = normalizeCalendars([
      { id: DEFAULT_CALENDAR_ID, custom: false, name: "", color: "nope", createdAt: 1 },
      { id: "x", custom: true, name: "   " }, // custom without a name → dropped
      { id: "y", custom: true, name: " Work ", color: "green", enabled: false },
      { id: "y", custom: true, name: "dup" }, // duplicate id → dropped
      { id: "" },
    ]);
    expect(out.length).toBe(2);
    expect(out[0]!.color).toBe("blue"); // invalid colour → fallback
    expect(out[0]!.enabled).toBe(true); // absent → visible
    expect(out[1]!.name).toBe("Work");
    expect(out[1]!.enabled).toBe(false);
  });

  test("normalization tolerates non-array input", () => {
    expect(normalizeEvents(null)).toEqual([]);
    expect(normalizeCalendars({})).toEqual([]);
  });
});


describe("calendar — recurrence expansion", () => {
  test("non-repeating events overlap (or not) a range", () => {
    const e = ev({ id: "a", startAt: at(2026, 3, 9, 9), endAt: at(2026, 3, 9, 10) });
    expect(expandOccurrences(e, at(2026, 3, 9), at(2026, 3, 10)).length).toBe(1);
    expect(expandOccurrences(e, at(2026, 3, 10), at(2026, 3, 11)).length).toBe(0);
    // A zero-width query yields nothing (no phantom occurrences).
    expect(expandOccurrences(e, at(2026, 3, 9), at(2026, 3, 9))).toEqual([]);
  });

  test("daily repeats fill the queried window", () => {
    const e = ev({ id: "d", startAt: at(2026, 3, 9, 9), repeat: "daily" });
    const occ = expandOccurrences(e, at(2026, 3, 9), at(2026, 3, 12));
    expect(occ.map((o) => o.startAt)).toEqual([
      at(2026, 3, 9, 9),
      at(2026, 3, 10, 9),
      at(2026, 3, 11, 9),
    ]);
  });

  test("weekly / monthly / yearly step from the original anchor", () => {
    const w = ev({ id: "w", startAt: at(2026, 3, 9, 9), repeat: "weekly" });
    expect(shiftOccurrence(w.startAt, "weekly", 2)).toBe(at(2026, 3, 23, 9));
    const m = ev({ id: "m", startAt: at(2026, 1, 31, 9), repeat: "monthly" });
    const occ = expandOccurrences(m, at(2026, 2, 1), at(2026, 5, 1));
    // Jan 31 → Feb 28 (clamped) → Mar 31 → Apr 30
    expect(occ.map((o) => o.startAt)).toEqual([
      at(2026, 2, 28, 9),
      at(2026, 3, 31, 9),
      at(2026, 4, 30, 9),
    ]);
    const y = ev({ id: "y", startAt: at(2026, 3, 9, 9), repeat: "yearly" });
    expect(shiftOccurrence(y.startAt, "yearly", 3)).toBe(at(2029, 3, 9, 9));
    expect(shiftOccurrence(y.startAt, "none", 5)).toBe(y.startAt);
  });

  test("a long-running daily repeat fast-forwards to the window (no hang)", () => {
    const old = at(2016, 1, 1, 8);
    const e = ev({ id: "old", startAt: old, repeat: "daily" });
    const occ = expandOccurrences(e, at(2026, 3, 9), at(2026, 3, 10));
    expect(occ.length).toBe(1);
    expect(occ[0]!.startAt).toBe(at(2026, 3, 9, 8));
    // Duration is preserved across occurrences.
    expect(occ[0]!.endAt - occ[0]!.startAt).toBe(3_600_000);
  });

  test("a repeat longer than its period never loses an overlapping occurrence", () => {
    // Regression: the fast-forward threshold used `from` (not `from - duration`)
    // with an *approximate* step, so an occurrence that started before the window
    // but still overlapped it was silently skipped. A 20-day-long weekly event
    // queried over one day must return the three overlapping occurrences.
    const base = at(2026, 1, 1);
    const e = ev({ id: "long", startAt: base, endAt: base + 20 * DAY_MS, repeat: "weekly" });
    const occ = expandOccurrences(e, at(2026, 1, 22), at(2026, 1, 23));
    expect(occ.map((o) => o.startAt)).toEqual([
      at(2026, 1, 8),
      at(2026, 1, 15),
      at(2026, 1, 22),
    ]);
    // Every returned occurrence really overlaps the queried window.
    expect(occ.every((o) => o.startAt < at(2026, 1, 23) && o.endAt > at(2026, 1, 22))).toBe(true);
  });

  test("occurrencesInRange sorts all-day first, then by time (and title)", () => {
    const h = at(2026, 3, 9);
    const events = [
      ev({ id: "late", title: "Z", startAt: h + 15 * 3_600_000, endAt: h + 16 * 3_600_000 }),
      ev({ id: "allday", title: "Holiday", startAt: h, endAt: h + DAY_MS, allDay: true }),
      ev({ id: "early", title: "A", startAt: h + 9 * 3_600_000, endAt: h + 10 * 3_600_000 }),
      ev({ id: "tie", title: "B", startAt: h + 9 * 3_600_000, endAt: h + 10 * 3_600_000 }),
    ];
    expect(occurrencesInRange(events, h, h + DAY_MS).map((o) => o.event.id)).toEqual([
      "allday",
      "early",
      "tie",
      "late",
    ]);
  });

  test("occurrencesOnDay returns the day's schedule; groupByDay buckets by start day", () => {
    const h = at(2026, 3, 9);
    const events = [
      ev({ id: "a", title: "A", startAt: h + 9 * 3_600_000, endAt: h + 10 * 3_600_000 }),
      ev({
        id: "b",
        title: "B",
        startAt: h + DAY_MS + 9 * 3_600_000,
        endAt: h + DAY_MS + 10 * 3_600_000,
      }),
    ];
    expect(occurrencesOnDay(events, h).map((o) => o.event.id)).toEqual(["a"]);
    const buckets = groupByDay(occurrencesInRange(events, h, h + 2 * DAY_MS));
    expect([...buckets.keys()]).toEqual([h, h + DAY_MS]);
    expect(buckets.get(h + DAY_MS)!.length).toBe(1);
  });

  test("sortOccurrences does not mutate the input array", () => {
    const h = at(2026, 3, 9);
    const occ = [
      ev({ id: "2", title: "2", startAt: h + 2 * 3_600_000 }),
      ev({ id: "1", title: "1", startAt: h + 3_600_000 }),
    ].map((e) => ({ event: e, startAt: e.startAt, endAt: e.endAt }));
    const before = occ.map((o) => o.event.id);
    sortOccurrences(occ);
    expect(occ.map((o) => o.event.id)).toEqual(before);
  });

  test("overlapsRange is half-open on both ends", () => {
    expect(overlapsRange(0, 10, 5, 15)).toBe(true);
    expect(overlapsRange(0, 5, 5, 10)).toBe(false); // touching end
    expect(overlapsRange(10, 20, 5, 10)).toBe(false); // touching start
  });
});


describe("calendar — selectors", () => {
  const groups: CalendarGroup[] = [
    { id: DEFAULT_CALENDAR_ID, custom: false, name: "", color: "blue", enabled: true, createdAt: 0 },
    { id: "work", custom: true, name: "Work", color: "indigo", enabled: true, createdAt: 0 },
    { id: "muted", custom: true, name: "Muted", color: "gray", enabled: false, createdAt: 0 },
  ];

  test("visibleEvents hides disabled calendars (orphan ids stay visible)", () => {
    const h = at(2026, 3, 9);
    const events = [
      ev({ id: "p", startAt: h }),
      ev({ id: "w", calendarId: "work", startAt: h }),
      ev({ id: "m", calendarId: "muted", startAt: h }),
      ev({ id: "ghost", calendarId: "gone", startAt: h }),
    ];
    expect(visibleEvents(events, groups).map((e) => e.id)).toEqual(["p", "w", "ghost"]);
    // no hidden calendars → returns a copy, not the same reference
    const shown = visibleEvents(events, [groups[0]!]);
    expect(shown).toEqual(events);
    expect(shown).not.toBe(events);
  });

  test("searchEvents matches title / location / notes, case-insensitively", () => {
    const h = at(2026, 3, 9);
    const events = [
      ev({ id: "t", title: "Standup", startAt: h }),
      ev({ id: "l", title: "Lunch", location: "Cafe Nero", startAt: h }),
      ev({ id: "n", title: "Review", notes: "bring the Standup notes", startAt: h }),
    ];
    expect(searchEvents(events, "  ").length).toBe(3); // blank passes all
    expect(searchEvents(events, "standup").map((e) => e.id)).toEqual(["t", "n"]);
    expect(searchEvents(events, "nero").map((e) => e.id)).toEqual(["l"]);
    expect(searchEvents(events, "zzz")).toEqual([]);
  });

  test("calendarById finds groups, undefined otherwise", () => {
    expect(calendarById(groups, "work")?.name).toBe("Work");
    expect(calendarById(groups, "nope")).toBeUndefined();
  });
});


describe("calendar — CRUD", () => {
  test("addEvent refuses a blank title and assigns id/createdAt", () => {
    const t0 = at(2026, 3, 9);
    const base: CalendarEvent[] = [];
    expect(addEvent(base, { ...newEventDraft(t0), title: "  " }, t0)).toEqual([]);
    const out = addEvent(base, { ...newEventDraft(t0), title: " Standup " }, t0);
    expect(out.length).toBe(1);
    expect(out[0]!.title).toBe("Standup");
    expect(out[0]!.createdAt).toBe(t0);
    expect(out[0]!.id).toBeTruthy();
    expect(base.length).toBe(0); // immutable
  });

  test("addEvent enforces the cap", () => {
    let list: CalendarEvent[] = [];
    for (let i = 0; i < EVENT_CAP + 2; i += 1) {
      list = addEvent(list, { ...newEventDraft(at(2026, 3, 9)), title: `e${i}` }, i + 1);
    }
    expect(list.length).toBe(EVENT_CAP);
    expect(list[list.length - 1]!.title).toBe(`e${EVENT_CAP + 1}`);
  });

  test("updateEvent patches, keeps identity, and re-sanitizes", () => {
    const t0 = at(2026, 3, 9);
    const list = addEvent([], { ...newEventDraft(t0), title: "Old" }, t0);
    const id = list[0]!.id;
    const out = updateEvent(list, id, { title: " New ", repeat: "weekly", alertMinutes: 15 });
    expect(out[0]!.id).toBe(id);
    expect(out[0]!.createdAt).toBe(t0);
    expect(out[0]!.title).toBe("New");
    expect(out[0]!.repeat).toBe("weekly");
    expect(out[0]!.alertMinutes).toBe(15);
    // blank title / unknown id are no-ops (a copy is still returned)
    expect(updateEvent(list, id, { title: "   " })[0]!.title).toBe("Old");
    expect(updateEvent(list, "nope", { title: "x" })).toEqual(list);
  });

  test("updateEvent switching to all-day snaps to midnight and one day long", () => {
    const t0 = at(2026, 3, 9, 14, 30);
    const list = addEvent([], { ...newEventDraft(t0), title: "X" }, t0);
    const out = updateEvent(list, list[0]!.id, { allDay: true });
    expect(out[0]!.startAt).toBe(at(2026, 3, 9));
    expect(out[0]!.endAt).toBe(at(2026, 3, 10));
  });

  test("removeEvent drops exactly one row", () => {
    const t0 = at(2026, 3, 9);
    const list = addEvent(
      addEvent([], { ...newEventDraft(t0), title: "a" }, t0),
      { ...newEventDraft(t0), title: "b" },
      t0 + 1,
    );
    const out = removeEvent(list, list[0]!.id);
    expect(out.map((e) => e.title)).toEqual(["b"]);
    expect(removeEvent(list, "nope").length).toBe(2);
  });

  test("calendar group CRUD protects the built-in default", () => {
    const now = 1000;
    let gs = seedCalendars(now);
    gs = addCalendar(gs, { name: " Travel ", color: "pink" }, now + 5);
    expect(gs.length).toBe(4);
    expect(gs[3]!.name).toBe("Travel");
    expect(addCalendar(gs, { name: "   ", color: "pink" }, now).length).toBe(4);
    gs = toggleCalendar(gs, "work");
    expect(gs.find((g) => g.id === "work")!.enabled).toBe(false);
    gs = toggleCalendar(gs, "work");
    expect(gs.find((g) => g.id === "work")!.enabled).toBe(true);
    gs = removeCalendar(gs, "work");
    expect(gs.find((g) => g.id === "work")).toBeUndefined();
    // the built-in default can never be removed
    expect(removeCalendar(gs, DEFAULT_CALENDAR_ID).length).toBe(gs.length);
  });

  test("reassignOrphans moves events off deleted calendars", () => {
    const h = at(2026, 3, 9);
    const events = [ev({ id: "a", calendarId: "gone", startAt: h }), ev({ id: "b", startAt: h })];
    const known = [seedCalendars(0)[0]!];
    const out = reassignOrphans(events, known);
    expect(out[0]!.calendarId).toBe(DEFAULT_CALENDAR_ID);
    expect(out[1]!.calendarId).toBe(DEFAULT_CALENDAR_ID);
    // when nothing is orphaned, the input is copied and left equal
    const same = reassignOrphans([out[1]!], known);
    expect(same).toEqual([out[1]!]);
  });

  test("makeId is unique within the same millisecond", () => {
    expect(new Set([makeId(5), makeId(5), makeId(5)]).size).toBe(3);
  });

  test("newEventDraft is a 09:00–10:00 one-hour slot on the given day", () => {
    const d = newEventDraft(at(2026, 3, 9, 18, 12));
    expect(d.startAt).toBe(at(2026, 3, 9, 9));
    expect(d.endAt).toBe(at(2026, 3, 9, 10));
    expect(d.allDay).toBe(false);
    expect(d.repeat).toBe("none");
    expect(d.alertMinutes).toBe(0);
    expect(d.calendarId).toBe(DEFAULT_CALENDAR_ID);
  });
});

describe("calendar — seeds + exported tables", () => {
  test("seeds are self-consistent (unique ids, every event in a real calendar)", () => {
    const now = at(2026, 3, 9, 12);
    const gs = seedCalendars(now);
    const es = seedEvents(now);
    const gids = new Set(gs.map((g) => g.id));
    expect(gids.has(DEFAULT_CALENDAR_ID)).toBe(true);
    expect(new Set(es.map((e) => e.id)).size).toBe(es.length);
    for (const e of es) {
      expect(gids.has(e.calendarId)).toBe(true);
      expect(e.endAt).toBeGreaterThan(e.startAt);
    }
    // seeds survive normalization unchanged in row count
    expect(normalizeEvents(es).length).toBe(es.length);
    expect(normalizeCalendars(gs).length).toBe(gs.length);
  });

  test("alert options and palette are bounded and include 'none'", () => {
    expect(ALERT_OPTIONS[0]).toBeNull();
    expect(ALERT_OPTIONS).toContain(0);
    expect(ALERT_OPTIONS).toContain(1440);
    expect(CALENDAR_COLORS.length).toBe(10);
  });
});


describe("calendar — multi-day spans + DST-safe day math", () => {
  test("atLocalTime pins a wall-clock hour on any day", () => {
    const t = atLocalTime(at(2026, 3, 9, 22), 9, 30);
    expect(new Date(t).getHours()).toBe(9);
    expect(new Date(t).getMinutes()).toBe(30);
    expect(toDateInput(t)).toBe("2026-03-09");
  });

  test("countDays counts whole local days (DST-tolerant, sign-aware)", () => {
    expect(countDays(at(2026, 3, 9), at(2026, 3, 12))).toBe(3);
    expect(countDays(at(2026, 3, 12), at(2026, 3, 9))).toBe(-3);
    expect(countDays(at(2026, 3, 9), at(2026, 3, 9, 23, 59))).toBe(0);
    expect(countDays(at(2026, 3, 9, 23, 59), at(2026, 3, 10, 0, 1))).toBe(1);
    // A 23h/25h local day (DST) still counts as exactly one day.
    expect(countDays(at(2026, 3, 28), at(2026, 3, 30))).toBe(2);
  });

  test("shiftByWallClock moves by the same local offset (and is a no-op when equal)", () => {
    const anchor = at(2026, 3, 9, 9);
    // Nothing changed → EXACT identity (editing a title must not drift a series).
    expect(shiftByWallClock(anchor, at(2026, 3, 9, 9), at(2026, 3, 9, 9))).toBe(anchor);
    // Same day, one hour later.
    expect(shiftByWallClock(anchor, at(2026, 3, 9, 9), at(2026, 3, 9, 10))).toBe(at(2026, 3, 9, 10));
    // One day later keeps the wall-clock time.
    expect(shiftByWallClock(anchor, at(2026, 3, 9, 9), at(2026, 3, 10, 9))).toBe(at(2026, 3, 10, 9));
    // Day + time-of-day combined (days are day-arithmetic, not 24h×N).
    expect(shiftByWallClock(anchor, at(2026, 3, 9, 9), at(2026, 3, 11, 10, 30))).toBe(
      at(2026, 3, 11, 10, 30),
    );
    // Month-end day arithmetic: Jan 31 anchor moved by the Jan 31 → Feb 28 delta.
    expect(shiftByWallClock(at(2026, 1, 31, 9), at(2026, 1, 31, 9), at(2026, 2, 28, 9))).toBe(
      at(2026, 2, 28, 9),
    );
    // A negative offset (moving an occurrence earlier) works too.
    expect(shiftByWallClock(anchor, at(2026, 3, 9, 9), at(2026, 3, 8, 8))).toBe(at(2026, 3, 8, 8));
  });

  test("allDayEnd is idempotent, multi-day capable, and collapses bad input", () => {
    const d1 = at(2026, 3, 9);
    expect(allDayEnd(d1, 0)).toBe(at(2026, 3, 10)); // missing end → one day
    expect(allDayEnd(d1, at(2026, 3, 12))).toBe(at(2026, 3, 12)); // exclusive kept
    expect(allDayEnd(d1, at(2026, 3, 11, 23, 59))).toBe(at(2026, 3, 12)); // inclusive snapped
    expect(allDayEnd(d1, at(2026, 3, 5))).toBe(at(2026, 3, 10)); // earlier → one day
    const once = allDayEnd(d1, at(2026, 3, 12));
    expect(allDayEnd(d1, once)).toBe(once); // idempotent
  });

  test("normalizeEvents preserves a multi-day all-day span and is idempotent", () => {
    const src = [
      { id: "v", title: "年假", allDay: true, startAt: at(2026, 3, 9), endAt: at(2026, 3, 12) },
    ];
    const once = normalizeEvents(src);
    expect(once[0]!.startAt).toBe(at(2026, 3, 9));
    expect(once[0]!.endAt).toBe(at(2026, 3, 12));
    expect(normalizeEvents(JSON.parse(JSON.stringify(once)))).toEqual(once);
    // an inclusive (non-midnight) persisted end snaps up to the next midnight
    const snapped = normalizeEvents([
      { id: "s", title: "x", allDay: true, startAt: at(2026, 3, 9), endAt: at(2026, 3, 11, 9) },
    ]);
    expect(snapped[0]!.endAt).toBe(at(2026, 3, 12));
  });

  test("sanitizing an all-day draft keeps a span, an earlier end collapses to one day", () => {
    const d1 = at(2026, 3, 9);
    const draft = {
      calendarId: DEFAULT_CALENDAR_ID,
      title: "假",
      allDay: true,
      repeat: "none" as const,
      alertMinutes: null,
    };
    const kept = addEvent([], { ...draft, startAt: d1, endAt: at(2026, 3, 12) }, 1);
    expect(kept[0]!.endAt).toBe(at(2026, 3, 12));
    const collapsed = addEvent([], { ...draft, startAt: d1, endAt: at(2026, 3, 5) }, 1);
    expect(collapsed[0]!.endAt).toBe(at(2026, 3, 10));
    // switching a timed event to all-day keeps exactly one whole day
    const timed = addEvent(
      [],
      { ...draft, allDay: false, startAt: at(2026, 3, 9, 14), endAt: at(2026, 3, 9, 15) },
      1,
    );
    const flipped = updateEvent(timed, timed[0]!.id, { allDay: true });
    expect(flipped[0]!.startAt).toBe(at(2026, 3, 9));
    expect(flipped[0]!.endAt).toBe(at(2026, 3, 10));
  });

  test("the local day window is a whole local day (not 24h of raw ms)", () => {
    // True in ANY timezone: on DST days the window is 23h/25h, never a shifted
    // 01:00 boundary — which raw `+ DAY_MS` arithmetic would produce.
    for (const day of [at(2026, 3, 9), at(2026, 3, 29), at(2026, 10, 25), at(2026, 11, 2)]) {
      const next = addDays(startOfDay(day), 1);
      expect(new Date(next).getHours()).toBe(0);
      expect(new Date(next).getMinutes()).toBe(0);
      expect(toDateInput(next)).not.toBe(toDateInput(day));
    }
    const e = ev({
      id: "ad",
      title: "Holiday",
      startAt: at(2026, 3, 29),
      endAt: addDays(at(2026, 3, 29), 1),
      allDay: true,
    });
    expect(occurrencesOnDay([e], at(2026, 3, 29)).length).toBe(1);
    expect(occurrencesOnDay([e], at(2026, 3, 30)).length).toBe(0);
  });

  test("a multi-day event appears on every day it covers, never outside", () => {
    const e = ev({
      id: "v",
      title: "年假",
      startAt: at(2026, 3, 9),
      endAt: at(2026, 3, 12),
      allDay: true,
    });
    for (const d of [9, 10, 11]) {
      expect(occurrencesOnDay([e], at(2026, 3, d)).length).toBe(1);
    }
    expect(occurrencesOnDay([e], at(2026, 3, 12)).length).toBe(0); // exclusive end
    expect(occurrencesOnDay([e], at(2026, 3, 8)).length).toBe(0);
  });
});


describe("calendar — multi-day day bucketing + continuation", () => {
  test("a multi-day TIMED event shows on both days", () => {
    const e = ev({ id: "t", title: "跨夜", startAt: at(2026, 3, 9, 22), endAt: at(2026, 3, 10, 6) });
    expect(occurrencesOnDay([e], at(2026, 3, 9)).length).toBe(1);
    expect(occurrencesOnDay([e], at(2026, 3, 10)).length).toBe(1);
    expect(occurrencesOnDay([e], at(2026, 3, 11)).length).toBe(0);
  });

  test("occurrencesByDay marks dots on every covered day, clipped to the window", () => {
    const span = {
      event: ev({ id: "v", title: "年假", startAt: at(2026, 3, 9), endAt: at(2026, 3, 12), allDay: true }),
      startAt: at(2026, 3, 9),
      endAt: at(2026, 3, 12),
    };
    const one = {
      event: ev({ id: "o", title: "O", startAt: at(2026, 3, 10, 9), endAt: at(2026, 3, 10, 10) }),
      startAt: at(2026, 3, 10, 9),
      endAt: at(2026, 3, 10, 10),
    };
    const map = occurrencesByDay([span, one], at(2026, 3, 1), at(2026, 4, 1));
    expect([...map.keys()]).toEqual([at(2026, 3, 9), at(2026, 3, 10), at(2026, 3, 11)]);
    expect(map.get(at(2026, 3, 10))!.map((o) => o.event.id)).toEqual(["v", "o"]);
    // clipped: a span that began earlier still marks the window's first day
    expect([...occurrencesByDay([span], at(2026, 3, 10), at(2026, 3, 11)).keys()]).toEqual([
      at(2026, 3, 10),
    ]);
    // degenerate window → empty (no unbounded walk)
    expect(occurrencesByDay([span], at(2026, 3, 1), at(2026, 3, 1)).size).toBe(0);
  });

  test("isContinuation / spansDays describe multi-day occurrences", () => {
    const span = {
      event: ev({ id: "v", title: "年假", startAt: at(2026, 3, 9), endAt: at(2026, 3, 12), allDay: true }),
      startAt: at(2026, 3, 9),
      endAt: at(2026, 3, 12),
    };
    expect(spansDays(span)).toBe(true);
    expect(isContinuation(span, at(2026, 3, 9, 15))).toBe(false);
    expect(isContinuation(span, at(2026, 3, 10))).toBe(true);
    const single = {
      event: ev({ id: "o", title: "O", startAt: at(2026, 3, 9, 9) }),
      startAt: at(2026, 3, 9, 9),
      endAt: at(2026, 3, 9, 10),
    };
    expect(spansDays(single)).toBe(false);
    expect(isContinuation(single, at(2026, 3, 9, 23))).toBe(false);
  });

  test("seeds include a genuine multi-day all-day span", () => {
    const es = seedEvents(at(2026, 3, 9, 12));
    const spans = es.filter(
      (e) => e.allDay && spansDays({ event: e, startAt: e.startAt, endAt: e.endAt }),
    );
    expect(spans.length).toBeGreaterThanOrEqual(1);
    expect(normalizeEvents(es).length).toBe(es.length); // survives normalization
  });
});

/**
 * Independent verification of the recurrence kernel.
 *
 * The range query fast-forwards and caps itself for boundedness; that
 * optimisation is exactly the kind of code that can silently *skip* valid
 * occurrences. This suite cross-checks it against a deliberately naive, obvious
 * reference (enumerate every `k`, no fast-forward, no cap) over a fixed-seed
 * PRNG, so the comparison is deterministic and reproducible rather than a
 * one-off audit script. A fixed seed means a regression shows up as the same
 * failing case on every machine.
 */
describe("calendar — recurrence vs. an independent brute-force reference", () => {
  /** Deterministic LCG — reproducible cases, no flakiness. */
  const mkRnd = (seed: number) => () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  /** The slow, obvious way: enumerate k, no fast-forward, no occurrence cap. */
  const brute = (e: CalendarEvent, from: number, to: number): Array<[number, number]> => {
    if (!(to > from)) return [];
    const dur = Math.max(0, e.endAt - e.startAt);
    if (e.repeat === "none") {
      return e.startAt < to && e.endAt > from ? [[e.startAt, e.endAt]] : [];
    }
    const out: Array<[number, number]> = [];
    // The cases below keep `from` within 400 days of the anchor and the window
    // within 600 days, so a daily repeat needs at most ~1000 steps; 5000 leaves
    // generous head-room while still being a finite, exhaustive enumeration.
    for (let k = 0; k < 5000; k += 1) {
      const s = shiftOccurrence(e.startAt, e.repeat, k);
      if (s >= to) break;
      if (s + dur > from) out.push([s, s + dur]);
    }
    return out;
  };

  test("expandOccurrences equals brute force over 2000 random events/ranges", () => {
    const rnd = mkRnd(123_456_789);
    const repeats: Repeat[] = ["none", "daily", "weekly", "monthly", "yearly"];
    for (let i = 0; i < 2000; i += 1) {
      const base = at(
        2000 + Math.floor(rnd() * 40),
        1 + Math.floor(rnd() * 12),
        1 + Math.floor(rnd() * 28),
        Math.floor(rnd() * 24),
        Math.floor(rnd() * 60),
      );
      const e = ev({
        id: `p${i}`,
        startAt: base,
        endAt: base + Math.max(60_000, Math.floor(rnd() * 40) * DAY_MS + Math.floor(rnd() * DAY_MS)),
        repeat: repeats[Math.floor(rnd() * repeats.length)]!,
      });
      // Anchor the query 0–400 days after the event's start so the naive
      // reference stays cheap; the far-future fast-forward bound is covered by
      // the dedicated "a repeat longer than its period…" regression test.
      const from = addDays(base, Math.floor(rnd() * 400));
      const to = addDays(from, Math.floor(rnd() * 600));
      const got = expandOccurrences(e, from, to).map((o) => [o.startAt, o.endAt] as [number, number]);
      expect(got).toEqual(brute(e, from, to));
    }
  });
});

