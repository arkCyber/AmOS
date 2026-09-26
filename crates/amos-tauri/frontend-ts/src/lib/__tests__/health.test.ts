/**
 * health.test.ts — the pure core behind HealthApp (REQ-A1454).
 *
 * The device half (a real cumulative step counter, its reboot reset, a heart-rate strap
 * losing contact, the runtime permission dialogs, the JNI load) cannot run on this host and
 * is stated as the honest boundary in the traceability row. What *can* be pinned here is
 * every decision the reducer makes off those readings, because getting one of them wrong
 * produces a silently wrong number on screen:
 *
 *   * a **reboot** (the counter drops) must re-baseline, never record a negative day;
 *   * a **local midnight** must start a new day from the sample, never attribute the whole
 *     since-boot count to it;
 *   * an **absent** reading must leave the history alone — and never be stored as `0`,
 *     which would read as a real measurement of "no steps / no pulse";
 *   * an **out-of-range** heart rate is a sensor artifact, refused, not drawn as a spike;
 *   * a workout that was still "running" when the app died must be **closed**, not resumed.
 */
import { describe, expect, test } from "bun:test";
import {
  activeWorkout,
  applyVitalsTick,
  dayKey,
  daySteps,
  endWorkout,
  healthNotice,
  normalizeHealthState,
  normalizeHeartRate,
  recentDays,
  startWorkout,
  stepCalories,
  stepDelta,
  workoutTotals,
  type HealthState,
  type HealthTick,
} from "../health";

/** The reducer's seed. Production reads it from storage (`readHealthState`), which folds a
 *  missing/garbage store to the same shape; the tests want the bare constructor. */
function emptyHealthState(): HealthState {
  return { days: [], workouts: [] };
}

/** A local-midday timestamp, so the day key is stable in any timezone. */
function noon(y: number, mo: number, d: number): number {
  return new Date(y, mo - 1, d, 12, 0, 0).getTime();
}

function tickOf(state = emptyHealthState(), day = "1970-01-01", raw = 0): HealthTick {
  return { state, counter: { day, raw } };
}

