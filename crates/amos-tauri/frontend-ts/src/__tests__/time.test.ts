import { describe, expect, test } from "bun:test";
import { batteryPercent, fmtClock, zoneClock, stopwatchReducer, stopwatchInit, fmtStopwatch, timerReducer, timerInit, fmtCountdown, alarmsReducer, alarmInit, ringingAlarms, alarmKey, dayAllowed, normalizeAlarms, normalizeWorldCities, removeWorldCity, addWorldCity, WORLD_CITY_PRESETS, WORLD_CITY_MAX, defaultWorldCities, lapDeltas, fastestLap, slowestLap, moveWorldCity, alarmsByTime, nextAlarmAtMs, risingEdge, type Alarm } from "../lib/time";
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
    // a much bigger catalog is now offered than the default four
    expect(WORLD_CITY_PRESETS.length).toBeGreaterThan(6);
    // add a specific (newer) preset city
    const sydney = WORLD_CITY_PRESETS.find((c) => c.zone === "Australia/Sydney")!;
    const five = addWorldCity(def, sydney);
    expect(five.length).toBe(5);
    expect(five[4]!.zone).toBe("Australia/Sydney");
    // add existing -> same list (no-op)
    expect(addWorldCity(five, sydney)).toBe(five);
    // fill up to the cap then one more evicts the oldest (LIFO by age)
    let list = def; // starts with the default four
    for (let i = 0; i < WORLD_CITY_MAX; i++) {
      list = addWorldCity(list, { zone: `Zone/${i}`, labelKey: "x" });
    }
    expect(list.length).toBe(WORLD_CITY_MAX);
    const capped = addWorldCity(list, { zone: "Zone/extra", labelKey: "x" });
    expect(capped.length).toBe(WORLD_CITY_MAX); // never exceeds the cap
    expect(capped.some((c) => c.zone === "Asia/Shanghai")).toBe(false); // oldest evicted
    expect(addWorldCity(capped, capped[0]!)).toBe(capped); // dup at cap -> no-op
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

describe("alarmsReducer add — repeat sanitization (bug: invalid day numbers leaked in-session)", () => {
  test("drops non-integer / out-of-range repeat days, matching normalizeAlarms", () => {
    let s = alarmInit();
    s = alarmsReducer(s, {
      type: "add",
      hour: 8,
      min: 0,
      label: "",
      repeat: [2.5, -1, 8, 3, 0, 3],
    });
    const al = s.list[0]!;
    expect(al.repeat).toEqual([0, 3]); // deduped, sorted, only integer 0..6
  });

  test("an all-invalid repeat list falls back to 'every day' (no repeat field)", () => {
    let s = alarmInit();
    s = alarmsReducer(s, { type: "add", hour: 8, min: 0, label: "", repeat: [-5, 9, 1.7] });
    expect(s.list[0]!.repeat).toBeUndefined();
    expect(dayAllowed(s.list[0]!, new Date(2024, 0, 1))).toBe(true);
  });

  test("valid repeats stay usable by dayAllowed (getDay: 0=Sun..6=Sat)", () => {
    let s = alarmInit();
    s = alarmsReducer(s, { type: "add", hour: 8, min: 0, label: "", repeat: [6, 6, 1] });
    const al = s.list[0]!;
    expect(al.repeat).toEqual([1, 6]);
    expect(dayAllowed(al, new Date(2024, 0, 1))).toBe(true); // 2024-01-01 Mon = 1
    expect(dayAllowed(al, new Date(2024, 0, 6))).toBe(true); // 2024-01-06 Sat = 6
    expect(dayAllowed(al, new Date(2024, 0, 7))).toBe(false); // 2024-01-07 Sun = 0
    expect(dayAllowed(al, new Date(2024, 0, 2))).toBe(false); // Tue = 2
  });
});

