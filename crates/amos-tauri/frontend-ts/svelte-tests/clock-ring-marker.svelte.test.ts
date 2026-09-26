/**
 * A ring latched by the Clock app's own 1 Hz tick must record the day it arrived
 * (REQ-A1392 / FMEA F-SH-651).
 *
 * The Clock screen is skipped by `osAlarmWatcher` while it is focused, so the arrival
 * that happens on-screen is latched by `alarmsReducer`'s `tick` and persisted by the
 * app's own effect — with **no** `ALARM_FIRED_KEY` marker. That was invisible until the
 * marker became load-bearing: `liveRingingIds` now reads a `ringing:true` with no
 * marker for today as *not ringing*, so without this half the ring would be retracted
 * and re-published as a second arrival the moment the user left the Clock app.
 *
 * 如实边界 (what this does NOT cover): the reconcile path is not mounted here (the
 * watcher is a separate module), and the tone loop is not asserted — only the marker
 * the ring writes.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import ClockApp from "../src/svelte/ClockApp.svelte";
import { ALARM_FIRED_KEY, ALARM_KEY, dateKey } from "../src/lib/alarmCore";

const AT = new Date(2026, 8, 7, 8, 0, 20); // 2026-09-07 (Monday) 08:00:20

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(AT);
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  window.localStorage.clear();
});

describe("ClockApp — an on-screen ring records the day it arrived (REQ-A1392)", () => {
  test("the tick that latches a due alarm writes today's fired marker", async () => {
    window.localStorage.setItem(
      ALARM_KEY,
      JSON.stringify([
        { id: "a1", hour: 8, min: 0, label: "起床", enabled: true, ringing: false, tone: "🔔" },
      ]),
    );
    render(ClockApp);
    await tick();

    // Nothing has rung yet, so there is no marker to inherit.
    expect(window.localStorage.getItem(ALARM_FIRED_KEY)).toBe(null);

    await vi.advanceTimersByTimeAsync(1000);
    await tick();

    const fired = JSON.parse(window.localStorage.getItem(ALARM_FIRED_KEY) ?? "{}") as Record<
      string,
      string
    >;
    expect(fired["a1|08:00"]).toBe(dateKey(AT));

    // …and the ring itself is persisted, which is what the marker has to describe.
    const stored = JSON.parse(window.localStorage.getItem(ALARM_KEY) ?? "[]") as {
      ringing?: boolean;
    }[];
    expect(stored[0]!.ringing).toBe(true);
  });

  test("a tick with nothing due writes no marker", async () => {
    window.localStorage.setItem(
      ALARM_KEY,
      JSON.stringify([
        { id: "a1", hour: 9, min: 0, label: "", enabled: true, ringing: false, tone: "🔔" },
      ]),
    );
    render(ClockApp);
    await tick();
    await vi.advanceTimersByTimeAsync(1000);
    await tick();
    expect(window.localStorage.getItem(ALARM_FIRED_KEY)).toBe(null);
  });
});
