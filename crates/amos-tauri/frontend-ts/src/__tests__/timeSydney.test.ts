// bun-iso-tz: Australia/Sydney
/**
 * The **southern hemisphere** rule (REQ-A343): DST starts in *October* and ends in *April*, the
 * mirror image of the northern cases. Its own file/process for the same reason as `timeLordHowe`.
 */
import { describe, expect, test } from "bun:test";
import { nextAlarmAtMs } from "../lib/time";

describe("wall-clock day arithmetic (DST, Australia/Sydney)", () => {
  test("the zone really is Sydney (otherwise the case below would be vacuous)", () => {
    expect(new Date(2026, 0, 15).getTimezoneOffset()).toBe(-660); // AEDT (+11) in January
    expect(new Date(2026, 6, 15).getTimezoneOffset()).toBe(-600); // AEST (+10) in July
  });

  test("a daily alarm crossing the October transition rings on time", () => {
    const now = new Date(2026, 9, 3, 20, 0, 0, 0).getTime(); // 2026-10-03 20:00, DST starts 10-04
    const d = new Date(nextAlarmAtMs({ hour: 7, min: 0, repeat: [] }, now)!);
    expect([d.getMonth() + 1, d.getDate(), d.getHours()]).toEqual([10, 4, 7]);
  });
});