describe("alarmsReducer update — edit an existing alarm (iOS parity)", () => {
  const at = (h: number, m: number) => new Date(2024, 0, 1, h, m, 0);
  const seed = () => {
    let s = alarmInit();
    s = alarmsReducer(s, { type: "add", hour: 8, min: 30, label: "起床", repeat: [1, 2, 3, 4, 5] });
    return { s, id: s.list[0]!.id };
  };

  test("rewrites hour/min/label/repeat and preserves id/enabled/tone", () => {
    const { s, id } = seed();
    const before = s.list[0]!;
    const next = alarmsReducer(s, {
      type: "update", id, hour: 7, min: 5, label: "晨跑", repeat: [1, 3, 5],
    });
    expect(next.list).toHaveLength(1);
    const al = next.list[0]!;
    expect(al.id).toBe(id); // same identity — an edit, not an add/remove
    expect(al).toMatchObject({ hour: 7, min: 5, label: "晨跑", repeat: [1, 3, 5] });
    expect(al.enabled).toBe(before.enabled);
    expect(al.tone).toBe(before.tone);
  });

  test("clamps out-of-range times like add does", () => {
    const { s, id } = seed();
    const next = alarmsReducer(s, {
      type: "update", id, hour: 99, min: -3, label: "", repeat: [],
    });
    expect(next.list[0]).toMatchObject({ hour: 23, min: 0, label: "" });
  });

  test("clearing every repeat day falls back to 'every day' (no repeat field)", () => {
    const { s, id } = seed();
    expect(s.list[0]!.repeat).toEqual([1, 2, 3, 4, 5]);
    const next = alarmsReducer(s, { type: "update", id, hour: 8, min: 30, label: "", repeat: [] });
    const al = next.list[0]!;
    expect(al.repeat).toBeUndefined();
    expect(dayAllowed(al, at(7, 0))).toBe(true); // Sunday now allowed
  });

  test("a ringing alarm is silenced when edited to a new time", () => {
    let s = seed().s;
    const id = s.list[0]!.id;
    s = alarmsReducer(s, { type: "tick", now: at(8, 29) });
    s = alarmsReducer(s, { type: "tick", now: at(8, 30) }); // rings at 08:30
    expect(ringingAlarms(s).length).toBe(1);
    // User edits it to 06:45 → stops ringing, and 08:30 won't re-fire that minute.
    s = alarmsReducer(s, { type: "update", id, hour: 6, min: 45, label: "更早", repeat: [] });
    expect(ringingAlarms(s)).toEqual([]);
    expect(s.list[0]).toMatchObject({ hour: 6, min: 45, label: "更早" });
    s = alarmsReducer(s, { type: "tick", now: at(8, 30) });
    expect(ringingAlarms(s)).toEqual([]);
    // And it fires at the NEW minute instead.
    s = alarmsReducer(s, { type: "tick", now: at(6, 44) });
    s = alarmsReducer(s, { type: "tick", now: at(6, 45) });
    expect(ringingAlarms(s).length).toBe(1);
  });
});

describe("alarmsReducer — ringtone tone on add/edit", () => {
  const seed = () => {
    let s = alarmInit();
    s = alarmsReducer(s, { type: "add", hour: 8, min: 30, label: "", tone: "🔔" });
    return { s, id: s.list[0]!.id };
  };

  test("add stores the chosen tone", () => {
    let s = alarmInit();
    s = alarmsReducer(s, { type: "add", hour: 7, min: 0, label: "", tone: "⏰" });
    expect(s.list[0]!.tone).toBe("⏰");
  });

  test("update with a tone token replaces it; absent keeps the existing one", () => {
    const { s, id } = seed();
    expect(s.list[0]!.tone).toBe("🔔");
    const changed = alarmsReducer(s, {
      type: "update", id, hour: 9, min: 0, label: "", repeat: [], tone: "🎶",
    });
    expect(changed.list[0]!.tone).toBe("🎶");
    // No tone in the action → tone is left untouched.
    const kept = alarmsReducer(changed, {
      type: "update", id, hour: 10, min: 0, label: "", repeat: [],
    });
    expect(kept.list[0]!.tone).toBe("🎶");
    // An invalid tone token is ignored (keeps the current one).
    const invalid = alarmsReducer(kept, {
      type: "update", id, hour: 11, min: 0, label: "", repeat: [], tone: "nope",
    });
    expect(invalid.list[0]!.tone).toBe("🎶");
  });
});