describe("stepDelta", () => {
  test("a positive difference is the steps taken", () => {
    expect(stepDelta(1000, 1250)).toBe(250);
  });

  test("an unchanged counter is zero, not a repeated reading", () => {
    expect(stepDelta(1000, 1000)).toBe(0);
  });

  test("a drop is a reboot: re-baseline to 0, never a negative day", () => {
    // The counter restarts near zero after a reboot. Subtracting would give -4200.
    expect(stepDelta(5000, 800)).toBe(0);
  });

  test("a non-finite reading is not a sample", () => {
    expect(stepDelta(1000, Number.NaN)).toBe(0);
    expect(stepDelta(Number.NaN, 1000)).toBe(0);
    expect(stepDelta(1000, Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("dayKey", () => {
  test("is the local calendar day", () => {
    expect(dayKey(noon(2026, 9, 20))).toBe("2026-09-20");
  });

  test("zero-pads month and day", () => {
    expect(dayKey(noon(2026, 1, 5))).toBe("2026-01-05");
  });
});

describe("normalizeHeartRate", () => {
  test("a plausible rate passes", () => {
    expect(normalizeHeartRate(72)).toBe(72);
    expect(normalizeHeartRate(25)).toBe(25);
    expect(normalizeHeartRate(250)).toBe(250);
  });

  test("out-of-range and non-finite are refused, not clamped", () => {
    expect(normalizeHeartRate(0)).toBeNull();
    expect(normalizeHeartRate(24)).toBeNull();
    expect(normalizeHeartRate(251)).toBeNull();
    expect(normalizeHeartRate(Number.NaN)).toBeNull();
    expect(normalizeHeartRate(null)).toBeNull();
    expect(normalizeHeartRate("72")).toBeNull();
  });
});

describe("applyVitalsTick", () => {
  test("accumulates positive step deltas into the local day", () => {
    const t0 = noon(2026, 9, 20);
    let tick = tickOf(emptyHealthState(), "2026-09-20", 1000);
    tick = applyVitalsTick(tick, { timestamp_ms: t0, steps_total: 1100, heart_rate_bpm: null }, t0);
    expect(tick.state.days).toEqual([
      { day: "2026-09-20", steps: 100, steps_recorded: true, hr_min: null, hr_max: null },
    ]);
    tick = applyVitalsTick(tick, { timestamp_ms: t0, steps_total: 1150, heart_rate_bpm: null }, t0);
    expect(tick.state.days[0]!.steps).toBe(150);
    expect(tick.counter).toEqual({ day: "2026-09-20", raw: 1150 });
  });

  test("a reboot mid-day re-baselines without a negative day", () => {
    const t0 = noon(2026, 9, 20);
    let tick = tickOf(emptyHealthState(), "2026-09-20", 5000);
    tick = applyVitalsTick(tick, { timestamp_ms: t0, steps_total: 5200, heart_rate_bpm: null }, t0);
    expect(tick.state.days[0]!.steps).toBe(200);
    // reboot: the counter drops to 30.
    tick = applyVitalsTick(tick, { timestamp_ms: t0, steps_total: 30, heart_rate_bpm: null }, t0);
    expect(tick.state.days[0]!.steps).toBe(200);
    expect(tick.counter.raw).toBe(30);
    // and counting resumes from the new baseline.
    tick = applyVitalsTick(tick, { timestamp_ms: t0, steps_total: 80, heart_rate_bpm: null }, t0);
    expect(tick.state.days[0]!.steps).toBe(250);
  });

  test("a new local day starts from the sample, never from the since-boot count", () => {
    const d1 = noon(2026, 9, 20);
    const d2 = noon(2026, 9, 21);
    let tick = tickOf(emptyHealthState(), "2026-09-20", 1000);
    tick = applyVitalsTick(tick, { timestamp_ms: d1, steps_total: 3000, heart_rate_bpm: null }, d1);
    expect(tick.state.days[0]!.steps).toBe(2000);
    // First tick of the new day: 3600 since boot, but the steps taken between midnight and
    // this sample are unknowable — the new day starts from this sample, so no steps are
    // attributed and no row is minted until the count actually moves.
    tick = applyVitalsTick(tick, { timestamp_ms: d2, steps_total: 3600, heart_rate_bpm: null }, d2);
    expect(tick.state.days.find((x) => x.day === "2026-09-21")).toBeUndefined();
    expect(tick.counter).toEqual({ day: "2026-09-21", raw: 3600 });
    tick = applyVitalsTick(tick, { timestamp_ms: d2, steps_total: 3625, heart_rate_bpm: null }, d2);
    expect(tick.state.days.find((x) => x.day === "2026-09-21")!.steps).toBe(25);
    // Yesterday is intact.
    expect(tick.state.days.find((x) => x.day === "2026-09-20")!.steps).toBe(2000);
  });

  test("an absent reading changes nothing (and is never stored as 0)", () => {
    const t0 = noon(2026, 9, 20);
    const tick = tickOf(emptyHealthState(), "2026-09-20", 1000);
    const next = applyVitalsTick(
      tick,
      { timestamp_ms: t0, steps_total: null, heart_rate_bpm: null },
      t0,
    );
    expect(next.state.days).toEqual([]);
    expect(next.counter).toEqual(tick.counter);
  });

  test("a zero step reading is a measurement of zero new steps, not a reset", () => {
    const t0 = noon(2026, 9, 20);
    const tick = tickOf(emptyHealthState(), "2026-09-20", 1000);
    const next = applyVitalsTick(tick, { timestamp_ms: t0, steps_total: 1000, heart_rate_bpm: null }, t0);
    // No day row is created for a zero delta, but the counter is re-affirmed.
    expect(next.state.days).toEqual([]);
    expect(next.counter.raw).toBe(1000);
  });

  test("heart rate tracks the day's min and max; an out-of-range value is ignored", () => {
    const t0 = noon(2026, 9, 20);
    let tick = tickOf(emptyHealthState(), "2026-09-20", 0);
    tick = applyVitalsTick(tick, { timestamp_ms: t0, steps_total: null, heart_rate_bpm: 80 }, t0);
    tick = applyVitalsTick(tick, { timestamp_ms: t0, steps_total: null, heart_rate_bpm: 110 }, t0);
    tick = applyVitalsTick(tick, { timestamp_ms: t0, steps_total: null, heart_rate_bpm: 65 }, t0);
    tick = applyVitalsTick(tick, { timestamp_ms: t0, steps_total: null, heart_rate_bpm: 0 }, t0);
    // The row is minted for the bpm pair; `steps_recorded` stays false, because a heart-rate
    // sample observed no steps (REQ-A1838 ∕ F-SH-909).
    expect(tick.state.days[0]).toEqual({
      day: "2026-09-20",
      steps: 0,
      steps_recorded: false,
      hr_min: 65,
      hr_max: 110,
    });
  });

  test("a heart-rate-only sample does not report a step measurement of zero", () => {
    const t0 = noon(2026, 9, 20);
    const tick = tickOf(emptyHealthState(), "2026-09-20", 0);
    // `steps_total` is absent (no counter on the platform / the activity permission was not
    // granted) while the pulse streams, so the day's row is minted for the bpm pair alone.
    const next = applyVitalsTick(tick, { timestamp_ms: t0, steps_total: null, heart_rate_bpm: 88 }, t0);
    expect(next.state.days).toHaveLength(1);
    // The row's `steps` is the seed `0`, so the day must read as "no step reading" — not as
    // "you walked zero steps". Reading the row's `steps` directly printed 「今日步数 0」
    // (and 「卡路里 0」) for a day whose counter was never consulted (REQ-A1838 ∕ F-SH-909).
    expect(daySteps(next.state, "2026-09-20")).toBeNull();
  });

  test("the first sample of a new day re-baselines, and a bpm on it does not mint a zero day", () => {
    const d1 = noon(2026, 9, 20);
    const d2 = noon(2026, 9, 21);
    // A working counter: yesterday it moved, today's first sample only re-baselines.
    let tick = tickOf(emptyHealthState(), "2026-09-20", 1000);
    tick = applyVitalsTick(tick, { timestamp_ms: d1, steps_total: 3000, heart_rate_bpm: null }, d1);
    expect(daySteps(tick.state, "2026-09-20")).toBe(2000);
    tick = applyVitalsTick(tick, { timestamp_ms: d2, steps_total: 3600, heart_rate_bpm: 72 }, d2);
    // The steps taken today before the baseline are unknowable, so today is "no reading" —
    // even though the sample carried a heart rate (REQ-A1838 ∕ F-SH-909).
    expect(daySteps(tick.state, "2026-09-21")).toBeNull();
    // Positive control: once the count actually moves, the day is a measurement.
    tick = applyVitalsTick(tick, { timestamp_ms: d2, steps_total: 3625, heart_rate_bpm: 72 }, d2);
    expect(daySteps(tick.state, "2026-09-21")).toBe(25);
  });

  test("daySteps is the measured count, or null when there is no row at all", () => {
    expect(daySteps(emptyHealthState(), "2026-09-20")).toBeNull();
  });
});

describe("workouts", () => {
  test("a running workout is credited the same delta as the day", () => {
    const t0 = noon(2026, 9, 20);
    const started = startWorkout(emptyHealthState(), "run", t0);
    let tick: HealthTick = { state: started.state, counter: { day: "2026-09-20", raw: 1000 } };
    tick = applyVitalsTick(tick, { timestamp_ms: t0, steps_total: 1200, heart_rate_bpm: null }, t0);
    const w = activeWorkout(tick.state)!;
    expect(w.steps).toBe(200);
    expect(tick.state.days[0]!.steps).toBe(200);
  });

  test("ending a workout stops the credit", () => {
    const t0 = noon(2026, 9, 20);
    const started = startWorkout(emptyHealthState(), "walk", t0);
    const ended = endWorkout(started.state, started.id, t0 + 60_000);
    expect(activeWorkout(ended)).toBeNull();
    expect(ended.workouts[0]!.endedAt).toBe(t0 + 60_000);
  });

  test("workoutTotals sums duration and steps", () => {
    const t0 = noon(2026, 9, 20);
    const a = startWorkout(emptyHealthState(), "walk", t0);
    const b = startWorkout(a.state, "run", t0 + 1000);
    const ended = endWorkout(b.state, a.id, t0 + 30_000);
    const totals = workoutTotals(ended.workouts);
    expect(totals.count).toBe(2);
    expect(totals.ms).toBe(30_000);
  });
});

describe("recentDays", () => {
  test("a day with a folded step delta is recorded; a day we never sampled is not", () => {
    const week = recentDays(
      { days: [{ day: "2026-09-20", steps: 4000, steps_recorded: true, hr_min: null, hr_max: null }], workouts: [] },
      noon(2026, 9, 22),
    );
    expect(week).toHaveLength(7);
    const sampled = week.find((w) => w.day === "2026-09-20")!;
    expect(sampled.recorded).toBe(true);
    expect(sampled.steps).toBe(4000);
    const unseen = week.filter((w) => w.day !== "2026-09-20");
    expect(unseen).toHaveLength(6);
    expect(unseen.every((w) => !w.recorded && w.steps === 0)).toBe(true);
  });

  test("a day whose only row was minted by a heart rate is unrecorded, like a day never seen", () => {
    // The row exists, but it carries no step observation — `steps` is the seed `0`. Drawing it
    // as a measured zero is exactly what `recorded` must refuse (REQ-A1838 ∕ F-SH-909).
    const week = recentDays(
      { days: [{ day: "2026-09-20", steps: 0, steps_recorded: false, hr_min: 70, hr_max: 90 }], workouts: [] },
      noon(2026, 9, 22),
    );
    const row = week.find((w) => w.day === "2026-09-20")!;
    expect(row.steps).toBe(0);
    expect(row.recorded).toBe(false);
  });
});

describe("normalizeHealthState", () => {
  test("drops malformed days and repairs a dangling workout", () => {
    const state = normalizeHealthState({
      days: [
        { day: "2026-09-20", steps: 100, hr_min: null, hr_max: null },
        { day: "not-a-day", steps: 5 },
        { day: "2026-09-19", steps: -3, hr_min: 120, hr_max: 60 },
      ],
      workouts: [
        { id: "w1", kind: "run", startedAt: 1000, endedAt: 0, steps: 10 },
        { kind: "walk", startedAt: 1, endedAt: 2, steps: 1 },
      ],
    });
    expect(state.days).toEqual([
      // A stored `-3` clamps to `0` and, being below zero, is not a folded delta — so it
      // migrates to "not recorded", as does any legacy `0` (REQ-A1838 ∕ F-SH-909).
      { day: "2026-09-19", steps: 0, steps_recorded: false, hr_min: 60, hr_max: 120 },
      { day: "2026-09-20", steps: 100, steps_recorded: true, hr_min: null, hr_max: null },
    ]);
    // The dangling workout is closed at its start (zero duration), not left running; the
    // id-less row is dropped.
    expect(state.workouts).toEqual([
      { id: "w1", kind: "run", startedAt: 1000, endedAt: 1000, steps: 10 },
    ]);
    expect(activeWorkout(state)).toBeNull();
  });

  test("garbage in yields an empty, renderable state", () => {
    expect(normalizeHealthState(null)).toEqual({ days: [], workouts: [] });
    expect(normalizeHealthState("nope")).toEqual({ days: [], workouts: [] });
  });

  test("migrates a legacy row without the flag: a positive count was measured, a zero was not", () => {
    const state = normalizeHealthState({
      days: [
        { day: "2026-09-20", steps: 900 }, // folded delta → measured
        { day: "2026-09-21", steps: 0 }, // only a heart-rate seed could have written this
      ],
    });
    expect(state.days.map((d) => d.steps_recorded)).toEqual([true, false]);
    // A stored flag is authoritative once written, even over the migration rule.
    const flagged = normalizeHealthState({
      days: [{ day: "2026-09-22", steps: 0, steps_recorded: true }],
    });
    expect(flagged.days[0]!.steps_recorded).toBe(true);
  });
});

describe("stepCalories", () => {
  test("without a weight there is no calorie figure", () => {
    expect(stepCalories(1000, null)).toBeNull();
    expect(stepCalories(1000, 0)).toBeNull();
    expect(stepCalories(1000, Number.NaN)).toBeNull();
  });

  test("with a weight the figure is a real one", () => {
    expect(stepCalories(1000, 70)).toBe(2800);
    expect(stepCalories(0, 70)).toBe(0);
  });
});

/**
 * The no-reading banner's cause selector (REQ-A1886).
 *
 * `healthNotice` exists because the screen's banner was one boolean over one sentence: any
 * "no sample" state drew 「此设备没有提供健康读数 / 连接真机并允许…权限」, which is true only when no
 * host answered at all. On a connected phone the snapshot **does** answer (the step counter is
 * even registered — verified on device), so the sentence was an instruction to do what the user
 * had already done. The table below is every reachable combination of the three facts.
 */
describe("healthNotice — one sentence per reachable cause (REQ-A1886)", () => {
  const reading = { timestamp_ms: 1, steps_total: 10, heart_rate_bpm: null };

  test("a real reading says nothing", () => {
    expect(healthNotice(reading, true, false)).toBe("none");
    // A heart-rate-only sample is still a reading, whichever scalar carried it.
    expect(healthNotice({ timestamp_ms: 1, steps_total: null, heart_rate_bpm: 72 }, true, false)).toBe("none");
  });

  test("no host at all is the only case the connect-a-phone copy is true for", () => {
    expect(healthNotice(null, false, false)).toBe("unbridged");
    // A detach the client heard about cannot make an unbridged shell "stopped".
    expect(healthNotice(null, false, true)).toBe("unbridged");
  });

  test("a bridged host with no sample yet is awaiting, not unbridged", () => {
    // The S5: connected, granted, counter registered, no step taken yet.
    expect(healthNotice(null, true, false)).toBe("awaiting");
  });

  test("a bridged host whose producer announced a detach is stopped, not awaiting", () => {
    // Walking changes nothing until re-attach, so this is not the "no sample yet" sentence.
    expect(healthNotice(null, true, true)).toBe("stopped");
  });

  test("a sample with neither scalar is no reading, not a zero", () => {
    // A `0` here would be a measurement nobody took; the host drops such a sample anyway.
    expect(healthNotice({ timestamp_ms: 1, steps_total: null, heart_rate_bpm: null }, true, false)).toBe("awaiting");
  });
});

/**
 * `healthNotice` must judge "a reading is on screen" by the **same rule the cells draw by**
 * (REQ-A1902).
 *
 * The banner asked the raw wire fields (`steps_total !== null || heart_rate_bpm !== null`),
 * but the pulse cell draws `normalizeHeartRate(...)` (25–250) and the reducer folds only a
 * non-negative step count. The two seams also disagree above the frontend: `android_glue::reading`
 * refuses only a **non-positive** heart rate (`v > 0.0`), so a contact artifact reporting
 * `12 bpm` — or a worn strap at `300` — reaches the UI as a number, `normalizeHeartRate`
 * refuses to draw it, and the banner was withheld on the strength of the very value the cell
 * threw away. Result: three `—` and no sentence saying why. The pairs below are that: an
 * out-of-range scalar is "no reading" (the banner returns), an in-range one is not.
 */
describe("healthNotice — an out-of-range scalar is no reading (REQ-A1902)", () => {
  const at = (steps_total: number | null, heart_rate_bpm: number | null) => ({
    timestamp_ms: 1,
    steps_total,
    heart_rate_bpm,
  });

  test("a heart rate the cell refuses does not by itself count as a reading", () => {
    // Reachable: 12 clears the Rust seam (only `> 0.0` is required) but not the cell's range.
    expect(healthNotice(at(null, 12), true, false)).toBe("awaiting");
    expect(healthNotice(at(null, 300), true, false)).toBe("awaiting");
  });

  test("the range is inclusive on both ends, exactly as the cell draws it", () => {
    expect(healthNotice(at(null, 25), true, false)).toBe("none");
    expect(healthNotice(at(null, 250), true, false)).toBe("none");
    // One step outside either bound is refused — the same boundaries `normalizeHeartRate` uses.
    expect(healthNotice(at(null, 24), true, false)).toBe("awaiting");
    expect(healthNotice(at(null, 251), true, false)).toBe("awaiting");
  });

  test("a negative step count is not a reading either", () => {
    // `sensor_host_record_vitals` takes an unchecked `Option<f64>`; the reducer refuses `raw < 0`.
    expect(healthNotice(at(-5, null), true, false)).toBe("awaiting");
    // A cumulative counter at **0** is a real reading (since boot, nothing yet) — unlike a
    // rejected pulse, it must NOT bring the banner back.
    expect(healthNotice(at(0, null), true, false)).toBe("none");
  });
});
