import { describe, expect, test } from "bun:test";
import { batteryPercent, fmtClock, zoneClock, stopwatchReducer, stopwatchInit, fmtStopwatch, timerReducer, timerInit, fmtCountdown, alarmsReducer, alarmInit, ringingAlarms, alarmKey, dayAllowed, normalizeAlarms, normalizeWorldCities, removeWorldCity, addWorldCity, WORLD_CITY_PRESETS, WORLD_CITY_MAX, defaultWorldCities, lapDeltas, fastestLap, type Alarm } from "../lib/time";

describe("time / status bar", () => {
  test("fmtClock pads hours/minutes", () => {
    expect(fmtClock(new Date(2024, 0, 1, 9, 5))).toBe("09:05");
    expect(fmtClock(new Date(2024, 0, 1, 23, 59))).toBe("23:59");
  });

  test("zoneClock renders wall-clock time in IANA zones", () => {
    const utc = new Date("2024-01-01T00:00:00Z"); // midnight UTC
    expect(zoneClock(utc, "Asia/Shanghai")).toBe("08:00");
    expect(zoneClock(utc, "Europe/London")).toBe("00:00"); // GMT in January
    expect(zoneClock(utc, "America/New_York")).toBe("19:00"); // EST, previous evening
  });

  test("zoneClock falls back to local time on an invalid zone (no throw)", () => {
    const d = new Date(2024, 0, 1, 9, 5);
    expect(zoneClock(d, "Not/AZone")).toBe(fmtClock(d));
  });

  test("zoneClock reuses the cached formatter across repeated calls", () => {
    const d1 = new Date("2024-01-01T00:00:00Z");
    const d2 = new Date("2024-01-01T00:05:00Z"); // five minutes later
    // warm the cache once, then confirm second call (cache-hit path) is stable
    expect(zoneClock(d1, "Asia/Tokyo")).toBe("09:00");
    expect(zoneClock(d2, "Asia/Tokyo")).toBe("09:05");
    expect(zoneClock(d1, "Asia/Tokyo")).toBe("09:00"); // repeats stay correct
  });

  test("batteryPercent counts down with the seconds", () => {
    expect(batteryPercent(new Date(2024, 0, 1, 0, 0, 0))).toBe(100);
    expect(batteryPercent(new Date(2024, 0, 1, 0, 0, 30))).toBe(70);
  });

  test("stopwatch reducer runs/pauses/resets and formats time", () => {
    const s0 = stopwatchInit();
    // start at t=1000, tick at 1500 → elapsed 500
    let s = stopwatchReducer(s0, { type: "start", now: 1000 });
    s = stopwatchReducer(s, { type: "tick", now: 1500 });
    expect(s.running).toBe(true);
    expect(s.elapsedMs).toBe(500);
    // pause freezes elapsed
    s = stopwatchReducer(s, { type: "pause", now: 2200 });
    expect(s.running).toBe(false);
    expect(s.elapsedMs).toBe(1200);
    // resume keeps counting from the paused value
    s = stopwatchReducer(s, { type: "start", now: 3000 });
    s = stopwatchReducer(s, { type: "tick", now: 3400 });
    expect(s.elapsedMs).toBe(1600); // 1200 + 400
    // reset clears
    expect(stopwatchReducer(s, { type: "reset" })).toEqual(stopwatchInit());

    expect(fmtStopwatch(0)).toBe("00:00.00");
    expect(fmtStopwatch(65_430)).toBe("01:05.43");
    expect(fmtStopwatch(-5)).toBe("00:00.00"); // guarded non-negative
  });

  test("timer reducer counts down, pauses, finishes and restarts", () => {
    const s0 = timerReducer(timerInit(), { type: "set", totalMs: 90_000 }); // 1:30
    expect(s0.remainingMs).toBe(90_000);
    // start at t=1000, one second later → 89s left
    let s = timerReducer(s0, { type: "start", now: 1000 });
    s = timerReducer(s, { type: "tick", now: 2000 });
    expect(s.running).toBe(true);
    expect(s.remainingMs).toBe(89_000);
    // pause freezes remaining
    s = timerReducer(s, { type: "pause", now: 3500 });
    expect(s.running).toBe(false);
    expect(s.remainingMs).toBe(87_500);
    // resume keeps counting from where it paused
    s = timerReducer(s, { type: "start", now: 5000 });
    s = timerReducer(s, { type: "tick", now: 6000 });
    expect(s.remainingMs).toBe(86_500); // 87500 − 1000
    // running past the deadline finishes (auto-stops at 0)
    s = timerReducer(s, { type: "tick", now: 200_000 });
    expect(s.running).toBe(false);
    expect(s.remainingMs).toBe(0);
    // reset restores the chosen duration; start restarts a finished timer too
    expect(timerReducer(s, { type: "reset" }).remainingMs).toBe(90_000);
    const restarted = timerReducer(s, { type: "start", now: 0 });
    expect(restarted.running).toBe(true);
    expect(restarted.remainingMs).toBe(90_000);

    expect(fmtCountdown(0)).toBe("00:00");
    expect(fmtCountdown(90_000)).toBe("01:30");
    expect(fmtCountdown(59_000)).toBe("00:59");
    expect(fmtCountdown(-100)).toBe("00:00"); // guarded non-negative
  });

  test("alarms ring at their minute, respect dismiss/toggle, and remove", () => {
    const at = (h: number, m: number) => new Date(2024, 0, 1, h, m, 0);
    let s = alarmInit();
    s = alarmsReducer(s, { type: "add", hour: 8, min: 30, label: "起床" });
    const id = s.list[0]!.id;

    s = alarmsReducer(s, { type: "tick", now: at(8, 29) }); // before the minute
    expect(ringingAlarms(s)).toEqual([]);

    s = alarmsReducer(s, { type: "tick", now: at(8, 30) }); // minute arrives → rings
    expect(ringingAlarms(s).map((a) => a.id)).toEqual([id]);

    s = alarmsReducer(s, { type: "tick", now: at(8, 30) }); // same minute: idempotent
    expect(ringingAlarms(s).length).toBe(1);

    s = alarmsReducer(s, { type: "dismiss", id });
    expect(ringingAlarms(s)).toEqual([]);

    s = alarmsReducer(s, { type: "toggle", id }); // switch off → no future rings
    s = alarmsReducer(s, { type: "tick", now: at(8, 30) });
    expect(ringingAlarms(s)).toEqual([]);

    expect(alarmKey(at(8, 5))).toBe("08:05");
    s = alarmsReducer(s, { type: "remove", id });
    expect(s.list).toEqual([]);
  });

  test("dismiss stays dismissed for the rest of the same minute (no re-ring)", () => {
    const at = (h: number, m: number) => new Date(2024, 0, 1, h, m, 0);
    let s = alarmInit();
    s = alarmsReducer(s, { type: "add", hour: 9, min: 0, label: "" });
    const id = s.list[0]!.id;
    s = alarmsReducer(s, { type: "tick", now: at(8, 59) }); // 08:59 no ring, latch
    s = alarmsReducer(s, { type: "tick", now: at(9, 0) }); // minute arrives → ring
    expect(ringingAlarms(s).length).toBe(1);
    s = alarmsReducer(s, { type: "dismiss", id }); // user closes it now
    expect(ringingAlarms(s)).toEqual([]);
    // The very next tick in the SAME minute must NOT re-ring it (regression).
    s = alarmsReducer(s, { type: "tick", now: at(9, 0) });
    expect(ringingAlarms(s)).toEqual([]);
  });

  test("snooze stops the ring and re-arms five minutes later", () => {
    const at = (h: number, m: number) => new Date(2024, 0, 1, h, m, 0);
    let s = alarmInit();
    s = alarmsReducer(s, { type: "add", hour: 9, min: 30, label: "" });
    const id = s.list[0]!.id;
    s = alarmsReducer(s, { type: "tick", now: at(9, 29) }); // latch 09:29
    s = alarmsReducer(s, { type: "tick", now: at(9, 30) }); // rings
    expect(ringingAlarms(s).length).toBe(1);

    s = alarmsReducer(s, { type: "snooze", id, now: at(9, 30) }); // snooze to 09:35
    expect(ringingAlarms(s)).toEqual([]); // silenced
    expect(s.list[0]).toMatchObject({ hour: 9, min: 35, enabled: true });

    // same minute does not re-fire…
    s = alarmsReducer(s, { type: "tick", now: at(9, 30) });
    expect(ringingAlarms(s)).toEqual([]);
    // …but 09:35 arrives → rings again
    s = alarmsReducer(s, { type: "tick", now: at(9, 35) });
    expect(ringingAlarms(s).length).toBe(1);
  });

  test("repeat days gate ringing: weekday alarm skips Sunday", () => {
    const dt = (day: number, h: number, m: number) => new Date(2024, 0, day, h, m, 0);
    // 2024-01-01 is a Monday (getDay 1); 2024-01-07 is Sunday (0).
    const wk: Alarm = { id: "w", hour: 8, min: 30, label: "", enabled: true, ringing: false, repeat: [1, 2, 3, 4, 5] };
    expect(dayAllowed(wk, dt(1, 0, 0))).toBe(true); // Monday
    expect(dayAllowed(wk, dt(7, 0, 0))).toBe(false); // Sunday
    const daily: Alarm = { id: "d", hour: 8, min: 30, label: "", enabled: true, ringing: false };
    expect(dayAllowed(daily, dt(7, 0, 0))).toBe(true); // no repeat → any day

    let s = alarmInit();
    s = alarmsReducer(s, { type: "add", hour: 8, min: 30, label: "", repeat: [1, 2, 3, 4, 5] });
    const id = s.list[0]!.id;
    // Monday 08:30 rings
    s = alarmsReducer(s, { type: "tick", now: dt(1, 8, 29) });
    s = alarmsReducer(s, { type: "tick", now: dt(1, 8, 30) });
    expect(ringingAlarms(s).length).toBe(1);
    s = alarmsReducer(s, { type: "dismiss", id });
    // Sunday 08:30 does not ring (not in the repeat set)
    s = alarmsReducer(s, { type: "tick", now: dt(7, 8, 28) });
    s = alarmsReducer(s, { type: "tick", now: dt(7, 8, 30) });
    expect(ringingAlarms(s)).toEqual([]);
  });

  test("tone cycles through the ringtone list and wraps", () => {
    let s = alarmInit();
    s = alarmsReducer(s, { type: "add", hour: 7, min: 0, label: "", repeat: [1] });
    const id = s.list[0]!.id;
    expect(s.list[0]!.tone).toBe("🔔"); // default tone on creation
    s = alarmsReducer(s, { type: "tone", id });
    expect(s.list[0]!.tone).toBe("⏰");
    s = alarmsReducer(s, { type: "tone", id });
    s = alarmsReducer(s, { type: "tone", id });
    expect(s.list[0]!.tone).toBe("🎶"); // third step lands on the last tone
    s = alarmsReducer(s, { type: "tone", id });
    expect(s.list[0]!.tone).toBe("🔔"); // wraps back to the default
  });

  test("normalizeAlarms drops garbage, clamps times, dedups, keeps repeat/tone", () => {
    const corrupt: unknown = [
      { id: "a", hour: 25, min: -5, enabled: true, tone: "⏰", repeat: [0, 1, 99, 1, -1] },
      { id: "a", hour: 8, min: 30 }, // dup id → dropped
      { id: "b" }, // missing time → dropped
      { id: "c", hour: 9, min: 15, enabled: false },
      null,
    ];
    const out = normalizeAlarms(corrupt);
    expect(out.length).toBe(2);
    expect(out[0]).toMatchObject({ id: "a", hour: 23, min: 0, enabled: true, tone: "⏰", repeat: [0, 1] });
    expect(out[0]!.ringing).toBe(false); // never restored ringing
    expect(out[1]).toMatchObject({ id: "c", hour: 9, min: 15, enabled: false });
    expect(out[1]!.tone).toBe("🔔"); // invalid tone → default
    expect(normalizeAlarms(null)).toEqual([]);
  });

  test("stopwatch/timer are resilient to clock skew and extreme ranges", () => {
    // stopwatch: start at t=1000, then clock steps backward → tick stays ≥0
    let s = stopwatchReducer(stopwatchInit(), { type: "start", now: 1000 });
    s = stopwatchReducer(s, { type: "tick", now: 900 });
    expect(s.elapsedMs).toBe(0); // never negative
    s = stopwatchReducer(s, { type: "pause", now: 700 });
    expect(s.elapsedMs).toBe(0);
    // huge forward jump still yields a sane, finite formatted string
    s = stopwatchReducer(stopwatchInit(), { type: "start", now: 0 });
    s = stopwatchReducer(s, { type: "tick", now: 1e12 });
    expect(Number.isFinite(s.elapsedMs)).toBe(true);
    expect(s.elapsedMs).toBeGreaterThanOrEqual(0);
    const str = fmtStopwatch(s.elapsedMs);
    expect(str.includes("NaN")).toBe(false);

    // timer: huge duration + far-future deadline auto-finishes at 0, not negative
    let t = timerReducer(timerInit(), { type: "set", totalMs: Number.MAX_SAFE_INTEGER });
    t = timerReducer(t, { type: "start", now: 1000 });
    t = timerReducer(t, { type: "tick", now: 1e300 });
    expect(t.running).toBe(false);
    expect(t.remainingMs).toBe(0);
    // fmtCountdown is finite and mm:ss-shaped even for huge inputs
    expect(fmtCountdown(Number.MAX_SAFE_INTEGER)).toMatch(/^\d+:\d{2}$/);
  });

  test("world clock: default four, add (dedupe/cap), remove, and sanitize garbage", () => {
    const def = defaultWorldCities();
    expect(def.map((c) => c.zone)).toEqual([
      "Asia/Shanghai",
      "Asia/Tokyo",
      "Europe/London",
      "America/New_York",
    ]);
    // add a new city
    const sydney = WORLD_CITY_PRESETS.find((c) => c.zone === "Australia/Sydney")!;
    const five = addWorldCity(def, sydney);
    expect(five.length).toBe(5);
    expect(five[4]!.zone).toBe("Australia/Sydney");
    // add existing -> same list (no-op)
    expect(addWorldCity(five, sydney)).toBe(five);
    // push past cap drops the oldest
    const other = { zone: "X", labelKey: "x" };
    const capped = addWorldCity(five, other); // 6
    expect(capped.length).toBe(WORLD_CITY_MAX);
    expect(addWorldCity(capped, other)).toBe(capped); // dup at cap -> no-op
    // remove
    expect(removeWorldCity(five, "Asia/Tokyo").map((c) => c.zone)).not.toContain("Asia/Tokyo");
    // sanitize persisted garbage
    expect(normalizeWorldCities([{ zone: "Mars/Olympus" }, 3, null, { zone: "Asia/Tokyo" }, { zone: "Asia/Tokyo" }])).toEqual([
      { zone: "Asia/Tokyo", labelKey: "clock.city.tokyo" },
    ]);
    expect(normalizeWorldCities("nope")).toEqual(def); // invalid -> fallback
    expect(normalizeWorldCities([])).toEqual(def); // empty -> fallback
  });

  test("lapDeltas / fastestLap compute per-lap splits and the best lap", () => {
    const snaps = [5000, 9000, 12000];
    expect(lapDeltas(snaps)).toEqual([5000, 4000, 3000]);
    expect(fastestLap(snaps)).toBe(2); // delta 3000 is smallest
    expect(lapDeltas([])).toEqual([]);
    expect(fastestLap([])).toBe(-1);
    expect(fastestLap([7000])).toBe(0); // single lap is trivially fastest
  });
});