describe("slowestLap + moveWorldCity", () => {
  test("slowestLap returns the index of the largest lap delta (-1 when none)", () => {
    // Cumulative lap snapshots → deltas [3000, 2000, 4000, 3000].
    const snaps = [3000, 5000, 9000, 12000];
    expect(fastestLap(snaps)).toBe(1); // 2000ms lap is the fastest
    expect(slowestLap(snaps)).toBe(2); // 4000ms lap is the slowest
    expect(slowestLap([])).toBe(-1);
  });

  test("moveWorldCity reorders, clamps and no-ops on no-change", () => {
    const mk = () =>
      ["A", "B", "C", "D"].map((z) => ({ zone: `T/${z}`, labelKey: `clock.city.${z.toLowerCase()}` }));
    expect(moveWorldCity(mk(), 0, 2).map((c) => c.zone)).toEqual([
      "T/B", "T/C", "T/A", "T/D",
    ]);
    expect(moveWorldCity(mk(), 3, 0).map((c) => c.zone)).toEqual([
      "T/D", "T/A", "T/B", "T/C",
    ]);
    // Same index / NaN are no-ops returning the same array.
    const l = mk();
    expect(moveWorldCity(l, 0, 0)).toBe(l);
    expect(moveWorldCity(l, 1, Number.NaN)).toBe(l);
    // Out-of-range indices are clamped to [0, n-1], so -5→99 == 0→3 reorder.
    const clamped = moveWorldCity(mk(), -5, 99);
    expect(clamped).not.toBe(mk());
    expect(clamped.map((c) => c.zone)).toEqual(["T/B", "T/C", "T/D", "T/A"]);
  });

  test("alarmsByTime returns a stable earliest-first copy without mutating input", () => {
    const mk = (id: string, hour: number, min: number): Alarm => ({
      id, hour, min, label: "", enabled: true, ringing: false, tone: "🔔",
    });
    const list = [mk("late", 8, 30), mk("early", 6, 0), mk("same", 8, 30)];
    const sorted = alarmsByTime(list);
    expect(sorted.map((a) => a.id)).toEqual(["early", "late", "same"]);
    expect(list.map((a) => a.id)).toEqual(["late", "early", "same"]); // input untouched
    expect(sorted[1]).toBe(list[0]); // ties keep identity
  });

  test("nextAlarmAtMs returns the next allowed occurrence strictly after now", () => {
    // 2026-09-07 is a Monday.
    const monday8am = new Date(2026, 8, 7, 8, 0).getTime();
    const daily: Alarm = { id: "d", hour: 8, min: 30, label: "", enabled: true, ringing: false };
    // Still later today → same day 08:30.
    expect(nextAlarmAtMs(daily, monday8am)).toBe(new Date(2026, 8, 7, 8, 30).getTime());
    // After today's time already passed → tomorrow 08:30.
    const monday9am = new Date(2026, 8, 7, 9, 0).getTime();
    expect(nextAlarmAtMs(daily, monday9am)).toBe(new Date(2026, 8, 8, 8, 30).getTime());
    // Weekday-only alarm on a Sunday evening → next Monday 08:30.
    const weekday: Alarm = { ...daily, repeat: [1, 2, 3, 4, 5] };
    const sunday10pm = new Date(2026, 8, 6, 22, 0).getTime(); // 2026-09-06 is a Sunday
    expect(nextAlarmAtMs(weekday, sunday10pm)).toBe(new Date(2026, 8, 7, 8, 30).getTime());
  });
});

describe("risingEdge (one-shot transient cues)", () => {
  test("is true only on the false→true transition", () => {
    expect(risingEdge(false, true)).toBe(true); // the cue fires here
    expect(risingEdge(true, true)).toBe(false); // already done — no re-fire
    expect(risingEdge(true, false)).toBe(false); // falling edge
    expect(risingEdge(false, false)).toBe(false); // steady
  });
});

