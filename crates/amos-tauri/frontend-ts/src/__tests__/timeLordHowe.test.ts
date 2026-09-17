// bun-iso-tz: Australia/Lord_Howe
/**
 * A DST rule that shifts by **30 minutes** (REQ-A343). Its own file, because the zone comes from the
 * process (`bun-iso-test.mjs` honours the `bun-iso-tz:` marker) — one file, one zone, one process.
 *
 * Measured here (never guessed): on 2026-04-05 the clock goes back 30 minutes, so a fixed
 * `+ 86_400_000` lands on 06:30 while the calendar step keeps 07:00.
 */
import { describe, expect, test } from "bun:test";
import { addLocalDays } from "../lib/time";

describe("wall-clock day arithmetic (DST, Australia/Lord_Howe)", () => {
  const hhmm = (ms: number) => {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };

  test("the zone really is Lord Howe (otherwise the case below would be vacuous)", () => {
    expect(new Date(2026, 0, 15).getTimezoneOffset()).toBe(-660); // +11:00
    expect(new Date(2026, 6, 15).getTimezoneOffset()).toBe(-630); // +10:30
  });

  test("a 30-minute DST shift still keeps the wall clock across a calendar day", () => {
    const n = new Date(2026, 3, 4, 7, 0, 0, 0).getTime(); // 07:00, transition is 2026-04-05
    expect(hhmm(addLocalDays(n, 1))).toBe("07:00");
    expect(hhmm(n + 86_400_000)).not.toBe("07:00"); // the naive form drifts 30 minutes
  });
});
