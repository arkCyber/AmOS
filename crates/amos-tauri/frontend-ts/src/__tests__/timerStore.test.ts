import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  normalizeTimer,
  persistFromTimer,
  pollTimer,
  readTimer,
  restoreTimerState,
  TIMER_KEY,
  writeTimer,
} from "../lib/timerStore";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}

const DAY = 86_400_000;

afterEach(() => {
  window.localStorage.removeItem(TIMER_KEY);
});

describe("timerStore — persisted countdown for OS-level finish", () => {
  test("normalizeTimer guards garbage and restores defaults", () => {
    expect(normalizeTimer(null)).toEqual({
      running: false, totalMs: 0, remainingMs: 0, endAtMs: 0, fired: false,
    });
    expect(normalizeTimer({ running: true, totalMs: 60_000, endAtMs: 1, remainingMs: 0, fired: 1 })).toEqual({
      running: true, totalMs: 60_000, endAtMs: 1, remainingMs: 0, fired: false,
    });
  });

  test("restoreTimerState resumes a running future deadline and ignores a passed one", () => {
    const now = 1_000_000;
    writeTimer({ running: true, totalMs: 300_000, remainingMs: 0, endAtMs: now + 200_000, fired: false });
    const resumed = restoreTimerState(now);
    expect(resumed).toEqual({ running: true, totalMs: 300_000, remainingMs: 200_000, endAtMs: now + 200_000 });
    // A deadline already passed is not resumed (OS surfaced it).
    writeTimer({ running: true, totalMs: 300_000, remainingMs: 0, endAtMs: now - 1, fired: false });
    expect(restoreTimerState(now)).toEqual({ running: false, totalMs: 0, remainingMs: 0, endAtMs: 0 });
  });

  test("restoreTimerState restores an armed/paused (not-running) countdown", () => {
    const now = 1_000_000;
    // Set but not started (3:00).
    writeTimer({ running: false, totalMs: 180_000, remainingMs: 180_000, endAtMs: 0, fired: false });
    expect(restoreTimerState(now)).toEqual({ running: false, totalMs: 180_000, remainingMs: 180_000, endAtMs: 0 });
    // Paused partway (5:00 total, 2:00 left).
    writeTimer({ running: false, totalMs: 300_000, remainingMs: 120_000, endAtMs: 0, fired: false });
    expect(restoreTimerState(now)).toMatchObject({ running: false, totalMs: 300_000, remainingMs: 120_000 });
    // Finished (0 left) → idle, no resurrect.
    writeTimer({ running: false, totalMs: 300_000, remainingMs: 0, endAtMs: 0, fired: true });
    expect(restoreTimerState(now)).toEqual({ running: false, totalMs: 0, remainingMs: 0, endAtMs: 0 });
  });

  test("persistFromTimer re-arms fired and stores the running deadline", () => {
    persistFromTimer({ running: true, totalMs: 60_000, remainingMs: 0, endAtMs: 1_200_000 });
    const t = readTimer();
    expect(t).toEqual({ running: true, totalMs: 60_000, remainingMs: 0, endAtMs: 1_200_000, fired: false });
    persistFromTimer({ running: false, totalMs: 60_000, remainingMs: 45_000, endAtMs: 0 });
    expect(readTimer()).toMatchObject({ running: false, remainingMs: 45_000, endAtMs: 0 });
  });

  test("pollTimer fires a reached deadline exactly once and stops running", () => {
    const now = 1_000_000;
    writeTimer({ running: true, totalMs: 60_000, remainingMs: 0, endAtMs: now - 100, fired: false });
    expect(pollTimer(now)).toBe(true); // fired
    expect(readTimer()).toMatchObject({ running: false, endAtMs: 0, fired: true });
    // Not again.
    expect(pollTimer(now)).toBe(false);
    // Not due yet.
    writeTimer({ running: true, totalMs: 60_000, remainingMs: 0, endAtMs: now + DAY, fired: false });
    expect(pollTimer(now)).toBe(false);
  });
});
