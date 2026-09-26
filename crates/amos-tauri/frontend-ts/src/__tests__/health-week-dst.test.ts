// bun-iso-tz: America/New_York
/**
 * The Health screen's last-7-days strip across a DST fall-back (REQ-A1461).
 *
 * `week` used to be built with a fixed 24-hour step (`nowMs - i * 86_400_000`) while its rows
 * are keyed by `dayKey` — a **local calendar** day. A day is not always 24 hours: on 2026-11-01
 * (25 h long in New York, 02:00 EDT → 01:00 EST) 24 h before late 11-02 is *still 11-01*, so the
 * strip came back with that day twice. Two consequences, both pinned here: the `{#each week as
 * w (w.day)}` block in `HealthApp.svelte` is **keyed by `day`** (duplicate keys), and the weekly
 * total (`week.reduce`) counted that day twice.
 *
 * `lib/time.ts::addLocalDays` is the one helper for calendar stepping and names its callers
 * (REQ-A343); the strip was the one caller that hand-rolled the subtraction. The zone comes from
 * the process (`bun-iso-test.mjs` reads the marker above), so the second case can measure what
 * the naive form actually produced instead of describing it.
 */
import { describe, expect, test } from "bun:test";
import { dayKey, recentDays, type HealthState } from "../lib/health";

/** Local wall-clock instant, so the cases read as the user's clock. */
const at = (y: number, mo: number, d: number, h: number, mi = 0) =>
  new Date(y, mo - 1, d, h, mi, 0, 0).getTime();

/** Late on the day **after** the fall-back: the instant that discriminates the two forms. */
const AFTER_FALL_BACK = () => at(2026, 11, 2, 23, 30);

const state = (days: HealthState["days"]): HealthState => ({ days, workouts: [] });

describe("health · the 7-day strip steps local calendar days (DST, America/New_York)", () => {
  test("the zone really is New York (otherwise these cases would be vacuous)", () => {
    expect(new Date(2026, 0, 15).getTimezoneOffset()).toBe(300); // EST
    expect(new Date(2026, 6, 15).getTimezoneOffset()).toBe(240); // EDT
  });

  test("a 25-hour day appears once, and the strip covers seven distinct days", () => {
    const week = recentDays(state([]), AFTER_FALL_BACK());
    expect(week.map((w) => w.day)).toEqual([
      "2026-10-27",
      "2026-10-28",
      "2026-10-29",
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
    ]);
    // The keyed `{#each}` needs these to be distinct (and the total to count each day once).
    expect(new Set(week.map((w) => w.day)).size).toBe(7);
  });

  test("the fixed-24h form is what duplicated the day (the negative control)", () => {
    const now = AFTER_FALL_BACK();
    const naive = Array.from({ length: 7 }, (_, k) => dayKey(now - k * 86_400_000));
    // 24 h before late 11-02 is still 11-01, so the day is listed twice and 10-27 is missing.
    expect(naive.filter((d) => d === "2026-11-01")).toHaveLength(2);
    expect(new Set(naive).size).toBe(6);
    expect(naive).not.toContain("2026-10-27");
  });

  test("the weekday label follows the stepped day", () => {
    // 2026-11-01 is a Sunday; a fixed-hour drift would have mislabelled the rows.
    expect(recentDays(state([]), AFTER_FALL_BACK()).map((w) => w.dow)).toEqual([2, 3, 4, 5, 6, 0, 1]);
  });

  test("steps are read off the day the row names, so the weekly total counts each day once", () => {
    const week = recentDays(
      state([
        { day: "2026-11-01", steps: 5000, steps_recorded: true, hr_min: null, hr_max: null },
        { day: "2026-10-31", steps: 1000, steps_recorded: true, hr_min: null, hr_max: null },
      ]),
      AFTER_FALL_BACK(),
    );
    const total = week.reduce((a, w) => a + w.steps, 0);
    expect(total).toBe(6000); // not 11-01 twice (10000) and not 11-01 dropped (1000)
    expect(week.find((w) => w.day === "2026-11-01")?.steps).toBe(5000);
  });

  test("a day with no row is a zero bar, never a missing one", () => {
    const week = recentDays(state([]), AFTER_FALL_BACK());
    expect(week).toHaveLength(7);
    expect(week.every((w) => w.steps === 0)).toBe(true);
  });
});