describe("alarm snoozeMin — per-alarm snooze length", () => {
  const at = (h: number, m: number) => new Date(2024, 0, 1, h, m, 0);

  test("snooze uses the alarm's snoozeMin; absent falls back to 5", () => {
    // Default (no snoozeMin) → +5 minutes (8:05).
    let s = alarmInit();
    s = alarmsReducer(s, { type: "add", hour: 8, min: 0, label: "" });
    const id = s.list[0]!.id;
    s = alarmsReducer(s, { type: "tick", now: at(7, 59) });
    s = alarmsReducer(s, { type: "tick", now: at(8, 0) });
    s = alarmsReducer(s, { type: "snooze", id, now: at(8, 0) });
    expect(s.list[0]).toMatchObject({ hour: 8, min: 5 });

    // snoozeMin 9 → +9 minutes (8:09).
    let s2 = alarmInit();
    s2 = alarmsReducer(s2, { type: "add", hour: 8, min: 0, label: "", snoozeMin: 9 });
    const id2 = s2.list[0]!.id;
    s2 = alarmsReducer(s2, { type: "tick", now: at(7, 59) });
    s2 = alarmsReducer(s2, { type: "tick", now: at(8, 0) });
    s2 = alarmsReducer(s2, { type: "snooze", id: id2, now: at(8, 0) });
    expect(s2.list[0]).toMatchObject({ hour: 8, min: 9 });
    expect(s2.list[0]!.snoozeMin).toBe(9);
  });

  test("add/update store snoozeMin; normalize keeps a valid one", () => {
    let s = alarmInit();
    s = alarmsReducer(s, { type: "add", hour: 7, min: 0, label: "", snoozeMin: 15 });
    expect(s.list[0]!.snoozeMin).toBe(15);
    s = alarmsReducer(s, { type: "update", id: s.list[0]!.id, hour: 8, min: 0, label: "", snoozeMin: 9 });
    expect(s.list[0]!.snoozeMin).toBe(9);
    // Invalid values are dropped (falls back to default at snooze time).
    s = alarmsReducer(s, { type: "update", id: s.list[0]!.id, hour: 8, min: 0, label: "", snoozeMin: 999 });
    expect(s.list[0]!.snoozeMin).toBe(9); // unchanged (invalid ignored)
    // normalize keeps a valid persisted snoozeMin.
    const kept = normalizeAlarms([{ id: "x", hour: 6, min: 0, label: "", enabled: true, ringing: false, snoozeMin: 9 }]);
    expect(kept[0]!.snoozeMin).toBe(9);
  });
});

describe("world-clock extra (name) cities", () => {
  const HK = { zone: "Asia/Hong_Kong", labelKey: "", name: { zh: "香港", en: "Hong Kong" } };

  test("normalize keeps preset zones and valid-name extra cities, drops garbage", () => {
    const def = defaultWorldCities();
    const got = normalizeWorldCities(
      [
        HK, // non-preset, has a bilingual name → kept
        { zone: "Asia/Tokyo" }, // preset → kept (normalized)
        { zone: "Mars/Olympus" }, // unknown + no name → garbage
        3,
        null,
      ],
      def,
    );
    const zones = got.map((c) => c.zone);
    expect(zones).toContain("Asia/Hong_Kong");
    expect(zones).toContain("Asia/Tokyo");
    expect(zones).not.toContain("Mars/Olympus");
    expect(got.find((c) => c.zone === "Asia/Hong_Kong")?.name).toEqual({ zh: "香港", en: "Hong Kong" });
  });

  test("extra cities can be added and the cap stays bounded", () => {
    let list = defaultWorldCities(); // 4
    list = addWorldCity(list, HK);
    expect(list.some((c) => c.zone === "Asia/Hong_Kong")).toBe(true);
    // Fill to WORLD_CITY_MAX then add → oldest evicted, length stays bounded.
    for (let i = 0; i < WORLD_CITY_MAX; i++) {
      list = addWorldCity(list, { zone: `Extra/${i}`, labelKey: "", name: { zh: `城${i}`, en: `City ${i}` } });
    }
    expect(list.length).toBe(WORLD_CITY_MAX);
    const extra = addWorldCity(list, { zone: "Extra/final", labelKey: "", name: { zh: "末", en: "Last" } });
    expect(extra.length).toBe(WORLD_CITY_MAX);
  });
});

