/**
 * Pure unit tests for the iOS-style stopwatch in lib/time.ts (reducer, format,
 * laps). Locks the semantics the Clock UI drives:
 *   • running accumulates on tick; paused freezes (later ticks are no-ops);
 *   • start from a paused state resumes with full continuity;
 *   • reset returns to zero; elapsed can never go negative (clamped);
 *   • fmtStopwatch is mm:ss.cc; lap deltas/fastest/slowest are stable.
 * Previously this logic had no headless coverage.
 */
import { describe, expect, test } from "bun:test";
import {
  fmtStopwatch,
  fastestLap,
  lapDeltas,
  slowestLap,
  stopwatchInit,
  stopwatchReducer,
} from "../lib/time";

describe("stopwatch reducer (iOS semantics)", () => {
  test("starts clean and accumulates on tick", () => {
    const init = stopwatchInit();
    expect(init).toEqual({ running: false, baseMs: 0, elapsedMs: 0 });
    const s = stopwatchReducer(init, { type: "start", now: 1000 });
    expect(s.running).toBe(true);
    expect(s.elapsedMs).toBe(0);
    const t = stopwatchReducer(s, { type: "tick", now: 2500 });
    expect(t.elapsedMs).toBe(1500);
  });

  test("pausing freezes elapsed; ticks while paused are no-ops", () => {
    let s = stopwatchReducer(stopwatchInit(), { type: "start", now: 0 });
    s = stopwatchReducer(s, { type: "tick", now: 9000 });
    const paused = stopwatchReducer(s, { type: "pause", now: 9000 });
    expect(paused.running).toBe(false);
    expect(paused.elapsedMs).toBe(9000);
    // time passes but the watch is paused → unchanged
    const later = stopwatchReducer(paused, { type: "tick", now: 50_000 });
    expect(later.elapsedMs).toBe(9000);
    expect(stopwatchReducer(paused, { type: "pause", now: 50_000 })).toBe(paused);
  });

  test("resuming keeps running total continuous", () => {
    let s = stopwatchReducer(stopwatchInit(), { type: "start", now: 1000 });
    s = stopwatchReducer(s, { type: "tick", now: 4000 }); // 3000ms
    s = stopwatchReducer(s, { type: "pause", now: 4000 });
    s = stopwatchReducer(s, { type: "start", now: 4000 + 2000 }); // resume
    const t = stopwatchReducer(s, { type: "tick", now: 4000 + 2000 + 1000 });
    expect(t.elapsedMs).toBe(3000 + 1000); // pause gap (2000) is NOT counted
  });

  test("elapsed is clamped at ≥ 0 even if the clock steps backwards", () => {
    let s = stopwatchReducer(stopwatchInit(), { type: "start", now: 10_000 });
    const t = stopwatchReducer(s, { type: "tick", now: 3000 }); // backward
    expect(t.elapsedMs).toBe(0);
  });

  test("reset returns to the pristine state", () => {
    let s = stopwatchReducer(stopwatchInit(), { type: "start", now: 0 });
    s = stopwatchReducer(s, { type: "tick", now: 5000 });
    s = stopwatchReducer(s, { type: "pause", now: 5000 });
    expect(stopwatchReducer(s, { type: "reset" })).toEqual(stopwatchInit());
  });
});

describe("stopwatch formatting", () => {
  test("fmtStopwatch renders mm:ss.cc with zero-padding", () => {
    expect(fmtStopwatch(0)).toBe("00:00.00");
    expect(fmtStopwatch(1250)).toBe("00:01.25");
    expect(fmtStopwatch(610_000)).toBe("10:10.00"); // 610000ms = 10m10.00s
    expect(fmtStopwatch(-5)).toBe("00:00.00"); // clamped
  });
});

describe("stopwatch laps", () => {
  test("lapDeltas are per-lap differences from cumulative snapshots", () => {
    expect(lapDeltas([1000, 1500, 2200])).toEqual([1000, 500, 700]);
    expect(lapDeltas([])).toEqual([]);
  });

  test("fastest/slowest mark the min/max deltas (iOS ★ / ●)", () => {
    const snaps = [1000, 1500, 2200]; // deltas 1000, 500, 700
    expect(fastestLap(snaps)).toBe(1); // 500ms
    expect(slowestLap(snaps)).toBe(0); // 1000ms
    expect(fastestLap([])).toBe(-1);
    expect(slowestLap([])).toBe(-1);
  });
});
