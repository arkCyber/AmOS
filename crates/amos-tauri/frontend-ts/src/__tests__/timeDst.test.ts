// bun-iso-tz: America/New_York
/**
 * Wall-clock day arithmetic (REQ-A343) — **DST must not move a clock reading**.
 *
 * The zone comes from the **process** (`bun-iso-test.mjs` reads the `bun-iso-tz:` marker above and
 * runs this file in its own process with `TZ` set). That is deliberate: a single process cannot
 * reliably switch zones for instants built afterwards, so switching `process.env.TZ` inside the file
 * made the southern-hemisphere case depend on which zone ran last — measured, not guessed. One file,
 * one zone, one process; `time-lordhowe` / `time-sydney` carry their own markers.
 *
 * The cases also assert what the **naive** form produces (`+ 86_400_000` ⇒ 08:00 / 06:00), which is
 * what makes them discriminating rather than decorative — the old alarm tests never crossed a
 * transition and were byte-equivalent before and after the fix.
 */
import { describe, expect, test } from "bun:test";
import { addLocalDays, nextAlarmAtMs } from "../lib/time";
import { dayStamp } from "../lib/messages";

describe("wall-clock day arithmetic (DST, America/New_York)", () => {
  test("the zone really is New York (otherwise these cases would be vacuous)", () => {
    expect(new Date(2026, 0, 15).getTimezoneOffset()).toBe(300); // EST
    expect(new Date(2026, 6, 15).getTimezoneOffset()).toBe(240); // EDT
  });

  const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0);
  const hhmm = (ms: number) => {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };

  test("addLocalDays keeps the wall clock across spring-forward and fall-back", () => {
    const beforeSpring = at(2026, 3, 7, 7); // 07:00 EST, DST starts 03-08
    expect(hhmm(addLocalDays(beforeSpring.getTime(), 1))).toBe("07:00");
    expect(hhmm(beforeSpring.getTime() + 86_400_000)).toBe("08:00"); // what the bug did
    const beforeFall = at(2026, 10, 31, 7); // 07:00 EDT, DST ends 11-01
    expect(hhmm(addLocalDays(beforeFall.getTime(), 1))).toBe("07:00");
    expect(hhmm(beforeFall.getTime() + 86_400_000)).toBe("06:00");
  });

  test("a daily alarm crossing spring-forward still rings at its own HH:MM", () => {
    const now = at(2026, 3, 8, 0, 30).getTime();
    const next = nextAlarmAtMs({ hour: 7, min: 0, repeat: [] }, now)!;
    const d = new Date(next);
    expect([d.getMonth() + 1, d.getDate(), d.getHours()]).toEqual([3, 8, 7]);
    expect(hhmm(next)).toBe("07:00"); // the value handed to the native wake-up scheduler
  });

  test("a weekday alarm whose next occurrence is days away crosses the transition correctly", () => {
    const now = at(2026, 3, 6, 9).getTime(); // Friday; a Monday-only alarm
    const d = new Date(nextAlarmAtMs({ hour: 7, min: 0, repeat: [1] }, now)!);
    // Measured under the naive step this is Mon 03-09 **08:00** (the drift adds an hour per step).
    expect([d.getMonth() + 1, d.getDate(), d.getHours(), d.getDay()]).toEqual([3, 9, 7, 1]);
  });

  test("a daily alarm crossing fall-back still rings at its own HH:MM", () => {
    const now = at(2026, 11, 1, 0, 30).getTime(); // 01:00–02:00 repeats tonight
    const d = new Date(nextAlarmAtMs({ hour: 7, min: 0, repeat: [] }, now)!);
    expect([d.getMonth() + 1, d.getDate(), d.getHours()]).toEqual([11, 1, 7]);
  });

  test('the labels that answer "yesterday" follow the calendar, not 24 h', () => {
    // The discriminating instant is **late on the fall-back day**: 24 h earlier is still 11-01 in
    // local time, so the naive subtraction answers "today" while the calendar step answers 10-31.
    // (Measured: naive `2026-11-01` vs `addLocalDays` `2026-10-31`.) An earlier draft used
    // 03-08 00:30, which does **not** discriminate — the spring-forward gap has not happened yet.
    const now = at(2026, 11, 1, 23, 30).getTime();
    const yesterday = at(2026, 10, 31, 12).getTime();
    expect(dayStamp(addLocalDays(now, -1))).toBe(dayStamp(yesterday));
    expect(dayStamp(now - 86_400_000)).not.toBe(dayStamp(yesterday));
    expect(dayStamp(now - 86_400_000)).toBe(dayStamp(now)); // …it says "today"
  });
});
