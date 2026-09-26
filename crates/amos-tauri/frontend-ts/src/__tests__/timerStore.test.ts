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

/**
 * REQ-A1431 ∕ FMEA F-SH-689 — every `amos.timer` write reports the store's verdict.
 *
 * This module's whole reason for existing is the doc above: the countdown is persisted *so
 * that an OS notifier can finish it when the Clock app is closed*. That sentence is true
 * only when the write landed — a refused `setItem` leaves the store on its previous value,
 * so the notifier polls an idle timer and the user's countdown rings nowhere. And the
 * consume inside `pollTimer` is a write too: it is the only thing that flips `running` off,
 * so a refused one leaves the deadline as due as it was while "Fires exactly once" reads as
 * satisfied.
 */
describe("timerStore — a refused write is not reported as a landed one (REQ-A1431)", () => {
  let refuseTimerWrites = false;
  let restore: (() => void) | null = null;

  const installRefusingStorage = (): void => {
    const real = window.localStorage;
    const fake = {
      get length() {
        return real.length;
      },
      clear: () => real.clear(),
      key: (i: number) => real.key(i),
      getItem: (k: string) => real.getItem(k),
      removeItem: (k: string) => real.removeItem(k),
      setItem: (k: string, v: string) => {
        if (refuseTimerWrites && k === TIMER_KEY) throw new Error("QuotaExceededError");
        real.setItem(k, v);
      },
    } as unknown as Storage;
    Object.defineProperty(window, "localStorage", { value: fake, configurable: true, writable: true });
    restore = () => {
      Object.defineProperty(window, "localStorage", { value: real, configurable: true, writable: true });
    };
  };

  const withStorage = (body: () => void): void => {
    installRefusingStorage();
    try {
      body();
    } finally {
      refuseTimerWrites = false;
      restore?.();
      restore = null;
    }
  };

  test("persistFromTimer answers the store's refusal (and the disk still holds the old value)", () => {
    withStorage(() => {
      refuseTimerWrites = true;
      // Starting a 5:00 countdown on a store that will not take it.
      expect(persistFromTimer({ running: true, totalMs: 300_000, remainingMs: 0, endAtMs: 9_999 })).toBe(false);
      expect(window.localStorage.getItem(TIMER_KEY)).toBeNull();
      // Control: the same call on a store that takes it answers true — the assertion above
      // cannot be passed by "always false".
      refuseTimerWrites = false;
      expect(persistFromTimer({ running: true, totalMs: 300_000, remainingMs: 0, endAtMs: 9_999 })).toBe(true);
      expect(readTimer()).toMatchObject({ running: true, endAtMs: 9_999 });
    });
  });

  test("a write that would not change the record is a no-op → true, not a refusal", () => {
    withStorage(() => {
      // The screen persists from an `$effect` that also runs on the mount flush, before the
      // user has touched the countdown; if that answered `false` the sentence
      // 「本次改动未保存」 would be printed on a screen where nothing was changed.
      expect(persistFromTimer({ running: false, totalMs: 0, remainingMs: 0, endAtMs: 0 })).toBe(true);
      refuseTimerWrites = true;
      // Still nothing to write ⇒ still a no-op (this is NOT the refusal path).
      expect(persistFromTimer({ running: false, totalMs: 0, remainingMs: 0, endAtMs: 0 })).toBe(true);
      // …but a real change to a refusing store IS one.
      expect(persistFromTimer({ running: false, totalMs: 60_000, remainingMs: 30_000, endAtMs: 0 })).toBe(false);
    });
  });

  test("a refused consume does not claim the deadline was consumed (running stays, still due)", () => {
    // Seed the running deadline on the *real* store first, then swap in the refusing one —
    // the interesting state is "the store holds a due timer and will not take the consume".
    writeTimer({ running: true, totalMs: 60_000, remainingMs: 0, endAtMs: 900_000, fired: false });
    withStorage(() => {
      refuseTimerWrites = true;
      expect(pollTimer(1_000_000), "消费没落盘 ⇒ 不许报「已消费」").toBe(false);
      // The store is untouched, so the deadline is still due — which is exactly why the
      // caller must be able to tell: it is what makes the next tick retry.
      expect(readTimer()).toMatchObject({ running: true, fired: false, endAtMs: 900_000 });
      refuseTimerWrites = false;
      expect(pollTimer(1_000_000)).toBe(true);
      expect(readTimer()).toMatchObject({ running: false, fired: true, endAtMs: 0 });
    });
  });
});
